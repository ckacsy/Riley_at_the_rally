/**
 * SharedUtils — shared utility functions used across multiple frontend modules.
 *
 * Exposes:
 *   window.SharedUtils.escapeHtml(str)   — HTML entity encoding
 *   window.SharedUtils.formatLapTime(ms) — MM:SS.mmm format
 */
(function (window) {
    'use strict';

    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatLapTime(ms) {
        if (ms == null) return '—';
        var mins = String(Math.floor(ms / 60000)).padStart(2, '0');
        var secs = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        var millis = String(ms % 1000).padStart(3, '0');
        return mins + ':' + secs + '.' + millis;
    }

    window.SharedUtils = {
        escapeHtml: escapeHtml,
        formatLapTime: formatLapTime,
    };
}(window));
