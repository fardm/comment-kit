// Database helper functions for D1

import type { Comment, CommentStatus, ReactionCounts, ReactionType, Vote, PostReaction, Subscription, EmailQueue, Session, LoginAttempt, Setting } from '../types';

export class Database {
  constructor(private db: D1Database) {}

  // Comments
  async createComment(data: {
    page_url: string;
    parent_id: number | null;
    author_name: string;
    author_email: string;
    author_url: string | null;
    content: string;
    ip_address: string;
    user_agent: string;
  }): Promise<Comment> {
    const result = await this.db.prepare(`
      INSERT INTO comments (page_url, parent_id, author_name, author_email, author_url, content, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      data.page_url,
      data.parent_id,
      data.author_name,
      data.author_email,
      data.author_url,
      data.content,
      data.ip_address,
      data.user_agent
    ).run();

    if (!result.success) {
      throw new Error('Failed to create comment');
    }

    const comment = await this.getCommentById(result.meta.last_row_id);
    if (!comment) {
      throw new Error('Failed to retrieve created comment');
    }

    return comment;
  }

  async getCommentById(id: number): Promise<Comment | null> {
    const result = await this.db.prepare('SELECT * FROM comments WHERE id = ?').bind(id).first<Comment>();
    return result || null;
  }

  async getCommentsByPageUrl(pageUrl: string, status: CommentStatus = 'approved'): Promise<Comment[]> {
    const result = await this.db.prepare(
      'SELECT * FROM comments WHERE page_url = ? AND status = ? ORDER BY created_at ASC'
    ).bind(pageUrl, status).all<Comment>();
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

    const sortOrder = filter.sort_order || 'asc';
    query += ` ORDER BY created_at ${sortOrder}`;

    if (filter.limit) {
      query += ' LIMIT ?';
      params.push(filter.limit);
    }

    if (filter.offset) {
      query += ' OFFSET ?';
      params.push(filter.offset);
    }

    const stmt = this.db.prepare(query);
    const result = await stmt.bind(...params).all<Comment>();
    return result.results;
  }

  async updateComment(id: number, data: Partial<Pick<Comment, 'status' | 'content'>>): Promise<boolean> {
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
    const result = await this.db.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async getCommentCount(filter: {
    page_url?: string;
    status?: CommentStatus;
  } = {}): Promise<number> {
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

  // Votes/Reactions
  async createVote(data: {
    comment_id: number;
    ip_address: string;
    reaction_type: ReactionType;
  }): Promise<Vote> {
    const result = await this.db.prepare(`
      INSERT INTO votes (comment_id, ip_address, reaction_type)
      VALUES (?, ?, ?)
    `).bind(data.comment_id, data.ip_address, data.reaction_type).run();

    if (!result.success) {
      throw new Error('Failed to create vote');
    }

    const vote = await this.db.prepare('SELECT * FROM votes WHERE id = ?').bind(result.meta.last_row_id).first<Vote>();
    if (!vote) {
      throw new Error('Failed to retrieve created vote');
    }

    return vote;
  }

  async removeVote(commentId: number, ipAddress: string, reactionType: ReactionType): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM votes WHERE comment_id = ? AND ip_address = ? AND reaction_type = ?
    `).bind(commentId, ipAddress, reactionType).run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async getCommentReactions(commentId: number): Promise<ReactionCounts> {
    const result = await this.db.prepare(`
      SELECT reaction_type, COUNT(*) as count FROM votes WHERE comment_id = ? GROUP BY reaction_type
    `).bind(commentId).all<{ reaction_type: ReactionType; count: number }>();

    const counts: ReactionCounts = {
      heart: 0,
      thumbs_up: 0,
      thumbs_down: 0,
      laugh: 0,
      cry: 0,
      fire: 0,
      clap: 0
    };

    for (const row of result.results) {
      counts[row.reaction_type as ReactionType] = row.count;
    }

    return counts;
  }

  async getUserVote(commentId: number, ipAddress: string): Promise<ReactionType | null> {
    const result = await this.db.prepare(`
      SELECT reaction_type FROM votes WHERE comment_id = ? AND ip_address = ? LIMIT 1
    `).bind(commentId, ipAddress).first<{ reaction_type: ReactionType }>();
    return result?.reaction_type || null;
  }

  // Post Reactions
  async createPostReaction(data: {
    page_url: string;
    ip_address: string;
    reaction_type: ReactionType;
  }): Promise<PostReaction> {
    const result = await this.db.prepare(`
      INSERT INTO post_reactions (page_url, ip_address, reaction_type)
      VALUES (?, ?, ?)
    `).bind(data.page_url, data.ip_address, data.reaction_type).run();

    if (!result.success) {
      throw new Error('Failed to create post reaction');
    }

    const reaction = await this.db.prepare('SELECT * FROM post_reactions WHERE id = ?')
      .bind(result.meta.last_row_id).first<PostReaction>();
    if (!reaction) {
      throw new Error('Failed to retrieve created post reaction');
    }

    return reaction;
  }

  async removePostReaction(pageUrl: string, ipAddress: string, reactionType: ReactionType): Promise<boolean> {
    const result = await this.db.prepare(`
      DELETE FROM post_reactions WHERE page_url = ? AND ip_address = ? AND reaction_type = ?
    `).bind(pageUrl, ipAddress, reactionType).run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async getPostReactions(pageUrl: string): Promise<ReactionCounts> {
    const result = await this.db.prepare(`
      SELECT reaction_type, COUNT(*) as count FROM post_reactions WHERE page_url = ? GROUP BY reaction_type
    `).bind(pageUrl).all<{ reaction_type: ReactionType; count: number }>();

    const counts: ReactionCounts = {
      heart: 0,
      thumbs_up: 0,
      thumbs_down: 0,
      laugh: 0,
      cry: 0,
      fire: 0,
      clap: 0
    };

    for (const row of result.results) {
      counts[row.reaction_type as ReactionType] = row.count;
    }

    return counts;
  }

  // Subscriptions
  async createSubscription(data: {
    page_url: string;
    email: string;
    token: string;
  }): Promise<Subscription> {
    const result = await this.db.prepare(`
      INSERT INTO subscriptions (page_url, email, token)
      VALUES (?, ?, ?)
    `).bind(data.page_url, data.email, data.token).run();

    if (!result.success) {
      throw new Error('Failed to create subscription');
    }

    const subscription = await this.db.prepare('SELECT * FROM subscriptions WHERE id = ?')
      .bind(result.meta.last_row_id).first<Subscription>();
    if (!subscription) {
      throw new Error('Failed to retrieve created subscription');
    }

    return subscription;
  }

  async getSubscriptionByToken(token: string): Promise<Subscription | null> {
    const result = await this.db.prepare('SELECT * FROM subscriptions WHERE token = ?').bind(token).first<Subscription>();
    return result || null;
  }

  async getSubscriptionsByEmail(email: string): Promise<Subscription[]> {
    const result = await this.db.prepare('SELECT * FROM subscriptions WHERE email = ?').bind(email).all<Subscription>();
    return result.results;
  }

  async getSubscriptionsByPageUrl(pageUrl: string): Promise<Subscription[]> {
    const result = await this.db.prepare('SELECT * FROM subscriptions WHERE page_url = ? AND active = 1')
      .bind(pageUrl).all<Subscription>();
    return result.results;
  }

  async unsubscribe(token: string): Promise<boolean> {
    const result = await this.db.prepare('UPDATE subscriptions SET active = 0 WHERE token = ?').bind(token).run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  // Settings
  async getSetting(key: string): Promise<string | null> {
    const result = await this.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
    return result?.value || null;
  }

  async setSetting(key: string, value: string): Promise<boolean> {
    const result = await this.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
    `).bind(key, value).run();
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

  // Sessions
  async createSession(data: {
    token: string;
    expires_at: string;
    ip_address: string | null;
    user_agent: string | null;
  }): Promise<Session> {
    const result = await this.db.prepare(`
      INSERT INTO sessions (token, expires_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?)
    `).bind(data.token, data.expires_at, data.ip_address, data.user_agent).run();

    if (!result.success) {
      throw new Error('Failed to create session');
    }

    const session = await this.db.prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(result.meta.last_row_id).first<Session>();
    if (!session) {
      throw new Error('Failed to retrieve created session');
    }

    return session;
  }

  async getSessionByToken(token: string): Promise<Session | null> {
    const result = await this.db.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first<Session>();
    return result || null;
  }

  async updateSession(token: string): Promise<boolean> {
    const result = await this.db.prepare('UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE token = ?').bind(token).run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async deleteSession(token: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return result.success && (result.meta.changes || 0) > 0;
  }

  async deleteExpiredSessions(): Promise<number> {
    const result = await this.db.prepare('DELETE FROM sessions WHERE expires_at < datetime("now")').run();
    return result.meta.changes || 0;
  }

  // Login Attempts
  async createLoginAttempt(data: {
    ip_address: string;
    success: number;
  }): Promise<LoginAttempt> {
    const result = await this.db.prepare(`
      INSERT INTO login_attempts (ip_address, success)
      VALUES (?, ?)
    `).bind(data.ip_address, data.success).run();

    if (!result.success) {
      throw new Error('Failed to create login attempt');
    }

    const attempt = await this.db.prepare('SELECT * FROM login_attempts WHERE id = ?')
      .bind(result.meta.last_row_id).first<LoginAttempt>();
    if (!attempt) {
      throw new Error('Failed to retrieve created login attempt');
    }

    return attempt;
  }

  async getRecentFailedLoginAttempts(ipAddress: string, minutes: number = 15): Promise<number> {
    const result = await this.db.prepare(`
      SELECT COUNT(*) as count FROM login_attempts
      WHERE ip_address = ? AND success = 0 AND attempted_at > datetime('now', '-${minutes} minutes')
    `).bind(ipAddress).first<{ count: number }>();
    return result?.count || 0;
  }

  async cleanupOldLoginAttempts(): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-7 days')
    `).run();
    return result.meta.changes || 0;
  }

  // Vote Log (for rate limiting)
  async logVote(ipAddress: string): Promise<void> {
    await this.db.prepare('INSERT INTO vote_log (ip_address) VALUES (?)').bind(ipAddress).run();
  }

  async getRecentVoteCount(ipAddress: string, minutes: number = 60): Promise<number> {
    const result = await this.db.prepare(`
      SELECT COUNT(*) as count FROM vote_log
      WHERE ip_address = ? AND created_at > datetime('now', '-${minutes} minutes')
    `).bind(ipAddress).first<{ count: number }>();
    return result?.count || 0;
  }

  async cleanupOldVoteLogs(): Promise<number> {
    const result = await this.db.prepare('DELETE FROM vote_log WHERE created_at < datetime("now", "-1 hour")').run();
    return result.meta.changes || 0;
  }

  // Email Queue
  async createEmailQueue(data: {
    comment_id: number | null;
    recipient_email: string;
    recipient_name: string | null;
    email_type: string;
    subject: string;
    body: string;
  }): Promise<any> {
    const result = await this.db.prepare(`
      INSERT INTO email_queue (comment_id, recipient_email, recipient_name, email_type, subject, body)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      data.comment_id,
      data.recipient_email,
      data.recipient_name,
      data.email_type,
      data.subject,
      data.body
    ).run();

    if (!result.success) {
      throw new Error('Failed to create email queue entry');
    }

    return { id: result.meta.last_row_id };
  }

  async getPendingEmails(limit: number = 50): Promise<any[]> {
    const result = await this.db.prepare(`
      SELECT * FROM email_queue 
      WHERE status = 'pending' AND attempts < 5
      ORDER BY created_at ASC
      LIMIT ?
    `).bind(limit).all();
    return result.results;
  }

  async markEmailSent(id: number): Promise<void> {
    await this.db.prepare(`
      UPDATE email_queue SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(id).run();
  }

  async incrementEmailAttempts(id: number, error: string): Promise<void> {
    await this.db.prepare(`
      UPDATE email_queue 
      SET attempts = attempts + 1, last_error = ?, status = 'failed'
      WHERE id = ?
    `).bind(error, id).run();
  }

  // Analytics
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
    const [total, approved, pending, spam, reactions, subscribers, byPage, byDate, byType] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) as count FROM comments').first<{ count: number }>(),
      this.db.prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'approved'").first<{ count: number }>(),
      this.db.prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'pending'").first<{ count: number }>(),
      this.db.prepare("SELECT COUNT(*) as count FROM comments WHERE status = 'spam'").first<{ count: number }>(),
      this.db.prepare('SELECT COUNT(*) as count FROM votes').first<{ count: number }>(),
      this.db.prepare('SELECT COUNT(*) as count FROM subscriptions WHERE active = 1').first<{ count: number }>(),
      this.db.prepare(`
        SELECT page_url, COUNT(*) as count FROM comments
        GROUP BY page_url ORDER BY count DESC LIMIT 20
      `).all<{ page_url: string; count: number }>(),
      this.db.prepare(`
        SELECT DATE(created_at) as date, COUNT(*) as count FROM comments
        WHERE created_at > datetime('now', '-30 days')
        GROUP BY DATE(created_at) ORDER BY date DESC
      `).all<{ date: string; count: number }>(),
      this.db.prepare(`
        SELECT reaction_type, COUNT(*) as count FROM votes GROUP BY reaction_type
      `).all<{ reaction_type: string; count: number }>()
    ]);

    const reactionsByType: Record<string, number> = {};
    for (const row of byType.results) {
      reactionsByType[row.reaction_type] = row.count;
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
      reactions_by_type: reactionsByType
    };
  }
}
