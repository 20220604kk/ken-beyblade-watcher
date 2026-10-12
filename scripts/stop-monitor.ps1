param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$dataDir = Join-Path $ProjectRoot 'data'
$stopFile = Join-Path $dataDir 'monitor-service.stop'
$disabledFile = Join-Path $dataDir 'monitor-disabled.flag'
$watchdogPidFile = Join-Path $dataDir 'monitor-watchdog.pid'
$servicePidFile = Join-Path $dataDir 'monitor-service.pid'
$watchdogScript = Join-Path $ProjectRoot 'scripts\monitor-service.ps1'
$entryFile = Join-Path $ProjectRoot 'src\index.js'

function Read-PidFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $parsed = 0
    [void][int]::TryParse([string](Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue | Select-Object -First 1), [ref]$parsed)
    return $parsed
}

function Stop-OwnedProcess {
    param(
        [int]$ProcessId,
        [string]$ExpectedText
    )
    if ($ProcessId -le 0) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    if ([string]$process.CommandLine -notlike "*$ExpectedText*") {
        Write-Warning "略過 PID $ProcessId：命令列不屬於此監控專案。"
        return $false
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "已停止 PID $ProcessId。"
    return $true
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ASCII
Set-Content -LiteralPath $disabledFile -Value 'disabled' -Encoding ASCII

[void](Stop-OwnedProcess -ProcessId (Read-PidFile $servicePidFile) -ExpectedText $entryFile)
Start-Sleep -Milliseconds 500
[void](Stop-OwnedProcess -ProcessId (Read-PidFile $watchdogPidFile) -ExpectedText $watchdogScript)

$listener = Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    [void](Stop-OwnedProcess -ProcessId $listener.OwningProcess -ExpectedText $entryFile)
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.CommandLine -like "*$entryFile*" } |
    ForEach-Object { [void](Stop-OwnedProcess -ProcessId $_.ProcessId -ExpectedText $entryFile) }

Remove-Item -LiteralPath $servicePidFile, $watchdogPidFile -Force -ErrorAction SilentlyContinue
Write-Host '監控服務已強制停止。' -ForegroundColor Yellow
