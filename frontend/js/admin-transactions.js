'use strict';

/**
 * Admin transactions dashboard.
 * Read-only financial visibility layer for admin.
 * Admin only — uses requireStrictAdmin().
 */
(function () {
    // ---------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------
    var currentPage = 1;
    var currentLimit = 50;
    var totalPages = 1;

    var ledgerUserId = null;
    var ledgerPage = 1;
    var ledgerTotalPages = 1;

    // ---------------------------------------------------------------------------
    // DOM references (set in init)
    // ---------------------------------------------------------------------------
    var flashContainer, ledgerFlashContainer;
    var btnApply, btnReset, btnPrev, btnNext;
    var tableWrapper, transactionsTbody, stateEmpty, stateLoading, paginationEl, paginationInfo;
    var summarySection, summaryTotalCount, summaryTotalAmount, bytypeGrid;
    var ledgerPanel, ledgerUsername, ledgerMeta, ledgerUserSummary;
    var ledgerTableWrapper, ledgerTbody, ledgerStateEmpty, ledgerStateLoading;
    var ledgerPagination, ledgerBtnPrev, ledgerBtnNext, ledgerPaginationInfo;
    var btnLedgerClose;

    // Shared filter helper (initialised in init after DOM is ready)
    var filterHelper;

    // ---------------------------------------------------------------------------
    // Amount formatting with sign-based color
    // ---------------------------------------------------------------------------
    function amountCell(amount) {
        var td = document.createElement('td');
        td.className = 'nowrap';
        if (amount == null) {
            td.textContent = '—';
            return td;
        }
        td.textContent = AdminUi.formatMoney(amount, { signed: true });
        td.className += amount >= 0 ? ' amount-positive' : ' amount-negative';
        return td;
    }

    // ---------------------------------------------------------------------------
    // Summary rendering
    // ---------------------------------------------------------------------------
    function renderSummary(summary) {
        if (!summary) {
            summarySection.hidden = true;
            return;
        }
        summaryTotalCount.textContent = String(summary.totalCount || 0);
        var amt = (summary.totalAmount || 0);
        summaryTotalAmount.textContent = AdminUi.formatMoney(amt, { signed: true });
        summaryTotalAmount.className = 'summary-card-value ' + (amt >= 0 ? 'amount-positive' : 'amount-negative');

        bytypeGrid.innerHTML = '';
        if (Array.isArray(summary.byType) && summary.byType.length > 0) {
            summary.byType.forEach(function (item) {
                var card = document.createElement('div');
                card.className = 'bytype-card';

                var typeEl = document.createElement('div');
                typeEl.className = 'bytype-card-type';
                typeEl.appendChild(AdminUi.typeBadge(item.type));
                card.appendChild(typeEl);

                var countEl = document.createElement('div');
                countEl.className = 'bytype-card-count';
                countEl.textContent = item.count + ' шт.';
                card.appendChild(countEl);

                var totalEl = document.createElement('div');
                var t = (item.total || 0);
                totalEl.className = 'bytype-card-total' + (t >= 0 ? ' amount-positive' : ' amount-negative');
                totalEl.textContent = AdminUi.formatMoney(t, { signed: true });
                card.appendChild(totalEl);

                bytypeGrid.appendChild(card);
            });
        }
        summarySection.hidden = false;
    }

    // ---------------------------------------------------------------------------
    // Row rendering
    // ---------------------------------------------------------------------------
    function renderTransactionRow(item, includeUser) {
        var tr = document.createElement('tr');

        // Date
        var tdDate = document.createElement('td');
        tdDate.className = 'nowrap';
        tdDate.textContent = AdminUi.formatDateTime(item.created_at);
        tr.appendChild(tdDate);

        if (includeUser) {
            // User
            var tdUser = document.createElement('td');
            tdUser.className = 'nowrap';
            if (item.username) {
                var userLink = document.createElement('span');
                userLink.className = 'username-link';
                userLink.textContent = item.username;
                userLink.setAttribute('data-user-id', String(item.user_id));
                userLink.setAttribute('data-username', item.username);
                tdUser.appendChild(userLink);
            } else {
                tdUser.textContent = item.user_id ? ('#' + item.user_id) : '—';
            }
            tr.appendChild(tdUser);
        }

        // Type
        var tdType = document.createElement('td');
        tdType.appendChild(AdminUi.typeBadge(item.type));
        tr.appendChild(tdType);

        // Amount
        tr.appendChild(amountCell(item.amount));

        // Balance after
        var tdBal = document.createElement('td');
        tdBal.className = 'nowrap';
        tdBal.textContent = AdminUi.formatMoney(item.balance_after);
        tr.appendChild(tdBal);

        // Description
        var tdDesc = document.createElement('td');
        tdDesc.textContent = item.description || '—';
        tr.appendChild(tdDesc);

        // Admin
        var tdAdmin = document.createElement('td');
        tdAdmin.className = 'nowrap';
        tdAdmin.textContent = item.admin_username || (item.admin_id ? ('#' + item.admin_id) : '—');
        tr.appendChild(tdAdmin);

        // Reference
        var tdRef = document.createElement('td');
        tdRef.textContent = item.reference_id || '—';
        tr.appendChild(tdRef);

        return tr;
    }

    // ---------------------------------------------------------------------------
    // Load main transactions list
    // ---------------------------------------------------------------------------
    function loadTransactions(filters, page) {
        AdminUi.clearFlash(flashContainer);
        stateLoading.hidden = false;
        stateEmpty.hidden = true;
        tableWrapper.hidden = true;
        paginationEl.hidden = true;
        summarySection.hidden = true;

        var qs = filterHelper.buildQuery(filters, page, currentLimit);

        AdminApi.adminFetch('/api/admin/transactions?' + qs)
            .then(function (data) {
                stateLoading.hidden = true;

                renderSummary(data.summary);

                if (!data.items || data.items.length === 0) {
                    stateEmpty.hidden = false;
                    return;
                }

                transactionsTbody.innerHTML = '';
                data.items.forEach(function (item) {
                    transactionsTbody.appendChild(renderTransactionRow(item, true));
                });

                tableWrapper.hidden = false;

                var pag = data.pagination || {};
                totalPages = pag.pages || 1;
                currentPage = pag.page || page;
                paginationInfo.textContent =
                    'Стр. ' + currentPage + ' из ' + totalPages + ' (всего: ' + (pag.total || 0) + ')';
                btnPrev.disabled = currentPage <= 1;
                btnNext.disabled = currentPage >= totalPages;
                paginationEl.hidden = false;
            })
            .catch(function (err) {
                stateLoading.hidden = true;
                AdminUi.showFlash(flashContainer, err.message || 'Ошибка загрузки', 'error');
            });
    }

    function applyFilters() {
        var filters = filterHelper.getFilters();
        currentPage = 1;
        filterHelper.syncUrlToState(filters, currentPage);
        loadTransactions(filters, currentPage);
    }

    function resetFilters() {
        filterHelper.resetFilters();
        currentPage = 1;
        history.replaceState(null, '', window.location.pathname);
        loadTransactions(filterHelper.getFilters(), currentPage);
    }

    // ---------------------------------------------------------------------------
    // Ledger panel
    // ---------------------------------------------------------------------------
    function openLedger(userId, username) {
        ledgerUserId = userId;
        ledgerPage = 1;
        ledgerUsername.textContent = 'Лэджер: ' + username;
        ledgerMeta.textContent = 'ID пользователя: ' + userId;
        ledgerPanel.hidden = false;
        ledgerPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        loadLedger(userId, ledgerPage);
    }

    function closeLedger() {
        ledgerPanel.hidden = true;
        ledgerUserId = null;
        ledgerPage = 1;
    }

    function renderLedgerUserInfo(data) {
        ledgerUserSummary.innerHTML = '';

        var fields = [
            { label: 'Баланс', value: AdminUi.formatMoney(data.user.balance) },
            { label: 'Статус', value: data.user.status || '—' },
            { label: 'Транзакций', value: String(data.summary.transactionCount || 0) },
            { label: 'Пополнений', value: AdminUi.formatMoney(data.summary.totalTopups || 0, { signed: true }) },
            { label: 'Холдов', value: AdminUi.formatMoney(data.summary.totalHolds || 0) },
            { label: 'Возвратов', value: AdminUi.formatMoney(data.summary.totalReleases || 0, { signed: true }) },
            { label: 'Списаний', value: AdminUi.formatMoney(data.summary.totalDeductions || 0) },
            { label: 'Корректировок', value: AdminUi.formatMoney(data.summary.totalAdminAdjusts || 0) },
        ];

        fields.forEach(function (f) {
            var stat = document.createElement('div');
            stat.className = 'ledger-stat';
            var lbl = document.createElement('div');
            lbl.className = 'ledger-stat-label';
            lbl.textContent = f.label;
            var val = document.createElement('div');
            val.className = 'ledger-stat-value';
            val.textContent = f.value;
            stat.appendChild(lbl);
            stat.appendChild(val);
            ledgerUserSummary.appendChild(stat);
        });
    }

    function loadLedger(userId, page) {
        AdminUi.clearFlash(ledgerFlashContainer);
        ledgerStateLoading.hidden = false;
        ledgerStateEmpty.hidden = true;
        ledgerTableWrapper.hidden = true;
        ledgerPagination.hidden = true;

        AdminApi.adminFetch('/api/admin/users/' + userId + '/ledger?page=' + page + '&limit=50')
            .then(function (data) {
                ledgerStateLoading.hidden = true;

                renderLedgerUserInfo(data);

                if (!data.transactions || data.transactions.length === 0) {
                    ledgerStateEmpty.hidden = false;
                    return;
                }

                ledgerTbody.innerHTML = '';
                data.transactions.forEach(function (item) {
                    ledgerTbody.appendChild(renderTransactionRow(item, false));
                });
                ledgerTableWrapper.hidden = false;

                var pag = data.pagination || {};
                ledgerTotalPages = pag.pages || 1;
                ledgerPage = pag.page || page;
                ledgerPaginationInfo.textContent =
                    'Стр. ' + ledgerPage + ' из ' + ledgerTotalPages + ' (всего: ' + (pag.total || 0) + ')';
                ledgerBtnPrev.disabled = ledgerPage <= 1;
                ledgerBtnNext.disabled = ledgerPage >= ledgerTotalPages;
                ledgerPagination.hidden = false;
            })
            .catch(function (err) {
                ledgerStateLoading.hidden = true;
                AdminUi.showFlash(ledgerFlashContainer, err.message || 'Ошибка загрузки лэджера', 'error');
            });
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    function init() {
        flashContainer = document.getElementById('flash-container');
        ledgerFlashContainer = document.getElementById('ledger-flash-container');

        btnApply = document.getElementById('btn-apply');
        btnReset = document.getElementById('btn-reset');
        btnPrev = document.getElementById('btn-prev');
        btnNext = document.getElementById('btn-next');

        tableWrapper = document.getElementById('table-wrapper');
        transactionsTbody = document.getElementById('transactions-tbody');
        stateEmpty = document.getElementById('state-empty');
        stateLoading = document.getElementById('state-loading');
        paginationEl = document.getElementById('pagination');
        paginationInfo = document.getElementById('pagination-info');

        summarySection = document.getElementById('summary-section');
        summaryTotalCount = document.getElementById('summary-total-count');
        summaryTotalAmount = document.getElementById('summary-total-amount');
        bytypeGrid = document.getElementById('bytype-grid');

        ledgerPanel = document.getElementById('ledger-panel');
        ledgerUsername = document.getElementById('ledger-username');
        ledgerMeta = document.getElementById('ledger-meta');
        ledgerUserSummary = document.getElementById('ledger-user-summary');
        ledgerTableWrapper = document.getElementById('ledger-table-wrapper');
        ledgerTbody = document.getElementById('ledger-tbody');
        ledgerStateEmpty = document.getElementById('ledger-state-empty');
        ledgerStateLoading = document.getElementById('ledger-state-loading');
        ledgerPagination = document.getElementById('ledger-pagination');
        ledgerBtnPrev = document.getElementById('ledger-btn-prev');
        ledgerBtnNext = document.getElementById('ledger-btn-next');
        ledgerPaginationInfo = document.getElementById('ledger-pagination-info');
        btnLedgerClose = document.getElementById('btn-ledger-close');

        // Initialise filter helper with the transactions filter field map
        filterHelper = AdminFilters.create({
            user_id:      'f-user-id',
            type:         'f-type',
            reference_id: 'f-reference-id',
            date_from:    'f-date-from',
            date_to:      'f-date-to',
            min_amount:   'f-min-amount',
            max_amount:   'f-max-amount',
        });

        // Buttons
        btnApply.addEventListener('click', applyFilters);
        btnReset.addEventListener('click', resetFilters);

        btnPrev.addEventListener('click', function () {
            if (currentPage > 1) {
                currentPage--;
                var filters = filterHelper.getFilters();
                filterHelper.syncUrlToState(filters, currentPage);
                loadTransactions(filters, currentPage);
            }
        });
        btnNext.addEventListener('click', function () {
            if (currentPage < totalPages) {
                currentPage++;
                var filters = filterHelper.getFilters();
                filterHelper.syncUrlToState(filters, currentPage);
                loadTransactions(filters, currentPage);
            }
        });

        btnLedgerClose.addEventListener('click', closeLedger);

        ledgerBtnPrev.addEventListener('click', function () {
            if (ledgerPage > 1 && ledgerUserId) {
                ledgerPage--;
                loadLedger(ledgerUserId, ledgerPage);
            }
        });
        ledgerBtnNext.addEventListener('click', function () {
            if (ledgerPage < ledgerTotalPages && ledgerUserId) {
                ledgerPage++;
                loadLedger(ledgerUserId, ledgerPage);
            }
        });

        // Delegate username clicks in main table
        transactionsTbody.addEventListener('click', function (e) {
            var target = e.target;
            if (target && target.classList.contains('username-link')) {
                var userId = target.getAttribute('data-user-id');
                var username = target.getAttribute('data-username');
                if (userId) openLedger(Number(userId), username || ('#' + userId));
            }
        });

        // Hydrate form from URL and load initial data
        currentPage = filterHelper.hydrateFormFromUrl();
        loadTransactions(filterHelper.getFilters(), currentPage);
    }

    // ---------------------------------------------------------------------------
    // Entry point: strict admin guard
    // ---------------------------------------------------------------------------
    AdminApi.requireStrictAdmin()
        .then(function () {
            document.getElementById('admin-loading').hidden = true;
            document.getElementById('admin-content').hidden = false;
            init();
        })
        .catch(function () { /* requireStrictAdmin handles redirects */ });
})();
