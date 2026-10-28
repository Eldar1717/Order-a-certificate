<#
.SYNOPSIS
    Разовая проверка здоровья приложения + перезапуск службы при зависании.
    Предназначен для запуска по расписанию (Планировщик заданий, каждые 2–5 минут).

.DESCRIPTION
    Сама служба Windows перезапускает приложение только когда процесс упал.
    Если процесс жив, но «завис» (например, заклинило подключение к БД),
    этот скрипт заметит отсутствие ответа /healthz и перезапустит службу.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\watchdog-check.ps1

.EXAMPLE
    # зарегистрировать проверку каждые 3 минуты от имени SYSTEM
    schtasks /create /tn "CollegeCertificates-Watchdog" /sc minute /mo 3 /ru SYSTEM ^
      /tr "powershell -ExecutionPolicy Bypass -File C:\apps\certs\scripts\watchdog-check.ps1" /f
#>

[CmdletBinding()]
param(
    [string]$Url = 'http://127.0.0.1:5000/healthz',
    [int]$Port = 5000,
    [string]$ServiceName = 'CollegeCertificates',
    [int]$TimeoutSeconds = 10,
    [int]$Attempts = 2,
    [int]$AttemptDelaySeconds = 5
)

$ErrorActionPreference = 'Stop'

$LogDir = Join-Path $PSScriptRoot 'logs'
$LogFile = Join-Path $LogDir 'watchdog-check.log'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

function Test-Health {
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSeconds -UseBasicParsing -ErrorAction Stop
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

$healthy = $false
for ($i = 1; $i -le $Attempts; $i++) {
    if (Test-Health) {
        $healthy = $true
        break
    }
    if ($i -lt $Attempts) { Start-Sleep -Seconds $AttemptDelaySeconds }
}

if ($healthy) {
    # тихий успешный проход, чтобы не раздувать лог
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) {
        Move-Item -Path $LogFile -Destination ($LogFile + '.1') -Force
    }
    exit 0
}

Write-Log "Health-check не прошёл после $Attempts попыток ($Url)" 'ERROR'

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if ($service) {
    Write-Log "Служба $ServiceName в состоянии $($service.Status) — перезапускаю" 'WARN'
    try {
        Restart-Service -Name $ServiceName -Force -ErrorAction Stop
        Start-Sleep -Seconds 5
        if (Test-Health) {
            Write-Log 'Приложение поднялось после перезапуска службы' 'INFO'
            exit 0
        }
        Write-Log 'После перезапуска службы приложение всё ещё не отвечает' 'ERROR'
        exit 2
    } catch {
        Write-Log "Не удалось перезапустить службу: $($_.Exception.Message)" 'ERROR'
        exit 2
    }
}

# Службы нет — значит, приложение запущено вручную. Пробуем найти процесс по порту.
Write-Log "Служба $ServiceName не найдена, ищу процесс, слушающий порт $Port" 'WARN'
try {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    foreach ($connection in $connections) {
        $proc = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Log "Останавливаю процесс $($proc.ProcessName) (PID $($proc.Id))" 'WARN'
            & taskkill.exe /PID $proc.Id /T /F | Out-Null
        }
    }
    Write-Log 'Процесс остановлен. Запустите приложение или службу заново.' 'ERROR'
} catch {
    Write-Log 'Процесс на порту не найден — приложение не запущено' 'ERROR'
}

exit 2
