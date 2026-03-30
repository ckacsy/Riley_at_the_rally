'use strict';

(function () {
    var currentAdminUser = null;
    var pendingCarId = null;

    // ---------------------------------------------------------------------------
    // Flash messages
    // ---------------------------------------------------------------------------
    function showFlash(message, type) {
        var container = document.getElementById('flash-container');
        if (!container) return;
        var el = document.createElement('div');
        el.className = 'admin-flash admin-flash--' + (type || 'info');
        el.textContent = message;
        container.appendChild(el);
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 5000);
    }

    function clearFlash() {
        var container = document.getElementById('flash-container');
        if (container) container.innerHTML = '';
    }

    // ---------------------------------------------------------------------------
    // Badge rendering
    // ---------------------------------------------------------------------------
    function statusBadge(status) {
        var map = {
            available:   { cls: 'badge--available',   text: 'Доступна' },
            unavailable: { cls: 'badge--unavailable', text: 'Занята' },
            maintenance: { cls: 'badge--maintenance', text: 'На обслуживании' },
        };
        var info = map[status] || { cls: '', text: status };
        return '<span class="badge ' + info.cls + '">' + info.text + '</span>';
    }

    // ---------------------------------------------------------------------------
    // Render cars grid
    // ---------------------------------------------------------------------------
    function renderCars(cars) {
        var grid = document.getElementById('cars-grid');
        var loading = document.getElementById('cars-loading');
        var errEl = document.getElementById('cars-error');
        if (loading) loading.hidden = true;
        if (errEl) errEl.hidden = true;

        if (!cars || cars.length === 0) {
            if (grid) { grid.hidden = true; grid.innerHTML = ''; }
            if (errEl) { errEl.hidden = false; errEl.textContent = 'Машины не найдены.'; }
            return;
        }

        grid.innerHTML = '';
        cars.forEach(function (car) {
            var card = document.createElement('div');
            card.className = 'car-card' + (car.status === 'maintenance' ? ' is-maintenance' : '');
            card.dataset.carId = car.id;

            var headerHtml = '<div class="car-card-header">' +
                '<div>' +
                '<div class="car-card-name">' + escapeHtml(car.name) + '</div>' +
                '<div class="car-card-model">' + escapeHtml(car.model || '') + '</div>' +
                '</div>' +
                statusBadge(car.status) +
                '</div>';

            var reasonHtml = '';
            if (car.maintenance && car.maintenance.reason) {
                reasonHtml = '<div class="car-card-reason">' +
                    '<div class="car-card-reason-label">Причина</div>' +
                    escapeHtml(car.maintenance.reason) +
                    '</div>';
            }

            var actionBtn = '';
            if (car.status === 'maintenance') {
                actionBtn = '<button class="btn btn-maintenance-disable" data-action="disable" data-car-id="' + car.id + '">' +
                    'Снять с обслуживания</button>';
            } else {
                actionBtn = '<button class="btn btn-maintenance-enable" data-action="enable" data-car-id="' + car.id + '">' +
                    'На обслуживание</button>';
            }

            card.innerHTML = headerHtml + reasonHtml +
                '<div class="car-card-actions">' + actionBtn + '</div>';

            // Cross-links: Investigation and Audit (created via DOM for XSS safety)
            var crossLinksDiv = document.createElement('div');
            crossLinksDiv.className = 'cross-link-group';

            var investLink = document.createElement('a');
            investLink.className = 'cross-link';
            investLink.href = '/admin-investigation?car_id=' + encodeURIComponent(car.id);
            investLink.textContent = '🔍 Расследование';
            investLink.title = 'Расследование по машине';
            crossLinksDiv.appendChild(investLink);

            var auditLink = document.createElement('a');
            auditLink.className = 'cross-link';
            auditLink.href = '/admin-audit?target_type=car&target_id=' + encodeURIComponent(car.id);
            auditLink.textContent = '📋 Аудит';
            auditLink.title = 'Аудит по машине';
            crossLinksDiv.appendChild(auditLink);

            card.appendChild(crossLinksDiv);
            grid.appendChild(card);
        });

        grid.hidden = false;

        // Attach button listeners
        grid.querySelectorAll('[data-action]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var action = btn.dataset.action;
                var carId = parseInt(btn.dataset.carId, 10);
                var carData = cars.find(function (c) { return c.id === carId; });
                if (!carData) return;
                if (action === 'enable') {
                    openEnableModal(carData);
                } else {
                    openDisableModal(carData);
                }
            });
        });
    }

    // ---------------------------------------------------------------------------
    // Load cars
    // ---------------------------------------------------------------------------
    function loadCars() {
        var loading = document.getElementById('cars-loading');
        var errEl = document.getElementById('cars-error');
        var grid = document.getElementById('cars-grid');
        if (loading) loading.hidden = false;
        if (errEl) errEl.hidden = true;
        if (grid) grid.hidden = true;

        AdminApi.adminFetch('/api/admin/cars')
            .then(function (data) {
                renderCars(data.cars || []);
            })
            .catch(function (err) {
                if (loading) loading.hidden = true;
                if (errEl) { errEl.hidden = false; errEl.textContent = 'Ошибка загрузки: ' + (err.message || 'неизвестная ошибка'); }
            });
    }

    // ---------------------------------------------------------------------------
    // Enable maintenance modal
    // ---------------------------------------------------------------------------
    function openEnableModal(car) {
        pendingCarId = car.id;
        var nameEl = document.getElementById('modal-enable-car-name');
        var reasonInput = document.getElementById('modal-reason');
        if (nameEl) nameEl.textContent = car.name;
        if (reasonInput) reasonInput.value = '';
        document.getElementById('modal-enable').classList.add('visible');
        if (reasonInput) setTimeout(function () { reasonInput.focus(); }, 50);
    }

    function closeEnableModal() {
        document.getElementById('modal-enable').classList.remove('visible');
        pendingCarId = null;
    }

    // ---------------------------------------------------------------------------
    // Disable maintenance modal
    // ---------------------------------------------------------------------------
    function openDisableModal(car) {
        pendingCarId = car.id;
        var nameEl = document.getElementById('modal-disable-car-name');
        var reasonEl = document.getElementById('modal-disable-reason');
        if (nameEl) nameEl.textContent = car.name;
        if (reasonEl) {
            reasonEl.textContent = (car.maintenance && car.maintenance.reason)
                ? ('Причина: ' + car.maintenance.reason)
                : '';
        }
        document.getElementById('modal-disable').classList.add('visible');
    }

    function closeDisableModal() {
        document.getElementById('modal-disable').classList.remove('visible');
        pendingCarId = null;
    }

    // ---------------------------------------------------------------------------
    // Submit maintenance toggle
    // ---------------------------------------------------------------------------
    function submitMaintenanceToggle(enabled, reason) {
        var carId = pendingCarId;
        if (!carId) return;

        var body = { enabled: enabled };
        if (enabled) body.reason = reason;

        var confirmBtn = document.getElementById(enabled ? 'modal-enable-confirm' : 'modal-disable-confirm');
        if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Сохранение…'; }

        clearFlash();

        AdminApi.adminFetch('/api/admin/cars/' + carId + '/maintenance', {
            method: 'POST',
            body: body,
        })
            .then(function () {
                if (enabled) {
                    closeEnableModal();
                    showFlash('Машина переведена в режим обслуживания.', 'success');
                } else {
                    closeDisableModal();
                    showFlash('Машина снята с обслуживания.', 'success');
                }
                loadCars();
            })
            .catch(function (err) {
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = enabled ? 'Поставить на обслуживание' : 'Снять с обслуживания'; }
                showFlash('Ошибка: ' + (err.message || 'неизвестная ошибка'), 'error');
            });
    }

    // ---------------------------------------------------------------------------
    // HTML escape
    // ---------------------------------------------------------------------------
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    AdminApi.requireStrictAdmin()
        .then(function (user) {
            currentAdminUser = user;
            document.getElementById('admin-loading').hidden = true;
            document.getElementById('admin-content').hidden = false;
            loadCars();
        })
        .catch(function () { /* requireStrictAdmin handles redirects */ });

    // Modal event listeners
    document.getElementById('modal-enable-cancel').addEventListener('click', closeEnableModal);
    document.getElementById('modal-disable-cancel').addEventListener('click', closeDisableModal);

    document.getElementById('modal-enable-confirm').addEventListener('click', function () {
        var reasonInput = document.getElementById('modal-reason');
        var reason = reasonInput ? reasonInput.value.trim() : '';
        // Client-side guard for immediate UX feedback (backend also validates)
        if (!reason) {
            reasonInput && reasonInput.focus();
            showFlash('Укажите причину обслуживания.', 'error');
            return;
        }
        submitMaintenanceToggle(true, reason);
    });

    document.getElementById('modal-disable-confirm').addEventListener('click', function () {
        submitMaintenanceToggle(false, null);
    });

    // Close modal on overlay click
    document.getElementById('modal-enable').addEventListener('click', function (e) {
        if (e.target === this) closeEnableModal();
    });
    document.getElementById('modal-disable').addEventListener('click', function (e) {
        if (e.target === this) closeDisableModal();
    });
})();
