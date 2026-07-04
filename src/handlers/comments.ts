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
  corsErrorResponse,
} from '../lib/utils';

/**
 * Strip fields that must never be exposed on public endpoints.
 *
 * BUG FIXED: the previous implementation returned the full Comment row
 * (including `ip_address`, `author_email`, and `user_agent`) on every
 * public GET. That is a serious privacy / PII leak: anyone could fetch
 * the IP address and email of every commenter by simply listing
 * approved comments. We now strip those fields before serialization.
 */
function stripPrivateCommentFields<T extends Comment>(comment: T): Omit<T, 'ip_address' | 'user_agent'> {
  const clone: any = { ...comment };
  delete clone.ip_address;
  delete clone.user_agent;
  delete clone.author_email;
  if (Array.isArray(clone.replies)) {
    clone.replies = clone.replies.map((c: Comment) => stripPrivateCommentFields(c));
  }
  return clone;
}

export async function handleGetComments(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);
  try {
    const url = new URL(request.url);
    const pageUrl = url.searchParams.get('page_url');
    const sortOrder = (url.searchParams.get('sort') as 'asc' | 'desc') || 'asc';

    if (!pageUrl) {
      return corsErrorResponse('page_url parameter is required', 400, allowedOrigins, origin);
    }

    // Public endpoint hard-codes status='approved'. See audit bug #3.
    const status: CommentStatus = 'approved';

    const db = new Database(env.DB);
    const comments = await db.getComments({
      page_url: pageUrl,
      status,
      sort_order: sortOrder,
      publicMode: true,
    });

    const commentsWithReactions = await Promise.all(
      comments.map(async (comment) => {
        const reactions = await db.getCommentReactions(comment.id);
        return { ...comment, reactions };
      })
    );

    const threaded = threadComments(commentsWithReactions);
    const safe = threaded.map((c) => stripPrivateCommentFields(c));

    const response = jsonResponse({ comments: safe, count: safe.length });
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error fetching comments:', error);
    return corsErrorResponse('Failed to fetch comments', 500, allowedOrigins, origin);
  }
}

export async function handleCreateComment(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);

  try {
    let body: CreateCommentInput;
    try {
      body = (await request.json()) as CreateCommentInput;
    } catch {
      return corsErrorResponse('Invalid JSON body', 400, allowedOrigins, origin);
    }

    // ---- Validation ------------------------------------------------------
    if (!body || typeof body !== 'object') {
      return corsErrorResponse('Invalid request body', 400, allowedOrigins, origin);
    }

    if (!body.page_url || typeof body.page_url !== 'string') {
      return corsErrorResponse('page_url is required', 400, allowedOrigins, origin);
    }
    const pageUrl = body.page_url.trim();
    if (!isValidUrl(pageUrl)) {
      return corsErrorResponse('page_url must be a valid http(s) URL', 400, allowedOrigins, origin);
    }

    if (!body.author_name || typeof body.author_name !== 'string') {
      return corsErrorResponse('author_name is required', 400, allowedOrigins, origin);
    }
    const authorName = body.author_name.trim();
    if (authorName.length === 0 || authorName.length > 100) {
      return corsErrorResponse('author_name must be 1-100 characters', 400, allowedOrigins, origin);
    }

    if (!body.author_email || typeof body.author_email !== 'string') {
      return corsErrorResponse('author_email is required', 400, allowedOrigins, origin);
    }
    const authorEmail = body.author_email.trim().toLowerCase();
    if (!isValidEmail(authorEmail)) {
      return corsErrorResponse('Invalid email address', 400, allowedOrigins, origin);
    }

    if (!body.content || typeof body.content !== 'string') {
      return corsErrorResponse('content is required', 400, allowedOrigins, origin);
    }
    const content = body.content;
    if (content.length === 0 || content.length > 5000) {
      return corsErrorResponse('Comment content must be 1-5000 characters', 400, allowedOrigins, origin);
    }

    let authorUrl: string | null = null;
    if (body.author_url !== undefined && body.author_url !== null && body.author_url !== '') {
      const trimmed = String(body.author_url).trim();
      if (!isValidUrl(trimmed)) {
        return corsErrorResponse('author_url must be a valid http(s) URL', 400, allowedOrigins, origin);
      }
      authorUrl = trimmed;
    }

    // ---- Parent comment check -------------------------------------------
    let parentId: number | null = null;
    if (body.parent_id !== undefined && body.parent_id !== null) {
      const n =
        typeof body.parent_id === 'number' ? body.parent_id : parseInt(String(body.parent_id), 10);
      if (!isFinite(n) || n <= 0) {
        return corsErrorResponse('Invalid parent_id', 400, allowedOrigins, origin);
      }
      const db = new Database(env.DB);
      const parent = await db.getPublicCommentById(n);
      if (!parent) {
        return corsErrorResponse('Parent comment not found', 400, allowedOrigins, origin);
      }
      if (parent.page_url !== pageUrl) {
        return corsErrorResponse(
          'Parent comment does not belong to the same page',
          400,
          allowedOrigins,
          origin
        );
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
      response.headers.set('Retry-After', String(Math.max(1, rateLimit.resetAt - Date.now())));
      return setCORSHeaders(response, allowedOrigins, origin);
    }

    // ---- Spam detection + moderation setting ----------------------------
    const isSpam = detectSpam(content, authorName, authorEmail);
    let commentStatus: CommentStatus = isSpam ? 'spam' : 'pending';

    const requireModeration = await db.getSetting('require_moderation');
    if (requireModeration === 'false' && !isSpam) {
      commentStatus = 'approved';
    }

    // ---- Create comment -------------------------------------------------
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

    // ---- Email notifications (best-effort) ------------------------------
    try {
      const emailService = new EmailService(env, db);
      if (parentId !== null) {
        const parent = await db.getCommentById(parentId);
        if (parent && parent.author_email && parent.author_email !== authorEmail) {
          await emailService.notifyReply(parent, comment);
        }
      }
      if (comment.status !== 'spam') {
        await emailService.notifyNewComment(comment, pageUrl);
      }
    } catch (emailError) {
      console.error('Email notification failed (non-fatal):', emailError);
    }

    // ---- Response -------------------------------------------------------
    const safeComment = stripPrivateCommentFields(comment);
    const response = jsonResponse(
      {
        comment: safeComment,
        status: comment.status,
        message: comment.status === 'approved' ? 'Comment published' : 'Comment submitted for moderation',
      },
      201
    );
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error creating comment:', error);
    return corsErrorResponse('Failed to create comment', 500, allowedOrigins, origin);
  }
}

export async function handleGetComment(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);
  try {
    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '', 10);

    if (!id || isNaN(id) || id <= 0) {
      return corsErrorResponse('Invalid comment ID', 400, allowedOrigins, origin);
    }

    const db = new Database(env.DB);
    const comment = await db.getPublicCommentById(id);

    if (!comment) {
      return corsErrorResponse('Comment not found', 404, allowedOrigins, origin);
    }

    const reactions = await db.getCommentReactions(comment.id);
    const commentWithReactions = { ...comment, reactions };
    const safe = stripPrivateCommentFields(commentWithReactions);

    const response = jsonResponse(safe);
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error fetching comment:', error);
    return corsErrorResponse('Failed to fetch comment', 500, allowedOrigins, origin);
  }
}

export async function handleOptions(request: Request, env: Env): Promise<Response> {
  const response = new Response(null, { status: 204 });
  return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
}
