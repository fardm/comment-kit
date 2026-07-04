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
          await this.db.incrementEmailAttempts(email.id, 'Send failed');
          failed++;
        }
      } catch (error: any) {
        await this.db.incrementEmailAttempts(email.id, error.message);
        failed++;
      }
    }

    return { processed, failed };
  }

  async sendEmail(to: string, subject: string, body: string, name: string | null): Promise<boolean> {
    // This is a placeholder for actual email sending
    // In production, integrate with:
    // - Cloudflare Email Routing
    // - SendGrid
    // - Mailgun
    // - AWS SES
    // - Resend
    
    if (!this.env.EMAIL_API_KEY) {
      console.log('Email not configured, would send to:', to);
      return true;
    }

    // Example integration with Resend (or similar service)
    try {
      // const response = await fetch('https://api.resend.com/emails', {
      //   method: 'POST',
      //   headers: {
      //     'Authorization': `Bearer ${this.env.EMAIL_API_KEY}`,
      //     'Content-Type': 'application/json'
      //   },
      //   body: JSON.stringify({
      //     from: 'noreply@yourdomain.com',
      //     to: name ? `${name} <${to}>` : to,
      //     subject,
      //     html: body
      //   })
      // });
      // return response.ok;
      
      console.log('Email sent to:', to);
      return true;
    } catch (error) {
      console.error('Failed to send email:', error);
      return false;
    }
  }

  async notifyNewComment(comment: any, pageUrl: string): Promise<void> {
    // Notify subscribers of the page
    const subscriptions = await this.db.getSubscriptionsByPageUrl(pageUrl);
    
    for (const sub of subscriptions) {
      const subject = 'New comment on page you follow';
      const body = this.generateNewCommentEmail(comment, sub.email);
      
      await this.queueEmail({
        comment_id: comment.id,
        recipient_email: sub.email,
        recipient_name: sub.email.split('@')[0],
        email_type: 'subscriber',
        subject,
        body
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
        body
      });
    }
  }

  async notifyReply(parentComment: any, reply: any): Promise<void> {
    if (!parentComment.author_email) return;

    const subject = 'Someone replied to your comment';
    const body = this.generateReplyEmail(parentComment, reply);
    
    await this.queueEmail({
      comment_id: reply.id,
      recipient_email: parentComment.author_email,
      recipient_name: parentComment.author_name,
      email_type: 'parent_reply',
      subject,
      body
    });
  }

  private generateNewCommentEmail(comment: any, recipientEmail: string): string {
    const unsubscribeUrl = `${this.env.APP_URL}/api/unsubscribe?token=${this.generateUnsubscribeToken(recipientEmail, comment.page_url)}`;
    
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>New Comment</h2>
        <p><strong>Author:</strong> ${comment.author_name}</p>
        <p><strong>Comment:</strong></p>
        <p style="background: #f5f5f5; padding: 15px; border-radius: 5px;">${comment.content}</p>
        <p><a href="${comment.page_url}">View on site</a></p>
        <hr>
        <p style="font-size: 12px; color: #666;">
          <a href="${unsubscribeUrl}">Unsubscribe from notifications for this page</a>
        </p>
      </div>
    `;
  }

  private generateAdminNotificationEmail(comment: any): string {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>New Comment Submitted</h2>
        <p><strong>Status:</strong> ${comment.status}</p>
        <p><strong>Author:</strong> ${comment.author_name} (${comment.author_email})</p>
        <p><strong>Page:</strong> ${comment.page_url}</p>
        <p><strong>Comment:</strong></p>
        <p style="background: #f5f5f5; padding: 15px; border-radius: 5px;">${comment.content}</p>
        <p><a href="${this.env.APP_URL}/admin">Moderate in admin panel</a></p>
      </div>
    `;
  }

  private generateReplyEmail(parentComment: any, reply: any): string {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Reply to Your Comment</h2>
        <p><strong>Your comment:</strong></p>
        <p style="background: #f5f5f5; padding: 15px; border-radius: 5px;">${parentComment.content}</p>
        <p><strong>Reply from ${reply.author_name}:</strong></p>
        <p style="background: #e8f4f8; padding: 15px; border-radius: 5px;">${reply.content}</p>
        <p><a href="${parentComment.page_url}">View on site</a></p>
      </div>
    `;
  }

  private generateUnsubscribeToken(email: string, pageUrl: string): string {
    // In production, use a proper JWT or secure token
    const data = `${email}:${pageUrl}:${Date.now()}`;
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    const hash = Array.from(new Uint8Array(crypto.subtle.digestSync('SHA-256', dataBytes)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return hash.substring(0, 32);
  }
}
