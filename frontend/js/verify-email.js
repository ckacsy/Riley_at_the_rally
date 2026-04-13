var token = new URLSearchParams(window.location.search).get('token');

if (!token) {
    showResult(false, '❌', 'Недопустимая ссылка', 'Ссылка подтверждения отсутствует или некорректна.');
} else {
    fetch('/api/auth/verify-email?token=' + encodeURIComponent(token))
        .then(function(r){ return r.json(); })
        .then(function(data){
            if (data.success) {
                showResult(true, '✅', 'Email подтверждён!', data.message || 'Ваш аккаунт активирован. Теперь вы можете арендовать машины и участвовать в гонках!',
                    '<a href="/profile" class="btn">Перейти в профиль</a>');
            } else {
                showResult(false, '❌', 'Ошибка подтверждения', data.error || 'Ссылка недействительна или истекла.',
                    '<a href="/profile" class="btn btn-outline">В профиль</a>');
            }
        })
        .catch(function(){
            showResult(false, '❌', 'Ошибка', 'Не удалось подключиться к серверу. Попробуйте позже.');
        });
}

function showResult(ok, icon, title, msg, actionsHtml) {
    document.getElementById('status-icon').textContent = icon;
    document.getElementById('status-title').textContent = title;
    document.getElementById('status-msg').textContent = msg;
    if (actionsHtml) document.getElementById('actions').innerHTML = actionsHtml;
}
