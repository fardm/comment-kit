<?php

// Define the base URL where the comment system is installed.
// Do not include a trailing slash.
// Example: 'https://example.com/comments'
define('APP_URL', 'https://example.com/comments');

// Add your domain
define('ALLOWED_ORIGINS', [
    'https://example.com',
    'http://localhost:8080'
]);

// Set timezone
date_default_timezone_set('Asia/Tehran');