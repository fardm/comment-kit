English | [فارسی](https://github.com/fardm/standalone-comments-server/blob/main/README-fa.md)

# Quartz Standalone Comments

This project adds a commenting system to [Quartz](https://quartz.jzhao.xyz/). The original repository can be found here: https://github.com/dlnorman/standalone-comments.

 I made several modifications to improve compatibility and usability for Quartz websites.

## Features

![image](comments.webp)

- Reactions with 10 emoji options for both posts and comments
- Admin panel for viewing and managing comments
- Data import and export support
- Email notifications for new comments

<br>

## Installation

It is recommended to use PHP 8.0 or newer. Although the original project claims support for PHP 7.4, I encountered errors with PHP 8.1. The issues were resolved after upgrading to PHP 8.3.

### Step 1: Install on Your Server

1. Get a shared hosting account and create a subdomain, for example: `comments.yourdomain.com`.
2. Download this repository by clicking the green **Code** button and selecting **Download ZIP**.
3. Upload the ZIP file to your hosting account's `public_html` directory and extract it.
4. Edit the `config.php` file:
   - Set `APP_URL` to the subdomain where you uploaded the files, for example: `comments.yourdomain.com`
   - Set `ALLOWED_ORIGINS` to your Quartz website domain, for example: `yourdomain.com`
5. Open `set-password.php` in your browser:

   ```
   https://comments.yourdomain.com/set-password.php
   ```

6. Choose an admin password.
7. Open the admin panel:

   ```
   https://comments.yourdomain.com/admin.html
   ```

8. Enter the password you selected and log in.

After successfully logging in, delete the `set-password.php` file from your `public_html` directory.

### Step 2: Install the Quartz Plugin

Run the following command inside your Quartz project:

```bash
npx quartz plugin add github:fardm/quartz-standalone-comments
```

Once installed, open the `quartz.config.yaml` file and configure the plugin. Set `backendUrl` to the URL of the server where you uploaded the comment system:

```yaml
- source: github:fardm/quartz-standalone-comments
  enabled: true
  options:
    backendUrl: https://comments.yourdomain.com
  layout:
    position: afterBody
    priority: 100
```

Start the local preview server:

```bash
npx quartz build --serve
```

You should now see the comment section at the bottom of your pages.

Keep in mind that this is only a local preview. Since the site is running locally, reactions and comments will not be stored in the database.

Deploy and sync your site using:

```bash
npx quartz sync
```

After deployment, visit your website and test both comments and reactions.

<br>

## Enable Email Notifications

1. Open your hosting control panel and navigate to **Cron Jobs**.
2. Add the following command:

```bash
php /home/username/public_html/comments/utils/process-email-queue.php
```

3. Open the comment system admin panel.
4. Go to **Utilities** and enable **Email Notifications**.
5. Enter your email address in the **Admin Email** field and save the settings.
6. Create a few test comments to verify everything is working correctly.

You can also send a test email from the **Test Email** section in the admin panel.

<br>

## My Modifications

Summary of the changes I made to the original project:

- Persian localization of the interface
- Jalali (Persian) date support
- Improved styling and UI
- Dark mode for the admin panel
- Redesigned emoji reactions (the original version only included four Disqus-style reactions; this version provides a wider GitHub-style emoji selection)
- Formatting help displayed inside the comment editor

<br>

## Security

To reduce spam and abuse, the system includes several protection layers:

- Honeypot protection to detect and block bots
- Rate limiting
- Automatic IP blocking after multiple failed login attempts in the admin panel

<br>

## Roadmap

- [ ] Multi-language support (currently the interface is Persian-only; English and language switching will be added)
- [ ] Complete export support for spam data and subscriptions
- [ ] Refactor naming conventions and functions; the project structure is no longer closely tied to Disqus
- [ ] Fix the import issue that causes user IP addresses to appear as `N/A` in the **All Comments** page
- [ ] One-click database reset from the admin panel
- [ ] Fix the **Last Reaction** display issue on mobile devices