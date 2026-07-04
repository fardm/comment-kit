// Script to insert admin panel HTML into D1 database
// Run with: node scripts/setup-admin-panel.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const htmlPath = path.join(__dirname, '..', 'public', 'admin.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

// Escape single quotes for SQL by doubling them
const escapedHtml = htmlContent.replace(/'/g, "''");

const sql = `INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_html', '${escapedHtml}');`;

console.log('Inserting admin panel HTML into D1 database...');
console.log('HTML length:', htmlContent.length);

try {
  execSync(`npx wrangler d1 execute comments-db --remote --command="${sql}"`, {
    stdio: 'inherit'
  });
  console.log('\n✓ Admin panel HTML inserted successfully!');
} catch (error) {
  console.error('\n✗ Failed to insert admin panel HTML:', error.message);
  process.exit(1);
}
