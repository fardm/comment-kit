-- Insert admin panel HTML into settings table
-- Run this with: wrangler d1 execute comments-db --remote --file=scripts/setup-admin-panel.sql

INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_html', '<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Comments Admin Panel</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #f5f5f5;
      color: #333;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }

    .login-screen {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }

    .login-box {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      width: 100%;
      max-width: 400px;
    }

    .login-box h1 {
      margin-bottom: 20px;
      color: #333;
    }

    .form-group {
      margin-bottom: 20px;
    }

    .form-group label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
    }

    .form-group input {
      width: 100%;
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 16px;
    }

    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 500;
      transition: background 0.2s;
    }

    .btn-primary {
      background: #667eea;
      color: white;
      width: 100%;
    }

    .btn-primary:hover {
      background: #5568d3;
    }

    .btn-danger {
      background: #e74c3c;
      color: white;
    }

    .btn-success {
      background: #27ae60;
      color: white;
    }

    .btn-secondary {
      background: #95a5a6;
      color: white;
    }

    .admin-panel {
      display: none;
    }

    .admin-panel.active {
      display: block;
    }

    .header {
      background: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .nav-tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }

    .nav-tab {
      padding: 10px 20px;
      background: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
    }

    .nav-tab.active {
      background: #667eea;
      color: white;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }

    .stat-card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .stat-card h3 {
      font-size: 14px;
      color: #666;
      margin-bottom: 10px;
    }

    .stat-card .value {
      font-size: 32px;
      font-weight: bold;
      color: #333;
    }

    .comments-table {
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .comments-table table {
      width: 100%;
      border-collapse: collapse;
    }

    .comments-table th,
    .comments-table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }

    .comments-table th {
      background: #f8f9fa;
      font-weight: 600;
    }

    .status-badge {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-pending {
      background: #fff3cd;
      color: #856404;
    }

    .status-approved {
      background: #d4edda;
      color: #155724;
    }

    .status-spam {
      background: #f8d7da;
      color: #721c24;
    }

    .comment-content {
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .actions {
      display: flex;
      gap: 8px;
    }

    .actions button {
      padding: 6px 12px;
      font-size: 12px;
    }

    .filter-bar {
      background: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .filter-bar select,
    .filter-bar input {
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
    }

    .pagination {
      display: flex;
      justify-content: center;
      gap: 10px;
      margin-top: 20px;
    }

    .pagination button {
      padding: 8px 16px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 4px;
      cursor: pointer;
    }

    .pagination button.active {
      background: #667eea;
      color: white;
      border-color: #667eea;
    }

    .settings-form {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .settings-form .form-group {
      margin-bottom: 20px;
    }

    .settings-form label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
    }

    .settings-form input,
    .settings-form select {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
    }

    .settings-form .checkbox-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .settings-form input[type="checkbox"] {
      width: auto;
    }

    .error {
      color: #e74c3c;
      padding: 10px;
      background: #fdeaea;
      border-radius: 4px;
      margin-bottom: 20px;
    }

    .success {
      color: #27ae60;
      padding: 10px;
      background: #d4edda;
      border-radius: 4px;
      margin-bottom: 20px;
    }

    .loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }

    @media (max-width: 768px) {
      .container {
        padding: 10px;
      }

      .header {
        flex-direction: column;
        gap: 10px;
      }

      .nav-tabs {
        flex-wrap: wrap;
      }

      .stats-grid {
        grid-template-columns: 1fr;
      }

      .comments-table {
        overflow-x: auto;
      }
    }
  </style>
</head>
<body>
  <!-- Login Screen -->
  <div id="loginScreen" class="login-screen">
    <div class="login-box">
      <h1>Admin Login</h1>
      <div id="loginError" class="error" style="display: none;"></div>
      <form id="loginForm">
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required>
        </div>
        <button type="submit" class="btn btn-primary">Login</button>
      </form>
    </div>
  </div>

  <!-- Admin Panel -->
  <div id="adminPanel" class="admin-panel">
    <div class="container">
      <div class="header">
        <h1>Comments Admin</h1>
        <button id="logoutBtn" class="btn btn-secondary">Logout</button>
      </div>

      <div class="nav-tabs">
        <button class="nav-tab active" data-tab="comments">Comments</button>
        <button class="nav-tab" data-tab="analytics">Analytics</button>
        <button class="nav-tab" data-tab="settings">Settings</button>
        <button class="nav-tab" data-tab="import-export">Import/Export</button>
      </div>

      <!-- Comments Tab -->
      <div id="commentsTab" class="tab-content active">
        <div class="filter-bar">
          <select id="statusFilter">
            <option value="">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="spam">Spam</option>
          </select>
          <input type="text" id="pageUrlFilter" placeholder="Filter by page URL">
          <button id="applyFilter" class="btn btn-primary">Apply Filter</button>
        </div>

        <div id="commentsContainer">
          <div class="loading">Loading comments...</div>
        </div>

        <div id="pagination" class="pagination"></div>
      </div>

      <!-- Analytics Tab -->
      <div id="analyticsTab" class="tab-content">
        <div class="stats-grid">
          <div class="stat-card">
            <h3>Total Comments</h3>
            <div class="value" id="totalComments">0</div>
          </div>
          <div class="stat-card">
            <h3>Approved</h3>
            <div class="value" id="approvedComments">0</div>
          </div>
          <div class="stat-card">
            <h3>Pending</h3>
            <div class="value" id="pendingComments">0</div>
          </div>
          <div class="stat-card">
            <h3>Spam</h3>
            <div class="value" id="spamComments">0</div>
          </div>
          <div class="stat-card">
            <h3>Total Reactions</h3>
            <div class="value" id="totalReactions">0</div>
          </div>
          <div class="stat-card">
            <h3>Subscribers</h3>
            <div class="value" id="totalSubscribers">0</div>
          </div>
        </div>

        <h2>Comments by Page</h2>
        <div id="commentsByPage" class="comments-table">
          <div class="loading">Loading analytics...</div>
        </div>
      </div>

      <!-- Settings Tab -->
      <div id="settingsTab" class="tab-content">
        <div class="settings-form">
          <h2>Settings</h2>
          <div id="settingsMessage"></div>
          <form id="settingsForm">
            <div class="form-group">
              <label for="requireModeration">Require Moderation</label>
              <div class="checkbox-group">
                <input type="checkbox" id="requireModeration" name="require_moderation">
                <span>Comments require manual approval before being published</span>
              </div>
            </div>
            <div class="form-group">
              <label for="allowGuestComments">Allow Guest Comments</label>
              <div class="checkbox-group">
                <input type="checkbox" id="allowGuestComments" name="allow_guest_comments">
                <span>Allow users to comment without logging in</span>
              </div>
            </div>
            <div class="form-group">
              <label for="maxCommentLength">Max Comment Length</label>
              <input type="number" id="maxCommentLength" name="max_comment_length" min="100" max="10000">
            </div>
            <div class="form-group">
              <label for="commentSortOrder">Comment Sort Order</label>
              <select id="commentSortOrder" name="comment_sort_order">
                <option value="asc">Oldest First</option>
                <option value="desc">Newest First</option>
              </select>
            </div>
            <div class="form-group">
              <label for="adminEmail">Admin Email</label>
              <input type="email" id="adminEmail" name="admin_email">
            </div>
            <button type="submit" class="btn btn-primary">Save Settings</button>
          </form>
        </div>
      </div>

      <!-- Import/Export Tab -->
      <div id="import-exportTab" class="tab-content">
        <div class="settings-form">
          <h2>Export Comments</h2>
          <p>Export all comments and settings to JSON format.</p>
          <button id="exportBtn" class="btn btn-primary">Export</button>

          <h2 style="margin-top: 40px;">Import Comments</h2>
          <p>Import comments from a JSON file.</p>
          <input type="file" id="importFile" accept=".json">
          <button id="importBtn" class="btn btn-secondary">Import</button>
          <div id="importMessage"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = ''/api/admin'';
    let authToken = localStorage.getItem(''adminToken'');
    let currentPage = 0;
    const pageSize = 50;

    // Check authentication on load
    if (authToken) {
      verifyToken();
    }

    // Login form
    document.getElementById(''loginForm'').addEventListener(''submit'', async (e) => {
      e.preventDefault();
      const password = document.getElementById(''password'').value;
      
      try {
        const response = await fetch(`${API_BASE}/login`, {
          method: ''POST'',
          headers: { ''Content-Type'': ''application/json'' },
          body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          authToken = data.token;
          localStorage.setItem(''adminToken'', authToken);
          showAdminPanel();
        } else {
          showError(data.error || ''Login failed'');
        }
      } catch (error) {
        showError(''Network error'');
      }
    });

    // Logout
    document.getElementById(''logoutBtn'').addEventListener(''click'', async () => {
      try {
        await fetch(`${API_BASE}/logout`, {
          method: ''POST'',
          headers: { ''Authorization'': `Bearer ${authToken}` }
        });
      } catch (error) {
        console.error(''Logout error:'', error);
      }
      
      authToken = null;
      localStorage.removeItem(''adminToken'');
      showLoginScreen();
    });

    // Tab navigation
    document.querySelectorAll(''.nav-tab'').forEach(tab => {
      tab.addEventListener(''click'', () => {
        document.querySelectorAll(''.nav-tab'').forEach(t => t.classList.remove(''active''));
        document.querySelectorAll(''.tab-content'').forEach(c => c.classList.remove(''active''));
        
        tab.classList.add(''active'');
        document.getElementById(`${tab.dataset.tab}Tab`).classList.add(''active'');
        
        if (tab.dataset.tab === ''comments'') loadComments();
        if (tab.dataset.tab === ''analytics'') loadAnalytics();
        if (tab.dataset.tab === ''settings'') loadSettings();
      });
    });

    // Filter comments
    document.getElementById(''applyFilter'').addEventListener(''click'', () => {
      currentPage = 0;
      loadComments();
    });

    // Settings form
    document.getElementById(''settingsForm'').addEventListener(''submit'', async (e) => {
      e.preventDefault();
      
      const settings = {
        require_moderation: document.getElementById(''requireModeration'').checked,
        allow_guest_comments: document.getElementById(''allowGuestComments'').checked,
        max_comment_length: document.getElementById(''maxCommentLength'').value,
        comment_sort_order: document.getElementById(''commentSortOrder'').value,
        admin_email: document.getElementById(''adminEmail'').value
      };
      
      try {
        const response = await fetch(`${API_BASE}/settings`, {
          method: ''PUT'',
          headers: {
            ''Content-Type'': ''application/json'',
            ''Authorization'': `Bearer ${authToken}`
          },
          body: JSON.stringify(settings)
        });
        
        if (response.ok) {
          showMessage(''Settings saved successfully'', ''success'');
        } else {
          showMessage(''Failed to save settings'', ''error'');
        }
      } catch (error) {
        showMessage(''Network error'', ''error'');
      }
    });

    // Export
    document.getElementById(''exportBtn'').addEventListener(''click'', async () => {
      try {
        const response = await fetch(`${API_BASE}/export`, {
          headers: { ''Authorization'': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
          const data = await response.json();
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: ''application/json'' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement(''a'');
          a.href = url;
          a.download = `comments-export-${new Date().toISOString().split(''T'')[0]}.json`;
          a.click();
          URL.revokeObjectURL(url);
        } else {
          showMessage(''Export failed'', ''error'');
        }
      } catch (error) {
        showMessage(''Network error'', ''error'');
      }
    });

    // Import
    document.getElementById(''importBtn'').addEventListener(''click'', async () => {
      const fileInput = document.getElementById(''importFile'');
      const file = fileInput.files[0];
      
      if (!file) {
        showMessage(''Please select a file'', ''error'');
        return;
      }
      
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        const response = await fetch(`${API_BASE}/import`, {
          method: ''POST'',
          headers: {
            ''Content-Type'': ''application/json'',
            ''Authorization'': `Bearer ${authToken}`
          },
          body: JSON.stringify(data)
        });
        
        const result = await response.json();
        
        if (response.ok) {
          showMessage(result.message, ''success'');
        } else {
          showMessage(result.error || ''Import failed'', ''error'');
        }
      } catch (error) {
        showMessage(''Invalid file format'', ''error'');
      }
    });

    async function verifyToken() {
      try {
        const response = await fetch(`${API_BASE}/verify`, {
          headers: { ''Authorization'': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
          showAdminPanel();
        } else {
          showLoginScreen();
        }
      } catch (error) {
        showLoginScreen();
      }
    }

    function showAdminPanel() {
      document.getElementById(''loginScreen'').style.display = ''none'';
      document.getElementById(''adminPanel'').classList.add(''active'');
      loadComments();
    }

    function showLoginScreen() {
      document.getElementById(''loginScreen'').style.display = ''flex'';
      document.getElementById(''adminPanel'').classList.remove(''active'');
    }

    function showError(message) {
      const errorDiv = document.getElementById(''loginError'');
      errorDiv.textContent = message;
      errorDiv.style.display = ''block'';
    }

    function showMessage(message, type) {
      const messageDiv = document.getElementById(''settingsMessage'');
      messageDiv.textContent = message;
      messageDiv.className = type;
      messageDiv.style.display = ''block'';
      setTimeout(() => messageDiv.style.display = ''none'', 3000);
    }

    async function loadComments() {
      const status = document.getElementById(''statusFilter'').value;
      const pageUrl = document.getElementById(''pageUrlFilter'').value;
      
      const params = new URLSearchParams({
        limit: pageSize,
        offset: currentPage * pageSize
      });
      
      if (status) params.append(''status'', status);
      if (pageUrl) params.append(''page_url'', pageUrl);
      
      try {
        const response = await fetch(`${API_BASE}/comments?${params}`, {
          headers: { ''Authorization'': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        
        if (response.ok) {
          renderComments(data.comments);
          renderPagination(data.total);
        } else {
          document.getElementById(''commentsContainer'').innerHTML = ''<div class="error">Failed to load comments</div>'';
        }
      } catch (error) {
        document.getElementById(''commentsContainer'').innerHTML = ''<div class="error">Network error</div>'';
      }
    }

    function renderComments(comments) {
      const container = document.getElementById(''commentsContainer'');
      
      if (comments.length === 0) {
        container.innerHTML = ''<div style="padding: 40px; text-align: center; color: #666;">No comments found</div>'';
        return;
      }
      
      container.innerHTML = `
        <div class="comments-table">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Author</th>
                <th>Content</th>
                <th>Page</th>
                <th>Status</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${comments.map(comment => `
                <tr>
                  <td>${comment.id}</td>
                  <td>${escapeHtml(comment.author_name)}</td>
                  <td class="comment-content">${escapeHtml(comment.content)}</td>
                  <td class="comment-content">${escapeHtml(comment.page_url)}</td>
                  <td><span class="status-badge status-${comment.status}">${comment.status}</span></td>
                  <td>${new Date(comment.created_at).toLocaleDateString()}</td>
                  <td class="actions">
                    ${comment.status === ''pending'' ? `
                      <button onclick="updateComment(${comment.id}, ''approved'')" class="btn btn-success">Approve</button>
                      <button onclick="updateComment(${comment.id}, ''spam'')" class="btn btn-danger">Spam</button>
                    ` : ''}
                    <button onclick="deleteComment(${comment.id})" class="btn btn-danger">Delete</button>
                  </td>
                </tr>
              `).join('''')}
            </tbody>
          </table>
        </div>
      `;
    }

    function renderPagination(total) {
      const totalPages = Math.ceil(total / pageSize);
      const pagination = document.getElementById(''pagination'');
      
      if (totalPages <= 1) {
        pagination.innerHTML = '''';
        return;
      }
      
      let html = '''';
      
      if (currentPage > 0) {
        html += `<button onclick="goToPage(${currentPage - 1})">Previous</button>`;
      }
      
      for (let i = 0; i < totalPages; i++) {
        html += `<button onclick="goToPage(${i})" ${i === currentPage ? ''class="active"'' : ''''}>${i + 1}</button>`;
      }
      
      if (currentPage < totalPages - 1) {
        html += `<button onclick="goToPage(${currentPage + 1})">Next</button>`;
      }
      
      pagination.innerHTML = html;
    }

    function goToPage(page) {
      currentPage = page;
      loadComments();
    }

    async function updateComment(id, status) {
      try {
        const response = await fetch(`${API_BASE}/comment?id=${id}`, {
          method: ''PUT'',
          headers: {
            ''Content-Type'': ''application/json'',
            ''Authorization'': `Bearer ${authToken}`
          },
          body: JSON.stringify({ status })
        });
        
        if (response.ok) {
          loadComments();
        } else {
          alert(''Failed to update comment'');
        }
      } catch (error) {
        alert(''Network error'');
      }
    }

    async function deleteComment(id) {
      if (!confirm(''Are you sure you want to delete this comment?'')) return;
      
      try {
        const response = await fetch(`${API_BASE}/comment?id=${id}`, {
          method: ''DELETE'',
          headers: { ''Authorization'': `Bearer ${authToken}` }
        });
        
        if (response.ok) {
          loadComments();
        } else {
          alert(''Failed to delete comment'');
        }
      } catch (error) {
        alert(''Network error'');
      }
    }

    async function loadAnalytics() {
      try {
        const response = await fetch(`${API_BASE}/analytics`, {
          headers: { ''Authorization'': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        
        if (response.ok) {
          document.getElementById(''totalComments'').textContent = data.total_comments;
          document.getElementById(''approvedComments'').textContent = data.approved_comments;
          document.getElementById(''pendingComments'').textContent = data.pending_comments;
          document.getElementById(''spamComments'').textContent = data.spam_comments;
          document.getElementById(''totalReactions'').textContent = data.total_reactions;
          document.getElementById(''totalSubscribers'').textContent = data.total_subscribers;
          
          const byPageContainer = document.getElementById(''commentsByPage'');
          byPageContainer.innerHTML = `
            <table>
              <thead>
                <tr>
                  <th>Page URL</th>
                  <th>Comments</th>
                </tr>
              </thead>
              <tbody>
                ${data.comments_by_page.map(item => `
                  <tr>
                    <td class="comment-content">${escapeHtml(item.page_url)}</td>
                    <td>${item.count}</td>
                  </tr>
                `).join('''')}
              </tbody>
            </table>
          `;
        }
      } catch (error) {
        console.error(''Failed to load analytics:'', error);
      }
    }

    async function loadSettings() {
      try {
        const response = await fetch(`${API_BASE}/settings`, {
          headers: { ''Authorization'': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        
        if (response.ok) {
          document.getElementById(''requireModeration'').checked = data.require_moderation === ''true'';
          document.getElementById(''allowGuestComments'').checked = data.allow_guest_comments === ''true'';
          document.getElementById(''maxCommentLength'').value = data.max_comment_length || ''5000'';
          document.getElementById(''commentSortOrder'').value = data.comment_sort_order || ''asc'';
          document.getElementById(''adminEmail'').value = data.admin_email || '''';
        }
      } catch (error) {
        console.error(''Failed to load settings:'', error);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement(''div'');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>');
