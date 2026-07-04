# Standalone Comments Server - Cloudflare Workers + D1

A fully-featured, serverless comments system built with Cloudflare Workers, TypeScript, and Cloudflare D1 (SQLite). This is a complete refactor of the original PHP-based system, offering better performance, scalability, and zero infrastructure maintenance.

## Features

### Public Features
- ✅ **Create comments** with author name, email, and optional website URL
- ✅ **Fetch comments by page** with pagination support
- ✅ **Threaded replies** (nested comments with unlimited depth)
- ✅ **Emoji reactions** (heart, thumbs up/down, laugh, cry, fire, clap)
- ✅ **Post-level reactions** (react to pages without commenting)
- ✅ **Email subscriptions** (subscribe to comment notifications per page)
- ✅ **Automatic spam detection** with keyword and pattern filtering

### Admin Panel
- ✅ **Authentication** with secure session management
- ✅ **Comment moderation** (approve, reject, mark as spam)
- ✅ **Bulk actions** (approve/reject/delete multiple comments)
- ✅ **View all comments** with filters (pending, approved, spam)
- ✅ **Analytics dashboard** with engagement metrics
- ✅ **Settings management** (moderation, limits, notifications)
- ✅ **Import/Export** comments in JSON format

### Security
- ✅ **Rate limiting** (comments, votes, reactions)
- ✅ **Spam protection** (keyword detection, link limits, caps ratio)
- ✅ **Brute force protection** (login attempt limiting)
- ✅ **Session management** with automatic expiration
- ✅ **CORS support** for cross-origin requests

### Architecture
- ✅ **Fully serverless** - no servers to manage
- ✅ **Cloudflare D1** - SQLite database at the edge
- ✅ **TypeScript** - type-safe codebase
- ✅ **Modular structure** - separated handlers and utilities
- ✅ **RESTful API** - clean, predictable endpoints

## Installation

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Cloudflare account with Workers and D1 enabled
- Wrangler CLI (`npm install -g wrangler`)

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Configure Wrangler

Edit `wrangler.toml` and update the following:

```toml
name = "standalone-comments-server"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "comments-db"
database_id = "your-database-id"  # Replace after creation

[vars]
APP_URL = "https://comments.yourdomain.com"
ALLOWED_ORIGINS = "https://yourdomain.com"
APP_LANGUAGE = "en"
SESSION_LIFETIME = "2592000"
```

### Step 3: Create D1 Database

```bash
# Create the database
wrangler d1 create comments-db

# Copy the database ID from the output and update wrangler.toml
```

### Step 4: Run Database Migration

```bash
# For local development
npm run d1:migrate-local

# For production
npm run d1:migrate
```

### Step 5: Set Secrets

```bash
# Generate SHA-256 hash of your password (Linux/Mac):
echo -n "your-password" | sha256sum

# Or use an online SHA-256 generator

# Set admin password hash
wrangler secret put ADMIN_PASSWORD_HASH
# Paste the hash when prompted

# Set JWT secret (use a random 32+ character string)
wrangler secret put JWT_SECRET

# Optional: Set email API key for notifications
wrangler secret put EMAIL_API_KEY
```

### Step 6: Deploy

```bash
# Deploy to Cloudflare Workers
npm run deploy
```

### Step 7: Access Admin Panel

1. Visit `https://your-worker-url/admin` (or your custom domain)
2. Login with the password you set
3. Configure settings in the admin panel

**Note:** The admin panel HTML is now served directly from the worker code, so no database configuration is needed.

## API Endpoints

### Public API

#### Get Comments
```
GET /api/comments?page_url={url}&status={pending|approved|spam}&sort={asc|desc}
```

#### Create Comment
```
POST /api/comments
Content-Type: application/json

{
  "page_url": "https://example.com/page",
  "parent_id": null,
  "author_name": "John Doe",
  "author_email": "john@example.com",
  "author_url": "https://example.com",
  "content": "Great article!"
}
```

#### Vote on Comment
```
POST /api/vote
Content-Type: application/json

{
  "comment_id": 123,
  "reaction_type": "heart"
}
```

#### React to Post
```
POST /api/post-reaction
Content-Type: application/json

{
  "page_url": "https://example.com/page",
  "reaction_type": "heart"
}
```

#### Subscribe to Page
```
POST /api/subscribe
Content-Type: application/json

{
  "page_url": "https://example.com/page",
  "email": "user@example.com"
}
```

#### Unsubscribe
```
GET /api/unsubscribe?token={token}
```

### Admin API

All admin endpoints require authentication via Bearer token or cookie.

#### Login
```
POST /api/admin/login
Content-Type: application/json

{
  "password": "your-password"
}
```

#### Get All Comments
```
GET /api/admin/comments?status={pending|approved|spam}&page_url={url}&limit=50&offset=0
Authorization: Bearer {token}
```

#### Update Comment
```
PUT /api/admin/comment?id={id}
Authorization: Bearer {token}
Content-Type: application/json

{
  "status": "approved",
  "content": "Updated content"
}
```

#### Delete Comment
```
DELETE /api/admin/comment?id={id}
Authorization: Bearer {token}
```

#### Bulk Update
```
POST /api/admin/comments/bulk
Authorization: Bearer {token}
Content-Type: application/json

{
  "ids": [1, 2, 3],
  "action": "approve"  // approve, reject, spam, delete
}
```

#### Get Analytics
```
GET /api/admin/analytics
Authorization: Bearer {token}
```

#### Get Settings
```
GET /api/admin/settings
Authorization: Bearer {token}
```

#### Update Settings
```
PUT /api/admin/settings
Authorization: Bearer {token}
Content-Type: application/json

{
  "require_moderation": true,
  "allow_guest_comments": true,
  "max_comment_length": 5000,
  "comment_sort_order": "asc",
  "admin_email": "admin@example.com"
}
```

#### Export Comments
```
GET /api/admin/export
Authorization: Bearer {token}
```

#### Import Comments
```
POST /api/admin/import
Authorization: Bearer {token}
Content-Type: application/json

{
  "comments": [...],
  "settings": {...}
}
```

## Database Schema

The system uses Cloudflare D1 (SQLite) with the following tables:

- **comments** - Stores all comments with threading support
- **votes** - Stores emoji reactions on comments
- **post_reactions** - Stores page-level emoji reactions
- **subscriptions** - Stores email subscriptions per page
- **email_queue** - Queue for asynchronous email delivery
- **sessions** - Admin session management
- **login_attempts** - Brute force protection tracking
- **vote_log** - Rate limiting for votes
- **settings** - System configuration

See `migrations/schema.sql` for the complete schema.

## Development

### Local Development

```bash
# Start local development server
npm run dev

# Run with local D1 database
wrangler dev --local
```

### Type Checking

```bash
npm run type-check
```

### Testing

```bash
npm run test
```

## Email Notifications

The system includes an email queue for asynchronous notifications. To enable email delivery:

1. Set `EMAIL_API_KEY` secret with your email service API key
2. Enable notifications in admin settings
3. Configure admin email address
4. Set up a Cloudflare Cron Trigger to process the queue (coming soon)

Supported email providers (via API integration):
- Resend
- SendGrid
- Mailgun
- AWS SES
- Cloudflare Email Routing

## Migration from PHP Version

If you're migrating from the original PHP version:

1. Export your existing data using the PHP admin panel
2. Import the JSON file using the new admin panel
3. Update your frontend to use the new API endpoints
4. Deploy the Cloudflare Worker
5. Update DNS to point to the Worker

## Configuration

### Custom Domain Setup

To use a custom domain for your comments server:

1. **Add Custom Domain in Cloudflare Dashboard:**
   - Go to your Cloudflare Workers dashboard
   - Select your worker
   - Click "Settings" → "Triggers" → "Custom Domains"
   - Click "Add Custom Domain"
   - Enter your domain (e.g., `comments.yourdomain.com`)
   - Follow the DNS instructions to add the CNAME record

2. **Update APP_URL in wrangler.toml:**
   ```toml
   [vars]
   APP_URL = "https://comments.yourdomain.com"
   ALLOWED_ORIGINS = "https://yourdomain.com,https://www.yourdomain.com"
   ```

3. **Deploy with new configuration:**
   ```bash
   npm run deploy
   ```

4. **Update ALLOWED_ORIGINS:**
   - Add all domains that will embed the comments widget
   - Use comma-separated values
   - Use `*` to allow all origins (not recommended for production)

**Why APP_URL matters:**
- Used in email notifications for unsubscribe links
- Referenced in admin panel for API calls
- Ensures correct absolute URLs are generated
- Required for CORS to work correctly with your custom domain

### Environment Variables

Set in `wrangler.toml` or as secrets:

- `APP_URL` - Base URL of the comment system
- `ALLOWED_ORIGINS` - Comma-separated list of allowed CORS origins
- `APP_LANGUAGE` - Default language (en, fa, etc.)
- `SESSION_LIFETIME` - Session lifetime in seconds (default: 2592000)
- `ADMIN_PASSWORD_HASH` - SHA-256 hash of admin password (secret)
- `JWT_SECRET` - Secret for session tokens (secret)
- `EMAIL_API_KEY` - Email service API key (secret, optional)

### Rate Limits

Default rate limits (configurable in code):

- Comments: 5 per hour per IP
- Votes: 20 per hour per IP
- Post reactions: 10 per hour per IP
- Login attempts: 5 failed attempts per 15 minutes

## Security Considerations

- Always use HTTPS in production
- Set strong admin passwords
- Keep secrets secure (never commit to git)
- Enable moderation for public-facing sites
- Monitor the admin panel for spam
- Regularly backup your D1 database

## Backup and Restore

### Backup

```bash
# Production backup
npm run d1:backup

# Local backup
npm run d1:backup-local
```

### Restore

```bash
# Restore from SQL file
wrangler d1 execute comments-db --file=backup.sql
```

## Performance

Cloudflare Workers + D1 provides:

- **Global edge deployment** - Low latency worldwide
- **Automatic scaling** - No capacity planning needed
- **Zero cold starts** - Fast response times
- **Built-in caching** - D1 includes query caching
- **DDoS protection** - Cloudflare's edge security

## License

MIT

## Support

For issues and questions:
- Open an issue on GitHub
- Check the documentation
- Review the API endpoints above

## Acknowledgments

This is a complete refactor of the original PHP-based standalone-comments-server, adapted for Cloudflare's serverless platform while maintaining feature parity and adding modern improvements.