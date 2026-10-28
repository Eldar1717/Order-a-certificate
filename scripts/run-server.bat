@echo off
rem ============================================================================
rem  Запуск сервера «Справки колледжа» в консольном режиме
rem  Используется для первой проверки или если служба не установлена.
rem  Для продакшена ставьте службу: scripts\install-service.ps1
rem ============================================================================

setlocal

cd /d "%~dp0.."

rem --- Настройки (измените под себя) ------------------------------------------
if "%PORT%"=="" set PORT=5000
if "%RESTART_MODE%"=="" set RESTART_MODE=exit
rem Токен для удалённого перезапуска: задайте свой длинный пароль
if "%RESTART_TOKEN%"=="" set RESTART_TOKEN=
rem Пароль секретаря и секрет сессий — обязательно поменяйте в продакшене
if "%SECRETARY_PASSWORD%"=="" set SECRETARY_PASSWORD=
if "%SECRET_KEY%"=="" set SECRET_KEY=
set APP_ENV=prod
rem ---------------------------------------------------------------------------

if exist ".venv\Scripts\waitress-serve.exe" (
    echo [i] Запуск через waitress на порту %PORT%
    ".venv\Scripts\waitress-serve.exe" --listen=0.0.0.0:%PORT% --threads=8 app:app
    goto :eof
)

if exist ".venv\Scripts\python.exe" (
    echo [i] waitress не найден, запускаю python app.py
    ".venv\Scripts\python.exe" app.py
    goto :eof
)

echo [!] Не найдено виртуальное окружение .venv
echo     Создайте его: python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
pause
