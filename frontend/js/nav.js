/**
 * RC Garage — Unified Navigation Module
 * Инжектит навбар на все страницы проекта.
 * Использует CSS-переменные из common.css и стили из nav.css.
 */
(function () {
    'use strict';

    var NAV_LINKS = [
        { href: '/garage',    label: '🏠 Гараж' },
        { href: '/broadcast', label: '📡 Трансляция' },
        { href: '/profile',   label: '👤 Профиль' }
    ];

    function getActivePath() {
        var pathname = window.location.pathname;
        // Remove trailing slash so '/garage/' and '/garage' both match '/garage'
        return pathname.replace(/\/$/, '') || '/';
    }

    function isLinkActive(href) {
        var current = getActivePath();
        if (href === '/') {
            return current === '' || current === '/';
        }
        return current === href || current === href + '.html';
    }

    function buildNav() {
        var nav = document.createElement('nav');
        nav.className = 'main-nav';
        nav.setAttribute('role', 'navigation');
        nav.setAttribute('aria-label', 'Основная навигация');

        // Logo
        var logo = document.createElement('a');
        logo.className = 'nav-logo';
        logo.href = '/garage';
        logo.textContent = '🚗 RC Garage';
        nav.appendChild(logo);

        // Burger button
        var burger = document.createElement('button');
        burger.className = 'nav-burger';
        burger.id = 'nav-burger';
        burger.setAttribute('aria-label', 'Открыть меню');
        burger.setAttribute('aria-expanded', 'false');
        burger.setAttribute('aria-controls', 'nav-menu');
        burger.innerHTML = '&#9776;';
        nav.appendChild(burger);

        // Menu list
        var menu = document.createElement('ul');
        menu.className = 'nav-menu';
        menu.id = 'nav-menu';

        NAV_LINKS.forEach(function (link) {
            var li = document.createElement('li');
            var a = document.createElement('a');
            a.href = link.href;
            a.textContent = link.label;
            if (isLinkActive(link.href)) {
                a.className = 'nav-active';
                a.setAttribute('aria-current', 'page');
            }
            li.appendChild(a);
            menu.appendChild(li);
        });

        nav.appendChild(menu);

        // Auth section (right side)
        var authEl = document.createElement('div');
        authEl.className = 'nav-auth';
        authEl.id = 'nav-auth';
        nav.appendChild(authEl);

        // Burger toggle handler
        burger.addEventListener('click', function () {
            var isOpen = menu.classList.toggle('open');
            burger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            burger.innerHTML = isOpen ? '&#10005;' : '&#9776;';
        });

        // Close menu on link click (mobile)
        var links = menu.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
            links[i].addEventListener('click', function () {
                menu.classList.remove('open');
                burger.setAttribute('aria-expanded', 'false');
                burger.innerHTML = '&#9776;';
            });
        }

        return nav;
    }

    function updateAuthSection(user) {
        var authEl = document.getElementById('nav-auth');
        if (!authEl) return;
        authEl.innerHTML = '';
        if (user) {
            var span = document.createElement('span');
            span.className = 'nav-auth-user';
            span.textContent = user.username || user.email || 'Профиль';
            var btn = document.createElement('button');
            btn.className = 'nav-auth-logout';
            btn.textContent = 'Выйти';
            btn.addEventListener('click', function () {
                fetch('/api/csrf-token', { credentials: 'same-origin' })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        return fetch('/api/auth/logout', {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: { 'x-csrf-token': data.csrfToken || '' }
                        });
                    })
                    .then(function () { window.location.href = '/login'; })
                    .catch(function (err) {
                        console.error('[nav] Logout error:', err);
                        window.location.href = '/login';
                    });
            });
            authEl.appendChild(span);
            authEl.appendChild(btn);
        } else {
            var a = document.createElement('a');
            a.href = '/login';
            a.className = 'nav-auth-login';
            a.textContent = 'Войти';
            authEl.appendChild(a);
        }
    }

    function maybeAddAdminLink(menu, user) {
        if (!user) return;
        if (user.role !== 'admin' && user.role !== 'moderator') return;
        var existing = menu.querySelector('a[href="/admin"]');
        if (existing) return;
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '/admin';
        a.textContent = '🛠 Админ';
        if (isLinkActive('/admin')) {
            a.className = 'nav-active';
            a.setAttribute('aria-current', 'page');
        }
        li.appendChild(a);
        menu.appendChild(li);
        // Close menu on click (mobile)
        a.addEventListener('click', function () {
            var m = document.getElementById('nav-menu');
            var b = document.getElementById('nav-burger');
            if (m) m.classList.remove('open');
            if (b) {
                b.setAttribute('aria-expanded', 'false');
                b.innerHTML = '&#9776;';
            }
        });
    }

    function loadAuthStatus() {
        fetch('/api/auth/me', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var user = data.user || null;
                updateAuthSection(user);
                maybeAddAdminLink(document.getElementById('nav-menu'), user);
            })
            .catch(function (err) {
                console.error('[nav] Auth check error:', err);
                updateAuthSection(null);
            });
    }

    function init() {
        // Find or create the #main-nav container
        var container = document.getElementById('main-nav');
        if (!container) {
            container = document.createElement('div');
            container.id = 'main-nav';
            document.body.insertBefore(container, document.body.firstChild);
        }

        // Clear any existing content and inject the nav
        container.innerHTML = '';
        container.appendChild(buildNav());

        // Mark body so pages can apply nav-aware layout adjustments
        document.body.classList.add('has-main-nav');

        // Load and display auth status
        loadAuthStatus();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
