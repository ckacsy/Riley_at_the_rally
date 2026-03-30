'use strict';

if (typeof AdminUi === 'undefined') throw new Error('admin-ui.js must be loaded before admin-analytics.js');
if (typeof AdminApi === 'undefined') throw new Error('admin-api.js must be loaded before admin-analytics.js');

/**
 * Admin analytics dashboard.
 * Read-only KPI and breakdown view for admin.
 * Admin only — uses requireStrictAdmin().
 */
(function () {
    // ---------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------
    var currentPreset = '30d';
    var customFrom = '';
    var customTo = '';

    // ---------------------------------------------------------------------------
    // DOM references (set in init)
    // ---------------------------------------------------------------------------
    var pageLoading, mainContent, flashContainer;
    var presetBtns, customRangeEl, dateFromEl, dateToEl, btnApplyCustom;
    var analyticsContent, stateLoading, stateEmpty;
    var kpiGrid, txtypeGrid, carsBarList, topusersBarList, timeseriesBarList;

    // ---------------------------------------------------------------------------
    // Period helpers
    // ---------------------------------------------------------------------------
    function buildQueryParams() {
        var params = new URLSearchParams();
        if (currentPreset === 'custom') {
            if (customFrom) params.set('date_from', customFrom);
            if (customTo) params.set('date_to', customTo);
        } else {
            params.set('period', currentPreset);
        }
        return params;
    }

    function syncUrlState() {
        var params = buildQueryParams();
        var newUrl = window.location.pathname + '?' + params.toString();
        history.replaceState(null, '', newUrl);
    }

    function hydrateFromUrl() {
        var params = new URLSearchParams(window.location.search);
        var dateFrom = params.get('date_from');
        var dateTo = params.get('date_to');
        var period = params.get('period');

        if (dateFrom || dateTo) {
            currentPreset = 'custom';
            customFrom = dateFrom || '';
            customTo = dateTo || '';
            if (dateFromEl) dateFromEl.value = customFrom;
            if (dateToEl) dateToEl.value = customTo;
        } else if (period && ['7d', '30d', '90d', 'all'].includes(period)) {
            currentPreset = period;
        }

        updatePresetButtons();
        toggleCustomRange();
    }

    function updatePresetButtons() {
        presetBtns.forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.preset === currentPreset);
        });
    }

    function toggleCustomRange() {
        customRangeEl.hidden = currentPreset !== 'custom';
    }

    // ---------------------------------------------------------------------------
    // Rendering helpers
    // ---------------------------------------------------------------------------
    function makeKpiCard(label, value) {
        var card = document.createElement('div');
        card.className = 'kpi-card';
        var lbl = document.createElement('div');
        lbl.className = 'kpi-card-label';
        lbl.textContent = label;
        var val = document.createElement('div');
        val.className = 'kpi-card-value';
        val.textContent = value;
        card.appendChild(lbl);
        card.appendChild(val);
        return card;
    }

    function makeBreakdownCard(label, value, sub) {
        var card = document.createElement('div');
        card.className = 'breakdown-card';
        var lbl = document.createElement('div');
        lbl.className = 'breakdown-card-label';
        lbl.textContent = label;
        var val = document.createElement('div');
        val.className = 'breakdown-card-value';
        val.textContent = value;
        card.appendChild(lbl);
        card.appendChild(val);
        if (sub != null) {
            var subEl = document.createElement('div');
            subEl.className = 'breakdown-card-sub';
            subEl.textContent = sub;
            card.appendChild(subEl);
        }
        return card;
    }

    function makeBarRow(name, meta, pct, colorClass) {
        var row = document.createElement('div');
        row.className = 'bar-row';

        var header = document.createElement('div');
        header.className = 'bar-row-header';

        var nameEl = document.createElement('span');
        nameEl.className = 'bar-row-name';
        nameEl.textContent = name;

        var metaEl = document.createElement('span');
        metaEl.className = 'bar-row-meta';
        metaEl.textContent = meta;

        header.appendChild(nameEl);
        header.appendChild(metaEl);

        var track = document.createElement('div');
        track.className = 'bar-track';
        var fill = document.createElement('div');
        fill.className = 'bar-fill' + (colorClass ? ' ' + colorClass : '');
        fill.style.width = Math.max(0, Math.min(100, pct || 0)).toFixed(1) + '%';
        track.appendChild(fill);

        row.appendChild(header);
        row.appendChild(track);
        return row;
    }

    // ---------------------------------------------------------------------------
    // Render overview
    // ---------------------------------------------------------------------------
    function renderOverview(data) {
        // KPI cards
        kpiGrid.innerHTML = '';
        var kpi = data.kpi || {};
        kpiGrid.appendChild(makeKpiCard('Всего пользователей', String(kpi.totalUsers || 0)));
        kpiGrid.appendChild(makeKpiCard('Сессий за период', String(kpi.totalSessions || 0)));
        kpiGrid.appendChild(makeKpiCard('Доход за период', AdminUi.formatMoney(kpi.totalRevenue || 0)));
        kpiGrid.appendChild(makeKpiCard('Ср. длит. сессии', AdminUi.formatDuration(kpi.avgSessionDuration || 0)));
        kpiGrid.appendChild(makeKpiCard('Ср. стоимость сессии', AdminUi.formatMoney(kpi.avgSessionCost || 0)));

        // Transaction type breakdown
        txtypeGrid.innerHTML = '';
        var byType = data.byTransactionType || [];
        if (byType.length === 0) {
            var noTx = document.createElement('div');
            noTx.className = 'breakdown-card-label';
            noTx.textContent = 'Нет транзакций за период';
            txtypeGrid.appendChild(noTx);
        } else {
            byType.forEach(function (row) {
                var card = makeBreakdownCard(
                    AdminUi.typeBadgeLabel(row.type),
                    AdminUi.formatMoney(row.total || 0),
                    row.count + ' операций'
                );
                card.querySelector('.breakdown-card-label').className += ' badge-type badge-type--' + (row.type || 'unknown');
                txtypeGrid.appendChild(card);
            });
        }

        // Car breakdown bars
        carsBarList.innerHTML = '';
        var byCar = data.byCarId || [];
        if (byCar.length === 0) {
            var noCar = document.createElement('div');
            noCar.className = 'state-empty';
            noCar.style.padding = '20px 0';
            noCar.textContent = 'Нет данных по машинам';
            carsBarList.appendChild(noCar);
        } else {
            var maxCarRev = Math.max.apply(null, byCar.map(function (r) { return r.totalRevenue || 0; }));
            byCar.forEach(function (row) {
                var pct = maxCarRev > 0 ? (row.totalRevenue / maxCarRev) * 100 : 0;
                var meta = AdminUi.formatMoney(row.totalRevenue || 0) + ' · ' + (row.sessionCount || 0) + ' сессий';
                carsBarList.appendChild(makeBarRow(row.car_name || ('Машина #' + row.car_id), meta, pct, 'bar-fill--green'));
            });
        }

        // Top users bars
        topusersBarList.innerHTML = '';
        var topUsers = data.topUsersBySpend || [];
        if (topUsers.length === 0) {
            var noUsers = document.createElement('div');
            noUsers.className = 'state-empty';
            noUsers.style.padding = '20px 0';
            noUsers.textContent = 'Нет данных по пользователям';
            topusersBarList.appendChild(noUsers);
        } else {
            var maxSpend = Math.max.apply(null, topUsers.map(function (r) { return r.totalSpend || 0; }));
            topUsers.forEach(function (row) {
                var pct = maxSpend > 0 ? (row.totalSpend / maxSpend) * 100 : 0;
                var meta = AdminUi.formatMoney(row.totalSpend || 0) + ' · ' + (row.sessionCount || 0) + ' сессий';
                topusersBarList.appendChild(makeBarRow(row.username || ('user_' + row.user_id), meta, pct, 'bar-fill--amber'));
            });
        }
    }

    // ---------------------------------------------------------------------------
    // Render timeseries
    // ---------------------------------------------------------------------------
    function renderTimeseries(data) {
        timeseriesBarList.innerHTML = '';
        var days = data.days || [];
        if (days.length === 0) {
            var noDays = document.createElement('div');
            noDays.className = 'state-empty';
            noDays.style.padding = '20px 0';
            noDays.textContent = 'Нет данных за выбранный период';
            timeseriesBarList.appendChild(noDays);
            return;
        }

        var maxRev = Math.max.apply(null, days.map(function (d) { return d.revenue || 0; }));
        // Render recent days last (already sorted asc, show descending for readability)
        var sorted = days.slice().reverse();
        sorted.forEach(function (day) {
            var pct = maxRev > 0 ? (day.revenue / maxRev) * 100 : 0;
            var meta = AdminUi.formatMoney(day.revenue || 0) + ' · ' + (day.sessions || 0) + ' сессий · пополн. ' + AdminUi.formatMoney(day.topups || 0);
            timeseriesBarList.appendChild(makeBarRow(day.date, meta, pct));
        });
    }

    // ---------------------------------------------------------------------------
    // Load data
    // ---------------------------------------------------------------------------
    function loadAnalytics() {
        AdminUi.clearFlash(flashContainer);
        analyticsContent.hidden = true;
        stateLoading.hidden = false;
        stateEmpty.hidden = true;

        var params = buildQueryParams();
        var overviewUrl = '/api/admin/analytics/overview?' + params.toString();
        var timeseriesUrl = '/api/admin/analytics/timeseries?' + params.toString();

        Promise.all([
            AdminApi.adminFetch(overviewUrl),
            AdminApi.adminFetch(timeseriesUrl),
        ])
            .then(function (results) {
                stateLoading.hidden = true;
                var overviewData = results[0];
                var timeseriesData = results[1];

                var kpi = overviewData.kpi || {};
                var hasData = kpi.totalSessions > 0 ||
                    (overviewData.byCarId && overviewData.byCarId.length > 0) ||
                    (overviewData.topUsersBySpend && overviewData.topUsersBySpend.length > 0);

                if (!hasData && kpi.totalUsers === 0) {
                    stateEmpty.hidden = false;
                    return;
                }

                renderOverview(overviewData);
                renderTimeseries(timeseriesData);
                analyticsContent.hidden = false;
            })
            .catch(function (err) {
                stateLoading.hidden = true;
                AdminUi.showFlash(flashContainer, 'Ошибка загрузки данных: ' + (err && err.message ? err.message : String(err)), 'error');
            });
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    function init() {
        pageLoading = document.getElementById('page-loading');
        mainContent = document.getElementById('main-content');
        flashContainer = document.getElementById('flash-container');
        presetBtns = Array.from(document.querySelectorAll('.btn-preset'));
        customRangeEl = document.getElementById('custom-range');
        dateFromEl = document.getElementById('date-from');
        dateToEl = document.getElementById('date-to');
        btnApplyCustom = document.getElementById('btn-apply-custom');
        analyticsContent = document.getElementById('analytics-content');
        stateLoading = document.getElementById('state-loading');
        stateEmpty = document.getElementById('state-empty');
        kpiGrid = document.getElementById('kpi-grid');
        txtypeGrid = document.getElementById('txtype-grid');
        carsBarList = document.getElementById('cars-bar-list');
        topusersBarList = document.getElementById('topusers-bar-list');
        timeseriesBarList = document.getElementById('timeseries-bar-list');

        // Auth guard: admin only
        AdminApi.requireStrictAdmin()
            .then(function () {
                pageLoading.hidden = true;
                mainContent.hidden = false;

                hydrateFromUrl();
                loadAnalytics();
            })
            .catch(function () { /* requireStrictAdmin handles redirects */ });

        // Period preset buttons
        presetBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                currentPreset = btn.dataset.preset;
                updatePresetButtons();
                toggleCustomRange();

                if (currentPreset !== 'custom') {
                    syncUrlState();
                    loadAnalytics();
                }
            });
        });

        // Custom range apply
        btnApplyCustom.addEventListener('click', function () {
            customFrom = dateFromEl.value;
            customTo = dateToEl.value;
            if (!customFrom || !customTo) {
                AdminUi.showFlash(flashContainer, 'Укажите обе даты', 'error');
                return;
            }
            syncUrlState();
            loadAnalytics();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
