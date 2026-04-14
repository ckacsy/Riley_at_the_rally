(function() {
    var forceFallback = new URLSearchParams(window.location.search).get('forceFallback') === '1';
    function hasWebGL() {
        try {
            var c = document.createElement('canvas');
            return !!(window.WebGLRenderingContext &&
                (c.getContext('webgl') || c.getContext('experimental-webgl')));
        } catch (e) { return false; }
    }

    var FALLBACK_MESSAGES = {
        webgl_unsupported: {
            title: '3D-гараж недоступен',
            body: 'Ваш браузер не поддерживает WebGL.<br>Обновите браузер для полного 3D-опыта.'
        },
        init_failed: {
            title: '3D-гараж временно недоступен',
            body: 'Не удалось загрузить 3D-сцену.<br>Попробуйте обновить страницу.'
        },
        load_timeout: {
            title: '3D-сцена загружается слишком долго',
            body: 'Загрузка заняла больше времени, чем ожидалось.<br>Попробуйте обновить страницу.'
        }
    };

    window.__showGarageFallback = function(reason) {
        reason = reason || 'init_failed';
        window.__garageFallbackReason = reason;
        var msgs = FALLBACK_MESSAGES[reason] || FALLBACK_MESSAGES['init_failed'];
        var fb = document.getElementById('webgl-fallback');
        var sl = document.getElementById('scene-loading');
        if (fb) {
            var h2 = fb.querySelector('h2');
            var p = fb.querySelector('p');
            if (h2) h2.textContent = msgs.title;
            if (p) p.innerHTML = msgs.body;
            fb.classList.add('active');
        }
        if (sl) sl.classList.add('hidden');
    };

    window.__garageNeedsWebGLFallback = !hasWebGL() || forceFallback;
    if (window.__garageNeedsWebGLFallback) {
        window.__showGarageFallback('webgl_unsupported');
    }
    // Safety net: if module script hasn't hidden the loader within 8s, show timeout fallback
    setTimeout(function() {
        var loader = document.getElementById('scene-loading');
        if (loader && !loader.classList.contains('hidden')) {
            window.__showGarageFallback('load_timeout');
        }
    }, 8000);
})();
