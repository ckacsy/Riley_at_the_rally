(function () {
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
        var mins = String(Math.floor(ms / 60000)).padStart(2, '0');
        var secs = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
        var millis = String(ms % 1000).padStart(3, '0');
        return mins + ':' + secs + '.' + millis;
    }

    function renderLeaderboard(entries, range) {
        var container = document.getElementById('leaderboard-container');
        if (!entries || entries.length === 0) {
            container.innerHTML = '<p class="no-data">Рекордов пока нет. Станьте первым!</p>';
            return;
        }
        var medals = ['medal-1', 'medal-2', 'medal-3'];
        var rows = entries.map(function (e, i) {
            var rankClass = medals[i] || '';
            var rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
            return '<tr>' +
                '<td class="' + rankClass + '">' + rank + '</td>' +
                '<td>' + escapeHtml(e.carName) + '</td>' +
                '<td>' + escapeHtml(e.userId) + '</td>' +
                '<td><strong>' + formatLapTime(e.lapTimeMs) + '</strong></td>' +
                '<td>' + new Date(e.date).toLocaleDateString('ru-RU') + '</td>' +
                '</tr>';
        }).join('');
        container.innerHTML =
            '<table class="leaderboard-table">' +
                '<thead><tr><th>#</th><th>Машина</th><th>Гонщик</th><th>Время круга</th><th>Дата</th></tr></thead>' +
                '<tbody>' + rows + '</tbody>' +
            '</table>';

        if (entries.length > 0) {
            var top = entries[0];
            var ogTitle = document.getElementById('og-title');
            var ogDesc = document.getElementById('og-description');
            var safeUserId = String(top.userId || '').replace(/[<>"&]/g, function (c) { return {'<':'&lt;','>':'&gt;','"':'&quot;','&':'&amp;'}[c]; });
            var safeCarName = String(top.carName || '').replace(/[<>"&]/g, function (c) { return {'<':'&lt;','>':'&gt;','"':'&quot;','&':'&amp;'}[c]; });
            if (ogTitle) ogTitle.content = 'Рекорд круга: ' + formatLapTime(top.lapTimeMs) + ' — ' + safeUserId + ' на ' + safeCarName;
            if (ogDesc) ogDesc.content = 'Лучший круг: ' + formatLapTime(top.lapTimeMs) + ' (' + safeUserId + ', ' + safeCarName + '). Присоединяйтесь и побейте!';
            var ogUrl = document.getElementById('og-url');
            if (ogUrl) ogUrl.content = window.location.origin + '/leaderboard?range=' + encodeURIComponent(range || 'all') + '#leaderboard-section';
        }
    }

    var currentLbRange = 'all';

    function loadLeaderboard(range) {
        range = range || currentLbRange;
        fetch('/api/leaderboard?range=' + encodeURIComponent(range), { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (data) { renderLeaderboard(data.leaderboard, data.range || range); })
            .catch(function () {
                document.getElementById('leaderboard-container').innerHTML =
                    '<p class="no-data">Не удалось загрузить рекорды.</p>';
            });
    }

    // Leaderboard tabs
    document.querySelectorAll('.leaderboard-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.leaderboard-tab').forEach(function (t) { t.classList.remove('active'); });
            tab.classList.add('active');
            currentLbRange = tab.getAttribute('data-range');
            loadLeaderboard(currentLbRange);
            var url = new URL(window.location.href);
            url.searchParams.set('leaderboard', currentLbRange);
            url.hash = 'leaderboard-section';
            window.history.replaceState(null, '', url.toString());
        });
    });

    // Copy link button
    document.getElementById('lb-copy-btn').addEventListener('click', function () {
        var url = new URL(window.location.href);
        url.searchParams.set('leaderboard', currentLbRange);
        url.hash = 'leaderboard-section';
        var shareUrl = url.toString();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareUrl).then(function () {
                var btn = document.getElementById('lb-copy-btn');
                var orig = btn.textContent;
                btn.textContent = '✅ Скопировано!';
                setTimeout(function () { btn.textContent = orig; }, 2000);
            }).catch(function () {
                prompt('Скопируйте ссылку:', shareUrl);
            });
        } else {
            prompt('Скопируйте ссылку:', shareUrl);
        }
    });

    // On load: check ?leaderboard= param and activate correct tab
    (function () {
        var params = new URLSearchParams(window.location.search);
        var rangeParam = params.get('leaderboard');
        var validRanges = ['all', 'week', 'day'];
        if (rangeParam && validRanges.indexOf(rangeParam) !== -1) {
            currentLbRange = rangeParam;
            document.querySelectorAll('.leaderboard-tab').forEach(function (t) { t.classList.remove('active'); });
            var targetTab = document.querySelector('.leaderboard-tab[data-range="' + rangeParam + '"]');
            if (targetTab) targetTab.classList.add('active');
            if (window.location.hash === '#leaderboard-section') {
                setTimeout(function () {
                    var el = document.getElementById('leaderboard-section');
                    if (el) el.scrollIntoView({ behavior: 'smooth' });
                }, 300);
            }
        }
    })();

    loadLeaderboard();
    setInterval(function () { loadLeaderboard(currentLbRange); }, 10000);
})();
