'use strict';

/**
 * Admin Users page logic.
 * Depends on: AdminApi (admin-api.js), AdminUi (admin-ui.js)
 */
(function () {

    var _currentUser = null;
    var _allUsers = [];
    var _filterText = '';

    var flashEl    = document.getElementById('flash-container');
    var loadingEl  = document.getElementById('admin-loading');
    var contentEl  = document.getElementById('admin-content');
    var stateEl    = document.getElementById('users-state');
    var tableEl    = document.getElementById('users-table');
    var tbodyEl    = document.getElementById('users-tbody');
    var searchEl   = document.getElementById('user-search');

    // Balance adjust modal elements
    var modalAdjust       = document.getElementById('modal-adjust');
    var modalFlashEl      = document.getElementById('modal-flash');
    var adjustAmountEl    = document.getElementById('adjust-amount');
    var adjustCommentEl   = document.getElementById('adjust-comment');
    var adjustKeyEl       = document.getElementById('adjust-idempotency-key');
    var adjustUserIdEl    = document.getElementById('adjust-user-id');
    var adjustSubmitBtn   = document.getElementById('modal-adjust-submit');
    var adjustCancelBtn   = document.getElementById('modal-adjust-cancel');

    // -------------------------------------------------------------------------
    // Bootstrap
    // -------------------------------------------------------------------------
    AdminApi.requireAdmin()
        .then(function (user) {
            _currentUser = user;
            loadingEl.hidden = true;
            contentEl.hidden = false;
            loadUsers();
        })
        .catch(function () { /* requireAdmin handles redirects */ });

    // -------------------------------------------------------------------------
    // Load & render users
    // -------------------------------------------------------------------------
    function loadUsers() {
        showState('Загрузка…');
        tableEl.hidden = true;

        AdminApi.adminFetch('/api/admin/users')
            .then(function (data) {
                _allUsers = data.users || [];
                renderUsers();
            })
            .catch(function (err) {
                showState('Ошибка загрузки: ' + err.message);
                AdminUi.showFlash(flashEl, err.message, 'error', 0);
            });
    }

    function renderUsers() {
        var filtered = _allUsers.filter(function (u) {
            if (!_filterText) return true;
            var q = _filterText.toLowerCase();
            return (u.username || '').toLowerCase().indexOf(q) !== -1 ||
                   (u.email || '').toLowerCase().indexOf(q) !== -1;
        });

        tbodyEl.innerHTML = '';

        if (filtered.length === 0) {
            showState(_filterText ? 'Ничего не найдено' : 'Пользователей нет');
            tableEl.hidden = true;
            return;
        }

        hideState();
        tableEl.hidden = false;

        filtered.forEach(function (user) {
            tbodyEl.appendChild(buildRow(user));
        });
    }

    function buildRow(user) {
        var tr = document.createElement('tr');
        tr.dataset.userId = String(user.id);

        function cell(text) {
            var td = document.createElement('td');
            td.textContent = text != null ? String(text) : '—';
            return td;
        }

        tr.appendChild(cell(user.id));
        tr.appendChild(cell(user.username || '—'));
        tr.appendChild(cell(user.email || '—'));

        // Role badge
        var roleCell = document.createElement('td');
        roleCell.appendChild(AdminUi.roleBadge(user.role));
        tr.appendChild(roleCell);

        // Status badge
        var statusCell = document.createElement('td');
        statusCell.appendChild(AdminUi.statusBadge(user.status));
        tr.appendChild(statusCell);

        tr.appendChild(cell(user.balance != null ? user.balance : '—'));
        tr.appendChild(cell(AdminUi.formatDate(user.created_at)));

        // Actions
        var actionsCell = document.createElement('td');
        actionsCell.appendChild(buildActions(user));
        tr.appendChild(actionsCell);

        return tr;
    }

    function buildActions(user) {
        var wrap = document.createElement('div');
        wrap.className = 'actions';

        var isSelf = _currentUser && user.id === _currentUser.id;

        // Ban
        if (!isSelf && user.status !== 'banned' && user.status !== 'deleted') {
            var banBtn = makeButton('Бан', 'btn-sm btn-ban', function () {
                confirmAndBan(user, banBtn);
            });
            wrap.appendChild(banBtn);
        }

        // Unban
        if (!isSelf && user.status === 'banned') {
            var unbanBtn = makeButton('Разбан', 'btn-sm btn-unban', function () {
                doUnban(user, unbanBtn);
            });
            wrap.appendChild(unbanBtn);
        }

        // Balance adjust
        if (!isSelf && user.status !== 'deleted') {
            var adjustBtn = makeButton('Баланс', 'btn-sm btn-adjust', function () {
                openAdjustModal(user);
            });
            wrap.appendChild(adjustBtn);
        }

        // Delete — only for admin users
        if (_currentUser && _currentUser.role === 'admin' && !isSelf && user.status !== 'deleted') {
            var deleteBtn = makeButton('Удалить', 'btn-sm btn-delete', function () {
                confirmAndDelete(user, deleteBtn);
            });
            wrap.appendChild(deleteBtn);
        }

        return wrap;
    }

    function makeButton(label, className, onClick) {
        var btn = document.createElement('button');
        btn.className = className;
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    // -------------------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------------------
    function confirmAndBan(user, btn) {
        if (!window.confirm('Забанить пользователя «' + (user.username || user.email) + '»?')) return;
        setLoading(btn, true);
        AdminApi.adminFetch('/api/admin/users/' + user.id + '/ban', { method: 'POST', body: {} })
            .then(function (data) {
                AdminUi.showFlash(flashEl, 'Пользователь забанен', 'success');
                loadUsers();
            })
            .catch(function (err) {
                AdminUi.showFlash(flashEl, err.message, 'error', 0);
                setLoading(btn, false);
            });
    }

    function doUnban(user, btn) {
        setLoading(btn, true);
        AdminApi.adminFetch('/api/admin/users/' + user.id + '/unban', { method: 'POST', body: {} })
            .then(function () {
                AdminUi.showFlash(flashEl, 'Пользователь разбанен', 'success');
                loadUsers();
            })
            .catch(function (err) {
                AdminUi.showFlash(flashEl, err.message, 'error', 0);
                setLoading(btn, false);
            });
    }

    function confirmAndDelete(user, btn) {
        if (!window.confirm('Удалить пользователя «' + (user.username || user.email) + '»? Это действие необратимо.')) return;
        setLoading(btn, true);
        AdminApi.adminFetch('/api/admin/users/' + user.id + '/delete', { method: 'POST', body: {} })
            .then(function () {
                AdminUi.showFlash(flashEl, 'Пользователь удалён', 'success');
                loadUsers();
            })
            .catch(function (err) {
                AdminUi.showFlash(flashEl, err.message, 'error', 0);
                setLoading(btn, false);
            });
    }

    // -------------------------------------------------------------------------
    // Balance Adjust Modal
    // -------------------------------------------------------------------------
    function openAdjustModal(user) {
        adjustUserIdEl.value = String(user.id);
        adjustAmountEl.value = '';
        adjustCommentEl.value = '';
        adjustKeyEl.value = generateUUID();
        AdminUi.clearFlash(modalFlashEl);
        adjustSubmitBtn.disabled = false;
        modalAdjust.hidden = false;
        adjustAmountEl.focus();
    }

    function closeAdjustModal() {
        modalAdjust.hidden = true;
    }

    adjustCancelBtn.addEventListener('click', closeAdjustModal);
    modalAdjust.addEventListener('click', function (e) {
        if (e.target === modalAdjust) closeAdjustModal();
    });

    adjustSubmitBtn.addEventListener('click', function () {
        var userId = adjustUserIdEl.value;
        var amount = parseFloat(adjustAmountEl.value);
        var comment = adjustCommentEl.value.trim();
        var key = adjustKeyEl.value;

        if (!amount || !isFinite(amount)) {
            AdminUi.showFlash(modalFlashEl, 'Введите корректную сумму', 'error', 0);
            return;
        }
        if (!comment) {
            AdminUi.showFlash(modalFlashEl, 'Введите комментарий', 'error', 0);
            return;
        }

        adjustSubmitBtn.disabled = true;
        AdminApi.adminFetch('/api/admin/users/' + userId + '/balance-adjust', {
            method: 'POST',
            body: { amount: amount, comment: comment, idempotency_key: key },
        })
            .then(function (data) {
                closeAdjustModal();
                AdminUi.showFlash(flashEl, 'Баланс скорректирован: ' + data.balance, 'success');
                loadUsers();
            })
            .catch(function (err) {
                AdminUi.showFlash(modalFlashEl, err.message, 'error', 0);
                adjustSubmitBtn.disabled = false;
                // Generate new key for next attempt
                adjustKeyEl.value = generateUUID();
            });
    });

    // -------------------------------------------------------------------------
    // Search / filter
    // -------------------------------------------------------------------------
    searchEl.addEventListener('input', function () {
        _filterText = searchEl.value.trim();
        renderUsers();
    });

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function showState(msg) {
        stateEl.textContent = msg;
        stateEl.hidden = false;
    }

    function hideState() {
        stateEl.hidden = true;
    }

    function setLoading(btn, loading) {
        btn.disabled = loading;
    }

    function generateUUID() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        // Fallback for older environments
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

})();
