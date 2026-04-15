        // ── Debug mode: activate via ?debug=1 query parameter ──
        var _isDebugMode = /[?&]debug=1/.test(window.location.search);
        if (_isDebugMode) {
            document.body.classList.add('debug-mode');
            var _debugPanel = document.getElementById('debug-panel');
            if (_debugPanel) _debugPanel.hidden = false;
        }

        // ── HUD mode status helper (used by race/duel to reflect current mode) ──
        function setHudModeStatus(text) {
            var el = document.getElementById('hud-mode-status');
            if (!el) return;
            el.textContent = text || '';
        }

        // Expose for duel-ui.js (loaded later)
        window._setHudModeStatus = setHudModeStatus;

        // ── Compact race HUD widget ──
        function updateHudRaceWidget(raceName, posText, lapActive) {
            var widget  = document.getElementById('hud-race-widget');
            var nameEl  = document.getElementById('hud-race-name');
            var posEl   = document.getElementById('hud-race-pos');
            if (!widget) return;
            if (raceName) {
                if (nameEl) nameEl.textContent = raceName;
                var pos = posText || '';
                if (posEl)  posEl.textContent = pos;
                widget.classList.toggle('has-sub', !!pos);
                widget.classList.toggle('lap-active', !!lapActive);
                widget.hidden = false;
            } else {
                widget.hidden = true;
                widget.classList.remove('has-sub', 'lap-active');
            }
        }

        // ── Drawer active race summary ──
        function updateDrawerActiveRace(raceName, posText, lapActive) {
            var el     = document.getElementById('race-active-summary');
            var nameEl = document.getElementById('das-race-name');
            var posEl  = document.getElementById('das-race-pos');
            var subEl  = document.getElementById('das-race-sub');
            if (!el) return;
            if (raceName) {
                if (nameEl) nameEl.textContent = raceName;
                if (posEl)  posEl.textContent  = posText || '';
                if (subEl)  subEl.textContent  = lapActive ? '⏱ Круг' : '';
                el.hidden = false;
            } else {
                el.hidden = true;
                if (nameEl) nameEl.textContent = '—';
                if (posEl)  posEl.textContent  = '';
                if (subEl)  subEl.textContent  = '';
            }
        }

        // ── Convenience: update both race display layers in one call ──
        function syncRaceWidgets(name, pos, lapActive) {
            updateHudRaceWidget(name, pos, lapActive);
            updateDrawerActiveRace(name, pos, lapActive);
        }

        // ── Compact duel HUD widget ──
        function updateHudDuelWidget(oppName, statusText, liveDuel) {
            var widget = document.getElementById('hud-duel-widget');
            var oppEl  = document.getElementById('hud-duel-opp');
            var subEl  = document.getElementById('hud-duel-sub');
            if (!widget) return;
            if (oppName) {
                if (oppEl) oppEl.textContent = oppName;
                var sub = statusText || '';
                if (subEl) subEl.textContent = sub;
                widget.classList.toggle('has-sub', !!sub);
                widget.classList.toggle('duel-live', !!liveDuel);
                widget.hidden = false;
            } else {
                widget.hidden = true;
                widget.classList.remove('has-sub', 'duel-live');
                // Reset to default placeholder so stale text can't reappear
                if (oppEl) oppEl.textContent = '—';
                if (subEl) subEl.textContent = '';
            }
        }

        // Expose for duel-ui.js
        window._setHudDuelWidget = updateHudDuelWidget;

        // Seed debug indicator immediately if debug mode is active
        if (_isDebugMode) {
            setHudModeStatus('🛠 DEBUG');
        }

        // Read activeSession from sessionStorage, returning null if missing or invalid
        function getActiveSession() {
            try {
                return JSON.parse(sessionStorage.getItem('activeSession') || 'null');
            } catch (e) {
                return null;
            }
        }

        // Restore session info from sessionStorage
        const sessionData = getActiveSession() || {};

        const hasSession = !!sessionData.carId;

        function disableControls() {
            ['forward', 'backward', 'left', 'right'].forEach(function (id) {
                document.getElementById(id).disabled = true;
            });
            document.getElementById('end-rental').disabled = true;
            document.getElementById('session-inactive-msg').style.display = 'block';
        }

        // If no active session, redirect to garage
        if (!hasSession) {
            window.location.replace('/garage');
        }

        function setSessionChromeHidden(hidden) {
            if (hidden) {
                document.body.classList.add('session-active');
            } else {
                document.body.classList.remove('session-active');
            }
        }

        // Hide navbar immediately if session is already active (e.g. page reload)
        if (sessionStorage.getItem('activeSession')) {
            setSessionChromeHidden(true);
        }

        // Handle bfcache back navigation: re-check session on pageshow
        window.addEventListener('pageshow', function (event) {
            if (event.persisted) {
                const session = getActiveSession();
                if (!session || !session.carId) {
                    window.location.replace('/garage');
                }
            }
        });

        const carId = sessionData.carId || null;
        const carName = sessionData.carName || 'Неизвестная машина';
        const startTime = sessionData.startTime ? new Date(sessionData.startTime) : new Date();

        document.getElementById('car-name').textContent = carName;

        // Auto-connect camera from session data
        (function () {
            const cameraUrl = sessionData.cameraUrl || '';
            const feed = document.getElementById('camera-feed');
            const noUrlMsg = document.getElementById('camera-no-url');
            if (cameraUrl) {
                if (feed) feed.src = cameraUrl;
            } else {
                if (noUrlMsg) noUrlMsg.style.display = 'block';
            }
        }());

        // Session timer
        let timerInterval = setInterval(function () {
            const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
            const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const seconds = String(elapsed % 60).padStart(2, '0');
            document.getElementById('session-timer').textContent = `${minutes}:${seconds}`;
        }, 1000);

        // Compact rank badge
        (function () {
            var wrap = document.getElementById('control-rank-wrap');
            if (!wrap || typeof window.RankUI === 'undefined') return;
            fetch('/api/profile/rank', { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (data) {
                    if (!wrap) return;
                    if (!data) { wrap.style.display = 'none'; return; }
                    wrap.innerHTML = window.RankUI.renderRankBadge(data, { size: 'compact' });
                })
                .catch(function () {
                    if (wrap) wrap.style.display = 'none';
                });
        }());

        // ---------- Client-side countdown timers ----------
        let maxCountdownInterval = null;
        let inactivityCountdownInterval = null;
        let inactivityRemainingMs = 0;
        let sessionMaxRemainingMs = 0;
        const WARNING_THRESHOLD_MS = 30 * 1000;
        const CRITICAL_THRESHOLD_MS = 10 * 1000;
        const COUNTDOWN_TICK_MS = 250;

        function fmtCountdown(ms) {
            const totalSec = Math.max(0, Math.ceil(ms / 1000));
            const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
            const s = String(totalSec % 60).padStart(2, '0');
            return `${m}:${s}`;
        }

        function showWarningBanner(msg, critical) {
            const banner = document.getElementById('session-warning-banner');
            if (!banner) return;
            banner.textContent = msg;
            banner.style.display = 'block';
            banner.classList.toggle('critical', !!critical);
        }

        function hideWarningBanner() {
            const banner = document.getElementById('session-warning-banner');
            if (banner) banner.style.display = 'none';
        }

        function stopCountdownTimers() {
            clearInterval(maxCountdownInterval);
            clearInterval(inactivityCountdownInterval);
            maxCountdownInterval = null;
            inactivityCountdownInterval = null;
            hideWarningBanner();
            const bar = document.getElementById('session-timers-bar');
            if (bar) bar.style.display = 'none';
        }

        function startCountdownTimers(maxDurationMs, inactivityMs) {
            if (!maxDurationMs || !inactivityMs) return;
            sessionMaxRemainingMs = maxDurationMs;
            inactivityRemainingMs = inactivityMs;

            const bar = document.getElementById('session-timers-bar');
            if (bar) bar.style.display = 'flex';

            maxCountdownInterval = setInterval(function () {
                sessionMaxRemainingMs -= COUNTDOWN_TICK_MS;
                if (sessionMaxRemainingMs < 0) sessionMaxRemainingMs = 0;

                const maxEl = document.getElementById('max-timer-countdown');
                const maxBadge = document.getElementById('max-timer-badge');
                if (maxEl) maxEl.textContent = fmtCountdown(sessionMaxRemainingMs);

                if (sessionMaxRemainingMs <= WARNING_THRESHOLD_MS) {
                    if (maxBadge) maxBadge.classList.add('warning');
                    showWarningBanner(
                        `⏱ До конца сессии: ${fmtCountdown(sessionMaxRemainingMs)}`,
                        sessionMaxRemainingMs <= CRITICAL_THRESHOLD_MS
                    );
                }

                if (sessionMaxRemainingMs <= 0) {
                    clearInterval(maxCountdownInterval);
                    maxCountdownInterval = null;
                    if (!sessionEnded) {
                        sessionEnded = true;
                        socket.emit('end_session', { carId: carId });
                        disableControls();
                    }
                }
            }, COUNTDOWN_TICK_MS);

            inactivityCountdownInterval = setInterval(function () {
                inactivityRemainingMs -= COUNTDOWN_TICK_MS;
                if (inactivityRemainingMs < 0) inactivityRemainingMs = 0;

                const inEl = document.getElementById('inactivity-timer-countdown');
                const inBadge = document.getElementById('inactivity-timer-badge');
                if (inEl) inEl.textContent = fmtCountdown(inactivityRemainingMs);

                if (inactivityRemainingMs <= WARNING_THRESHOLD_MS) {
                    if (inBadge) inBadge.classList.add('warning');
                    // Only show inactivity warning if max timer is not already showing
                    if (sessionMaxRemainingMs > WARNING_THRESHOLD_MS) {
                        showWarningBanner(
                            `💤 Бездействие: сессия завершится через ${fmtCountdown(inactivityRemainingMs)}`,
                            inactivityRemainingMs <= CRITICAL_THRESHOLD_MS
                        );
                    }
                }

                if (inactivityRemainingMs <= 0) {
                    clearInterval(inactivityCountdownInterval);
                    inactivityCountdownInterval = null;
                    if (!sessionEnded) {
                        sessionEnded = true;
                        socket.emit('end_session', { carId: carId });
                        disableControls();
                    }
                }
            }, COUNTDOWN_TICK_MS);
        }

        function resetInactivityCountdown() {
            if (!inactivityTimeoutMsFromServer) return;
            inactivityRemainingMs = inactivityTimeoutMsFromServer;
            const inBadge = document.getElementById('inactivity-timer-badge');
            if (inBadge) inBadge.classList.remove('warning');
            // Hide warning if it was for inactivity and max timer is still safe
            if (sessionMaxRemainingMs > WARNING_THRESHOLD_MS) {
                hideWarningBanner();
            }
        }
        window._resetInactivityCountdown = resetInactivityCountdown;

        // Holds the inactivityTimeoutMs received from server (for resets)
        let inactivityTimeoutMsFromServer = 0;
        // -------------------------------------------------

        // End session via HTTP beacon (reliable on page unload/back navigation)
        function sendEndSessionBeacon(socketId) {
            if (!socketId) return;
            try {
                const currentSession = getActiveSession() || {};
                const payload = { sessionId: socketId };
                if (currentSession.sessionRef) payload.sessionRef = currentSession.sessionRef;
                const blob = new Blob(
                    [JSON.stringify(payload)],
                    { type: 'application/json' }
                );
                navigator.sendBeacon('/api/session/end', blob);
            } catch (e) {
                // sendBeacon not supported — socket disconnect will clean up
            }
        }

        // Flag to prevent double-ending the session
        let sessionEnded = false;

        function endSessionOnLeave() {
            if (sessionEnded) return;
            sessionEnded = true;
            clearInterval(timerInterval);
            stopCountdownTimers();
            if (hasSession) {
                const currentSocketId = socket && socket.id ? socket.id : null;
                if (currentSocketId) {
                    if (socket.connected) {
                        // Socket is alive — use WebSocket to end; server disconnect handler
                        // is the safety net if the emit doesn't arrive in time.
                        socket.emit('end_session', { carId: carId });
                    } else {
                        // Socket already dead — fall back to HTTP beacon so the server
                        // can still clean up the session.
                        sendEndSessionBeacon(currentSocketId);
                    }
                }
                sessionStorage.removeItem('activeSession');
            }
        }

        window.addEventListener('beforeunload', endSessionOnLeave);

        window.addEventListener('pagehide', endSessionOnLeave);

        const socket = io(window.location.origin);
        window._controlSocket = socket;

        // Hook global reliability layer for reconnect UX
        if (window.Reliability) {
            window.Reliability.installSocketReliability(socket);
        }

        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');
        const speedSlider = document.getElementById('speed-slider');
        const speedValue = document.getElementById('speed-value');

        // --- Visual feedback helpers ---
        const MAX_CMD_LOG = 5;
        const cmdLogEntries = [];

        function addCmdLogEntry(text) {
            const logEl = document.getElementById('cmd-log');
            if (!logEl) return;
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            const timeStr = hh + ':' + mm + ':' + ss;
            const entryEl = document.createElement('div');
            entryEl.className = 'cmd-log-entry';
            const timeEl = document.createElement('span');
            timeEl.className = 'cmd-log-time';
            timeEl.textContent = timeStr;
            const textEl = document.createElement('span');
            textEl.className = 'cmd-log-text';
            textEl.textContent = text;
            entryEl.appendChild(timeEl);
            entryEl.appendChild(textEl);
            const entry = { text, el: entryEl };
            cmdLogEntries.unshift(entry);
            if (cmdLogEntries.length > MAX_CMD_LOG) {
                const removed = cmdLogEntries.pop();
                if (removed.el.parentNode) removed.el.parentNode.removeChild(removed.el);
            }
            logEl.prepend(entry.el);
            // Fade older entries
            cmdLogEntries.forEach(function (e, i) {
                if (i > 0) e.el.classList.add('fading');
                else e.el.classList.remove('fading');
            });
        }
        window._addCmdLogEntry = addCmdLogEntry;

        let speedToastTimeout = null;
        function showSpeedToast(value) {
            const toastEl = document.getElementById('speed-toast');
            if (!toastEl) return;
            toastEl.textContent = 'Скорость: ' + value + '%';
            toastEl.classList.add('visible');
            clearTimeout(speedToastTimeout);
            speedToastTimeout = setTimeout(function () {
                toastEl.classList.remove('visible');
            }, 1200);
        }

        // ── HUD speed display update ──
        function updateHudSpeed(value) {
            const el = document.getElementById('hud-speed-value');
            if (!el) return;
            el.textContent = Math.abs(value);
            const frameEl = document.getElementById('hud-speed-frame');
            const dirEl   = document.getElementById('hud-speed-dir');
            if (value > 0) {
                el.classList.add('hud-speed-active');
                if (dirEl)   dirEl.textContent = '▲';
                if (frameEl) { frameEl.classList.add('speed-active', 'dir-forward'); frameEl.classList.remove('dir-backward'); }
            } else if (value < 0) {
                el.classList.remove('hud-speed-active');
                if (dirEl)   dirEl.textContent = '▼';
                if (frameEl) { frameEl.classList.add('dir-backward'); frameEl.classList.remove('speed-active', 'dir-forward'); }
            } else {
                el.classList.remove('hud-speed-active');
                if (dirEl)   dirEl.textContent = '▶';
                if (frameEl) { frameEl.classList.remove('speed-active', 'dir-forward', 'dir-backward'); }
            }
        }

        // ── Debug control state readout (operator panel only) ──
        function updateDebugCtrlState() {
            if (!_isDebugMode) return;
            var srcEl  = document.getElementById('dcs-source');
            var dirEl  = document.getElementById('dcs-direction');
            var spdEl  = document.getElementById('dcs-speed');
            var strEl  = document.getElementById('dcs-steering');
            if (!srcEl) return; // panel not in DOM
            // Source
            var srcLabels = { keyboard: '⌨️ клавиатура', gamepad: '🎮 геймпад', debug: '🖱 кнопки', none: '— нет' };
            srcEl.textContent = srcLabels[ctrl.source] || ctrl.source;
            // Direction
            if (ctrl.direction === 'forward') {
                dirEl.textContent = '▲ вперёд';
                dirEl.className = 'dcs-value state-active';
            } else if (ctrl.direction === 'backward') {
                dirEl.textContent = '▼ назад';
                dirEl.className = 'dcs-value state-backward';
            } else {
                dirEl.textContent = '■ стоп';
                dirEl.className = 'dcs-value';
            }
            // Speed
            spdEl.textContent = ctrl.speed + '%';
            spdEl.className = ctrl.speed > 0 ? 'dcs-value state-active' : 'dcs-value';
            // Steering
            var steerVal = ctrl.steering;
            if (steerVal > 0) {
                strEl.textContent = '→ +' + steerVal + '°';
                strEl.className = 'dcs-value state-active';
            } else if (steerVal < 0) {
                strEl.textContent = '← ' + steerVal + '°';
                strEl.className = 'dcs-value state-backward';
            } else {
                strEl.textContent = '0°';
                strEl.className = 'dcs-value';
            }
        }

        speedSlider.addEventListener('input', function () {
            speedValue.textContent = speedSlider.value;
            showSpeedToast(speedSlider.value);
            resetInactivityCountdown();
            var sliderSpeed = parseInt(speedSlider.value, 10);
            // If keyboard or debug is actively driving, immediately apply new speed.
            var isActiveDrive = (ctrl.source === 'keyboard' || ctrl.source === 'debug') &&
                                ctrl.direction !== 'stop';
            if (isActiveDrive) {
                ctrl.speed = sliderSpeed;
                dispatchCommand();
            } else {
                updateHudSpeed(sliderSpeed);
                var teleSpeed = document.getElementById('tele-speed');
                if (teleSpeed) teleSpeed.textContent = sliderSpeed + '%';
            }
        });

        // Ping measurement
        let pingInterval = null;

        socket.on('connect', function () {
            statusDot.classList.remove('disconnected');
            statusDot.classList.add('connected');
            statusText.textContent = 'Подключено';
            // Re-establish server-side session so car status is 'unavailable'
            if (hasSession && carId) {
                if (!sessionData.dbUserId) {
                    console.warn('Сессия недоступна: требуется вход и подтверждённый email.');
                    return;
                }
                socket.emit('start_session', { carId: carId, userId: sessionData.userId, dbUserId: sessionData.dbUserId });
            }
            // Announce presence as driver
            if (sessionData && sessionData.dbUserId && sessionData.userId) {
                socket.emit('presence:hello', {
                    page: 'control',
                    userId: sessionData.dbUserId,
                    username: sessionData.userId,
                });
            }
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(function () {
                const start = Date.now();
                socket.volatile.emit('ping_check', function () {
                    const latency = Date.now() - start;
                    const pingEl = document.getElementById('tele-ping');
                    if (pingEl) {
                        pingEl.textContent = latency + ' мс';
                        pingEl.className = 'telemetry-value ' + (latency < 50 ? 'good' : latency < 150 ? 'warn' : 'bad');
                    }
                });
            }, 3000);
            // Reset dedup fingerprint so the first command after reconnect is always
            // delivered — the server-side state may have been reset during the outage.
            lastEmittedSig = '';
            // Re-arm hold-refresh if an input is still held (brief reconnect scenario).
            if (ctrl.direction !== 'stop' || ctrl.steering !== 0) {
                startHoldRefresh();
            }
        });

        // Heartbeat to keep presence alive (every 15 seconds)
        var presenceHeartbeatInterval = setInterval(function () {
            if (socket && socket.connected) {
                socket.emit('presence:heartbeat');
            }
        }, 15000);

        socket.on('session_started', function (data) {
            // Update sessionStorage with new socket-based sessionId and sessionRef
            const updated = Object.assign({}, sessionData, { sessionId: data.sessionId, sessionRef: data.sessionRef || null });
            sessionStorage.setItem('activeSession', JSON.stringify(updated));
            setSessionChromeHidden(true);
            // Start client-side countdown timers if server provided values
            if (data.sessionMaxDurationMs && data.inactivityTimeoutMs) {
                inactivityTimeoutMsFromServer = data.inactivityTimeoutMs;
                stopCountdownTimers();
                startCountdownTimers(data.sessionMaxDurationMs, data.inactivityTimeoutMs);
            }
        });

        socket.on('disconnect', function () {
            statusDot.classList.remove('connected');
            statusDot.classList.add('disconnected');
            statusText.textContent = 'Отключено';
            clearInterval(pingInterval);
            pingInterval = null;
            const pingEl = document.getElementById('tele-ping');
            if (pingEl) { pingEl.textContent = '—'; pingEl.className = 'telemetry-value'; }
            // Pause keepalive while offline — commands would be silently dropped otherwise.
            stopHoldRefresh();
        });

        socket.on('session_ended', function (data) {
            sessionEnded = true;
            clearInterval(timerInterval);
            stopCountdownTimers();
            resetRaceUiState();
            setSessionChromeHidden(false);
            sessionStorage.removeItem('activeSession');
            const durationSec = data.durationSeconds || 0;
            const cost = data.cost || 0;
            const minutes = Math.floor(durationSec / 60);
            const seconds = durationSec % 60;
            document.getElementById('summary-car').textContent = `Машина: ${carName}`;
            document.getElementById('summary-duration').textContent =
                `Длительность: ${minutes}м ${seconds}с`;
            document.getElementById('summary-cost').textContent =
                `${cost.toFixed(2)} ₽`;
            const reasonEl = document.getElementById('summary-reason');
            if (reasonEl) {
                if (data.reason === 'time_limit') {
                    reasonEl.textContent = '⏱ Сессия завершена: превышен лимит времени.';
                    reasonEl.style.display = 'block';
                } else if (data.reason === 'inactivity') {
                    reasonEl.textContent = '💤 Сессия завершена: превышен лимит бездействия.';
                    reasonEl.style.display = 'block';
                } else if (data.reason === 'admin_force_end') {
                    reasonEl.textContent = '🛑 Сессия завершена оператором.';
                    reasonEl.style.display = 'block';
                } else {
                    reasonEl.style.display = 'none';
                }
            }
            document.getElementById('summary-overlay').classList.add('visible');
        });

        socket.on('control_error', function (data) {
            if (data && data.code === 'rate_limited') {
                const el = document.getElementById('lap-flash');
                if (el) {
                    el.textContent = data.message || 'Слишком много команд.';
                    el.style.color = '#e67e22';
                    clearTimeout(el._ctrlErrTimeout);
                    el._ctrlErrTimeout = setTimeout(function () {
                        el.textContent = '';
                        el.style.color = '';
                    }, 2000);
                }
            }
        });

        socket.on('car_telemetry', function (data) {
            if (data.battery != null) {
                const el = document.getElementById('tele-battery');
                if (el) {
                    el.textContent = Math.round(data.battery) + '%';
                    el.className = 'telemetry-value ' + (data.battery > 50 ? 'good' : data.battery > 20 ? 'warn' : 'bad');
                }
            }
        });

        socket.on('session_error', function (data) {
            clearInterval(timerInterval);
            stopCountdownTimers();
            resetRaceUiState();
            setSessionChromeHidden(false);
            disableControls();
            const msg = document.getElementById('session-inactive-msg');
            msg.innerHTML = '';
            msg.appendChild(document.createTextNode(
                (data.message || 'Ошибка сессии.') + ' Управление недоступно. '
            ));
            const link = document.createElement('a');
            link.href = '/garage';
            link.textContent = 'Вернуться в гараж';
            msg.appendChild(link);
            msg.appendChild(document.createTextNode('.'));
            sessionStorage.removeItem('activeSession');
        });

        document.getElementById('end-rental').addEventListener('click', function () {
            sessionEnded = true;
            socket.emit('end_session', { carId: carId });
        });

        document.getElementById('back-to-main').addEventListener('click', function () {
            sessionEnded = true;
            sessionStorage.removeItem('activeSession');
            window.location.href = '/garage';
        });

        // ── Debug controls: pointer press-and-hold ──────────────────────────────
        // Each button behaves like a held key: pointerdown starts the drive command,
        // pointerup/pointercancel releases it.  Multiple buttons can be held at once
        // (e.g. forward + left) and the state resolves exactly like keyboard input.

        /** Which debug buttons are currently held (via pointer). */
        var debugHeld = { up: false, down: false, left: false, right: false };

        /** Recompute ctrl from current debugHeld state (mirrors applyKeyboardState). */
        function applyDebugState() {
            var up    = debugHeld.up;
            var down  = debugHeld.down;
            var left  = debugHeld.left;
            var right = debugHeld.right;
            if (up) {
                ctrl.direction = 'forward';
                ctrl.speed     = parseInt(speedSlider.value, 10);
            } else if (down) {
                ctrl.direction = 'backward';
                ctrl.speed     = parseInt(speedSlider.value, 10);
            } else {
                ctrl.direction = 'stop';
                ctrl.speed     = 0;
            }
            ctrl.steering = (left && !right) ? -30 : (right && !left ? 30 : 0);
            ctrl.source   = 'debug';
        }

        /**
         * Bind press-and-hold pointer events to a single debug button.
         * @param {string} id   - DOM element id of the button
         * @param {string} axis - key in debugHeld ('up' | 'down' | 'left' | 'right')
         */
        function bindDebugButton(id, axis) {
            var btn = document.getElementById(id);
            if (!btn) return;

            btn.addEventListener('pointerdown', function (e) {
                e.preventDefault(); // prevent ghost mouse events on touch screens
                btn.setPointerCapture(e.pointerId); // track pointer even if it drifts off
                debugHeld[axis] = true;
                applyDebugState();
                dispatchCommand(true);
                if (ctrl.direction !== 'stop' || ctrl.steering !== 0) startHoldRefresh();
                // Command log
                var label = axis === 'up'   ? '→ вперёд @ ' + ctrl.speed + '%'
                          : axis === 'down' ? '→ назад @ '  + ctrl.speed + '%'
                          : axis === 'left' ? '→ влево'
                          :                   '→ вправо';
                addCmdLogEntry(label);
            });

            function releaseDebug(e) {
                if (!debugHeld[axis]) return;
                debugHeld[axis] = false;
                applyDebugState();
                var isNeutral = ctrl.direction === 'stop' && ctrl.steering === 0;
                // Force-dispatch when returning to neutral (same rationale as keyup).
                dispatchCommand(isNeutral);
                if (isNeutral) stopHoldRefresh();
            }

            btn.addEventListener('pointerup',     releaseDebug);
            btn.addEventListener('pointercancel', releaseDebug);
        }

        bindDebugButton('forward',  'up');
        bindDebugButton('backward', 'down');
        bindDebugButton('left',     'left');
        bindDebugButton('right',    'right');

        // ── Debug stop button (emergency stop) ──
        (function () {
            var stopBtn = document.getElementById('debug-stop-btn');
            if (!stopBtn) return;
            stopBtn.addEventListener('click', function () {
                // Reset all held debug states so a subsequent hold re-registers cleanly
                debugHeld.up = false; debugHeld.down = false;
                debugHeld.left = false; debugHeld.right = false;
                emitSafetyStop();
                addCmdLogEntry('🛑 Стоп (кнопка)');
            });
        }());

        // ═══════════════════════════════════════════════════════════════════
        // Unified control state & dispatch pipeline
        // ═══════════════════════════════════════════════════════════════════

        /** Shared driving state — all input sources write here. */
        var ctrl = {
            direction: 'stop',   // 'forward' | 'backward' | 'stop'
            speed:     0,        // 0–100 (always positive; direction carries the sign)
            steering:  0,        // –90 to +90
            source:    'none',   // 'keyboard' | 'gamepad' | 'debug' | 'none'
        };

        // Seed the debug control-state readout immediately so it shows correct defaults.
        if (_isDebugMode) updateDebugCtrlState();

        /** Build the canonical socket payload from ctrl state. */
        function buildPayload() {
            return {
                direction:      ctrl.direction,
                speed:          ctrl.direction === 'forward'  ?  ctrl.speed
                              : ctrl.direction === 'backward' ? -ctrl.speed
                              : 0,
                steering_angle: ctrl.steering,
            };
        }

        /** Short fingerprint for change-detection / dedup. */
        function sigOf(p) {
            return p.direction + ':' + p.speed + ':' + p.steering_angle;
        }

        var lastEmittedSig   = '';
        var holdRefreshTimer = null;
        /**
         * Hold-refresh rate: 10 Hz (100 ms).
         * Purpose: RC hardware may need a continuous stream of commands to keep
         * moving rather than a one-shot command.  10 Hz is a safe keepalive cadence:
         *   • Comfortably under the backend rate-limit (CONTROL_RATE_LIMIT_MAX = 20/s).
         *   • Immediate-send-on-change is still the primary path for all transitions.
         *   • Hold-refresh only fires while a non-neutral input is held steady.
         */
        var HOLD_REFRESH_MS  = 100;

        /** Start periodic re-emit while an input is held (keeps car alive). */
        function startHoldRefresh() {
            if (holdRefreshTimer) return;
            holdRefreshTimer = setInterval(function () {
                if (ctrl.direction !== 'stop' || ctrl.steering !== 0) {
                    dispatchCommand(true); // force-emit for keepalive
                } else {
                    stopHoldRefresh();
                }
            }, HOLD_REFRESH_MS);
        }

        function stopHoldRefresh() {
            if (holdRefreshTimer) {
                clearInterval(holdRefreshTimer);
                holdRefreshTimer = null;
            }
        }

        /** Sync HUD / telemetry to current ctrl state. */
        function syncHud() {
            var displaySpeed = ctrl.direction === 'forward'  ?  ctrl.speed
                             : ctrl.direction === 'backward' ? -ctrl.speed
                             :                                  0;
            updateHudSpeed(displaySpeed);
            var teleSpeed = document.getElementById('tele-speed');
            if (teleSpeed) teleSpeed.textContent = Math.abs(displaySpeed) + '%';
            updateButtonHighlights();
            updateInputViz();
            updateDebugCtrlState();
        }

        /**
         * The ONE place socket.emit('control_command') is called.
         * Deduplicates identical consecutive commands; emits immediately on change.
         * @param {boolean} [force] — bypass dedup (e.g. safety stop, hold keepalive).
         */
        function dispatchCommand(force) {
            if (!socket || !socket.connected) return;
            var payload = buildPayload();
            var sig = sigOf(payload);
            if (!force && sig === lastEmittedSig) return;
            lastEmittedSig = sig;
            socket.emit('control_command', payload);
            resetInactivityCountdown();
            syncHud();
        }

        /** Immediate safety stop — clears all input state and forces a stop command. */
        function emitSafetyStop() {
            pressedActions.clear();
            ctrl.direction = 'stop';
            ctrl.speed     = 0;
            ctrl.steering  = 0;
            ctrl.source    = 'none';
            stopHoldRefresh();
            // Reset gamepad's internal dedup tracking so the next poll re-sends
            // whatever analog position the triggers are currently in.
            if (window.GamepadController && typeof window.GamepadController.resetState === 'function') {
                window.GamepadController.resetState();
            }
            dispatchCommand(true);
        }

        // Expose for gamepad.js (which loads before control.js in the HTML).
        // Accepts { direction, speed, steering, source } where:
        //   speed    — always positive (0–100); direction carries the sign
        //   steering — raw angle (–90 to +90); mapped to steering_angle in buildPayload()
        window._controlDispatch = function (state) {
            if (state.source    !== undefined) ctrl.source    = state.source;
            if (state.direction !== undefined) ctrl.direction = state.direction;
            if (state.speed     !== undefined) ctrl.speed     = state.speed;
            if (state.steering  !== undefined) ctrl.steering  = state.steering;
            dispatchCommand(false);
        };

        // ── Keyboard input ──────────────────────────────────────────────────────

        /** Normalised set of logical actions for currently-held keys. */
        var pressedActions = new Set();

        /**
         * Map raw key names → logical actions.
         * Supports Arrow keys, WASD, and Space (brake/stop).
         */
        var KEY_ACTIONS = {
            'ArrowUp':   'up',
            'w': 'up',   'W': 'up',
            'ArrowDown': 'down',
            's': 'down', 'S': 'down',
            'ArrowLeft': 'left',
            'a': 'left', 'A': 'left',
            'ArrowRight': 'right',
            'd': 'right', 'D': 'right',
            ' ': 'brake',
        };

        /** Recompute ctrl.direction / speed / steering from current pressedActions. */
        function applyKeyboardState() {
            var up    = pressedActions.has('up');
            var down  = pressedActions.has('down');
            var left  = pressedActions.has('left');
            var right = pressedActions.has('right');
            var brake = pressedActions.has('brake');

            if (brake) {
                ctrl.direction = 'stop';
                ctrl.speed     = 0;
            } else if (up) {
                ctrl.direction = 'forward';
                ctrl.speed     = parseInt(speedSlider.value, 10);
            } else if (down) {
                ctrl.direction = 'backward';
                ctrl.speed     = parseInt(speedSlider.value, 10);
            } else {
                ctrl.direction = 'stop';
                ctrl.speed     = 0;
            }

            ctrl.steering = (left && !right) ? -30 : (right && !left ? 30 : 0);
            ctrl.source   = 'keyboard';
        }

        /** Highlight debug-panel buttons based on ctrl state. */
        function updateButtonHighlights() {
            var fwdBtn   = document.getElementById('forward');
            var bwdBtn   = document.getElementById('backward');
            var leftBtn  = document.getElementById('left');
            var rightBtn = document.getElementById('right');
            if (fwdBtn)  fwdBtn.classList.toggle('button-active',  ctrl.direction === 'forward');
            if (bwdBtn)  bwdBtn.classList.toggle('button-active',  ctrl.direction === 'backward');
            if (leftBtn) leftBtn.classList.toggle('button-active', ctrl.steering < -5);
            if (rightBtn) rightBtn.classList.toggle('button-active', ctrl.steering > 5);
        }

        /** Update the HUD key-press visualisation (arrow grid). */
        function updateInputViz() {
            var hudUp    = document.getElementById('hud-key-up');
            var hudDown  = document.getElementById('hud-key-down');
            var hudLeft  = document.getElementById('hud-key-left');
            var hudRight = document.getElementById('hud-key-right');
            // Derive from canonical ctrl state so all input sources (keyboard,
            // gamepad, debug buttons) are reflected in the HUD arrow grid.
            if (hudUp)    hudUp.classList.toggle('active',    ctrl.direction === 'forward');
            if (hudDown)  hudDown.classList.toggle('active',  ctrl.direction === 'backward');
            if (hudLeft)  hudLeft.classList.toggle('active',  ctrl.steering < -5);
            if (hudRight) hudRight.classList.toggle('active', ctrl.steering > 5);
        }

        document.addEventListener('keydown', function (e) {
            var action = KEY_ACTIONS[e.key];
            if (!action) return;
            // Don't intercept keys when a text input is focused
            var tag = document.activeElement && document.activeElement.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            e.preventDefault();
            if (pressedActions.has(action)) return; // already held — ignore repeat
            pressedActions.add(action);
            applyKeyboardState();
            dispatchCommand();
            if (ctrl.direction !== 'stop' || ctrl.steering !== 0) startHoldRefresh();
            // Log on first press of a new key combination
            var label = '';
            if (pressedActions.has('brake')) {
                label = 'Стоп (пробел)';
            } else {
                if (pressedActions.has('up'))    label += (label ? ' + ' : '') + 'Вперёд';
                if (pressedActions.has('down'))  label += (label ? ' + ' : '') + 'Назад';
                if (pressedActions.has('left'))  label += (label ? ' + ' : '') + 'Влево';
                if (pressedActions.has('right')) label += (label ? ' + ' : '') + 'Вправо';
            }
            if (label) {
                var speedLabel = ctrl.speed ? ' @ ' + ctrl.speed + '%' : '';
                addCmdLogEntry('⌨️ ' + label + speedLabel);
            }
        });

        document.addEventListener('keyup', function (e) {
            var action = KEY_ACTIONS[e.key];
            if (!action) return;
            pressedActions.delete(action);
            applyKeyboardState();
            // Force-dispatch when returning to neutral so the stop always reaches
            // the car, even if lastEmittedSig already holds 'stop:0:0' (e.g. after
            // a safety stop or reconnect before this keyup fired).
            var isNeutral = ctrl.direction === 'stop' && ctrl.steering === 0;
            dispatchCommand(isNeutral);
            if (isNeutral) {
                stopHoldRefresh();
                if (pressedActions.size === 0) addCmdLogEntry('⌨️ Стоп');
            }
        });

        // ── Safety stops ────────────────────────────────────────────────────────

        // Stop on window blur (user alt-tabs or browser loses focus)
        window.addEventListener('blur', emitSafetyStop);

        // Stop when the tab is hidden (browser minimised, hidden, etc.)
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) emitSafetyStop();
        });

        // --- Race / Multiplayer Logic ---
        let currentRaceId   = null;
        let currentRaceName = null; // tracked for drawer summary and HUD widget
        let currentRacePos  = '';   // tracked for drawer summary and HUD widget
        let lapRunning = false;
        let lapStartTime = null;
        let lapDisplayInterval = null;

        function getMyUserId() {
            return sessionData.userId || ('user-' + socket.id);
        }


        function showRaceUI(inRace) {
            document.getElementById('race-no-session').style.display = inRace ? 'none' : 'flex';
            document.getElementById('race-in-session').style.display = inRace ? 'flex' : 'none';
            document.getElementById('race-status-bar').style.display = inRace ? 'block' : 'none';
            document.getElementById('lap-timer-section').style.display = inRace ? 'flex' : 'none';
            document.getElementById('positions-section').style.display = inRace ? 'block' : 'none';
        }

        function resetRaceUiState() {
            document.getElementById('start-lap-btn').disabled = false;
            document.getElementById('stop-lap-btn').disabled = true;
            document.getElementById('lap-time-display').textContent = '00:00.000';
            lapRunning = false;
            lapStartTime = null;
            clearInterval(lapDisplayInterval);
            lapDisplayInterval = null;
            var flashEl = document.getElementById('lap-flash');
            if (flashEl) { clearTimeout(flashEl._timeout); flashEl.textContent = ''; }
            // Hide compact race HUD widget and drawer summary so they never linger after reset
            syncRaceWidgets(null);
        }

        /** Sort race players by position: lapCount desc, then bestLapTime asc. */
        function sortPlayersByPosition(players) {
            return players.slice().sort(function (a, b) {
                if (b.lapCount !== a.lapCount) return b.lapCount - a.lapCount;
                if (!a.bestLapTime) return 1;
                if (!b.bestLapTime) return -1;
                return a.bestLapTime - b.bestLapTime;
            });
        }

        function renderPositions(players) {
            // Sort by lapCount desc, then bestLapTime asc
            const sorted = sortPlayersByPosition(players);
            const tbody = document.getElementById('positions-body');
            tbody.innerHTML = sorted.map(function (p, i) {
                const isMe = p.socketId === socket.id;
                const best = p.bestLapTime != null ? SharedUtils.formatLapTime(p.bestLapTime) : '—';
                return `<tr class="${isMe ? 'me' : ''}">
                    <td>${i + 1}</td>
                    <td>${SharedUtils.escapeHtml(p.carName)}${isMe ? ' (вы)' : ''}</td>
                    <td>${p.lapCount}</td>
                    <td>${best}</td>
                </tr>`;
            }).join('');
        }

        function renderLeaderboard(entries) {
            const tbody = document.getElementById('lb-body');
            if (!entries || entries.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="lb-empty-cell">Нет рекордов</td></tr>';
                return;
            }
            tbody.innerHTML = entries.slice(0, 5).map(function (e, i) {
                return `<tr>
                    <td>${i + 1}</td>
                    <td>${SharedUtils.escapeHtml(e.carName)}</td>
                    <td>${SharedUtils.escapeHtml(e.userId)}</td>
                    <td><strong>${SharedUtils.formatLapTime(e.lapTimeMs)}</strong></td>
                </tr>`;
            }).join('');
        }

        function loadLeaderboard() {
            fetch('/api/leaderboard', { cache: 'no-store' })
                .then(function (res) { return res.json(); })
                .then(function (data) { renderLeaderboard(data.leaderboard || []); })
                .catch(function () {
                    var tbody = document.getElementById('lb-body');
                    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="lb-empty-cell">Пока нет рекордов</td></tr>';
                });
        }

        function flashMessage(msg, isRecord) {
            const el = document.getElementById('lap-flash');
            el.textContent = msg;
            el.style.color = isRecord ? '#FFD700' : '#28a745';
            clearTimeout(el._timeout);
            el._timeout = setTimeout(function () { el.textContent = ''; }, 4000);
        }

        function loadActiveRaces() {
            fetch('/api/races')
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    const select = document.getElementById('race-select');
                    const races = data.races || [];
                    // Keep default option, rebuild the rest
                    while (select.options.length > 1) select.remove(1);
                    races.forEach(function (r) {
                        const opt = document.createElement('option');
                        opt.value = r.id;
                        opt.textContent = r.name + ' (' + r.playerCount + ' уч.)';
                        select.appendChild(opt);
                    });
                })
                .catch(function () {});
        }

        // Enable Join button only when a race is selected in the dropdown
        document.getElementById('race-select').addEventListener('change', function () {
            document.getElementById('join-race-btn').disabled = !this.value;
        });

        // Auto-join race if selected from index.html, or auto-create if "create new race" was chosen
        socket.on('connect', function () {
            const sd = sessionData || {};
            if (!sd.dbUserId) {
                console.warn('Автоматическое подключение к гонке пропущено: требуется вход и подтверждённый email.');
                return;
            }
            const playerInfo = { userId: getMyUserId(), carId: carId, carName: carName, dbUserId: sd.dbUserId };
            if (sd.selectedRaceId && !currentRaceId) {
                socket.emit('join_race', Object.assign({ raceId: sd.selectedRaceId }, playerInfo));
            } else if (sessionStorage.getItem('createNewRace') === 'true' && !currentRaceId) {
                sessionStorage.removeItem('createNewRace');
                socket.emit('join_race', playerInfo);
            }
        });

        socket.on('race_joined', function (data) {
            currentRaceId   = data.raceId;
            currentRaceName = data.raceName;
            currentRacePos  = '';
            // Clear the selectedRaceId so reconnections don't re-join automatically
            const updated = Object.assign({}, sessionData);
            delete updated.selectedRaceId;
            sessionStorage.setItem('activeSession', JSON.stringify(updated));
            document.getElementById('race-status-bar').textContent =
                '🏎 ' + data.raceName + ' — вы в гонке!';
            showRaceUI(true);
            renderPositions(data.players);
            loadLeaderboard();
            setHudModeStatus('');
            syncRaceWidgets(currentRaceName, '');
        });

        socket.on('race_updated', function (data) {
            if (data.raceId !== currentRaceId) return;
            var bar = document.getElementById('race-status-bar');
            bar.textContent = '';
            bar.appendChild(document.createTextNode('🏎 '));
            var strong = document.createElement('strong');
            strong.textContent = data.raceName;
            bar.appendChild(strong);
            bar.appendChild(document.createTextNode(' — ' + data.players.length + ' участник(ов)'));
            renderPositions(data.players);
            // Update compact race widget and drawer summary with current position
            var myPos = 0;
            var sorted = sortPlayersByPosition(data.players);
            for (var i = 0; i < sorted.length; i++) {
                if (sorted[i].socketId === socket.id) { myPos = i + 1; break; }
            }
            currentRaceName = data.raceName;
            currentRacePos  = myPos ? 'P' + myPos : '';
            syncRaceWidgets(currentRaceName, currentRacePos, lapRunning);
        });

        socket.on('race_left', function () {
            currentRaceId   = null;
            currentRaceName = null;
            currentRacePos  = '';
            resetRaceUiState();
            showRaceUI(false);
            loadActiveRaces();
            setHudModeStatus(_isDebugMode ? '🛠 DEBUG' : '');
        });

        socket.on('lap_started', function (data) {
            lapRunning = true;
            lapStartTime = data.startTime;
            document.getElementById('start-lap-btn').disabled = true;
            document.getElementById('stop-lap-btn').disabled = false;
            lapDisplayInterval = setInterval(function () {
                const elapsed = Date.now() - lapStartTime;
                document.getElementById('lap-time-display').textContent = SharedUtils.formatLapTime(elapsed);
            }, 50);
            syncRaceWidgets(currentRaceName, currentRacePos, /*lapActive=*/true);
        });

        socket.on('lap_recorded', function (data) {
            // Only reset lap UI for the player who finished their lap
            if (data.userId === getMyUserId()) {
                lapRunning = false;
                clearInterval(lapDisplayInterval);
                lapDisplayInterval = null;
                document.getElementById('start-lap-btn').disabled = false;
                document.getElementById('stop-lap-btn').disabled = true;
                document.getElementById('lap-time-display').textContent = SharedUtils.formatLapTime(data.lapTimeMs);
                // Clear lap-active state in HUD widget and drawer summary
                syncRaceWidgets(currentRaceName, currentRacePos, /*lapActive=*/false);
                if (data.isGlobalRecord) {
                    flashMessage('🏆 Новый рекорд трассы: ' + SharedUtils.formatLapTime(data.lapTimeMs) + '!', true);
                } else if (data.isPersonalBest) {
                    flashMessage('🎉 Личный рекорд: ' + SharedUtils.formatLapTime(data.lapTimeMs), false);
                } else {
                    flashMessage('Круг: ' + SharedUtils.formatLapTime(data.lapTimeMs), false);
                }
            } else if (data.isGlobalRecord) {
                flashMessage('🏆 ' + data.userId + ' побил рекорд трассы: ' + SharedUtils.formatLapTime(data.lapTimeMs) + '!', true);
            }
            loadLeaderboard();
        });

        document.getElementById('create-race-btn').addEventListener('click', function () {
            if (!sessionData.dbUserId) {
                alert('Войдите и подтвердите email для участия в гонках.');
                return;
            }
            socket.emit('join_race', {
                userId: getMyUserId(),
                carId: carId,
                carName: carName,
                dbUserId: sessionData.dbUserId,
            });
        });

        document.getElementById('join-race-btn').addEventListener('click', function () {
            const raceId = document.getElementById('race-select').value;
            if (!raceId) return;
            if (!sessionData.dbUserId) {
                alert('Войдите и подтвердите email для участия в гонках.');
                return;
            }
            socket.emit('join_race', {
                raceId: raceId,
                userId: getMyUserId(),
                carId: carId,
                carName: carName,
                dbUserId: sessionData.dbUserId,
            });
        });

        document.getElementById('leave-race-btn').addEventListener('click', function () {
            socket.emit('leave_race');
        });

        document.getElementById('start-lap-btn').addEventListener('click', function () {
            socket.emit('start_lap');
        });

        document.getElementById('stop-lap-btn').addEventListener('click', function () {
            socket.emit('end_lap');
        });

        // Load races for the join dropdown initially
        loadActiveRaces();
        loadLeaderboard();
        // Bug 4: Update race list instantly via socket instead of polling
        socket.on('races_updated', function () {
            if (!currentRaceId) loadActiveRaces();
        });
        setInterval(function () {
            if (!currentRaceId) loadActiveRaces();
        }, 30000);

        // ── Chat drawer (extracted to chat-drawer.js) ──
        if (window.ChatDrawer) {
            window.ChatDrawer.init(socket, sessionData);
        }

        // ── Duel UI ──
        if (typeof window.DuelUI !== 'undefined') {
            window.DuelUI.init(socket, { hasActiveSession: hasSession });
        }

        // ── Left drawer toggle ──
        (function () {
            var toggle  = document.getElementById('left-drawer-toggle');
            var drawer  = document.getElementById('left-drawer');
            var closeBtn = document.getElementById('left-drawer-close');
            if (!toggle || !drawer) return;

            function openLeftDrawer() {
                document.body.setAttribute('data-left-drawer-open', 'true');
                drawer.setAttribute('aria-hidden', 'false');
                toggle.setAttribute('aria-expanded', 'true');
            }

            function closeLeftDrawer() {
                document.body.setAttribute('data-left-drawer-open', 'false');
                drawer.setAttribute('aria-hidden', 'true');
                toggle.setAttribute('aria-expanded', 'false');
            }

            toggle.addEventListener('click', function () {
                var isOpen = document.body.getAttribute('data-left-drawer-open') === 'true';
                if (isOpen) { closeLeftDrawer(); } else { openLeftDrawer(); }
            });

            if (closeBtn) closeBtn.addEventListener('click', closeLeftDrawer);

            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && document.body.getAttribute('data-left-drawer-open') === 'true') {
                    closeLeftDrawer();
                }
            });
        }());

        // ── Debug panel toggle button, close button, and backtick hotkey (debug mode only) ──
        if (_isDebugMode) {
            (function () {
                var panel     = document.getElementById('debug-panel');
                var toggleBtn = document.getElementById('debug-panel-toggle');
                var closeBtn  = document.getElementById('debug-panel-close');

                function isPanelOpen() {
                    return panel && !panel.hidden;
                }

                function syncToggleBtn() {
                    if (!toggleBtn) return;
                    if (isPanelOpen()) {
                        toggleBtn.textContent = '🛠 Скрыть консоль';
                        toggleBtn.classList.add('panel-open');
                    } else {
                        toggleBtn.textContent = '🛠 Консоль оператора';
                        toggleBtn.classList.remove('panel-open');
                    }
                }

                function openPanel() {
                    if (!panel) return;
                    panel.hidden = false;
                    syncToggleBtn();
                }

                function closePanel() {
                    if (!panel) return;
                    panel.hidden = true;
                    syncToggleBtn();
                }

                function togglePanel() {
                    if (isPanelOpen()) { closePanel(); } else { openPanel(); }
                }

                if (toggleBtn) toggleBtn.addEventListener('click', togglePanel);
                // Close button: hide panel AND sync the toggle button label
                if (closeBtn)  closeBtn.addEventListener('click', closePanel);

                // Backtick (`) hotkey — toggle debug panel
                document.addEventListener('keydown', function (e) {
                    if (e.key === '`' || e.key === 'Backquote') {
                        // Don't trigger if focus is on a text input
                        var tag = document.activeElement && document.activeElement.tagName;
                        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
                        e.preventDefault();
                        togglePanel();
                    }
                });

                // Initial sync
                syncToggleBtn();
            }());
        }

