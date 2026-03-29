'use strict';

/**
 * Admin API helper module.
 * Provides a thin wrapper around fetch() with:
 *  - automatic credentials inclusion
 *  - CSRF token management with one-shot retry on 403
 *  - automatic redirect to login on 401
 *  - role-based access guard
 */
(function (global) {
    var _csrfToken = null;

    /**
     * Fetch and cache the CSRF token.
     * @returns {Promise<string>}
     */
    function getCsrfToken() {
        if (_csrfToken) return Promise.resolve(_csrfToken);
        return fetch('/api/csrf-token', { credentials: 'include' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                _csrfToken = data.csrfToken || '';
                return _csrfToken;
            });
    }

    /**
     * Force-refresh the CSRF token (called after 403 CSRF failure).
     * @returns {Promise<string>}
     */
    function refreshCsrfToken() {
        _csrfToken = null;
        return getCsrfToken();
    }

    /**
     * Fetch /api/auth/me and return the user object, or null on failure.
     * @returns {Promise<object|null>}
     */
    function getCurrentUser() {
        return fetch('/api/auth/me', { credentials: 'include' })
            .then(function (r) {
                if (!r.ok) return null;
                return r.json().then(function (d) { return d.user || null; });
            })
            .catch(function () { return null; });
    }

    /**
     * Normalize an error message from a JSON response body.
     * @param {object} body
     * @returns {string}
     */
    function extractErrorMessage(body) {
        if (!body) return 'Неизвестная ошибка';
        return body.message || body.error || JSON.stringify(body);
    }

    /**
     * Core fetch wrapper used by all admin pages.
     *
     * Behaviour:
     *  - always sends credentials: include
     *  - sets Content-Type: application/json for POST/PUT/PATCH/DELETE
     *  - on 401 → redirect to /login
     *  - on 403 → if CSRF-related, refresh token and retry ONCE; else throw
     *  - resolves with parsed JSON response body
     *
     * @param {string} url
     * @param {RequestInit & { body?: any }} options
     * @param {boolean} [_isRetry] — internal flag to prevent infinite loops
     * @returns {Promise<any>}
     */
    function adminFetch(url, options, _isRetry) {
        options = options || {};
        var method = (options.method || 'GET').toUpperCase();
        var needsJson = ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) !== -1;

        return getCsrfToken().then(function (token) {
            var headers = Object.assign({}, options.headers || {});
            if (needsJson) {
                headers['Content-Type'] = 'application/json';
                headers['x-csrf-token'] = token;
            }
            var body = options.body;
            if (needsJson && body && typeof body !== 'string') {
                body = JSON.stringify(body);
            }

            return fetch(url, Object.assign({}, options, {
                credentials: 'include',
                headers: headers,
                body: body,
            }));
        }).then(function (response) {
            if (response.status === 401) {
                window.location.href = '/login';
                return Promise.reject(new Error('Unauthorised — redirecting to login'));
            }

            return response.json().then(function (body) {
                if (response.status === 403) {
                    // Check if this is a CSRF failure and we haven't retried yet
                    var isCsrfError = body && (
                        String(body.error).toLowerCase().indexOf('csrf') !== -1 ||
                        String(body.message).toLowerCase().indexOf('csrf') !== -1
                    );
                    if (isCsrfError && !_isRetry) {
                        return refreshCsrfToken().then(function () {
                            return adminFetch(url, options, true);
                        });
                    }
                    var msg = extractErrorMessage(body);
                    return Promise.reject(new Error(msg));
                }

                if (!response.ok) {
                    var errMsg = extractErrorMessage(body);
                    return Promise.reject(new Error(errMsg));
                }

                return body;
            });
        });
    }

    /**
     * Guard function: call on every admin page load.
     * Fetches /api/auth/me; redirects if unauthenticated or insufficient role.
     * @returns {Promise<object>} resolves with the current user
     */
    function requireAdmin() {
        return getCurrentUser().then(function (user) {
            if (!user) {
                window.location.href = '/login';
                return Promise.reject(new Error('Not authenticated'));
            }
            if (user.role !== 'admin' && user.role !== 'moderator') {
                window.location.href = '/garage';
                return Promise.reject(new Error('Forbidden'));
            }
            return user;
        });
    }

    // Expose as a global so HTML pages can load it as a plain <script>
    global.AdminApi = {
        getCsrfToken: getCsrfToken,
        getCurrentUser: getCurrentUser,
        adminFetch: adminFetch,
        requireAdmin: requireAdmin,
    };
})(window);
