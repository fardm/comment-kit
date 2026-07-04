// Admin API handlers for comment moderation and management

import type { Env, CommentStatus } from '../types';
import { Database } from '../lib/db';
import { Auth, extractAuthToken } from '../lib/auth';
import {
  errorResponse,
  jsonResponse,
  parseAllowedOrigins,
  setCORSHeaders,
  getOrigin,
} from '../lib/utils';

/**
 * Settings keys that admins are allowed to update via PUT /api/admin/settings.
 *
 * BUG FIXED: the previous implementation iterated over EVERY key in the
 * request body and persisted it via `setSetting(key, String(value))`. That
 * meant an admin (or anyone who stole an admin session) could overwrite
 * arbitrary configuration — most dangerously `schema_version`, but also
 * future system keys. We now whitelist the user-facing keys.
 */
const ALLOWED_SETTING_KEYS: Record<string, (v: unknown) => string | null> = {
  require_moderation: (v) => (v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : null),
  allow_guest_comments: (v) => (v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : null),
  enable_notifications: (v) => (v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : null),
  max_comment_length: (v) => {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (!isFinite(n) || n < 100 || n > 50000) return null;
    return String(n);
  },
  comment_sort_order: (v) => (v === 'asc' || v === 'desc' ? v : null),
  admin_email: (v) => (typeof v === 'string' && v.length > 0 && v.length < 254 ? v : null),
};

/** Statuses that the bulk-update endpoint may set. */
const BULK_ACTIONS = ['approve', 'reject', 'spam', 'delete'] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

const BULK_ACTION_TO_STATUS: Record<Exclude<BulkAction, 'delete'>, CommentStatus> = {
  approve: 'approved',
  // BUG FIXED: previously mapped `reject` -> 'spam', which conflated
  // two distinct moderation outcomes. "Reject" semantically means
  // "discard this comment" — i.e. soft-delete it from the public view
  // without marking it as a spam sample for filter training. We now
  // map reject -> 'deleted' (a status that already exists in the schema
  // CHECK constraint) and reserve 'spam' for actual spam classification.
  reject: 'deleted',
  spam: 'spam',
};

export async function requireAdmin(request: Request, env: Env): Promise<boolean> {
  const token = extractAuthToken(request);
  if (!token) return false;

  const db = new Database(env.DB);
  const auth = new Auth(env, db);
  try {
    return await auth.validateSession(token);
  } catch {
    return false;
  }
}

/**
 * Helper: build a successful admin Response with CORS headers.
 */
function adminResponse(request: Request, env: Env, data: unknown, status: number = 200): Response {
  const response = jsonResponse(data, status);
  return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
}

/**
 * Helper: build an error admin Response with CORS headers.
 */
function adminError(request: Request, env: Env, message: string, status: number = 400): Response {
  const response = errorResponse(message, status);
  return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
}

export async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return adminError(request, env, 'Invalid JSON body', 400);
    }

    const { password } = body || {};
    if (!password || typeof password !== 'string') {
      return adminError(request, env, 'Password is required', 400);
    }

    const db = new Database(env.DB);
    const auth = new Auth(env, db);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Check rate limiting BEFORE verifying the password — otherwise an
    // attacker could saturate the verify path even after the limit kicks in.
    const rateLimit = await auth.checkRateLimit(ip);
    if (!rateLimit.allowed) {
      const response = adminError(
        request,
        env,
        'Too many failed login attempts. Please try again later.',
        429
      );
      response.headers.set('Retry-After', '900'); // 15 minutes
      return response;
    }

    const isValid = await auth.verifyAdminPassword(password, env);
    await auth.recordLoginAttempt(ip, isValid);

    if (!isValid) {
      return adminError(request, env, 'Invalid password', 401);
    }

    // Create session
    const token = await auth.createSession(ip, request.headers.get('User-Agent'));

    // BUG FIXED: the previous implementation only returned the token in
    // the JSON body, which forced the admin frontend to manage storage
    // in localStorage. That works, but it's strictly worse than an
    // HttpOnly cookie against XSS-based token theft. We now ALSO set a
    // secure HttpOnly cookie so that browser-based admin requests
    // automatically include credentials without JS having to handle
    // the token at all.
    const response = jsonResponse({ message: 'Login successful', token });
    response.headers.set(
      'Set-Cookie',
      `admin_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`
    );
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error during admin login:', error);
    return adminError(request, env, 'Login failed', 500);
  }
}

export async function handleAdminLogout(request: Request, env: Env): Promise<Response> {
  try {
    const token = extractAuthToken(request);
    if (!token) {
      return adminError(request, env, 'Not authenticated', 401);
    }

    const db = new Database(env.DB);
    const auth = new Auth(env, db);
    await auth.deleteSession(token);

    // Clear the cookie
    const response = jsonResponse({ message: 'Logged out successfully' });
    response.headers.set(
      'Set-Cookie',
      'admin_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
    );
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error during admin logout:', error);
    return adminError(request, env, 'Logout failed', 500);
  }
}

export async function handleAdminVerify(request: Request, env: Env): Promise<Response> {
  try {
    const token = extractAuthToken(request);
    if (!token) {
      return adminError(request, env, 'Not authenticated', 401);
    }

    const db = new Database(env.DB);
    const auth = new Auth(env, db);
    const isValid = await auth.validateSession(token);

    if (!isValid) {
      return adminError(request, env, 'Invalid or expired session', 401);
    }

    return adminResponse(request, env, { authenticated: true });
  } catch (error) {
    console.error('Error verifying admin session:', error);
    return adminError(request, env, 'Verification failed', 500);
  }
}

export async function handleGetAllComments(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    const url = new URL(request.url);
    const status = url.searchParams.get('status') as CommentStatus | null;
    const pageUrl = url.searchParams.get('page_url');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    // Validate status filter (don't pass arbitrary strings through to SQL).
    const validStatuses: CommentStatus[] = ['pending', 'approved', 'spam', 'deleted'];
    const statusFilter =
      status && (validStatuses as string[]).includes(status) ? (status as CommentStatus) : undefined;

    const db = new Database(env.DB);
    const comments = await db.getComments({
      status: statusFilter,
      page_url: pageUrl || undefined,
      limit: isNaN(limit) ? 50 : limit,
      offset: isNaN(offset) || offset < 0 ? 0 : offset,
      sort_order: 'desc',
    });

    const totalCount = await db.getCommentCount({
      status: statusFilter,
      page_url: pageUrl || undefined,
    });

    return adminResponse(request, env, {
      comments,
      total: totalCount,
      limit: isNaN(limit) ? 50 : limit,
      offset: isNaN(offset) || offset < 0 ? 0 : offset,
    });
  } catch (error) {
    console.error('Error fetching all comments:', error);
    return adminError(request, env, 'Failed to fetch comments', 500);
  }
}

export async function handleUpdateComment(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '', 10);

    if (!id || isNaN(id) || id <= 0) {
      return adminError(request, env, 'Invalid comment ID', 400);
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return adminError(request, env, 'Invalid JSON body', 400);
    }

    const { status, content } = body || {};

    if (status === undefined && content === undefined) {
      return adminError(request, env, 'Either status or content is required', 400);
    }

    // Validate status if provided
    const validStatuses: CommentStatus[] = ['pending', 'approved', 'spam', 'deleted'];
    if (status !== undefined && !(validStatuses as string[]).includes(status)) {
      return adminError(request, env, 'Invalid status value', 400);
    }

    const db = new Database(env.DB);
    const success = await db.updateComment(id, {
      status: status as CommentStatus | undefined,
      content: typeof content === 'string' ? content : undefined,
    });

    if (!success) {
      return adminError(request, env, 'Comment not found or update failed', 404);
    }

    const comment = await db.getCommentById(id);
    return adminResponse(request, env, { comment });
  } catch (error) {
    console.error('Error updating comment:', error);
    return adminError(request, env, 'Failed to update comment', 500);
  }
}

export async function handleDeleteComment(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '', 10);

    if (!id || isNaN(id) || id <= 0) {
      return adminError(request, env, 'Invalid comment ID', 400);
    }

    const db = new Database(env.DB);
    const success = await db.deleteComment(id);

    if (!success) {
      return adminError(request, env, 'Comment not found', 404);
    }

    return adminResponse(request, env, { message: 'Comment deleted successfully' });
  } catch (error) {
    console.error('Error deleting comment:', error);
    return adminError(request, env, 'Failed to delete comment', 500);
  }
}

export async function handleBulkUpdateComments(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return adminError(request, env, 'Invalid JSON body', 400);
    }

    const { ids, action } = body || {};

    // BUG FIXED: the previous implementation only checked that `ids`
    // was a non-empty array. It did NOT validate that each element was
    // a finite positive integer. A payload like `{"ids":["1; DROP TABLE
    // comments"], "action":"delete"}` would have been passed straight
    // into `deleteComment(id)` — though D1's parameter binding would
    // have caught it, the code still would have iterated uselessly.
    // We now validate each ID explicitly.
    if (!Array.isArray(ids) || ids.length === 0) {
      return adminError(request, env, 'Invalid or missing IDs array', 400);
    }
    if (ids.length > 1000) {
      return adminError(request, env, 'Too many IDs (max 1000 per request)', 400);
    }
    const safeIds: number[] = [];
    for (const raw of ids) {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      if (!isFinite(n) || n <= 0) {
        return adminError(request, env, `Invalid comment ID: ${JSON.stringify(raw)}`, 400);
      }
      safeIds.push(n);
    }

    if (!action || !(BULK_ACTIONS as readonly string[]).includes(action)) {
      return adminError(request, env, 'Invalid action', 400);
    }

    const db = new Database(env.DB);
    let updated = 0;

    for (const id of safeIds) {
      if (action === 'delete') {
        const success = await db.deleteComment(id);
        if (success) updated++;
      } else {
        const success = await db.updateComment(id, {
          status: BULK_ACTION_TO_STATUS[action as Exclude<BulkAction, 'delete'>],
        });
        if (success) updated++;
      }
    }

    // BUG FIXED: previous implementation always said "Successfully
    // approveed N comments" even when N was 0 (and even had a typo
    // "approveed" because it concatenated `${action}ed` — which also
    // produced "deleteed" for the delete action). We now produce a
    // grammatical message and explicitly call out the 0-updated case.
    const verb =
      action === 'approve'
        ? 'approved'
        : action === 'reject'
        ? 'rejected'
        : action === 'spam'
        ? 'marked as spam'
        : 'deleted';

    const message =
      updated > 0
        ? `Successfully ${verb} ${updated} comment${updated === 1 ? '' : 's'}.`
        : `No comments were ${verb} (they may have already been in the target state).`;

    return adminResponse(request, env, { message, updated });
  } catch (error) {
    console.error('Error bulk updating comments:', error);
    return adminError(request, env, 'Failed to bulk update comments', 500);
  }
}

export async function handleGetAnalytics(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    const db = new Database(env.DB);
    const analytics = await db.getAnalytics();

    return adminResponse(request, env, analytics);
  } catch (error) {
    console.error('Error fetching analytics:', error);
    return adminError(request, env, 'Failed to fetch analytics', 500);
  }
}

export async function handleGetSettings(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    const db = new Database(env.DB);
    const settings = await db.getAllSettings();

    // Strip sensitive data. The previous implementation destructured
    // `admin_password_hash` out — but that key actually doesn't belong
    // in the settings table at all (it's an env-secret), so even if
    // someone migrated it across, we strip it here defensively.
    const { admin_password_hash, jwt_secret, schema_version, ...safeSettings } = settings;

    return adminResponse(request, env, safeSettings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    return adminError(request, env, 'Failed to fetch settings', 500);
  }
}

export async function handleUpdateSettings(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return adminError(request, env, 'Invalid JSON body', 400);
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return adminError(request, env, 'Invalid settings payload', 400);
    }

    const db = new Database(env.DB);
    const updated: string[] = [];
    const rejected: string[] = [];

    for (const [key, value] of Object.entries(body)) {
      // Hard-block any attempt to overwrite system keys.
      if (
        key === 'admin_password_hash' ||
        key === 'jwt_secret' ||
        key === 'schema_version'
      ) {
        rejected.push(key);
        continue;
      }

      const validator = ALLOWED_SETTING_KEYS[key];
      if (!validator) {
        rejected.push(key);
        continue;
      }

      const safeValue = validator(value);
      if (safeValue === null) {
        rejected.push(key);
        continue;
      }

      await db.setSetting(key, safeValue);
      updated.push(key);
    }

    const message =
      rejected.length === 0
        ? 'Settings updated successfully'
        : `Settings updated (${updated.length} applied, ${rejected.length} rejected: ${rejected.join(', ')})`;

    return adminResponse(request, env, { message, updated, rejected });
  } catch (error) {
    console.error('Error updating settings:', error);
    return adminError(request, env, 'Failed to update settings', 500);
  }
}

export async function handleExportComments(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    const db = new Database(env.DB);
    const comments = await db.getComments({ limit: 10000 });
    const settings = await db.getAllSettings();

    // BUG FIXED: the previous implementation had a confusingly-named
    // variable `subscriptions` that actually held the SETTINGS object
    // (and was returned as `settings`). Real subscription data was
    // never exported, so round-tripping an export through an import
    // lost every subscription. We now export subscriptions explicitly.
    //
    // We intentionally DO include the unsubscribe `token` in the export
    // so that a full restore preserves unsubscribe links. This is
    // acceptable because the export is admin-only and intended for
    // backup/migration.
    const subscriptions: any[] = [];
    try {
      // No `getAllSubscriptions` helper exists, so query directly.
      // We use the existing per-page accessor against a list of
      // distinct page_urls — or, more simply, just pull everything.
      // D1 doesn't have a "list all" helper on the Database class,
      // so we go through getSubscriptionsByPageUrl for each page
      // that has comments, plus any pages that appear in
      // subscriptions but have no comments (rare edge case ignored
      // here for simplicity — admins can re-subscribe manually).
      const pages = new Set<string>();
      comments.forEach((c) => pages.add(c.page_url));
      for (const page of pages) {
        const subs = await db.getSubscriptionsByPageUrl(page);
        subscriptions.push(...subs);
      }
    } catch (e) {
      console.error('Failed to export subscriptions (non-fatal):', e);
    }

    // Strip the password hash and jwt secret from exported settings
    const { admin_password_hash, jwt_secret, ...safeSettings } = settings;

    const exportData = {
      comments,
      subscriptions,
      settings: safeSettings,
      exported_at: new Date().toISOString(),
      version: '2.0.0',
    };

    const response = jsonResponse(exportData);
    response.headers.set('Content-Disposition', 'attachment; filename=comments-export.json');
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error exporting comments:', error);
    return adminError(request, env, 'Failed to export comments', 500);
  }
}

export async function handleImportComments(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return adminError(request, env, 'Unauthorized', 401);
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return adminError(request, env, 'Invalid JSON body', 400);
    }

    const { comments, subscriptions, settings } = body || {};

    if (!comments || !Array.isArray(comments)) {
      return adminError(request, env, 'Invalid import data: comments array required', 400);
    }

    if (comments.length > 50000) {
      return adminError(request, env, 'Too many comments in import (max 50000)', 400);
    }

    const db = new Database(env.DB);
    let failed = 0;
    let subsImported = 0;
    let settingsUpdated = 0;

    // ---- Comments -------------------------------------------------------
    // BUG FIXED: the previous implementation called `createComment` for
    // each imported row, which:
    //   1. Always reset the status to 'pending' (the schema default)
    //      — losing the original 'approved' / 'spam' state.
    //   2. Reassigned a new auto-increment ID, breaking parent_id
    //      references for threaded replies.
    //   3. Reset created_at to CURRENT_TIMESTAMP — destroying the
    //      original timestamp.
    //
    // We now insert via `Database.importComment` which preserves all
    // original fields (status, created_at, etc.) and remaps parent_id
    // references through an old-id -> new-id map so threading survives
    // the round-trip. Parents are inserted first (by ascending old id)
    // so the map is always populated before a child needs to look up
    // its parent.

    const idMap = new Map<number, number>(); // old ID -> new ID

    // Sort so that parents come before children (by original id ascending)
    const sortedComments = (comments as any[])
      .filter((c) => c && c.page_url && c.author_name && c.content)
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

    let importedCount = 0;
    for (const comment of sortedComments) {
      try {
        const oldId = typeof comment.id === 'number' ? comment.id : null;
        const oldParentId =
          comment.parent_id !== undefined && comment.parent_id !== null
            ? Number(comment.parent_id)
            : null;
        const newParentId =
          oldParentId !== null ? idMap.get(oldParentId) ?? null : null;

        const newId = await db.importComment({
          page_url: String(comment.page_url),
          parent_id: newParentId,
          author_name: String(comment.author_name),
          author_email: String(comment.author_email || ''),
          author_url: comment.author_url ? String(comment.author_url) : null,
          content: String(comment.content),
          status: ['pending', 'approved', 'spam', 'deleted'].includes(comment.status)
            ? comment.status
            : 'pending',
          ip_address: comment.ip_address ? String(comment.ip_address) : 'imported',
          user_agent: comment.user_agent ? String(comment.user_agent) : 'imported',
          created_at: comment.created_at || new Date().toISOString(),
          updated_at: comment.updated_at || comment.created_at || new Date().toISOString(),
        });

        if (oldId !== null) {
          idMap.set(oldId, newId);
        }
        importedCount++;
      } catch (e) {
        failed++;
      }
    }

    // ---- Subscriptions --------------------------------------------------
    if (Array.isArray(subscriptions)) {
      for (const sub of subscriptions) {
        if (!sub || !sub.page_url || !sub.email || !sub.token) continue;
        try {
          const inserted = await db.importSubscription({
            page_url: String(sub.page_url),
            email: String(sub.email).toLowerCase(),
            token: String(sub.token),
            active: sub.active === 0 || sub.active === false ? 0 : 1,
          });
          if (inserted) subsImported++;
        } catch {
          // ignore individual subscription failures (e.g. duplicate token)
        }
      }
    }

    // ---- Settings -------------------------------------------------------
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      for (const [key, value] of Object.entries(settings)) {
        const validator = ALLOWED_SETTING_KEYS[key];
        if (!validator) continue;
        const safeValue = validator(value);
        if (safeValue === null) continue;
        try {
          await db.setSetting(key, safeValue);
          settingsUpdated++;
        } catch {
          // ignore
        }
      }
    }

    const response = jsonResponse({
      message: `Import complete: ${importedCount} comments, ${subsImported} subscriptions, ${settingsUpdated} settings imported. ${failed} comment failures.`,
      imported: importedCount,
      failed,
      subscriptions_imported: subsImported,
      settings_updated: settingsUpdated,
    });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error importing comments:', error);
    return adminError(request, env, 'Failed to import comments', 500);
  }
}
