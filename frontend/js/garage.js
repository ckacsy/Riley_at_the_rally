        var socket = io(window.location.origin);

        // Hook global reliability layer for reconnect UX
        if (window.Reliability) {
            window.Reliability.installSocketReliability(socket);
        }

        var currentUser = null;
        var ratePerMinute = 0.50;
        var availableCars = [];
        var carAvailabilityStatus = 'available';
        window._carAvailabilityStatus = 'available';
        window._carStatusMap = {};
        var isFullscreen = false;

        // Generic panel collapse helper
        function createPanelCollapse(panelEl, toggleBtnEl, storageKey, iconMap) {
            var collapsed = localStorage.getItem(storageKey) === 'true';

            function apply(isCollapsed) {
                collapsed = isCollapsed;
                panelEl.classList.toggle('collapsed', isCollapsed);
                toggleBtnEl.textContent = isCollapsed ? iconMap.collapsed : iconMap.expanded;
                localStorage.setItem(storageKey, isCollapsed ? 'true' : 'false');
            }

            toggleBtnEl.addEventListener('click', function () { apply(!collapsed); });
            apply(collapsed);

            return {
                isCollapsed: function () { return collapsed; },
                setCollapsed: function (v) { apply(v); }
            };
        }

        // Apply autohide: if setting is on, force collapse state at startup
        if (localStorage.getItem('garageAutoHideLeft') === 'true') {
            localStorage.setItem('garageLeftCollapsed', 'true');
        }
        if (localStorage.getItem('garageAutoHideRight') === 'true') {
            localStorage.setItem('garageRightCollapsed', 'true');
        }

        // Left panel collapse
        var leftPanelCollapse = createPanelCollapse(
            document.getElementById('left-panel'),
            document.getElementById('panel-toggle'),
            'garageLeftCollapsed',
            { collapsed: '\u25b6', expanded: '\u25c4' }
        );

        // Right panel collapse
        var rightPanelCollapse = createPanelCollapse(
            document.getElementById('right-panel'),
            document.getElementById('right-panel-toggle'),
            'garageRightCollapsed',
            { collapsed: '\u25c4', expanded: '\u25b6' }
        );

        // Click on collapsed right panel icons → expand panel
        document.querySelectorAll('.rp-icon').forEach(function(icon) {
            icon.addEventListener('click', function() {
                if (rightPanelCollapse.isCollapsed()) {
                    rightPanelCollapse.setCollapsed(false);
                }
            });
        });

        // Tab switching (auto-expands left panel if collapsed)
        document.querySelectorAll('.tab-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (leftPanelCollapse.isCollapsed()) {
                    leftPanelCollapse.setCollapsed(false);
                }
                document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
                document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
                btn.classList.add('active');
                var tc = document.getElementById('tab-' + btn.getAttribute('data-tab'));
                if (tc) tc.classList.add('active');
            });
        });

        // Controls tab accordion
        document.querySelectorAll('.control-scheme-header').forEach(function(header) {
            header.addEventListener('click', function() {
                var card = this.closest('.control-scheme-card');
                card.classList.toggle('open');
            });
        });

        // ---- Upgrades tab: card data & rendering ----
        (function () {
            var upgradeCards = [
                { name: 'Мотор',   icon: '⚡',  color: '#ff4444', level: 3, maxLevel: 10, desc: 'Мощность двигателя. Влияет на максимальную скорость' },
                { name: 'Колёса',  icon: '🛞',  color: '#44ff44', level: 2, maxLevel: 10, desc: 'Сцепление с трассой. Влияет на управляемость в поворотах' },
                { name: 'Кузов',   icon: '🛡️', color: '#4488ff', level: 4, maxLevel: 10, desc: 'Аэродинамика и защита. Снижает сопротивление воздуха' },
                { name: 'Батарея', icon: '🔋',  color: '#ffcc00', level: 1, maxLevel: 10, desc: 'Ёмкость аккумулятора. Влияет на время заезда' },
                { name: 'Пульт',   icon: '📡',  color: '#aa44ff', level: 5, maxLevel: 10, desc: 'Качество связи. Снижает задержку управления' },
                { name: 'Прочее',  icon: '🔧',  color: '#ff8844', level: 2, maxLevel: 10, desc: 'Дополнительные модификации и тюнинг' }
            ];
            var tabEl = document.getElementById('tab-upgrades');
            var container = tabEl && tabEl.querySelector('.upgrades-tab-content');
            if (!container) return;
            upgradeCards.forEach(function (card) {
                var maxLevel = card.maxLevel > 0 ? card.maxLevel : 10;
                var pct = Math.round((card.level / maxLevel) * 100);

                var cardEl = document.createElement('div');
                cardEl.className = 'upgrade-card';
                cardEl.style.borderLeftColor = card.color;

                var header = document.createElement('div');
                header.className = 'upgrade-card-header';

                var iconEl = document.createElement('span');
                iconEl.className = 'upgrade-card-icon';
                iconEl.textContent = card.icon;

                var titleEl = document.createElement('span');
                titleEl.className = 'upgrade-card-title';
                titleEl.textContent = card.name;

                var levelEl = document.createElement('span');
                levelEl.className = 'upgrade-card-level';
                levelEl.textContent = 'Ур. ' + card.level + '/' + maxLevel;

                header.appendChild(iconEl);
                header.appendChild(titleEl);
                header.appendChild(levelEl);

                var track = document.createElement('div');
                track.className = 'upgrade-progress-track';
                var fill = document.createElement('div');
                fill.className = 'upgrade-progress-fill';
                fill.style.width = pct + '%';
                fill.style.background = card.color;
                track.appendChild(fill);

                var desc = document.createElement('p');
                desc.className = 'upgrade-card-desc';
                desc.textContent = card.desc;

                var footer = document.createElement('div');
                footer.className = 'upgrade-card-footer';
                var soonLabel = document.createElement('span');
                soonLabel.className = 'upgrade-soon-label';
                soonLabel.textContent = '🚧 Скоро';
                var btn = document.createElement('button');
                btn.className = 'btn-upgrade';
                btn.disabled = true;
                btn.textContent = '🔒 Улучшить';
                footer.appendChild(soonLabel);
                footer.appendChild(btn);

                cardEl.appendChild(header);
                cardEl.appendChild(track);
                cardEl.appendChild(desc);
                cardEl.appendChild(footer);
                container.appendChild(cardEl);
            });
        }());

        // Fullscreen toggle
        function toggleFullscreen(force) {
            isFullscreen = (force !== undefined) ? !!force : !isFullscreen;
            document.getElementById('left-panel').classList.toggle('hidden-panel', isFullscreen);
            document.getElementById('carousel-wrap').classList.toggle('hidden-panel', isFullscreen);
            var rp = document.getElementById('right-panel');
            if (rp) rp.classList.toggle('hidden-panel', isFullscreen);
            var ctaWrap = document.getElementById('center-cta-wrap');
            if (ctaWrap) ctaWrap.classList.toggle('hidden-panel', isFullscreen);
            var btn = document.getElementById('fullscreen-btn');
            btn.classList.toggle('active', isFullscreen);
            btn.textContent = isFullscreen ? '\u26f6 \u041f\u0430\u043d\u0435\u043b\u0438' : '\u26f6 \u041f\u043e\u043b\u043d\u044b\u0439 \u044d\u043a\u0440\u0430\u043d';
            var showUiBtn = document.getElementById('show-ui-btn');
            if (showUiBtn) showUiBtn.style.display = isFullscreen ? 'block' : 'none';
        }
        document.getElementById('fullscreen-btn').addEventListener('click', function () { toggleFullscreen(); });
        var showUiBtnEl = document.getElementById('show-ui-btn');
        if (showUiBtnEl) showUiBtnEl.addEventListener('click', function () { toggleFullscreen(false); });
        document.addEventListener('keydown', function (e) {
            if (e.code === 'Space' && !['INPUT','TEXTAREA','SELECT','BUTTON'].includes(document.activeElement.tagName)) {
                e.preventDefault(); toggleFullscreen();
            }
        });

        // Carousel filters
        ['filter-class', 'filter-type', 'filter-avail'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('change', function () { if (window._renderCarousel) window._renderCarousel(); });
        });
        var searchEl = document.getElementById('carousel-search');
        if (searchEl) searchEl.addEventListener('input', function () { if (window._renderCarousel) window._renderCarousel(); });

        // Settings toggles
        document.getElementById('setting-autorotate').addEventListener('change', function () { if (window._garageScene) window._garageScene.setAutoRotate(this.checked); });

        // Auto-hide settings: init checkboxes from localStorage and wire change handlers
        var autoHideLeftEl = document.getElementById('setting-autohide-left');
        if (autoHideLeftEl) {
            autoHideLeftEl.checked = localStorage.getItem('garageAutoHideLeft') === 'true';
            autoHideLeftEl.addEventListener('change', function () {
                localStorage.setItem('garageAutoHideLeft', this.checked ? 'true' : 'false');
            });
        }
        var autoHideRightEl = document.getElementById('setting-autohide-right');
        if (autoHideRightEl) {
            autoHideRightEl.checked = localStorage.getItem('garageAutoHideRight') === 'true';
            autoHideRightEl.addEventListener('change', function () {
                localStorage.setItem('garageAutoHideRight', this.checked ? 'true' : 'false');
            });
        }

        var qualityEl = document.getElementById('setting-3d-quality');
        if (qualityEl) {
            var savedQ = localStorage.getItem('garageQuality') || 'auto';
            qualityEl.value = savedQ;
            qualityEl.addEventListener('change', function () {
                var val = this.value;
                if (val === 'auto') {
                    localStorage.removeItem('garageQuality');
                } else {
                    localStorage.setItem('garageQuality', val);
                }
            });
        }

        // Status bar polling
        var sbServerDot  = document.getElementById('sb-server-dot');
        var sbServerText = document.getElementById('sb-server-text');
        var sbPing       = document.getElementById('sb-ping');
        var sbCarState   = document.getElementById('sb-car-state');

        function pollStatusBar() {
            var t0 = Date.now();
            fetch('/api/health', { credentials: 'same-origin' })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok && d.ok, ping: Date.now() - t0 }; }); })
                .then(function (res) {
                    sbPing.textContent = res.ping + ' \u043c\u0441';
                    if (res.ok) {
                        sbServerDot.className = 'sb-dot green';
                        sbServerText.textContent = '\u041e\u043d\u043b\u0430\u0439\u043d';
                    } else {
                        sbServerDot.className = 'sb-dot orange';
                        sbServerText.textContent = '\u041f\u0440\u043e\u0431\u043b\u0435\u043c\u044b';
                    }
                })
                .catch(function () {
                    sbPing.textContent = '\u2014';
                    sbServerDot.className = 'sb-dot red';
                    sbServerText.textContent = '\u041e\u0444\u043b\u0430\u0439\u043d';
                });
        }

        function updateCarStateLabel() {
            var map = {
                available:   '🟢 Свободна',
                busy:        '🟡 Занята',
                offline:     '🔴 Недоступна',
                maintenance: '🔧 На обслуживании'
            };
            sbCarState.textContent = map[carAvailabilityStatus] || carAvailabilityStatus;
        }

        pollStatusBar();
        setInterval(pollStatusBar, 5000);

        // Auth
        var csrfToken = '';
        fetch('/api/csrf-token', { credentials: 'same-origin' }).then(function(r){return r.json();}).then(function(d){csrfToken=d.csrfToken||'';loadAuth();});

        function loadAuth() {
            fetch('/api/auth/me', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (data) { currentUser = data.user || null; renderAuthChip(); updateCTA(); loadDailyBonusStatus(); loadRankBadge(); })
                .catch(function () { currentUser = null; renderAuthChip(); updateCTA(); loadDailyBonusStatus(); renderGuestRankBadge(); });
        }

        // ---- Rank badge (profile card) ----
        function renderGuestRankBadge() {
            var el = document.getElementById('profile-rank-badge');
            if (!el || typeof window.RankUI === 'undefined') return;
            el.innerHTML = '<span class="rank-badge rank-badge-guest">—</span>';
        }

        function loadRankBadge() {
            var el = document.getElementById('profile-rank-badge');
            if (!el || typeof window.RankUI === 'undefined') return;
            if (!currentUser) { renderGuestRankBadge(); return; }
            el.innerHTML = window.RankUI.renderRankBadge(null, { loading: true });
            fetch('/api/profile/rank', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (!el) return;
                    if (!data) { el.innerHTML = '<span class="rank-badge rank-badge-guest">—</span>'; return; }
                    el.innerHTML = window.RankUI.renderRankBadge(data, { size: 'normal' });
                })
                .catch(function () {
                    if (el) el.innerHTML = '<span class="rank-badge rank-badge-guest">—</span>';
                });
        }

        // ---- Live rankings (ratings tab) ----
        var _rankingsTimer = null;
        var _rankingsLoaded = false;

        function loadRankings() {
            var container = document.getElementById('rankings-container');
            if (!container || typeof window.RankUI === 'undefined') return;
            if (!_rankingsLoaded) {
                container.innerHTML = '<div class="rankings-loading">Загрузка рейтинга…</div>';
            }
            fetch('/api/rankings', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (!container) return;
                    if (!data) {
                        container.innerHTML = '<div class="rankings-error">Не удалось загрузить рейтинг</div>';
                        return;
                    }
                    _rankingsLoaded = true;
                    window.RankUI.renderRankings(container, data);
                })
                .catch(function () {
                    if (container) container.innerHTML = '<div class="rankings-error">Ошибка загрузки рейтинга</div>';
                });
        }

        // Auto-refresh rankings every 30 s when tab is visible
        document.querySelectorAll('.tab-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var tab = btn.getAttribute('data-tab');
                if (tab === 'ratings') {
                    loadRankings();
                    if (!_rankingsTimer) {
                        _rankingsTimer = setInterval(loadRankings, 30000);
                    }
                } else {
                    if (_rankingsTimer) {
                        clearInterval(_rankingsTimer);
                        _rankingsTimer = null;
                    }
                }
            });
        });

        // Clear rankings timer when page is unloaded
        window.addEventListener('beforeunload', function () {
            if (_rankingsTimer) {
                clearInterval(_rankingsTimer);
                _rankingsTimer = null;
            }
        });

        // Balance
        var currentBalance = 0;
        var currentActiveHold = 0;

        function loadBalance() {
            fetch('/api/balance', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (!data) return;
                    currentBalance = data.balance || 0;
                    currentActiveHold = data.activeHold || 0;
                    var el = document.getElementById('rp-credits');
                    if (el) el.textContent = currentBalance.toFixed(2) + ' RC';
                    updateCTA();
                })
                .catch(function () {});
        }

        // Top-up modal
        (function () {
            var overlay = document.getElementById('topup-overlay');
            var statusEl = document.getElementById('topup-status');

            document.getElementById('topup-btn').addEventListener('click', function () {
                if (!currentUser) { window.location.href = '/login?redirect=/garage'; return; }
                statusEl.style.display = 'none';
                statusEl.className = 'topup-status';
                overlay.classList.add('visible');
            });

            document.getElementById('topup-close').addEventListener('click', function () {
                overlay.classList.remove('visible');
            });

            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) overlay.classList.remove('visible');
            });

            document.querySelectorAll('.topup-amount-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var amount = parseInt(this.getAttribute('data-amount'), 10);
                    var allBtns = document.querySelectorAll('.topup-amount-btn');
                    allBtns.forEach(function (b) { b.disabled = true; });
                    statusEl.style.display = 'none';

                    fetch('/api/payment/create', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
                        body: JSON.stringify({ amount: amount })
                    })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        if (data.confirmationUrl) {
                            window.location.href = data.confirmationUrl;
                        } else if (data.mock) {
                            currentBalance = data.balance || currentBalance;
                            var el = document.getElementById('rp-credits');
                            if (el) el.textContent = currentBalance.toFixed(2) + ' RC';
                            statusEl.textContent = '✅ Баланс пополнен на ' + amount + ' RC';
                            statusEl.className = 'topup-status success';
                            statusEl.style.display = 'block';
                            updateCTA();
                            setTimeout(function () { overlay.classList.remove('visible'); }, 2000);
                        } else {
                            statusEl.textContent = data.error || 'Ошибка создания платежа';
                            statusEl.className = 'topup-status error';
                            statusEl.style.display = 'block';
                        }
                    })
                    .catch(function () {
                        statusEl.textContent = 'Ошибка сети. Попробуйте снова.';
                        statusEl.className = 'topup-status error';
                        statusEl.style.display = 'block';
                    })
                    .finally(function () {
                        allBtns.forEach(function (b) { b.disabled = false; });
                    });
                });
            });
        })();

        function renderAuthChip() {
            var profileEl = document.getElementById('profile-username');
            var avatarEl = document.querySelector('.profile-avatar');
            if (currentUser) {
                if (profileEl) profileEl.textContent = currentUser.username;
                if (avatarEl) {
                    if (currentUser.avatar_path) {
                        var img = document.createElement('img');
                        img.src = currentUser.avatar_path;
                        img.alt = '\u0410\u0432\u0430\u0442\u0430\u0440';
                        img.style.cssText = 'width:36px;height:36px;border-radius:50%;object-fit:cover;';
                        avatarEl.innerHTML = '';
                        avatarEl.appendChild(img);
                    } else {
                        avatarEl.innerHTML = '&#x1F464;';
                    }
                }
            } else {
                if (profileEl) profileEl.textContent = '\u0413\u043e\u0441\u0442\u044c';
                if (avatarEl) avatarEl.innerHTML = '&#x1F464;';
            }
        }

        function updateCTA() {
            var btn = document.getElementById('cta-btn');
            var fallbackBtn = document.getElementById('fallback-cta-btn');
            var centerBtn = document.getElementById('center-cta-btn');
            function setFallback(text, disabled, fn) {
                if (!fallbackBtn) return;
                fallbackBtn.textContent = text; fallbackBtn.disabled = disabled; fallbackBtn.onclick = fn || null;
            }
            function setCenter(text, disabled, cls, fn) {
                if (!centerBtn) return;
                centerBtn.textContent = text; centerBtn.disabled = disabled;
                centerBtn.className = 'cta-btn' + (cls ? ' ' + cls : '');
                centerBtn.onclick = fn || null;
            }
            function setBtn(text, disabled, cls, fn) {
                if (!btn) return;
                btn.textContent = text; btn.className = 'cta-btn' + (cls ? ' ' + cls : '');
                btn.disabled = disabled; btn.onclick = fn || null;
            }
            if (!currentUser) {
                setBtn('\u0422\u043e\u043b\u044c\u043a\u043e \u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440 / \u0412\u043e\u0439\u0442\u0438', false, 'observer', function () { window.location.href = '/login?redirect=/garage'; });
                setFallback('\u0412\u043e\u0439\u0442\u0438', false, function () { window.location.href = '/login?redirect=/garage'; });
                setCenter('\u0412\u043e\u0439\u0442\u0438', false, 'observer', function () { window.location.href = '/login?redirect=/garage'; });
            } else if (currentUser.status === 'banned' || currentUser.status === 'disabled') {
                setBtn('\u0410\u043a\u043a\u0430\u0443\u043d\u0442 \u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d', true, '', null);
                setFallback('\u0410\u043a\u043a\u0430\u0443\u043d\u0442 \u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d', true, null);
                setCenter('\u0410\u043a\u043a\u0430\u0443\u043d\u0442 \u0437\u0430\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d', true, '', null);
            } else if (currentUser.status === 'pending') {
                setBtn('\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435 email', false, '', function () { window.location.href = '/verify-email'; });
                setFallback('\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435 email', false, function () { window.location.href = '/verify-email'; });
                setCenter('\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435 email', false, '', function () { window.location.href = '/verify-email'; });
            } else if (currentUser.status !== 'active') {
                setBtn('\u0410\u043a\u043a\u0430\u0443\u043d\u0442 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d', true, '', null);
                setFallback('\u0410\u043a\u043a\u0430\u0443\u043d\u0442 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d', true, null);
                setCenter('\u0410\u043a\u043a\u0430\u0443\u043d\u0442 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d', true, '', null);
            } else {
            var activeIdx = window._activeVariant || 0;
            var variants = window.CAR_VARIANTS_REF || [];
            var selectedVariant = variants[activeIdx];
            var perCarStatus = selectedVariant && window._carStatusMap ? window._carStatusMap[selectedVariant.id] : null;
            var effectiveStatus = perCarStatus || carAvailabilityStatus;
            if (effectiveStatus === 'busy' || effectiveStatus === 'unavailable') {
                setBtn('\u041c\u0430\u0448\u0438\u043d\u0430 \u0437\u0430\u043d\u044f\u0442\u0430', true, '', null);
                setFallback('\u041c\u0430\u0448\u0438\u043d\u0430 \u0437\u0430\u043d\u044f\u0442\u0430', true, null);
                setCenter('\u041c\u0430\u0448\u0438\u043d\u0430 \u0437\u0430\u043d\u044f\u0442\u0430', true, '', null);
            } else if (effectiveStatus === 'offline') {
                setBtn('\u041c\u0430\u0448\u0438\u043d\u0430 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430', true, '', null);
                setFallback('\u041c\u0430\u0448\u0438\u043d\u0430 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430', true, null);
                setCenter('\u041c\u0430\u0448\u0438\u043d\u0430 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430', true, '', null);
            } else if (effectiveStatus === 'maintenance') {
                setBtn('\u041d\u0430 \u043e\u0431\u0441\u043b\u0443\u0436\u0438\u0432\u0430\u043d\u0438\u0438', true, '', null);
                setFallback('\u041d\u0430 \u043e\u0431\u0441\u043b\u0443\u0436\u0438\u0432\u0430\u043d\u0438\u0438', true, null);
                setCenter('\u041d\u0430 \u043e\u0431\u0441\u043b\u0443\u0436\u0438\u0432\u0430\u043d\u0438\u0438', true, '', null);
            } else if ((currentBalance + currentActiveHold) < 100) {
                setBtn('\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e RC (\u043c\u0438\u043d. 100)', true, '', null);
                setFallback('\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e RC', true, null);
                setCenter('\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e RC (\u043c\u0438\u043d. 100)', true, '', null);
            } else {
                setBtn('\u041d\u0410 \u0422\u0420\u0415\u041a', false, '', startSession);
                setFallback('\u041d\u0410 \u0422\u0420\u0415\u041a', false, startSession);
                setCenter('\u041d\u0410 \u0422\u0420\u0415\u041a', false, '', startSession);
            }
            }
        }

        function renderAvailabilityBadge() {
            var t = { available: '\u0414\u043e\u0441\u0442\u0443\u043f\u043d\u0430', busy: '\u0417\u0430\u043d\u044f\u0442\u0430', offline: '\u041d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430', maintenance: '\u041d\u0430 \u043e\u0431\u0441\u043b\u0443\u0436\u0438\u0432\u0430\u043d\u0438\u0438' };
            var text = t[carAvailabilityStatus] || carAvailabilityStatus;
            var css  = 'car-availability-badge status-' + carAvailabilityStatus;
            var badge = document.getElementById('car-availability-badge');
            if (badge) {
                badge.className = css;
                var bavText = document.getElementById('car-availability-text');
                if (bavText) bavText.textContent = text;
            }
            var fb = document.getElementById('fallback-availability-badge');
            if (fb) { fb.className = css; document.getElementById('fallback-availability-text').textContent = text; }
            updateCarStateLabel();
        }

        function loadCarStatus() {
            fetch('/api/car-status', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    carAvailabilityStatus = data.status || 'available';
                    window._carAvailabilityStatus = carAvailabilityStatus;
                    renderAvailabilityBadge(); updateCTA();
                    if (window._renderCarousel) window._renderCarousel();
                })
                .catch(function (err) {
                    console.warn('car-status fetch failed:', err);
                    carAvailabilityStatus = 'available';
                    window._carAvailabilityStatus = 'available';
                    renderAvailabilityBadge();
                });
        }

        function loadCars() {
            fetch('/api/cars', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    ratePerMinute = data.ratePerMinute || ratePerMinute;
                    var cars = data.cars || [];
                    window._allCarsData = cars;
                    availableCars = cars.filter(function (c) { return c.status === 'available'; });
                    var newMap = {};
                    cars.forEach(function (c) { newMap[c.id] = c.status === 'unavailable' ? 'busy' : (c.status || 'available'); });
                    window._carStatusMap = newMap;
                    if (typeof window._renderCarousel === 'function') window._renderCarousel();
                })
                .catch(function () {});
        }

        function loadLeaderboard() {
            fetch('/api/leaderboard?range=all', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    var rows = data.leaderboard || [];
                    var container = document.getElementById('lb-preview');
                    if (!container) return;
                    container.innerHTML = '';
                    if (!rows.length) {
                        container.innerHTML = '<div class="lb-row lb-row--empty">\u041d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445</div>';
                        return;
                    }
                    rows.slice(0, 5).forEach(function (row, i) {
                        var ms  = row.lapTimeMs || 0;
                        var lapTimeStr = (ms / 1000).toFixed(3);
                        var el  = document.createElement('div');
                        el.className = 'lb-row';
                        var rankSpan = document.createElement('span');
                        rankSpan.className = 'lb-rank';
                        rankSpan.textContent = i + 1;
                        var nameSpan = document.createElement('span');
                        nameSpan.className = 'lb-name';
                        nameSpan.textContent = row.userId || '\u2014';
                        var timeSpan = document.createElement('span');
                        timeSpan.className = 'lb-time';
                        timeSpan.textContent = lapTimeStr + '\u0441';
                        el.appendChild(rankSpan);
                        el.appendChild(nameSpan);
                        el.appendChild(timeSpan);
                        container.appendChild(el);
                    });
                })
                .catch(function () {
                    var c = document.getElementById('lb-preview');
                    if (c) c.innerHTML = '<div class="lb-row lb-row--empty">\u041e\u0448\u0438\u0431\u043a\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043a\u0438</div>';
                });
        }

        socket.on('cars_updated', function (data) {
            var cars = data.cars || [];
            availableCars = cars.filter(function (c) { return c.status === 'available'; });
            // Build per-car status map
            var newMap = {};
            cars.forEach(function (c) { newMap[c.id] = c.status === 'unavailable' ? 'busy' : c.status; });
            window._carStatusMap = newMap;
            // Update global status for the selected car
            var activeVariantRef = window.CAR_VARIANTS_REF && window.CAR_VARIANTS_REF[window._activeVariant || 0];
            var activeCarId = activeVariantRef ? activeVariantRef.id : null;
            if (activeCarId != null && newMap[activeCarId] != null) {
                carAvailabilityStatus = newMap[activeCarId];
            } else {
                var anyBusy = cars.some(function (c) { return c.status === 'unavailable'; });
                var anyMaint = cars.some(function (c) { return c.status === 'maintenance'; });
                carAvailabilityStatus = anyBusy ? 'busy' : (anyMaint ? 'maintenance' : 'available');
            }
            window._carAvailabilityStatus = carAvailabilityStatus;
            renderAvailabilityBadge();
            updateCTA();
            if (typeof window._renderCarousel === 'function') { window._renderCarousel(); }
        });

        // Start session (existing flow unchanged)
        function startSession() {
            if (!currentUser) { window.location.href = '/login?redirect=/garage'; return; }

            // Check balance before starting
            if (currentBalance < 100) {
                alert('\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u0441\u0440\u0435\u0434\u0441\u0442\u0432. \u041c\u0438\u043d\u0438\u043c\u0430\u043b\u044c\u043d\u044b\u0439 \u0431\u0430\u043b\u0430\u043d\u0441: 100 RC. \u041f\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435 \u0431\u0430\u043b\u0430\u043d\u0441.');
                document.getElementById('topup-overlay').classList.add('visible');
                return;
            }

            // Determine the selected car from the carousel
            var activeIdx = window._activeVariant || 0;
            var variants = window.CAR_VARIANTS_REF || [];
            var selectedVariant = variants[activeIdx];
            if (!selectedVariant) {
                alert('\u041c\u0430\u0448\u0438\u043d\u0430 \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d\u0430.');
                return;
            }
            // Check per-car status
            var statusMap = window._carStatusMap || {};
            var carStatus = statusMap[selectedVariant.id];
            if (carStatus === 'busy' || carStatus === 'unavailable') {
                alert('\u042d\u0442\u0430 \u043c\u0430\u0448\u0438\u043d\u0430 \u0441\u0435\u0439\u0447\u0430\u0441 \u0437\u0430\u043d\u044f\u0442\u0430. \u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u0443\u044e.');
                return;
            }
            if (carStatus === 'offline') {
                alert('\u042d\u0442\u0430 \u043c\u0430\u0448\u0438\u043d\u0430 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430.');
                return;
            }
            if (carStatus === 'maintenance') {
                alert('\u042d\u0442\u0430 \u043c\u0430\u0448\u0438\u043d\u0430 \u043d\u0430\u0445\u043e\u0434\u0438\u0442\u0441\u044f \u043d\u0430 \u0442\u0435\u0445\u043d\u0438\u0447\u0435\u0441\u043a\u043e\u043c \u043e\u0431\u0441\u043b\u0443\u0436\u0438\u0432\u0430\u043d\u0438\u0438.');
                return;
            }
            // Find car data by matching the variant id
            var allCarsMap = {};
            if (window._allCarsData) {
                window._allCarsData.forEach(function (c) { allCarsMap[c.id] = c; });
            } else {
                (availableCars || []).forEach(function (c) { allCarsMap[c.id] = c; });
            }
            var car = allCarsMap[selectedVariant.id];
            if (!car) {
                car = { id: selectedVariant.id, name: 'Riley-X1 \u00b7 ' + selectedVariant.name };
            }
            var btn = document.getElementById('cta-btn');
            var centerBtn = document.getElementById('center-cta-btn');
            if (btn) { btn.disabled = true; btn.textContent = '\u0417\u0430\u043f\u0443\u0441\u043a\u2026'; }
            if (centerBtn) { centerBtn.disabled = true; centerBtn.textContent = '\u0417\u0430\u043f\u0443\u0441\u043a\u2026'; }
            var selectedRace = sessionStorage.getItem('selectedRaceId') || null;
            socket.emit('start_session', { carId: car.id, userId: currentUser.username, dbUserId: currentUser.id });
            socket.once('session_started', function (data) {
                sessionStorage.setItem('activeSession', JSON.stringify({
                    carId: car.id, carName: car.name, startTime: new Date().toISOString(),
                    sessionId: data.sessionId, sessionRef: data.sessionRef || null, userId: currentUser.username,
                    dbUserId: currentUser.id, ratePerMinute: ratePerMinute, selectedRaceId: selectedRace,
                    cameraUrl: data.cameraUrl || ''
                }));
                window.location.href = '/control';
            });
            socket.once('session_error', function (data) {
                if (data.code === 'insufficient_balance') {
                    document.getElementById('topup-overlay').classList.add('visible');
                } else if (data.code === 'session_already_active') {
                    alert(data.message || '\u0423 \u0432\u0430\u0441 \u0443\u0436\u0435 \u0435\u0441\u0442\u044c \u0430\u043a\u0442\u0438\u0432\u043d\u0430\u044f \u0441\u0435\u0441\u0441\u0438\u044f.');
                } else {
                    alert(data.message || '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043d\u0430\u0447\u0430\u0442\u044c \u0441\u0435\u0441\u0441\u0438\u044e.');
                }
                updateCTA(); loadCars();
            });
        }

        // Stale session check
        function checkStaleSession() {
            var stale = null;
            try { stale = JSON.parse(sessionStorage.getItem('activeSession') || 'null'); } catch (e) {}
            if (!stale || !stale.sessionId) { sessionStorage.removeItem('activeSession'); return; }
            sessionStorage.removeItem('activeSession');
            fetch('/api/session/end', {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: stale.sessionId })
            })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var carName = stale.carName || ('\u041c\u0430\u0448\u0438\u043d\u0430 #' + (stale.carId || '?'));
                var dur = '\u2014', cost = '0.00 ₽';
                if (data.ended) {
                    var s = data.durationSeconds || 0;
                    dur  = Math.floor(s / 60) + '\u043c ' + (s % 60) + '\u0441';
                    cost = (data.cost || 0).toFixed(2) + ' ₽';
                } else if (stale.startTime) {
                    var s2 = Math.max(0, Math.floor((Date.now() - new Date(stale.startTime).getTime()) / 1000));
                    dur  = Math.floor(s2 / 60) + '\u043c ' + (s2 % 60) + '\u0441';
                    cost = ((s2 / 60) * (stale.ratePerMinute || ratePerMinute)).toFixed(2) + ' ₽';
                }
                document.getElementById('stale-car').textContent      = '\u041c\u0430\u0448\u0438\u043d\u0430: ' + carName;
                document.getElementById('stale-duration').textContent  = '\u0414\u043b\u0438\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442\u044c: ' + dur;
                document.getElementById('stale-cost').textContent      = cost;
                document.getElementById('stale-overlay').classList.add('visible');
            })
            .catch(function () {});
        }

        document.getElementById('stale-close').addEventListener('click', function () {
            document.getElementById('stale-overlay').classList.remove('visible');
        });
        window.addEventListener('pageshow', function (e) { if (e.persisted) checkStaleSession(); });

        // Carousel prev/next arrows
        (function () {
            var prevBtn = document.getElementById('carousel-prev');
            var nextBtn = document.getElementById('carousel-next');
            if (prevBtn) prevBtn.addEventListener('click', function () {
                if (typeof window._renderCarousel === 'function') {
                    var thumbs = document.querySelectorAll('.car-thumb');
                    if (!thumbs.length) return;
                    var active = document.querySelector('.car-thumb.active');
                    var idx = active ? parseInt(active.getAttribute('data-variant-index'), 10) : 0;
                    var newIdx = (idx - 1 + thumbs.length) % thumbs.length;
                    thumbs[newIdx].click();
                }
            });
            if (nextBtn) nextBtn.addEventListener('click', function () {
                if (typeof window._renderCarousel === 'function') {
                    var thumbs = document.querySelectorAll('.car-thumb');
                    if (!thumbs.length) return;
                    var active = document.querySelector('.car-thumb.active');
                    var idx = active ? parseInt(active.getAttribute('data-variant-index'), 10) : 0;
                    var newIdx = (idx + 1) % thumbs.length;
                    thumbs[newIdx].click();
                }
            });
        }());

        // ---- Daily Bonus ----
        var DAILY_REWARD_SCHEDULE = [2, 3, 5, 5, 8, 10, 15];

        function renderDailyBonusWidget(data) {
            var w = document.getElementById('daily-bonus-widget');
            if (!w) return;

            var cycleDay = data.cycleDay || 1;
            var streakCount = data.streakCount || 1;
            var todayReward = data.todayReward || DAILY_REWARD_SCHEDULE[0];
            var nextReward = data.nextReward || DAILY_REWARD_SCHEDULE[0];
            var claimedToday = !!data.claimedToday;

            var dotsHtml = '';
            for (var i = 1; i <= 7; i++) {
                var reward = DAILY_REWARD_SCHEDULE[i - 1];
                var dotCls = 'daily-bonus-dot';
                var lblCls = 'daily-bonus-day-label';
                if (i < cycleDay || (i === cycleDay && claimedToday)) {
                    dotCls += ' done';
                } else if (i === cycleDay && !claimedToday) {
                    dotCls += ' active';
                    lblCls += ' active';
                }
                dotsHtml += '<div class="daily-bonus-day">' +
                    '<div class="' + dotCls + '">' + reward + '</div>' +
                    '<div class="' + lblCls + '">' + i + '</div>' +
                    '</div>';
            }

            var rewardHtml = claimedToday
                ? '<div class="daily-bonus-reward">Следующий: <strong>' + nextReward + ' RC</strong></div>'
                : '<div class="daily-bonus-reward">Сегодня: <strong>' + todayReward + ' RC</strong></div>';

            var streakHtml = '<div class="daily-bonus-streak-info">🔥 Серия: <span>' + streakCount + '</span> ' +
                (streakCount === 1 ? 'день' : (streakCount < 5 ? 'дня' : 'дней')) + '</div>';

            var btnHtml;
            if (claimedToday) {
                btnHtml = '<button class="daily-bonus-claim-btn claimed" disabled>Получено ✅</button>';
            } else {
                btnHtml = '<button class="daily-bonus-claim-btn" id="daily-bonus-claim-btn">Забрать ' + todayReward + ' RC</button>';
            }

            w.innerHTML = '<div class="daily-bonus-streak">' + dotsHtml + '</div>' +
                rewardHtml + streakHtml + btnHtml +
                '<div id="daily-bonus-error" class="daily-bonus-error"></div>';

            if (!claimedToday) {
                var btn = document.getElementById('daily-bonus-claim-btn');
                if (btn) {
                    btn.addEventListener('click', function () {
                        claimDailyBonus();
                    });
                }
            }
        }

        function loadDailyBonusStatus() {
            var w = document.getElementById('daily-bonus-widget');
            if (!w) return;
            if (!currentUser) {
                w.innerHTML = '<div class="daily-bonus-guest">Войдите для получения бонусов</div>';
                return;
            }
            if (currentUser.status !== 'active') {
                w.innerHTML = '<div class="daily-bonus-guest">Недоступно</div>';
                return;
            }
            fetch('/api/daily-bonus/status', { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (data) { renderDailyBonusWidget(data); })
                .catch(function () {
                    if (w) w.innerHTML = '<div class="daily-bonus-guest">Недоступно</div>';
                });
        }

        function claimDailyBonus() {
            var btn = document.getElementById('daily-bonus-claim-btn');
            if (btn) { btn.disabled = true; btn.textContent = 'Получение…'; }
            fetch('/api/daily-bonus/claim', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
            })
            .then(function (r) {
                return r.json().then(function (body) { return { status: r.status, body: body }; });
            })
            .then(function (resp) {
                if (resp.status === 200 && resp.body.claimed) {
                    // Update balance state and display
                    currentBalance = resp.body.balance;
                    var credEl = document.getElementById('rp-credits');
                    if (credEl) credEl.textContent = resp.body.balance.toFixed(2) + ' RC';
                    updateCTA();
                    renderDailyBonusWidget({
                        claimedToday: true,
                        cycleDay: resp.body.cycleDay,
                        streakCount: resp.body.streakCount,
                        todayReward: resp.body.reward,
                        nextReward: resp.body.nextReward,
                    });
                } else if (resp.status === 409 && resp.body.code === 'already_claimed') {
                    loadDailyBonusStatus();
                } else {
                    if (btn) { btn.disabled = false; btn.textContent = 'Попробовать снова'; }
                    var errEl = document.getElementById('daily-bonus-error');
                    if (errEl) { errEl.textContent = resp.body.error || 'Ошибка'; errEl.style.display = 'block'; }
                }
            })
            .catch(function () {
                if (btn) { btn.disabled = false; btn.textContent = 'Попробовать снова'; }
                var errEl = document.getElementById('daily-bonus-error');
                if (errEl) { errEl.textContent = 'Ошибка сети'; errEl.style.display = 'block'; }
            });
        }

        // Init
        loadBalance();
        loadCars();
        loadCarStatus();
        checkStaleSession();
        loadLeaderboard();
        setInterval(loadCarStatus, 10000);
        // Reload balance on page return (e.g., after YooKassa redirect)
        window.addEventListener('pageshow', function (e) {
            var isBackForward = e.persisted;
            if (!isBackForward) {
                try {
                    var navEntries = window.performance && performance.getEntriesByType && performance.getEntriesByType('navigation');
                    if (navEntries && navEntries.length && navEntries[0].type === 'back_forward') {
                        isBackForward = true;
                    }
                } catch (_) {}
            }
            if (isBackForward) {
                loadBalance();
            }
            // Check for payment return via URL param
            var params = new URLSearchParams(window.location.search);
            if (params.get('payment') === 'return') {
                loadBalance();
            }
        });
