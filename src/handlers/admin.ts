// Admin API handlers for comment moderation and management

import type { Env, CommentStatus } from '../types';
import { Database } from '../lib/db';
import { Auth } from '../lib/auth';
import { errorResponse, jsonResponse, parseAllowedOrigins, setCORSHeaders, getOrigin } from '../lib/utils';
import { extractAuthToken } from '../lib/auth';

export async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();
    const { password } = body;

    if (!password) {
      return errorResponse('Password is required', 400);
    }

    const db = new Database(env.DB);
    const auth = new Auth(env, db);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Check rate limiting
    const rateLimit = await auth.checkRateLimit(ip);
    if (!rateLimit.allowed) {
      return errorResponse('Too many failed login attempts. Please try again later.', 429);
    }

    // Verify password
    const isValid = await auth.verifyAdminPassword(password, env);
    await auth.recordLoginAttempt(ip, isValid);

    if (!isValid) {
      return errorResponse('Invalid password', 401);
    }

    // Create session
    const token = await auth.createSession(ip, request.headers.get('User-Agent'));

    const response = jsonResponse({ 
      message: 'Login successful',
      token 
    });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error during admin login:', error);
    return errorResponse('Login failed', 500);
  }
}

export async function handleAdminLogout(request: Request, env: Env): Promise<Response> {
  try {
    const token = extractAuthToken(request);
    if (!token) {
      return errorResponse('Not authenticated', 401);
    }

    const db = new Database(env.DB);
    const auth = new Auth(env, db);
    await auth.deleteSession(token);

    const response = jsonResponse({ message: 'Logged out successfully' });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error during admin logout:', error);
    return errorResponse('Logout failed', 500);
  }
}

export async function handleAdminVerify(request: Request, env: Env): Promise<Response> {
  try {
    const token = extractAuthToken(request);
    if (!token) {
      return errorResponse('Not authenticated', 401);
    }

    const db = new Database(env.DB);
    const auth = new Auth(env, db);
    const isValid = await auth.validateSession(token);

    if (!isValid) {
      return errorResponse('Invalid or expired session', 401);
    }

    const response = jsonResponse({ authenticated: true });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error verifying admin session:', error);
    return errorResponse('Verification failed', 500);
  }
}

export async function requireAdmin(request: Request, env: Env): Promise<boolean> {
  const token = extractAuthToken(request);
  if (!token) return false;

  const db = new Database(env.DB);
  const auth = new Auth(env, db);
  return await auth.validateSession(token);
}

export async function handleGetAllComments(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const url = new URL(request.url);
    const status = url.searchParams.get('status') as CommentStatus | null;
    const pageUrl = url.searchParams.get('page_url');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    const db = new Database(env.DB);
    const comments = await db.getComments({
      status: status || undefined,
      page_url: pageUrl || undefined,
      limit,
      offset,
      sort_order: 'desc'
    });

    const totalCount = await db.getCommentCount({
      status: status || undefined,
      page_url: pageUrl || undefined
    });

    const response = jsonResponse({ 
      comments, 
      total: totalCount,
      limit,
      offset
    });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching all comments:', error);
    return errorResponse('Failed to fetch comments', 500);
  }
}

export async function handleUpdateComment(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '');

    if (!id || isNaN(id)) {
      return errorResponse('Invalid comment ID', 400);
    }

    const body = await request.json();
    const { status, content } = body;

    if (!status && !content) {
      return errorResponse('Either status or content is required', 400);
    }

    const db = new Database(env.DB);
    const success = await db.updateComment(id, { 
      status: status as CommentStatus,
      content 
    });

    if (!success) {
      return errorResponse('Comment not found or update failed', 404);
    }

    const comment = await db.getCommentById(id);
    const response = jsonResponse({ comment });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error updating comment:', error);
    return errorResponse('Failed to update comment', 500);
  }
}

export async function handleDeleteComment(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '');

    if (!id || isNaN(id)) {
      return errorResponse('Invalid comment ID', 400);
    }

    const db = new Database(env.DB);
    const success = await db.deleteComment(id);

    if (!success) {
      return errorResponse('Comment not found', 404);
    }

    const response = jsonResponse({ message: 'Comment deleted successfully' });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error deleting comment:', error);
    return errorResponse('Failed to delete comment', 500);
  }
}

export async function handleBulkUpdateComments(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const body = await request.json();
    const { ids, action, status } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return errorResponse('Invalid or missing IDs array', 400);
    }

    if (!action || !['approve', 'reject', 'spam', 'delete'].includes(action)) {
      return errorResponse('Invalid action', 400);
    }

    const db = new Database(env.DB);
    const statusMap: Record<string, CommentStatus> = {
      approve: 'approved',
      reject: 'spam',
      spam: 'spam'
    };

    let updated = 0;
    for (const id of ids) {
      if (action === 'delete') {
        const success = await db.deleteComment(id);
        if (success) updated++;
      } else {
        const success = await db.updateComment(id, { status: statusMap[action] });
        if (success) updated++;
      }
    }

    const response = jsonResponse({ 
      message: `Successfully ${action}ed ${updated} comments`,
      updated 
    });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error bulk updating comments:', error);
    return errorResponse('Failed to bulk update comments', 500);
  }
}

export async function handleGetAnalytics(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const db = new Database(env.DB);
    const analytics = await db.getAnalytics();

    const response = jsonResponse(analytics);
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching analytics:', error);
    return errorResponse('Failed to fetch analytics', 500);
  }
}

export async function handleGetSettings(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const db = new Database(env.DB);
    const settings = await db.getAllSettings();

    // Remove sensitive data
    const { admin_password_hash, ...safeSettings } = settings;

    const response = jsonResponse(safeSettings);
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching settings:', error);
    return errorResponse('Failed to fetch settings', 500);
  }
}

export async function handleUpdateSettings(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const body = await request.json();
    const db = new Database(env.DB);

    for (const [key, value] of Object.entries(body)) {
      if (key === 'admin_password_hash') {
        // Don't allow updating password hash directly
        continue;
      }
      await db.setSetting(key, String(value));
    }

    const response = jsonResponse({ message: 'Settings updated successfully' });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error updating settings:', error);
    return errorResponse('Failed to update settings', 500);
  }
}

export async function handleExportComments(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const db = new Database(env.DB);
    const comments = await db.getComments({ limit: 10000 });
    const subscriptions = await db.getAllSettings();

    const exportData = {
      comments,
      settings: subscriptions,
      exported_at: new Date().toISOString(),
      version: '2.0.0'
    };

    const response = jsonResponse(exportData);
    response.headers.set('Content-Disposition', 'attachment; filename=comments-export.json');
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error exporting comments:', error);
    return errorResponse('Failed to export comments', 500);
  }
}

export async function handleImportComments(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await requireAdmin(request, env))) {
      return errorResponse('Unauthorized', 401);
    }

    const body = await request.json();
    const { comments } = body;

    if (!comments || !Array.isArray(comments)) {
      return errorResponse('Invalid import data', 400);
    }

    const db = new Database(env.DB);
    let imported = 0;
    let failed = 0;

    for (const comment of comments) {
      try {
        await db.createComment({
          page_url: comment.page_url,
          parent_id: comment.parent_id || null,
          author_name: comment.author_name,
          author_email: comment.author_email,
          author_url: comment.author_url || null,
          content: comment.content,
          ip_address: comment.ip_address || 'imported',
          user_agent: comment.user_agent || 'imported'
        });
        imported++;
      } catch (error) {
        failed++;
      }
    }

    const response = jsonResponse({ 
      message: `Import complete: ${imported} imported, ${failed} failed`,
      imported,
      failed
    });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error importing comments:', error);
    return errorResponse('Failed to import comments', 500);
  }
}
