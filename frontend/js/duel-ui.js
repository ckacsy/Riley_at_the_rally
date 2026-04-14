/**
 * DuelUI — frontend module for ranked duel search, match, and result states.
 *
 * Responsibilities:
 *  - Bind to duel socket events (duel:searching, duel:matched, duel:result, etc.)
 *  - Manage DOM state transitions: idle → searching → matched → in_progress → result
 *  - Restore duel state on page load via GET /api/duel/status
 *  - Use window.RankUI helpers for rank badge rendering
 *
 * Usage:
 *   window.DuelUI.init(socket, { hasActiveSession: true });
 */
(function (window) {
    'use strict';

    // -------------------------------------------------------------------------
    // Audio helpers (Web Audio API — no external files needed)
    // -------------------------------------------------------------------------

    var _audioCtx = null;
    var BEEP_DURATION = 0.15;    // seconds — short beep for countdown numbers
    var GO_SOUND_DURATION = 0.3; // seconds — longer beep for СТАРТ!

    function _getAudioContext() {
        if (!_audioCtx) {
            try {
                _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                return null;
            }
        }
        return _audioCtx;
    }

    function _playCountdownBeep() {
        try {
            var ctx = _getAudioContext();
            if (!ctx) return;
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 440; // A4 note
            gain.gain.value = 0.3;
            osc.start();
            osc.stop(ctx.currentTime + BEEP_DURATION);
        } catch (e) {} // Ignore if audio not available
    }

    function _playGoSound() {
        try {
            var ctx = _getAudioContext();
            if (!ctx) return;
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880; // A5 note — higher pitch for GO
            gain.gain.value = 0.4;
            osc.start();
            osc.stop(ctx.currentTime + GO_SOUND_DURATION);
        } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------


    function renderOpponentBadge(opponent) {
        if (typeof window.RankUI === 'undefined') {
            return '<span class="rank-badge rank-badge-compact">' + SharedUtils.escapeHtml(opponent.username) + '</span>';
        }
        var rankData = {
            rank: opponent.rank,
            stars: opponent.stars,
            isLegend: opponent.isLegend,
            legendPosition: opponent.legendPosition,
            display: opponent.display || null,
        };
        return window.RankUI.renderRankBadge(rankData, { size: 'compact' });
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    var _socket = null;
    var _hasActiveSession = false;
    var _duelState = 'idle'; // idle | searching | ready_pending | countdown | in_progress | result
    var _countdownInterval = null;

    // -------------------------------------------------------------------------
    // DOM references (set in init)
    // -------------------------------------------------------------------------

    var _panel = null;          // #duel-panel
    var _searchBtn = null;      // #duel-search-btn
    var _cancelBtn = null;      // #duel-cancel-btn
    var _statusEl = null;       // #duel-status-text
    var _matchCard = null;      // #duel-match-card
    var _resultCard = null;     // #duel-result-card
    var _noSessionMsg = null;   // #duel-no-session-msg

    // -------------------------------------------------------------------------
    // Race action availability sync
    // -------------------------------------------------------------------------

    /**
     * Disable or enable race panel interactions depending on whether a duel
     * is currently active (searching / matched / in progress).
     * Locks the entire #race-panel via pointer-events so any future elements
     * inside it are also automatically blocked.
     * create-race-btn lives outside #race-panel and is handled separately.
     */
    function syncRaceActionAvailability() {
        var duelActive = _duelState !== 'idle' && _duelState !== 'result';

        // Block the ENTIRE race panel, not individual buttons
        var racePanel = document.getElementById('race-panel');
        if (racePanel) {
            if (duelActive) {
                racePanel.classList.add('duel-locked');
            } else {
                racePanel.classList.remove('duel-locked');
            }
        }

        // Also block create-race-btn which is OUTSIDE race-panel
        var createBtn = document.getElementById('create-race-btn');
        if (createBtn) {
            createBtn.disabled = duelActive;
        }
    }

    // -------------------------------------------------------------------------
    // UI state transitions
    // -------------------------------------------------------------------------

    function _setState(state) {
        _duelState = state;

        var isIdle       = state === 'idle';
        var isSearching  = state === 'searching';
        var isMatched    = state === 'ready_pending' || state === 'countdown' || state === 'in_progress';
        var isResult     = state === 'result';

        if (_searchBtn) {
            _searchBtn.disabled = !isIdle || !_hasActiveSession;
            _searchBtn.style.display = (isMatched || isSearching || isResult) ? 'none' : '';
        }
        if (_cancelBtn) {
            _cancelBtn.style.display = isSearching ? 'block' : 'none';
        }
        if (_statusEl) {
            _statusEl.style.display = '';
        }
        if (_matchCard) {
            _matchCard.style.display = isMatched ? 'block' : 'none';
        }
        if (_resultCard) {
            _resultCard.style.display = isResult ? 'block' : 'none';
        }

        syncRaceActionAvailability();
    }

    function _setStatusText(text) {
        if (_statusEl) _statusEl.textContent = text;
    }

    // -------------------------------------------------------------------------
    // Socket event handlers
    // -------------------------------------------------------------------------

    function _onSearching() {
        _setState('searching');
        _setStatusText('🔍 Поиск соперника…');
    }

    function _onSearchCancelled() {
        _setState('idle');
        _setStatusText('Поиск отменён.');
        setTimeout(function () {
            if (_duelState === 'idle') _setStatusText('');
        }, 2500);
    }

    function _onSearchTimeout() {
        _setState('idle');
        _setStatusText('⏱ Соперник не найден. Попробуйте ещё раз.');
        setTimeout(function () {
            if (_duelState === 'idle') _setStatusText('');
        }, 4000);
    }

    // -------------------------------------------------------------------------
    // Ready-state helpers
    // -------------------------------------------------------------------------

    /**
     * Attach a click handler to the #duel-cancel-ready-btn that emits
     * duel:cancel_ready and disables the button to prevent double-sends.
     */
    function _attachCancelReadyBtnHandler() {
        var cancelReadyBtn = document.getElementById('duel-cancel-ready-btn');
        if (!cancelReadyBtn) return;
        cancelReadyBtn.addEventListener('click', function () {
            if (!_socket) return;
            _socket.emit('duel:cancel_ready');
            // Do not disable the button here — the server responds with duel:cancelled
            // which resets the entire UI. Keeping the button active allows retries if
            // the emit is lost before the server processes it.
        });
    }

    /**
     * Attach a click handler to the #duel-ready-btn that emits duel:ready,
     * disables itself, and updates the own-ready indicator.
     * Extracted to avoid duplication between _onMatched and _restoreStatus.
     */
    function _attachReadyBtnHandler() {
        var readyBtn = document.getElementById('duel-ready-btn');
        if (!readyBtn) return;
        readyBtn.addEventListener('click', function () {
            if (!_socket) return;
            _socket.emit('duel:ready');
            readyBtn.disabled = true;
            var ownReady = document.getElementById('duel-own-ready');
            if (ownReady) ownReady.textContent = 'Я: ✅';
        });
    }

    function _onMatched(data) {
        _setState('ready_pending');
        _setStatusText('✅ Соперник найден! Нажмите «Готов»');

        var checkpoints = data.requiredCheckpoints || 2;
        window.DuelProgress.setRequiredCheckpoints(checkpoints);

        if (_matchCard) {
            var opponent = data.opponent || {};
            var checkpoints = data.requiredCheckpoints || 0;
            _matchCard.innerHTML =
                '<div class="duel-match-title">⚔️ Соперник найден!</div>' +
                '<div class="duel-match-opponent">' +
                    '<span class="duel-match-label">Соперник:</span> ' +
                    '<span class="duel-opponent-name">' + SharedUtils.escapeHtml(opponent.username) + '</span> ' +
                    renderOpponentBadge(opponent) +
                '</div>' +
                '<div class="duel-match-checkpoints">Чекпоинтов: ' + checkpoints + '</div>' +
                '<div class="duel-ready-section" id="duel-ready-section">' +
                    '<div class="duel-ready-indicators">' +
                        '<span class="duel-ready-indicator" id="duel-own-ready">Я: ⬜</span>' +
                        '<span class="duel-ready-indicator" id="duel-opp-ready">Соперник: ⬜</span>' +
                    '</div>' +
                    '<button class="duel-ready-btn" id="duel-ready-btn">✅ Готов</button>' +
                    '<button class="duel-cancel-ready-btn" id="duel-cancel-ready-btn">✖ Отмена</button>' +
                '</div>';

            _attachReadyBtnHandler();
            _attachCancelReadyBtnHandler();
        }
    }

    function _onOpponentReady() {
        var oppReady = document.getElementById('duel-opp-ready');
        if (oppReady) oppReady.textContent = 'Соперник: ✅';
    }

    function _onCountdown() {
        _setState('countdown');
        _setStatusText('🏁 Приготовьтесь!');

        // Clear any existing interval before setting up a new one (e.g. on reconnect)
        if (_countdownInterval) {
            clearInterval(_countdownInterval);
            _countdownInterval = null;
        }

        var readySection = document.getElementById('duel-ready-section');
        if (readySection) readySection.style.display = 'none';

        var overlay = document.getElementById('duel-countdown-overlay');
        var numberEl = document.getElementById('duel-countdown-number');

        if (overlay && numberEl) {
            overlay.classList.add('visible');

            var count = 3;
            numberEl.textContent = count;
            numberEl.className = 'countdown-number countdown-enter';
            _playCountdownBeep();

            _countdownInterval = setInterval(function () {
                count--;
                if (count > 0) {
                    numberEl.textContent = count;
                    // Trigger animation restart via reflow
                    numberEl.className = 'countdown-number';
                    void numberEl.offsetWidth; // force reflow
                    numberEl.className = 'countdown-number countdown-enter';
                    _playCountdownBeep();
                } else {
                    clearInterval(_countdownInterval);
                    _countdownInterval = null;
                }
            }, 1000);
        }
    }

    function _onDuelStart() {
        if (_countdownInterval) {
            clearInterval(_countdownInterval);
            _countdownInterval = null;
        }
        // Show СТАРТ! in full-screen overlay for 500ms so the user can see it before the lap begins
        var overlay = document.getElementById('duel-countdown-overlay');
        var numberEl = document.getElementById('duel-countdown-number');
        if (overlay && numberEl) {
            numberEl.className = 'countdown-number countdown-go';
            numberEl.textContent = 'СТАРТ!';
            _playGoSound();
        }
        _setState('in_progress');
        _setStatusText('⚔️ Дуэль началась!');
        var readySection = document.getElementById('duel-ready-section');
        if (readySection) readySection.style.display = 'none';
        setTimeout(function () {
            if (overlay) overlay.classList.remove('visible');
            if (_socket) _socket.emit('duel:start_lap');
            window.DuelProgress.activate();
        }, 500);
    }

    function _buildRankHtml(rankChange) {
        if (rankChange == null) return '';
        var newRank = rankChange['new'];
        var oldRank = rankChange['old'];

        if (newRank && newRank.isLegend && oldRank && !oldRank.isLegend) {
            return '<div class="duel-result-rank duel-result-legend">🏅 Вы достигли Легенды!</div>';
        }
        if (newRank && oldRank) {
            var oldRankNum = oldRank.rank || 0;
            var newRankNum = newRank.rank || 0;
            var oldStars   = oldRank.stars || 0;
            var newStars   = newRank.stars || 0;

            if (oldRankNum === newRankNum && oldStars === newStars) {
                return '<div class="duel-result-rank duel-result-no-change">Ранг не изменился</div>';
            }
            var changeHtml = '';
            if (newRankNum < oldRankNum) {
                changeHtml = '<span class="duel-rank-up">▲ Ранг ' + oldRankNum + ' → Ранг ' + newRankNum + '</span>';
            } else if (newRankNum > oldRankNum) {
                changeHtml = '<span class="duel-rank-down">▼ Ранг ' + oldRankNum + ' → Ранг ' + newRankNum + '</span>';
            } else if (newStars > oldStars) {
                changeHtml = '<span class="duel-rank-up">' + '★'.repeat(newStars) + '</span>';
            } else if (newStars < oldStars) {
                changeHtml = '<span class="duel-rank-down">' + '★'.repeat(newStars) + '</span>';
            }
            return changeHtml ? '<div class="duel-result-rank">' + changeHtml + '</div>' : '';
        }
        return '';
    }

    function _onResult(data) {
        // Cancel any running countdown
        if (_countdownInterval) {
            clearInterval(_countdownInterval);
            _countdownInterval = null;
        }
        var cdOverlay = document.getElementById('duel-countdown-overlay');
        if (cdOverlay) cdOverlay.classList.remove('visible');

        _setState('result');

        var result = data.result || '';
        var reason = data.reason || result;
        var rankChange = data.rankChange != null ? data.rankChange : null;
        var lapTimeMs = data.lapTimeMs != null ? data.lapTimeMs : null;
        var opponent = data.opponent != null ? data.opponent : null;

        var title = '';
        var resultClass = 'duel-result-draw';

        if (result === 'win') {
            title = reason === 'disconnect'
                ? '🏆 Победа (соперник отключился)'
                : '🏆 Победа!';
            resultClass = 'duel-result-win';
        } else if (result === 'loss') {
            title = '❌ Поражение';
            resultClass = 'duel-result-loss';
        } else if (result === 'cancel') {
            title = '⚪ Дуэль отменена';
        } else if (result === 'timeout') {
            title = '⏱ Время вышло';
        } else if (result === 'ready_timeout') {
            title = '⏱ Соперник не подтвердил готовность';
        } else {
            title = result;
        }

        // Time comparison section (for win/loss with at least one lap time)
        var timesHtml = '';
        if (result === 'win' || result === 'loss') {
            var myTimeStr  = lapTimeMs ? SharedUtils.formatLapTime(lapTimeMs) : '—';
            var oppTimeStr = (opponent && opponent.lapTimeMs) ? SharedUtils.formatLapTime(opponent.lapTimeMs) : '—';

            var diffHtml = '';
            if (lapTimeMs && opponent && opponent.lapTimeMs) {
                var diffMs  = lapTimeMs - opponent.lapTimeMs;
                var diffSec = (Math.abs(diffMs) / 1000).toFixed(3);
                var diffSign = diffMs > 0 ? '+' : '-';
                var diffClass = diffMs <= 0 ? 'duel-rank-up' : 'duel-rank-down';
                diffHtml = '<div class="duel-result-timediff ' + diffClass + '">' +
                    diffSign + diffSec + 'с</div>';
            }

            timesHtml =
                '<div class="duel-result-times">' +
                    '<div class="duel-result-time-col">' +
                        '<div class="duel-result-time-label">Ваше время</div>' +
                        '<div class="duel-result-time-val">' + SharedUtils.escapeHtml(myTimeStr) + '</div>' +
                    '</div>' +
                    '<div class="duel-result-time-col">' +
                        '<div class="duel-result-time-label">Соперник</div>' +
                        '<div class="duel-result-time-val">' + SharedUtils.escapeHtml(oppTimeStr) + '</div>' +
                    '</div>' +
                '</div>' +
                diffHtml;
        } else if (lapTimeMs && lapTimeMs > 0) {
            timesHtml = '<div class="duel-result-lap">Время круга: <strong>' +
                SharedUtils.escapeHtml(SharedUtils.formatLapTime(lapTimeMs)) + '</strong></div>';
        }

        var rankHtml = _buildRankHtml(rankChange);

        var opponentHtml = '';
        if (opponent && opponent.username) {
            opponentHtml = '<div class="duel-result-opponent">vs. <strong>' +
                SharedUtils.escapeHtml(opponent.username) + '</strong></div>';
        }

        if (_resultCard) {
            _resultCard.className = 'duel-result-card ' + resultClass;
            _resultCard.style.display = 'block';
            _resultCard.innerHTML =
                '<div class="duel-result-label">' + SharedUtils.escapeHtml(title) + '</div>' +
                timesHtml +
                rankHtml +
                opponentHtml +
                '<button class="duel-result-dismiss" id="duel-result-dismiss-btn">Закрыть</button>';

            var dismissBtn = document.getElementById('duel-result-dismiss-btn');
            if (dismissBtn) {
                dismissBtn.addEventListener('click', function () {
                    _setState('idle');
                    _setStatusText('');
                    if (_matchCard) _matchCard.innerHTML = '';
                    if (_resultCard) {
                        _resultCard.innerHTML = '';
                    }
                    _refreshOwnRankBadge();
                });
            }
        }

        _setStatusText('');
        if (_matchCard) _matchCard.style.display = 'none';
        window.DuelProgress.reset();
    }

    function _onDuelError(data) {
        var code = (data && data.code) || '';
        if (code === 'already_in_duel') return; // silently ignore if already tracked
        _setState('idle');
        _setStatusText('⚠ ' + (data && data.message ? data.message : 'Ошибка дуэли.'));
        setTimeout(function () {
            if (_duelState === 'idle') _setStatusText('');
        }, 4000);
    }

    function _onDuelCancelled(data) {
        // Cancel any running countdown
        if (_countdownInterval) {
            clearInterval(_countdownInterval);
            _countdownInterval = null;
        }
        var cdOverlay = document.getElementById('duel-countdown-overlay');
        if (cdOverlay) cdOverlay.classList.remove('visible');

        var reason = data && data.reason;
        var msg = reason === 'finish_rejected'
            ? 'Дуэль отменена: финиш не принят (слишком быстро).'
            : 'Дуэль отменена.';
        _setState('idle');
        _setStatusText(msg);
        if (_matchCard) _matchCard.innerHTML = '';
        window.DuelProgress.reset();
        setTimeout(function () {
            if (_duelState === 'idle') _setStatusText('');
        }, 2500);
    }

    // -------------------------------------------------------------------------
    // Rank badge refresh
    // -------------------------------------------------------------------------

    function _refreshOwnRankBadge() {
        var wrap = document.getElementById('control-rank-wrap');
        if (!wrap || typeof window.RankUI === 'undefined') return;
        fetch('/api/profile/rank', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (rankData) {
                if (!rankData) return;
                wrap.innerHTML = window.RankUI.renderRankBadge(rankData, { size: 'compact' });
            })
            .catch(function () {});
    }

    // -------------------------------------------------------------------------
    // Status restoration on page load
    // -------------------------------------------------------------------------

    function _restoreStatus() {
        fetch('/api/duel/status', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data) return;
                var s = data.status;
                if (s === 'searching') {
                    _setState('searching');
                    _setStatusText('🔍 Поиск соперника…');
                } else if (s === 'ready_pending') {
                    _setState('ready_pending');
                    _setStatusText('✅ Соперник найден — нажмите «Готов»');
                    if (_matchCard) {
                        _matchCard.style.display = 'block';
                        if (!document.getElementById('duel-ready-btn')) {
                            _matchCard.innerHTML =
                                '<div class="duel-match-title">⚔️ Подтвердите готовность</div>' +
                                '<div class="duel-ready-section" id="duel-ready-section">' +
                                    '<div class="duel-ready-indicators">' +
                                        '<span class="duel-ready-indicator" id="duel-own-ready">Я: ⬜</span>' +
                                        '<span class="duel-ready-indicator" id="duel-opp-ready">Соперник: ⬜</span>' +
                                    '</div>' +
                                    '<button class="duel-ready-btn" id="duel-ready-btn">✅ Готов</button>' +
                                    '<button class="duel-cancel-ready-btn" id="duel-cancel-ready-btn">✖ Отмена</button>' +
                                '</div>';
                            _attachReadyBtnHandler();
                            _attachCancelReadyBtnHandler();
                        }
                    }
                } else if (s === 'in_progress' || s === 'countdown') {
                    // Treat countdown as in_progress on restore: the 3s window is too short
                    // to reconstruct the countdown UI, so go straight to active racing state.
                    _setState('in_progress');
                    _setStatusText('⚔️ Дуэль в процессе');
                    if (_socket) _socket.emit('duel:start_lap');
                    window.DuelProgress.activate();
                } else if (s === 'finished') {
                    _setState('result');
                    _setStatusText('Дуэль завершена');
                }
            })
            .catch(function () {});
    }

    // -------------------------------------------------------------------------
    // Public init
    // -------------------------------------------------------------------------

    function init(socket, opts) {
        _socket = socket;
        _hasActiveSession = !!(opts && opts.hasActiveSession);

        _panel         = document.getElementById('duel-panel');
        _searchBtn     = document.getElementById('duel-search-btn');
        _cancelBtn     = document.getElementById('duel-cancel-btn');
        _statusEl      = document.getElementById('duel-status-text');
        _matchCard     = document.getElementById('duel-match-card');
        _resultCard    = document.getElementById('duel-result-card');
        _noSessionMsg  = document.getElementById('duel-no-session-msg');

        if (!_panel) return; // panel not present in DOM

        // Show/hide no-session message
        if (_noSessionMsg) {
            _noSessionMsg.style.display = _hasActiveSession ? 'none' : '';
        }
        if (_searchBtn) {
            _searchBtn.disabled = !_hasActiveSession;
        }

        // Initial state
        _setState('idle');

        // Button handlers
        if (_searchBtn) {
            _searchBtn.addEventListener('click', function () {
                if (!_hasActiveSession) return;
                socket.emit('duel:search');
            });
        }
        if (_cancelBtn) {
            _cancelBtn.addEventListener('click', function () {
                socket.emit('duel:cancel_search');
            });
        }

        // Socket events
        socket.on('duel:searching',        _onSearching);
        socket.on('duel:search_cancelled', _onSearchCancelled);
        socket.on('duel:search_timeout',   _onSearchTimeout);
        socket.on('duel:matched',          _onMatched);
        socket.on('duel:opponent_ready',   _onOpponentReady);
        socket.on('duel:countdown',        _onCountdown);
        socket.on('duel:start',            _onDuelStart);
        socket.on('duel:result',           _onResult);
        socket.on('duel:cancelled',        _onDuelCancelled);
        socket.on('duel:error',            _onDuelError);

        // DuelProgress socket wiring
        window.DuelProgress.init(socket);

        // Restore state if page was refreshed mid-duel
        if (_hasActiveSession) {
            _restoreStatus();
        }
    }

    // -------------------------------------------------------------------------
    // Export
    // -------------------------------------------------------------------------

    window.DuelUI = {
        init: init,
    };

}(window));
