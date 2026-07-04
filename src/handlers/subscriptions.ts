// Handlers for email subscriptions

import type { Env } from '../types';
import { Database } from '../lib/db';
import { generateToken, isValidEmail, errorResponse, jsonResponse, parseAllowedOrigins, setCORSHeaders } from '../lib/utils';

export async function handleCreateSubscription(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json();
    const { page_url, email } = body;

    if (!page_url || !email) {
      return errorResponse('Missing required fields', 400);
    }

    if (!isValidEmail(email)) {
      return errorResponse('Invalid email address', 400);
    }

    const db = new Database(env.DB);
    const token = generateToken(32);

    try {
      await db.createSubscription({ page_url, email, token });
    } catch (error: any) {
      // Duplicate subscription
      if (error.message && error.message.includes('UNIQUE')) {
        const response = jsonResponse({ message: 'Already subscribed' }, 200);
        return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS));
      }
      throw error;
    }

    const response = jsonResponse({ 
      message: 'Subscription created successfully',
      token 
    }, 201);
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS));
  } catch (error) {
    console.error('Error creating subscription:', error);
    return errorResponse('Failed to create subscription', 500);
  }
}

export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return errorResponse('Token is required', 400);
    }

    const db = new Database(env.DB);
    const success = await db.unsubscribe(token);

    if (!success) {
      return errorResponse('Invalid or expired token', 404);
    }

    const response = jsonResponse({ message: 'Unsubscribed successfully' });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS));
  } catch (error) {
    console.error('Error unsubscribing:', error);
    return errorResponse('Failed to unsubscribe', 500);
  }
}

export async function handleGetSubscriptions(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const email = url.searchParams.get('email');
    const pageUrl = url.searchParams.get('page_url');

    const db = new Database(env.DB);
    let subscriptions;

    if (email) {
      subscriptions = await db.getSubscriptionsByEmail(email);
    } else if (pageUrl) {
      subscriptions = await db.getSubscriptionsByPageUrl(pageUrl);
    } else {
      return errorResponse('Either email or page_url parameter is required', 400);
    }

    const response = jsonResponse({ subscriptions });
    return setCORSHeaders(response, parseAllowedOrigins(env.ALLOWED_ORIGINS));
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    return errorResponse('Failed to fetch subscriptions', 500);
  }
}
