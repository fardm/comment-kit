// Rate limiting utilities

import type { Env } from '../types';
import { Database } from './db';

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
      postReaction: { max: 10, window: 3600 } // 10 post reactions per hour
    };
  }

  async checkCommentLimit(ipAddress: string, email?: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    // Check by IP
    const recentComments = await this.db.getComments({
      ip_address: ipAddress,
      limit: 1000
    });
    
    const oneHourAgo = new Date(Date.now() - this.limits.comment.window * 1000).toISOString();
    const recentCount = recentComments.filter(c => c.created_at > oneHourAgo).length;
    
    const remaining = Math.max(0, this.limits.comment.max - recentCount);
    const allowed = remaining > 0;
    const resetAt = Date.now() + this.limits.comment.window * 1000;
    
    return { allowed, remaining, resetAt };
  }

  async checkVoteLimit(ipAddress: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const recentVotes = await this.db.getRecentVoteCount(ipAddress, 60); // Check last hour
    
    const remaining = Math.max(0, this.limits.vote.max - recentVotes);
    const allowed = remaining > 0;
    const resetAt = Date.now() + this.limits.vote.window * 1000;
    
    return { allowed, remaining, resetAt };
  }

  async checkPostReactionLimit(ipAddress: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    // For post reactions, we'll use the same vote log for simplicity
    const recentVotes = await this.db.getRecentVoteCount(ipAddress, 60);
    
    const remaining = Math.max(0, this.limits.postReaction.max - recentVotes);
    const allowed = remaining > 0;
    const resetAt = Date.now() + this.limits.postReaction.window * 1000;
    
    return { allowed, remaining, resetAt };
  }

  async logVote(ipAddress: string): Promise<void> {
    await this.db.logVote(ipAddress);
    
    // Clean up old logs periodically
    if (Math.random() < 0.1) {
      await this.db.cleanupOldVoteLogs();
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

  check(key: string, type: string): { allowed: boolean; remaining: number; resetAt: number } {
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
