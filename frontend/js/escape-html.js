/**
 * escape-html.js — global HTML escaping utility.
 *
 * Exposes:
 *   window.escapeHtml(str) — escape &, <, >, ", and ' for safe insertion into HTML.
 *
 * Load this script before any page script that builds HTML strings with
 * user-controlled data and assigns them via innerHTML.
 */
(function (window) {
    'use strict';

    /**
     * Escape HTML special characters in a string so it is safe to inject
     * into HTML markup via innerHTML or string concatenation.
     *
     * @param {*} str  Value to escape (null/undefined → empty string).
     * @returns {string}
     */
    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    window.escapeHtml = escapeHtml;
}(window));
