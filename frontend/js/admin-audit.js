'use strict';

if (typeof AdminUi === 'undefined') throw new Error('admin-ui.js must be loaded before admin-audit.js');
if (typeof AdminApi === 'undefined') throw new Error('admin-api.js must be loaded before admin-audit.js');
if (typeof AdminFilters === 'undefined') throw new Error('admin-filters.js must be loaded before admin-audit.js');

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
    var btnApply, btnReset, btnPrev, btnNext;
    var tableWrapper, auditTbody, stateEmpty, stateLoading, paginationEl, paginationInfo;

    // Shared filter helper (initialised in init after DOM is ready)
    var filterHelper;

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

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

        var qs = filterHelper.buildQuery(filters, page, currentLimit);

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
        var filters = filterHelper.getFilters();
        filterHelper.syncUrlToState(filters, currentPage);
        loadAuditLog(filters, currentPage);
    }

    function onReset() {
        filterHelper.resetFilters();
        currentPage = 1;
        history.replaceState(null, '', window.location.pathname);
        loadAuditLog(filterHelper.getFilters(), currentPage);
    }

    function onPrev() {
        if (currentPage <= 1) return;
        currentPage -= 1;
        var filters = filterHelper.getFilters();
        filterHelper.syncUrlToState(filters, currentPage);
        loadAuditLog(filters, currentPage);
    }

    function onNext() {
        if (currentPage >= totalPages) return;
        currentPage += 1;
        var filters = filterHelper.getFilters();
        filterHelper.syncUrlToState(filters, currentPage);
        loadAuditLog(filters, currentPage);
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    function init() {
        flashContainer = document.getElementById('flash-container');
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

        // Initialise filter helper with the audit filter field map
        filterHelper = AdminFilters.create({
            action:      'f-action',
            admin_id:    'f-admin-id',
            target_type: 'f-target-type',
            target_id:   'f-target-id',
            date_from:   'f-date-from',
            date_to:     'f-date-to',
        });

        btnApply.addEventListener('click', onApply);
        btnReset.addEventListener('click', onReset);
        btnPrev.addEventListener('click', onPrev);
        btnNext.addEventListener('click', onNext);

        AdminApi.requireStrictAdmin()
            .then(function () {
                document.getElementById('admin-loading').hidden = true;
                document.getElementById('admin-content').hidden = false;
                currentPage = filterHelper.hydrateFormFromUrl();
                loadAuditLog(filterHelper.getFilters(), currentPage);
            })
            .catch(function () { /* requireStrictAdmin handles redirects */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
