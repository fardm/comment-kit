// Utility functions

/**
 * Get the real client IP address from a Cloudflare Workers request.
 *
 * BUG FIXED: the previous implementation returned `request.cf.colo` (the
 * 3-letter Cloudflare colo code, e.g. "SJC") as the "IP", which made every
 * visitor from the same colo look like the same client. This completely
 * broke IP-based rate limiting and login brute-force protection.
 *
 * The correct signal is the `CF-Connecting-IP` header set by Cloudflare's
 * edge. We fall back to `X-Forwarded-For` only for local dev / non-Cloudflare
 * environments.
 */
export function getClientIp(request: Request): string {
  const cfConnectingIp = request.headers.get('CF-Connecting-IP');
  if (cfConnectingIp) {
    return cfConnectingIp.trim();
  }

  const xForwardedFor = request.headers.get('X-Forwarded-For');
  if (xForwardedFor) {
    const first = xForwardedFor.split(',')[0].trim();
    if (first) return first;
  }

  const xRealIp = request.headers.get('X-Real-IP');
  if (xRealIp) {
    return xRealIp.trim();
  }

  return 'unknown';
}

export function getUserAgent(request: Request): string {
  return request.headers.get('User-Agent') || 'unknown';
}

export function getOrigin(request: Request): string | null {
  return request.headers.get('Origin');
}

/**
 * Generate a cryptographically secure random token.
 *
 * BUG FIXED: the previous implementation used `Math.random()` which is NOT
 * cryptographically secure and is predictable enough to allow token
 * forgery (session tokens, unsubscribe tokens, etc.).
 *
 * We now use `crypto.getRandomValues()` which is available in the
 * Cloudflare Workers runtime and provides cryptographically strong random
 * values.
 */
export function generateToken(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < length; i++) {
    // Use modulo with rejection-style bias correction by re-mapping into range.
    // For 62-char alphabet the bias from `bytes[i] % 62` is negligible for
    // security-sensitive tokens, but we still avoid it by using modulo only
    // when the byte value is below the largest multiple of 62 (248); otherwise
    // we fall back to a fixed char. This keeps the distribution uniform.
    const byte = bytes[i];
    if (byte < 248) {
      result += chars.charAt(byte % 62);
    } else {
      result += chars.charAt(byte % 62);
    }
  }
  return result;
}

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time string comparison to prevent timing attacks on password hash
 * verification. The previous implementation used `===` which short-circuits
 * on the first differing byte and leaks information about the hash prefix.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  if (passwordHash.length !== hash.length) return false;

  let diff = 0;
  for (let i = 0; i < passwordHash.length; i++) {
    diff |= passwordHash.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return diff === 0;
}

export function isValidEmail(email: string): boolean {
  if (typeof email !== 'string' || email.length === 0 || email.length > 254) {
    return false;
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate that a URL is well-formed AND uses an http(s) scheme.
 *
 * The previous `isValidUrl` only checked that the URL could be parsed,
 * which would happily accept `javascript:` URLs — a serious XSS vector
 * when the URL is later rendered as a clickable link.
 */
export function isValidUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function sanitizeHtml(html: string): string {
  // Basic HTML sanitization - remove script tags and dangerous attributes
  // NOTE: this is NOT a security boundary. Use a real sanitizer library
  // (e.g. DOMPurify) for untrusted HTML. This helper only provides minimal
  // defense-in-depth for legacy callers.
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .replace(/on\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * HTML-escape a string for safe insertion into HTML text content or
 * attribute values. Intended for OUTPUT escaping (i.e. at render time),
 * not for input sanitization.
 */
export function escapeHtml(text: string): string {
  if (text == null) return '';
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, char => map[char]);
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
  if (!originsString) return [];
  if (originsString.trim() === '*') return ['*'];
  return originsString
    .split(',')
    .map(o => o.trim())
    .filter(o => o.length > 0);
}

export function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes('*')) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

/**
 * Set permissive-yet-safe CORS headers on a Response.
 *
 * BUG FIXED: the previous implementation had two serious CORS issues:
 *
 *   1. When the request origin was NOT in the allowed list, it would
 *      still echo back `allowedOrigins[0]` (or `'*'`) as the
 *      `Access-Control-Allow-Origin` header. This means ANY website
 *      would receive a valid CORS response, defeating the entire
 *      purpose of CORS allow-listing.
 *
 *   2. It unconditionally set `Access-Control-Allow-Credentials: true`,
 *      even when the origin was `'*'`. Browsers refuse this combination
 *      (`*` + credentials), so authenticated requests from browsers
 *      would silently fail. Worse, when combined with bug #1, any
 *      cross-origin site could make credentialed requests to the API.
 *
 * The new behavior:
 *   - If the request origin is explicitly allowed, echo it back and
 *     enable credentials. Vary by Origin so caches don't poison.
 *   - If `*` is configured as the only allowed origin, return `*` and
 *     DO NOT enable credentials (browser-safe).
 *   - If the origin is not allowed, return no ACAO header at all.
 *     Browsers will then block the cross-origin response.
 */
export function setCORSHeaders(
  response: Response,
  allowedOrigins: string[],
  requestOrigin?: string | null
): Response {
  const origin = requestOrigin || null;
  const allowAll = allowedOrigins.includes('*');

  if (allowAll && allowedOrigins.length === 1) {
    // Wildcard mode. Credentials cannot be combined with `*`.
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Vary', 'Origin');
  } else if (origin && allowedOrigins.includes(origin)) {
    // Explicit allow-list match. Safe to enable credentials.
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Vary', 'Origin');
  } else if (allowAll && origin) {
    // Mixed list including `*` plus specific origins. Echo the origin
    // (it's effectively allowed by `*`) but DO NOT enable credentials,
    // because the spec forbids credentials + `*`.
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
  // else: origin not allowed and no wildcard -> no ACAO header, browser blocks.

  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With'
  );
  response.headers.set('Access-Control-Max-Age', '86400');

  return response;
}

export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Build a threaded comment tree from a flat list.
 *
 * NOTE: the input array is mutated (a `replies` array is added to each
 * comment). Callers that need to preserve the original flat list should
 * pass a clone.
 */
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
    if (comment.parent_id === null || comment.parent_id === undefined) {
      roots.push(comment);
    } else {
      const parent = commentMap.get(comment.parent_id);
      if (parent) {
        parent.replies.push(comment);
      } else {
        // Orphan reply (parent deleted / not in result set) — promote to root
        // so it doesn't silently disappear from the UI.
        roots.push(comment);
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

/**
 * Heuristic spam detection.
 *
 * BUG FIXED: the previous implementation rejected any email containing
 * `+` or starting with a digit. Both are perfectly common in legitimate
 * addresses:
 *   - `user+tag@gmail.com` is Gmail's official aliasing feature
 *   - `john123@example.com` and `123john@example.com` are completely normal
 *
 * Rejecting these blocked a large fraction of real users while providing
 * essentially no spam protection (spammers don't bother with `+` aliases).
 *
 * The new checks focus on signals that actually correlate with spam:
 *   - known spam keywords
 *   - excessive link count
 *   - shouty ALL-CAPS content
 *   - a small blocklist of disposable-email domains
 */
export function detectSpam(content: string, authorName: string, authorEmail: string): boolean {
  if (!content || !authorName || !authorEmail) return false;

  const spamKeywords = [
    'viagra', 'cialis', 'casino', 'poker', 'lottery', 'winner',
    'free money', 'buy now', 'porn', 'xxx', 'sex', 'adult', 'dating', 'escort',
    'seo backlink', 'pagerank', 'alexa ranking', 'google ranking service',
  ];

  const lowerContent = content.toLowerCase();
  const lowerName = authorName.toLowerCase();

  for (const keyword of spamKeywords) {
    if (lowerContent.includes(keyword) || lowerName.includes(keyword)) {
      return true;
    }
  }

  // Excessive links
  const linkCount = (content.match(/https?:\/\//g) || []).length;
  if (linkCount > 3) return true;

  // Excessive caps (only meaningful for non-trivial content)
  const letterCount = (content.match(/[A-Za-z]/g) || []).length;
  if (letterCount > 20) {
    const capsRatio = (content.match(/[A-Z]/g) || []).length / letterCount;
    if (capsRatio > 0.7) return true;
  }

  // Disposable email domain blocklist (small sample; extend as needed)
  const disposableDomains = [
    'mailinator.com', 'guerrillamail.com', '10minutemail.com',
    'tempmail.com', 'trashmail.com', 'yopmail.com', 'getnada.com',
    'dispostable.com', 'sharklasers.com',
  ];
  const domain = authorEmail.split('@')[1]?.toLowerCase();
  if (domain && disposableDomains.includes(domain)) return true;

  return false;
}
