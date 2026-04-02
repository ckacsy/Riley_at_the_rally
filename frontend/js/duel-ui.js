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
    // Helpers
    // -------------------------------------------------------------------------

    function escHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fmtLapTime(ms) {
        if (ms == null) return '—';
        var mins = String(Math.floor(ms / 60000)).padStart(2, '0');
        var secs = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        var millis = String(ms % 1000).padStart(3, '0');
        return mins + ':' + secs + '.' + millis;
    }

    function renderOpponentBadge(opponent) {
        if (typeof window.RankUI === 'undefined') {
            return '<span class="rank-badge rank-badge-compact">' + escHtml(opponent.username) + '</span>';
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
    var _duelState = 'idle'; // idle | searching | ready_pending | in_progress | result

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
    // UI state transitions
    // -------------------------------------------------------------------------

    function _setState(state) {
        _duelState = state;

        var isIdle       = state === 'idle';
        var isSearching  = state === 'searching';
        var isMatched    = state === 'ready_pending' || state === 'in_progress';
        var isResult     = state === 'result';

        if (_searchBtn) {
            _searchBtn.disabled = !isIdle || !_hasActiveSession;
            _searchBtn.style.display = (isMatched || isSearching || isResult) ? 'none' : '';
        }
        if (_cancelBtn) {
            _cancelBtn.style.display = isSearching ? '' : 'none';
        }
        if (_statusEl) {
            _statusEl.style.display = '';
        }
        if (_matchCard) {
            _matchCard.style.display = isMatched ? '' : 'none';
        }
        if (_resultCard) {
            _resultCard.style.display = isResult ? '' : 'none';
        }
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

    function _onMatched(data) {
        _setState('ready_pending');
        _setStatusText('✅ Соперник найден! Нажмите «Готов»');

        if (_matchCard) {
            var opponent = data.opponent || {};
            var checkpoints = data.requiredCheckpoints || 0;
            _matchCard.innerHTML =
                '<div class="duel-match-title">⚔️ Соперник найден!</div>' +
                '<div class="duel-match-opponent">' +
                    '<span class="duel-match-label">Соперник:</span> ' +
                    '<span class="duel-opponent-name">' + escHtml(opponent.username) + '</span> ' +
                    renderOpponentBadge(opponent) +
                '</div>' +
                '<div class="duel-match-checkpoints">Чекпоинтов: ' + checkpoints + '</div>' +
                '<div class="duel-ready-section" id="duel-ready-section">' +
                    '<div class="duel-ready-indicators">' +
                        '<span class="duel-ready-indicator" id="duel-own-ready">Я: ⬜</span>' +
                        '<span class="duel-ready-indicator" id="duel-opp-ready">Соперник: ⬜</span>' +
                    '</div>' +
                    '<button class="duel-ready-btn" id="duel-ready-btn">✅ Готов</button>' +
                '</div>';

            var readyBtn = document.getElementById('duel-ready-btn');
            if (readyBtn) {
                readyBtn.addEventListener('click', function () {
                    if (!_socket) return;
                    _socket.emit('duel:ready');
                    readyBtn.disabled = true;
                    var ownReady = document.getElementById('duel-own-ready');
                    if (ownReady) ownReady.textContent = 'Я: ✅';
                });
            }
        }
    }

    function _onOpponentReady() {
        var oppReady = document.getElementById('duel-opp-ready');
        if (oppReady) oppReady.textContent = 'Соперник: ✅';
    }

    function _onDuelStart() {
        _setState('in_progress');
        _setStatusText('⚔️ Дуэль началась!');
        var readySection = document.getElementById('duel-ready-section');
        if (readySection) readySection.style.display = 'none';
    }

    function _onResult(data) {
        _setState('result');

        var result = data.result || '';
        var reason = data.reason || result;
        var rankChange = data.rankChange || null;
        var lapTimeMs = data.lapTimeMs != null ? data.lapTimeMs : null;

        var emoji = '';
        var label = '';
        var cssClass = '';

        if (result === 'win') {
            emoji = '🏆'; label = 'Победа!'; cssClass = 'duel-result-win';
        } else if (result === 'loss') {
            emoji = '💀'; label = 'Поражение'; cssClass = 'duel-result-loss';
        } else if (result === 'timeout') {
            emoji = '⏱'; label = 'Время вышло'; cssClass = 'duel-result-draw';
        } else if (result === 'cancel') {
            emoji = '🚫'; label = 'Дуэль отменена'; cssClass = 'duel-result-draw';
        } else if (result === 'disconnect') {
            emoji = '🔌'; label = 'Соперник отключился'; cssClass = 'duel-result-win';
        } else {
            emoji = '—'; label = result; cssClass = 'duel-result-draw';
        }

        var lapHtml = lapTimeMs != null
            ? '<div class="duel-result-lap">Время круга: <strong>' + fmtLapTime(lapTimeMs) + '</strong></div>'
            : '';

        var rankHtml = '';
        if (rankChange && rankChange['new']) {
            var newRank = rankChange['new'];
            var oldRank = rankChange['old'];
            var deltaStars = 0;
            var deltaRank = 0;
            if (oldRank) {
                deltaStars = (newRank.stars || 0) - (oldRank.stars || 0);
                deltaRank  = (oldRank.rank || 0) - (newRank.rank || 0); // positive = rank improved
            }
            var rankBadgeHtml = typeof window.RankUI !== 'undefined'
                ? window.RankUI.renderRankBadge(newRank, { size: 'compact' })
                : '';

            var deltaText = '';
            if (deltaRank > 0) {
                deltaText = ' <span class="duel-rank-delta duel-rank-up">▲ Ранг повышен</span>';
            } else if (deltaRank < 0) {
                deltaText = ' <span class="duel-rank-delta duel-rank-down">▼ Ранг понижен</span>';
            } else if (deltaStars > 0) {
                deltaText = ' <span class="duel-rank-delta duel-rank-up">+' + deltaStars + '⭐</span>';
            } else if (deltaStars < 0) {
                deltaText = ' <span class="duel-rank-delta duel-rank-down">' + deltaStars + '⭐</span>';
            }

            rankHtml = '<div class="duel-result-rank">Ранг: ' + rankBadgeHtml + deltaText + '</div>';

            // Refresh own rank badge on control page
            _refreshOwnRankBadge();
        }

        if (_resultCard) {
            _resultCard.className = 'duel-result-card ' + cssClass;
            _resultCard.innerHTML =
                '<div class="duel-result-emoji">' + emoji + '</div>' +
                '<div class="duel-result-label">' + label + '</div>' +
                lapHtml +
                rankHtml +
                '<button class="duel-result-dismiss" id="duel-result-dismiss-btn">OK</button>';

            var dismissBtn = document.getElementById('duel-result-dismiss-btn');
            if (dismissBtn) {
                dismissBtn.addEventListener('click', function () {
                    _setState('idle');
                    _setStatusText('');
                    if (_matchCard) _matchCard.innerHTML = '';
                    if (_resultCard) _resultCard.innerHTML = '';
                });
            }
        }

        _setStatusText('');
        if (_matchCard) _matchCard.style.display = 'none';
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
                        _matchCard.style.display = '';
                        if (!document.getElementById('duel-ready-btn')) {
                            _matchCard.innerHTML =
                                '<div class="duel-match-title">⚔️ Подтвердите готовность</div>' +
                                '<div class="duel-ready-section" id="duel-ready-section">' +
                                    '<div class="duel-ready-indicators">' +
                                        '<span class="duel-ready-indicator" id="duel-own-ready">Я: ⬜</span>' +
                                        '<span class="duel-ready-indicator" id="duel-opp-ready">Соперник: ⬜</span>' +
                                    '</div>' +
                                    '<button class="duel-ready-btn" id="duel-ready-btn">✅ Готов</button>' +
                                '</div>';
                            var readyBtn = document.getElementById('duel-ready-btn');
                            if (readyBtn) {
                                readyBtn.addEventListener('click', function () {
                                    if (!_socket) return;
                                    _socket.emit('duel:ready');
                                    readyBtn.disabled = true;
                                    var ownReady = document.getElementById('duel-own-ready');
                                    if (ownReady) ownReady.textContent = 'Я: ✅';
                                });
                            }
                        }
                    }
                } else if (s === 'in_progress') {
                    _setState('in_progress');
                    _setStatusText('⚔️ Дуэль в процессе');
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
        socket.on('duel:start',            _onDuelStart);
        socket.on('duel:result',           _onResult);
        socket.on('duel:error',            _onDuelError);

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
