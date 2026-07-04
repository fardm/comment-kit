// Quick sanity tests for the fixed utilities.
// Run with: npx tsx scripts/sanity-check.ts

import {
  getClientIp,
  generateToken,
  isValidEmail,
  isValidUrl,
  isOriginAllowed,
  parseAllowedOrigins,
  setCORSHeaders,
  detectSpam,
  threadComments,
  escapeHtml,
} from '../src/lib/utils';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/', { headers });
}

console.log('\n== getClientIp ==');
// Should NOT return the colo code (the old bug).
const r1 = makeRequest({ 'CF-Connecting-IP': '203.0.113.42' });
assert(getClientIp(r1) === '203.0.113.42', 'returns CF-Connecting-IP when present');
const r2 = makeRequest({ 'X-Forwarded-For': '198.51.100.1, 10.0.0.1' });
assert(getClientIp(r2) === '198.51.100.1', 'returns first X-Forwarded-For when no CF-Connecting-IP');
const r3 = makeRequest({});
assert(getClientIp(r3) === 'unknown', 'returns "unknown" when no IP headers present');

console.log('\n== generateToken ==');
const t1 = generateToken(32);
const t2 = generateToken(32);
assert(t1.length === 32, 'token length matches requested length');
assert(t1 !== t2, 'two consecutive tokens are different (not deterministic)');

console.log('\n== isValidEmail ==');
assert(isValidEmail('user@example.com'), 'simple email is valid');
assert(isValidEmail('user+tag@gmail.com'), 'Gmail plus-addressing is valid (was rejected before fix)');
assert(isValidEmail('john123@example.com'), 'email with digits is valid (was rejected before fix)');
assert(isValidEmail('12345@example.com'), 'email starting with digits is valid (was rejected before fix)');
assert(!isValidEmail('notanemail'), 'plain string is invalid');
assert(!isValidEmail(''), 'empty string is invalid');

console.log('\n== isValidUrl ==');
assert(isValidUrl('https://example.com/page'), 'https URL is valid');
assert(isValidUrl('http://localhost:1313/post'), 'http URL is valid');
assert(!isValidUrl('javascript:alert(1)'), 'javascript: URL is REJECTED (was accepted before fix)');
assert(!isValidUrl(''), 'empty URL is invalid');

console.log('\n== setCORSHeaders ==');
// Wildcard mode
const resp1 = new Response(null);
setCORSHeaders(resp1, ['*'], 'https://evil.com');
assert(resp1.headers.get('Access-Control-Allow-Origin') === '*', 'wildcard mode returns *');
assert(!resp1.headers.get('Access-Control-Allow-Credentials'), 'wildcard mode does NOT set credentials');

// Explicit allow-list match
const resp2 = new Response(null);
setCORSHeaders(resp2, ['https://good.com'], 'https://good.com');
assert(resp2.headers.get('Access-Control-Allow-Origin') === 'https://good.com', 'allowed origin is echoed back');
assert(resp2.headers.get('Access-Control-Allow-Credentials') === 'true', 'credentials enabled for allowed origin');

// Non-matching origin (the critical fix)
const resp3 = new Response(null);
setCORSHeaders(resp3, ['https://good.com'], 'https://evil.com');
assert(
  !resp3.headers.get('Access-Control-Allow-Origin'),
  'non-matching origin gets NO ACAO header (was incorrectly reflected before fix)'
);

console.log('\n== detectSpam ==');
assert(!detectSpam('hello world', 'John', 'john@example.com'), 'normal content is not spam');
assert(detectSpam('buy viagra now', 'spammer', 'spam@x.com'), 'viagra keyword is spam');
assert(detectSpam('casino poker free money', 'spammer', 'spam@x.com'), 'casino keyword is spam');
assert(!detectSpam('check out my page', 'John', 'john+newsletter@gmail.com'), 'plus-addressed email is NOT spam (was rejected before fix)');
assert(!detectSpam('123 john doe 456', 'John', 'john123@example.com'), 'digits in email are NOT spam (was rejected before fix)');
assert(detectSpam('http://a.com http://b.com http://c.com http://d.com http://e.com', 'x', 'x@x.com'), 'excessive links is spam');

console.log('\n== threadComments ==');
const flat = [
  { id: 1, parent_id: null, content: 'root 1' },
  { id: 2, parent_id: 1, content: 'reply to 1' },
  { id: 3, parent_id: null, content: 'root 2' },
  { id: 4, parent_id: 2, content: 'reply to 2' },
  { id: 5, parent_id: 999, content: 'orphan reply (parent does not exist)' },
];
const tree = threadComments(JSON.parse(JSON.stringify(flat)));
assert(tree.length === 3, 'tree has 3 root nodes (2 roots + 1 promoted orphan)');
assert(tree[0].replies.length === 1, 'first root has 1 reply');
assert(tree[0].replies[0].replies.length === 1, 'reply has nested reply');
assert(tree[2].content === 'orphan reply (parent does not exist)', 'orphan reply is promoted to root (was lost before fix)');

console.log('\n== escapeHtml ==');
assert(escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;', 'escapes < >');
assert(escapeHtml('"quoted"') === '&quot;quoted&quot;', 'escapes double quotes');

console.log(`\n--- ${passed} passed, ${failed} failed ---`);
process.exit(failed === 0 ? 0 : 1);
