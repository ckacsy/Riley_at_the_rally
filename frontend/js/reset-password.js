var csrfToken = '';
var submitBtn = document.getElementById('submit-btn');
submitBtn.disabled = true;
fetch('/api/csrf-token').then(function(r){return r.json();}).then(function(d){csrfToken=d.csrfToken||''; submitBtn.disabled = false;});

var token = new URLSearchParams(window.location.search).get('token') || '';
if (!token) {
    document.getElementById('reset-form').style.display = 'none';
    var eb = document.getElementById('error-box');
    eb.innerHTML = 'Ссылка для сброса пароля недействительна или устарела. <a href="/forgot-password">Запросите новую</a>.';
    eb.style.display = 'block';
}

document.querySelectorAll('.toggle-pw').forEach(function(btn) {
    btn.addEventListener('click', function() {
        var inp = document.getElementById(this.dataset.target);
        inp.type = inp.type === 'password' ? 'text' : 'password';
    });
});

function setErr(id, msg) {
    var inp = document.getElementById(id);
    var err = document.getElementById(id + '-err');
    if (!err) return;
    if (msg) { err.textContent = msg; err.classList.add('visible'); if (inp) inp.setAttribute('aria-invalid', 'true'); }
    else { err.textContent = ''; err.classList.remove('visible'); if (inp) inp.removeAttribute('aria-invalid'); }
}

document.getElementById('reset-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var btn = document.getElementById('submit-btn');
    var btnText = document.getElementById('btn-text');
    var spinner = document.getElementById('btn-spinner');
    var errorBox = document.getElementById('error-box');
    var successBox = document.getElementById('success-box');

    setErr('password', ''); setErr('confirm-password', '');
    errorBox.style.display = 'none'; successBox.style.display = 'none';

    var password = document.getElementById('password').value;
    var confirmPassword = document.getElementById('confirm-password').value;

    if (!password) { setErr('password', 'Введите новый пароль'); return; }
    if (password !== confirmPassword) { setErr('confirm-password', 'Пароли не совпадают'); return; }

    btn.disabled = true; btnText.textContent = 'Сохранение…'; spinner.style.display = 'inline-block';

    fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ token: token, password: password, confirm_password: confirmPassword })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
        spinner.style.display = 'none';
        if (data.success) {
            document.getElementById('reset-form').style.display = 'none';
            successBox.innerHTML = (data.message || 'Пароль успешно изменён.') + ' Перенаправление на страницу входа…';
            successBox.style.display = 'block';
            setTimeout(function() { window.location.href = '/login'; }, 3000);
        } else {
            btn.disabled = false; btnText.textContent = 'Сохранить пароль';
            var errMsg = data.error || '';
            var isInvalidToken = errMsg && (
                errMsg.indexOf('недействи') !== -1 ||
                errMsg.indexOf('использован') !== -1 ||
                errMsg.indexOf('истекл') !== -1
            );
            if (isInvalidToken) {
                document.getElementById('reset-form').style.display = 'none';
                errorBox.innerHTML = 'Ссылка недействительна или устарела. <a href="/forgot-password">Запросите новую</a>.';
            } else {
                errorBox.textContent = errMsg || 'Произошла ошибка. Попробуйте ещё раз.';
            }
            errorBox.style.display = 'block';
        }
    })
    .catch(function() {
        spinner.style.display = 'none';
        btn.disabled = false; btnText.textContent = 'Сохранить пароль';
        errorBox.textContent = 'Ошибка соединения с сервером.';
        errorBox.style.display = 'block';
    });
});
