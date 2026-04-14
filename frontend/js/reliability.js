/**
 * reliability.js — Global frontend reliability layer (Task 9.6)
 *
 * Provides:
 *   window.Reliability.installGlobalErrorHandlers()
 *   window.Reliability.showGlobalNotice(message, level)
 *   window.Reliability.setConnectionState({ connected, reconnecting, stale })
 *   window.Reliability.installSocketReliability(socket)
 *
 * Auto-installs global error/rejection handlers on load.
 * No unsafe-inline required — loaded as an external script.
 */
(function (window) {
    'use strict';

    var RECONNECT_FAIL_MS = 30000; // 30 s before showing "please refresh"
    var NOTICE_DISMISS_MS = 5000;  // auto-dismiss toast after 5 s
    var NOTICE_FADE_MS    = 400;   // CSS fade-out duration

    var _noticeContainer  = null;
    var _reconnectBanner  = null;
    var _reconnectTimer   = null;
    var _bannerVisible    = false;

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _ensureNoticeContainer() {
        if (_noticeContainer) return _noticeContainer;
        _noticeContainer = document.createElement('div');
        _noticeContainer.id = 'global-notice-container';
        _noticeContainer.setAttribute('aria-live', 'polite');
        _noticeContainer.setAttribute('aria-atomic', 'false');
        document.body.appendChild(_noticeContainer);
        return _noticeContainer;
    }

    function _ensureReconnectBanner() {
        if (_reconnectBanner) return _reconnectBanner;
        _reconnectBanner = document.createElement('div');
        _reconnectBanner.id = 'global-reconnect-banner';
        _reconnectBanner.className = 'global-reconnect-banner';
        _reconnectBanner.setAttribute('role', 'status');
        _reconnectBanner.setAttribute('aria-live', 'polite');
        document.body.appendChild(_reconnectBanner);
        return _reconnectBanner;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Show a non-blocking toast notification.
     *
     * @param {string} message - User-facing message (must NOT contain stack traces)
     * @param {'info'|'warn'|'error'} [level='info']
     */
    function showGlobalNotice(message, level) {
        var container = _ensureNoticeContainer();
        var toast = document.createElement('div');
        toast.className = 'global-notice global-notice-' + (level || 'info');
        toast.setAttribute('role', 'alert');
        toast.textContent = message;
        container.appendChild(toast);

        // Schedule auto-dismiss
        setTimeout(function () {
            toast.classList.add('global-notice-fade');
            setTimeout(function () {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, NOTICE_FADE_MS);
        }, NOTICE_DISMISS_MS);
    }

    /**
     * Update the persistent connection-state banner.
     *
     * @param {{ connected?: boolean, reconnecting?: boolean, stale?: boolean }} state
     */
    function setConnectionState(state) {
        var banner = _ensureReconnectBanner();

        if (state.stale) {
            _bannerVisible = true;
            banner.className = 'global-reconnect-banner global-reconnect-stale';
            banner.textContent = '⚠️ Соединение потеряно. Обновите страницу.';
        } else if (state.reconnecting) {
            _bannerVisible = true;
            banner.className = 'global-reconnect-banner global-reconnect-connecting';
            banner.textContent = '🔄 Переподключение…';
        } else if (state.connected) {
            if (_bannerVisible) {
                // Briefly show "restored" before hiding
                banner.className = 'global-reconnect-banner global-reconnect-ok';
                banner.textContent = '✓ Соединение восстановлено';
                setTimeout(function () {
                    banner.className = 'global-reconnect-banner';
                    _bannerVisible = false;
                }, 2000);
            } else {
                banner.className = 'global-reconnect-banner';
            }
        }
    }

    /**
     * Hook Socket.IO lifecycle events to drive the reconnect banner.
     * Safe to call even before `connect` fires.
     *
     * @param {object} socket - Socket.IO client instance
     */
    function installSocketReliability(socket) {
        socket.on('disconnect', function () {
            clearTimeout(_reconnectTimer);
            setConnectionState({ reconnecting: true });

            _reconnectTimer = setTimeout(function () {
                setConnectionState({ stale: true });
            }, RECONNECT_FAIL_MS);
        });

        socket.on('reconnect_attempt', function () {
            setConnectionState({ reconnecting: true });
        });

        socket.on('connect_error', function () {
            if (!socket.connected) {
                setConnectionState({ reconnecting: true });
            }
        });

        socket.on('connect', function () {
            clearTimeout(_reconnectTimer);
            setConnectionState({ connected: true });
        });

        socket.on('reconnect_failed', function () {
            clearTimeout(_reconnectTimer);
            setConnectionState({ stale: true });
        });
    }

    /**
     * Install window-level error and unhandled-rejection handlers.
     * Logs detailed info to the console; shows only a safe message to the user.
     */
    function installGlobalErrorHandlers() {
        window.onerror = function (message, source, lineno, colno, error) {
            console.error('[reliability] Uncaught error:', message,
                '\n  at', source, lineno + ':' + colno,
                '\n ', error);
            showGlobalNotice('Произошла непредвиденная ошибка.', 'error');
            return false; // let browser default handler also run
        };

        window.addEventListener('unhandledrejection', function (event) {
            console.error('[reliability] Unhandled promise rejection:', event.reason);
            showGlobalNotice('Произошла непредвиденная ошибка.', 'error');
        });
    }

    // -------------------------------------------------------------------------
    // Expose
    // -------------------------------------------------------------------------

    window.Reliability = {
        installGlobalErrorHandlers: installGlobalErrorHandlers,
        showGlobalNotice: showGlobalNotice,
        setConnectionState: setConnectionState,
        installSocketReliability: installSocketReliability,
    };

    // Auto-install on load
    installGlobalErrorHandlers();

}(window));
