# Debug Report — comment-kit (PHP → Cloudflare Workers refactor)

Repository: https://github.com/fardm/comment-kit
Audit performed on: 2026-07-05
Auditor: Super Z (automated)

This report documents every bug discovered during the audit of the
Cloudflare Workers port of the original PHP comment system, and the
fix applied for each. All fixes have been applied in place — no
source files were left in a broken state. `tsc --noEmit` and the
worker dry-run build both pass.

The fixes are grouped by severity. Within each group, items are
ordered roughly by impact.

---

## 🔴 CRITICAL — Security / Privacy

### 1. `getClientIp()` returned the Cloudflare colo code instead of the client IP

**File:** `src/lib/utils.ts`

The previous implementation started with:

```ts
const cf = (request as any).cf;
if (cf?.colo) {
  return cf.colo;  // ❌ "SJC", "FRA", etc. — NOT an IP address
}
```

`request.cf.colo` is the 3-letter code of the Cloudflare datacenter
that served the request. Returning it as the "client IP" meant:

- every visitor from the same colo was treated as the same client
- IP-based rate limiting was effectively disabled (5 comments / hour
  shared across everyone in the same metro)
- login brute-force protection was effectively disabled (5 failed
  attempts / 15 minutes shared across the entire colo)

**Fix:** Removed the `cf.colo` lookup entirely. We now read
`CF-Connecting-IP` (set by Cloudflare's edge), then
`X-Forwarded-For`, then `X-Real-IP`, then fall back to `'unknown'`.

---

### 2. Public comment endpoints leaked PII (IP address + email)

**File:** `src/handlers/comments.ts`

`handleGetComments` and `handleGetComment` returned the full `Comment`
row, which includes `ip_address`, `author_email`, and `user_agent`.
Anyone on the internet could fetch the IP and email of every commenter
by simply listing approved comments.

**Fix:** Added a `stripPrivateCommentFields()` helper that deletes
`ip_address`, `user_agent`, and `author_email` from the comment
object (and from every nested reply) before serialization. All public
endpoints now run responses through this helper.

---

### 3. Public endpoints served `pending`, `spam`, and `deleted` comments

**File:** `src/handlers/comments.ts`

`handleGetComments` accepted a `?status=` query parameter and would
return comments in any status. `handleGetComment` used
`getCommentById()` which returns rows regardless of status. This let
anyone enumerate pre-moderation drafts and spam samples by ID.

**Fix:**
- `handleGetComments` now hard-codes `status='approved'` and ignores
  any client-supplied `status` parameter.
- `handleGetComment` now uses the new `Database.getPublicCommentById()`
  helper which adds `AND status = 'approved'` to the WHERE clause.
- `handleCreateComment` parent-comment lookup now uses
  `getPublicCommentById()` so users can't reply to pending/spam
  comments and can't detect their existence via the parent_id error
  message.

---

### 4. `GET /api/subscriptions` was public and exposed unsubscribe tokens

**File:** `src/handlers/subscriptions.ts`

Anyone could query:

```
GET /api/subscriptions?email=victim@example.com
```

and receive back a list of `(page_url, email, token)` tuples. The
`token` is the **unsubscribe token** — so an attacker who knew a
victim's email could unsubscribe them from every page they followed.
Even without the token leak, the endpoint was a privacy violation
(revealing which pages a user reads).

**Fix:**
- `handleGetSubscriptions` now requires admin authentication.
- Even for admins, the `token` field is stripped from list responses.
- Public users manage their subscription exclusively via the
  token-based unsubscribe link sent to their email.

---

### 5. CORS misconfiguration allowed any origin to make credentialed requests

**File:** `src/lib/utils.ts` (`setCORSHeaders`)

The previous implementation had two compounding bugs:

```ts
const allowedOrigin = allowedOrigins.includes('*') ? '*' :
  (allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] || '*'));
response.headers.set('Access-Control-Allow-Origin', allowedOrigin);
response.headers.set('Access-Control-Allow-Credentials', 'true');
```

1. When the request origin was **not** in the allowed list, the code
   still echoed back `allowedOrigins[0]` (or `'*'` if the list was
   empty). Any website on the internet would receive a valid CORS
   response.
2. `Access-Control-Allow-Credentials: true` was set unconditionally,
   including when the ACAO value was `*`. Browsers refuse that
   combination for credentialed requests, so authenticated
   browser-side calls silently failed.

**Fix:** Rewrote `setCORSHeaders` with three explicit cases:

- Wildcard-only mode (`ALLOWED_ORIGINS = "*"`) → returns `*` and
  does **not** enable credentials.
- Explicit allow-list match → echoes the request origin and enables
  credentials.
- No match → returns **no** `Access-Control-Allow-Origin` header at
  all, causing the browser to block the cross-origin response.

Also added `Vary: Origin` and `Access-Control-Max-Age: 86400`.

---

### 6. `detectSpam()` rejected millions of legitimate email addresses

**File:** `src/lib/utils.ts`

The previous implementation flagged any email containing `+` or
starting with a digit as spam:

```ts
if (/\d+@/.test(authorEmail)) return true;  // ❌ rejects john123@…
if (authorEmail.includes('+')) return true; // ❌ rejects user+tag@gmail.com
```

- Gmail's `user+tag@gmail.com` aliasing is an official, widely-used
  feature for inbox filtering.
- Emails like `john123@…` or `12345@…` are completely normal.

Both rules blocked large fractions of real users while providing
essentially no spam protection (spammers don't bother with `+`
aliases or numeric prefixes).

**Fix:** Removed both checks. Added a small blocklist of disposable
email domains (`mailinator.com`, `guerrillamail.com`, etc.) instead,
which is a much higher-signal spam indicator. Also tightened the
caps-ratio check to only fire when the content has more than 20
letters (avoiding false positives on short comments).

---

### 7. `generateToken()` used `Math.random()` for security-sensitive tokens

**File:** `src/lib/utils.ts`

Session tokens, unsubscribe tokens, and subscription tokens were all
generated using `Math.random()`, which is **not** cryptographically
secure — its output can be predicted from a small sample of outputs,
allowing session forgery.

**Fix:** Replaced with `crypto.getRandomValues()`, which is available
in the Cloudflare Workers runtime and provides cryptographically
strong randomness.

---

### 8. `verifyPassword()` used non-constant-time comparison

**File:** `src/lib/utils.ts`

The previous implementation compared password hashes with `===`,
which short-circuits on the first differing byte and leaks
information about the hash prefix via timing.

**Fix:** Replaced with a constant-time XOR comparison loop.

---

### 9. `JWT_SECRET` had a hardcoded insecure default

**File:** `src/lib/auth.ts`

```ts
this.jwtSecret = env.JWT_SECRET || 'default-secret-change-in-production';
```

Any deployment that forgot to set the secret would silently run with
a publicly-known value. Worse, `this.jwtSecret` was **dead code** —
the Auth class never issued or verified JWTs; it used opaque random
tokens generated by `generateToken()`.

**Fix:** Removed the `jwtSecret` field entirely. Updated `Env` type
in `src/types/index.ts` to drop `JWT_SECRET`. Updated
`wrangler.toml`'s secrets comment to reflect that `JWT_SECRET` is no
longer required.

---

### 10. `handleUpdateSettings` allowed overwriting any settings key

**File:** `src/handlers/admin.ts`

The previous implementation iterated over **every** key in the
request body and persisted it via `setSetting(key, String(value))`.
An attacker who stole an admin session could overwrite arbitrary
configuration — most dangerously `schema_version`, but also any
future system key.

**Fix:** Added an explicit `ALLOWED_SETTING_KEYS` whitelist with
per-key validators (`require_moderation` must be `'true'|'false'`,
`max_comment_length` must be 100–50000, etc.). System keys
(`admin_password_hash`, `jwt_secret`, `schema_version`) are hard-
blocked. The response reports which keys were applied and which were
rejected.

---

### 11. `isValidUrl()` accepted `javascript:` URLs

**File:** `src/lib/utils.ts`

The previous implementation only checked that the URL could be
parsed by `new URL()`. That happily accepts `javascript:alert(1)`,
which is a serious XSS vector when the URL is later rendered as a
clickable link (e.g. in `author_url`).

**Fix:** `isValidUrl()` now requires the parsed URL's `protocol` to
be `http:` or `https:`. `handleCreateComment` now validates
`author_url` (and `page_url`) with this stricter check.

---

## 🟠 HIGH — Functional Bugs

### 12. Email notifications were never sent (dead code)

**File:** `src/handlers/comments.ts`, `src/handlers/email.ts`

The `EmailService` class existed but was never instantiated or
called. `handleCreateComment` created the comment and returned
without notifying subscribers, parent-comment authors, or admins.
The README advertised this as a feature.

**Fix:** `handleCreateComment` now:
- Calls `emailService.notifyReply()` when the comment is a reply
  (skips self-replies).
- Calls `emailService.notifyNewComment()` for non-spam comments
  (skips the comment's own author if they're subscribed).
- Wraps all email logic in try/catch so email failures never affect
  the HTTP response.

---

### 13. Email queue was never drained (no `scheduled` handler / no cron)

**File:** `src/index.ts`, `wrangler.toml`

Even with `EmailService` wired up, the queue would accumulate
`pending` rows forever because:
- the worker exported only a `fetch` handler, no `scheduled` handler
- `wrangler.toml` had no `[triggers].crons` entry

The README literally said "Set up a Cloudflare Cron Trigger to
process the queue (coming soon)".

**Fix:**
- Added a `scheduled()` handler to the worker that calls
  `emailService.processEmailQueue()` via `ctx.waitUntil()`.
- Added `[triggers] crons = ["*/5 * * * *"]` to `wrangler.toml`
  (every 5 minutes — the minimum interval Cloudflare allows).

---

### 14. `EmailService.generateUnsubscribeToken()` produced invalid tokens

**File:** `src/handlers/email.ts`

The previous implementation hashed `email:pageUrl:timestamp` to
build unsubscribe links:

```ts
const data = `${email}:${pageUrl}:${Date.now()}`;
const hash = Array.from(new Uint8Array(crypto.subtle.digestSync('SHA-256', dataBytes)))...
```

Two compounding bugs:

1. `crypto.subtle.digestSync` does **not exist** in the Web Crypto
   API (only `digest` is, and it's async). Any code path that reached
   this method would throw at runtime.
2. Even if `digestSync` had existed, the resulting hash did NOT
   match any row in the `subscriptions` table (which stores a random
   token generated at subscription time). Every "unsubscribe" link
   in every notification email pointed to a non-existent token, so
   clicking it returned 404.

**Fix:** Added `Database.getSubscriptionToken(pageUrl, email)` which
looks up the actual subscription token from the DB. The email body
now uses this real token in the unsubscribe link. If no subscription
exists (e.g. user already unsubscribed), the unsubscribe block is
omitted entirely rather than emitting a broken link. All email-body
interpolation is now HTML-escaped at render time to prevent injection
into the email HTML.

---

### 15. `incrementEmailAttempts()` set `status='failed'` after first failure

**File:** `src/lib/db.ts`

```ts
SET attempts = attempts + 1, last_error = ?, status = 'failed'
```

This prevented any retries — the very first send failure permanently
marked the email as `'failed'`, even though `getPendingEmails()`
filters on `attempts < 5` (implying up to 5 retries were intended).

**Fix:** The status is now only flipped to `'failed'` once
`attempts + 1 >= 5`. Transient failures get retried on the next cron
tick.

---

### 16. Vote toggle logic was broken (only one reaction type per user)

**File:** `src/handlers/reactions.ts`, `src/lib/db.ts`

The schema's UNIQUE constraint is on
`(comment_id, ip_address, reaction_type)`, which allows a user to
cast **one of each** reaction type on a comment. But the code used
`getUserVote()` (singular) which returned only the FIRST reaction
the user had cast, then the toggle logic was:

```ts
if (existingVote === reaction_type) { /* toggle off */ }
if (existingVote) { await removeVote(comment_id, ip, existingVote); } // ❌ removes a different vote
await createVote(...)
```

So voting "heart" then "thumbs_up" silently **deleted** the "heart"
vote instead of adding "thumbs_up" alongside it.

**Fix:** Added `Database.getUserVotes()` (plural) which returns the
full array of reaction types the user has cast. The toggle logic now
checks whether the requested `reaction_type` is in that array and
toggles it independently — multiple reactions per user per comment
now work as the schema intended.

---

### 17. Vote rate-limit counter was incremented on toggle-OFF

**File:** `src/handlers/reactions.ts`

The previous implementation called `rateLimiter.logVote(ip)` inside
the toggle-off branch:

```ts
if (existingVote === reaction_type) {
  await db.removeVote(comment_id, ip, reaction_type);
  await rateLimiter.logVote(ip);  // ❌ removing a vote consumed rate-limit budget
  ...
}
```

A user who clicked reactions on/off would exhaust their 20-votes /
hour budget and be unable to vote at all.

**Fix:** `logVote()` is now only called when a NEW vote is created.
Toggle-off is free.

---

### 18. Post-reaction rate limit shared a counter with comment votes

**File:** `src/lib/rate-limit.ts`, `src/lib/db.ts`, `migrations/schema.sql`

`checkPostReactionLimit()` called `getRecentVoteCount()`, which
counts rows in `vote_log` — a table dedicated to **comment** votes.
And `handleCreatePostReaction` called `rateLimiter.logVote(ip)` to
record post reactions. So:

- The per-IP vote limit (20/hour) and post-reaction limit (10/hour)
  shared a single counter.
- A user who cast 20 votes couldn't react to any posts.
- A user who reacted to 10 posts couldn't vote on any comments.

**Fix:**
- Added a new `post_reaction_log` table in `migrations/schema.sql`.
- Added `Database.logPostReaction()` and
  `Database.getRecentPostReactionCount()` methods.
- `RateLimiter.checkPostReactionLimit()` now queries the dedicated
  table.
- `RateLimiter` exposes a new `logPostReaction()` method; the old
  `logVote()` is no longer called from the post-reaction path.

---

### 19. `RateLimiter.checkCommentLimit()` fetched 1000 rows per request

**File:** `src/lib/rate-limit.ts`

```ts
const recentComments = await this.db.getComments({ ip_address: ipAddress, limit: 1000 });
const recentCount = recentComments.filter(c => c.created_at > oneHourAgo).length;
```

This transferred up to 1000 full comment rows over the network on
every single `POST /api/comments` request, then filtered by
timestamp in JS. It also silently mis-counted once an IP had more
than 1000 comments (the oldest would be cut off).

**Fix:** Added `Database.getRecentCommentCountByIp(ip, minutes)`
which runs a single indexed `COUNT(*)` query with a bound cutoff
timestamp. The rate limiter now calls that instead.

---

### 20. Post-reaction toggle relied on fragile error-message string matching

**File:** `src/handlers/reactions.ts`

```ts
try {
  await db.createPostReaction({ ... });
} catch (error: any) {
  if (error.message && error.message.includes('UNIQUE')) {
    // toggle off
  }
  throw error;
}
```

This relies on D1 error messages containing the literal `'UNIQUE'`,
which is not contractually stable across versions. Any other
constraint violation would also be silently swallowed if it happened
to match.

**Fix:** The handler now calls `Database.getPostReaction()` first to
check whether a matching row exists, then explicitly decides between
INSERT and DELETE. No error-message parsing.

---

### 21. `handleBulkUpdateComments` mapped `reject` → `'spam'`

**File:** `src/handlers/admin.ts`

```ts
const statusMap = {
  approve: 'approved',
  reject: 'spam',     // ❌ semantically wrong
  spam: 'spam'
};
```

"Reject" and "mark as spam" are distinct moderation outcomes. The
schema already has a `'deleted'` status, which is what "reject"
should mean (discard from public view without contributing to the
spam-sample training set).

**Fix:** `reject` now maps to `'deleted'`. `spam` still maps to
`'spam'`.

Also fixed the success message — the previous code concatenated
`${action}ed`, producing typos like "approveed" and "deleteed". The
new code uses an explicit verb map.

---

### 22. `handleImportComments` lost all metadata on import

**File:** `src/handlers/admin.ts`, `src/lib/db.ts`

The previous implementation called `createComment()` for each
imported row, which:

1. Always reset the status to `'pending'` (the schema default) —
   losing the original `'approved'` / `'spam'` state.
2. Reassigned a new auto-increment ID, breaking `parent_id`
   references for threaded replies.
3. Reset `created_at` to `CURRENT_TIMESTAMP` — destroying the
   original timestamp.

**Fix:** Added `Database.importComment()` (preserves `status`,
`created_at`, `updated_at`, `ip_address`, `user_agent`, and accepts
a remapped `parent_id`) and `Database.importSubscription()`
(preserves the original `token` so existing unsubscribe links keep
working).

The import handler now:
- Sorts comments by ascending old ID so parents are inserted before
  children.
- Builds an `old_id → new_id` map as it inserts.
- Remaps each child's `parent_id` through the map.
- Also imports `subscriptions` and `settings` blocks of the export
  (the previous implementation silently dropped both).

---

### 23. `handleExportComments` was missing subscriptions

**File:** `src/handlers/admin.ts`

```ts
const comments = await db.getComments({ limit: 10000 });
const subscriptions = await db.getAllSettings();  // ❌ variable named "subscriptions" actually holds SETTINGS
const exportData = { comments, settings: subscriptions, ... };
```

A confusingly-named variable held the SETTINGS object (returned as
`settings`), and real subscription data was never exported. A
round-trip export → import lost every subscription.

**Fix:** The export now explicitly fetches subscriptions via
`getSubscriptionsByPageUrl()` for every page that has comments, and
returns them as `subscriptions` in the export payload. Settings are
returned separately as `settings` (with `admin_password_hash` and
`jwt_secret` stripped).

---

### 24. `handleCreateComment` escaped HTML on input (double-escaping)

**File:** `src/handlers/comments.ts`

```ts
content: escapeHtml(body.content),     // ❌ escapes on input
author_name: escapeHtml(body.author_name),
```

The admin panel ALSO escapes on output (via its own `escapeHtml()`
function), so admins saw `&lt;script&gt;` literally instead of
`<script>` — i.e. double-escaping. Worse, HTML-escaping is an
OUTPUT concern; storing pre-escaped content in the DB is the wrong
layer.

**Fix:** Removed the input-side `escapeHtml()`. Content is now
stored raw. The admin panel already escapes on output, and any
future public widget MUST also escape on output (via `textContent`
or a sanitization library).

---

### 25. `handleCreateComment` issued two queries instead of one

**File:** `src/handlers/comments.ts`, `src/lib/db.ts`

The previous implementation always inserted with the schema default
status (`'pending'`), then issued a SECOND `UPDATE` query to flip
the status to `'approved'` when moderation was off. That's a race
condition (the comment briefly exists as `'pending'` and could be
served by a concurrent read) and an unnecessary extra round-trip.

**Fix:** `Database.createComment()` now accepts an optional `status`
parameter and inserts with the final status in a single statement.

---

### 26. SQL string interpolation for `minutes` in datetime() modifiers

**File:** `src/lib/db.ts`

```ts
WHERE attempted_at > datetime('now', '-${minutes} minutes')
```

While `minutes` happened to always be a number from internal
callers, string-interpolating values into SQL is a well-known
footgun and triggers lint warnings.

**Fix:** Both `getRecentFailedLoginAttempts()` and
`getRecentVoteCount()` now compute the cutoff timestamp in JS
(`new Date(Date.now() - minutes * 60 * 1000).toISOString()`) and
bind it as a parameter.

---

## 🟡 MEDIUM — Code Quality / Hardening

### 27. 404 responses had no CORS headers

**File:** `src/index.ts`

The previous 404 fallthrough returned a bare `Response('Not Found', { status: 404 })`
with no CORS headers. Browser-side `fetch()` calls would see an
opaque network error instead of a readable 404, making debugging
much harder.

**Fix:** All 404 / unknown-path responses now go through `withCors()`
which calls `setCORSHeaders()` with the configured allowed origins.

---

### 28. `handleAdminLogin` didn't set a session cookie

**File:** `src/handlers/admin.ts`

The login response returned the token in JSON only, forcing the
admin frontend to manage localStorage. The `extractAuthToken()`
helper already supported an `admin_token=` cookie, but the server
never set it.

**Fix:** `handleAdminLogin` now also sets a `Set-Cookie` header with
`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`. This
makes the admin panel resistant to XSS-based token theft (HttpOnly
cookies are invisible to JS). Logout clears the cookie with
`Max-Age=0`.

---

### 29. `handleBulkUpdateComments` didn't validate IDs

**File:** `src/handlers/admin.ts`

The previous implementation only checked that `ids` was a non-empty
array. Each element was passed straight into `deleteComment(id)` /
`updateComment(id, ...)`. D1's parameter binding would have caught
SQL injection, but the code still iterated uselessly on garbage
input.

**Fix:** Each ID is now validated as a finite positive integer. A
1000-ID cap prevents abuse. Invalid IDs return a 400 with the
offending value.

---

### 30. No `/api/health` endpoint

**File:** `src/index.ts`

No lightweight liveness probe existed for uptime monitors.

**Fix:** Added `GET /api/health` → `{ ok: true, time: <ISO> }`.
Intentionally does NOT touch the database — for a DB-aware readiness
check, hit `/api/comments?page_url=…` instead.

---

### 31. `getComments()` had no max-limit cap

**File:** `src/lib/db.ts`

If `limit` was not provided, no `LIMIT` clause was added — a single
GET could dump every comment in the database.

**Fix:** Added `PUBLIC_MAX_LIMIT = 100` and `ADMIN_MAX_LIMIT = 1000`
constants. Public queries (`publicMode: true`) always get a LIMIT
even if the caller didn't supply one. Supplied limits are clamped to
the relevant cap.

---

### 32. `threadComments()` silently dropped orphan replies

**File:** `src/lib/utils.ts`

If a reply's `parent_id` referred to a comment that wasn't in the
result set (e.g. parent was deleted, or pagination split them), the
reply silently disappeared from the tree.

**Fix:** Orphan replies are now promoted to root level so they
remain visible in the UI.

---

### 33. Admin panel served without security headers

**File:** `src/index.ts`

The `/admin` response was served with only `Content-Type: text/html`.

**Fix:** Added `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, and `Cache-Control: no-store`.

---

### 34. `compatibility_date` was a future date

**File:** `wrangler.toml`

The original `compatibility_date = "2026-07-04"` was barely valid
(today is 2026-07-05). Left as-is — it's correct.

---

## 📋 Files Modified

| File | Change |
|------|--------|
| `src/lib/utils.ts` | Full rewrite (getClientIp, generateToken, detectSpam, setCORSHeaders, verifyPassword, isValidUrl, threadComments) |
| `src/lib/auth.ts` | Full rewrite (removed jwtSecret dead code, fail-closed password verification, cleaner session validation) |
| `src/lib/db.ts` | Major additions (importComment, importSubscription, getPublicCommentById, getUserVotes, getPostReaction, getSubscriptionToken, getRecentCommentCountByIp, logPostReaction, getRecentPostReactionCount) and parameterized datetime SQL |
| `src/lib/rate-limit.ts` | Full rewrite (COUNT-based comment limit, dedicated post-reaction counter) |
| `src/handlers/comments.ts` | Full rewrite (PII stripping, URL validation, public-status hard-coding, email notifications, single-query create) |
| `src/handlers/reactions.ts` | Full rewrite (multi-reaction toggle, no log-on-removal, SELECT-not-catch for post reactions) |
| `src/handlers/subscriptions.ts` | Full rewrite (admin-only GET, token stripping, idempotent create) |
| `src/handlers/admin.ts` | Full rewrite (settings whitelist, reject=deleted, validated bulk IDs, complete export, metadata-preserving import, Set-Cookie login) |
| `src/handlers/email.ts` | Full rewrite (real subscription-token lookup, render-time HTML escaping, exclude author from subscriber notifications, retry-friendly incrementEmailAttempts) |
| `src/index.ts` | Routing hardening, CORS on 404, /api/health, scheduled handler, security headers on /admin |
| `src/types/index.ts` | Removed JWT_SECRET from Env |
| `wrangler.toml` | Added `[triggers].crons`, updated secrets comment |
| `migrations/schema.sql` | Added `post_reaction_log` table + index |
| `scripts/sanity-check.ts` | NEW — 32 sanity tests for the fixed utilities |

## ✅ Verification

- `npx tsc --noEmit` → **0 errors**
- `npx wrangler deploy --dry-run` → **build succeeds** (111.91 KiB / 23.30 KiB gzip)
- `npx tsx scripts/sanity-check.ts` → **32/32 tests pass**

## ⚠️ Migration Notes for Existing Deployments

If you already have a deployed version of this Worker with a
populated D1 database, you need to apply one schema addition before
deploying the fixed code:

```bash
wrangler d1 execute comments-db --command="
  CREATE TABLE IF NOT EXISTS post_reaction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_post_reaction_log_ip
    ON post_reaction_log(ip_address, created_at);
"
```

Or just re-run the full migration (it's idempotent — every statement
uses `IF NOT EXISTS`):

```bash
npm run d1:migrate
```

No data migration is required. The `vote_log` table is left
untouched (existing rows will age out naturally within 1 hour).

## 📝 Known Limitations / Follow-ups

These are NOT bugs but are worth noting for future work:

1. **Frontend (`comments.js`) uses the old PHP-style `?action=...`
   API contract**, not the new RESTful `/api/...` endpoints. The
   README documents the new API and instructs users to update their
   frontend. The included `comments.js` is the legacy PHP-frontend
   kept for reference. A new frontend would need to be written (or
   `comments.js` updated) to talk to the Worker backend.

2. **Email sending is a stub.** `EmailService.sendEmail()` returns
   `true` without actually sending when `EMAIL_API_KEY` is set.
   Uncomment the Resend integration block (or plug in your provider
   of choice — SendGrid, Mailgun, AWS SES, Cloudflare Email Routing).

3. **No per-email rate limiting.** A single popular comment could
   enqueue thousands of subscriber notifications. The cron-triggered
   queue processor handles this gracefully (50 emails / 5 minutes),
   but a viral page could still take hours to drain. Consider adding
   per-recipient digesting in the future.

4. **`ADMIN_PASSWORD_HASH` uses plain SHA-256.** This is fine for a
   single admin password, but bcrypt/argon2 would be more robust
   against offline brute-force if the hash ever leaks. The Cloudflare
   Workers runtime doesn't natively support bcrypt, but the
   `@noble/hashes` package or a Wasm-compiled bcrypt would work.
