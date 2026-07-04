// Main Cloudflare Worker entry point

import type { Env } from './types';
import * as commentHandlers from './handlers/comments';
import * as reactionHandlers from './handlers/reactions';
import * as subscriptionHandlers from './handlers/subscriptions';
import * as adminHandlers from './handlers/admin';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return commentHandlers.handleOptions(request, env);
    }

    // Public API routes
    if (path === '/api/comments' && request.method === 'GET') {
      return commentHandlers.handleGetComments(request, env);
    }

    if (path === '/api/comments' && request.method === 'POST') {
      return commentHandlers.handleCreateComment(request, env);
    }

    if (path === '/api/comment' && request.method === 'GET') {
      return commentHandlers.handleGetComment(request, env);
    }

    // Reaction routes
    if (path === '/api/vote' && request.method === 'POST') {
      return reactionHandlers.handleCreateVote(request, env);
    }

    if (path === '/api/vote' && request.method === 'GET') {
      return reactionHandlers.handleGetCommentReactions(request, env);
    }

    if (path === '/api/post-reaction' && request.method === 'POST') {
      return reactionHandlers.handleCreatePostReaction(request, env);
    }

    if (path === '/api/post-reaction' && request.method === 'GET') {
      return reactionHandlers.handleGetPostReactions(request, env);
    }

    // Subscription routes
    if (path === '/api/subscribe' && request.method === 'POST') {
      return subscriptionHandlers.handleCreateSubscription(request, env);
    }

    if (path === '/api/unsubscribe' && request.method === 'GET') {
      return subscriptionHandlers.handleUnsubscribe(request, env);
    }

    if (path === '/api/subscriptions' && request.method === 'GET') {
      return subscriptionHandlers.handleGetSubscriptions(request, env);
    }

    // Admin API routes
    if (path.startsWith('/api/admin/')) {
      if (path === '/api/admin/login' && request.method === 'POST') {
        return adminHandlers.handleAdminLogin(request, env);
      }

      if (path === '/api/admin/logout' && request.method === 'POST') {
        return adminHandlers.handleAdminLogout(request, env);
      }

      if (path === '/api/admin/verify' && request.method === 'GET') {
        return adminHandlers.handleAdminVerify(request, env);
      }

      if (path === '/api/admin/comments' && request.method === 'GET') {
        return adminHandlers.handleGetAllComments(request, env);
      }

      if (path === '/api/admin/comment' && request.method === 'PUT') {
        return adminHandlers.handleUpdateComment(request, env);
      }

      if (path === '/api/admin/comment' && request.method === 'DELETE') {
        return adminHandlers.handleDeleteComment(request, env);
      }

      if (path === '/api/admin/comments/bulk' && request.method === 'POST') {
        return adminHandlers.handleBulkUpdateComments(request, env);
      }

      if (path === '/api/admin/analytics' && request.method === 'GET') {
        return adminHandlers.handleGetAnalytics(request, env);
      }

      if (path === '/api/admin/settings' && request.method === 'GET') {
        return adminHandlers.handleGetSettings(request, env);
      }

      if (path === '/api/admin/settings' && request.method === 'PUT') {
        return adminHandlers.handleUpdateSettings(request, env);
      }

      if (path === '/api/admin/export' && request.method === 'GET') {
        return adminHandlers.handleExportComments(request, env);
      }

      if (path === '/api/admin/import' && request.method === 'POST') {
        return adminHandlers.handleImportComments(request, env);
      }
    }

    // Serve static files for admin panel
    if (path === '/admin' || path === '/admin/') {
      const adminHtml = await env.DB.prepare('SELECT * FROM settings WHERE key = ?').bind('admin_html').first();
      if (adminHtml) {
        return new Response(adminHtml.value as string, {
          headers: { 'Content-Type': 'text/html' },
        });
      }
      // Return default admin panel
      return new Response('Admin panel not configured', { status: 404 });
    }

    // 404 for unknown routes
    return new Response('Not Found', { status: 404 });
  },
};
