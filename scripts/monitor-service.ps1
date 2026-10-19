param(
    [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Continue'
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$dataDir = Join-Path $ProjectRoot 'data'
$logsDir = Join-Path $ProjectRoot 'logs\\系統'
$archiveLogsDir = Join-Path $ProjectRoot 'logs\\原始封存'
$stopFile = Join-Path $dataDir 'monitor-service.stop'
$disabledFile = Join-Path $dataDir 'monitor-disabled.flag'
$watchdogPidFile = Join-Path $dataDir 'monitor-watchdog.pid'
$servicePidFile = Join-Path $dataDir 'monitor-service.pid'
$watchdogLog = Join-Path $logsDir 'watchdog.log'
$stdoutLog = Join-Path $logsDir 'monitor-current.out.log'
$stderrLog = Join-Path $logsDir 'monitor-current.err.log'
$entryFile = Join-Path $ProjectRoot 'src\index.js'

New-Item -ItemType Directory -Path $dataDir, $logsDir, $archiveLogsDir -Force | Out-Null

function Write-WatchdogLog {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if ((Test-Path -LiteralPath $watchdogLog) -and (Get-Item -LiteralPath $watchdogLog).Length -ge 2MB) {
        $rotatedWatchdog = Join-Path $logsDir ('watchdog-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
        Move-Item -LiteralPath $watchdogLog -Destination $rotatedWatchdog
    }
    Add-Content -LiteralPath $watchdogLog -Value $line -Encoding UTF8
}

try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
} catch {
    Write-WatchdogLog '找不到 Node.js，服務守護程式停止。'
    exit 1
}

$serviceMutex = New-Object Threading.Mutex($false, 'Local\KenBeybladeWatcherService')
try { $serviceMutexOwned = $serviceMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $serviceMutexOwned = $true }
if (-not $serviceMutexOwned) { $serviceMutex.Dispose(); exit 0 }
if ((Test-Path -LiteralPath $stopFile) -or (Test-Path -LiteralPath $disabledFile)) {
    $serviceMutex.ReleaseMutex(); $serviceMutex.Dispose(); exit 0
}
Set-Content -LiteralPath $watchdogPidFile -Value $PID -Encoding ASCII
Write-WatchdogLog "守護程式啟動，PID=$PID。"
$runNumber = 0

try {
    while (-not (Test-Path -LiteralPath $stopFile) -and -not (Test-Path -LiteralPath $disabledFile)) {
        if ($runNumber -gt 0) {
            $archiveStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            if ((Test-Path -LiteralPath $stdoutLog) -and (Get-Item -LiteralPath $stdoutLog).Length -gt 0) {
                Move-Item -LiteralPath $stdoutLog `
                    -Destination (Join-Path $archiveLogsDir "crash-$archiveStamp-$runNumber.out.log") `
                    -Force
            }
            if ((Test-Path -LiteralPath $stderrLog) -and (Get-Item -LiteralPath $stderrLog).Length -gt 0) {
                Move-Item -LiteralPath $stderrLog `
                    -Destination (Join-Path $archiveLogsDir "crash-$archiveStamp-$runNumber.err.log") `
                    -Force
            }
        }
        $runNumber += 1
        $startedAt = Get-Date
        Write-WatchdogLog "啟動監控服務：$entryFile"
        Set-Location -LiteralPath $ProjectRoot

        $service = Start-Process -FilePath $node `
            -ArgumentList @($entryFile) `
            -WorkingDirectory $ProjectRoot `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog `
            -WindowStyle Hidden `
            -PassThru

        Set-Content -LiteralPath $servicePidFile -Value $service.Id -Encoding ASCII
        # Retain the original process handle so Windows exit status stays available
        # after termination instead of reopening a PID which may no longer exist.
        $serviceHandle = $service.Handle
        $service.WaitForExit()
        $exitCode = $service.ExitCode
        if ($null -eq $exitCode -or [string]::IsNullOrWhiteSpace([string]$exitCode)) {
            $exitCode = 'unknown'
        }
        $runtimeSeconds = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
        Remove-Item -LiteralPath $servicePidFile -Force -ErrorAction SilentlyContinue
        Write-WatchdogLog "監控服務已退出：PID=$($service.Id)，ExitCode=$exitCode，運作 ${runtimeSeconds} 秒。"

        if (Test-Path -LiteralPath $stopFile) {
            break
        }

        $delaySeconds = if ($runtimeSeconds -lt 30) { 10 } else { 3 }
        Write-WatchdogLog "非預期退出，${delaySeconds} 秒後自動重啟。"
        Start-Sleep -Seconds $delaySeconds
    }
} catch {
    Write-WatchdogLog "守護程式錯誤：$($_.Exception.ToString())"
    exit 1
} finally {
    Remove-Item -LiteralPath $servicePidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $watchdogPidFile -Force -ErrorAction SilentlyContinue
    Write-WatchdogLog '守護程式已停止。'
    if ($serviceMutexOwned) { $serviceMutex.ReleaseMutex() }
    $serviceMutex.Dispose()
}
