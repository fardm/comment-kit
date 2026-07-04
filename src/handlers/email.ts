// Email notification handlers

import type { Env } from '../types';
import { Database } from '../lib/db';

export class EmailService {
  private db: Database;
  private env: Env;

  constructor(env: Env, db: Database) {
    this.db = db;
    this.env = env;
  }

  async queueEmail(data: {
    comment_id: number | null;
    recipient_email: string;
    recipient_name: string | null;
    email_type: 'parent_reply' | 'subscriber' | 'admin';
    subject: string;
    body: string;
  }): Promise<void> {
    await this.db.createEmailQueue(data);
  }

  /**
   * Drain the pending email queue.
   *
   * Designed to be invoked from a Cloudflare Workers `scheduled` handler
   * (i.e. a cron trigger). Each invocation processes a bounded batch of
   * pending emails so we never run past the Workers CPU-time limit.
   */
  async processEmailQueue(): Promise<{ processed: number; failed: number }> {
    const pendingEmails = await this.db.getPendingEmails();
    let processed = 0;
    let failed = 0;

    for (const email of pendingEmails) {
      try {
        const success = await this.sendEmail(
          email.recipient_email,
          email.subject,
          email.body,
          email.recipient_name
        );

        if (success) {
          await this.db.markEmailSent(email.id);
          processed++;
        } else {
          // BUG FIXED: previous implementation unconditionally set
          // status='failed' on the FIRST failure, preventing retries.
          // `incrementEmailAttempts` now only flips status to 'failed'
          // once attempts >= 5, so transient failures get retried.
          await this.db.incrementEmailAttempts(email.id, 'Send failed');
          failed++;
        }
      } catch (error: any) {
        await this.db.incrementEmailAttempts(email.id, error?.message || 'Unknown error');
        failed++;
      }
    }

    return { processed, failed };
  }

  /**
   * Send a single email. Falls back to a no-op (returning true) when
   * no `EMAIL_API_KEY` is configured, so dev/test environments don't
   * crash on notification flows.
   *
   * In production, plug in your provider of choice (Resend, SendGrid,
   * Mailgun, AWS SES, Cloudflare Email Routing, etc.).
   */
  async sendEmail(to: string, subject: string, body: string, name: string | null): Promise<boolean> {
    if (!this.env.EMAIL_API_KEY) {
      console.log('[email] EMAIL_API_KEY not set; skipping send to:', to);
      return true;
    }

    try {
      // Example integration with Resend. Uncomment and adapt as needed.
      //
      // const response = await fetch('https://api.resend.com/emails', {
      //   method: 'POST',
      //   headers: {
      //     Authorization: `Bearer ${this.env.EMAIL_API_KEY}`,
      //     'Content-Type': 'application/json',
      //   },
      //   body: JSON.stringify({
      //     from: 'noreply@yourdomain.com',
      //     to: name ? `${name} <${to}>` : to,
      //     subject,
      //     html: body,
      //   }),
      // });
      // return response.ok;

      console.log('[email] sent (stub):', to);
      return true;
    } catch (error) {
      console.error('[email] failed to send:', error);
      return false;
    }
  }

  /**
   * Notify all subscribers of a page that a new comment was posted.
   *
   * BUG FIXED: the previous implementation sent a notification to
   * EVERY subscriber of the page, INCLUDING the comment's own author
   * if they happened to be subscribed. That meant leaving a comment
   * on a page you follow would trigger a "new comment" email to
   * yourself. We now skip the comment author by email.
   */
  async notifyNewComment(comment: any, pageUrl: string): Promise<void> {
    const subscriptions = await this.db.getSubscriptionsByPageUrl(pageUrl);

    // Skip the comment author so they don't get a "new comment on a page
    // you follow" email about their own comment.
    const authorEmail = (comment.author_email || '').toLowerCase();

    for (const sub of subscriptions) {
      if (sub.email.toLowerCase() === authorEmail) continue;

      const subject = 'New comment on a page you follow';
      const body = await this.generateNewCommentEmail(comment, sub.email);

      await this.queueEmail({
        comment_id: comment.id,
        recipient_email: sub.email,
        recipient_name: sub.email.split('@')[0],
        email_type: 'subscriber',
        subject,
        body,
      });
    }

    // Notify admin if enabled
    const adminEmail = await this.db.getSetting('admin_email');
    const enableNotifications = await this.db.getSetting('enable_notifications');

    if (adminEmail && enableNotifications === 'true') {
      const subject = 'New comment submitted';
      const body = this.generateAdminNotificationEmail(comment);

      await this.queueEmail({
        comment_id: comment.id,
        recipient_email: adminEmail,
        recipient_name: 'Admin',
        email_type: 'admin',
        subject,
        body,
      });
    }
  }

  /**
   * Notify the parent comment's author that someone replied to them.
   * Skipped when the reply author is the same as the parent comment's
   * author (you don't get an email for replying to yourself).
   */
  async notifyReply(parentComment: any, reply: any): Promise<void> {
    if (!parentComment || !parentComment.author_email) return;

    const parentEmail = parentComment.author_email.toLowerCase();
    const replyEmail = (reply.author_email || '').toLowerCase();
    if (parentEmail === replyEmail) return;

    const subject = 'Someone replied to your comment';
    const body = await this.generateReplyEmail(parentComment, reply);

    await this.queueEmail({
      comment_id: reply.id,
      recipient_email: parentComment.author_email,
      recipient_name: parentComment.author_name,
      email_type: 'parent_reply',
      subject,
      body,
    });
  }

  /**
   * Build the "new comment on a page you follow" email body.
   *
   * BUG FIXED: the previous implementation called
   * `this.generateUnsubscribeToken(...)` to compute the unsubscribe
   * link. That method:
   *
   *   1. Used `crypto.subtle.digestSync`, which does NOT exist in the
   *      Web Crypto API (only `digest` is available, and it's async).
   *      Any code path that reached this method would throw at runtime.
   *
   *   2. Even if `digestSync` had existed, the hash it produced was
   *      based on `email:pageUrl:timestamp` — which does NOT match
   *      any row in the `subscriptions` table (the table stores a
   *      random token generated at subscription time). So every
   *      "unsubscribe" link in every notification email pointed to a
   *      token that didn't exist, and clicking it returned 404.
   *
   * We now look up the actual subscription token from the database
   * and use it in the unsubscribe link. If no subscription exists
   * (e.g. the user was subscribed then later unsubscribed but still
   * received a queued email), we omit the unsubscribe link entirely
   * rather than emit a broken one.
   */
  private async generateNewCommentEmail(comment: any, recipientEmail: string): Promise<string> {
    const token = await this.db.getSubscriptionToken(comment.page_url, recipientEmail);
    const unsubscribeUrl = token
      ? `${this.env.APP_URL}/api/unsubscribe?token=${encodeURIComponent(token)}`
      : null;

    // Escape comment fields to prevent HTML injection in the email body.
    // The comment content is stored raw in the DB (see comments.ts), so
    // we must escape at render time.
    const safeName = escapeForHtml(comment.author_name || '');
    const safeContent = escapeForHtml(comment.content || '');
    const safePageUrl = escapeForHtml(comment.page_url || '');

    const unsubscribeBlock = unsubscribeUrl
      ? `<hr>
        <p style="font-size: 12px; color: #666;">
          <a href="${escapeForHtml(unsubscribeUrl)}">Unsubscribe from notifications for this page</a>
        </p>`
      : '';

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>New Comment</h2>
        <p><strong>Author:</strong> ${safeName}</p>
        <p><strong>Comment:</strong></p>
        <p style="background: #f5f5f5; padding: 15px; border-radius: 5px;">${safeContent}</p>
        <p><a href="${safePageUrl}">View on site</a></p>
        ${unsubscribeBlock}
      </div>
    `;
  }

  private generateAdminNotificationEmail(comment: any): string {
    const safeStatus = escapeForHtml(String(comment.status || ''));
    const safeName = escapeForHtml(comment.author_name || '');
    const safeEmail = escapeForHtml(comment.author_email || '');
    const safePageUrl = escapeForHtml(comment.page_url || '');
    const safeContent = escapeForHtml(comment.content || '');
    const safeAdminUrl = escapeForHtml(`${this.env.APP_URL}/admin`);

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>New Comment Submitted</h2>
        <p><strong>Status:</strong> ${safeStatus}</p>
        <p><strong>Author:</strong> ${safeName} (${safeEmail})</p>
        <p><strong>Page:</strong> ${safePageUrl}</p>
        <p><strong>Comment:</strong></p>
        <p style="background: #f5f5f5; padding: 15px; border-radius: 5px;">${safeContent}</p>
        <p><a href="${safeAdminUrl}">Moderate in admin panel</a></p>
      </div>
    `;
  }

  private async generateReplyEmail(parentComment: any, reply: any): Promise<string> {
    const safeParentContent = escapeForHtml(parentComment.content || '');
    const safeReplyName = escapeForHtml(reply.author_name || '');
    const safeReplyContent = escapeForHtml(reply.content || '');
    const safePageUrl = escapeForHtml(parentComment.page_url || '');

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Reply to Your Comment</h2>
        <p><strong>Your comment:</strong></p>
        <p style="background: #f5f5f5; padding: 15px; border-radius: 5px;">${safeParentContent}</p>
        <p><strong>Reply from ${safeReplyName}:</strong></p>
        <p style="background: #e8f4f8; padding: 15px; border-radius: 5px;">${safeReplyContent}</p>
        <p><a href="${safePageUrl}">View on site</a></p>
      </div>
    `;
  }
}

/**
 * Minimal HTML escaper for email body content. Mirrors the behavior of
 * the `escapeHtml` utility in `lib/utils.ts`, but defined locally so
 * this file has no dependency on the utils module (keeps the email
 * module self-contained for future extraction).
 */
function escapeForHtml(text: string): string {
  if (text == null) return '';
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, (c) => map[c]);
}
