// Authentication and session management

import type { Session, Env } from '../types';
import { Database } from './db';
import { generateToken, hashPassword, verifyPassword } from './utils';

export class Auth {
  private db: Database;
  private sessionLifetime: number;

  constructor(env: Env, db: Database) {
    this.db = db;
    this.sessionLifetime = parseInt(env.SESSION_LIFETIME || '2592000', 10); // 30 days default
    if (isNaN(this.sessionLifetime) || this.sessionLifetime <= 0) {
      this.sessionLifetime = 2592000;
    }

    // BUG FIXED: the previous implementation read `env.JWT_SECRET` and
    // silently fell back to the literal string `'default-secret-change-in-production'`.
    // That value is committed in the source, so any deployment that forgot to
    // set the secret would silently run with a publicly-known "secret" —
    // defeating the entire purpose of having a secret.
    //
    // The `jwtSecret` field was also dead code: this class never issued or
    // verified JWTs, it generated random opaque tokens via `generateToken`.
    // We've removed the field entirely. If JWT support is needed in the
    // future, it should fail loud when the secret is missing instead of
    // silently using a default.
  }

  async createSession(ipAddress: string | null, userAgent: string | null): Promise<string> {
    const token = generateToken(64);
    const expiresAt = new Date(Date.now() + this.sessionLifetime * 1000).toISOString();

    await this.db.createSession({
      token,
      expires_at: expiresAt,
      ip_address: ipAddress,
      user_agent: userAgent,
    });

    return token;
  }

  async validateSession(token: string): Promise<boolean> {
    if (!token || typeof token !== 'string') return false;

    const session = await this.db.getSessionByToken(token);
    if (!session) return false;

    // Check if session is expired
    const now = new Date();
    const expiresAt = new Date(session.expires_at);
    if (isNaN(expiresAt.getTime())) {
      // Defensive: malformed expires_at — treat as expired and delete.
      await this.db.deleteSession(token);
      return false;
    }
    if (now > expiresAt) {
      await this.db.deleteSession(token);
      return false;
    }

    // Update last activity (best-effort; failure here should not log the
    // user out).
    try {
      await this.db.updateSession(token);
    } catch {
      // ignore
    }

    return true;
  }

  async deleteSession(token: string): Promise<void> {
    if (!token) return;
    await this.db.deleteSession(token);
  }

  /**
   * Verify the admin password against the configured hash.
   *
   * BUG FIXED: the previous implementation returned `false` (via
   * `verifyPassword` returning `false`) when `ADMIN_PASSWORD_HASH` was
   * not set, but only after a comparison against `undefined`. Worse, the
   * `verifyAdminPassword` method here threw `Error('Admin password not
   * configured')` — which the caller in `handleAdminLogin` did NOT
   * catch specifically, so it bubbled up to the generic 500 handler.
   *
   * The new behavior: if the hash is missing or empty, we return `false`
   * cleanly so the caller can return a normal 401. This also prevents
   * an attacker from being able to log in with an empty password when
   * the hash happens to be unset.
   */
  async verifyAdminPassword(password: string, env: Env): Promise<boolean> {
    const storedHash = env.ADMIN_PASSWORD_HASH;
    if (!storedHash || typeof storedHash !== 'string' || storedHash.length === 0) {
      // Misconfigured deployment. Fail closed (deny login) rather than
      // throwing — the caller will return a 401 which is the correct
      // user-facing behavior, and we log a server-side warning.
      console.warn('ADMIN_PASSWORD_HASH is not set; admin login will be denied.');
      return false;
    }

    if (!password || typeof password !== 'string') return false;

    return verifyPassword(password, storedHash);
  }

  /**
   * Hash a password and return the hex digest. Used by setup/import scripts
   * to produce the value that should be stored as the `ADMIN_PASSWORD_HASH`
   * secret. This method does NOT persist anything.
   */
  async hashPasswordForSecret(password: string): Promise<string> {
    return hashPassword(password);
  }

  async checkRateLimit(ipAddress: string): Promise<{ allowed: boolean; remaining: number }> {
    const recentAttempts = await this.db.getRecentFailedLoginAttempts(ipAddress, 15);
    const maxAttempts = 5;

    if (recentAttempts >= maxAttempts) {
      return { allowed: false, remaining: 0 };
    }

    return { allowed: true, remaining: maxAttempts - recentAttempts };
  }

  async recordLoginAttempt(ipAddress: string, success: boolean): Promise<void> {
    await this.db.createLoginAttempt({ ip_address: ipAddress, success: success ? 1 : 0 });

    // Clean up old attempts periodically (probabilistic to avoid per-request overhead)
    if (Math.random() < 0.1) {
      try {
        await this.db.cleanupOldLoginAttempts();
      } catch {
        // ignore cleanup failures
      }
    }
  }

  async cleanupExpiredSessions(): Promise<number> {
    return await this.db.deleteExpiredSessions();
  }
}

/**
 * Extract an admin auth token from a request.
 *
 * Looks for, in order:
 *   1. `Authorization: Bearer <token>` header
 *   2. `admin_token=<token>` cookie
 *
 * The cookie support exists so that the admin panel can rely on cookies
 * set by the login response (see `handleAdminLogin` which now sets the
 * cookie via `Set-Cookie`). Both paths use the same token format.
 */
export function extractAuthToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token) return token;
  }

  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith('admin_token=')) {
        const token = cookie.substring('admin_token='.length).trim();
        if (token) return token;
      }
    }
  }

  return null;
}
