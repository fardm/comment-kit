// Utility functions

export function getClientIp(request: Request): string {
  const cf = (request as any).cf;
  if (cf?.colo) {
    return cf.colo;
  }
  
  const forwardedFor = request.headers.get('CF-Connecting-IP');
  if (forwardedFor) {
    return forwardedFor;
  }
  
  const xForwardedFor = request.headers.get('X-Forwarded-For');
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }
  
  return 'unknown';
}

export function getUserAgent(request: Request): string {
  return request.headers.get('User-Agent') || 'unknown';
}

export function getOrigin(request: Request): string | null {
  return request.headers.get('Origin');
}

export function generateToken(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  return crypto.subtle.digest('SHA-256', data).then(hash => {
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  return passwordHash === hash;
}

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeHtml(html: string): string {
  // Basic HTML sanitization - remove script tags and dangerous attributes
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, char => map[char]);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function resolvePageUrl(pageUrl: string, siteOrigin: string): string {
  if (!pageUrl) return pageUrl;
  
  if (pageUrl.startsWith('http://') || pageUrl.startsWith('https://')) {
    return pageUrl;
  }
  
  if (pageUrl.startsWith('/')) {
    return siteOrigin + pageUrl;
  }
  
  return siteOrigin + '/' + pageUrl;
}

export function parseAllowedOrigins(originsString: string): string[] {
  if (originsString === '*') return ['*'];
  return originsString.split(',').map(o => o.trim()).filter(o => o.length > 0);
}

export function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes('*')) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

export function setCORSHeaders(response: Response, allowedOrigins: string[], requestOrigin?: string | null): Response {
  const origin = requestOrigin || '*';
  const allowedOrigin = allowedOrigins.includes('*') ? '*' : 
    (allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] || '*'));
  
  response.headers.set('Access-Control-Allow-Origin', allowedOrigin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  
  return response;
}

export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

export function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function threadComments(comments: any[]): any[] {
  const commentMap = new Map();
  const roots: any[] = [];
  
  // First pass: create map and initialize replies array
  for (const comment of comments) {
    comment.replies = [];
    commentMap.set(comment.id, comment);
  }
  
  // Second pass: build tree structure
  for (const comment of comments) {
    if (comment.parent_id === null) {
      roots.push(comment);
    } else {
      const parent = commentMap.get(comment.parent_id);
      if (parent) {
        parent.replies.push(comment);
      }
    }
  }
  
  return roots;
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  
  return date.toLocaleDateString();
}

export function detectSpam(content: string, authorName: string, authorEmail: string): boolean {
  const spamKeywords = [
    'viagra', 'cialis', 'casino', 'poker', 'lottery', 'winner',
    'free money', 'click here', 'buy now', 'subscribe', 'unsubscribe',
    'porn', 'xxx', 'sex', 'adult', 'dating', 'escort',
    'seo', 'backlink', 'pagerank', 'alexa', 'google ranking'
  ];
  
  const lowerContent = content.toLowerCase();
  const lowerName = authorName.toLowerCase();
  const lowerEmail = authorEmail.toLowerCase();
  
  // Check for spam keywords
  for (const keyword of spamKeywords) {
    if (lowerContent.includes(keyword) || lowerName.includes(keyword)) {
      return true;
    }
  }
  
  // Check for excessive links
  const linkCount = (content.match(/https?:\/\//g) || []).length;
  if (linkCount > 3) return true;
  
  // Check for excessive caps
  const capsRatio = (content.match(/[A-Z]/g) || []).length / content.length;
  if (capsRatio > 0.7 && content.length > 20) return true;
  
  // Check for suspicious email patterns
  if (/\d+@/.test(authorEmail)) return true;
  if (authorEmail.includes('+')) return true; // disposable emails often use +
  
  return false;
}
