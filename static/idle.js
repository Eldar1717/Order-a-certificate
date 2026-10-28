/* ==========================================================================
   Экран ожидания (заставка с командой разработчиков) для киоска студентов.
   Показывается после простоя, исчезает при первом касании.
   ========================================================================== */
(function () {
    'use strict';

    var OVERLAY_ID = 'teamIdle';
    var DEFAULT_IDLE_SECONDS = 45;

    var overlay = null;
    var timer = null;
    var idleSeconds = DEFAULT_IDLE_SECONDS;
    var suspended = false;

    function isSecretaryArea() {
        var path = location.pathname;
        return path.indexOf('/secretary') === 0 || path.indexOf('/admin') === 0;
    }

    function param(name) {
        return new URLSearchParams(location.search).get(name);
    }

    function pad(value) {
        return value < 10 ? '0' + value : String(value);
    }

    function updateClock() {
        var timeEl = document.getElementById('teamIdleTime');
        var dateEl = document.getElementById('teamIdleDate');
        if (!timeEl) return;

        var now = new Date();
        var hh = pad(now.getHours());
        var mm = pad(now.getMinutes());
        timeEl.textContent = hh + ':' + mm;
        timeEl.setAttribute('datetime', now.toISOString());

        if (dateEl) {
            var days = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
            var months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
            dateEl.textContent = days[now.getDay()] + ', ' + now.getDate() + ' ' + months[now.getMonth()];
        }
    }

    function show() {
        if (!overlay || suspended || !overlay.hidden) return;
        updateClock();
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        document.documentElement.style.overflow = 'hidden';
        document.body.classList.add('idle-mode');
        // клавиатура киоска не должна всплывать под заставкой
        if (window.KioskKeyboard && window.KioskKeyboard.isEnabled) {
            try { window.KioskKeyboard.hide(); } catch (e) { /* ignore */ }
        }
    }

    function hide() {
        if (!overlay || overlay.hidden) return;
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        document.documentElement.style.overflow = '';
        document.body.classList.remove('idle-mode');
        restartTimer();
    }

    function restartTimer() {
        clearTimeout(timer);
        if (suspended || idleSeconds <= 0) return;
        timer = setTimeout(show, idleSeconds * 1000);
    }

    function onActivity() {
        if (overlay && !overlay.hidden) return; // касание по самой заставке обрабатывается отдельно
        restartTimer();
    }

    function init() {
        if (isSecretaryArea()) return;

        overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;

        var configured = parseInt(overlay.dataset.idle, 10);
        if (!isNaN(configured)) idleSeconds = configured;

        if (param('screensaver') === 'off') {
            suspended = true;
            return;
        }
        // ?screensaver=now — показать заставку сразу (удобно для проверки)
        // в киоск-режиме (?kiosk=1) заставка показывается сразу после загрузки
        var kiosk = param('kiosk');
        if (param('screensaver') === 'now' || kiosk === '1' || kiosk === 'on' || kiosk === 'true') {
            show();
            return;
        }

        updateClock();
        setInterval(updateClock, 15000);

        // Первое касание скрывает заставку; кнопка ведёт к заказу
        overlay.addEventListener('pointerdown', function (event) {
            var start = event.target.closest('[data-idle-start]');
            if (start) {
                location.href = overlay.dataset.orderUrl || '/order';
                return;
            }
            hide();
        });

        overlay.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
                event.preventDefault();
                hide();
            }
        });

        ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (name) {
            window.addEventListener(name, onActivity, { passive: true });
        });

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) restartTimer();
        });

        // Не показываем заставку поверх уже открытой формы заказа — начинаем отсчёт
        restartTimer();
    }

    window.TeamIdle = {
        show: show,
        hide: hide,
        reset: restartTimer,
        isVisible: function () { return Boolean(overlay && !overlay.hidden); },
        setIdleSeconds: function (seconds) {
            idleSeconds = Math.max(0, Number(seconds) || 0);
            restartTimer();
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
