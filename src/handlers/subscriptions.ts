// Handlers for email subscriptions

import type { Env } from '../types';
import { Database } from '../lib/db';
import { Auth, extractAuthToken } from '../lib/auth';
import {
  generateToken,
  isValidEmail,
  errorResponse,
  jsonResponse,
  parseAllowedOrigins,
  setCORSHeaders,
  getOrigin,
  corsErrorResponse,
} from '../lib/utils';

export async function handleCreateSubscription(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return corsErrorResponse('Invalid JSON body', 400, allowedOrigins, origin);
    }

    const { page_url, email } = body || {};

    if (!page_url || typeof page_url !== 'string') {
      return corsErrorResponse('page_url is required', 400, allowedOrigins, origin);
    }
    if (!email || typeof email !== 'string') {
      return corsErrorResponse('email is required', 400, allowedOrigins, origin);
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return corsErrorResponse('Invalid email address', 400, allowedOrigins, origin);
    }

    const db = new Database(env.DB);

    const existingToken = await db.getSubscriptionToken(page_url, normalizedEmail);
    if (existingToken) {
      const response = jsonResponse({ message: 'Already subscribed' }, 200);
      return setCORSHeaders(response, allowedOrigins, origin);
    }

    const token = generateToken(32);
    await db.createSubscription({
      page_url,
      email: normalizedEmail,
      token,
    });

    const response = jsonResponse(
      {
        message: 'Subscription created successfully',
        token,
      },
      201
    );
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error creating subscription:', error);
    return corsErrorResponse('Failed to create subscription', 500, allowedOrigins, origin);
  }
}

export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token || typeof token !== 'string') {
      return corsErrorResponse('Token is required', 400, allowedOrigins, origin);
    }

    const db = new Database(env.DB);
    const success = await db.unsubscribe(token);

    if (!success) {
      const response = jsonResponse({
        message: 'You are not subscribed (or have already unsubscribed).',
      });
      return setCORSHeaders(response, allowedOrigins, origin);
    }

    const response = jsonResponse({ message: 'Unsubscribed successfully' });
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error unsubscribing:', error);
    return corsErrorResponse('Failed to unsubscribe', 500, allowedOrigins, origin);
  }
}

/**
 * Look up subscriptions by email or page_url.
 *
 * BUG FIXED: the previous implementation was a PUBLIC endpoint that
 * allowed anyone to query:
 *
 *     GET /api/subscriptions?email=victim@example.com
 *
 * and receive back a list of (page_url, email, **token**) tuples for
 * every subscription on that email. That was a major privacy leak
 * (revealing which pages a user reads) AND a security leak (the
 * returned `token` is the unsubscribe token, so an attacker could
 * unsubscribe anyone whose email they knew).
 *
 * The endpoint is now admin-only. Public users manage their
 * subscription exclusively via the token-based unsubscribe link
 * sent to them in notification emails.
 */
export async function handleGetSubscriptions(request: Request, env: Env): Promise<Response> {
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const origin = getOrigin(request);
  try {
    // Require admin auth
    const token = extractAuthToken(request);
    if (!token) {
      return corsErrorResponse('Unauthorized', 401, allowedOrigins, origin);
    }
    const db = new Database(env.DB);
    const auth = new Auth(env, db);
    const ok = await auth.validateSession(token);
    if (!ok) {
      return corsErrorResponse('Unauthorized', 401, allowedOrigins, origin);
    }

    const url = new URL(request.url);
    const email = url.searchParams.get('email');
    const pageUrl = url.searchParams.get('page_url');

    let subscriptions;

    if (email) {
      subscriptions = await db.getSubscriptionsByEmail(email);
    } else if (pageUrl) {
      subscriptions = await db.getSubscriptionsByPageUrl(pageUrl);
    } else {
      return corsErrorResponse(
        'Either email or page_url parameter is required',
        400,
        allowedOrigins,
        origin
      );
    }

    // Strip the raw unsubscribe token from list responses.
    const safeSubs = subscriptions.map((s) => {
      const clone: any = { ...s };
      delete clone.token;
      return clone;
    });

    const response = jsonResponse({ subscriptions: safeSubs });
    return setCORSHeaders(response, allowedOrigins, origin);
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    return corsErrorResponse('Failed to fetch subscriptions', 500, allowedOrigins, origin);
  }
}
