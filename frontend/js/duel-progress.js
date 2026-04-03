/**
 * DuelProgress — Live checkpoint tracker UI for ranked duels.
 *
 * Responsibilities:
 *  - Display real-time checkpoint progress during active duels
 *  - Track elapsed time since lap start
 *  - Update checkpoint indicators as they are hit
 *  - Show finish status when all checkpoints are passed
 *
 * Usage (called from DuelUI):
 *   window.DuelProgress.init(socket);
 *   window.DuelProgress.setRequiredCheckpoints(2);
 *   window.DuelProgress.activate();
 *   window.DuelProgress.reset();
 */
(function (window) {
    'use strict';

    // -------------------------------------------------------------------------
    // CheckpointSource — abstraction layer for checkpoint/finish triggering.
    //   mode='manual'  → clickable buttons (current stage)
    //   mode='sensor'  → future: hardware sensor API
    // -------------------------------------------------------------------------

    function CheckpointSource(socket, mode) {
        this.socket = socket;
        this.mode   = mode || 'manual';
    }

    CheckpointSource.prototype.triggerCheckpoint = function (index) {
        this.socket.emit('duel:checkpoint', { index: index });
    };

    CheckpointSource.prototype.triggerFinish = function () {
        this.socket.emit('duel:finish_lap');
    };

    // -------------------------------------------------------------------------
    // Module state
    // -------------------------------------------------------------------------

    var _socket              = null;
    var _checkpointSource    = null;
    var _active              = false;
    var _checkpoints         = [];    // Array of { hit: boolean, timestamp: null|number }
    var _requiredCheckpoints = 2;     // Default; overridden by setRequiredCheckpoints()
    var _lapStartTime        = null;  // Date.now() when lap started
    var _elapsedInterval     = null;  // setInterval handle for elapsed time display

    // -------------------------------------------------------------------------
    // DOM helpers
    // -------------------------------------------------------------------------

    function _getPanel() {
        return document.getElementById('duel-progress-panel');
    }

    function _getElapsedEl() {
        return document.getElementById('duel-progress-elapsed');
    }

    function _getCheckpointsEl() {
        return document.getElementById('duel-progress-checkpoints');
    }

    function _getFinishEl() {
        return document.getElementById('duel-progress-finish');
    }

    function _getEmulationEl() {
        return document.getElementById('duel-emulation-controls');
    }

    // -------------------------------------------------------------------------
    // Emulation button helpers
    // -------------------------------------------------------------------------

    function _renderEmulationButtons() {
        var container = _getEmulationEl();
        if (!container) return;

        container.innerHTML = '';

        var label = document.createElement('div');
        label.className = 'duel-emulation-label';
        label.textContent = '🧪 Эмуляция трассы';
        container.appendChild(label);

        for (var i = 0; i < _requiredCheckpoints; i++) {
            var btn = document.createElement('button');
            btn.className = 'duel-emulation-btn';
            btn.id = 'duel-emu-btn-' + i;
            btn.textContent = 'Чекпоинт ' + (i + 1);
            btn.disabled = (i !== 0); // only first button active
            (function (idx) {
                btn.addEventListener('click', function () {
                    if (_checkpointSource) _checkpointSource.triggerCheckpoint(idx);
                });
            }(i));
            container.appendChild(btn);
        }

        var finishBtn = document.createElement('button');
        finishBtn.className = 'duel-emulation-btn duel-emulation-finish';
        finishBtn.id = 'duel-emu-finish-btn';
        finishBtn.textContent = 'Финиш';
        finishBtn.disabled = true;
        finishBtn.addEventListener('click', function () {
            if (_checkpointSource) _checkpointSource.triggerFinish();
        });
        container.appendChild(finishBtn);
    }

    function _updateEmulationButtons(confirmedIndex) {
        var confirmedBtn = document.getElementById('duel-emu-btn-' + confirmedIndex);
        if (confirmedBtn) {
            confirmedBtn.textContent = 'Чекпоинт ' + (confirmedIndex + 1) + ' ✅';
            confirmedBtn.disabled = true;
        }

        var nextIndex = confirmedIndex + 1;
        if (nextIndex < _requiredCheckpoints) {
            var nextBtn = document.getElementById('duel-emu-btn-' + nextIndex);
            if (nextBtn) nextBtn.disabled = false;
        } else {
            // All checkpoints done — activate finish button
            var finishBtn = document.getElementById('duel-emu-finish-btn');
            if (finishBtn) finishBtn.disabled = false;
        }
    }

    function _resetEmulationButtons() {
        var container = _getEmulationEl();
        if (container) container.innerHTML = '';
    }

    // -------------------------------------------------------------------------
    // Elapsed time formatting
    // -------------------------------------------------------------------------

    function _fmtElapsed(ms) {
        var mins   = String(Math.floor(ms / 60000)).padStart(2, '0');
        var secs   = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        var millis = String(ms % 1000).padStart(3, '0');
        return mins + ':' + secs + '.' + millis;
    }

    function _updateElapsed() {
        if (_lapStartTime == null) return;
        var elapsed = Date.now() - _lapStartTime;
        var el = _getElapsedEl();
        if (el) el.textContent = '⏱ ' + _fmtElapsed(elapsed);
    }

    // -------------------------------------------------------------------------
    // Checkpoint rendering
    // -------------------------------------------------------------------------

    function _renderCheckpoints() {
        var container = _getCheckpointsEl();
        if (!container) return;
        container.innerHTML = '';
        for (var i = 0; i < _requiredCheckpoints; i++) {
            var cp    = _checkpoints[i] || { hit: false, timestamp: null };
            var item  = document.createElement('div');
            item.className = 'duel-checkpoint-item' + (cp.hit ? ' hit' : '');
            item.id = 'duel-cp-item-' + i;

            var icon  = document.createElement('span');
            icon.className = 'duel-checkpoint-icon';
            icon.id = 'duel-cp-icon-' + i;
            icon.textContent = cp.hit ? '✅' : '⬜';

            var label = document.createElement('span');
            label.textContent = 'Чекпоинт ' + (i + 1);

            var time  = document.createElement('span');
            time.className = 'duel-checkpoint-time';
            time.id = 'duel-cp-time-' + i;
            if (cp.hit && cp.timestamp != null && _lapStartTime != null) {
                time.textContent = '+' + _fmtElapsed(cp.timestamp - _lapStartTime);
            } else {
                time.textContent = '';
            }

            item.appendChild(icon);
            item.appendChild(label);
            item.appendChild(time);
            container.appendChild(item);
        }
    }

    // -------------------------------------------------------------------------
    // Socket event handlers
    // -------------------------------------------------------------------------

    function _onLapStarted() {
        _lapStartTime = Date.now();
        if (_elapsedInterval) {
            clearInterval(_elapsedInterval);
            _elapsedInterval = null;
        }
        _elapsedInterval = setInterval(_updateElapsed, 50);

        var el = _getElapsedEl();
        if (el) el.textContent = '⏱ 00:00.000';
    }

    function _onCheckpointOk(data) {
        var index = data && data.index != null ? data.index : -1;
        if (index < 0 || index >= _requiredCheckpoints) return;

        if (!_checkpoints[index]) {
            _checkpoints[index] = { hit: false, timestamp: null };
        }
        _checkpoints[index].hit = true;
        _checkpoints[index].timestamp = Date.now();

        // Update DOM for this checkpoint item
        var item = document.getElementById('duel-cp-item-' + index);
        if (item) {
            item.className = 'duel-checkpoint-item hit';
        }
        var icon = document.getElementById('duel-cp-icon-' + index);
        if (icon) icon.textContent = '✅';

        var timeEl = document.getElementById('duel-cp-time-' + index);
        if (timeEl && _lapStartTime != null) {
            timeEl.textContent = '+' + _fmtElapsed(_checkpoints[index].timestamp - _lapStartTime);
        }

        // Check if all checkpoints are hit
        var allHit = true;
        for (var i = 0; i < _requiredCheckpoints; i++) {
            if (!(_checkpoints[i] && _checkpoints[i].hit)) {
                allHit = false;
                break;
            }
        }
        if (allHit) {
            var finishEl = _getFinishEl();
            if (finishEl) {
                finishEl.textContent = '🏁 Финиш: все чекпоинты пройдены!';
                finishEl.className = 'duel-progress-finish ready';
            }
        }

        // Update emulation button for this checkpoint
        _updateEmulationButtons(index);
    }

    function _onResult() {
        if (_elapsedInterval) {
            clearInterval(_elapsedInterval);
            _elapsedInterval = null;
        }
        _resetEmulationButtons();
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    window.DuelProgress = {

        /**
         * Bind socket events. Must be called once during init.
         * @param {object} socket — Socket.IO instance
         */
        init: function (socket) {
            _socket = socket;
            _checkpointSource = new CheckpointSource(socket, 'manual');
            socket.on('duel:lap_started', function () {
                _onLapStarted();
            });
            socket.on('duel:checkpoint_ok', function (data) {
                _onCheckpointOk(data);
            });
            socket.on('duel:result', function () {
                _onResult();
            });
        },

        /**
         * Store how many checkpoints are required for this duel.
         * Called from DuelUI._onMatched before activate().
         * @param {number} n
         */
        setRequiredCheckpoints: function (n) {
            _requiredCheckpoints = (typeof n === 'number' && n > 0) ? n : 2;
        },

        /**
         * Show the progress panel and prepare UI for an incoming lap.
         * Idempotent — safe to call multiple times.
         */
        activate: function () {
            _active = true;

            // Reset checkpoint state
            _checkpoints = [];
            for (var i = 0; i < _requiredCheckpoints; i++) {
                _checkpoints.push({ hit: false, timestamp: null });
            }

            var panel = _getPanel();
            if (panel) panel.style.display = '';

            // Reset elapsed display
            var elapsedEl = _getElapsedEl();
            if (elapsedEl) elapsedEl.textContent = '⏱ 00:00.000';

            // Reset finish indicator
            var finishEl = _getFinishEl();
            if (finishEl) {
                finishEl.textContent = '🏁 Финиш: ожидание';
                finishEl.className = 'duel-progress-finish';
            }

            // Render checkpoint items (status indicators)
            _renderCheckpoints();

            // Render emulation control buttons (manual trigger harness)
            _renderEmulationButtons();
        },

        /**
         * Hide the panel and clear all state.
         * Idempotent — safe to call when panel is already hidden.
         */
        reset: function () {
            _active = false;

            if (_elapsedInterval) {
                clearInterval(_elapsedInterval);
                _elapsedInterval = null;
            }

            _lapStartTime = null;
            _checkpoints  = [];

            var panel = _getPanel();
            if (panel) panel.style.display = 'none';

            // Reset child elements
            var elapsedEl = _getElapsedEl();
            if (elapsedEl) elapsedEl.textContent = '⏱ 00:00.000';

            var checkpointsEl = _getCheckpointsEl();
            if (checkpointsEl) checkpointsEl.innerHTML = '';

            var finishEl = _getFinishEl();
            if (finishEl) {
                finishEl.textContent = '🏁 Финиш: ожидание';
                finishEl.className = 'duel-progress-finish';
            }

            _resetEmulationButtons();
        },
    };

}(window));
