// Handlers for emoji reactions (votes and post reactions)

import type { Env, ReactionType } from '../types';
import { Database } from '../lib/db';
import { RateLimiter } from '../lib/rate-limit';
import { getClientIp, errorResponse, jsonResponse, parseAllowedOrigins, setCORSHeaders, getOrigin } from '../lib/utils';

export async function handleCreateVote(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();
    const { comment_id, reaction_type } = body;

    if (!comment_id || !reaction_type) {
      return errorResponse('Missing required fields', 400);
    }

    const validReactions: ReactionType[] = ['heart', 'thumbs_up', 'thumbs_down', 'laugh', 'cry', 'fire', 'clap'];
    if (!validReactions.includes(reaction_type)) {
      return errorResponse('Invalid reaction type', 400);
    }

    const ip = getClientIp(request);
    const db = new Database(env.DB);
    const rateLimiter = new RateLimiter(db);

    // Rate limiting
    const rateLimit = await rateLimiter.checkVoteLimit(ip);
    if (!rateLimit.allowed) {
      return errorResponse('Rate limit exceeded. Please wait before voting again.', 429);
    }

    // Check if comment exists
    const comment = await db.getCommentById(comment_id);
    if (!comment) {
      return errorResponse('Comment not found', 404);
    }

    // Check if user already voted with this reaction
    const existingVote = await db.getUserVote(comment_id, ip);
    if (existingVote === reaction_type) {
      // Remove the vote (toggle off)
      await db.removeVote(comment_id, ip, reaction_type);
      await rateLimiter.logVote(ip);
      const reactions = await db.getCommentReactions(comment_id);
      const response = jsonResponse({ reactions, voted: false });
      return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
    }

    // Remove existing vote if different reaction
    if (existingVote) {
      await db.removeVote(comment_id, ip, existingVote);
    }

    // Create new vote
    await db.createVote({ comment_id, ip_address: ip, reaction_type });
    await rateLimiter.logVote(ip);

    const reactions = await db.getCommentReactions(comment_id);
    const response = jsonResponse({ reactions, voted: true, reaction_type });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error creating vote:', error);
    return errorResponse('Failed to create vote', 500);
  }
}

export async function handleGetCommentReactions(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const commentId = parseInt(url.searchParams.get('comment_id') || '');

    if (!commentId || isNaN(commentId)) {
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
    const body = await request.json();
    const { page_url, reaction_type } = body;

    if (!page_url || !reaction_type) {
      return errorResponse('Missing required fields', 400);
    }

    const validReactions: ReactionType[] = ['heart', 'thumbs_up', 'thumbs_down', 'laugh', 'cry', 'fire', 'clap'];
    if (!validReactions.includes(reaction_type)) {
      return errorResponse('Invalid reaction type', 400);
    }

    const ip = getClientIp(request);
    const db = new Database(env.DB);
    const rateLimiter = new RateLimiter(db);

    // Rate limiting
    const rateLimit = await rateLimiter.checkPostReactionLimit(ip);
    if (!rateLimit.allowed) {
      return errorResponse('Rate limit exceeded. Please wait before reacting again.', 429);
    }

    // Check if user already reacted with this type
    const existingReactions = await db.getPostReactions(page_url);
    // For simplicity, we'll just add the reaction (D1 will handle duplicates via UNIQUE constraint)
    
    try {
      await db.createPostReaction({ page_url, ip_address: ip, reaction_type });
      await rateLimiter.logVote(ip);
    } catch (error: any) {
      // If duplicate, remove it (toggle off)
      if (error.message && error.message.includes('UNIQUE')) {
        await db.removePostReaction(page_url, ip, reaction_type);
        const reactions = await db.getPostReactions(page_url);
        const response = jsonResponse({ reactions, reacted: false });
        return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
      }
      throw error;
    }

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
