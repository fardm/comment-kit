// Database helper functions for D1

import type {
  Comment,
  CommentStatus,
  ReactionCounts,
  ReactionType,
  Vote,
  PostReaction,
  Subscription,
  EmailQueue,
  Session,
  LoginAttempt,
  Setting,
} from '../types';

/**
 * Hard cap on the number of rows a single public query may return.
 * The previous implementation would happily return ALL rows when no
 * `limit` filter was supplied, which is both a performance footgun
 * and an information-disclosure risk (a single GET could dump every
 * comment in the database).
 */
const PUBLIC_MAX_LIMIT = 100;
const ADMIN_MAX_LIMIT = 1000;

function clampLimit(limit: number | undefined, max: number): number | undefined {
  if (limit === undefined) return undefined;
  const n = Math.floor(limit);
  if (!isFinite(n) || n <= 0) return undefined;
  return Math.min(n, max);
}

export class Database {
  constructor(private db: D1Database) {}

  // ---------------------------------------------------------------- Comments

  async createComment(data: {
    page_url: string;
    parent_id: number | null;
    author_name: string;
    author_email: string;
    author_url: string | null;
    content: string;
    ip_address: string;
    user_agent: string;
    status?: CommentStatus;
  }): Promise<Comment> {
    // BUG FIXED: the previous implementation always inserted with the
    // schema default status ('pending') and then issued a SECOND query
    // to flip it to 'approved' when moderation was off. That's a race
    // condition (the comment briefly exists as 'pending' and could be
    // served by a concurrent read) and an unnecessary extra round-trip
    // to D1. We now insert with the final status in a single statement.
    const finalStatus: CommentStatus = data.status || 'pending';

    const result = await this.db
      .prepare(
        `INSERT INTO comments (page_url, parent_id, author_name, author_email, author_url, content, status, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        data.page_url,
        data.parent_id,
        data.author_name,
        data.author_email,
        data.author_url,
        data.content,
        finalStatus,
        data.ip_address,
        data.user_agent
      )
      .run();

    if (!result.success) {
      throw new Error('Failed to create comment');
    }

    const comment = await this.getCommentById(result.meta.last_row_id as number);
    if (!comment) {
      throw new Error('Failed to retrieve created comment');
    }

    return comment;
  }

  async getCommentById(id: number): Promise<Comment | null> {
    const result = await this.db
      .prepare('SELECT * FROM comments WHERE id = ?')
      .bind(id)
      .first<Comment>();
    return result || null;
  }

  /**
   * Fetch a single comment by ID, but only if it is in a publicly-visible
   * state (i.e. 'approved'). The plain `getCommentById` returns rows in
   * any status — including pending, spam, and deleted — which is correct
   * for admin usage but is an information-disclosure bug when used from
   * public endpoints.
   */
  async getPublicCommentById(id: number): Promise<Comment | null> {
    const result = await this.db
      .prepare("SELECT * FROM comments WHERE id = ? AND status = 'approved'")
      .bind(id)
      .first<Comment>();
    return result || null;
  }

  async getCommentsByPageUrl(pageUrl: string, status: CommentStatus = 'approved'): Promise<Comment[]> {
    const result = await this.db
      .prepare('SELECT * FROM comments WHERE page_url = ? AND status = ? ORDER BY created_at ASC')
      .bind(pageUrl, status)
      .all<Comment>();
    return result.results;
  }

  async getComments(filter: {
    page_url?: string;
    status?: CommentStatus;
    author_email?: string;
    ip_address?: string;
    limit?: number;
    offset?: number;
    sort_order?: 'asc' | 'desc';
    /** when true, clamps the limit to the public cap (default false = admin cap) */
    publicMode?: boolean;
  } = {}): Promise<Comment[]> {
    let query = 'SELECT * FROM comments WHERE 1=1';
    const params: any[] = [];

    if (filter.page_url) {
      query += ' AND page_url = ?';
      params.push(filter.page_url);
    }

    if (filter.status) {
      query += ' AND status = ?';
      params.push(filter.status);
    }

    if (filter.author_email) {
      query += ' AND author_email = ?';
      params.push(filter.author_email);
    }

    if (filter.ip_address) {
      query += ' AND ip_address = ?';
      params.push(filter.ip_address);
    }

    const sortOrder = filter.sort_order === 'desc' ? 'DESC' : 'ASC';
    query += ` ORDER BY created_at ${sortOrder}`;

    const cap = filter.publicMode ? PUBLIC_MAX_LIMIT : ADMIN_MAX_LIMIT;
    const limit = clampLimit(filter.limit, cap);
    if (limit !== undefined) {
      query += ' LIMIT ?';
      params.push(limit);
    } else if (filter.publicMode) {
      // always enforce a cap on public queries
      query += ` LIMIT ${PUBLIC_MAX_LIMIT}`;
    }

    if (filter.offset !== undefined && filter.offset > 0) {
      query += ' OFFSET ?';
      params.push(Math.floor(filter.offset));
    }

    const stmt = this.db.prepare(query);
    const result = await stmt.bind(...params).all<Comment>();
    return result.results;
  }

  async updateComment(
    id: number,
    data: Partial<Pick<Comment, 'status' | 'content'>>
  ): Promise<boolean> {
    const updates: string[] = [];
    const params: any[] = [];

    if (data.status !== undefined) {
      updates.push('status = ?');
      params.push(data.status);
    }

    if (data.content !== undefined) {
      updates.push('content = ?, updated_at = CURRENT_TIMESTAMP');
      params.push(data.content);
    }

    if (updates.length === 0) {
      return false;
    }

    params.push(id);
    const query = `UPDATE comments SET ${updates.join(', ')} WHERE id = ?`;
    const result = await this.db.prepare(query).bind(...params).run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async deleteComment(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM comments WHERE id = ?')
      .bind(id)
      .run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  /**
   * Insert a comment with full control over every column. Used by the
   * import flow to preserve the original `status`, `created_at`,
   * `updated_at`, `ip_address`, `user_agent`, and `parent_id` from the
   * source export. The public `createComment` method always sets
   * `created_at` and `updated_at` to CURRENT_TIMESTAMP via the schema
   * defaults, which would destroy historical timestamps on import.
   *
   * Returns the new row ID.
   */
  async importComment(data: {
    page_url: string;
    parent_id: number | null;
    author_name: string;
    author_email: string;
    author_url: string | null;
    content: string;
    status: CommentStatus;
    ip_address: string;
    user_agent: string;
    created_at: string;
    updated_at: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `INSERT INTO comments
           (page_url, parent_id, author_name, author_email, author_url, content, status, ip_address, user_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        data.page_url,
        data.parent_id,
        data.author_name,
        data.author_email,
        data.author_url,
        data.content,
        data.status,
        data.ip_address,
        data.user_agent,
        data.created_at,
        data.updated_at
      )
      .run();

    if (!result.success) {
      throw new Error('Failed to import comment');
    }
    return result.meta.last_row_id as number;
  }

  /**
   * Insert a subscription row, preserving the original unsubscribe
   * `token` so that previously-sent notification links keep working
   * after a migration. Returns true on insert, false on duplicate
   * (same page_url+email OR same token already exists).
   */
  async importSubscription(data: {
    page_url: string;
    email: string;
    token: string;
    active: number;
  }): Promise<boolean> {
    try {
      const result = await this.db
        .prepare(
          `INSERT OR IGNORE INTO subscriptions (page_url, email, token, active)
           VALUES (?, ?, ?, ?)`
        )
        .bind(data.page_url, data.email, data.token, data.active)
        .run();
      return result.success && (result.meta.changes || 0) > 0;
    } catch {
      return false;
    }
  }

  async getCommentCount(filter: { page_url?: string; status?: CommentStatus } = {}): Promise<number> {
    let query = 'SELECT COUNT(*) as count FROM comments WHERE 1=1';
    const params: any[] = [];

    if (filter.page_url) {
      query += ' AND page_url = ?';
      params.push(filter.page_url);
    }

    if (filter.status) {
      query += ' AND status = ?';
      params.push(filter.status);
    }

    const result = await this.db.prepare(query).bind(...params).first<{ count: number }>();
    return result?.count || 0;
  }

  // --------------------------------------------------------- Votes / Reactions

  async createVote(data: {
    comment_id: number;
    ip_address: string;
    reaction_type: ReactionType;
  }): Promise<Vote> {
    const result = await this.db
      .prepare(
        `INSERT INTO votes (comment_id, ip_address, reaction_type)
         VALUES (?, ?, ?)`
      )
      .bind(data.comment_id, data.ip_address, data.reaction_type)
      .run();

    if (!result.success) {
      throw new Error('Failed to create vote');
    }

    const vote = await this.db
      .prepare('SELECT * FROM votes WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<Vote>();
    if (!vote) {
      throw new Error('Failed to retrieve created vote');
    }

    return vote;
  }

  async removeVote(commentId: number, ipAddress: string, reactionType: ReactionType): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM votes WHERE comment_id = ? AND ip_address = ? AND reaction_type = ?`
      )
      .bind(commentId, ipAddress, reactionType)
      .run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async getCommentReactions(commentId: number): Promise<ReactionCounts> {
    const result = await this.db
      .prepare(
        `SELECT reaction_type, COUNT(*) as count FROM votes WHERE comment_id = ? GROUP BY reaction_type`
      )
      .bind(commentId)
      .all<{ reaction_type: ReactionType; count: number }>();

    const counts: ReactionCounts = {
      heart: 0,
      thumbs_up: 0,
      thumbs_down: 0,
      laugh: 0,
      cry: 0,
      fire: 0,
      clap: 0,
    };

    for (const row of result.results) {
      const key = row.reaction_type as keyof ReactionCounts;
      if (key in counts) {
        counts[key] = row.count;
      }
    }

    return counts;
  }

  /**
   * BUG FIXED: the previous `getUserVote` (singular) returned only the
   * FIRST reaction type a user had cast on a comment. Combined with the
   * schema's `UNIQUE(comment_id, ip_address, reaction_type)` constraint
   * — which ALLOWS multiple reaction types per user per comment — this
   * meant the toggle logic in `handleCreateVote` was broken: voting
   * "heart" then "thumbs_up" would silently delete the "heart" vote
   * instead of adding "thumbs_up" alongside it.
   *
   * The new `getUserVotes` returns the full set of reaction types the
   * user has cast on the comment, which the toggle logic can reason
   * about correctly.
   */
  async getUserVotes(commentId: number, ipAddress: string): Promise<ReactionType[]> {
    const result = await this.db
      .prepare(
        `SELECT reaction_type FROM votes WHERE comment_id = ? AND ip_address = ?`
      )
      .bind(commentId, ipAddress)
      .all<{ reaction_type: ReactionType }>();
    return result.results.map(r => r.reaction_type);
  }

  // ------------------------------------------------------------- Post Reactions

  async createPostReaction(data: {
    page_url: string;
    ip_address: string;
    reaction_type: ReactionType;
  }): Promise<PostReaction> {
    const result = await this.db
      .prepare(
        `INSERT INTO post_reactions (page_url, ip_address, reaction_type)
         VALUES (?, ?, ?)`
      )
      .bind(data.page_url, data.ip_address, data.reaction_type)
      .run();

    if (!result.success) {
      throw new Error('Failed to create post reaction');
    }

    const reaction = await this.db
      .prepare('SELECT * FROM post_reactions WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<PostReaction>();
    if (!reaction) {
      throw new Error('Failed to retrieve created post reaction');
    }

    return reaction;
  }

  async removePostReaction(
    pageUrl: string,
    ipAddress: string,
    reactionType: ReactionType
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `DELETE FROM post_reactions WHERE page_url = ? AND ip_address = ? AND reaction_type = ?`
      )
      .bind(pageUrl, ipAddress, reactionType)
      .run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  /**
   * Look up whether a given (page_url, ip, reaction_type) reaction already
   * exists. Used by the toggle logic in the post-reaction handler so we
   * can decide between INSERT and DELETE without relying on fragile
   * string matching of D1 error messages.
   */
  async getPostReaction(
    pageUrl: string,
    ipAddress: string,
    reactionType: ReactionType
  ): Promise<PostReaction | null> {
    const result = await this.db
      .prepare(
        `SELECT * FROM post_reactions WHERE page_url = ? AND ip_address = ? AND reaction_type = ? LIMIT 1`
      )
      .bind(pageUrl, ipAddress, reactionType)
      .first<PostReaction>();
    return result || null;
  }

  async getPostReactions(pageUrl: string): Promise<ReactionCounts> {
    const result = await this.db
      .prepare(
        `SELECT reaction_type, COUNT(*) as count FROM post_reactions WHERE page_url = ? GROUP BY reaction_type`
      )
      .bind(pageUrl)
      .all<{ reaction_type: ReactionType; count: number }>();

    const counts: ReactionCounts = {
      heart: 0,
      thumbs_up: 0,
      thumbs_down: 0,
      laugh: 0,
      cry: 0,
      fire: 0,
      clap: 0,
    };

    for (const row of result.results) {
      const key = row.reaction_type as keyof ReactionCounts;
      if (key in counts) {
        counts[key] = row.count;
      }
    }

    return counts;
  }

  // ------------------------------------------------------------- Subscriptions

  async createSubscription(data: {
    page_url: string;
    email: string;
    token: string;
  }): Promise<Subscription> {
    const result = await this.db
      .prepare(
        `INSERT INTO subscriptions (page_url, email, token)
         VALUES (?, ?, ?)`
      )
      .bind(data.page_url, data.email, data.token)
      .run();

    if (!result.success) {
      throw new Error('Failed to create subscription');
    }

    const subscription = await this.db
      .prepare('SELECT * FROM subscriptions WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<Subscription>();
    if (!subscription) {
      throw new Error('Failed to retrieve created subscription');
    }

    return subscription;
  }

  async getSubscriptionByToken(token: string): Promise<Subscription | null> {
    const result = await this.db
      .prepare('SELECT * FROM subscriptions WHERE token = ?')
      .bind(token)
      .first<Subscription>();
    return result || null;
  }

  /**
   * Look up the unsubscribe token for a given (page_url, email) pair.
   * Used by the email-notification code to build working unsubscribe
   * links — the previous implementation generated a brand-new hash
   * that did NOT match anything in the `subscriptions` table, so every
   * "unsubscribe" link in every notification email returned 404.
   */
  async getSubscriptionToken(pageUrl: string, email: string): Promise<string | null> {
    const result = await this.db
      .prepare(
        `SELECT token FROM subscriptions WHERE page_url = ? AND email = ? AND active = 1 LIMIT 1`
      )
      .bind(pageUrl, email)
      .first<{ token: string }>();
    return result?.token || null;
  }

  async getSubscriptionsByEmail(email: string): Promise<Subscription[]> {
    const result = await this.db
      .prepare('SELECT * FROM subscriptions WHERE email = ?')
      .bind(email)
      .all<Subscription>();
    return result.results;
  }

  async getSubscriptionsByPageUrl(pageUrl: string): Promise<Subscription[]> {
    const result = await this.db
      .prepare('SELECT * FROM subscriptions WHERE page_url = ? AND active = 1')
      .bind(pageUrl)
      .all<Subscription>();
    return result.results;
  }

  async unsubscribe(token: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE subscriptions SET active = 0 WHERE token = ?')
      .bind(token)
      .run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  // ------------------------------------------------------------------- Settings

  async getSetting(key: string): Promise<string | null> {
    const result = await this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return result?.value || null;
  }

  async setSetting(key: string, value: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`
      )
      .bind(key, value)
      .run();
    return result.success;
  }

  async getAllSettings(): Promise<Record<string, string>> {
    const result = await this.db.prepare('SELECT * FROM settings').all<Setting>();
    const settings: Record<string, string> = {};
    for (const row of result.results) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  // ------------------------------------------------------------------- Sessions

  async createSession(data: {
    token: string;
    expires_at: string;
    ip_address: string | null;
    user_agent: string | null;
  }): Promise<Session> {
    const result = await this.db
      .prepare(
        `INSERT INTO sessions (token, expires_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?)`
      )
      .bind(data.token, data.expires_at, data.ip_address, data.user_agent)
      .run();

    if (!result.success) {
      throw new Error('Failed to create session');
    }

    const session = await this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<Session>();
    if (!session) {
      throw new Error('Failed to retrieve created session');
    }

    return session;
  }

  async getSessionByToken(token: string): Promise<Session | null> {
    const result = await this.db
      .prepare('SELECT * FROM sessions WHERE token = ?')
      .bind(token)
      .first<Session>();
    return result || null;
  }

  async updateSession(token: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE token = ?')
      .bind(token)
      .run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async deleteSession(token: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM sessions WHERE token = ?')
      .bind(token)
      .run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async deleteExpiredSessions(): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`)
      .run();
    return result.meta.changes || 0;
  }

  // ------------------------------------------------------------- Login Attempts

  async createLoginAttempt(data: {
    ip_address: string;
    success: number;
  }): Promise<LoginAttempt> {
    const result = await this.db
      .prepare(
        `INSERT INTO login_attempts (ip_address, success)
         VALUES (?, ?)`
      )
      .bind(data.ip_address, data.success)
      .run();

    if (!result.success) {
      throw new Error('Failed to create login attempt');
    }

    const attempt = await this.db
      .prepare('SELECT * FROM login_attempts WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<LoginAttempt>();
    if (!attempt) {
      throw new Error('Failed to retrieve created login attempt');
    }

    return attempt;
  }

  /**
   * Count recent FAILED login attempts for an IP.
   *
   * BUG FIXED: the previous implementation interpolated `minutes` directly
   * into the SQL string (e.g. `datetime('now', '-${minutes} minutes')`).
   * While `minutes` happened to always be a number from internal callers,
   * string-interpolating values into SQL is a well-known footgun and
   * triggers lint warnings. We now compute the cutoff timestamp in JS and
   * bind it as a parameter, which is both safer and more portable across
   * SQLite builds.
   */
  async getRecentFailedLoginAttempts(ipAddress: string, minutes: number = 15): Promise<number> {
    const safeMinutes = Math.max(0, Math.floor(minutes));
    const cutoff = new Date(Date.now() - safeMinutes * 60 * 1000).toISOString();
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM login_attempts
         WHERE ip_address = ? AND success = 0 AND attempted_at > ?`
      )
      .bind(ipAddress, cutoff)
      .first<{ count: number }>();
    return result?.count || 0;
  }

  async cleanupOldLoginAttempts(): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-7 days')`)
      .run();
    return result.meta.changes || 0;
  }

  // ----------------------------------------------------- Vote Log (rate limiting)

  async logVote(ipAddress: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO vote_log (ip_address) VALUES (?)')
      .bind(ipAddress)
      .run();
  }

  /**
   * Count recent vote_log entries for an IP.
   *
   * BUG FIXED: same string-interpolation issue as
   * `getRecentFailedLoginAttempts`. Fixed by computing the cutoff in JS
   * and binding it as a parameter.
   */
  async getRecentVoteCount(ipAddress: string, minutes: number = 60): Promise<number> {
    const safeMinutes = Math.max(0, Math.floor(minutes));
    const cutoff = new Date(Date.now() - safeMinutes * 60 * 1000).toISOString();
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM vote_log
         WHERE ip_address = ? AND created_at > ?`
      )
      .bind(ipAddress, cutoff)
      .first<{ count: number }>();
    return result?.count || 0;
  }

  async cleanupOldVoteLogs(): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM vote_log WHERE created_at < datetime('now', '-1 hour')`)
      .run();
    return result.meta.changes || 0;
  }

  // ---------------------------------------- Post-reaction Log (rate limiting)

  /**
   * Log a post-reaction event for rate-limiting purposes.
   *
   * BUG FIXED: previously, `handleCreatePostReaction` called
   * `rateLimiter.logVote(ip)` to record post reactions, which mixed
   * post-reaction events into the vote_log table. This had two
   * consequences:
   *   1. The vote rate limit (20/hour) and post-reaction rate limit
   *      (10/hour) shared the same counter, so a user who cast 20
   *      votes could not react to any posts, and vice versa.
   *   2. `checkPostReactionLimit` actually called `getRecentVoteCount`,
   *      so it was counting vote events — meaning the two limits
   *      weren't even internally consistent.
   *
   * We now keep a separate `post_reaction_log` table so each limit is
   * counted independently. See `migrations/schema.sql`.
   */
  async logPostReaction(ipAddress: string): Promise<void> {
    await this.db
      .prepare('INSERT INTO post_reaction_log (ip_address) VALUES (?)')
      .bind(ipAddress)
      .run();
  }

  async getRecentPostReactionCount(ipAddress: string, minutes: number = 60): Promise<number> {
    const safeMinutes = Math.max(0, Math.floor(minutes));
    const cutoff = new Date(Date.now() - safeMinutes * 60 * 1000).toISOString();
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM post_reaction_log
         WHERE ip_address = ? AND created_at > ?`
      )
      .bind(ipAddress, cutoff)
      .first<{ count: number }>();
    return result?.count || 0;
  }

  async cleanupOldPostReactionLogs(): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM post_reaction_log WHERE created_at < datetime('now', '-1 hour')`)
      .run();
    return result.meta.changes || 0;
  }

  // --------------------------------------------------------- Comment rate limit

  /**
   * Count recent comments by IP using a single COUNT(*) query.
   *
   * BUG FIXED: the previous `RateLimiter.checkCommentLimit` fetched up
   * to 1000 most-recent comments for the IP and then filtered in JS by
   * timestamp. That approach:
   *   - transferred up to 1000 full comment rows over the network on
   *     every single POST /api/comments request
   *   - did the time filter in JavaScript instead of in the database
   *   - silently mis-counted once the IP had more than 1000 comments
   *
   * We now issue a single indexed COUNT(*) query that uses the
   * `idx_ip_address` index on the comments table.
   */
  async getRecentCommentCountByIp(ipAddress: string, minutes: number = 60): Promise<number> {
    const safeMinutes = Math.max(0, Math.floor(minutes));
    const cutoff = new Date(Date.now() - safeMinutes * 60 * 1000).toISOString();
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) as count FROM comments
         WHERE ip_address = ? AND created_at > ?`
      )
      .bind(ipAddress, cutoff)
      .first<{ count: number }>();
    return result?.count || 0;
  }

  // -------------------------------------------------------------- Email Queue

  async createEmailQueue(data: {
    comment_id: number | null;
    recipient_email: string;
    recipient_name: string | null;
    email_type: string;
    subject: string;
    body: string;
  }): Promise<{ id: number }> {
    const result = await this.db
      .prepare(
        `INSERT INTO email_queue (comment_id, recipient_email, recipient_name, email_type, subject, body)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        data.comment_id,
        data.recipient_email,
        data.recipient_name,
        data.email_type,
        data.subject,
        data.body
      )
      .run();

    if (!result.success) {
      throw new Error('Failed to create email queue entry');
    }

    return { id: result.meta.last_row_id as number };
  }

  async getPendingEmails(limit: number = 50): Promise<EmailQueue[]> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
    const result = await this.db
      .prepare(
        `SELECT * FROM email_queue
         WHERE status = 'pending' AND attempts < 5
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .bind(safeLimit)
      .all<EmailQueue>();
    return result.results;
  }

  async markEmailSent(id: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE email_queue SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`
      )
      .bind(id)
      .run();
  }

  /**
   * Increment the attempt counter and record the failure reason.
   *
   * BUG FIXED: the previous implementation unconditionally set
   * `status = 'failed'` after the FIRST failure, which prevented
   * retries. The schema's `attempts < 5` filter in `getPendingEmails`
   * implies the intent was up to 5 retries before giving up. We now
   * only set `status = 'failed'` once `attempts >= 5`.
   */
  async incrementEmailAttempts(id: number, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE email_queue
         SET attempts = attempts + 1,
             last_error = ?,
             status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE status END
         WHERE id = ?`
      )
      .bind(error, id)
      .run();
  }

  // ----------------------------------------------------------------- Analytics

  async getAnalytics(): Promise<{
    total_comments: number;
    approved_comments: number;
    pending_comments: number;
    spam_comments: number;
    total_reactions: number;
    total_subscribers: number;
    comments_by_page: Array<{ page_url: string; count: number }>;
    comments_by_date: Array<{ date: string; count: number }>;
    reactions_by_type: Record<string, number>;
  }> {
    const emptyCounts: Record<string, number> = {
      heart: 0,
      thumbs_up: 0,
      thumbs_down: 0,
      laugh: 0,
      cry: 0,
      fire: 0,
      clap: 0,
    };

    const [total, approved, pending, spam, reactions, subscribers, byPage, byDate, byType] =
      await Promise.all([
        this.db.prepare('SELECT COUNT(*) as count FROM comments').first<{ count: number }>(),
        this.db
          .prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'approved'")
          .first<{ count: number }>(),
        this.db
          .prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'pending'")
          .first<{ count: number }>(),
        this.db
          .prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'spam'")
          .first<{ count: number }>(),
        this.db.prepare('SELECT COUNT(*) as count FROM votes').first<{ count: number }>(),
        this.db
          .prepare('SELECT COUNT(*) as count FROM subscriptions WHERE active = 1')
          .first<{ count: number }>(),
        this.db
          .prepare(
            `SELECT page_url, COUNT(*) as count FROM comments
             GROUP BY page_url ORDER BY count DESC LIMIT 20`
          )
          .all<{ page_url: string; count: number }>(),
        this.db
          .prepare(
            `SELECT DATE(created_at) as date, COUNT(*) as count FROM comments
             WHERE created_at > datetime('now', '-30 days')
             GROUP BY DATE(created_at) ORDER BY date DESC`
          )
          .all<{ date: string; count: number }>(),
        this.db
          .prepare(`SELECT reaction_type, COUNT(*) as count FROM votes GROUP BY reaction_type`)
          .all<{ reaction_type: string; count: number }>(),
      ]);

    const reactionsByType: Record<string, number> = { ...emptyCounts };
    for (const row of byType.results) {
      if (row.reaction_type in reactionsByType) {
        reactionsByType[row.reaction_type] = row.count;
      } else {
        reactionsByType[row.reaction_type] = row.count;
      }
    }

    return {
      total_comments: total?.count || 0,
      approved_comments: approved?.count || 0,
      pending_comments: pending?.count || 0,
      spam_comments: spam?.count || 0,
      total_reactions: reactions?.count || 0,
      total_subscribers: subscribers?.count || 0,
      comments_by_page: byPage.results,
      comments_by_date: byDate.results,
      reactions_by_type: reactionsByType,
    };
  }
}
