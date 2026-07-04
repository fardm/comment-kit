// Rate limiting utilities

import { Database } from './db';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  private db: Database;
  private limits: {
    comment: { max: number; window: number }; // max comments per window (seconds)
    vote: { max: number; window: number };
    postReaction: { max: number; window: number };
  };

  constructor(db: Database) {
    this.db = db;
    this.limits = {
      comment: { max: 5, window: 3600 }, // 5 comments per hour
      vote: { max: 20, window: 3600 }, // 20 votes per hour
      postReaction: { max: 10, window: 3600 }, // 10 post reactions per hour
    };
  }

  /**
   * Check whether an IP may post another comment.
   *
   * BUG FIXED: the previous implementation fetched up to 1000 most-recent
   * comments for the IP and filtered by timestamp in JS. That approach
   * was both wildly inefficient (transferring up to 1000 full comment
   * rows on every POST) and silently mis-counted once an IP had more
   * than 1000 comments. We now delegate to a single indexed COUNT(*)
   * query on the database side.
   *
   * NOTE: the `email` parameter was previously accepted but never used.
   * Per-email rate limiting is intentionally NOT implemented because
   * email is attacker-controlled (anyone can send any email they like
   * in the `author_email` field). IP-based limiting is the only
   * meaningful signal here without requiring email verification.
   */
  async checkCommentLimit(ipAddress: string, _email?: string): Promise<RateLimitResult> {
    const windowSeconds = this.limits.comment.window;
    const windowMinutes = Math.ceil(windowSeconds / 60);
    const recentCount = await this.db.getRecentCommentCountByIp(ipAddress, windowMinutes);

    const remaining = Math.max(0, this.limits.comment.max - recentCount);
    const allowed = remaining > 0;
    const resetAt = Date.now() + windowSeconds * 1000;

    return { allowed, remaining, resetAt };
  }

  async checkVoteLimit(ipAddress: string): Promise<RateLimitResult> {
    const windowSeconds = this.limits.vote.window;
    const windowMinutes = Math.ceil(windowSeconds / 60);
    const recentVotes = await this.db.getRecentVoteCount(ipAddress, windowMinutes);

    const remaining = Math.max(0, this.limits.vote.max - recentVotes);
    const allowed = remaining > 0;
    const resetAt = Date.now() + windowSeconds * 1000;

    return { allowed, remaining, resetAt };
  }

  /**
   * Check whether an IP may post another post-level reaction.
   *
   * BUG FIXED: the previous implementation called `getRecentVoteCount`,
   * which counts rows in `vote_log` — i.e. COMMENT votes, not post
   * reactions. So the post-reaction rate limit was actually enforced
   * against the comment-vote counter, and the two limits interfered
   * with each other. We now query the dedicated `post_reaction_log`
   * table.
   */
  async checkPostReactionLimit(ipAddress: string): Promise<RateLimitResult> {
    const windowSeconds = this.limits.postReaction.window;
    const windowMinutes = Math.ceil(windowSeconds / 60);
    const recent = await this.db.getRecentPostReactionCount(ipAddress, windowMinutes);

    const remaining = Math.max(0, this.limits.postReaction.max - recent);
    const allowed = remaining > 0;
    const resetAt = Date.now() + windowSeconds * 1000;

    return { allowed, remaining, resetAt };
  }

  async logVote(ipAddress: string): Promise<void> {
    await this.db.logVote(ipAddress);

    // Probabilistic cleanup to avoid unbounded growth
    if (Math.random() < 0.1) {
      try {
        await this.db.cleanupOldVoteLogs();
      } catch {
        // ignore
      }
    }
  }

  async logPostReaction(ipAddress: string): Promise<void> {
    await this.db.logPostReaction(ipAddress);

    if (Math.random() < 0.1) {
      try {
        await this.db.cleanupOldPostReactionLogs();
      } catch {
        // ignore
      }
    }
  }

  setLimit(type: 'comment' | 'vote' | 'postReaction', max: number, window: number): void {
    this.limits[type] = { max, window };
  }
}

// Simple in-memory rate limiter for non-D1 scenarios
export class InMemoryRateLimiter {
  private requests: Map<string, { count: number; resetAt: number }> = new Map();
  private limits: Map<string, { max: number; window: number }> = new Map();

  constructor() {
    // Set default limits
    this.limits.set('comment', { max: 5, window: 3600 });
    this.limits.set('vote', { max: 20, window: 3600 });
    this.limits.set('postReaction', { max: 10, window: 3600 });
  }

  check(key: string, type: string): RateLimitResult {
    const limit = this.limits.get(type);
    if (!limit) {
      return { allowed: true, remaining: Infinity, resetAt: Date.now() };
    }

    const now = Date.now();
    const record = this.requests.get(key);

    if (!record || now > record.resetAt) {
      // Create new record or reset expired one
      const resetAt = now + limit.window * 1000;
      this.requests.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: limit.max - 1, resetAt };
    }

    if (record.count >= limit.max) {
      return { allowed: false, remaining: 0, resetAt: record.resetAt };
    }

    record.count++;
    return { allowed: true, remaining: limit.max - record.count, resetAt: record.resetAt };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.requests.entries()) {
      if (now > record.resetAt) {
        this.requests.delete(key);
      }
    }
  }
}
