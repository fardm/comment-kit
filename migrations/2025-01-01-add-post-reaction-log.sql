-- Migration: post_reaction_log table
-- Apply this migration to existing comment-kit deployments that were
-- created BEFORE the post_reaction_log table was added to schema.sql.
--
-- Run with:
--   wrangler d1 execute comments-db --file=./migrations/2025-01-01-add-post-reaction-log.sql
-- or
--   npm run d1:migrate   (re-runs the full idempotent schema.sql)

-- The dedicated post_reaction_log table keeps the per-IP rate limit for
-- post-level reactions INDEPENDENT from the comment-vote rate limit.
-- Without this table, the rate-limiter will throw on every post-reaction
-- request and the backend will return a 500 error (which browsers
-- report as a CORS error because the 500 response has no CORS headers).
CREATE TABLE IF NOT EXISTS post_reaction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_reaction_log_ip ON post_reaction_log(ip_address, created_at);
