'use strict';

/**
 * AdminFilters — shared filter/query-state helper for admin pages.
 *
 * Usage:
 *   var filters = AdminFilters.create({
 *     car_id:    'f-car-id',    // element ID string
 *     user_id:   'f-user-id',
 *     date_from: 'f-date-from',
 *   });
 *
 *   var values     = filters.getFilters();
 *   var qs         = filters.buildQuery(values, page, limit);
 *   filters.syncUrlToState(values, page);
 *   var initPage   = filters.hydrateFormFromUrl();   // returns parsed page number
 *   filters.resetFilters();
 *
 * Designed to be loaded as a plain <script> before page-specific JS.
 */
(function (global) {

    /**
     * Create a reusable filter state helper for a given set of filter fields.
     *
     * @param {Object} fieldMap  Maps URL param key → element ID (string) or DOM element.
     *   Each element must expose a `.value` property (input, select, textarea).
     * @returns {{ getFilters, buildQuery, syncUrlToState, hydrateFormFromUrl, resetFilters }}
     */
    function create(fieldMap) {

        function resolveEl(elOrId) {
            if (typeof elOrId === 'string') return document.getElementById(elOrId);
            return elOrId;
        }

        /**
         * Read current filter values from all mapped form fields.
         * @returns {Object}  Key → trimmed string value.
         */
        function getFilters() {
            var result = {};
            Object.keys(fieldMap).forEach(function (key) {
                var el = resolveEl(fieldMap[key]);
                result[key] = el ? el.value.trim() : '';
            });
            return result;
        }

        /**
         * Build a query string including page/limit and all non-empty filter values.
         * @param {Object} filters  Output of getFilters().
         * @param {number} page
         * @param {number} limit
         * @returns {string}  Ready-to-use query string (no leading '?').
         */
        function buildQuery(filters, page, limit) {
            var params = new URLSearchParams();
            params.set('page', String(page));
            params.set('limit', String(limit));
            Object.keys(filters).forEach(function (key) {
                if (filters[key]) params.set(key, filters[key]);
            });
            return params.toString();
        }

        /**
         * Sync current filter state back to the browser URL without reloading.
         * Omits page=1 (implicit default) and any empty filter values.
         * @param {Object} filters  Output of getFilters().
         * @param {number} page
         */
        function syncUrlToState(filters, page) {
            var params = new URLSearchParams();
            if (page > 1) params.set('page', String(page));
            Object.keys(filters).forEach(function (key) {
                if (filters[key]) params.set(key, filters[key]);
            });
            var qs = params.toString();
            history.replaceState(null, '', qs ? '?' + qs : window.location.pathname);
        }

        /**
         * Populate all mapped form fields from the current URL search params.
         * @returns {number}  The parsed page number from the URL (defaults to 1).
         */
        function hydrateFormFromUrl() {
            var params = new URLSearchParams(window.location.search);
            Object.keys(fieldMap).forEach(function (key) {
                var el = resolveEl(fieldMap[key]);
                if (el) el.value = params.get(key) || '';
            });
            var p = parseInt(params.get('page') || '1', 10);
            return (p >= 1) ? p : 1;
        }

        /**
         * Reset all mapped form fields to empty string.
         */
        function resetFilters() {
            Object.keys(fieldMap).forEach(function (key) {
                var el = resolveEl(fieldMap[key]);
                if (el) el.value = '';
            });
        }

        return {
            getFilters: getFilters,
            buildQuery: buildQuery,
            syncUrlToState: syncUrlToState,
            hydrateFormFromUrl: hydrateFormFromUrl,
            resetFilters: resetFilters,
        };
    }

    global.AdminFilters = { create: create };
})(window);
