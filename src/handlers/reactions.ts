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

export async function handleCreateVote(request: Request, env: Env): Promise<Response> {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { comment_id, reaction_type } = body || {};

    if (!comment_id || typeof comment_id !== 'number') {
      return errorResponse('Missing or invalid comment_id', 400);
    }
    if (!isReactionType(reaction_type)) {
      return errorResponse('Invalid reaction type', 400);
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
      response.headers.set('Retry-After', String(rateLimit.resetAt - Date.now()));
      return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
    }

    // Only allow voting on APPROVED comments. Voting on pending/spam
    // comments would leak moderation state to the public.
    const comment = await db.getPublicCommentById(comment_id);
    if (!comment) {
      return errorResponse('Comment not found', 404);
    }

    // BUG FIXED: the previous implementation called `getUserVote`
    // (singular) which returned only the FIRST reaction the user had
    // cast on the comment. The schema's UNIQUE constraint is on
    // (comment_id, ip_address, reaction_type) — i.e. a user may cast
    // ONE of EACH reaction type on a comment. The toggle logic was
    // therefore broken:
    //
    //   - User votes "heart"  -> existingVote=null, creates "heart"     ✓
    //   - User votes "thumbs_up" -> existingVote="heart", removes
    //     "heart" and creates "thumbs_up" — but the user wanted BOTH ✗
    //
    // We now look up the full set of reactions the user has cast on
    // the comment and toggle the requested one independently.
    const userReactions = await db.getUserVotes(comment_id, ip);
    const alreadyHas = userReactions.includes(reaction_type);

    if (alreadyHas) {
      // Toggle off
      await db.removeVote(comment_id, ip, reaction_type);
      // BUG FIXED: the previous implementation called `rateLimiter.logVote`
      // here, which means toggling a vote OFF consumed the user's vote
      // rate-limit budget. A user who clicked reactions on/off would
      // quickly hit the 20/hour limit and be unable to vote at all. We
      // now only log NEW votes.
    } else {
      // Create new vote
      await db.createVote({ comment_id, ip_address: ip, reaction_type });
      await rateLimiter.logVote(ip);
    }

    const reactions = await db.getCommentReactions(comment_id);
    const response = jsonResponse({
      reactions,
      voted: !alreadyHas,
      reaction_type: alreadyHas ? null : reaction_type,
    });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error creating vote:', error);
    return errorResponse('Failed to create vote', 500);
  }
}

export async function handleGetCommentReactions(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const commentId = parseInt(url.searchParams.get('comment_id') || '', 10);

    if (!commentId || isNaN(commentId) || commentId <= 0) {
      return errorResponse('Invalid comment ID', 400);
    }

    const db = new Database(env.DB);
    const reactions = await db.getCommentReactions(commentId);

    const response = jsonResponse({ reactions });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching reactions:', error);
    return errorResponse('Failed to fetch reactions', 500);
  }
}

export async function handleCreatePostReaction(request: Request, env: Env): Promise<Response> {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { page_url, reaction_type } = body || {};

    if (!page_url || typeof page_url !== 'string') {
      return errorResponse('Missing page_url', 400);
    }
    if (!isReactionType(reaction_type)) {
      return errorResponse('Invalid reaction type', 400);
    }

    const ip = getClientIp(request);
    const db = new Database(env.DB);
    const rateLimiter = new RateLimiter(db);

    // Rate limiting
    const rateLimit = await rateLimiter.checkPostReactionLimit(ip);
    if (!rateLimit.allowed) {
      const response = errorResponse(
        'Rate limit exceeded. Please wait before reacting again.',
        429
      );
      response.headers.set('Retry-After', String(rateLimit.resetAt - Date.now()));
      return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
    }

    // BUG FIXED: the previous implementation detected a duplicate
    // (toggle-off) by catching a UNIQUE-constraint error and string-
    // matching on `'UNIQUE'` in the error message. That is fragile:
    //   - D1 error messages are not contractually stable across versions
    //   - any OTHER constraint violation would be silently swallowed
    //   - the rate-limit counter (`logVote`) was incorrectly incremented
    //     inside the try block even on the toggle-OFF path
    //
    // We now SELECT first to detect existing reactions and decide
    // between INSERT and DELETE explicitly. This is one extra round
    // trip but is correct, readable, and avoids relying on error
    // messages for control flow.
    const existing = await db.getPostReaction(page_url, ip, reaction_type);

    if (existing) {
      // Toggle off
      await db.removePostReaction(page_url, ip, reaction_type);
      const reactions = await db.getPostReactions(page_url);
      const response = jsonResponse({ reactions, reacted: false });
      return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
    }

    // Create new reaction
    await db.createPostReaction({ page_url, ip_address: ip, reaction_type });
    // BUG FIXED: previously called `rateLimiter.logVote(ip)`, which
    // mixed post-reaction events into the vote_log counter. We now
    // log to the dedicated post_reaction_log table.
    await rateLimiter.logPostReaction(ip);

    const reactions = await db.getPostReactions(page_url);
    const response = jsonResponse({ reactions, reacted: true, reaction_type });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error creating post reaction:', error);
    return errorResponse('Failed to create post reaction', 500);
  }
}

export async function handleGetPostReactions(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pageUrl = url.searchParams.get('page_url');

    if (!pageUrl) {
      return errorResponse('page_url parameter is required', 400);
    }

    const db = new Database(env.DB);
    const reactions = await db.getPostReactions(pageUrl);

    const response = jsonResponse({ reactions });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching post reactions:', error);
    return errorResponse('Failed to fetch post reactions', 500);
  }
}
