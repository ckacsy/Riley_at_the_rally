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
        { href: '/control',   label: '🎮 Управление' },
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
