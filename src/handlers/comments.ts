// Public API handlers for comments

import type { Env, Comment, CreateCommentInput, CommentStatus } from '../types';
import { Database } from '../lib/db';
import { RateLimiter } from '../lib/rate-limit';
import { EmailService } from './email';
import {
  getClientIp,
  getUserAgent,
  getOrigin,
  isValidEmail,
  isValidUrl,
  detectSpam,
  threadComments,
  errorResponse,
  jsonResponse,
  parseAllowedOrigins,
  setCORSHeaders,
} from '../lib/utils';

/**
 * Strip fields that must never be exposed on public endpoints.
 *
 * BUG FIXED: the previous implementation returned the full Comment row
 * (including `ip_address`, `author_email`, and `user_agent`) on every
 * public GET. That is a serious privacy / PII leak: anyone could fetch
 * the IP address and email of every commenter by simply listing
 * approved comments. We now strip those fields before serialization.
 *
 * This helper performs a DEEP strip (also applied to nested replies).
 */
function stripPrivateCommentFields<T extends Comment>(comment: T): Omit<T, 'ip_address' | 'user_agent'> {
  // Avoid mutating the input — clone and delete.
  const clone: any = { ...comment };
  delete clone.ip_address;
  delete clone.user_agent;
  // author_email is needed for some flows (e.g. reply notifications) but
  // should NOT be exposed on public reads. We keep it out of the public
  // response as well.
  delete clone.author_email;
  if (Array.isArray(clone.replies)) {
    clone.replies = clone.replies.map((c: Comment) => stripPrivateCommentFields(c));
  }
  return clone;
}

export async function handleGetComments(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pageUrl = url.searchParams.get('page_url');
    const sortOrder = (url.searchParams.get('sort') as 'asc' | 'desc') || 'asc';

    if (!pageUrl) {
      return errorResponse('page_url parameter is required', 400);
    }

    // BUG FIXED: the previous implementation allowed the caller to pass
    // ANY status value (`pending`, `spam`, `deleted`, `approved`) and
    // would happily return comments in that status. That meant anyone
    // on the internet could enumerate pending/spam/deleted comments
    // (which often contain spam content, PII, or pre-moderation
    // drafts) by simply calling:
    //
    //     GET /api/comments?page_url=...&status=pending
    //
    // The public endpoint now hard-codes status='approved' and ignores
    // any client-supplied status parameter.
    const status: CommentStatus = 'approved';

    const db = new Database(env.DB);
    const comments = await db.getComments({
      page_url: pageUrl,
      status,
      sort_order: sortOrder,
      publicMode: true,
    });

    // Add reaction counts to each comment
    const commentsWithReactions = await Promise.all(
      comments.map(async (comment) => {
        const reactions = await db.getCommentReactions(comment.id);
        return { ...comment, reactions };
      })
    );

    // Thread the comments
    const threaded = threadComments(commentsWithReactions);

    // Strip PII before serialization
    const safe = threaded.map((c) => stripPrivateCommentFields(c));

    const response = jsonResponse({ comments: safe, count: safe.length });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching comments:', error);
    return errorResponse('Failed to fetch comments', 500);
  }
}

export async function handleCreateComment(request: Request, env: Env): Promise<Response> {
  try {
    let body: CreateCommentInput;
    try {
      body = (await request.json()) as CreateCommentInput;
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    // ---- Validation ------------------------------------------------------
    if (!body || typeof body !== 'object') {
      return errorResponse('Invalid request body', 400);
    }

    if (!body.page_url || typeof body.page_url !== 'string') {
      return errorResponse('page_url is required', 400);
    }
    // Normalize and validate page_url. Must be http(s).
    const pageUrl = body.page_url.trim();
    if (!isValidUrl(pageUrl)) {
      return errorResponse('page_url must be a valid http(s) URL', 400);
    }

    if (!body.author_name || typeof body.author_name !== 'string') {
      return errorResponse('author_name is required', 400);
    }
    const authorName = body.author_name.trim();
    if (authorName.length === 0 || authorName.length > 100) {
      return errorResponse('author_name must be 1-100 characters', 400);
    }

    if (!body.author_email || typeof body.author_email !== 'string') {
      return errorResponse('author_email is required', 400);
    }
    const authorEmail = body.author_email.trim().toLowerCase();
    if (!isValidEmail(authorEmail)) {
      return errorResponse('Invalid email address', 400);
    }

    if (!body.content || typeof body.content !== 'string') {
      return errorResponse('content is required', 400);
    }
    const content = body.content;
    if (content.length === 0 || content.length > 5000) {
      return errorResponse('Comment content must be 1-5000 characters', 400);
    }

    // author_url is optional but must be a valid http(s) URL if present.
    // BUG FIXED: previously no scheme validation — `javascript:` URLs
    // would pass and could later render as clickable XSS vectors.
    let authorUrl: string | null = null;
    if (body.author_url !== undefined && body.author_url !== null && body.author_url !== '') {
      const trimmed = String(body.author_url).trim();
      if (!isValidUrl(trimmed)) {
        return errorResponse('author_url must be a valid http(s) URL', 400);
      }
      authorUrl = trimmed;
    }

    // ---- Parent comment check -------------------------------------------
    let parentId: number | null = null;
    if (body.parent_id !== undefined && body.parent_id !== null) {
      const n = typeof body.parent_id === 'number' ? body.parent_id : parseInt(String(body.parent_id), 10);
      if (!isFinite(n) || n <= 0) {
        return errorResponse('Invalid parent_id', 400);
      }
      const db = new Database(env.DB);
      // Only allow replying to APPROVED comments. Replying to pending/spam
      // would leak moderation state to the public.
      const parent = await db.getPublicCommentById(n);
      if (!parent) {
        return errorResponse('Parent comment not found', 400);
      }
      // Ensure parent is on the same page (prevents cross-page threading abuse)
      if (parent.page_url !== pageUrl) {
        return errorResponse('Parent comment does not belong to the same page', 400);
      }
      parentId = n;
    }

    // ---- Rate limiting ---------------------------------------------------
    const ip = getClientIp(request);
    const db = new Database(env.DB);
    const rateLimiter = new RateLimiter(db);
    const rateLimit = await rateLimiter.checkCommentLimit(ip, authorEmail);

    if (!rateLimit.allowed) {
      const response = errorResponse(
        'Rate limit exceeded. Please wait before posting another comment.',
        429
      );
      response.headers.set('Retry-After', String(rateLimit.resetAt - Date.now()));
      return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
    }

    // ---- Spam detection + moderation setting ----------------------------
    const isSpam = detectSpam(content, authorName, authorEmail);
    let commentStatus: CommentStatus = isSpam ? 'spam' : 'pending';

    const requireModeration = await db.getSetting('require_moderation');
    if (requireModeration === 'false' && !isSpam) {
      commentStatus = 'approved';
    }

    // ---- Create comment -------------------------------------------------
    // BUG FIXED: the previous implementation called escapeHtml() on
    // author_name and content BEFORE storing them in the database.
    // That had two bad consequences:
    //   1. The admin panel ALSO escaped on output (via its own
    //      escapeHtml() function), so admins saw `&lt;script&gt;`
    //      literally instead of `<script>` — i.e. double-escaping.
    //   2. It encodes the wrong layer: HTML-escaping is an OUTPUT
    //      concern. The DB should store the raw, unescaped content
    //      and the rendering layer (admin HTML, public widget) is
    //      responsible for escaping it for the relevant context
    //      (HTML text, HTML attribute, URL, etc.).
    //
    // We now store raw content. The admin panel already escapes on
    // output. Any future public widget MUST also escape on output
    // (e.g. via `textContent` or a sanitization library).
    const comment = await db.createComment({
      page_url: pageUrl,
      parent_id: parentId,
      author_name: authorName,
      author_email: authorEmail,
      author_url: authorUrl,
      content: content,
      ip_address: ip,
      user_agent: getUserAgent(request),
      status: commentStatus,
    });

    // ---- Email notifications (best-effort, non-blocking) ----------------
    // BUG FIXED: the previous implementation never invoked the
    // EmailService at all — `email.ts` existed but was dead code.
    // We now fire notifications for subscriber and reply emails.
    // Failures are logged but never affect the HTTP response.
    try {
      const emailService = new EmailService(env, db);

      // Reply notification to parent comment author
      if (parentId !== null) {
        const parent = await db.getCommentById(parentId);
        if (parent && parent.author_email && parent.author_email !== authorEmail) {
          await emailService.notifyReply(parent, comment);
        }
      }

      // Subscriber + admin notifications (only for non-spam comments)
      if (comment.status !== 'spam') {
        await emailService.notifyNewComment(comment, pageUrl);
      }
    } catch (emailError) {
      // Email failures must NOT fail the comment creation
      console.error('Email notification failed (non-fatal):', emailError);
    }

    // ---- Response -------------------------------------------------------
    // Strip PII from the returned comment as well.
    const safeComment = stripPrivateCommentFields(comment);

    const response = jsonResponse(
      {
        comment: safeComment,
        status: comment.status,
        message: comment.status === 'approved' ? 'Comment published' : 'Comment submitted for moderation',
      },
      201
    );
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error creating comment:', error);
    return errorResponse('Failed to create comment', 500);
  }
}

export async function handleGetComment(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '', 10);

    if (!id || isNaN(id) || id <= 0) {
      return errorResponse('Invalid comment ID', 400);
    }

    const db = new Database(env.DB);

    // BUG FIXED: the previous implementation called `getCommentById`,
    // which returns the comment regardless of status. That meant anyone
    // could fetch pending/spam/deleted comments by simply enumerating
    // IDs (1, 2, 3, ...). We now use `getPublicCommentById` which
    // restricts to status='approved'.
    const comment = await db.getPublicCommentById(id);

    if (!comment) {
      return errorResponse('Comment not found', 404);
    }

    // Add reaction counts
    const reactions = await db.getCommentReactions(comment.id);
    const commentWithReactions = { ...comment, reactions };

    // Strip PII
    const safe = stripPrivateCommentFields(commentWithReactions);

    const response = jsonResponse(safe);
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching comment:', error);
    return errorResponse('Failed to fetch comment', 500);
  }
}

export async function handleOptions(request: Request, env: Env): Promise<Response> {
  const response = new Response(null, { status: 204 });
  return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
}
