/**
 * GamepadController — gamepad input module for the /control page.
 *
 * Self-contained: zero impact when no gamepad is connected.
 * Relies on globals exposed by control.js:
 *   window._controlSocket          — Socket.IO socket
 *   window._controlDispatch(state) — unified control pipeline (preferred)
 *   window._addCmdLogEntry(text)   — append to command log
 *   window._resetInactivityCountdown() — reset inactivity timer
 */
(function () {
    'use strict';

    let gamepadIndex = null;
    let gamepadPollRAF = null;
    let lastCommandTime = 0;
    const COMMAND_INTERVAL_MS = 66; // ~15 Hz poll cadence
    const DEADZONE = 0.15;
    let lastSteering = 0;
    let lastSpeed = 0;
    let lastDirection = 'stop';

    function getSocket() {
        return window._controlSocket || null;
    }

    function updateTelemetry(connected, name) {
        const el = document.getElementById('tele-gamepad');
        if (!el) return;
        if (connected) {
            el.textContent = '✓ ' + (name || 'Подключён');
            el.className = 'telemetry-value good';
        } else {
            el.textContent = '—';
            el.className = 'telemetry-value';
        }
    }

    function onGamepadConnected(e) {
        gamepadIndex = e.gamepad.index;
        updateTelemetry(true, e.gamepad.id.substring(0, 20));
        if (!gamepadPollRAF) pollGamepad();
        var addLog = window._addCmdLogEntry;
        if (addLog) addLog('🎮 Геймпад подключён');
    }

    function onGamepadDisconnected(e) {
        if (e.gamepad.index === gamepadIndex) {
            gamepadIndex = null;
            updateTelemetry(false);
            cancelAnimationFrame(gamepadPollRAF);
            gamepadPollRAF = null;
            var addLog = window._addCmdLogEntry;
            if (addLog) addLog('🎮 Геймпад отключён');
        }
    }

    function pollGamepad() {
        gamepadPollRAF = requestAnimationFrame(pollGamepad);
        if (gamepadIndex === null) return;

        const gp = navigator.getGamepads()[gamepadIndex];
        if (!gp) return;

        const now = Date.now();
        if (now - lastCommandTime < COMMAND_INTERVAL_MS) return;

        // Left stick X → steering
        let stickX = gp.axes[0] || 0;
        if (Math.abs(stickX) < DEADZONE) stickX = 0;
        const steering = Math.round(stickX * 90); // -90 to 90

        // Triggers: RT = forward, LT = backward
        let rt = 0;
        let lt = 0;
        if (gp.buttons[7]) rt = gp.buttons[7].value || 0;
        if (gp.buttons[6]) lt = gp.buttons[6].value || 0;

        // B button = emergency stop
        const bButton = gp.buttons[1] && gp.buttons[1].pressed;

        // Determine direction and speed
        let direction = 'stop';
        let speed = 0;
        const speedSlider = document.getElementById('speed-slider');
        const maxSpeed = speedSlider ? parseInt(speedSlider.value, 10) : 50;

        if (bButton) {
            direction = 'stop';
            speed = 0;
        } else if (rt > 0.05) {
            direction = 'forward';
            speed = Math.round(rt * maxSpeed);
        } else if (lt > 0.05) {
            direction = 'backward';
            speed = Math.round(lt * maxSpeed); // positive; direction carries the sign
        }

        // Only send if something meaningfully changed (suppresses analog jitter)
        const steeringChanged = Math.abs(steering - lastSteering) > 2;
        const speedChanged = Math.abs(speed - lastSpeed) > 2 || direction !== lastDirection;

        if (!steeringChanged && !speedChanged) return;

        lastSteering = steering;
        lastSpeed = speed;
        lastDirection = direction;
        lastCommandTime = now;

        // Route through unified pipeline (defined in control.js)
        if (typeof window._controlDispatch === 'function') {
            window._controlDispatch({ direction, speed, steering, source: 'gamepad' });
        } else {
            // Fallback: direct emit (e.g. if control.js loaded out of order)
            const socket = getSocket();
            if (socket) {
                const cmd = { direction, speed: direction === 'backward' ? -speed : speed };
                if (steeringChanged) cmd.steering_angle = steering;
                socket.emit('control_command', cmd);
            }
        }

        // Reset inactivity countdown
        if (typeof window._resetInactivityCountdown === 'function') {
            window._resetInactivityCountdown();
        }
    }

    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

    window.GamepadController = {
        isConnected: function () { return gamepadIndex !== null; },
    };
}());
