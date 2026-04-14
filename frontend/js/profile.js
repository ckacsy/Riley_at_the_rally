var csrfToken = '';
var currentUsername = '';
fetch('/api/csrf-token', { credentials: 'same-origin' }).then(function(r){return r.json();}).then(function(d){csrfToken=d.csrfToken||'';});

function formatLapTime(ms) {
    const mins = String(Math.floor(ms / 60000)).padStart(2, '0');
    const secs = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const millis = String(ms % 1000).padStart(3, '0');
    return mins + ':' + secs + '.' + millis;
}

function formatDuration(totalSec) {
    const h = (totalSec / 3600).toFixed(1);
    return h;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('ru-RU', {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}

function esc(str) {
    if (str == null) return '—';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function loadProfile() {
    fetch('/api/profile', { credentials: 'same-origin' })
        .then(function (res) {
            if (res.status === 401) {
                window.location.href = '/login?redirect=/profile';
                return null;
            }
            return res.json();
        })
        .then(function (data) {
            if (!data) return;
            if (data.error) {
                document.getElementById('loading').style.display = 'none';
                const errEl = document.getElementById('error');
                errEl.textContent = data.error;
                errEl.style.display = 'block';
                return;
            }
            renderProfile(data);
        })
        .catch(function () {
            document.getElementById('loading').style.display = 'none';
            const errEl = document.getElementById('error');
            errEl.textContent = 'Не удалось загрузить профиль.';
            errEl.style.display = 'block';
        });
}

function renderProfile(data) {
    const { user, stats } = data;

    // Show pending banner if account not active
    if (user.status === 'pending') {
        document.getElementById('pending-banner').style.display = 'flex';
    }

    // Avatar
    if (user.avatar_path) {
        const img = document.createElement('img');
        img.className = 'avatar-img';
        img.src = user.avatar_path;
        img.alt = 'Аватар';
        const container = document.getElementById('avatar-container');
        const placeholder = document.getElementById('avatar-placeholder');
        if (placeholder) {
            container.replaceChild(img, placeholder);
        } else {
            container.innerHTML = '';
            container.appendChild(img);
        }
    }

    // Profile info
    currentUsername = user.username;
    document.getElementById('profile-username').textContent = user.username;
    document.getElementById('profile-email').textContent = user.email;
    document.getElementById('profile-joined').textContent = 'Участник с ' + formatDate(user.created_at);

    // Stats
    document.getElementById('stat-sessions').textContent = stats.totalSessions;
    document.getElementById('stat-races').textContent = stats.totalRaces;
    document.getElementById('stat-laps').textContent = stats.totalLaps;
    document.getElementById('stat-time').textContent = formatDuration(stats.totalTimeSec);

    // Best lap
    const bestSection = document.getElementById('best-lap-section');
    if (stats.bestLap) {
        bestSection.innerHTML = '<div class="best-lap-card">' +
            '<div class="best-lap-icon">🏆</div>' +
            '<div class="best-lap-info">' +
            '<div class="best-lap-title">Лучший круг</div>' +
            '<div class="best-lap-time">' + formatLapTime(stats.bestLap.lap_time_ms) + '</div>' +
            '<div class="best-lap-car">🚗 ' + esc(stats.bestLap.car_name || '—') + '</div>' +
            '<div class="best-lap-date">' + formatDate(stats.bestLap.created_at) + '</div>' +
            '</div></div>';
    } else {
        bestSection.innerHTML = '<div class="no-data-card">🏁 Нет записанных кругов. Участвуйте в гонках, чтобы установить рекорд!</div>';
    }

    // Recent laps
    const recentContainer = document.getElementById('recent-laps-container');
    if (!stats.recentLaps || stats.recentLaps.length === 0) {
        recentContainer.innerHTML = '<div class="no-data-card">Нет записанных кругов</div>';
    } else {
        const bestTime = stats.bestLap ? stats.bestLap.lap_time_ms : null;
        const rows = stats.recentLaps.map(function (lap) {
            const isBest = bestTime && lap.lap_time_ms === bestTime;
            return '<tr>' +
                '<td>' + formatLapTime(lap.lap_time_ms) + (isBest ? '<span class="best-badge">Рекорд</span>' : '') + '</td>' +
                '<td>' + esc(lap.car_name || '—') + '</td>' +
                '<td>' + formatDate(lap.created_at) + '</td>' +
                '</tr>';
        }).join('');
        recentContainer.innerHTML = '<table class="laps-table">' +
            '<thead><tr><th>Время круга</th><th>Машина</th><th>Дата</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>';
    }

    document.getElementById('loading').style.display = 'none';
    document.getElementById('profile-content').style.display = 'block';
}

// Avatar upload
document.getElementById('avatar-input').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const statusEl = document.getElementById('upload-status');
    statusEl.textContent = 'Загрузка…';
    statusEl.style.color = 'rgba(255,255,255,0.5)';
    const formData = new FormData();
    formData.append('avatar', file);
    fetch('/api/profile/avatar', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrfToken },
        body: formData
    })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data.success) {
                const container = document.getElementById('avatar-container');
                const newImg = document.createElement('img');
                newImg.className = 'avatar-img';
                newImg.src = data.avatarPath + '?t=' + Date.now();
                newImg.alt = 'Аватар';
                container.innerHTML = '';
                container.appendChild(newImg);
                statusEl.textContent = 'Фото обновлено!';
                statusEl.style.color = '#4caf50';
                setTimeout(function () { statusEl.textContent = ''; }, 3000);
            } else {
                statusEl.textContent = data.error || 'Ошибка загрузки';
                statusEl.style.color = '#f44336';
            }
        })
        .catch(function () {
            statusEl.textContent = 'Ошибка загрузки';
            statusEl.style.color = '#f44336';
        });
});

// Logout
document.getElementById('logout-btn').addEventListener('click', function () {
    fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrfToken }
    })
        .then(function () { window.location.href = '/'; });
});

// Resend verification email
var resendBtn = document.getElementById('resend-btn');
if (resendBtn) {
    resendBtn.addEventListener('click', function () {
        resendBtn.disabled = true;
        resendBtn.textContent = 'Отправка…';
        fetch('/api/auth/resend-verification', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'x-csrf-token': csrfToken }
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                resendBtn.textContent = data.success ? '✅ Отправлено' : '❌ Ошибка';
                setTimeout(function () {
                    resendBtn.disabled = false;
                    resendBtn.textContent = 'Отправить повторно';
                }, 5000);
            })
            .catch(function () {
                resendBtn.textContent = '❌ Ошибка';
                setTimeout(function () {
                    resendBtn.disabled = false;
                    resendBtn.textContent = 'Отправить повторно';
                }, 3000);
            });
    });
}

// Username change
document.getElementById('username-edit-btn').addEventListener('click', function () {
    var input = document.getElementById('username-edit-input');
    input.value = currentUsername;
    document.getElementById('username-edit-form').classList.add('visible');
    document.getElementById('username-msg').style.display = 'none';
    input.focus();
});
document.getElementById('username-cancel-btn').addEventListener('click', function () {
    document.getElementById('username-edit-form').classList.remove('visible');
    document.getElementById('username-msg').style.display = 'none';
});
document.getElementById('username-save-btn').addEventListener('click', function () {
    var newName = document.getElementById('username-edit-input').value.trim();
    var saveBtn = document.getElementById('username-save-btn');
    var msgEl = document.getElementById('username-msg');
    if (!newName) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохранение…';
    fetch('/api/profile/username', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ username: newName })
    })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (data.success) {
                currentUsername = data.username;
                document.getElementById('profile-username').textContent = data.username;
                document.getElementById('username-edit-form').classList.remove('visible');
                msgEl.textContent = '✅ Имя изменено';
                msgEl.className = 'username-msg success';
                msgEl.style.display = 'block';
                setTimeout(function () { msgEl.style.display = 'none'; }, 4000);
            } else {
                msgEl.textContent = data.error || 'Ошибка';
                msgEl.className = 'username-msg error';
                msgEl.style.display = 'block';
            }
        })
        .catch(function () {
            msgEl.textContent = 'Ошибка сети';
            msgEl.className = 'username-msg error';
            msgEl.style.display = 'block';
        })
        .finally(function () {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Сохранить';
        });
});

loadProfile();

// Load rank block
function loadRankBlock() {
    var section = document.getElementById('rank-section');
    var content = document.getElementById('rank-block-content');
    if (!section || !content || typeof window.RankUI === 'undefined') return;
    fetch('/api/profile/rank', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
            if (!data) return;
            var RankUI = window.RankUI;
            var html = '';

            if (data.isLegend) {
                html += '<div class="rank-main-badge">' +
                        '<div class="rank-main-emoji">🏆</div>' +
                        '<div class="rank-main-info">' +
                        '<div class="rank-main-label rank-zone-legend">' +
                        'Legend' + (data.legendPosition != null ? ' #' + data.legendPosition : '') +
                        '</div>' +
                        '</div>' +
                        '</div>';
            } else {
                var display  = data.display || {};
                var emoji    = display.emoji || '';
                var label    = display.label || String(data.rank);
                var zoneClass = RankUI.getRankZoneClass(data.rank, false);

                html += '<div class="rank-main-badge">' +
                        '<div class="rank-main-emoji">' + emoji + '</div>' +
                        '<div class="rank-main-info ' + zoneClass + '">' +
                        '<div class="rank-main-label">Ранг ' + label + '</div>' +
                        '<div class="rank-main-stars">' + RankUI.renderStars(data.stars || 0) + '</div>';

                if (data.stars === 3 && !data.isLegend) {
                    html += '<div class="rank-promo-hint">Ещё 1 победа до повышения</div>';
                }

                html += '</div>' +
                        '</div>';
            }

            // Duel stats
            var hasDuels = (data.duelsWon || 0) > 0 || (data.duelsLost || 0) > 0;
            html += '<div class="rank-duel-stats">' +
                    '<div class="rank-duel-stat">' +
                    '<div class="rank-duel-stat-value">' + (data.duelsWon || 0) + '</div>' +
                    '<div class="rank-duel-stat-label">Дуэлей выиграно</div>' +
                    '</div>' +
                    '<div class="rank-duel-stat">' +
                    '<div class="rank-duel-stat-value">' + (data.duelsLost || 0) + '</div>' +
                    '<div class="rank-duel-stat-label">Дуэлей проиграно</div>' +
                    '</div>' +
                    '</div>';

            if (!hasDuels) {
                html += '<div class="rank-no-duels">Вы ещё не участвовали в дуэлях</div>';
            }

            content.innerHTML = html;
            section.style.display = 'block';
        })
        .catch(function () {
            // Silently fail — rank block just stays hidden
        });
}
loadRankBlock();

// Load balance display
fetch('/api/balance', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
        if (!d) return;
        var el = document.getElementById('profile-balance');
        if (el) el.textContent = 'Баланс: ' + (d.balance || 0).toFixed(2) + ' RC';
    })
    .catch(function () {});

// Transaction history toggle
var txLoaded = false;
document.getElementById('transactions-toggle').addEventListener('click', function () {
    var content = document.getElementById('transactions-content');
    var isVisible = window.getComputedStyle(content).display !== 'none';
    content.style.display = isVisible ? 'none' : 'block';
    this.textContent = (isVisible ? '💳 Информация о транзакциях ▶' : '💳 Информация о транзакциях ▼');
    if (!isVisible && !txLoaded) {
        txLoaded = true;
        loadTransactions();
    }
});

function loadTransactions() {
    var container = document.getElementById('transactions-container');
    container.innerHTML = '<p class="tx-loading-msg">Загрузка...</p>';
    fetch('/api/transactions', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
            if (!data || !data.transactions) {
                container.innerHTML = '<p class="tx-loading-msg">Нет данных</p>';
                return;
            }
            var txs = data.transactions;
            // Hide internal hold/release — user only sees net deductions
            txs = txs.filter(function (tx) {
                return tx.type !== 'hold' && tx.type !== 'release';
            });
            if (!txs.length) {
                container.innerHTML = '<p class="tx-loading-msg">Транзакций пока нет</p>';
                return;
            }
            var typeLabels = {
                topup: 'Пополнение', hold: 'Блокировка',
                deduct: 'Списание', release: 'Возврат', bonus: 'Бонус',
                daily_bonus: 'Ежедневный бонус'
            };
            var typeClasses = {
                topup: 'tx-type-topup', hold: 'tx-type-hold',
                deduct: 'tx-type-deduct', release: 'tx-type-release', bonus: 'tx-type-bonus',
                daily_bonus: 'tx-type-bonus'
            };
            var rows = txs.map(function (tx) {
                var amtCls = tx.amount >= 0 ? 'tx-amount-pos' : 'tx-amount-neg';
                var amtStr = (tx.amount >= 0 ? '+' : '') + tx.amount.toFixed(2) + ' RC';
                var typeLabel = typeLabels[tx.type] || tx.type;
                var typeCls = typeClasses[tx.type] || '';
                var dateStr = tx.created_at ? tx.created_at.replace('T', ' ').slice(0, 16) : '—';
                return '<tr>' +
                    '<td>' + esc(dateStr) + '</td>' +
                    '<td class="' + typeCls + '">' + esc(typeLabel) + '</td>' +
                    '<td class="' + amtCls + '">' + esc(amtStr) + '</td>' +
                    '<td>' + (tx.balance_after != null ? tx.balance_after.toFixed(2) + ' RC' : '—') + '</td>' +
                    '<td>' + esc(tx.description) + '</td>' +
                    '</tr>';
            }).join('');
            container.innerHTML =
                '<table class="tx-table">' +
                '<thead><tr><th>Дата</th><th>Тип</th><th>Сумма</th><th>Баланс после</th><th>Описание</th></tr></thead>' +
                '<tbody>' + rows + '</tbody></table>';
        })
        .catch(function () {
            container.innerHTML = '<p class="tx-error-msg">Ошибка загрузки транзакций</p>';
        });
}
