// Core type definitions for the comments system

export type CommentStatus = 'pending' | 'approved' | 'spam' | 'deleted';
export type ReactionType = 'heart' | 'thumbs_up' | 'thumbs_down' | 'laugh' | 'cry' | 'fire' | 'clap';
export type EmailType = 'parent_reply' | 'subscriber' | 'admin';
export type EmailStatus = 'pending' | 'sent' | 'failed';
export type CommentSortOrder = 'asc' | 'desc';

export interface Comment {
  id: number;
  page_url: string;
  parent_id: number | null;
  author_name: string;
  author_email: string;
  author_url: string | null;
  content: string;
  created_at: string;
  updated_at: string;
  status: CommentStatus;
  ip_address: string | null;
  user_agent: string | null;
  replies?: Comment[];
  reactions?: ReactionCounts;
}

export interface ReactionCounts {
  heart: number;
  thumbs_up: number;
  thumbs_down: number;
  laugh: number;
  cry: number;
  fire: number;
  clap: number;
}

export interface Vote {
  id: number;
  comment_id: number;
  ip_address: string;
  reaction_type: ReactionType;
  created_at: string;
}

export interface PostReaction {
  id: number;
  page_url: string;
  ip_address: string;
  reaction_type: ReactionType;
  created_at: string;
}

export interface Subscription {
  id: number;
  page_url: string;
  email: string;
  token: string;
  subscribed_at: string;
  active: number;
}

export interface EmailQueue {
  id: number;
  comment_id: number | null;
  recipient_email: string;
  recipient_name: string | null;
  email_type: EmailType;
  subject: string;
  body: string;
  created_at: string;
  sent_at: string | null;
  status: EmailStatus;
  attempts: number;
  last_error: string | null;
}

export interface Session {
  id: number;
  token: string;
  created_at: string;
  expires_at: string;
  last_activity: string;
  ip_address: string | null;
  user_agent: string | null;
}

export interface LoginAttempt {
  id: number;
  ip_address: string;
  attempted_at: string;
  success: number;
}

export interface Setting {
  key: string;
  value: string;
}

export interface CreateCommentInput {
  page_url: string;
  parent_id?: number | null;
  author_name: string;
  author_email: string;
  author_url?: string | null;
  content: string;
}

export interface UpdateCommentInput {
  status?: CommentStatus;
  content?: string;
}

export interface CommentFilter {
  page_url?: string;
  status?: CommentStatus;
  author_email?: string;
  limit?: number;
  offset?: number;
}

export interface AnalyticsData {
  total_comments: number;
  approved_comments: number;
  pending_comments: number;
  spam_comments: number;
  total_reactions: number;
  total_subscribers: number;
  comments_by_page: Array<{ page_url: string; count: number }>;
  comments_by_date: Array<{ date: string; count: number }>;
  reactions_by_type: Record<ReactionType, number>;
}

export interface ImportExportData {
  comments: Comment[];
  subscriptions: Subscription[];
  settings: Setting[];
  exported_at: string;
  version: string;
}

export interface Env {
  DB: D1Database;
  APP_URL: string;
  ALLOWED_ORIGINS: string;
  APP_LANGUAGE: string;
  SESSION_LIFETIME: string;
  ADMIN_PASSWORD_HASH?: string;
  // NOTE: JWT_SECRET has been intentionally removed. The previous code
  // read it but never used it for any actual JWT operation — the Auth
  // class generates opaque random session tokens instead. Keeping the
  // field in the type would imply it's required when it isn't.
  EMAIL_API_KEY?: string;
}

export interface RequestContext {
  ip: string;
  userAgent: string;
  origin: string | null;
  isAdmin: boolean;
}
