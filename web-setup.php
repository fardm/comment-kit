<?php
require_once 'config.php';
require_once 'database.php';

$message = '';
$error = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $password = trim($_POST['password'] ?? '');
    $confirm  = trim($_POST['confirm_password'] ?? '');

    if ($password === '') {
        $error = 'Password cannot be empty.';
    } elseif (strlen($password) < 8) {
        $error = 'Password must be at least 8 characters.';
    } elseif ($password !== $confirm) {
        $error = 'Passwords do not match.';
    } else {
        $hash = password_hash($password, PASSWORD_DEFAULT);

        $db = getDatabase();
        if (!$db) {
            $error = 'Could not connect to database.';
        } else {
            $stmt = $db->prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', ?)");
            $stmt->execute([$hash]);

            $stmt = $db->prepare("DELETE FROM settings WHERE key = 'admin_token'");
            $stmt->execute();

            $message = 'Password updated successfully!';
        }
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Set Admin Password</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background: #f4f6f8;
            margin: 0;
            padding: 40px;
        }
        .container {
            max-width: 420px;
            margin: 0 auto;
            background: #fff;
            padding: 24px;
            border-radius: 10px;
            box-shadow: 0 4px 18px rgba(0,0,0,0.08);
        }
        h2 {
            margin-top: 0;
            text-align: center;
        }
        label {
            display: block;
            margin-top: 14px;
            margin-bottom: 6px;
            font-weight: bold;
        }
        .password-wrapper {
            position: relative;
        }
        input[type="password"],
        input[type="text"] {
            width: 100%;
            padding: 10px 90px 10px 10px;
            border: 1px solid #ccc;
            border-radius: 6px;
            box-sizing: border-box;
        }
        .toggle-btn {
            position: absolute;
            top: 50%;
            right: 8px;
            transform: translateY(-50%);
            border: 0;
            background: #e9ecef;
            color: #333;
            padding: 6px 10px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
        }
        .toggle-btn:hover {
            background: #d6dbe0;
        }
        .submit-btn {
            width: 100%;
            margin-top: 18px;
            padding: 12px;
            border: 0;
            background: #007bff;
            color: #fff;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
        }
        .submit-btn:hover {
            background: #0056b3;
        }
        .success {
            color: green;
            margin-bottom: 15px;
            font-weight: bold;
        }
        .error {
            color: red;
            margin-bottom: 15px;
            font-weight: bold;
        }
        .warning {
            margin-top: 20px;
            color: #b26a00;
            font-size: 14px;
            background: #fff3cd;
            padding: 10px;
            border-radius: 6px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>Set Admin Password</h2>

        <?php if ($message): ?>
            <div class="success">✓ <?php echo htmlspecialchars($message); ?></div>
        <?php endif; ?>

        <?php if ($error): ?>
            <div class="error">✗ <?php echo htmlspecialchars($error); ?></div>
        <?php endif; ?>

        <form method="post">
            <label for="password">New Password</label>
            <div class="password-wrapper">
                <input type="password" name="password" id="password" required>
                <button type="button" class="toggle-btn" onclick="togglePassword('password', this)">Show</button>
            </div>

            <label for="confirm_password">Confirm Password</label>
            <div class="password-wrapper">
                <input type="password" name="confirm_password" id="confirm_password" required>
                <button type="button" class="toggle-btn" onclick="togglePassword('confirm_password', this)">Show</button>
            </div>

            <button type="submit" class="submit-btn">Save Password</button>
        </form>

        <div class="warning">
            <b>Security Warning:</b> After setting the password, delete this file immediately from your host.
        </div>
    </div>

    <script>
        function togglePassword(inputId, button) {
            const input = document.getElementById(inputId);
            if (input.type === 'password') {
                input.type = 'text';
                button.textContent = 'Hide';
            } else {
                input.type = 'password';
                button.textContent = 'Show';
            }
        }
    </script>
</body>
</html>
