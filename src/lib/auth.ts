// Authentication and session management

import type { Session, Env } from '../types';
import { Database } from './db';
import { generateToken, hashPassword, verifyPassword } from './utils';

export class Auth {
  private db: Database;
  private sessionLifetime: number;
  private jwtSecret: string;

  constructor(env: Env, db: Database) {
    this.db = db;
    this.sessionLifetime = parseInt(env.SESSION_LIFETIME || '2592000'); // 30 days default
    this.jwtSecret = env.JWT_SECRET || 'default-secret-change-in-production';
  }

  async createSession(ipAddress: string | null, userAgent: string | null): Promise<string> {
    const token = generateToken(64);
    const expiresAt = new Date(Date.now() + this.sessionLifetime * 1000).toISOString();
    
    await this.db.createSession({
      token,
      expires_at: expiresAt,
      ip_address: ipAddress,
      user_agent: userAgent
    });
    
    return token;
  }

  async validateSession(token: string): Promise<boolean> {
    const session = await this.db.getSessionByToken(token);
    if (!session) return false;
    
    // Check if session is expired
    const now = new Date();
    const expiresAt = new Date(session.expires_at);
    if (now > expiresAt) {
      await this.db.deleteSession(token);
      return false;
    }
    
    // Update last activity
    await this.db.updateSession(token);
    
    return true;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.deleteSession(token);
  }

  async verifyAdminPassword(password: string, env: Env): Promise<boolean> {
    const storedHash = env.ADMIN_PASSWORD_HASH;
    if (!storedHash) {
      throw new Error('Admin password not configured');
    }
    
    return verifyPassword(password, storedHash);
  }

  async setAdminPassword(password: string, env: Env): Promise<string> {
    const hash = await hashPassword(password);
    // This would be set as a secret in production
    return hash;
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
    
    // Clean up old attempts periodically
    if (Math.random() < 0.1) {
      await this.db.cleanupOldLoginAttempts();
    }
  }

  async cleanupExpiredSessions(): Promise<number> {
    return await this.db.deleteExpiredSessions();
  }
}

export function extractAuthToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith('admin_token=')) {
        return cookie.substring('admin_token='.length);
      }
    }
  }
  
  return null;
}
