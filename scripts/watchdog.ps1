<#
.SYNOPSIS
    Watchdog для приложения «Справки колледжа»: следит за /healthz и перезапускает
    сервер, если процесс упал или не отвечает.

.DESCRIPTION
    Скрипт сам запускает приложение дочерним процессом и полностью им управляет:
      * падение процесса (например, необработанное исключение) — перезапуск;
      * приложение отвечает, но /healthz отдаёт ошибку — перезапуск после N попыток;
      * приложение «зависло» и не отвечает вообще — принудительное завершение и перезапуск;
      * защита от «шторма» перезапусков: пауза растёт при частых падениях.

    Логи пишутся в scripts\logs\watchdog.log (с ротацией по размеру).

.EXAMPLE
    # обычный запуск (для проверки, из консоли)
    powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1

.EXAMPLE
    # установить автозапуск при входе в систему и запустить сейчас
    powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1 -InstallStartup -Start

.NOTES
    Для продакшена надёжнее служба Windows (см. scripts\install-service.ps1):
    она стартует до входа пользователя в систему и переживает перезагрузку.
#>

[CmdletBinding()]
param(
    [string]$AppDir = (Split-Path -Parent $PSScriptRoot),
    [string]$Url = 'http://127.0.0.1:5000/healthz',
    [int]$Port = 5000,
    [int]$CheckIntervalSeconds = 20,
    [int]$TimeoutSeconds = 8,
    [int]$FailuresBeforeRestart = 2,
    [int]$MaxRestartsPerHour = 10,
    [switch]$InstallStartup,
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$LogDir = Join-Path $PSScriptRoot 'logs'
$LogFile = Join-Path $LogDir 'watchdog.log'
$PidFile = Join-Path $LogDir 'app.pid'
$MaxLogBytes = 5MB

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Write-Host $line
    try {
        if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MaxLogBytes)) {
            Move-Item -Path $LogFile -Destination ($LogFile + '.1') -Force
        }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch {
        # лог не должен останавливать watchdog
    }
}

function Get-PythonPath {
    $venvPython = Join-Path $AppDir '.venv\Scripts\python.exe'
    if (Test-Path $venvPython) { return $venvPython }
    return 'python'
}

function Test-AppHealth {
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSeconds -UseBasicParsing -ErrorAction Stop
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Stop-AppProcess {
    param($Process)
    if ($null -eq $Process -or $Process.HasExited) { return }
    try {
        Write-Log "Останавливаю процесс $($Process.Id) вместе с дочерними" 'WARN'
        & taskkill.exe /PID $Process.Id /T /F | Out-Null
        $Process.WaitForExit(10000) | Out-Null
    } catch {
        Write-Log "Не удалось остановить процесс: $($_.Exception.Message)" 'ERROR'
    }
}

function Start-AppProcess {
    $python = Get-PythonPath
    $serve = Join-Path $AppDir '.venv\Scripts\waitress-serve.exe'

    if (Test-Path $serve) {
        $appArgs = @('--listen=0.0.0.0:' + $Port, '--threads=8', 'app:app')
        $file = $serve
    } else {
        $appArgs = @('app.py')
        $file = $python
    }

    Write-Log "Запуск: $file $($appArgs -join ' ')"
    $process = Start-Process -FilePath $file -ArgumentList $appArgs -WorkingDirectory $AppDir `
        -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $process.Id -Encoding ASCII
    Write-Log "Приложение запущено, PID=$($process.Id)" 'INFO'
    return $process
}

function Register-StartupShortcut {
    $startup = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startup 'Справки колледжа (watchdog).lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'powershell.exe'
    $shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $shortcut.WorkingDirectory = $AppDir
    $shortcut.Description = 'Watchdog приложения «Справки колледжа»'
    $shortcut.Save()
    Write-Log "Автозапуск установлен: $shortcutPath"
}

# --------------------------------------------------------------------------- #
# Основной цикл
# --------------------------------------------------------------------------- #

if ($InstallStartup) {
    Register-StartupShortcut
    if (-not $Start) {
        Write-Log 'Автозапуск добавлен. Запустите скрипт без параметров или с -Start.'
        return
    }
}

Write-Log '=== Watchdog запущен ==='
Write-Log "Каталог приложения: $AppDir"
Write-Log "Проверка: $Url каждые $CheckIntervalSeconds с"

$process = Start-AppProcess
$failures = 0
$restartTimes = New-Object System.Collections.ArrayList
$lastStart = Get-Date

while ($true) {
    Start-Sleep -Seconds $CheckIntervalSeconds

    $process = $null
    if (Test-Path $PidFile) {
        $rawPid = (Get-Content -Path $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($rawPid -match '^\d+$') {
            $process = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
        }
    }

    if ($null -eq $process -or $process.HasExited) {
        Write-Log 'Процесс приложения завершился' 'ERROR'
        $failures = $FailuresBeforeRestart
    } elseif (Test-AppHealth) {
        if ($failures -gt 0) {
            Write-Log "Приложение отвечает, счётчик ошибок сброшен (было $failures)"
        }
        $failures = 0
        continue
    } else {
        $failures += 1
        Write-Log "Health-check не прошёл ($failures из $FailuresBeforeRestart)" 'WARN'
    }

    if ($failures -lt $FailuresBeforeRestart) { continue }

    # Защита от шторма перезапусков
    $hourAgo = (Get-Date).AddHours(-1)
    $recent = @($restartTimes | Where-Object { $_ -gt $hourAgo })
    $restartTimes = New-Object System.Collections.ArrayList
    foreach ($t in $recent) { [void]$restartTimes.Add($t) }

    if ($recent.Count -ge $MaxRestartsPerHour) {
        Write-Log "Превышен лимит перезапусков ($MaxRestartsPerHour в час). Ждём 5 минут." 'ERROR'
        Start-Sleep -Seconds 300
        continue
    }

    # Если приложение проработало меньше 2 минут — пауза перед повтором
    $alive = ((Get-Date) - $lastStart).TotalSeconds
    if ($alive -lt 120) {
        $pause = [Math]::Min([int](120 - $alive), 60)
        Write-Log "Приложение упало через $([int]$alive) с после старта, пауза $pause с" 'WARN'
        Start-Sleep -Seconds $pause
    }

    Stop-AppProcess -Process $process
    $process = Start-AppProcess
    $lastStart = Get-Date
    [void]$restartTimes.Add((Get-Date))
    $failures = 0
}
