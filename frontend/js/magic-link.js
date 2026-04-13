var csrfToken = '';
fetch('/api/csrf-token').then(function(r){return r.json();}).then(function(d){csrfToken=d.csrfToken||'';});

// Show error if redirected back with ?error=invalid
(function(){
    var params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'invalid') {
        var eb = document.getElementById('error-box');
        eb.textContent = 'Ссылка для входа недействительна или истекла. Запросите новую ссылку ниже.';
        eb.style.display = 'block';
    }
})();

function setErr(id, msg) {
    var inp = document.getElementById(id);
    var err = document.getElementById(id + '-err');
    if (!err) return;
    if (msg) {
        err.textContent = msg; err.classList.add('visible');
        if (inp) inp.setAttribute('aria-invalid', 'true');
    } else {
        err.textContent = ''; err.classList.remove('visible');
        if (inp) inp.removeAttribute('aria-invalid');
    }
}

document.getElementById('email').focus();

document.getElementById('magic-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var btn = document.getElementById('submit-btn');
    var btnText = document.getElementById('btn-text');
    var spinner = document.getElementById('btn-spinner');
    var successBox = document.getElementById('success-box');

    setErr('email', '');
    btn.disabled = true;
    btnText.textContent = 'Отправка…';
    spinner.style.display = 'inline-block';

    fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ email: document.getElementById('email').value })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
        spinner.style.display = 'none';
        if (data.success) {
            document.getElementById('magic-form').style.display = 'none';
            successBox.style.display = 'block';
        } else {
            setErr('email', data.error || 'Произошла ошибка. Попробуйте снова.');
            btn.disabled = false;
            btnText.textContent = 'Отправить ссылку';
        }
    })
    .catch(function() {
        spinner.style.display = 'none';
        setErr('email', 'Ошибка соединения с сервером.');
        btn.disabled = false;
        btnText.textContent = 'Отправить ссылку';
    });
});
