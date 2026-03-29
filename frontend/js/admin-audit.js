'use strict';

/**
 * Admin audit log viewer.
 * Strict admin only — uses AdminApi.requireStrictAdmin().
 */
(function () {
    // ---------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------
    var currentPage = 1;
    var currentLimit = 50;
    var totalPages = 1;

    // ---------------------------------------------------------------------------
    // DOM references (set after DOMContentLoaded guard inside init)
    // ---------------------------------------------------------------------------
    var flashContainer;
    var fAction, fAdminId, fTargetType, fTargetId, fDateFrom, fDateTo;
    var btnApply, btnReset, btnPrev, btnNext;
    var tableWrapper, auditTbody, stateEmpty, stateLoading, paginationEl, paginationInfo;

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    function getFilters() {
        return {
            action: fAction.value.trim(),
            admin_id: fAdminId.value.trim(),
            target_type: fTargetType.value.trim(),
            target_id: fTargetId.value.trim(),
            date_from: fDateFrom.value.trim(),
            date_to: fDateTo.value.trim(),
        };
    }

    function buildQuery(filters, page, limit) {
        var params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', String(limit));
        if (filters.action) params.set('action', filters.action);
        if (filters.admin_id) params.set('admin_id', filters.admin_id);
        if (filters.target_type) params.set('target_type', filters.target_type);
        if (filters.target_id) params.set('target_id', filters.target_id);
        if (filters.date_from) params.set('date_from', filters.date_from);
        if (filters.date_to) params.set('date_to', filters.date_to);
        return params.toString();
    }

    function syncUrlToState(filters, page) {
        var params = new URLSearchParams();
        if (page > 1) params.set('page', String(page));
        if (filters.action) params.set('action', filters.action);
        if (filters.admin_id) params.set('admin_id', filters.admin_id);
        if (filters.target_type) params.set('target_type', filters.target_type);
        if (filters.target_id) params.set('target_id', filters.target_id);
        if (filters.date_from) params.set('date_from', filters.date_from);
        if (filters.date_to) params.set('date_to', filters.date_to);
        var qs = params.toString();
        history.replaceState(null, '', qs ? '?' + qs : window.location.pathname);
    }

    function hydrateFormFromUrl() {
        var params = new URLSearchParams(window.location.search);
        fAction.value = params.get('action') || '';
        fAdminId.value = params.get('admin_id') || '';
        fTargetType.value = params.get('target_type') || '';
        fTargetId.value = params.get('target_id') || '';
        fDateFrom.value = params.get('date_from') || '';
        fDateTo.value = params.get('date_to') || '';
        var p = parseInt(params.get('page') || '1', 10);
        currentPage = (p >= 1) ? p : 1;
    }

    // Safely render a details_json value: parse and pretty-print.
    function renderDetails(detailsJson) {
        if (!detailsJson) return '—';
        var preview = document.createElement('span');
        var btn = document.createElement('button');
        btn.className = 'btn-details';
        btn.textContent = 'Показать';
        var block = document.createElement('div');
        block.className = 'details-block';
        block.hidden = true;

        var parsed;
        var isObject = false;
        try {
            parsed = JSON.parse(detailsJson);
            isObject = typeof parsed === 'object' && parsed !== null;
        } catch (_) {
            // Not valid JSON — display as plain text
            parsed = detailsJson;
            isObject = false;
        }

        var pre = document.createElement('pre');
        pre.textContent = isObject
            ? JSON.stringify(parsed, null, 2)
            : String(parsed);
        block.appendChild(pre);

        btn.addEventListener('click', function () {
            var isHidden = block.hidden;
            block.hidden = !isHidden;
            btn.textContent = isHidden ? 'Скрыть' : 'Показать';
        });

        var wrap = document.createElement('div');
        wrap.appendChild(btn);
        wrap.appendChild(block);
        return wrap;
    }

    function renderRow(item) {
        var tr = document.createElement('tr');

        // Date/Time
        var tdDate = document.createElement('td');
        tdDate.className = 'nowrap';
        tdDate.textContent = AdminUi.formatDateTime(item.created_at);
        tr.appendChild(tdDate);

        // Admin
        var tdAdmin = document.createElement('td');
        tdAdmin.className = 'nowrap';
        var adminText = item.admin_username || String(item.admin_id);
        if (item.admin_id && item.admin_username) {
            adminText = item.admin_username + ' (#' + item.admin_id + ')';
        } else if (item.admin_id) {
            adminText = '#' + item.admin_id;
        }
        tdAdmin.textContent = adminText;
        tr.appendChild(tdAdmin);

        // Action
        var tdAction = document.createElement('td');
        tdAction.className = 'nowrap';
        tdAction.textContent = item.action || '—';
        tr.appendChild(tdAction);

        // Target
        var tdTarget = document.createElement('td');
        tdTarget.className = 'nowrap';
        var targetParts = [];
        if (item.target_type) targetParts.push(item.target_type);
        if (item.target_id) targetParts.push('#' + item.target_id);
        if (item.target_username) targetParts.push('(' + item.target_username + ')');
        tdTarget.textContent = targetParts.length ? targetParts.join(' ') : '—';
        tr.appendChild(tdTarget);

        // IP
        var tdIp = document.createElement('td');
        tdIp.className = 'nowrap';
        tdIp.textContent = item.ip_address || '—';
        tr.appendChild(tdIp);

        // Details
        var tdDetails = document.createElement('td');
        var detailsNode = renderDetails(item.details_json);
        if (typeof detailsNode === 'string') {
            tdDetails.textContent = detailsNode;
        } else {
            tdDetails.appendChild(detailsNode);
        }
        tr.appendChild(tdDetails);

        return tr;
    }

    // ---------------------------------------------------------------------------
    // Load data
    // ---------------------------------------------------------------------------
    function loadAuditLog(filters, page) {
        AdminUi.clearFlash(flashContainer);
        stateLoading.hidden = false;
        stateEmpty.hidden = true;
        tableWrapper.hidden = true;
        paginationEl.hidden = true;

        var qs = buildQuery(filters, page, currentLimit);

        AdminApi.adminFetch('/api/admin/audit-log?' + qs)
            .then(function (data) {
                stateLoading.hidden = true;

                if (!data.items || data.items.length === 0) {
                    stateEmpty.hidden = false;
                    return;
                }

                auditTbody.innerHTML = '';
                data.items.forEach(function (item) {
                    auditTbody.appendChild(renderRow(item));
                });

                tableWrapper.hidden = false;

                // Pagination
                var pag = data.pagination || {};
                totalPages = pag.pages || 1;
                currentPage = pag.page || page;
                paginationInfo.textContent = 'Стр. ' + currentPage + ' из ' + totalPages + ' (всего: ' + (pag.total || 0) + ')';
                btnPrev.disabled = currentPage <= 1;
                btnNext.disabled = currentPage >= totalPages;
                paginationEl.hidden = false;
            })
            .catch(function (err) {
                stateLoading.hidden = true;
                AdminUi.showFlash(flashContainer, err.message || 'Ошибка загрузки', 'error');
            });
    }

    // ---------------------------------------------------------------------------
    // Event handlers
    // ---------------------------------------------------------------------------
    function onApply() {
        currentPage = 1;
        var filters = getFilters();
        syncUrlToState(filters, currentPage);
        loadAuditLog(filters, currentPage);
    }

    function onReset() {
        fAction.value = '';
        fAdminId.value = '';
        fTargetType.value = '';
        fTargetId.value = '';
        fDateFrom.value = '';
        fDateTo.value = '';
        currentPage = 1;
        history.replaceState(null, '', window.location.pathname);
        loadAuditLog(getFilters(), currentPage);
    }

    function onPrev() {
        if (currentPage <= 1) return;
        currentPage -= 1;
        var filters = getFilters();
        syncUrlToState(filters, currentPage);
        loadAuditLog(filters, currentPage);
    }

    function onNext() {
        if (currentPage >= totalPages) return;
        currentPage += 1;
        var filters = getFilters();
        syncUrlToState(filters, currentPage);
        loadAuditLog(filters, currentPage);
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    function init() {
        flashContainer = document.getElementById('flash-container');
        fAction = document.getElementById('f-action');
        fAdminId = document.getElementById('f-admin-id');
        fTargetType = document.getElementById('f-target-type');
        fTargetId = document.getElementById('f-target-id');
        fDateFrom = document.getElementById('f-date-from');
        fDateTo = document.getElementById('f-date-to');
        btnApply = document.getElementById('btn-apply');
        btnReset = document.getElementById('btn-reset');
        btnPrev = document.getElementById('btn-prev');
        btnNext = document.getElementById('btn-next');
        tableWrapper = document.getElementById('table-wrapper');
        auditTbody = document.getElementById('audit-tbody');
        stateEmpty = document.getElementById('state-empty');
        stateLoading = document.getElementById('state-loading');
        paginationEl = document.getElementById('pagination');
        paginationInfo = document.getElementById('pagination-info');

        btnApply.addEventListener('click', onApply);
        btnReset.addEventListener('click', onReset);
        btnPrev.addEventListener('click', onPrev);
        btnNext.addEventListener('click', onNext);

        AdminApi.requireStrictAdmin()
            .then(function () {
                document.getElementById('admin-loading').hidden = true;
                document.getElementById('admin-content').hidden = false;
                hydrateFormFromUrl();
                loadAuditLog(getFilters(), currentPage);
            })
            .catch(function () { /* requireStrictAdmin handles redirects */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
