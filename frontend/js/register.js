var csrfToken = '';
fetch('/api/csrf-token').then(function(r){return r.json();}).then(function(d){csrfToken=d.csrfToken||'';});

document.querySelectorAll('.toggle-pw').forEach(function(btn){
    btn.addEventListener('click',function(){
        var inp=document.getElementById(this.dataset.target);
        inp.type=inp.type==='password'?'text':'password';
    });
});

var WEAK_PW=new Set(['password','password1','password123','passw0rd','12345678','123456789','1234567890','87654321','11111111','00000000','qwerty123','iloveyou','admin123','letmein1','welcome1']);
function pwStrength(pw){
    if(!pw)return 0;
    var s=0;
    if(pw.length>=8)s++;if(pw.length>=12)s++;
    if(/[A-Z]/.test(pw))s++;if(/[a-z]/.test(pw))s++;
    if(/[0-9]/.test(pw))s++;if(/[^A-Za-z0-9]/.test(pw))s++;
    if(WEAK_PW.has(pw.toLowerCase()))return 1;
    return s;
}
var pwInp=document.getElementById('password');
var pwBar=document.getElementById('pw-bar');
var pwLbl=document.getElementById('pw-label');
var dbTimer;
pwInp.addEventListener('input',function(){
    clearTimeout(dbTimer);
    dbTimer=setTimeout(function(){
        var s=pwStrength(pwInp.value);
        pwBar.style.width=Math.min(100,(s/6)*100)+'%';
        var c=['#dc3545','#dc3545','#ff7043','#ffc107','#66bb6a','#28a745','#0a7c3e'];
        var l=['','Очень слабый','Слабый','Средний','Хороший','Надёжный','Надёжный'];
        pwBar.style.backgroundColor=c[s]||'#dc3545';
        pwLbl.textContent=l[s]||'';
    },300);
});

function setErr(id,msg){
    var inp=document.getElementById(id);
    var err=document.getElementById(id+'-err');
    if(!err)return;
    if(msg){err.textContent=msg;err.classList.add('visible');if(inp)inp.setAttribute('aria-invalid','true');}
    else{err.textContent='';err.classList.remove('visible');if(inp)inp.setAttribute('aria-invalid','false');}
}

document.getElementById('username').focus();

document.getElementById('register-form').addEventListener('submit',function(e){
    e.preventDefault();
    var btn=document.getElementById('submit-btn');
    var btnText=document.getElementById('btn-text');
    var spinner=document.getElementById('btn-spinner');
    var successEl=document.getElementById('success-msg');
    successEl.style.display='none';
    ['username','email','password','confirm_password'].forEach(function(f){setErr(f,'');});

    btn.disabled=true;btnText.textContent='Регистрация…';spinner.style.display='inline-block';

    fetch('/api/auth/register',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-csrf-token':csrfToken},
        body:JSON.stringify({
            username:document.getElementById('username').value,
            email:document.getElementById('email').value,
            password:document.getElementById('password').value,
            confirm_password:document.getElementById('confirm_password').value
        })
    })
    .then(function(r){return r.json();})
    .then(function(data){
        spinner.style.display='none';
        if(data.success){
            if(data.csrfToken)csrfToken=data.csrfToken;
            successEl.textContent='✅ Аккаунт создан! Письмо с подтверждением email отправлено на указанный адрес. Перенаправление…';
            successEl.style.display='block';
            setTimeout(function(){window.location.href='/profile';},2500);
        }else{
            if(data.errors){
                Object.keys(data.errors).forEach(function(f){setErr(f,data.errors[f]);});
                var first=Object.keys(data.errors)[0];
                var fi=document.getElementById(first);if(fi)fi.focus();
            }else if(data.error){setErr('email',data.error);}
            btn.disabled=false;btnText.textContent='Зарегистрироваться';
        }
    })
    .catch(function(){
        spinner.style.display='none';
        setErr('email','Ошибка соединения с сервером.');
        btn.disabled=false;btnText.textContent='Зарегистрироваться';
    });
});
