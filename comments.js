/**
 * Standalone Comment System - Client Widget
 * Embeddable comment system for static sites
 */



class CommentSystem {
    constructor(options) {
        this.apiUrl = options.apiUrl || '/comments/api.php';
        this.pageUrl = options.pageUrl || window.location.pathname;
        this.containerId = options.containerId || 'comments-container';
        this.closed = options.closed || false;
        this.container = document.getElementById(this.containerId);
        this._outsideClickHandlerBound = false;
        this._setupOutsideClickHandler();

        if (!this.container) {
            console.error('Comment container not found');
            return;
        }

        this.init();
    }

    _setupOutsideClickHandler() {
        if (this._outsideClickHandlerBound) return;
        this._outsideClickHandlerBound = true;

        document.addEventListener('click', (e) => {
            if (!this.container) return;
            const openWrap = this.container.querySelector('.reaction-picker-wrap.open');
            if (!openWrap) return;
            if (e.target && openWrap.contains(e.target)) return;
            this.closeAllReactionPickers();
        });
    }

    closeAllReactionPickers() {
        if (!this.container) return;
        this.container.querySelectorAll('.reaction-picker-wrap.open').forEach(el => {
            el.classList.remove('open');
        });
    }

    getReactionDefinitions() {
        // Keep reaction_type stable for persistence (DB stores reaction_type).
        // This order matches the requested emoji list:
        // 👍 👎 🙏 👌 🔥 ❤️ ☹️ 😡 😄 😐
        return [
            { type: 'thumbsup',  emoji: '👍', label: 'Good point' },
            { type: 'lightbulb', emoji: '👎', label: 'Dislike' },
            { type: 'pray',      emoji: '🙏', label: 'Thanks' },
            { type: 'ok',        emoji: '👌', label: 'Okay' },
            { type: 'fire',      emoji: '🔥', label: 'Love it' },
            { type: 'heart',     emoji: '❤️', label: 'Love it' },
            { type: 'frown',     emoji: '☹️', label: 'Not great' },
            { type: 'rage',      emoji: '😡', label: 'Angry' },
            { type: 'funny',     emoji: '😄', label: 'Funny' },
            { type: 'neutral',   emoji: '😐', label: 'Neutral' },
        ];
    }

    getCommentReactionCounts(comment) {
        // New backend returns `votes_by_reaction_type`, old one exposes only 4 fields.
        if (comment && comment.votes_by_reaction_type && typeof comment.votes_by_reaction_type === 'object') {
            return comment.votes_by_reaction_type;
        }
        return {
            heart: comment.votes_heart || 0,
            thumbsup: comment.votes_thumbsup || 0,
            lightbulb: comment.votes_lightbulb || 0,
            funny: comment.votes_funny || 0,
        };
    }

    getPostReactions() {
        try {
            return JSON.parse(localStorage.getItem('post_reactions') || '{}');
        } catch (e) {
            return {};
        }
    }

    setPostReactions(data) {
        try {
            localStorage.setItem('post_reactions', JSON.stringify(data));
        } catch (e) {}
    }

    hasPostReacted(reactionType) {
        const data = this.getPostReactions();
        return (data[this.pageUrl] || []).includes(reactionType);
    }

    async handlePostReaction(reactionType) {
        // Optimistic-close picker UX (real update is still async).
        this.closeAllReactionPickers();

        const toggleEls = document.querySelectorAll(`.reaction-picker-emoji[data-reaction-target="post"][data-reaction="${reactionType}"], .btn-reaction.btn-post-reaction[data-reaction="${reactionType}"]`);
        toggleEls.forEach(el => el.disabled = true);
        try {
            const response = await fetch(`${this.apiUrl}?action=post_reaction`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ page_url: this.pageUrl, reaction_type: reactionType })
            });
            const result = await response.json();
            if (response.ok) {
                const data = this.getPostReactions();
                const key = this.pageUrl;
                if (!data[key]) data[key] = [];
                if (result.voted) {
                    if (!data[key].includes(reactionType)) data[key].push(reactionType);
                } else {
                    data[key] = data[key].filter(r => r !== reactionType);
                    if (data[key].length === 0) delete data[key];
                }
                this.setPostReactions(data);

                this.updatePostReactionBadges(result.counts || {});
            }
        } catch (e) {
            // Silently fail
        } finally {
            setTimeout(() => {
                toggleEls.forEach(el => el.disabled = false);
            }, 500);
        }
    }

    renderPostReactionsSection(counts = {}) {
        const reactions = this.getReactionDefinitions();
        const usedReactions = reactions.filter(r => (counts[r.type] || 0) > 0);
        const badgesHtml = usedReactions.map(r => {
            const count = counts[r.type] || 0;
            const voted = this.hasPostReacted(r.type);
            return `<button class="btn-reaction btn-post-reaction btn-reaction-${r.type}${voted ? ' voted' : ''}"
                                    data-reaction-target="post"
                                    data-reaction="${r.type}"
                                    onclick="commentsWidget.handlePostReaction('${r.type}')"
                                    title="${r.label}">
                                <span class="reaction-emoji">${r.emoji}</span><span class="reaction-count">${count > 0 ? count : ''}</span>
                            </button>`;
        }).join('');

        return `
            <h4 class="post-reactions-label">بازخورد</h4>
            <div class="post-reactions-section">
                <div class="reaction-picker-wrap" id="cs-post-reaction-picker-wrap">
                    <button type="button"
                            class="btn-reaction-add"
                            data-reaction-target="post"
                            onclick="commentsWidget.togglePostReactionPicker()"
                            aria-label="Add reaction"
                            title="Add reaction">
                        <svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" height="18" aria-hidden="true" data-component="Octicon" viewBox="0 0 16 16" version="1.1" width="18" data-view-component="true" class="octicon octicon-smiley social-button-emoji">    <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm3.82 1.636a.75.75 0 0 1 1.038.175l.007.009c.103.118.22.222.35.31.264.178.683.37 1.285.37.602 0 1.02-.192 1.285-.371.13-.088.247-.192.35-.31l.007-.008a.75.75 0 0 1 1.222.87l-.022-.015c.02.013.021.015.021.015v.001l-.001.002-.002.003-.005.007-.014.019a2.066 2.066 0 0 1-.184.213c-.16.166-.338.316-.53.445-.63.418-1.37.638-2.127.629-.946 0-1.652-.308-2.126-.63a3.331 3.331 0 0 1-.715-.657l-.014-.02-.005-.006-.002-.003v-.002h-.001l.613-.432-.614.43a.75.75 0 0 1 .183-1.044ZM12 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM5 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm5.25 2.25.592.416a97.71 97.71 0 0 0-.592-.416Z" fill="#9198A1"></path></svg>
                    </button>
                    <div class="cs-reaction-picker" role="menu" aria-hidden="true">
                        ${this.getReactionDefinitions().map(r => {
                            return `<button type="button"
                                            class="reaction-picker-emoji"
                                            data-reaction-target="post"
                                            data-reaction="${r.type}"
                                            onclick="commentsWidget.handlePostReaction('${r.type}')"
                                            title="${r.label}">
                                        <span class="reaction-picker-emoji-visual">${r.emoji}</span>
                                    </button>`;
                        }).join('')}
                    </div>
                </div>
                <div class="post-reactions-badges${usedReactions.length === 0 ? ' no-badges' : ''}" id="post-reaction-badges">
                    ${badgesHtml}
                </div>
            </div>
        `;
    }

    getVotedComments() {
        try {
            const data = JSON.parse(localStorage.getItem('comment_votes') || '{}');
            // Fallback: if old format (array), convert to empty object
            if (Array.isArray(data)) return {};
            return data;
        } catch (e) {
            return {};
        }
    }

    setVotedComments(data) {
        try {
            localStorage.setItem('comment_votes', JSON.stringify(data));
        } catch (e) {}
    }

    hasVoted(commentId, reactionType) {
        const data = this.getVotedComments();
        return (data[commentId] || []).includes(reactionType);
    }

    async handleVote(commentId, reactionType) {
        this.closeAllReactionPickers();

        const toggleEls = document.querySelectorAll(`.btn-reaction[data-comment-id="${commentId}"][data-reaction="${reactionType}"], .reaction-picker-emoji[data-comment-id="${commentId}"][data-reaction="${reactionType}"]`);
        if ([...toggleEls].some(el => el.disabled)) return;
        toggleEls.forEach(el => el.disabled = true);
        try {
            const response = await fetch(`${this.apiUrl}?action=vote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comment_id: commentId, reaction_type: reactionType })
            });
            const result = await response.json();
            if (response.ok) {
                // Update localStorage
                const data = this.getVotedComments();
                const key = String(commentId);
                if (!data[key]) data[key] = [];
                if (result.voted) {
                    if (!data[key].includes(reactionType)) data[key].push(reactionType);
                } else {
                    data[key] = data[key].filter(r => r !== reactionType);
                    if (data[key].length === 0) delete data[key];
                }
                this.setVotedComments(data);

                // Update badges based on returned counts (insert/remove as needed).
                this.updateCommentReactionBadges(commentId, result.counts || {});
            }
        } catch (e) {
            // Silently fail — voting is non-critical
        } finally {
            setTimeout(() => {
                toggleEls.forEach(el => el.disabled = false);
            }, 500);
        }
    }

    updateCommentReactionBadges(commentId, counts) {
        const container = document.getElementById(`comment-reaction-badges-${commentId}`);
        if (!container) return;

        const used = this.getReactionDefinitions().filter(r => (counts[r.type] || 0) > 0);
        if (used.length === 0) {
            container.innerHTML = '';
            const wrap = document.getElementById(`cs-reaction-picker-wrap-${commentId}`);
            if (wrap) wrap.classList.add('no-badges');
            return;
        }

        const wrap = document.getElementById(`cs-reaction-picker-wrap-${commentId}`);
        if (wrap) wrap.classList.remove('no-badges');
        container.innerHTML = used.map(r => {
            const count = counts[r.type] || 0;
            const voted = this.hasVoted(commentId, r.type);
            return `<button class="btn-reaction btn-reaction-${r.type}${voted ? ' voted' : ''}"
                            data-reaction-target="comment"
                            data-comment-id="${commentId}"
                            data-reaction="${r.type}"
                            onclick="commentsWidget.handleVote(${commentId}, '${r.type}')"
                            title="${r.label}">
                        <span class="reaction-emoji">${r.emoji}</span><span class="reaction-count">${count > 0 ? count : ''}</span>
                    </button>`;
        }).join('');
    }

    updatePostReactionBadges(counts) {
        const container = document.getElementById('post-reaction-badges');
        if (!container) return;

        const used = this.getReactionDefinitions().filter(r => (counts[r.type] || 0) > 0);
        if (used.length === 0) {
            container.innerHTML = '';
            container.classList.add('no-badges');
            return;
        }

        container.classList.remove('no-badges');
        container.innerHTML = used.map(r => {
            const count = counts[r.type] || 0;
            const voted = this.hasPostReacted(r.type);
            return `<button class="btn-reaction btn-post-reaction btn-reaction-${r.type}${voted ? ' voted' : ''}"
                            data-reaction-target="post"
                            data-reaction="${r.type}"
                            onclick="commentsWidget.handlePostReaction('${r.type}')"
                            title="${r.label}">
                        <span class="reaction-emoji">${r.emoji}</span><span class="reaction-count">${count > 0 ? count : ''}</span>
                    </button>`;
        }).join('');
    }

    toggleReactionPicker(commentId) {
        const wrap = document.getElementById(`cs-reaction-picker-wrap-${commentId}`);
        if (!wrap) return;

        const isOpen = wrap.classList.contains('open');
        this.closeAllReactionPickers();
        if (!isOpen) wrap.classList.add('open');
    }

    togglePostReactionPicker() {
        const wrap = document.getElementById('cs-post-reaction-picker-wrap');
        if (!wrap) return;
        const isOpen = wrap.classList.contains('open');
        this.closeAllReactionPickers();
        if (!isOpen) wrap.classList.add('open');
    }

    async init() {
        this.render();
        await this.loadComments();
    }

    // رندر
    render() {
        const formHtml = this.closed
            ? '<p class="comments-closed">Comments are closed.</p>'
            : `<div id="comment-form-container">${this.renderCommentForm()}</div>`;

        this.container.innerHTML = `
            <div class="comments-system">
                <div class="post-comment">
                    <div id="post-reactions-container">
                        ${this.renderPostReactionsSection()}
                    </div>
                    <h3 class="comments-title"></h3>
                    <p class="befor-form-comment">نظرتان را بنویسید.</p>
                    ${formHtml}
                </div>
                <div id="comments-list" class="comments-list">
                    <p class="loading">Loading comments...</p>
                </div>
            </div>
        `;

        if (!this.closed) {
            this.attachFormHandler();
        }
    }

    renderCommentForm(parentId = null, parentAuthor = null) {
        const replyText = parentAuthor ? `پاسخ به ${this.escapeHtml(parentAuthor)}` : '';
        const formId = parentId ? `reply-form-${parentId}` : 'main-comment-form';

        // Get saved user info from localStorage
        const savedInfo = this.getSavedUserInfo();

        return `
            <form class="comment-form" id="${formId}" data-parent-id="${parentId || ''}">
                <h4>${replyText}</h4>
                <div class="form-group">
                    <input type="text" name="author_name" placeholder="نام *" required class="form-input" value="${this.escapeHtml(savedInfo.name)}">
                </div>
                <div class="form-group">
                    <input type="email" name="author_email" placeholder="ایمیل *  (آدرس ایمیل شما منتشر نخواهد شد)" required class="form-input" value="${this.escapeHtml(savedInfo.email)}">
                </div>
                <div class="form-group">
                    <input type="url" name="author_url" placeholder="وب سایت" class="form-input" value="${this.escapeHtml(savedInfo.url)}">
                </div>
                <div class="form-group" aria-hidden="true" style="position: absolute; opacity: 0; top: 0; left: 0; height: 0; width: 0; z-index: -1; overflow: hidden; pointer-events: none;">
                    <input type="text" name="website" placeholder="Website" class="form-input" tabindex="-1" autocomplete="off">
                </div>
                <div class="form-group">
                    <textarea name="content" placeholder="متن *" required class="form-textarea" rows="4"></textarea>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" name="subscribe" value="1">
                        <span>نظرات بعدی در این صفحه را به ایمیل من ارسال کن.</span>
                    </label>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" name="remember_me" value="1" ${savedInfo.remember ? 'checked' : ''}>
                        <span>مشخصات من را برای دفعه‌ی بعد به یاد داشته باش.</span>
                    </label>
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn-submit">ارسال</button>
                    ${parentId ? '<button type="button" class="btn-cancel" onclick="this.closest(\'.comment-reply-form\').remove()">لغو</button>' : ''}
                </div>
                <div class="form-message"></div>
            </form>
        `;
    }

    attachFormHandler(form = null) {
        const forms = form ? [form] : document.querySelectorAll('.comment-form');
        forms.forEach(f => {
            f.addEventListener('submit', (e) => this.handleSubmit(e));
        });
    }

    async handleSubmit(e) {
        e.preventDefault();
        const form = e.target;
        const formData = new FormData(form);
        const messageEl = form.querySelector('.form-message');
        const submitBtn = form.querySelector('.btn-submit');

        submitBtn.disabled = true;
        messageEl.textContent = 'Posting...';
        messageEl.className = 'form-message info';

        const authorName = formData.get('author_name');
        const authorEmail = formData.get('author_email');
        const authorUrl = formData.get('author_url');
        const rememberMe = formData.get('remember_me') ? true : false;

        const data = {
            page_url: this.pageUrl,
            parent_id: form.dataset.parentId || null,
            author_name: authorName,
            author_email: authorEmail,
            author_url: authorUrl,
            content: formData.get('content'),
            subscribe: formData.get('subscribe') ? true : false
        };

        try {
            const response = await fetch(`${this.apiUrl}?action=post`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data)
            });

            const result = await response.json();

            if (response.ok) {
                // Save user info if remember me is checked
                this.saveUserInfo(authorName, authorEmail, authorUrl, rememberMe);

                messageEl.textContent = result.message;
                messageEl.className = 'form-message success';
                form.reset();

                // Restore saved info after reset if remember me was checked
                if (rememberMe) {
                    form.querySelector('input[name="author_name"]').value = authorName;
                    form.querySelector('input[name="author_email"]').value = authorEmail;
                    form.querySelector('input[name="author_url"]').value = authorUrl;
                    form.querySelector('input[name="remember_me"]').checked = true;
                }

                // Reload comments
                setTimeout(() => {
                    this.loadComments();
                    messageEl.textContent = '';
                }, 2000);
            } else {
                messageEl.textContent = result.error || 'ارسال نشد';
                messageEl.className = 'form-message error';
            }
        } catch (error) {
            messageEl.textContent = 'خطای شبکه. لطفاً دوباره تلاش کنید.';
            messageEl.className = 'form-message error';
        } finally {
            submitBtn.disabled = false;
        }
    }

    async loadComments() {
        try {
            const response = await fetch(`${this.apiUrl}?action=comments&url=${encodeURIComponent(this.pageUrl)}`);
            const data = await response.json();

            if (response.ok) {
                this.displayComments(data.comments);
                const prContainer = document.getElementById('post-reactions-container');
                if (prContainer && data.post_reactions) {
                    prContainer.innerHTML = this.renderPostReactionsSection(data.post_reactions);
                }
            } else {
                document.getElementById('comments-list').innerHTML =
                    '<p class="error">Failed to load comments</p>';
            }
        } catch (error) {
            document.getElementById('comments-list').innerHTML =
                '<p class="error">Failed to load comments</p>';
        }
    }

    displayComments(comments) {
        const listEl = document.getElementById('comments-list');

        if (comments.length === 0) {
            listEl.innerHTML = this.closed
                ? '<p class="no-comments">No comments.</p>'
                : '<p class="no-comments">هنوز کامنتی ثبت نشده!</p>';
            return;
        }

        listEl.innerHTML = comments.map(comment => this.renderComment(comment)).join('');
    }

    formatJalaliDate(dateString) {
        if (!dateString) return '';
        try {
            const date = new Date(dateString);
            return new Intl.DateTimeFormat('fa-IR', {
                calendar: 'persian',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Tehran'
            }).format(date);
        } catch (e) {
            return dateString;
        }
    }

    renderComment(comment, depth = 0) {
        const formattedDate = this.formatJalaliDate(comment.created_at);

        const authorLink = comment.author_url
            ? `<a href="${this.escapeHtml(comment.author_url)}" target="_blank" rel="nofollow noopener">${this.escapeHtml(comment.author_name)}</a>`
            : this.escapeHtml(comment.author_name);

        const isPending = comment.status === 'pending';
        const pendingBadge = isPending ? '<span class="badge-pending">در انتظار بررسی</span>' : '';

        const reactionCounts = this.getCommentReactionCounts(comment);
        const reactions = this.getReactionDefinitions();
        const usedReactions = reactions.filter(r => (reactionCounts[r.type] || 0) > 0);
        const hasAnyReactions = usedReactions.length > 0;
        const reactionsHtml = usedReactions.map(r => {
            const count = reactionCounts[r.type] || 0;
            const voted = this.hasVoted(comment.id, r.type);
            return `<button class="btn-reaction btn-reaction-${r.type}${voted ? ' voted' : ''}"
                            data-reaction-target="comment"
                            data-comment-id="${comment.id}" data-reaction="${r.type}"
                            onclick="commentsWidget.handleVote(${comment.id}, '${r.type}')"
                            title="${r.label}">
                        <span class="reaction-emoji">${r.emoji}</span><span class="reaction-count">${count > 0 ? count : ''}</span>
                    </button>`;
        }).join('');

        const upvoteBtn = isPending ? '' : `
            <div class="reaction-picker-wrap${hasAnyReactions ? '' : ' no-badges'}" id="cs-reaction-picker-wrap-${comment.id}">
                <button type="button"
                        class="btn-reaction-add"
                        data-reaction-target="comment"
                        onclick="commentsWidget.toggleReactionPicker(${comment.id})"
                        aria-label="Add reaction"
                        title="Add reaction">
                    <svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" height="18" aria-hidden="true" data-component="Octicon" viewBox="0 0 16 16" version="1.1" width="18" data-view-component="true" class="octicon octicon-smiley social-button-emoji">    <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm3.82 1.636a.75.75 0 0 1 1.038.175l.007.009c.103.118.22.222.35.31.264.178.683.37 1.285.37.602 0 1.02-.192 1.285-.371.13-.088.247-.192.35-.31l.007-.008a.75.75 0 0 1 1.222.87l-.022-.015c.02.013.021.015.021.015v.001l-.001.002-.002.003-.005.007-.014.019a2.066 2.066 0 0 1-.184.213c-.16.166-.338.316-.53.445-.63.418-1.37.638-2.127.629-.946 0-1.652-.308-2.126-.63a3.331 3.331 0 0 1-.715-.657l-.014-.02-.005-.006-.002-.003v-.002h-.001l.613-.432-.614.43a.75.75 0 0 1 .183-1.044ZM12 7a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM5 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm5.25 2.25.592.416a97.71 97.71 0 0 0-.592-.416Z" fill="#9198A1"></path></svg>
                </button>
                <div class="cs-reaction-picker" role="menu" aria-hidden="true">
                    ${reactions.map(r => {
                        return `<button type="button"
                                        class="reaction-picker-emoji"
                                        data-reaction-target="comment"
                                        data-comment-id="${comment.id}"
                                        data-reaction="${r.type}"
                                        onclick="commentsWidget.handleVote(${comment.id}, '${r.type}')"
                                        title="${r.label}">
                                    <span class="reaction-picker-emoji-visual">${r.emoji}</span>
                                </button>`;
                    }).join('')}
                </div>
                <div class="comment-reaction-badges" id="comment-reaction-badges-${comment.id}">
                    ${reactionsHtml}
                </div>
            </div>
        `;

        let html = `
            <div class="comment ${isPending ? 'comment-pending' : ''}" id="comment-${comment.id}" style="margin-right: ${depth * 30}px">
                <div class="comment-meta">
                    <span class="comment-author">${authorLink}</span>
                    <span class="comment-date">${formattedDate}</span>
                    ${pendingBadge}
                </div>
                <div class="comment-content">
                    ${this.renderMarkdown(comment.content)}
                </div>
                <div class="comment-actions">
                    ${upvoteBtn}
                    ${this.closed ? '' : `<button class="btn-reply" onclick="commentsWidget.showReplyForm(${comment.id}, '${this.escapeHtml(comment.author_name).replace(/'/g, "\\'")}')">پاسخ</button>`}
                </div>
                <div id="reply-form-container-${comment.id}"></div>
            </div>
        `;

        if (comment.replies && comment.replies.length > 0) {
            html += comment.replies.map(reply => this.renderComment(reply, depth + 1)).join('');
        }

        return html;
    }

    showReplyForm(parentId, parentAuthor) {
        // Remove any existing reply forms
        document.querySelectorAll('.comment-reply-form').forEach(el => el.remove());

        const container = document.getElementById(`reply-form-container-${parentId}`);
        const formContainer = document.createElement('div');
        formContainer.className = 'comment-reply-form';
        formContainer.innerHTML = this.renderCommentForm(parentId, parentAuthor);
        container.appendChild(formContainer);

        this.attachFormHandler(formContainer.querySelector('form'));
        formContainer.querySelector('textarea').focus();
    }

    renderMarkdown(text) {
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        const safeUrl = (url) => /^https?:\/\//i.test(url.trim()) ? url.trim() : '#';

        // Token-based inline processor. Only 'text' tokens are eligible for further
        // pattern matching; 'html' tokens pass through as-is. This prevents double-
        // processing and keeps user content safely escaped.
        function applyPattern(tokens, regex, replacer) {
            return tokens.flatMap(token => {
                if (token.type !== 'text') return [token];
                const parts = [];
                let last = 0;
                regex.lastIndex = 0;
                let m;
                while ((m = regex.exec(token.value)) !== null) {
                    if (m.index > last) parts.push({ type: 'text', value: token.value.slice(last, m.index) });
                    parts.push({ type: 'html', value: replacer(m) });
                    last = m.index + m[0].length;
                }
                if (last < token.value.length) parts.push({ type: 'text', value: token.value.slice(last) });
                return parts.length ? parts : [token];
            });
        }

        function renderInline(str) {
            let tokens = [{ type: 'text', value: str }];
            // inline code first — protects contents from other patterns
            tokens = applyPattern(tokens, /`([^`]+)`/g,
                m => `<code>${esc(m[1])}</code>`);
            // images before links (![...] would also match [...])
            tokens = applyPattern(tokens, /!\[([^\]]*)\]\(([^)]+)\)/g,
                m => `<img src="${esc(safeUrl(m[2]))}" alt="${esc(m[1])}" loading="lazy">`);
            // markdown links (before bare-URL pass, so link URLs aren't double-linked)
            tokens = applyPattern(tokens, /\[([^\]]+)\]\(([^)]+)\)/g,
                m => `<a href="${esc(safeUrl(m[2]))}" rel="nofollow noopener" target="_blank">${esc(m[1])}</a>`);
            // bare URLs — negative lookbehind strips trailing punctuation
            tokens = applyPattern(tokens, /https?:\/\/[^\s<>"')\]]+(?<![.,;:!?])/g,
                m => `<a href="${esc(m[0])}" rel="nofollow noopener" target="_blank">${esc(m[0])}</a>`);
            // bold
            tokens = applyPattern(tokens, /\*\*([^*\n]+)\*\*/g,
                m => `<strong>${esc(m[1])}</strong>`);
            // italic (* and _)
            tokens = applyPattern(tokens, /\*([^*\n]+)\*/g,
                m => `<em>${esc(m[1])}</em>`);
            tokens = applyPattern(tokens, /_([^_\n]+)_/g,
                m => `<em>${esc(m[1])}</em>`);
            return tokens.map(t => t.type === 'html' ? t.value : esc(t.value)).join('');
        }

        return text.split('\n').map(line => {
            if (/^>\s?/.test(line)) {
                return `<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`;
            }
            return renderInline(line);
        }).join('<br>');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getSavedUserInfo() {
        try {
            const saved = localStorage.getItem('comment_user_info');
            if (saved) {
                const info = JSON.parse(saved);
                return {
                    name: info.name || '',
                    email: info.email || '',
                    url: info.url || '',
                    remember: true
                };
            }
        } catch (e) {
            console.error('Error loading saved user info:', e);
        }
        return { name: '', email: '', url: '', remember: false };
    }

    saveUserInfo(name, email, url, remember) {
        try {
            if (remember) {
                localStorage.setItem('comment_user_info', JSON.stringify({
                    name: name,
                    email: email,
                    url: url
                }));
            } else {
                localStorage.removeItem('comment_user_info');
            }
        } catch (e) {
            console.error('Error saving user info:', e);
        }
    }
}

// Initialize when DOM is ready
let commentsWidget;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initComments);
} else {
    initComments();
}

function initComments() {
    // Configuration can be set via data attributes or global config
    const container = document.getElementById('comments-container');
    if (container) {
        const config = {
            apiUrl: container.dataset.apiUrl || window.COMMENTS_CONFIG?.apiUrl || '/comments/api.php',
            pageUrl: container.dataset.pageUrl || window.COMMENTS_CONFIG?.pageUrl || window.location.pathname,
            containerId: 'comments-container',
            closed: container.dataset.closed === 'true' || window.COMMENTS_CONFIG?.closed || false
        };
        commentsWidget = new CommentSystem(config);
    }
}
