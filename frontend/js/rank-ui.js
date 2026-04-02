/**
 * RankUI — reusable rank rendering helpers for the frontend.
 *
 * Works with the API response shape from /api/profile/rank and /api/rankings.
 * Does NOT calculate rank progression — only renders data from the API.
 *
 * Usage:
 *   var html = RankUI.renderRankBadge(rankData);
 *   var cls  = RankUI.getRankZoneClass(rank, isLegend);
 */
(function (global) {
    'use strict';

    var MAX_STARS = 3;

    /**
     * Return a CSS zone class based on rank number and legend status.
     * - Legend:    rank-zone-legend
     * - Ranks 1–5:  rank-zone-hard
     * - Ranks 6–9:  rank-zone-mid
     * - Ranks 10–15: rank-zone-safe
     * @param {number} rank
     * @param {boolean} isLegend
     * @returns {string}
     */
    function getRankZoneClass(rank, isLegend) {
        if (isLegend) return 'rank-zone-legend';
        if (rank >= 10) return 'rank-zone-safe';
        if (rank >= 6)  return 'rank-zone-mid';
        return 'rank-zone-hard';
    }

    /**
     * Render filled/empty star string as HTML.
     * @param {number} stars  Filled stars (0–3)
     * @returns {string} HTML
     */
    function renderStars(stars) {
        var filled = Math.max(0, Math.min(stars, MAX_STARS));
        var empty  = MAX_STARS - filled;
        var html   = '';
        for (var i = 0; i < filled; i++) {
            html += '<span class="rank-star rank-star-filled" aria-hidden="true">★</span>';
        }
        for (var j = 0; j < empty; j++) {
            html += '<span class="rank-star rank-star-empty" aria-hidden="true">☆</span>';
        }
        return html;
    }

    /**
     * Render a Legend badge.
     * @param {number|null} position Legend position number (1-based) or null
     * @returns {string} HTML
     */
    function renderLegendBadge(position) {
        var pos = position != null ? ' #' + position : '';
        return '<span class="rank-badge rank-zone-legend" aria-label="Legend' + pos + '">' +
               '<span class="rank-badge-emoji">🏆</span>' +
               '<span class="rank-badge-label">Legend' + pos + '</span>' +
               '</span>';
    }

    /**
     * Render a rank badge from an /api/profile/rank response object.
     *
     * @param {object} data   API response — { rank, stars, isLegend, legendPosition, display }
     * @param {object} [opts]
     * @param {string} [opts.size]     'compact' | 'normal' (default 'normal')
     * @param {boolean} [opts.loading] Show loading placeholder
     * @returns {string} HTML
     */
    function renderRankBadge(data, opts) {
        var options = opts || {};
        var size = options.size || 'normal';

        if (options.loading) {
            return '<span class="rank-badge rank-badge-loading">Загрузка…</span>';
        }

        if (!data) {
            return '<span class="rank-badge rank-badge-guest">—</span>';
        }

        if (data.isLegend) {
            var legPos = data.legendPosition != null ? ' #' + data.legendPosition : '';
            return '<span class="rank-badge rank-zone-legend rank-badge-' + size + '">' +
                   '<span class="rank-badge-emoji">🏆</span>' +
                   '<span class="rank-badge-label">Legend' + legPos + '</span>' +
                   '</span>';
        }

        var zoneClass = getRankZoneClass(data.rank, false);
        var display   = data.display || {};
        var emoji     = display.emoji || '';
        var label     = display.label || String(data.rank);

        if (size === 'compact') {
            return '<span class="rank-badge ' + zoneClass + ' rank-badge-compact" title="Ранг ' + label + '">' +
                   '<span class="rank-badge-emoji">' + emoji + '</span>' +
                   '<span class="rank-badge-label">' + label + '</span>' +
                   '<span class="rank-badge-stars" aria-label="' + (data.stars || 0) + ' звезды из 3">' +
                   renderStars(data.stars || 0) + '</span>' +
                   '</span>';
        }

        return '<span class="rank-badge ' + zoneClass + ' rank-badge-normal">' +
               '<span class="rank-badge-emoji">' + emoji + '</span>' +
               '<span class="rank-badge-label">Ранг ' + label + '</span>' +
               '<span class="rank-badge-stars" aria-label="' + (data.stars || 0) + ' звезды из 3">' +
               renderStars(data.stars || 0) + '</span>' +
               '</span>';
    }

    /**
     * Render a single ladder row for the rankings tab.
     * @param {object} entry   Ladder entry from /api/rankings response
     * @param {number} place   1-based placement index in the sorted list
     * @returns {string} HTML
     */
    function renderLadderRow(entry, place) {
        var zoneClass = getRankZoneClass(entry.rank, false);
        var display   = entry.display || {};
        var emoji     = display.emoji || '';
        var label     = display.label || String(entry.rank);
        var name      = esc(entry.username || '—');
        var stars     = renderStars(entry.stars || 0);
        var wl        = (entry.duelsWon || 0) + '/' + (entry.duelsLost || 0);

        return '<div class="rankings-row ' + zoneClass + '">' +
               '<span class="rankings-place">' + place + '</span>' +
               '<span class="rankings-name" title="' + name + '">' + name + '</span>' +
               '<span class="rankings-rank">' + emoji + ' ' + label + '</span>' +
               '<span class="rankings-stars">' + stars + '</span>' +
               '<span class="rankings-wl">' + wl + '</span>' +
               '</div>';
    }

    /**
     * Render a single legend row.
     * @param {object} entry   Legend entry from /api/rankings response
     * @returns {string} HTML
     */
    function renderLegendRow(entry) {
        var pos  = entry.legendPosition != null ? '#' + entry.legendPosition : '—';
        var name = esc(entry.username || '—');
        var wl   = (entry.duelsWon || 0) + '/' + (entry.duelsLost || 0);

        return '<div class="rankings-row rank-zone-legend">' +
               '<span class="rankings-place rank-zone-legend">' + pos + '</span>' +
               '<span class="rankings-name" title="' + name + '">' + name + '</span>' +
               '<span class="rankings-rank">🏆 Legend</span>' +
               '<span class="rankings-stars"></span>' +
               '<span class="rankings-wl">' + wl + '</span>' +
               '</div>';
    }

    /**
     * Render a full rankings block (legend + ladder) into a container element.
     * @param {HTMLElement} container
     * @param {object} data   Response from /api/rankings — { ladder, legend }
     */
    function renderRankings(container, data) {
        if (!container) return;
        var html = '';

        // Legend section
        html += '<div class="rankings-section">' +
                '<div class="rankings-section-title rank-zone-legend">🏆 Легенды</div>';
        if (!data.legend || data.legend.length === 0) {
            html += '<div class="rankings-empty">Пока нет легенд</div>';
        } else {
            html += '<div class="rankings-header">' +
                    '<span class="rankings-place">#</span>' +
                    '<span class="rankings-name">Игрок</span>' +
                    '<span class="rankings-rank">Ранг</span>' +
                    '<span class="rankings-stars">Звёзды</span>' +
                    '<span class="rankings-wl">П/П</span>' +
                    '</div>';
            data.legend.forEach(function (entry) {
                html += renderLegendRow(entry);
            });
        }
        html += '</div>';

        // Ladder section
        html += '<div class="rankings-section">' +
                '<div class="rankings-section-title">🎖 Лесенка</div>';
        if (!data.ladder || data.ladder.length === 0) {
            html += '<div class="rankings-empty">Нет игроков в рейтинге</div>';
        } else {
            html += '<div class="rankings-header">' +
                    '<span class="rankings-place">#</span>' +
                    '<span class="rankings-name">Игрок</span>' +
                    '<span class="rankings-rank">Ранг</span>' +
                    '<span class="rankings-stars">Звёзды</span>' +
                    '<span class="rankings-wl">П/П</span>' +
                    '</div>';
            data.ladder.forEach(function (entry, idx) {
                html += renderLadderRow(entry, idx + 1);
            });
        }
        html += '</div>';

        container.innerHTML = html;
    }

    // Internal HTML escape helper
    function esc(str) {
        if (str == null) return '—';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    global.RankUI = {
        getRankZoneClass:  getRankZoneClass,
        renderStars:       renderStars,
        renderLegendBadge: renderLegendBadge,
        renderRankBadge:   renderRankBadge,
        renderLadderRow:   renderLadderRow,
        renderLegendRow:   renderLegendRow,
        renderRankings:    renderRankings,
    };

}(window));
