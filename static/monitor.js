/* ==========================================================================
   Контроль связи с сервером для киоска.
   Если приложение перезапускается, студент видит понятный экран ожидания,
   а страница сама перезагружается, как только сервер снова отвечает.
   ========================================================================== */
(function () {
    'use strict';

    var PING_INTERVAL = 15000;   // обычная проверка
    var RETRY_INTERVAL = 3000;   // пока сервер недоступен
    var FAILS_TO_SHOW = 2;       // сколько подряд неудач считаем сбоем

    var overlay = null;
    var statusEl = null;
    var fails = 0;
    var down = false;
    var timer = null;
    var startedAt = 0;

    function buildOverlay() {
        overlay = document.createElement('div');
        overlay.className = 'offline-overlay';
        overlay.hidden = true;
        overlay.setAttribute('role', 'alertdialog');
        overlay.setAttribute('aria-live', 'assertive');
        overlay.innerHTML =
            '<div class="offline-overlay__inner">' +
                '<div class="offline-overlay__icon">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                        '<path d="M3 3l18 18"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/>' +
                        '<path d="M5 12a10 10 0 0 1 4-2.4"/><path d="M15 9.6A10 10 0 0 1 19 12"/>' +
                        '<path d="M12 19h.01"/>' +
                    '</svg>' +
                '</div>' +
                '<h2>Сервер обновляется</h2>' +
                '<p>Приложение перезапускается. Это занимает несколько секунд.</p>' +
                '<p>Пожалуйста, подождите — страница обновится автоматически.</p>' +
                '<div class="offline-overlay__status">' +
                    '<span class="spinner"></span>' +
                    '<span data-status>Проверяем связь…</span>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        statusEl = overlay.querySelector('[data-status]');
    }

    function show() {
        if (!overlay) buildOverlay();
        down = true;
        startedAt = Date.now();
        overlay.hidden = false;
        document.documentElement.style.overflow = 'hidden';
    }

    function hide() {
        if (!overlay) return;
        down = false;
        overlay.hidden = true;
        document.documentElement.style.overflow = '';
    }

    function tickStatus() {
        if (!statusEl || !down) return;
        var seconds = Math.round((Date.now() - startedAt) / 1000);
        statusEl.textContent = 'Проверяем связь… ' + seconds + ' с';
    }

    function schedule(delay) {
        clearTimeout(timer);
        timer = setTimeout(check, delay);
    }

    function check() {
        var wasDown = down;

        fetch('/healthz', { cache: 'no-store' })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function () {
                fails = 0;
                if (wasDown) {
                    // сервер вернулся — перезагружаем страницу, чтобы получить свежие данные
                    down = false; // останавливаем счётчик секунд, чтобы он не перебивал текст
                    if (statusEl) statusEl.textContent = 'Сервер доступен. Обновляем страницу…';
                    setTimeout(function () { location.reload(); }, 700);
                    return;
                }
                hide();
                schedule(PING_INTERVAL);
            })
            .catch(function () {
                fails += 1;
                if (fails >= FAILS_TO_SHOW) {
                    show();
                    tickStatus();
                }
                schedule(RETRY_INTERVAL);
            });
    }

    function init() {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            // мониторинг всё равно нужен, просто без анимаций
        }
        check();
        setInterval(tickStatus, 1000);

        // вернулись на вкладку — проверяем сразу, не ждём таймер
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
                clearTimeout(timer);
                check();
            }
        });

        window.addEventListener('online', function () {
            clearTimeout(timer);
            check();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
