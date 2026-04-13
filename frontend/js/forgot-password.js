var csrfToken = '';
fetch('/api/csrf-token').then(function(r){return r.json();}).then(function(d){csrfToken=d.csrfToken||'';});

document.getElementById('email').focus();

function setErr(id, msg) {
    var inp = document.getElementById(id);
    var err = document.getElementById(id + '-err');
    if (!err) return;
    if (msg) { err.textContent = msg; err.classList.add('visible'); if (inp) inp.setAttribute('aria-invalid', 'true'); }
    else { err.textContent = ''; err.classList.remove('visible'); if (inp) inp.removeAttribute('aria-invalid'); }
}

document.getElementById('forgot-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var btn = document.getElementById('submit-btn');
    var btnText = document.getElementById('btn-text');
    var spinner = document.getElementById('btn-spinner');
    var successBox = document.getElementById('success-box');

    setErr('email', '');
    successBox.style.display = 'none';

    var email = document.getElementById('email').value.trim();
    if (!email) { setErr('email', 'Введите email'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr('email', 'Введите корректный email'); return; }

    btn.disabled = true; btnText.textContent = 'Отправка…'; spinner.style.display = 'inline-block';

    var genericMsg = 'Если этот email зарегистрирован, вы получите письмо со ссылкой для сброса пароля. Проверьте папку «Спам», если письмо не пришло.';

    fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ email: email })
    })
    .then(function(r) { return r.json(); })
    .then(function() {
        spinner.style.display = 'none';
        document.getElementById('forgot-form').style.display = 'none';
        successBox.textContent = genericMsg;
        successBox.style.display = 'block';
    })
    .catch(function() {
        spinner.style.display = 'none';
        document.getElementById('forgot-form').style.display = 'none';
        successBox.textContent = genericMsg;
        successBox.style.display = 'block';
    });
});
