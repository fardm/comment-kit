// Handlers for emoji reactions (votes and post reactions)

import type { Env, ReactionType } from '../types';
import { Database } from '../lib/db';
import { RateLimiter } from '../lib/rate-limit';
import {
  getClientIp,
  errorResponse,
  jsonResponse,
  parseAllowedOrigins,
  setCORSHeaders,
  getOrigin,
  corsErrorResponse,
} from '../lib/utils';

const VALID_REACTIONS: ReactionType[] = [
  'heart',
  'thumbs_up',
  'thumbs_down',
  'laugh',
  'cry',
  'fire',
  'clap',
];

function isReactionType(value: unknown): value is ReactionType {
  return typeof value === 'string' && (VALID_REACTIONS as string[]).includes(value);
}

/**
 * Helper: detect "table does not exist" errors thrown by D1 so we can
 * return a clean 500 with a helpful message instead of letting it bubble
 * up as a generic 500 (which the browser would then mask as a CORS
 * error).
 *
 * This matters because the `post_reaction_log` table was added in a
 * later migration — deployments that haven't re-run `npm run d1:migrate`
 * will hit this on every post-reaction request.
 */
function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('no such table') ||
    msg.includes('no such column') ||
    msg.includes('post_reaction_log')
  );
}

export async function handleCreateVote(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);

  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return corsErrorResponse('Invalid JSON body', 400, allowedOrigins, origin);
    }

    const { comment_id, reaction_type } = body || {};

    if (!comment_id || typeof comment_id !== 'number') {
      return corsErrorResponse('Missing or invalid comment_id', 400, allowedOrigins, origin);
    }
    if (!isReactionType(reaction_type)) {
      return corsErrorResponse('Invalid reaction type', 400, allowedOrigins, origin);
    }

    const ip = getClientIp(request);
    const db = new Database(env.DB);
    const rateLimiter = new RateLimiter(db);

    // Rate limiting
    const rateLimit = await rateLimiter.checkVoteLimit(ip);
    if (!rateLimit.allowed) {
      const response = errorResponse(
        'Rate limit exceeded. Please wait before voting again.',
        429
      );
      response.headers.set('Retry-After', String(Math.max(1, rateLimit.resetAt - Date.now())));
      return setCORSHeaders(response, allowedOrigins, origin);
    }

    // Only allow voting on APPROVED comments. Voting on pending/spam
    // comments would leak moderation state to the public.
    const comment = await db.getPublicCommentById(comment_id);
    if (!comment) {
      return corsErrorResponse('Comment not found', 404, allowedOrigins, origin);
    }

    const userReactions = await db.getUserVotes(comment_id, ip);
    const alreadyHas = userReactions.includes(reaction_type);

    if (alreadyHas) {
      await db.removeVote(comment_id, ip, reaction_type);
    } else {
      await db.createVote({ comment_id, ip_address: ip, reaction_type });
      await rateLimiter.logVote(ip);
    }

    const reactions = await db.getCommentReactions(comment_id);
    const response = jsonResponse({
      reactions,
      voted: !alreadyHas,
      reaction_type: alreadyHas ? null : reaction_type,
    });
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error creating vote:', error);
    return corsErrorResponse('Failed to create vote', 500, allowedOrigins, origin);
  }
}

export async function handleGetCommentReactions(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);
  try {
    const url = new URL(request.url);
    const commentId = parseInt(url.searchParams.get('comment_id') || '', 10);

    if (!commentId || isNaN(commentId) || commentId <= 0) {
      return corsErrorResponse('Invalid comment ID', 400, allowedOrigins, origin);
    }

    const db = new Database(env.DB);
    const reactions = await db.getCommentReactions(commentId);

    const response = jsonResponse({ reactions });
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error fetching reactions:', error);
    return corsErrorResponse('Failed to fetch reactions', 500, allowedOrigins, origin);
  }
}

export async function handleCreatePostReaction(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);

  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return corsErrorResponse('Invalid JSON body', 400, allowedOrigins, origin);
    }

    const { page_url, reaction_type } = body || {};

    if (!page_url || typeof page_url !== 'string') {
      return corsErrorResponse('Missing page_url', 400, allowedOrigins, origin);
    }
    if (!isReactionType(reaction_type)) {
      return corsErrorResponse('Invalid reaction type', 400, allowedOrigins, origin);
    }

    const ip = getClientIp(request);
    const db = new Database(env.DB);
    const rateLimiter = new RateLimiter(db);

    // Rate limiting — wrapped in try/catch because the dedicated
    // post_reaction_log table may not exist on deployments that haven't
    // re-run the migration. We fall back to "allow" rather than failing
    // the request — rate-limiting is a soft protection, not a correctness
    // requirement, and the user should still be able to react.
    let rateLimitOk = true;
    try {
      const rateLimit = await rateLimiter.checkPostReactionLimit(ip);
      rateLimitOk = rateLimit.allowed;
    } catch (e) {
      if (isMissingTableError(e)) {
        console.warn(
          '[post-reaction] post_reaction_log table missing — rate limit skipped. Run `npm run d1:migrate` to enable it.'
        );
      } else {
        throw e;
      }
    }

    if (!rateLimitOk) {
      const response = errorResponse(
        'Rate limit exceeded. Please wait before reacting again.',
        429
      );
      response.headers.set('Retry-After', '900');
      return setCORSHeaders(response, allowedOrigins, origin);
    }

    const existing = await db.getPostReaction(page_url, ip, reaction_type);

    if (existing) {
      // Toggle off
      await db.removePostReaction(page_url, ip, reaction_type);
      const reactions = await db.getPostReactions(page_url);
      const response = jsonResponse({ reactions, reacted: false });
      return setCORSHeaders(response, allowedOrigins, origin);
    }

    // Create new reaction
    await db.createPostReaction({ page_url, ip_address: ip, reaction_type });

    // Log the rate-limit event — same try/catch as above
    try {
      await rateLimiter.logPostReaction(ip);
    } catch (e) {
      if (!isMissingTableError(e)) {
        console.warn('[post-reaction] failed to log rate-limit event:', e);
      }
    }

    const reactions = await db.getPostReactions(page_url);
    const response = jsonResponse({ reactions, reacted: true, reaction_type });
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error creating post reaction:', error);
    const msg = isMissingTableError(error)
      ? 'Database migration required: run `npm run d1:migrate` to add the post_reaction_log table.'
      : 'Failed to create post reaction';
    return corsErrorResponse(msg, 500, allowedOrigins, origin);
  }
}

export async function handleGetPostReactions(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);
  try {
    const url = new URL(request.url);
    const pageUrl = url.searchParams.get('page_url');

    if (!pageUrl) {
      return corsErrorResponse('page_url parameter is required', 400, allowedOrigins, origin);
    }

    const db = new Database(env.DB);
    const reactions = await db.getPostReactions(pageUrl);

    const response = jsonResponse({ reactions });
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error fetching post reactions:', error);
    return corsErrorResponse('Failed to fetch post reactions', 500, allowedOrigins, origin);
  }
}
