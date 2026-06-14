<?php

// Define the base URL where the comment system is installed. Do not include a trailing slash.
define('APP_URL', 'https://example.com/comments');

// Add your domain
define('ALLOWED_ORIGINS', [
    'https://example.com'
]);

// Set timezone
date_default_timezone_set('Asia/Tehran');