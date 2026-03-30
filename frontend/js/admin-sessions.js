'use strict';

/**
 * Admin sessions dashboard.
 * Shows completed rental sessions and live active sessions.
 * Accessible to moderator and admin.
 */
(function () {
    // ---------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------
    var currentPage = 1;
    var currentLimit = 50;
    var totalPages = 1;
    var activeTab = 'completed'; // 'completed' | 'active'
    var activeRefreshTimer = null;
    var activeRefreshPaused = false;
    var currentUserRole = null; // populated after requireAdmin resolves
    var forceEndTargetCarId = null; // carId being targeted by the modal

    // ---------------------------------------------------------------------------
    // DOM references (set in init)
    // ---------------------------------------------------------------------------
    var flashContainer, flashActiveContainer;
    var btnApply, btnReset, btnPrev, btnNext;
    var tableWrapper, sessionsTbody, stateEmpty, stateLoading, paginationEl, paginationInfo;
    var summaryGrid, summaryTotal, summaryRevenue, summaryAvgDuration, summaryAvgCost;
    var tabCompleted, tabActive, panelCompleted, panelActive;
    var activeTableWrapper, activeTbody, activeStateEmpty, activeStateLoading;
    var activeCountBadge, refreshInfo, thActions;
    // Modal elements
    var forceEndModal, flashModalContainer;
    var modalCarName, modalUsername, modalDuration, modalCost, modalHold;
    var modalReason, modalNote, modalCancelBtn, modalConfirmBtn;

    // Shared filter helper (initialised in init after DOM is ready)
    var filterHelper;

    // ---------------------------------------------------------------------------
    // Completed sessions helpers
    // ---------------------------------------------------------------------------

    function renderSummary(summary) {
        if (!summary) {
            summaryGrid.hidden = true;
            return;
        }
        summaryTotal.textContent = String(summary.totalSessions || 0);
        summaryRevenue.textContent = AdminUi.formatMoney(summary.totalRevenue || 0);
        summaryAvgDuration.textContent = AdminUi.formatDuration(summary.avgDurationSeconds || 0);
        summaryAvgCost.textContent = AdminUi.formatMoney(summary.avgCost || 0);
        summaryGrid.hidden = false;
    }

    function renderCompletedRow(item) {
        var tr = document.createElement('tr');

        var tdId = document.createElement('td');
        tdId.className = 'nowrap';
        tdId.textContent = String(item.id || '—');
        tr.appendChild(tdId);

        var tdUser = document.createElement('td');
        tdUser.className = 'nowrap';
        var userText = item.username || (item.user_id ? '#' + item.user_id : '—');
        tdUser.textContent = userText;
        tr.appendChild(tdUser);

        var tdCar = document.createElement('td');
        tdCar.textContent = item.car_name || (item.car_id ? '#' + item.car_id : '—');
        tr.appendChild(tdCar);

        var tdDuration = document.createElement('td');
        tdDuration.className = 'nowrap';
        tdDuration.textContent = AdminUi.formatDuration(item.duration_seconds);
        tr.appendChild(tdDuration);

        var tdCost = document.createElement('td');
        tdCost.className = 'nowrap';
        tdCost.textContent = AdminUi.formatMoney(item.cost);
        tr.appendChild(tdCost);

        var tdDate = document.createElement('td');
        tdDate.className = 'nowrap';
        tdDate.textContent = AdminUi.formatDateTime(item.created_at);
        tr.appendChild(tdDate);

        return tr;
    }

    function loadSessions(filters, page) {
        AdminUi.clearFlash(flashContainer);
        stateLoading.hidden = false;
        stateEmpty.hidden = true;
        tableWrapper.hidden = true;
        paginationEl.hidden = true;
        summaryGrid.hidden = true;

        var qs = filterHelper.buildQuery(filters, page, currentLimit);

        AdminApi.adminFetch('/api/admin/sessions?' + qs)
            .then(function (data) {
                stateLoading.hidden = true;

                renderSummary(data.summary);

                if (!data.items || data.items.length === 0) {
                    stateEmpty.hidden = false;
                    return;
                }

                sessionsTbody.innerHTML = '';
                data.items.forEach(function (item) {
                    sessionsTbody.appendChild(renderCompletedRow(item));
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

    // ---------------------------------------------------------------------------
    // Active sessions helpers
    // ---------------------------------------------------------------------------
    function renderActiveRow(item) {
        var tr = document.createElement('tr');

        var tdUser = document.createElement('td');
        tdUser.className = 'nowrap';
        tdUser.textContent = item.username || (item.userId ? '#' + item.userId : '—');
        tr.appendChild(tdUser);

        var tdCar = document.createElement('td');
        tdCar.textContent = item.carName || (item.carId ? '#' + item.carId : '—');
        tr.appendChild(tdCar);

        var tdStart = document.createElement('td');
        tdStart.className = 'nowrap';
        tdStart.textContent = AdminUi.formatDateTime(item.startTime);
        tr.appendChild(tdStart);

        var tdDur = document.createElement('td');
        tdDur.className = 'nowrap';
        tdDur.textContent = AdminUi.formatDuration(item.durationSeconds);
        tr.appendChild(tdDur);

        var tdHold = document.createElement('td');
        tdHold.className = 'nowrap';
        tdHold.textContent = AdminUi.formatMoney(item.holdAmount);
        tr.appendChild(tdHold);

        var tdCost = document.createElement('td');
        tdCost.className = 'nowrap';
        tdCost.textContent = AdminUi.formatMoney(item.currentCostEstimate);
        tr.appendChild(tdCost);

        // Actions column — force-end button, admin only
        var tdActions = document.createElement('td');
        tdActions.className = 'nowrap';
        if (currentUserRole === 'admin') {
            var btnForceEnd = document.createElement('button');
            btnForceEnd.className = 'btn btn-danger btn-sm';
            btnForceEnd.textContent = 'Завершить принудительно';
            btnForceEnd.setAttribute('data-car-id', String(item.carId));
            btnForceEnd.addEventListener('click', function () {
                openForceEndModal(item);
            });
            tdActions.appendChild(btnForceEnd);
        }
        tr.appendChild(tdActions);

        return tr;
    }

    function loadActiveSessions() {
        if (activeTab !== 'active') return;

        AdminApi.adminFetch('/api/admin/sessions/active')
            .then(function (data) {
                activeStateLoading.hidden = true;

                var items = data.items || [];
                var count = items.length;

                activeCountBadge.textContent = count > 0 ? ' (' + count + ')' : '';

                if (count === 0) {
                    activeTableWrapper.hidden = true;
                    activeStateEmpty.hidden = false;
                    return;
                }

                activeTbody.innerHTML = '';
                items.forEach(function (item) {
                    activeTbody.appendChild(renderActiveRow(item));
                });

                activeStateEmpty.hidden = true;
                activeTableWrapper.hidden = false;
            })
            .catch(function (err) {
                activeStateLoading.hidden = true;
                AdminUi.showFlash(flashActiveContainer, err.message || 'Ошибка загрузки', 'error');
            });
    }

    function startActiveRefresh() {
        stopActiveRefresh();
        activeRefreshTimer = setInterval(function () {
            if (!activeRefreshPaused && activeTab === 'active') {
                loadActiveSessions();
            }
        }, 10000);
    }

    function stopActiveRefresh() {
        if (activeRefreshTimer) {
            clearInterval(activeRefreshTimer);
            activeRefreshTimer = null;
        }
    }

    // ---------------------------------------------------------------------------
    // Force-end modal
    // ---------------------------------------------------------------------------
    function openForceEndModal(item) {
        forceEndTargetCarId = item.carId;
        modalCarName.textContent = item.carName || (item.carId ? '#' + item.carId : '—');
        modalUsername.textContent = item.username || (item.userId ? '#' + item.userId : '—');
        modalDuration.textContent = AdminUi.formatDuration(item.durationSeconds);
        modalCost.textContent = AdminUi.formatMoney(item.currentCostEstimate);
        modalHold.textContent = AdminUi.formatMoney(item.holdAmount);
        modalReason.value = '';
        modalNote.value = '';
        AdminUi.clearFlash(flashModalContainer);
        modalConfirmBtn.disabled = false;
        forceEndModal.hidden = false;
    }

    function closeForceEndModal() {
        forceEndModal.hidden = true;
        forceEndTargetCarId = null;
    }

    function submitForceEnd() {
        var reason = modalReason.value;
        if (!reason) {
            AdminUi.showFlash(flashModalContainer, 'Выберите причину завершения', 'error');
            return;
        }

        modalConfirmBtn.disabled = true;
        AdminUi.clearFlash(flashModalContainer);

        AdminApi.adminFetch(
            '/api/admin/sessions/active/' + forceEndTargetCarId + '/force-end',
            {
                method: 'POST',
                body: { reason: reason, note: modalNote.value.trim() || null },
            }
        ).then(function (data) {
            closeForceEndModal();
            if (data.ended) {
                AdminUi.showFlash(
                    flashActiveContainer,
                    'Сессия завершена: ' + (data.session ? data.session.carName || '' : ''),
                    'success'
                );
            } else {
                AdminUi.showFlash(flashActiveContainer, 'Сессия уже завершена', 'info');
            }
            loadActiveSessions();
        }).catch(function (err) {
            modalConfirmBtn.disabled = false;
            AdminUi.showFlash(flashModalContainer, err.message || 'Ошибка', 'error');
        });
    }

    // ---------------------------------------------------------------------------
    // Tab switching
    // ---------------------------------------------------------------------------
    function showTab(tab) {
        activeTab = tab;
        if (tab === 'completed') {
            tabCompleted.classList.add('active');
            tabActive.classList.remove('active');
            panelCompleted.hidden = false;
            panelActive.hidden = true;
            stopActiveRefresh();
        } else {
            tabActive.classList.add('active');
            tabCompleted.classList.remove('active');
            panelActive.hidden = false;
            panelCompleted.hidden = true;
            // Show loading, then load
            activeStateLoading.hidden = false;
            activeStateEmpty.hidden = true;
            activeTableWrapper.hidden = true;
            loadActiveSessions();
            startActiveRefresh();
        }
    }

    // ---------------------------------------------------------------------------
    // Event handlers
    // ---------------------------------------------------------------------------
    function onApply() {
        currentPage = 1;
        var filters = filterHelper.getFilters();
        filterHelper.syncUrlToState(filters, currentPage);
        loadSessions(filters, currentPage);
    }

    function onReset() {
        filterHelper.resetFilters();
        currentPage = 1;
        history.replaceState(null, '', window.location.pathname);
        loadSessions(filterHelper.getFilters(), currentPage);
    }

    function onPrev() {
        if (currentPage <= 1) return;
        currentPage -= 1;
        var filters = filterHelper.getFilters();
        filterHelper.syncUrlToState(filters, currentPage);
        loadSessions(filters, currentPage);
    }

    function onNext() {
        if (currentPage >= totalPages) return;
        currentPage += 1;
        var filters = filterHelper.getFilters();
        filterHelper.syncUrlToState(filters, currentPage);
        loadSessions(filters, currentPage);
    }

    // ---------------------------------------------------------------------------
    // Load car list for filter dropdown
    // ---------------------------------------------------------------------------
    function loadCars() {
        var fCarId = document.getElementById('f-car-id');
        return fetch('/api/cars', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var cars = data.cars || [];
                cars.forEach(function (car) {
                    var opt = document.createElement('option');
                    opt.value = String(car.id);
                    opt.textContent = car.name;
                    fCarId.appendChild(opt);
                });
            })
            .catch(function () { /* ignore — dropdown will just show "all" */ });
    }

    // ---------------------------------------------------------------------------
    // Page Visibility API for active sessions refresh
    // ---------------------------------------------------------------------------
    function setupVisibility() {
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                activeRefreshPaused = true;
            } else {
                activeRefreshPaused = false;
                if (activeTab === 'active') {
                    loadActiveSessions();
                }
            }
        });
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    function init() {
        flashContainer = document.getElementById('flash-container');
        flashActiveContainer = document.getElementById('flash-active-container');
        btnApply = document.getElementById('btn-apply');
        btnReset = document.getElementById('btn-reset');
        btnPrev = document.getElementById('btn-prev');
        btnNext = document.getElementById('btn-next');
        tableWrapper = document.getElementById('table-wrapper');
        sessionsTbody = document.getElementById('sessions-tbody');
        stateEmpty = document.getElementById('state-empty');
        stateLoading = document.getElementById('state-loading');
        paginationEl = document.getElementById('pagination');
        paginationInfo = document.getElementById('pagination-info');
        summaryGrid = document.getElementById('summary-grid');
        summaryTotal = document.getElementById('summary-total');
        summaryRevenue = document.getElementById('summary-revenue');
        summaryAvgDuration = document.getElementById('summary-avg-duration');
        summaryAvgCost = document.getElementById('summary-avg-cost');
        tabCompleted = document.getElementById('tab-completed');
        tabActive = document.getElementById('tab-active');
        panelCompleted = document.getElementById('panel-completed');
        panelActive = document.getElementById('panel-active');
        activeTableWrapper = document.getElementById('active-table-wrapper');
        activeTbody = document.getElementById('active-tbody');
        activeStateEmpty = document.getElementById('active-state-empty');
        activeStateLoading = document.getElementById('active-state-loading');
        activeCountBadge = document.getElementById('active-count-badge');
        refreshInfo = document.getElementById('refresh-info');
        thActions = document.getElementById('th-actions');
        // Modal
        forceEndModal = document.getElementById('force-end-modal');
        flashModalContainer = document.getElementById('flash-modal-container');
        modalCarName = document.getElementById('modal-car-name');
        modalUsername = document.getElementById('modal-username');
        modalDuration = document.getElementById('modal-duration');
        modalCost = document.getElementById('modal-cost');
        modalHold = document.getElementById('modal-hold');
        modalReason = document.getElementById('modal-reason');
        modalNote = document.getElementById('modal-note');
        modalCancelBtn = document.getElementById('modal-cancel-btn');
        modalConfirmBtn = document.getElementById('modal-confirm-btn');

        // Initialise filter helper with the sessions filter field map
        filterHelper = AdminFilters.create({
            car_id:    'f-car-id',
            user_id:   'f-user-id',
            date_from: 'f-date-from',
            date_to:   'f-date-to',
            min_cost:  'f-min-cost',
            max_cost:  'f-max-cost',
        });

        btnApply.addEventListener('click', onApply);
        btnReset.addEventListener('click', onReset);
        btnPrev.addEventListener('click', onPrev);
        btnNext.addEventListener('click', onNext);
        tabCompleted.addEventListener('click', function () { showTab('completed'); });
        tabActive.addEventListener('click', function () { showTab('active'); });
        modalCancelBtn.addEventListener('click', closeForceEndModal);
        modalConfirmBtn.addEventListener('click', submitForceEnd);
        // Close modal on backdrop click
        forceEndModal.addEventListener('click', function (e) {
            if (e.target === forceEndModal) closeForceEndModal();
        });

        setupVisibility();

        AdminApi.requireAdmin()
            .then(function (user) {
                currentUserRole = user.role;
                // Show the actions column header for admins
                if (currentUserRole === 'admin' && thActions) {
                    thActions.hidden = false;
                }
                document.getElementById('admin-loading').hidden = true;
                document.getElementById('admin-content').hidden = false;
                // Load cars first so that the filter dropdown is ready before hydrating the form
                return loadCars();
            })
            .then(function () {
                currentPage = filterHelper.hydrateFormFromUrl();
                loadSessions(filterHelper.getFilters(), currentPage);
            })
            .catch(function () { /* requireAdmin handles redirects */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
