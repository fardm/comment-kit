// Public API handlers for comments

import type { Env, Comment, CreateCommentInput } from '../types';
import { Database } from '../lib/db';
import { RateLimiter } from '../lib/rate-limit';
import { getClientIp, getUserAgent, getOrigin, isValidEmail, escapeHtml, detectSpam, threadComments, errorResponse, jsonResponse, parseAllowedOrigins, isOriginAllowed, setCORSHeaders } from '../lib/utils';

export async function handleGetComments(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pageUrl = url.searchParams.get('page_url');
    const status = url.searchParams.get('status') as 'pending' | 'approved' | 'spam' | 'deleted' || 'approved';
    const sortOrder = url.searchParams.get('sort') as 'asc' | 'desc' || 'asc';

    if (!pageUrl) {
      return errorResponse('page_url parameter is required', 400);
    }

    const db = new Database(env.DB);
    const comments = await db.getComments({
      page_url: pageUrl,
      status,
      sort_order: sortOrder
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

    const response = jsonResponse({ comments: threaded, count: threaded.length });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching comments:', error);
    return errorResponse('Failed to fetch comments', 500);
  }
}

export async function handleCreateComment(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as CreateCommentInput;

    // Validation
    if (!body.page_url || !body.author_name || !body.author_email || !body.content) {
      return errorResponse('Missing required fields', 400);
    }

    if (!isValidEmail(body.author_email)) {
      return errorResponse('Invalid email address', 400);
    }

    if (body.content.length > 5000) {
      return errorResponse('Comment content too long (max 5000 characters)', 400);
    }

    if (body.author_name.length > 100) {
      return errorResponse('Author name too long (max 100 characters)', 400);
    }

    // Check if parent comment exists
    if (body.parent_id) {
      const db = new Database(env.DB);
      const parentComment = await db.getCommentById(body.parent_id);
      if (!parentComment) {
        return errorResponse('Parent comment not found', 400);
      }
    }

    // Rate limiting
    const ip = getClientIp(request);
    const db = new Database(env.DB);
    const rateLimiter = new RateLimiter(db);
    const rateLimit = await rateLimiter.checkCommentLimit(ip, body.author_email);

    if (!rateLimit.allowed) {
      return errorResponse('Rate limit exceeded. Please wait before posting another comment.', 429);
    }

    // Spam detection
    const isSpam = detectSpam(body.content, body.author_name, body.author_email);
    let commentStatus: 'pending' | 'approved' | 'spam' = isSpam ? 'spam' : 'pending';

    // Check moderation setting
    const requireModeration = await db.getSetting('require_moderation');
    if (requireModeration === 'false' && !isSpam) {
      commentStatus = 'approved';
    }

    // Create comment
    const comment = await db.createComment({
      page_url: body.page_url,
      parent_id: body.parent_id || null,
      author_name: escapeHtml(body.author_name),
      author_email: body.author_email,
      author_url: body.author_url || null,
      content: escapeHtml(body.content),
      ip_address: ip,
      user_agent: getUserAgent(request)
    });

    // Update status if needed
    if (commentStatus !== 'pending') {
      await db.updateComment(comment.id, { status: commentStatus });
      comment.status = commentStatus;
    }

    const response = jsonResponse({ 
      comment, 
      status: comment.status,
      message: comment.status === 'approved' ? 'Comment published' : 'Comment submitted for moderation'
    }, 201);
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error creating comment:', error);
    return errorResponse('Failed to create comment', 500);
  }
}

export async function handleGetComment(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '');

    if (!id || isNaN(id)) {
      return errorResponse('Invalid comment ID', 400);
    }

    const db = new Database(env.DB);
    const comment = await db.getCommentById(id);

    if (!comment) {
      return errorResponse('Comment not found', 404);
    }

    // Add reaction counts
    const reactions = await db.getCommentReactions(comment.id);
    const commentWithReactions = { ...comment, reactions };

    const response = jsonResponse(commentWithReactions);
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching comment:', error);
    return errorResponse('Failed to fetch comment', 500);
  }
}

export async function handleOptions(request: Request, env: Env): Promise<Response> {
  const response = new Response(null, { status: 204 });
  return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS));
}
