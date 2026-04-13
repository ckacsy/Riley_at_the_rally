(function() {
    var forceFallback = new URLSearchParams(window.location.search).get('forceFallback') === '1';
    function hasWebGL() {
        try {
            var c = document.createElement('canvas');
            return !!(window.WebGLRenderingContext &&
                (c.getContext('webgl') || c.getContext('experimental-webgl')));
        } catch (e) { return false; }
    }
    window.__garageNeedsWebGLFallback = !hasWebGL() || forceFallback;
    if (window.__garageNeedsWebGLFallback) {
        var fb = document.getElementById('webgl-fallback');
        var sl = document.getElementById('scene-loading');
        if (fb) fb.classList.add('active');
        if (sl) sl.classList.add('hidden');
    }
    // Safety net: if module script hasn't hidden the loader within 8s, force-hide it
    setTimeout(function() {
        var loader = document.getElementById('scene-loading');
        var fallback = document.getElementById('webgl-fallback');
        if (loader && !loader.classList.contains('hidden')) {
            loader.classList.add('hidden');
            if (fallback) fallback.classList.add('active');
        }
    }, 8000);
})();
