'use strict';

if (typeof AdminUi === 'undefined') throw new Error('admin-ui.js must be loaded before admin-investigation.js');
if (typeof AdminApi === 'undefined') throw new Error('admin-api.js must be loaded before admin-investigation.js');
if (typeof AdminFilters === 'undefined') throw new Error('admin-filters.js must be loaded before admin-investigation.js');

/**
 * Admin investigation dashboard.
 * Unified chronological event timeline for admin investigations.
 * Admin only — uses requireStrictAdmin().
 */
(function () {
    // ---------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------
    var currentPage = 1;
    var currentLimit = 50;
    var totalPages = 1;

    // ---------------------------------------------------------------------------
    // DOM references (set in init)
    // ---------------------------------------------------------------------------
    var flashContainer;
    var btnApply, btnReset, btnPrev, btnNext;
    var timelineList, stateHint, stateEmpty, stateLoading, paginationEl, paginationInfo;
    var entityPanel, entityPanelTitle, entityPanelBody, entityPanelClose;

    // Shared filter helper
    var filterHelper;

    // ---------------------------------------------------------------------------
    // Source metadata
    // ---------------------------------------------------------------------------
    var SOURCE_META = {
        transaction:  { label: '💳 Транзакция',  cls: 'transaction' },
        session:      { label: '🏎️ Сессия',       cls: 'session' },
        audit:        { label: '📋 Аудит',        cls: 'audit' },
        maintenance:  { label: '🔧 Обслуживание', cls: 'maintenance' },
    };

    // ---------------------------------------------------------------------------
    // Timeline rendering
    // ---------------------------------------------------------------------------
    function renderTimeline(items) {
        timelineList.innerHTML = '';

        items.forEach(function (item) {
            var meta = SOURCE_META[item.source] || { label: item.source, cls: 'audit' };
            var d = item.details || {};

            var el = document.createElement('div');
            el.className = 'timeline-item';

            // Header row
            var header = document.createElement('div');
            header.className = 'timeline-item-header';

            var badge = document.createElement('span');
            badge.className = 'timeline-badge timeline-badge--' + meta.cls;
            badge.textContent = meta.label;
            header.appendChild(badge);

            var timeEl = document.createElement('span');
            timeEl.className = 'timeline-time';
            timeEl.textContent = AdminUi.formatDateTime(item.created_at);
            header.appendChild(timeEl);

            var summary = document.createElement('span');
            summary.className = 'timeline-summary';
            summary.textContent = item.summary;
            header.appendChild(summary);

            var toggleBtn = document.createElement('button');
            toggleBtn.className = 'timeline-toggle';
            toggleBtn.textContent = '▶ детали';
            header.appendChild(toggleBtn);

            el.appendChild(header);

            // Details section (hidden by default)
            var detailsEl = document.createElement('div');
            detailsEl.className = 'timeline-details';
            detailsEl.hidden = true;
            detailsEl.appendChild(buildDetailsTable(item));
            detailsEl.appendChild(buildLinks(item));
            el.appendChild(detailsEl);

            toggleBtn.addEventListener('click', function () {
                detailsEl.hidden = !detailsEl.hidden;
                toggleBtn.textContent = detailsEl.hidden ? '▶ детали' : '▼ скрыть';
            });

            timelineList.appendChild(el);
        });
    }

    function buildDetailsTable(item) {
        var d = item.details || {};
        var table = document.createElement('table');
        var rows = [];

        if (item.source === 'transaction') {
            rows = [
                ['ID', d.id],
                ['Тип', d.type],
                ['Сумма', d.amount != null ? AdminUi.formatMoney(d.amount, { signed: true }) : '—'],
                ['Баланс после', d.balance_after != null ? AdminUi.formatMoney(d.balance_after) : '—'],
                ['Пользователь', buildEntityLinkEl('user', d.user_id, d.username)],
                ['Описание', d.description],
                ['Reference ID', d.reference_id || '—'],
                ['Админ', d.admin_username || (d.admin_id ? '#' + d.admin_id : '—')],
            ];
        } else if (item.source === 'session') {
            rows = [
                ['ID', d.id],
                ['Пользователь', buildEntityLinkEl('user', d.user_id, d.username)],
                ['Машина', d.car_name || ('Машина #' + d.car_id)],
                ['Длительность', d.duration_seconds != null ? AdminUi.formatDuration(d.duration_seconds) : '—'],
                ['Стоимость', d.cost != null ? AdminUi.formatMoney(d.cost) : '—'],
                ['Session Ref', d.session_ref || '—'],
            ];
        } else if (item.source === 'audit') {
            rows = [
                ['ID', d.id],
                ['Действие', d.action],
                ['Объект', d.target_type + ' #' + d.target_id],
                ['Админ', d.admin_username || (d.admin_id ? '#' + d.admin_id : '—')],
                ['Детали', d.details ? JSON.stringify(d.details, null, 0) : '—'],
            ];
        } else if (item.source === 'maintenance') {
            rows = [
                ['Машина', 'Машина #' + d.car_id],
                ['Статус', d.enabled ? 'ТО включён' : 'ТО выключен'],
                ['Причина', d.reason || '—'],
                ['Админ', d.admin_username || (d.admin_id ? '#' + d.admin_id : '—')],
            ];
        }

        rows.forEach(function (row) {
            var tr = document.createElement('tr');
            var tdLabel = document.createElement('td');
            tdLabel.textContent = row[0];
            tr.appendChild(tdLabel);
            var tdVal = document.createElement('td');
            if (row[1] instanceof Node) {
                tdVal.appendChild(row[1]);
            } else {
                tdVal.textContent = row[1] != null ? String(row[1]) : '—';
            }
            tr.appendChild(tdVal);
            table.appendChild(tr);
        });

        return table;
    }

    function buildEntityLinkEl(type, id, label) {
        if (!id) {
            var span = document.createElement('span');
            span.textContent = label || '—';
            return span;
        }
        var a = document.createElement('span');
        a.className = 'entity-link';
        a.textContent = label ? String(label) + ' (#' + id + ')' : '#' + id;
        a.setAttribute('data-entity-type', type);
        a.setAttribute('data-entity-id', String(id));
        a.addEventListener('click', function () {
            openEntityPanel(type, id);
        });
        return a;
    }

    function buildLinks(item) {
        var d = item.details || {};
        var linksEl = document.createElement('div');
        linksEl.className = 'timeline-links';

        if (item.source === 'transaction') {
            if (d.user_id) {
                addLink(linksEl, 'Пользователь →', '/admin-users?user_id=' + d.user_id);
                addLink(linksEl, 'Транзакции →', '/admin-transactions?user_id=' + d.user_id);
            }
            if (d.reference_id) {
                addLink(linksEl, 'По Reference →', '/admin-investigation?reference_id=' + encodeURIComponent(d.reference_id));
            }
        } else if (item.source === 'session') {
            if (d.user_id) {
                addLink(linksEl, 'Пользователь →', '/admin-users?user_id=' + d.user_id);
                addLink(linksEl, 'Транзакции →', '/admin-transactions?user_id=' + d.user_id);
            }
            if (d.car_id) {
                addLink(linksEl, 'Машины →', '/admin-cars');
            }
            if (d.session_ref) {
                addLink(linksEl, 'Транзакции по ref →', '/admin-transactions?reference_id=' + encodeURIComponent(d.session_ref));
            }
        } else if (item.source === 'audit') {
            if (d.target_type === 'user' && d.target_id) {
                addLink(linksEl, 'Пользователь →', '/admin-users?user_id=' + d.target_id);
            }
        } else if (item.source === 'maintenance') {
            if (d.car_id) {
                addLink(linksEl, 'Машины →', '/admin-cars');
                addLink(linksEl, 'Сессии по машине →', '/admin-sessions?car_id=' + d.car_id);
            }
        }

        return linksEl;
    }

    function addLink(container, text, href) {
        var a = document.createElement('a');
        a.className = 'timeline-link';
        a.href = href;
        a.textContent = text;
        container.appendChild(a);
    }

    // ---------------------------------------------------------------------------
    // Entity side panel
    // ---------------------------------------------------------------------------
    function openEntityPanel(type, id) {
        entityPanelTitle.textContent = type === 'user' ? 'Пользователь #' + id
                                     : type === 'session' ? 'Сессия #' + id
                                     : 'Машина #' + id;
        entityPanelBody.innerHTML = '<div class="state-msg">Загрузка…</div>';
        entityPanel.classList.add('open');

        AdminApi.adminFetch('/api/admin/investigation/entity/' + encodeURIComponent(type) + '/' + encodeURIComponent(id))
            .then(function (data) {
                renderEntityPanel(data);
            })
            .catch(function (err) {
                entityPanelBody.innerHTML = '';
                var msg = document.createElement('div');
                msg.className = 'state-msg';
                msg.textContent = 'Ошибка: ' + (err.message || 'Не удалось загрузить');
                entityPanelBody.appendChild(msg);
            });
    }

    function renderEntityPanel(data) {
        entityPanelBody.innerHTML = '';

        if (data.type === 'user') {
            var u = data.entity;
            var fields = [
                ['ID', u.id],
                ['Логин', u.username],
                ['Email', u.email],
                ['Статус', u.status],
                ['Роль', u.role],
                ['Баланс', AdminUi.formatMoney(u.balance)],
                ['Создан', AdminUi.formatDateTime(u.created_at)],
            ];
            appendFields(entityPanelBody, fields);
            var linksEl = document.createElement('div');
            linksEl.className = 'timeline-links';
            addLink(linksEl, 'Открыть профиль →', '/admin-users?user_id=' + u.id);
            addLink(linksEl, 'Транзакции →', '/admin-transactions?user_id=' + u.id);
            addLink(linksEl, 'Таймлайн →', '/admin-investigation?user_id=' + u.id);
            entityPanelBody.appendChild(linksEl);
        } else if (data.type === 'session') {
            var s = data.entity;
            var fields = [
                ['ID', s.id],
                ['Пользователь', s.username ? s.username + ' (#' + s.user_id + ')' : '#' + s.user_id],
                ['Машина', s.car_name || ('Машина #' + s.car_id)],
                ['Длительность', s.duration_seconds != null ? AdminUi.formatDuration(s.duration_seconds) : '—'],
                ['Стоимость', s.cost != null ? AdminUi.formatMoney(s.cost) : '—'],
                ['Session Ref', s.session_ref || '—'],
                ['Дата', AdminUi.formatDateTime(s.created_at)],
            ];
            appendFields(entityPanelBody, fields);
            if (Array.isArray(data.transactions) && data.transactions.length > 0) {
                var h = document.createElement('div');
                h.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.45);margin:10px 0 4px;';
                h.textContent = 'Связанные транзакции (' + data.transactions.length + ')';
                entityPanelBody.appendChild(h);
                data.transactions.forEach(function (t) {
                    var row = document.createElement('div');
                    row.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.65);padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05);';
                    row.textContent = AdminUi.formatDateTime(t.created_at) + ' · ' + t.type + ' · ' + AdminUi.formatMoney(t.amount, { signed: true });
                    entityPanelBody.appendChild(row);
                });
            }
        } else if (data.type === 'car') {
            var c = data.entity;
            var fields = [
                ['ID машины', c.car_id],
                ['Сессий всего', c.recent_sessions_count],
            ];
            if (c.maintenance) {
                var m = c.maintenance;
                fields.push(['Режим ТО', m.enabled ? 'Включён' : 'Выключен']);
                if (m.reason) fields.push(['Причина', m.reason]);
                if (m.admin_username) fields.push(['Обновил', m.admin_username]);
                fields.push(['Дата изменения', AdminUi.formatDateTime(m.created_at)]);
            } else {
                fields.push(['Режим ТО', 'Нет данных']);
            }
            appendFields(entityPanelBody, fields);
            var linksEl = document.createElement('div');
            linksEl.className = 'timeline-links';
            addLink(linksEl, 'Машины →', '/admin-cars');
            addLink(linksEl, 'Сессии →', '/admin-sessions?car_id=' + c.car_id);
            addLink(linksEl, 'Таймлайн →', '/admin-investigation?car_id=' + c.car_id);
            entityPanelBody.appendChild(linksEl);
        }
    }

    function appendFields(container, fields) {
        fields.forEach(function (f) {
            var div = document.createElement('div');
            div.className = 'entity-field';
            var label = document.createElement('div');
            label.className = 'entity-field-label';
            label.textContent = f[0];
            var value = document.createElement('div');
            value.className = 'entity-field-value';
            value.textContent = f[1] != null ? String(f[1]) : '—';
            div.appendChild(label);
            div.appendChild(value);
            container.appendChild(div);
        });
    }

    // ---------------------------------------------------------------------------
    // Load timeline
    // ---------------------------------------------------------------------------
    function loadTimeline(filters, page) {
        stateHint.hidden = true;
        stateEmpty.hidden = true;
        stateLoading.hidden = false;
        timelineList.hidden = true;
        paginationEl.hidden = true;

        AdminUi.clearFlash(flashContainer);

        var qs = filterHelper.buildQuery(filters, page, currentLimit);
        AdminApi.adminFetch('/api/admin/investigation/timeline?' + qs.toString())
            .then(function (data) {
                stateLoading.hidden = true;

                if (!data.items || data.items.length === 0) {
                    stateEmpty.hidden = false;
                    return;
                }

                var pag = data.pagination || {};
                totalPages = pag.pages || 1;
                currentPage = pag.page || 1;

                renderTimeline(data.items);
                timelineList.hidden = false;

                // Pagination
                paginationInfo.textContent = 'Стр. ' + currentPage + ' из ' + totalPages + ' (' + (pag.total || 0) + ' событий)';
                btnPrev.disabled = currentPage <= 1;
                btnNext.disabled = currentPage >= totalPages;
                paginationEl.hidden = totalPages <= 1;
            })
            .catch(function (err) {
                stateLoading.hidden = true;
                AdminUi.showFlash(flashContainer, err.message || 'Ошибка загрузки', 'error');
            });
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    function init() {
        flashContainer = document.getElementById('flash-container');
        stateHint = document.getElementById('state-hint');
        stateEmpty = document.getElementById('state-empty');
        stateLoading = document.getElementById('state-loading');
        timelineList = document.getElementById('timeline-list');
        paginationEl = document.getElementById('pagination');
        paginationInfo = document.getElementById('pagination-info');
        btnApply = document.getElementById('btn-apply');
        btnReset = document.getElementById('btn-reset');
        btnPrev = document.getElementById('btn-prev');
        btnNext = document.getElementById('btn-next');
        entityPanel = document.getElementById('entity-panel');
        entityPanelTitle = document.getElementById('entity-panel-title');
        entityPanelBody = document.getElementById('entity-panel-body');
        entityPanelClose = document.getElementById('entity-panel-close');

        filterHelper = AdminFilters.create({
            user_id: 'f-user-id',
            car_id: 'f-car-id',
            reference_id: 'f-reference-id',
            date_from: 'f-date-from',
            date_to: 'f-date-to',
        });

        entityPanelClose.addEventListener('click', function () {
            entityPanel.classList.remove('open');
        });

        btnApply.addEventListener('click', function () {
            currentPage = 1;
            var filters = filterHelper.getFilters();
            filterHelper.syncUrlToState(filters, currentPage);
            loadTimeline(filters, currentPage);
        });

        btnReset.addEventListener('click', function () {
            filterHelper.resetFilters();
            currentPage = 1;
            filterHelper.syncUrlToState({}, currentPage);
            stateHint.hidden = false;
            stateEmpty.hidden = true;
            stateLoading.hidden = true;
            timelineList.hidden = true;
            paginationEl.hidden = true;
            AdminUi.clearFlash(flashContainer);
        });

        btnPrev.addEventListener('click', function () {
            if (currentPage > 1) {
                currentPage--;
                var filters = filterHelper.getFilters();
                filterHelper.syncUrlToState(filters, currentPage);
                loadTimeline(filters, currentPage);
            }
        });

        btnNext.addEventListener('click', function () {
            if (currentPage < totalPages) {
                currentPage++;
                var filters = filterHelper.getFilters();
                filterHelper.syncUrlToState(filters, currentPage);
                loadTimeline(filters, currentPage);
            }
        });

        // Auto-load if URL params are present
        currentPage = filterHelper.hydrateFormFromUrl();
        var urlFilters = filterHelper.getFilters();
        var hasFilter = Object.values(urlFilters).some(function (v) { return v !== ''; });
        if (hasFilter) {
            loadTimeline(urlFilters, currentPage);
        }
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
