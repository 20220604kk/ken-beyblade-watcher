param(
    [switch]$OpenBrowser,
    [switch]$Scheduled
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$dataDir = Join-Path $ProjectRoot 'data'
$systemLogsDir = Join-Path $ProjectRoot 'logs\系統'
$watchdogScript = Join-Path $ProjectRoot 'scripts\monitor-service.ps1'
$watchdogPidFile = Join-Path $dataDir 'monitor-watchdog.pid'
$servicePidFile = Join-Path $dataDir 'monitor-service.pid'
$stopFile = Join-Path $dataDir 'monitor-service.stop'
$disabledFile = Join-Path $dataDir 'monitor-disabled.flag'
$dashboardUrl = 'http://127.0.0.1:3210/'

New-Item -ItemType Directory -Path $dataDir, $systemLogsDir -Force | Out-Null

if ($Scheduled -and (Test-Path -LiteralPath $disabledFile)) {
    exit 0
}
if (-not $Scheduled) {
    Remove-Item -LiteralPath $disabledFile -Force -ErrorAction SilentlyContinue
}

function Test-WatcherProcess {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    return [string]$process.CommandLine -like "*$watchdogScript*"
}

try {
    $status = Invoke-RestMethod -Uri ($dashboardUrl + 'api/status') -Method Get -TimeoutSec 2
    Write-Host '監控服務已在運作。' -ForegroundColor Green
    Write-Host "控制台：$dashboardUrl"
    if ($OpenBrowser) { Start-Process $dashboardUrl }
    exit 0
} catch {
}

$watchdogPid = 0
if (Test-Path -LiteralPath $watchdogPidFile) {
    [void][int]::TryParse([string](Get-Content -LiteralPath $watchdogPidFile -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$watchdogPid)
}
if (Test-WatcherProcess $watchdogPid) {
    Write-Host "守護程式仍在啟動服務（PID $watchdogPid），等待控制台..."
} else {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
        throw '尚未安裝程式套件，請先執行 install.bat。'
    }
    [void](Get-Command node.exe -ErrorAction Stop)
    Remove-Item -LiteralPath $stopFile, $watchdogPidFile, $servicePidFile -Force -ErrorAction SilentlyContinue
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchdogScript, '-ProjectRoot', $ProjectRoot)
    $watchdog = Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
    Write-Host "已啟動監控守護程式（PID $($watchdog.Id)）。"
}

$status = $null
for ($attempt = 1; $attempt -le 40; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    try {
        $status = Invoke-RestMethod -Uri ($dashboardUrl + 'api/status') -Method Get -TimeoutSec 2
        break
    } catch {
    }
}
if (-not $status) {
    $errorLog = Join-Path $systemLogsDir 'monitor-current.err.log'
    if (Test-Path -LiteralPath $errorLog) {
        Get-Content -LiteralPath $errorLog -Encoding UTF8 -Tail 30
    }
    throw '控制台在 20 秒內沒有回應。'
}

Write-Host '監控服務啟動成功。' -ForegroundColor Green
Write-Host "控制台：$dashboardUrl"
if ($OpenBrowser) { Start-Process $dashboardUrl }
