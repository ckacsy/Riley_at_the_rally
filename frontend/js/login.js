var csrfToken = '';
fetch('/api/csrf-token').then(function(r){return r.json();}).then(function(d){csrfToken=d.csrfToken||'';});

// Show error if redirected back with invalid magic link
(function(){
    var params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'invalid_magic_link') {
        var eb = document.getElementById('error-banner');
        eb.textContent = 'Ссылка для входа недействительна или истекла.';
        eb.style.display = 'block';
    }
})();

document.querySelectorAll('.toggle-pw').forEach(function(btn){
    btn.addEventListener('click',function(){
        var inp=document.getElementById(this.dataset.target);
        inp.type=inp.type==='password'?'text':'password';
    });
});

function setErr(id,msg){
    var inp=document.getElementById(id);
    var err=document.getElementById(id+'-err');
    if(!err)return;
    if(msg){err.textContent=msg;err.classList.add('visible');if(inp)inp.setAttribute('aria-invalid','true');}
    else{err.textContent='';err.classList.remove('visible');if(inp)inp.removeAttribute('aria-invalid');}
}

document.getElementById('identifier').focus();

document.getElementById('login-form').addEventListener('submit', function(e){
    e.preventDefault();
    var btn=document.getElementById('submit-btn');
    var btnText=document.getElementById('btn-text');
    var spinner=document.getElementById('btn-spinner');
    var successEl=document.getElementById('success-msg');
    var lockoutEl=document.getElementById('lockout-msg');

    successEl.style.display='none';
    lockoutEl.style.display='none';
    setErr('identifier','');setErr('password','');

    btn.disabled=true;btnText.textContent='Вход…';spinner.style.display='inline-block';

    fetch('/api/auth/login',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-csrf-token':csrfToken},
        body:JSON.stringify({
            identifier:document.getElementById('identifier').value,
            password:document.getElementById('password').value
        })
    })
    .then(function(r){return r.json();})
    .then(function(data){
        spinner.style.display='none';
        if(data.success){
            if(data.csrfToken)csrfToken=data.csrfToken;
            successEl.textContent='Вход выполнен! Перенаправление…';
            successEl.style.display='block';
            var redirect=new URLSearchParams(window.location.search).get('redirect')||'/';
            setTimeout(function(){window.location.href=redirect;},800);
        }else{
            if(data.error && (data.error.indexOf('попытк')!==-1 || data.error.indexOf('заблокир')!==-1)){
                lockoutEl.textContent='⚠️ '+data.error;
                lockoutEl.style.display='block';
            }else{
                setErr('password',data.error||'Неверный логин или пароль');
                document.getElementById('password').focus();
            }
            btn.disabled=false;btnText.textContent='Войти';
        }
    })
    .catch(function(){
        spinner.style.display='none';
        setErr('identifier','Ошибка соединения с сервером.');
        btn.disabled=false;btnText.textContent='Войти';
    });
});
