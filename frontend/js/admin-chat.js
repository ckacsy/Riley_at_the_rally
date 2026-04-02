'use strict';

/**
 * Admin chat moderation page logic.
 * Depends on: AdminApi (admin-api.js), AdminUi (admin-ui.js)
 *
 * Uses GET /api/admin/chat/messages to load messages and
 * DELETE /api/admin/chat/:id to delete them.
 */
(function () {
    var loadingEl     = document.getElementById('admin-loading');
    var contentEl     = document.getElementById('admin-content');
    var flashEl       = document.getElementById('flash-container');
    var stateEl       = document.getElementById('chat-state');
    var tableWrapEl   = document.getElementById('chat-table-wrap');
    var tbodyEl       = document.getElementById('chat-tbody');
    var paginationEl  = document.getElementById('pagination');
    var statusEl      = document.getElementById('chat-status');
    var btnRefresh    = document.getElementById('btn-refresh');

    var _page       = 1;
    var _limit      = 50;
    var _total      = 0;
    var _currentUser = null;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatTime(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
        } catch (e) { return iso; }
    }

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------
    AdminApi.requireAdmin()
        .then(function (user) {
            _currentUser = user;
            loadingEl.hidden = true;
            contentEl.hidden = false;
            loadMessages();
        })
        .catch(function () { /* requireAdmin handles redirects */ });

    btnRefresh.addEventListener('click', function () {
        loadMessages();
    });

    // -------------------------------------------------------------------------
    // Load messages
    // -------------------------------------------------------------------------
    function loadMessages() {
        stateEl.hidden = false;
        stateEl.textContent = 'Загрузка…';
        tableWrapEl.hidden = true;
        statusEl.textContent = '';

        AdminApi.adminFetch('/api/admin/chat/messages?page=' + _page + '&limit=' + _limit)
            .then(function (data) {
                _total = data.total || 0;
                renderTable(data.messages || []);
                renderPagination();
                stateEl.hidden = true;
                tableWrapEl.hidden = false;
                statusEl.textContent = 'Всего сообщений: ' + _total;
            })
            .catch(function (err) {
                stateEl.textContent = 'Ошибка загрузки: ' + err.message;
                AdminUi.showFlash(flashEl, err.message, 'error', 8000);
            });
    }

    // -------------------------------------------------------------------------
    // Render table
    // -------------------------------------------------------------------------
    function renderTable(messages) {
        tbodyEl.innerHTML = '';

        if (!messages.length) {
            stateEl.textContent = 'Сообщений нет';
            stateEl.hidden = false;
            tableWrapEl.hidden = true;
            return;
        }

        messages.forEach(function (msg) {
            var tr = document.createElement('tr');
            tr.setAttribute('data-msg-id', msg.id);
            if (msg.deleted) tr.classList.add('msg-row-deleted');

            // ID
            var tdId = document.createElement('td');
            tdId.className = 'msg-id';
            tdId.textContent = msg.id;
            tr.appendChild(tdId);

            // Username
            var tdUser = document.createElement('td');
            tdUser.className = 'msg-user';
            tdUser.textContent = msg.username || '—';
            tr.appendChild(tdUser);

            // Message text
            var tdText = document.createElement('td');
            if (msg.deleted) {
                tdText.innerHTML = '<span class="msg-text msg-text--deleted">[Удалено]</span>';
                if (msg.deletedBy) {
                    tdText.innerHTML += '<br><span class="msg-deleted-by">Удалил: ' + esc(msg.deletedBy) + '</span>';
                }
            } else {
                var textEl = document.createElement('span');
                textEl.className = 'msg-text';
                textEl.textContent = msg.message || '';
                tdText.appendChild(textEl);
            }
            tr.appendChild(tdText);

            // Time
            var tdTime = document.createElement('td');
            tdTime.className = 'msg-time';
            tdTime.textContent = formatTime(msg.createdAt);
            tr.appendChild(tdTime);

            // Action
            var tdAction = document.createElement('td');
            if (!msg.deleted) {
                var btn = document.createElement('button');
                btn.className = 'btn-delete';
                btn.textContent = 'Удалить';
                btn.setAttribute('data-id', msg.id);
                btn.addEventListener('click', function () {
                    deleteMessage(msg.id, btn, tr);
                });
                tdAction.appendChild(btn);
            } else {
                var deletedLabel = document.createElement('span');
                deletedLabel.className = 'deleted-label';
                deletedLabel.textContent = 'Удалено';
                tdAction.appendChild(deletedLabel);
            }
            tr.appendChild(tdAction);

            tbodyEl.appendChild(tr);
        });
    }

    // -------------------------------------------------------------------------
    // Delete a message via REST
    // -------------------------------------------------------------------------
    function deleteMessage(id, btn, tr) {
        btn.disabled = true;
        btn.textContent = 'Удаление…';

        AdminApi.adminFetch('/api/admin/chat/' + id, { method: 'DELETE' })
            .then(function () {
                markRowDeleted(tr);
            })
            .catch(function (err) {
                btn.disabled = false;
                btn.textContent = 'Удалить';
                AdminUi.showFlash(flashEl, 'Ошибка: ' + err.message, 'error', 6000);
            });
    }

    function markRowDeleted(tr) {
        tr.classList.add('msg-row-deleted');
        var tdText = tr.cells[2];
        if (tdText) {
            tdText.innerHTML = '<span class="msg-text msg-text--deleted">[Удалено]</span>';
        }
        var tdAction = tr.cells[4];
        if (tdAction) {
            tdAction.innerHTML = '<span class="deleted-label">Удалено</span>';
        }
    }

    // -------------------------------------------------------------------------
    // Pagination
    // -------------------------------------------------------------------------
    function renderPagination() {
        paginationEl.innerHTML = '';
        var totalPages = Math.max(1, Math.ceil(_total / _limit));

        var btnPrev = document.createElement('button');
        btnPrev.textContent = '← Назад';
        btnPrev.disabled = _page <= 1;
        btnPrev.addEventListener('click', function () {
            if (_page > 1) { _page--; loadMessages(); }
        });
        paginationEl.appendChild(btnPrev);

        var info = document.createElement('span');
        info.className = 'page-info';
        info.textContent = 'Стр. ' + _page + ' / ' + totalPages;
        paginationEl.appendChild(info);

        var btnNext = document.createElement('button');
        btnNext.textContent = 'Вперёд →';
        btnNext.disabled = _page >= totalPages;
        btnNext.addEventListener('click', function () {
            if (_page < totalPages) { _page++; loadMessages(); }
        });
        paginationEl.appendChild(btnNext);
    }
}());
