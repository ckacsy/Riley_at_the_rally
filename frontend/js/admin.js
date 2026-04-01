'use strict';

/**
 * Admin landing page — Operations Hub dashboard.
 *
 * Fetches GET /api/admin/dashboard once on load and renders role-aware widgets.
 * Provides a manual refresh button; no polling or auto-refresh.
 */
(function () {
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Return a status class based on the count and threshold.
     * @param {number} count
     * @param {'warn'|'danger'|'neutral'|'ok'} mode
     * @returns {string}
     */
    function statusClass(count, mode) {
        if (mode === 'neutral') return 'dash-widget--neutral';
        if (mode === 'ok') return 'dash-widget--ok';
        if (mode === 'warn') return count > 0 ? 'dash-widget--warn' : 'dash-widget--ok';
        if (mode === 'danger') return count > 0 ? 'dash-widget--danger' : 'dash-widget--ok';
        return 'dash-widget--neutral';
    }

    /**
     * Escape HTML entities for safe text insertion.
     * @param {string} str
     * @returns {string}
     */
    function esc(str) {
        if (!str && str !== 0) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Render one session preview line.
     * @param {{ carName: string, username: string }} item
     * @returns {string}
     */
    function sessionPreviewLine(item) {
        return '<li>' + esc(item.carName) + (item.username ? ' · ' + esc(item.username) : '') + '</li>';
    }

    /**
     * Render one maintenance car preview line.
     * @param {{ carName: string, reason: string }} item
     * @returns {string}
     */
    function maintPreviewLine(item) {
        return '<li>' + esc(item.carName) + (item.reason ? ': ' + esc(item.reason) : '') + '</li>';
    }

    /**
     * Render one audit action preview line.
     * @param {{ action: string, admin_username: string, target_username: string }} item
     * @returns {string}
     */
    function auditPreviewLine(item) {
        var actionLabels = {
            ban_user:        'Блокировка пользователя',
            unban_user:      'Разблокировка пользователя',
            delete_user:     'Удаление пользователя',
            balance_adjust:  'Корректировка баланса',
            compensation:    'Компенсация',
            delete_message:  'Удаление сообщения',
            publish_news:    'Публикация новости',
            archive_news:    'Архивирование новости',
            create_news:     'Создание новости',
            update_news:     'Редактирование новости',
            force_end_session: 'Принудительное завершение сессии',
            set_role:        'Изменение роли',
        };
        var action = actionLabels[item.action] || item.action;
        var line = esc(action);
        if (item.admin_username) line += ' — ' + esc(item.admin_username);
        if (item.target_username) line += ' → ' + esc(item.target_username);
        return '<li>' + line + '</li>';
    }

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    /**
     * Render the Operations Hub section from dashboard API response.
     * @param {object} data
     * @param {string} role - 'admin' | 'moderator'
     */
    function renderDashboard(data, role) {
        var hub = document.getElementById('ops-hub-grid');
        if (!hub) return;

        var widgets = [];

        // Active sessions
        var as = data.activeSessions || { count: 0, items: [] };
        var asItems = (as.items || []).slice(0, 5).map(sessionPreviewLine).join('');
        widgets.push(
            '<a href="/admin-sessions" class="dash-widget ' + statusClass(as.count, 'ok') + '">' +
            '<span class="dash-widget__title">Активные сессии</span>' +
            '<span class="dash-widget__count">' + esc(as.count) + '</span>' +
            (asItems ? '<ul class="dash-widget__preview">' + asItems + '</ul>' : '') +
            '</a>'
        );

        if (role === 'admin') {
            // Orphaned holds
            var oh = data.orphanedHolds || { count: 0 };
            widgets.push(
                '<a href="/admin-transactions#orphaned-holds" class="dash-widget ' + statusClass(oh.count, 'danger') + '">' +
                '<span class="dash-widget__title">Зависшие блокировки</span>' +
                '<span class="dash-widget__count">' + esc(oh.count) + '</span>' +
                '</a>'
            );

            // Maintenance cars
            var mc = data.maintenanceCars || { count: 0, items: [] };
            var mcItems = (mc.items || []).slice(0, 5).map(maintPreviewLine).join('');
            widgets.push(
                '<a href="/admin-cars" class="dash-widget ' + statusClass(mc.count, 'warn') + '">' +
                '<span class="dash-widget__title">Машины на обслуживании</span>' +
                '<span class="dash-widget__count">' + esc(mc.count) + '</span>' +
                (mcItems ? '<ul class="dash-widget__preview">' + mcItems + '</ul>' : '') +
                '</a>'
            );

            // Banned users
            var bu = data.bannedUsers || { count: 0 };
            widgets.push(
                '<a href="/admin-users" class="dash-widget ' + statusClass(bu.count, 'neutral') + '">' +
                '<span class="dash-widget__title">Забаненные пользователи</span>' +
                '<span class="dash-widget__count">' + esc(bu.count) + '</span>' +
                '</a>'
            );

            // Recent audit actions
            var ra = data.recentAuditActions || [];
            var raItems = ra.slice(0, 5).map(auditPreviewLine).join('');
            widgets.push(
                '<a href="/admin-audit" class="dash-widget dash-widget--neutral">' +
                '<span class="dash-widget__title">Последние важные действия</span>' +
                (raItems
                    ? '<ul class="dash-widget__preview">' + raItems + '</ul>'
                    : '<span class="dash-widget__empty">Нет действий</span>') +
                '</a>'
            );
        }

        var grid = document.getElementById('ops-hub-grid');
        if (grid) {
            grid.innerHTML = widgets.join('');
            grid.hidden = false;
        }

        var skeleton = document.getElementById('ops-hub-skeleton');
        if (skeleton) skeleton.hidden = true;
    }

    /**
     * Show error state in the ops hub.
     */
    function renderDashboardError() {
        var skeleton = document.getElementById('ops-hub-skeleton');
        if (skeleton) skeleton.textContent = 'Ошибка загрузки. Нажмите ↻ Обновить.';
    }

    // -------------------------------------------------------------------------
    // Fetch
    // -------------------------------------------------------------------------

    var _currentRole = null;

    /**
     * Fetch dashboard data and render.
     */
    function loadDashboard() {
        var skeleton = document.getElementById('ops-hub-skeleton');
        var grid = document.getElementById('ops-hub-grid');

        if (skeleton) {
            skeleton.textContent = 'Загрузка…';
            skeleton.hidden = false;
        }
        if (grid) {
            grid.innerHTML = '';
            grid.hidden = true;
        }

        fetch('/api/admin/dashboard', { credentials: 'include' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                renderDashboard(data, _currentRole);
            })
            .catch(function () {
                renderDashboardError();
                if (skeleton) skeleton.hidden = false;
            });
    }

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------

    /**
     * Initialise the Operations Hub.
     * Called after AdminApi.requireAdmin() resolves with the current user.
     * @param {{ role: string }} user
     */
    function initDashboard(user) {
        _currentRole = user.role;

        var refreshBtn = document.getElementById('ops-hub-refresh');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                loadDashboard();
            });
        }

        loadDashboard();
    }

    // Expose for use by the inline script in admin.html
    window.AdminDashboard = { init: initDashboard };
})();
