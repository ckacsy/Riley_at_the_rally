/**
 * LeaderboardPage — leaderboard page module.
 *
 * Handles three sections:
 *   1. Track Records  — /api/leaderboard (lap times)
 *   2. Rank Ladder    — /api/rankings → data.ladder
 *   3. Hall of Legends — /api/rankings → data.legend
 *
 * Requires: SharedUtils, RankUI (optional but used for badges/stars)
 */
(function (window) {
    'use strict';

    var currentSection  = 'track';
    var currentLbRange  = 'all';
    var currentUsername = null;
    var rankingsData    = null;
    var trackLoaded     = false;
    var rankingsLoaded  = false;

    // --- Utility wrappers ---

    function esc(str) {
        return window.SharedUtils ? window.SharedUtils.escapeHtml(str) : String(str == null ? '' : str);
    }

    function fmtTime(ms) {
        return window.SharedUtils ? window.SharedUtils.formatLapTime(ms) : String(ms);
    }

    // --- Section tab switching ---

    function switchSection(section) {
        currentSection = section;

        document.querySelectorAll('.lb-section-tab').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-section') === section);
        });

        document.querySelectorAll('.lb-section').forEach(function (el) {
            var isActive = el.getAttribute('data-section') === section;
            el.classList.toggle('hidden', !isActive);
        });

        if (section === 'track' && !trackLoaded) {
            loadTrackRecords();
        } else if ((section === 'ladder' || section === 'legends') && !rankingsLoaded) {
            loadRankings();
        }
    }

    // --- Track Records ---

    function renderTrackRecords(entries) {
        var container = document.getElementById('lb-track-container');
        if (!container) return;

        if (!entries || entries.length === 0) {
            container.innerHTML = '<p class="lb-empty">Рекордов пока нет. Станьте первым!</p>';
            return;
        }

        var medals = ['medal-1', 'medal-2', 'medal-3'];
        var rows = entries.map(function (e, i) {
            var rankClass = medals[i] || '';
            var rankCell  = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
            return '<tr>' +
                '<td class="' + rankClass + '">' + rankCell + '</td>' +
                '<td>' + esc(e.carName) + '</td>' +
                '<td>' + esc(e.userId) + '</td>' +
                '<td><strong>' + fmtTime(e.lapTimeMs) + '</strong></td>' +
                '<td>' + new Date(e.date).toLocaleDateString('ru-RU') + '</td>' +
                '</tr>';
        }).join('');

        container.innerHTML =
            '<div class="lb-table-wrap">' +
            '<table class="leaderboard-table">' +
            '<thead><tr><th>#</th><th>Машина</th><th>Гонщик</th><th>Время круга</th><th>Дата</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
            '</table></div>';
    }

    function loadTrackRecords(range) {
        range = range || currentLbRange;
        var container = document.getElementById('lb-track-container');
        if (container) container.innerHTML = '<p class="lb-loading">Загрузка рекордов…</p>';

        fetch('/api/leaderboard?range=' + encodeURIComponent(range), { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                trackLoaded = true;
                renderTrackRecords(data.leaderboard);
            })
            .catch(function () {
                var el = document.getElementById('lb-track-container');
                if (el) el.innerHTML = '<p class="lb-empty">Не удалось загрузить рекорды.</p>';
            });
    }

    // --- Rank Ladder ---

    function renderLadder(data) {
        var container = document.getElementById('lb-ladder-container');
        if (!container) return;

        var entries = (data && data.ladder) || [];
        if (entries.length === 0) {
            container.innerHTML = '<p class="lb-empty">Ещё никто не участвовал в ранговых дуэлях</p>';
            return;
        }

        var html =
            '<div class="lb-table-wrap">' +
            '<table class="leaderboard-table lb-rank-table">' +
            '<thead><tr>' +
            '<th>#</th><th>Игрок</th><th>Ранг</th><th>Звёзды</th>' +
            '<th>Побед</th><th>Поражений</th><th>W/L</th>' +
            '</tr></thead><tbody>';

        entries.forEach(function (entry, idx) {
            var won  = entry.duelsWon  || 0;
            var lost = entry.duelsLost || 0;
            var wl   = lost > 0 ? (won / lost).toFixed(1) : (won > 0 ? '∞' : '—');

            var badgeHtml = window.RankUI
                ? window.RankUI.renderRankBadge(
                    { rank: entry.rank, stars: entry.stars, isLegend: false, display: entry.display },
                    { size: 'compact' }
                  )
                : esc('Ранг ' + (entry.rank || '—'));

            var starsHtml = window.RankUI ? window.RankUI.renderStars(entry.stars || 0) : '';
            var isCurrent = currentUsername && entry.username === currentUsername;
            var rowClass  = isCurrent ? ' class="lb-current-user"' : '';
            var youBadge  = isCurrent ? ' <span class="lb-you">(Вы)</span>' : '';

            html +=
                '<tr' + rowClass + '>' +
                '<td>' + (idx + 1) + '</td>' +
                '<td>' + esc(entry.username) + youBadge + '</td>' +
                '<td>' + badgeHtml + '</td>' +
                '<td>' + starsHtml + '</td>' +
                '<td>' + won + '</td>' +
                '<td>' + lost + '</td>' +
                '<td>' + wl + '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
    }

    // --- Hall of Legends ---

    function renderLegends(data) {
        var container = document.getElementById('lb-legends-container');
        if (!container) return;

        var entries = (data && data.legend) || [];
        if (entries.length === 0) {
            container.innerHTML = '<p class="lb-empty">Зал Легенд пока пуст</p>';
            return;
        }

        var html =
            '<div class="lb-table-wrap">' +
            '<table class="leaderboard-table lb-legends-table">' +
            '<thead><tr>' +
            '<th>#</th><th>Игрок</th><th>Позиция</th><th>Побед</th><th>Поражений</th>' +
            '</tr></thead><tbody>';

        entries.forEach(function (entry, idx) {
            var pos      = entry.legendPosition != null ? '🏅 #' + entry.legendPosition : '🏅';
            var won      = entry.duelsWon  || 0;
            var lost     = entry.duelsLost || 0;
            var isCurrent = currentUsername && entry.username === currentUsername;
            var rowClass  = 'lb-legend-row' + (isCurrent ? ' lb-current-user' : '');
            var youBadge  = isCurrent ? ' <span class="lb-you">(Вы)</span>' : '';

            html +=
                '<tr class="' + rowClass + '">' +
                '<td>' + (idx + 1) + '</td>' +
                '<td>' + esc(entry.username) + youBadge + '</td>' +
                '<td class="lb-legend-pos">' + pos + '</td>' +
                '<td>' + won + '</td>' +
                '<td>' + lost + '</td>' +
                '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
    }

    // --- Load /api/rankings ---

    function loadRankings() {
        var ladderEl  = document.getElementById('lb-ladder-container');
        var legendsEl = document.getElementById('lb-legends-container');
        if (ladderEl)  ladderEl.innerHTML  = '<p class="lb-loading">Загрузка…</p>';
        if (legendsEl) legendsEl.innerHTML = '<p class="lb-loading">Загрузка…</p>';

        fetch('/api/rankings', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                rankingsLoaded = true;
                if (!data) {
                    if (ladderEl)  ladderEl.innerHTML  = '<p class="lb-empty">Не удалось загрузить рейтинг</p>';
                    if (legendsEl) legendsEl.innerHTML = '<p class="lb-empty">Не удалось загрузить рейтинг</p>';
                    return;
                }
                rankingsData = data;
                renderLadder(data);
                renderLegends(data);
            })
            .catch(function () {
                rankingsLoaded = true;
                if (ladderEl)  ladderEl.innerHTML  = '<p class="lb-empty">Ошибка загрузки рейтинга</p>';
                if (legendsEl) legendsEl.innerHTML = '<p class="lb-empty">Ошибка загрузки рейтинга</p>';
            });
    }

    // --- Current user detection ---

    function detectCurrentUser() {
        fetch('/api/auth/me', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (data && data.user && data.user.username) {
                    currentUsername = data.user.username;
                    if (rankingsData) {
                        renderLadder(rankingsData);
                        renderLegends(rankingsData);
                    }
                }
            })
            .catch(function () {});
    }

    // --- Init ---

    function init() {
        // Section tab switching
        document.querySelectorAll('.lb-section-tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                switchSection(btn.getAttribute('data-section'));
            });
        });

        // Track records range subtabs (all / week / day)
        document.querySelectorAll('.lb-range-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                document.querySelectorAll('.lb-range-tab').forEach(function (t) { t.classList.remove('active'); });
                tab.classList.add('active');
                currentLbRange = tab.getAttribute('data-range');
                loadTrackRecords(currentLbRange);
            });
        });

        // Copy link button
        var copyBtn = document.getElementById('lb-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                var url = new URL(window.location.href);
                url.hash = 'top';
                var shareUrl = url.origin + url.pathname;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(shareUrl).then(function () {
                        var orig = copyBtn.textContent;
                        copyBtn.textContent = '✅ Скопировано!';
                        setTimeout(function () { copyBtn.textContent = orig; }, 2000);
                    }).catch(function () {
                        prompt('Скопируйте ссылку:', shareUrl);
                    });
                } else {
                    prompt('Скопируйте ссылку:', shareUrl);
                }
            });
        }

        // Initial loads
        detectCurrentUser();
        loadTrackRecords();
    }

    window.LeaderboardPage = { init: init };
    init();

}(window));
