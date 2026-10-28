<#
.SYNOPSIS
    Устанавливает приложение как службу Windows (NSSM) с автоматическим перезапуском.

.DESCRIPTION
    Служба — самый надёжный вариант для сервера:
      * запускается до входа пользователя в систему;
      * переживает перезагрузку компьютера;
      * перезапускает приложение через 5 секунд после любого падения;
      * при зависании проверяет упавший процесс и поднимает его заново.

    Скрипт нужно запускать от имени администратора.
    NSSM (nssm.exe) должен лежать рядом со скриптом или быть доступен в PATH.
    Скачать: https://nssm.cc/download (распакуйте nssm.exe из папки win64).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall

.NOTES
    Альтернатива без внешних утилит: «Планировщик заданий» с триггером
    «При запуске компьютера» и действием scripts\watchdog.ps1.
#>

[CmdletBinding()]
param(
    [string]$AppDir = (Split-Path -Parent $PSScriptRoot),
    [string]$ServiceName = 'CollegeCertificates',
    [string]$DisplayName = 'Справки колледжа',
    [int]$Port = 5000,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Запустите PowerShell от имени администратора.'
    }
}

function Find-Nssm {
    $candidates = @(
        (Join-Path $PSScriptRoot 'nssm.exe'),
        (Join-Path $PSScriptRoot 'tools\nssm.exe'),
        'nssm.exe'
    )
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    throw 'nssm.exe не найден. Положите его рядом со скриптом или добавьте в PATH (nssm.cc/download).'
}

Assert-Administrator

if ($Uninstall) {
    $nssm = Find-Nssm
    Write-Host "Останавливаю и удаляю службу $ServiceName…"
    & $nssm stop $ServiceName | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
    Write-Host 'Служба удалена.' -ForegroundColor Green
    return
}

$nssm = Find-Nssm

# Выбираем, чем запускать: waitress из venv, иначе python
$waitress = Join-Path $AppDir '.venv\Scripts\waitress-serve.exe'
$python = Join-Path $AppDir '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }

if (Test-Path $waitress) {
    $application = $waitress
    $appArguments = "--listen=0.0.0.0:$Port --threads=8 app:app"
} else {
    $application = $python
    $appArguments = 'app.py'
}

Write-Host "Каталог:    $AppDir"
Write-Host "Команда:    $application $appArguments"
Write-Host "Служба:     $ServiceName"
Write-Host ''

# Если служба уже есть — удаляем, чтобы применить новые настройки
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Служба уже установлена, переустанавливаю…" -ForegroundColor Yellow
    & $nssm stop $ServiceName | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 2
}

& $nssm install $ServiceName $application $appArguments
& $nssm set $ServiceName AppDirectory $AppDir
& $nssm set $ServiceName DisplayName $DisplayName
& $nssm set $ServiceName Description 'Система мониторинга готовности справок колледжа'
& $nssm set $ServiceName Start SERVICE_AUTO_START

# Переменные окружения приложения
& $nssm set $ServiceName AppEnvironmentExtra `
    "APP_ENV=prod" `
    "RESTART_MODE=exit" `
    "PORT=$Port"

# Логи приложения
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
& $nssm set $ServiceName AppStdout (Join-Path $logDir 'app.out.log')
& $nssm set $ServiceName AppStderr (Join-Path $logDir 'app.err.log')
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 10485760

# Автоперезапуск при падении: 5 секунд, без ограничения попыток
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000
& $nssm set $ServiceName AppThrottle 10000

# Зависание: NSSM не умеет сам опрашивать HTTP, поэтому дополнительно
# ставим watchdog в Планировщик заданий (он проверяет /healthz).
Write-Host ''
Write-Host 'Запускаю службу…'
& $nssm start $ServiceName

Start-Sleep -Seconds 4
$service = Get-Service -Name $ServiceName
Write-Host "Состояние службы: $($service.Status)" -ForegroundColor Green
Write-Host ''
Write-Host 'Проверка здоровья:' -ForegroundColor Cyan
try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 10
    Write-Host $health.Content
} catch {
    Write-Host "Приложение ещё не отвечает: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "Посмотрите лог: $logDir\app.err.log"
}

Write-Host ''
Write-Host 'Готово. Управление:' -ForegroundColor Cyan
Write-Host "  Get-Service $ServiceName"
Write-Host "  Restart-Service $ServiceName"
Write-Host "  nssm edit $ServiceName"
Write-Host ''
Write-Host 'Для контроля зависаний добавьте watchdog в Планировщик заданий:' -ForegroundColor Cyan
Write-Host "  schtasks /create /tn `"CollegeCertificates-Watchdog`" /sc minute /mo 5 /ru SYSTEM /tr `"powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\watchdog-check.ps1`"`""
