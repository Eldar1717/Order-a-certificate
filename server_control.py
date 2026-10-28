"""Управление жизненным циклом приложения на сервере.

Здесь собрано всё, что нужно для удалённой диагностики и перезапуска:

* отметка времени старта процесса (для uptime);
* файл состояния с информацией о последнем перезапуске;
* проверка доступа по токену (для секретаря и удалённого администрирования);
* отложенный самоостанов процесса: приложение не «убивает себя» мгновенно,
  а сначала отвечает на запрос, затем корректно завершается, после чего
  его поднимает служба Windows (NSSM / WinSW) или watchdog-скрипт.

Переменные окружения:

    RESTART_TOKEN   — токен для удалённого перезапуска (если пусто — режим выключен)
    RESTART_MODE    — exit (по умолчанию) или noop (не завершать процесс, только запись в лог)
    RESTART_DELAY   — задержка перед остановом в секундах (по умолчанию 1.5)
    SERVER_STATE_FILE — путь к файлу состояния (по умолчанию instance/server_state.json)
    APP_ENV         — произвольная метка окружения (prod / test), попадает в статус
"""

import hmac
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone

from database import fmt_dt

log = logging.getLogger('server_control')

APP_START = time.time()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.environ.get(
    'SERVER_STATE_FILE',
    os.path.join(BASE_DIR, 'instance', 'server_state.json')
)

RESTART_TOKEN = os.environ.get('RESTART_TOKEN', '').strip()
RESTART_MODE = os.environ.get('RESTART_MODE', 'exit').strip().lower()
RESTART_DELAY = float(os.environ.get('RESTART_DELAY', '1.5'))
APP_ENV = os.environ.get('APP_ENV', 'prod')

_lock = threading.Lock()
_restart_scheduled = False


# --------------------------------------------------------------------------- #
# Состояние процесса и файл с историей перезапусков
# --------------------------------------------------------------------------- #

def uptime_seconds():
    return int(time.time() - APP_START)


def started_at():
    return datetime.fromtimestamp(APP_START, tz=timezone.utc)


def human_uptime(seconds=None):
    """1 д 04:12 или 04:12 — в зависимости от длительности."""
    total = uptime_seconds() if seconds is None else int(seconds)
    days, rest = divmod(max(total, 0), 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    if days:
        return f'{days} д {hours:02d}:{minutes:02d}'
    if hours:
        return f'{hours:02d}:{minutes:02d}:{secs:02d}'
    return f'{minutes:02d}:{secs:02d}'


def read_state():
    """Читает историю перезапусков, не падая на битом или отсутствующем файле."""
    try:
        with open(STATE_FILE, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(**fields):
    """Обновляет файл состояния. Ошибки записи не должны ломать приложение."""
    with _lock:
        state = read_state()
        state.update(fields)
        state['updated_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        try:
            os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
            tmp = STATE_FILE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as fh:
                json.dump(state, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, STATE_FILE)
        except OSError as exc:  # например, нет прав на запись
            log.warning('Не удалось записать состояние сервера: %s', exc)
        return state


def mark_started():
    """Вызывается при старте процесса: фиксирует время запуска."""
    return write_state(
        last_start_at=datetime.now(timezone.utc).isoformat(timespec='seconds'),
        last_start_pid=os.getpid(),
        app_env=APP_ENV,
    )


# --------------------------------------------------------------------------- #
# Доступ
# --------------------------------------------------------------------------- #

def token_enabled():
    return bool(RESTART_TOKEN)


def check_token(token):
    """Сравнение без утечки длины/содержимого по времени."""
    if not RESTART_TOKEN or not token:
        return False
    return hmac.compare_digest(str(token), RESTART_TOKEN)


def is_authorized(token=None):
    """Доступ к админ-действиям: или сессия секретаря, или токен."""
    from flask import session

    if session.get('role') == 'secretary':
        return True
    return check_token(token)


# --------------------------------------------------------------------------- #
# Перезапуск
# --------------------------------------------------------------------------- #

def _exit_process():
    """Жёсткое завершение: гарантирует выход даже при живых фоновых потоках.

    Служба Windows (NSSM / WinSW) или watchdog поднимает процесс заново.
    """
    log.warning('Завершаю процесс для перезапуска (режим %s)', RESTART_MODE)
    for handler in logging.getLogger().handlers:
        try:
            handler.flush()
        except Exception:  # noqa: BLE001 - лог не должен мешать останову
            pass
    os._exit(0)


def schedule_restart(reason='вручную', by='секретарь', delay=None):
    """Планирует останов процесса. Возвращает (ok, сообщение)."""
    global _restart_scheduled

    with _lock:
        if _restart_scheduled:
            return False, 'Перезапуск уже запланирован'
        _restart_scheduled = True

    delay = RESTART_DELAY if delay is None else float(delay)
    now_iso = datetime.now(timezone.utc).isoformat(timespec='seconds')

    write_state(
        last_restart_request_at=now_iso,
        last_restart_reason=(reason or 'вручную')[:200],
        last_restart_by=(by or 'неизвестно')[:100],
        pending_restart=True,
    )
    log.warning('Запрошен перезапуск: причина=%r, инициатор=%r, через %.1f c',
                reason, by, delay)

    if RESTART_MODE == 'noop':
        log.warning('RESTART_MODE=noop — процесс не будет остановлен')
        return True, 'Перезапуск запрошен (режим noop: процесс не остановлен)'

    timer = threading.Timer(delay, _exit_process)
    timer.daemon = True
    timer.start()
    return True, 'Перезапуск запрошен'


def status_payload(db_ok=None, db_error=None):
    """Единый ответ для /healthz и админ-панели."""
    state = read_state()
    return {
        'status': 'ok' if db_ok else 'degraded',
        'app_env': APP_ENV,
        'pid': os.getpid(),
        'uptime_seconds': uptime_seconds(),
        'uptime_human': human_uptime(),
        'started_at': started_at().isoformat(timespec='seconds'),
        'started_at_local': fmt_dt(started_at()),
        'database': 'ok' if db_ok else 'error',
        'database_error': db_error,
        'restart_mode': RESTART_MODE,
        'token_enabled': token_enabled(),
        'last_start_at': state.get('last_start_at'),
        'last_restart_request_at': state.get('last_restart_request_at'),
        'last_restart_reason': state.get('last_restart_reason'),
        'last_restart_by': state.get('last_restart_by'),
        'pending_restart': bool(state.get('pending_restart')) and _restart_scheduled,
    }
