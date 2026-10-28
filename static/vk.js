/* ==========================================================================
   Экранная клавиатура для сенсорного киоска (Windows + браузер)
   Без зависимостей: раскладки RU/EN, Shift, Caps, цифровой блок, вставка/очистка.
   ========================================================================== */
(function () {
    'use strict';

    var STORE_KEY = 'vk.enabled';

    /* ------------------------------ Раскладки ------------------------------ */

    var LAYOUTS = {
        ru: {
            name: 'РУС',
            hint: 'Русская раскладка',
            rows: [
                ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
                ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
                ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', 'ё']
            ]
        },
        en: {
            name: 'ENG',
            hint: 'Английская раскладка',
            rows: [
                ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
                ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
                ['z', 'x', 'c', 'v', 'b', 'n', 'm']
            ]
        }
    };

    var NUMPAD = [
        ['7', '8', '9'],
        ['4', '5', '6'],
        ['1', '2', '3'],
        ['.', '0', '-']
    ];

    /* Спецсимволы для цифрового режима (даты, телефоны, номера) */
    var SYMBOLS = [['.', ',', '-', '/', ':', '№', '(', ')']];

    /* ------------------------------ Состояние ------------------------------ */

    var state = {
        lang: 'ru',
        shift: false,
        caps: false,
        mode: 'text',      // text | num
        enabled: false,    // включён ли режим экранной клавиатуры
        open: false,
        active: null,      // активный input/textarea
        replaceOnNext: false, // числовое поле с готовым значением: первая цифра заменяет его
        retarget: null     // куда вернуть фокус после физической клавиатуры
    };

    var root = null;
    var rowsEl = null;
    var titleEl = null;
    var toggleBtn = null;

    /* ------------------------------ Утилиты ------------------------------ */

    function isTextField(el) {
        if (!el) return false;
        var tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag !== 'INPUT') return false;
        return ['text', 'search', 'email', 'tel', 'password', 'url', 'number'].indexOf(el.type) !== -1;
    }

    function wantsNumpad(el) {
        if (!el) return false;
        return el.type === 'number' || el.type === 'tel' || el.dataset.vk === 'num';
    }

    function supportsSelection(el) {
        // type=number и type=date не поддерживают setSelectionRange
        try {
            return typeof el.selectionStart === 'number' && el.type !== 'number' && el.type !== 'date';
        } catch (e) {
            return false;
        }
    }

    function fireInput(el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function charFor(key) {
        var upper = state.caps || state.shift; // Shift «липкий», Caps перекрывает его
        return upper ? key.toUpperCase() : key;
    }

    /* ------------------------------ Ввод ------------------------------ */

    function insertText(text) {
        var el = state.active;
        if (!el) return;

        el.focus({ preventScroll: true });

        // «1» по умолчанию в поле «Количество»: первая цифра заменяет значение
        if (state.replaceOnNext && el.type === 'number') {
            el.value = '';
            state.replaceOnNext = false;
        }

        if (supportsSelection(el)) {
            var start = el.selectionStart != null ? el.selectionStart : el.value.length;
            var end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
            var next = el.value.slice(0, start) + text + el.value.slice(end);

            if (el.maxLength > 0 && next.length > el.maxLength) {
                next = next.slice(0, el.maxLength);
            }

            el.value = next;
            var caret = Math.min(start + text.length, next.length);
            try {
                el.setSelectionRange(caret, caret);
            } catch (e) { /* ignore */ }
        } else {
            // number/date: работаем только через value
            if (el.type === 'number') {
                var raw = (el.value || '') + text;
                if (!/^-?\d*\.?\d*$/.test(raw)) return;
                el.value = raw;
            } else {
                el.value = (el.value || '') + text;
            }
        }

        fireInput(el);
        updateShiftUI();
    }

    function backspace() {
        var el = state.active;
        if (!el) return;
        el.focus({ preventScroll: true });

        if (supportsSelection(el)) {
            var start = el.selectionStart;
            var end = el.selectionEnd;
            if (start !== end) {
                el.value = el.value.slice(0, start) + el.value.slice(end);
                try { el.setSelectionRange(start, start); } catch (e) { /* ignore */ }
            } else if (start > 0) {
                el.value = el.value.slice(0, start - 1) + el.value.slice(end);
                try { el.setSelectionRange(start - 1, start - 1); } catch (e) { /* ignore */ }
            }
        } else {
            el.value = (el.value || '').slice(0, -1);
        }

        fireInput(el);
    }

    function clearField() {
        var el = state.active;
        if (!el) return;
        el.value = '';
        fireInput(el);
        el.focus({ preventScroll: true });
    }

    function isVisible(el) {
        if (el.hidden || el.disabled || el.type === 'hidden') return false;
        var style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function nextField(direction) {
        var fields = Array.prototype.slice.call(document.querySelectorAll('input, textarea')).filter(function (el) {
            return isTextField(el) && !el.readOnly && el.type !== 'hidden' && isVisible(el);
        });
        if (!fields.length) return;
        var index = fields.indexOf(state.active);
        var target = fields[(index + direction + fields.length) % fields.length];
        target.focus({ preventScroll: false });
        syncMode(target);
    }

    /* ------------------------------ Отрисовка ------------------------------ */

    function makeKey(label, opts) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vk__key' + (opts && opts.cls ? ' ' + opts.cls : '');
        btn.textContent = label;
        if (opts && opts.aria) btn.setAttribute('aria-label', opts.aria);
        if (opts && opts.data) {
            Object.keys(opts.data).forEach(function (k) { btn.dataset[k] = opts.data[k]; });
        }
        if (opts && opts.html) btn.innerHTML = opts.html;
        return btn;
    }

    function render() {
        if (!root) return;
        rowsEl.innerHTML = '';

        var layout = LAYOUTS[state.lang];
        titleEl.textContent = state.mode === 'num'
            ? 'Цифровой ввод'
            : 'Экранная клавиатура · ' + layout.hint;

        if (state.mode === 'num') {
            renderNumpad();
            return;
        }

        var shiftUp = state.caps || state.shift;

        layout.rows.forEach(function (row, rowIndex) {
            var rowEl = document.createElement('div');
            rowEl.className = 'vk__row';

            if (rowIndex === layout.rows.length - 1) {
                rowEl.appendChild(makeKey('⇧', {
                    cls: 'vk__key--mod' + (shiftUp ? ' is-active' : ''),
                    aria: 'Заглавная буква',
                    data: { action: 'shift' }
                }));
            }

            row.forEach(function (letter) {
                rowEl.appendChild(makeKey(shiftUp ? letter.toUpperCase() : letter, {
                    cls: 'vk__key--letter',
                    aria: 'Клавиша ' + letter,
                    data: { key: letter }
                }));
            });

            if (rowIndex === layout.rows.length - 1) {
                rowEl.appendChild(makeKey('⌫', {
                    cls: 'vk__key--mod vk__key--danger',
                    aria: 'Удалить символ',
                    data: { action: 'backspace' }
                }));
            }

            rowsEl.appendChild(rowEl);
        });

        /* Служебный ряд */
        var serviceRow = document.createElement('div');
        serviceRow.className = 'vk__row';

        serviceRow.appendChild(makeKey(state.lang === 'ru' ? 'ENG' : 'РУС', {
            cls: 'vk__key--mod',
            aria: 'Сменить раскладку',
            data: { action: 'lang' }
        }));
        serviceRow.appendChild(makeKey('123', {
            cls: 'vk__key--mod' + (state.mode === 'num' ? ' is-active' : ''),
            aria: 'Цифры и символы',
            data: { action: 'numpad' }
        }));
        serviceRow.appendChild(makeKey('Caps', {
            cls: 'vk__key--mod' + (state.caps ? ' is-active' : ''),
            aria: 'Фиксированные заглавные',
            data: { action: 'caps' }
        }));
        serviceRow.appendChild(makeKey('Пробел', {
            cls: 'vk__key--space',
            aria: 'Пробел',
            data: { action: 'space' }
        }));
        serviceRow.appendChild(makeKey('Готово', {
            cls: 'vk__key--primary',
            aria: 'Готово, скрыть клавиатуру',
            data: { action: 'done' }
        }));

        rowsEl.appendChild(serviceRow);
    }

    function numpadAllows(key) {
        var el = state.active;
        if (!el || el.type !== 'number') return true;
        var step = el.getAttribute('step');
        var isInteger = !step || step === '1' || step === '' ;
        if (key === '.') return !isInteger || step === 'any';
        if (key === '-') return el.min !== '' && Number(el.min) < 0;
        return true;
    }

    function renderNumpad() {
        var wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.gap = '18px';
        wrapper.style.justifyContent = 'center';
        wrapper.style.alignItems = 'stretch';
        wrapper.style.flexWrap = 'wrap';

        var grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(3, minmax(74px, 1fr))';
        grid.style.gap = '6px';
        grid.style.flex = '1 1 260px';
        grid.style.maxWidth = '420px';

        NUMPAD.forEach(function (row) {
            row.forEach(function (digit) {
                if (!numpadAllows(digit)) {
                    var placeholder = document.createElement('span');
                    placeholder.style.minHeight = '56px';
                    grid.appendChild(placeholder);
                    return;
                }
                var btn = makeKey(digit, { aria: 'Цифра ' + digit, data: { key: digit } });
                btn.style.minHeight = '56px';
                btn.style.fontSize = '1.3rem';
                grid.appendChild(btn);
            });
        });

        var symbols = document.createElement('div');
        symbols.style.display = 'grid';
        symbols.style.gridTemplateColumns = 'repeat(4, minmax(52px, 1fr))';
        symbols.style.gap = '6px';
        symbols.style.flex = '1 1 240px';
        symbols.style.alignContent = 'start';

        SYMBOLS[0].forEach(function (sym) {
            if (!numpadAllows(sym)) return;
            var btn = makeKey(sym, { aria: 'Символ ' + sym, data: { key: sym } });
            btn.style.minHeight = '52px';
            symbols.appendChild(btn);
        });

        [
            { label: '⌫', action: 'backspace', cls: 'vk__key--danger', aria: 'Удалить символ' },
            { label: 'Очистить', action: 'clear', cls: 'vk__key--danger', aria: 'Очистить поле' },
            { label: 'АБВ', action: 'text', cls: 'vk__key--mod', aria: 'Вернуться к буквам' },
            { label: 'Готово', action: 'done', cls: 'vk__key--primary', aria: 'Готово, скрыть клавиатуру' }
        ].forEach(function (item) {
            var btn = makeKey(item.label, { cls: item.cls, aria: item.aria, data: { action: item.action } });
            btn.style.minHeight = '52px';
            symbols.appendChild(btn);
        });

        wrapper.appendChild(grid);
        wrapper.appendChild(symbols);
        rowsEl.appendChild(wrapper);
    }

    function updateShiftUI() {
        if (!rowsEl) return;
        var shiftUp = state.caps || state.shift;
        Array.prototype.forEach.call(rowsEl.querySelectorAll('[data-key].vk__key--letter'), function (btn) {
            var key = btn.dataset.key;
            btn.textContent = shiftUp ? key.toUpperCase() : key;
        });
        var shiftBtn = rowsEl.querySelector('[data-action="shift"]');
        if (shiftBtn) shiftBtn.classList.toggle('is-active', shiftUp);
    }

    /* ------------------------------ Действия ------------------------------ */

    function handleAction(action) {
        switch (action) {
            case 'shift':
                state.shift = !state.shift;
                updateShiftUI();
                break;
            case 'caps':
                state.caps = !state.caps;
                if (state.caps) state.shift = false;
                render();
                break;
            case 'lang':
                state.lang = state.lang === 'ru' ? 'en' : 'ru';
                state.shift = false;
                render();
                break;
            case 'numpad':
                state.mode = 'num';
                render();
                break;
            case 'text':
                state.mode = 'text';
                render();
                break;
            case 'space':
                insertText(' ');
                break;
            case 'backspace':
                backspace();
                break;
            case 'clear':
                clearField();
                break;
            case 'next':
                nextField(1);
                break;
            case 'prev':
                nextField(-1);
                break;
            case 'hide':
                hide();
                break;
            case 'done':
                hide();
                if (state.active) state.active.blur();
                break;
        }
    }

    /* ------------------------------ Показ / скрытие ------------------------------ */

    function measure() {
        if (!root || !root.classList.contains('is-open')) {
            document.documentElement.style.setProperty('--vk-height', '0px');
            document.body.style.removeProperty('--vk-height');
            return;
        }
        var height = root.getBoundingClientRect().height;
        document.body.style.setProperty('--vk-height', Math.round(height) + 'px');
    }

    function scrollActiveIntoView() {
        var el = state.active;
        if (!el || !root) return;
        var rect = el.getBoundingClientRect();
        var vkTop = window.innerHeight - root.getBoundingClientRect().height;

        if (rect.bottom > vkTop - 24 || rect.top < 80) {
            var target = window.scrollY + rect.top - (vkTop / 2) + rect.height / 2;
            try {
                window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
            } catch (e) {
                window.scrollTo(0, Math.max(0, target));
            }
        }
    }

    function blurActive() {
        state.active = null;
        state.replaceOnNext = false;
        document.querySelectorAll('.vk-field-active').forEach(function (node) {
            node.classList.remove('vk-field-active');
        });
    }

    function show(el) {
        if (!state.enabled || !root) return;
        if (el && isTextField(el)) {
            state.active = el;
            state.replaceOnNext = el.type === 'number' && el.value !== '';
            document.querySelectorAll('.vk-field-active').forEach(function (node) {
                node.classList.remove('vk-field-active');
            });
            el.classList.add('vk-field-active');
            syncMode(el);
        }
        if (!state.active) return;

        root.classList.add('is-open');
        document.body.classList.add('vk-open');
        state.open = true;
        render();
        measure();
        scrollActiveIntoView();
    }

    function hide() {
        if (!root) return;
        root.classList.remove('is-open');
        document.body.classList.remove('vk-open');
        document.querySelectorAll('.vk-field-active').forEach(function (node) {
            node.classList.remove('vk-field-active');
        });
        state.open = false;
        measure();
    }

    function syncMode(el) {
        var next = wantsNumpad(el) ? 'num' : 'text';
        if (next !== state.mode) {
            state.mode = next;
            if (state.open) render();
        }
    }

    /* ------------------------------ Инициализация ------------------------------ */

    function buildToggle() {
        toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'vk-toggle';
        toggleBtn.setAttribute('aria-label', 'Открыть экранную клавиатуру');
        toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<rect x="2.5" y="6" width="19" height="12.5" rx="2.5"/>' +
            '<path d="M6.5 10h.01M9.8 10h.01M13.1 10h.01M16.4 10h.01M6.5 14.2h11"/>' +
            '</svg>';
        toggleBtn.addEventListener('click', function () {
            var el = state.active || document.querySelector('input[type="text"], input[type="search"], textarea');
            show(el);
        });
        document.body.appendChild(toggleBtn);
    }

    function buildKeyboard() {
        root = document.createElement('div');
        root.className = 'vk';
        root.setAttribute('role', 'group');
        root.setAttribute('aria-label', 'Экранная клавиатура');

        var inner = document.createElement('div');
        inner.className = 'vk__inner';

        var bar = document.createElement('div');
        bar.className = 'vk__bar';

        titleEl = document.createElement('div');
        titleEl.className = 'vk__title';
        titleEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<rect x="2.5" y="6" width="19" height="12.5" rx="2.5"/><path d="M6.5 10h.01M9.8 10h.01M13.1 10h.01M16.4 10h.01M6.5 14.2h11"/></svg>' +
            '<span>Экранная клавиатура</span>';

        var actions = document.createElement('div');
        actions.className = 'vk__bar-actions';

        var prev = document.createElement('button');
        prev.type = 'button';
        prev.className = 'vk__chip';
        prev.textContent = '← Предыдущее поле';
        prev.dataset.action = 'prev';
        prev.addEventListener('click', function () { handleAction('prev'); });

        var next = document.createElement('button');
        next.type = 'button';
        next.className = 'vk__chip';
        next.textContent = 'Следующее поле →';
        next.dataset.action = 'next';
        next.addEventListener('click', function () { handleAction('next'); });

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'vk__chip vk__chip--close';
        close.textContent = '✕ Скрыть';
        close.setAttribute('aria-label', 'Скрыть клавиатуру');
        close.dataset.action = 'hide';
        close.addEventListener('click', function () { handleAction('hide'); });

        actions.appendChild(prev);
        actions.appendChild(next);
        actions.appendChild(close);

        bar.appendChild(titleEl);
        bar.appendChild(actions);

        rowsEl = document.createElement('div');
        rowsEl.className = 'vk__rows';

        inner.appendChild(bar);
        inner.appendChild(rowsEl);
        root.appendChild(inner);

        /* Единый обработчик нажатий */
        root.addEventListener('pointerdown', function (event) {
            // не даём полю потерять фокус и не «проваливаемся» в скролл
            if (event.target.closest('.vk__key, .vk__chip')) event.preventDefault();
        });

        root.addEventListener('click', function (event) {
            var keyBtn = event.target.closest('[data-key]');
            if (keyBtn) {
                insertText(charFor(keyBtn.dataset.key));
                return;
            }
            var actionBtn = event.target.closest('[data-action]');
            if (actionBtn) handleAction(actionBtn.dataset.action);
        });

        document.body.appendChild(root);
    }

    function bindFields() {
        document.addEventListener('focusin', function (event) {
            if (!state.enabled) return;

            // Поле с нативным вводом (дата, чекбокс и т.п.) — экранная клавиатура не нужна
            if (event.target.matches && event.target.matches('input, textarea') && !isTextField(event.target)) {
                blurActive();
                hide();
                return;
            }

            if (isTextField(event.target)) {
                state.active = event.target;
                show(event.target);
            }
        });

        document.addEventListener('pointerdown', function (event) {
            if (!state.enabled) return;
            var field = event.target.closest && event.target.closest('input, textarea');
            if (!field) return;
            if (isTextField(field)) {
                state.active = field;
                // открываем сразу по касанию, чтобы клавиатура успела появиться до фокуса
                show(field);
            } else {
                blurActive();
                hide();
            }
        });

        /* Физическая клавиатура: скрываем экранную, возвращаем по клику в поле */
        var lastRealKey = 0;
        document.addEventListener('keydown', function (event) {
            if (!state.enabled || !state.open) return;
            if (event.key === 'Escape') {
                hide();
                return;
            }
            if (event.key === 'Tab') {
                setTimeout(function () {
                    syncMode(document.activeElement);
                }, 0);
                return;
            }
            if (event.key && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
                lastRealKey = Date.now();
                hide();
            }
            if (event.key === 'Enter' && document.activeElement && document.activeElement.tagName !== 'TEXTAREA') {
                hide();
            }
            void lastRealKey;
        });

        window.addEventListener('resize', function () {
            if (state.open) measure();
        });

        window.addEventListener('orientationchange', function () {
            setTimeout(measure, 250);
        });
    }

    function enable() {
        state.enabled = true;
        document.body.classList.add('vk-enabled');
        try { localStorage.setItem(STORE_KEY, 'on'); } catch (e) { /* ignore */ }
        if (toggleBtn) toggleBtn.classList.add('is-visible');
    }

    function disable() {
        state.enabled = false;
        hide();
        document.body.classList.remove('vk-enabled');
        try { localStorage.setItem(STORE_KEY, 'off'); } catch (e) { /* ignore */ }
        if (toggleBtn) toggleBtn.classList.remove('is-visible');
    }

    function autoDetect() {
        var forced = new URLSearchParams(location.search).get('vk');
        if (forced === 'on' || forced === '1') return true;
        if (forced === 'off' || forced === '0') return false;

        var stored = null;
        try { stored = localStorage.getItem(STORE_KEY); } catch (e) { /* ignore */ }

        if (stored === 'on') return true;
        if (stored === 'off') return false;

        // Автоопределение: грубый указатель (сенсор), сенсорные события, отсутствие мыши
        var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        var noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
        var hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

        return Boolean(hasTouch && (coarse || noHover));
    }

    function startIdleReset(seconds) {
        if (!seconds || seconds < 20) return;
        var timer = null;

        function goHome() {
            // на панели секретаря и на экране входа не перенаправляем — не мешаем работе
            var path = location.pathname;
            if (path.indexOf('/secretary') === 0) return;
            location.replace('/');
        }

        function reset() {
            clearTimeout(timer);
            timer = setTimeout(goHome, seconds * 1000);
        }

        ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (name) {
            window.addEventListener(name, reset, { passive: true });
        });

        reset();
        window.KioskKeyboard.resetIdle = reset;
    }

    function init() {
        buildKeyboard();
        buildToggle();
        bindFields();

        // кнопка переключения на странице входа секретаря и в футере
        document.querySelectorAll('[data-vk-toggle]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (state.enabled) {
                    disable();
                } else {
                    enable();
                    var first = document.querySelector('input[type="password"], input[type="text"], textarea');
                    if (first) show(first);
                }
            });
        });

        if (autoDetect()) enable();

        document.body.classList.add('kiosk-ui');

        var params = new URLSearchParams(location.search);
        var kiosk = params.get('kiosk');
        if (kiosk === '1' || kiosk === 'on' || kiosk === 'true') {
            document.body.classList.add('kiosk-mode');
            var idleParam = parseInt(params.get('idle'), 10);
            startIdleReset(isNaN(idleParam) ? 180 : idleParam);
        }

        measure();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.KioskKeyboard = {
        enable: enable,
        disable: disable,
        toggle: function () { state.enabled ? disable() : enable(); },
        show: show,
        hide: hide,
        isEnabled: function () { return state.enabled; }
    };
})();
