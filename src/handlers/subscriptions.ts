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
} from '../lib/utils';

export async function handleCreateSubscription(request: Request, env: Env): Promise<Response> {
  try {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { page_url, email } = body || {};

    if (!page_url || typeof page_url !== 'string') {
      return errorResponse('page_url is required', 400);
    }
    if (!email || typeof email !== 'string') {
      return errorResponse('email is required', 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return errorResponse('Invalid email address', 400);
    }

    const db = new Database(env.DB);

    // Idempotency: if (page_url, email) is already subscribed, return
    // success WITHOUT leaking the existing unsubscribe token. The
    // previous implementation relied on a UNIQUE-constraint error to
    // detect duplicates and returned the existing subscription's
    // token in the success path on the second attempt — but since we
    // generate a fresh random token on each call, the second attempt
    // would throw UNIQUE. We now handle this explicitly.
    const existingToken = await db.getSubscriptionToken(page_url, normalizedEmail);
    if (existingToken) {
      const response = jsonResponse({ message: 'Already subscribed' }, 200);
      return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
    }

    const token = generateToken(32);
    await db.createSubscription({
      page_url,
      email: normalizedEmail,
      token,
    });

    // Note: we DO return the token here because the subscriber needs
    // it for the immediate "manage your subscription" UX. The token
    // is never exposed in GET /api/subscriptions (that endpoint is
    // admin-only — see handleGetSubscriptions).
    const response = jsonResponse(
      {
        message: 'Subscription created successfully',
        token,
      },
      201
    );
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error creating subscription:', error);
    return errorResponse('Failed to create subscription', 500);
  }
}

export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token || typeof token !== 'string') {
      return errorResponse('Token is required', 400);
    }

    const db = new Database(env.DB);
    const success = await db.unsubscribe(token);

    if (!success) {
      // Return 200 with a not-found message rather than 404 — the user
      // may have already unsubscribed, and a 404 page is confusing UX
      // for an unsubscribe link. The previous implementation returned
      // 404 which made email clients show a scary error.
      const response = jsonResponse({
        message: 'You are not subscribed (or have already unsubscribed).',
      });
      return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
    }

    const response = jsonResponse({ message: 'Unsubscribed successfully' });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error unsubscribing:', error);
    return errorResponse('Failed to unsubscribe', 500);
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
  try {
    // Require admin auth
    const token = extractAuthToken(request);
    if (!token) {
      return errorResponse('Unauthorized', 401);
    }
    const db = new Database(env.DB);
    const auth = new Auth(env, db);
    const ok = await auth.validateSession(token);
    if (!ok) {
      return errorResponse('Unauthorized', 401);
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
      return errorResponse('Either email or page_url parameter is required', 400);
    }

    // Even for admins, strip the raw unsubscribe token from list
    // responses — admins don't need it to manage subscriptions, and
    // exposing it through the admin API would re-introduce the leak
    // if the admin panel ever gets an XSS. Admins can still unpause
    // a subscription via a dedicated admin endpoint if needed.
    const safeSubs = subscriptions.map((s) => {
      const clone: any = { ...s };
      delete clone.token;
      return clone;
    });

    const response = jsonResponse({ subscriptions: safeSubs });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS), getOrigin(request));
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    return errorResponse('Failed to fetch subscriptions', 500);
  }
}
