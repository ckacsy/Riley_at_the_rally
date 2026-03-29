'use strict';

/**
 * Admin UI helpers — flash messages, badges, common rendering utilities.
 * Designed to be loaded as a plain <script> before page-specific JS.
 */
(function (global) {

    /**
     * Show a flash message inside `container`.
     * @param {HTMLElement} container
     * @param {string} message
     * @param {'success'|'error'|'info'} type
     * @param {number} [ttlMs] — auto-dismiss timeout; 0 = never
     */
    function showFlash(container, message, type, ttlMs) {
        if (!container) return;
        container.innerHTML = '';
        var el = document.createElement('div');
        el.className = 'admin-flash admin-flash--' + (type || 'info');
        el.textContent = message;
        container.appendChild(el);
        if (ttlMs === undefined) ttlMs = type === 'error' ? 0 : 4000;
        if (ttlMs > 0) {
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, ttlMs);
        }
    }

    /**
     * Clear all flash messages from a container.
     * @param {HTMLElement} container
     */
    function clearFlash(container) {
        if (container) container.innerHTML = '';
    }

    /**
     * Build an HTML badge element for a user role.
     * @param {string} role
     * @returns {HTMLElement}
     */
    function roleBadge(role) {
        var el = document.createElement('span');
        el.className = 'badge badge-role badge-role--' + (role || 'unknown');
        el.textContent = role || '—';
        return el;
    }

    /**
     * Build an HTML badge element for a user status.
     * @param {string} status
     * @returns {HTMLElement}
     */
    function statusBadge(status) {
        var el = document.createElement('span');
        el.className = 'badge badge-status badge-status--' + (status || 'unknown');
        el.textContent = status || '—';
        return el;
    }

    /**
     * Format an ISO datetime string for display (date only).
     * @param {string|null} iso
     * @returns {string}
     */
    function formatDate(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleDateString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric',
            });
        } catch (_) {
            return iso.slice(0, 10);
        }
    }

    /**
     * Format an ISO datetime string for display (date + time).
     * @param {string|null} iso
     * @returns {string}
     */
    function formatDateTime(iso) {
        if (!iso) return '—';
        try {
            var d = new Date(iso);
            if (isNaN(d.getTime())) return '—';
            return d.toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
        } catch (_) {
            return '—';
        }
    }

    /**
     * Show a full-page loading overlay.
     * @param {string} id — overlay element id
     */
    function showLoading(id) {
        var el = document.getElementById(id || 'admin-loading');
        if (el) el.hidden = false;
    }

    /**
     * Hide the full-page loading overlay.
     * @param {string} id
     */
    function hideLoading(id) {
        var el = document.getElementById(id || 'admin-loading');
        if (el) el.hidden = true;
    }

    /**
     * Escape text for safe insertion as textContent (convenience wrapper).
     * Use this when you need to display user-supplied text in the DOM.
     * @param {string} str
     * @returns {string}
     */
    function esc(str) {
        var div = document.createElement('div');
        div.textContent = String(str || '');
        return div.innerHTML;
    }

    global.AdminUi = {
        showFlash: showFlash,
        clearFlash: clearFlash,
        roleBadge: roleBadge,
        statusBadge: statusBadge,
        formatDate: formatDate,
        formatDateTime: formatDateTime,
        showLoading: showLoading,
        hideLoading: hideLoading,
        esc: esc,
    };
})(window);
