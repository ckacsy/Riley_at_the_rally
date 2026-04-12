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
            if (bar) bar.style.display = '';

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
            const entry = { text, el: document.createElement('div') };
            entry.el.className = 'cmd-log-entry';
            entry.el.textContent = text;
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

        function flashButton(id) {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.classList.add('button-active');
            setTimeout(function () { btn.classList.remove('button-active'); }, 150);
        }

        speedSlider.addEventListener('input', function () {
            resetInactivityCountdown();
            speedValue.textContent = speedSlider.value;
            showSpeedToast(speedSlider.value);
        });

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
                    reasonEl.style.display = '';
                } else if (data.reason === 'inactivity') {
                    reasonEl.textContent = '💤 Сессия завершена: превышен лимит бездействия.';
                    reasonEl.style.display = '';
                } else if (data.reason === 'admin_force_end') {
                    reasonEl.textContent = '🛑 Сессия завершена оператором.';
                    reasonEl.style.display = '';
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

        document.getElementById('forward').addEventListener('click', function () {
            resetInactivityCountdown();
            flashButton('forward');
            const speed = parseInt(speedSlider.value, 10);
            addCmdLogEntry('→ вперёд @ ' + speed + '%');
            socket.emit('control_command', { direction: 'forward', speed: speed });
        });

        document.getElementById('backward').addEventListener('click', function () {
            resetInactivityCountdown();
            flashButton('backward');
            const speed = parseInt(speedSlider.value, 10);
            addCmdLogEntry('→ назад @ ' + speed + '%');
            socket.emit('control_command', { direction: 'backward', speed: -speed });
        });

        document.getElementById('left').addEventListener('click', function () {
            resetInactivityCountdown();
            flashButton('left');
            addCmdLogEntry('→ поворот влево');
            socket.emit('control_command', { steering_angle: -30 });
        });

        document.getElementById('right').addEventListener('click', function () {
            resetInactivityCountdown();
            flashButton('right');
            addCmdLogEntry('→ поворот вправо');
            socket.emit('control_command', { steering_angle: 30 });
        });

        // Keyboard controls: arrow keys for continuous movement
        const pressedKeys = new Set();
        let keyControlInterval = null;
        let lastCommandSignature = '';

        function updateKeyButtonHighlights() {
            ['forward', 'backward', 'left', 'right'].forEach(function (id) {
                const btn = document.getElementById(id);
                if (!btn) return;
                const isActive = (id === 'forward' && pressedKeys.has('ArrowUp')) ||
                                 (id === 'backward' && pressedKeys.has('ArrowDown')) ||
                                 (id === 'left' && pressedKeys.has('ArrowLeft')) ||
                                 (id === 'right' && pressedKeys.has('ArrowRight'));
                btn.classList.toggle('button-active', isActive);
            });
        }

        function sendKeyCommand() {
            resetInactivityCountdown();
            var sig = '';
            if (pressedKeys.has('ArrowUp')) sig += (sig ? ' + ' : '') + 'Вперёд';
            if (pressedKeys.has('ArrowDown')) sig += (sig ? ' + ' : '') + 'Назад';
            if (pressedKeys.has('ArrowLeft')) sig += (sig ? ' + ' : '') + 'Влево';
            if (pressedKeys.has('ArrowRight')) sig += (sig ? ' + ' : '') + 'Вправо';
            if (sig !== lastCommandSignature) {
                lastCommandSignature = sig;
                addCmdLogEntry('⌨️ ' + (sig || 'Стоп'));
            }
            const speed = parseInt(speedSlider.value, 10);
            const cmd = {};
            if (pressedKeys.has('ArrowUp')) {
                cmd.direction = 'forward';
                cmd.speed = speed;
            } else if (pressedKeys.has('ArrowDown')) {
                cmd.direction = 'backward';
                cmd.speed = -speed;
            }
            if (pressedKeys.has('ArrowLeft')) {
                cmd.steering_angle = -30;
            } else if (pressedKeys.has('ArrowRight')) {
                cmd.steering_angle = 30;
            }
            if (Object.keys(cmd).length > 0) {
                socket.emit('control_command', cmd);
            }
        }

        document.addEventListener('keydown', function (e) {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                if (!pressedKeys.has(e.key)) {
                    pressedKeys.add(e.key);
                    updateKeyButtonHighlights();
                    sendKeyCommand();
                    if (!keyControlInterval) {
                        keyControlInterval = setInterval(sendKeyCommand, 100);
                    }
                }
            }
        });

        document.addEventListener('keyup', function (e) {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                pressedKeys.delete(e.key);
                updateKeyButtonHighlights();
                if (pressedKeys.size === 0) {
                    clearInterval(keyControlInterval);
                    keyControlInterval = null;
                    socket.emit('control_command', { direction: 'stop', speed: 0 });
                    if (lastCommandSignature !== '') {
                        lastCommandSignature = '';
                        addCmdLogEntry('⌨️ Стоп');
                    }
                } else {
                    sendKeyCommand();
                }
            }
        });

        // --- Race / Multiplayer Logic ---
        let currentRaceId = null;
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
        }

        function renderPositions(players) {
            // Sort by lapCount desc, then bestLapTime asc
            const sorted = players.slice().sort(function (a, b) {
                if (b.lapCount !== a.lapCount) return b.lapCount - a.lapCount;
                if (!a.bestLapTime) return 1;
                if (!b.bestLapTime) return -1;
                return a.bestLapTime - b.bestLapTime;
            });
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
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#888">Нет рекордов</td></tr>';
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
                    if (tbody) tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#888">Пока нет рекордов</td></tr>';
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
            currentRaceId = data.raceId;
            // Clear the selectedRaceId so reconnections don't re-join automatically
            const updated = Object.assign({}, sessionData);
            delete updated.selectedRaceId;
            sessionStorage.setItem('activeSession', JSON.stringify(updated));
            document.getElementById('race-status-bar').textContent =
                '🏎 ' + data.raceName + ' — вы в гонке!';
            showRaceUI(true);
            renderPositions(data.players);
            loadLeaderboard();
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
        });

        socket.on('race_left', function () {
            currentRaceId = null;
            resetRaceUiState();
            showRaceUI(false);
            loadActiveRaces();
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
        });

        socket.on('lap_recorded', function (data) {
            // Bug 1: Only reset lap UI for the player who finished their lap
            if (data.userId === getMyUserId()) {
                lapRunning = false;
                clearInterval(lapDisplayInterval);
                lapDisplayInterval = null;
                document.getElementById('start-lap-btn').disabled = false;
                document.getElementById('stop-lap-btn').disabled = true;
                document.getElementById('lap-time-display').textContent = SharedUtils.formatLapTime(data.lapTimeMs);
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
