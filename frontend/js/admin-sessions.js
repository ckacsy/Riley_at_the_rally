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

    // ---------------------------------------------------------------------------
    // DOM references (set in init)
    // ---------------------------------------------------------------------------
    var flashContainer, flashActiveContainer;
    var fCarId, fUserId, fDateFrom, fDateTo, fMinCost, fMaxCost;
    var btnApply, btnReset, btnPrev, btnNext;
    var tableWrapper, sessionsTbody, stateEmpty, stateLoading, paginationEl, paginationInfo;
    var summaryGrid, summaryTotal, summaryRevenue, summaryAvgDuration, summaryAvgCost;
    var tabCompleted, tabActive, panelCompleted, panelActive;
    var activeTableWrapper, activeTbody, activeStateEmpty, activeStateLoading;
    var activeCountBadge, refreshInfo;

    // ---------------------------------------------------------------------------
    // Completed sessions helpers
    // ---------------------------------------------------------------------------
    function getFilters() {
        return {
            car_id: fCarId.value.trim(),
            user_id: fUserId.value.trim(),
            date_from: fDateFrom.value.trim(),
            date_to: fDateTo.value.trim(),
            min_cost: fMinCost.value.trim(),
            max_cost: fMaxCost.value.trim(),
        };
    }

    function buildQuery(filters, page, limit) {
        var params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', String(limit));
        if (filters.car_id) params.set('car_id', filters.car_id);
        if (filters.user_id) params.set('user_id', filters.user_id);
        if (filters.date_from) params.set('date_from', filters.date_from);
        if (filters.date_to) params.set('date_to', filters.date_to);
        if (filters.min_cost) params.set('min_cost', filters.min_cost);
        if (filters.max_cost) params.set('max_cost', filters.max_cost);
        return params.toString();
    }

    function syncUrlToState(filters, page) {
        var params = new URLSearchParams();
        if (page > 1) params.set('page', String(page));
        if (filters.car_id) params.set('car_id', filters.car_id);
        if (filters.user_id) params.set('user_id', filters.user_id);
        if (filters.date_from) params.set('date_from', filters.date_from);
        if (filters.date_to) params.set('date_to', filters.date_to);
        if (filters.min_cost) params.set('min_cost', filters.min_cost);
        if (filters.max_cost) params.set('max_cost', filters.max_cost);
        var qs = params.toString();
        history.replaceState(null, '', qs ? '?' + qs : window.location.pathname);
    }

    function hydrateFormFromUrl() {
        var params = new URLSearchParams(window.location.search);
        fCarId.value = params.get('car_id') || '';
        fUserId.value = params.get('user_id') || '';
        fDateFrom.value = params.get('date_from') || '';
        fDateTo.value = params.get('date_to') || '';
        fMinCost.value = params.get('min_cost') || '';
        fMaxCost.value = params.get('max_cost') || '';
        var p = parseInt(params.get('page') || '1', 10);
        currentPage = (p >= 1) ? p : 1;
    }

    function renderSummary(summary) {
        if (!summary) {
            summaryGrid.hidden = true;
            return;
        }
        summaryTotal.textContent = String(summary.totalSessions || 0);
        summaryRevenue.textContent = (summary.totalRevenue || 0).toFixed(2) + ' RC';
        summaryAvgDuration.textContent = AdminUi.formatDuration(summary.avgDurationSeconds || 0);
        summaryAvgCost.textContent = (summary.avgCost || 0).toFixed(2) + ' RC';
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
        tdCost.textContent = item.cost != null ? item.cost.toFixed(2) + ' RC' : '—';
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

        var qs = buildQuery(filters, page, currentLimit);

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
        tdHold.textContent = item.holdAmount != null ? item.holdAmount.toFixed(2) + ' RC' : '—';
        tr.appendChild(tdHold);

        var tdCost = document.createElement('td');
        tdCost.className = 'nowrap';
        tdCost.textContent = item.currentCostEstimate != null
            ? item.currentCostEstimate.toFixed(2) + ' RC' : '—';
        tr.appendChild(tdCost);

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
        var filters = getFilters();
        syncUrlToState(filters, currentPage);
        loadSessions(filters, currentPage);
    }

    function onReset() {
        fCarId.value = '';
        fUserId.value = '';
        fDateFrom.value = '';
        fDateTo.value = '';
        fMinCost.value = '';
        fMaxCost.value = '';
        currentPage = 1;
        history.replaceState(null, '', window.location.pathname);
        loadSessions(getFilters(), currentPage);
    }

    function onPrev() {
        if (currentPage <= 1) return;
        currentPage -= 1;
        var filters = getFilters();
        syncUrlToState(filters, currentPage);
        loadSessions(filters, currentPage);
    }

    function onNext() {
        if (currentPage >= totalPages) return;
        currentPage += 1;
        var filters = getFilters();
        syncUrlToState(filters, currentPage);
        loadSessions(filters, currentPage);
    }

    // ---------------------------------------------------------------------------
    // Load car list for filter dropdown
    // ---------------------------------------------------------------------------
    function loadCars() {
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
        fCarId = document.getElementById('f-car-id');
        fUserId = document.getElementById('f-user-id');
        fDateFrom = document.getElementById('f-date-from');
        fDateTo = document.getElementById('f-date-to');
        fMinCost = document.getElementById('f-min-cost');
        fMaxCost = document.getElementById('f-max-cost');
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

        btnApply.addEventListener('click', onApply);
        btnReset.addEventListener('click', onReset);
        btnPrev.addEventListener('click', onPrev);
        btnNext.addEventListener('click', onNext);
        tabCompleted.addEventListener('click', function () { showTab('completed'); });
        tabActive.addEventListener('click', function () { showTab('active'); });

        setupVisibility();

        AdminApi.requireAdmin()
            .then(function () {
                document.getElementById('admin-loading').hidden = true;
                document.getElementById('admin-content').hidden = false;
                // Load cars first so that the filter dropdown is ready before hydrating the form
                return loadCars();
            })
            .then(function () {
                hydrateFormFromUrl();
                loadSessions(getFilters(), currentPage);
            })
            .catch(function () { /* requireAdmin handles redirects */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
