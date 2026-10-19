param(
    [ValidateSet('Start','Stop','Restart','AutoStartOn','AutoStartOff')]
    [string]$Action,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$dataPath = Join-Path $ProjectRoot 'data'
$controlMutex = New-Object Threading.Mutex($false, 'Local\KenBeybladeWatcherControl')
$acquired = $false
function Read-Status {
    try {
        $reply = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/status' -TimeoutSec 3
        if ($null -eq $reply.autoPurchase -or $null -eq $reply.japanAuctions) { throw '3210 不是此監控服務' }
        return $reply
    } catch { return $null }
}
function Assert-CanStop {
    $reply = Read-Status
    if (-not $reply) {
        $listener = Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue
        if ($listener) { throw '控制台無法確認狀態，未停止任何程序。請先查看系統日誌。' }
        return
    }
    $busy = $reply.autoPurchase.processing -or $reply.autoPurchase.queued -gt 0 -or
        $reply.autoPurchase.notificationPending -gt 0 -or $reply.autoPurchase.maintenance.running
    foreach ($platform in @('funbox','eslite')) {
        foreach ($account in $reply.autoPurchase.runtime.$platform.accounts) {
            if ($account.busy -or $account.state -eq 'busy' -or $account.interactiveLoginOpen -or
                $account.accountBrowserOpen -or $account.loginState -eq 'checking' -or
                $account.sessionRecoveryState -eq 'recovering') { $busy = $true }
        }
    }
    foreach ($line in $reply.japanAuctions.amazonJpProductOrders) {
        if ($line.running -or $line.interactive -or $line.phase -eq 'ordering' -or $line.evidencePending -gt 0 -or $line.race.busy) { $busy = $true }
    }
    if ($busy) { throw '目前有帳號操作、檢查或交易正在進行，這次沒有停止。請完成／關閉登入視窗後再試，避免中斷送單。' }
}
function Run-Script([string]$Name) {
    $scriptPath = Join-Path $ProjectRoot ('scripts\' + $Name)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $info.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
    $info.WorkingDirectory = $ProjectRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(70000)) { throw '操作尚未結束，請先查看目前狀態；不要重複點擊。' }
    if ($process.ExitCode -ne 0) { throw '服務操作失敗。請查看目前狀態及「系統日誌」，沒有重設任何帳號／訂單資料。' }
}
try {
    try { $acquired = $controlMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw '另一個開關操作尚未結束，請稍候。' }
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    switch ($Action) {
        'AutoStartOn' {
            Remove-Item -LiteralPath (Join-Path $dataPath 'monitor-autostart-disabled.flag') -Force -ErrorAction SilentlyContinue
            $message = '已允許開機啟動與異常復原；手動關閉的狀態仍優先，按「開啟監控」才會解除。'
        }
        'AutoStartOff' {
            Set-Content -LiteralPath (Join-Path $dataPath 'monitor-autostart-disabled.flag') -Value 'disabled' -Encoding ASCII
            $message = '已禁止開機與排程自動啟動；不影響正在運作的監控。'
        }
        'Start' {
            Run-Script 'start-monitor.ps1'
            if (-not (Read-Status)) { throw '啟動操作已結束，但控制台尚未回應；不能認定已啟動。' }
            $message = '監控服務已開啟；各平台沿用原設定，不會額外啟用自動下單。'
        }
        'Stop' {
            Assert-CanStop
            Run-Script 'stop-monitor.ps1'
            if (Read-Status) { throw '控制台仍有回應，不能認定已關閉。' }
            $message = '監控已關閉；重開機也維持關閉，直到再次按「開啟監控」。'
        }
        'Restart' {
            Assert-CanStop
            Run-Script 'stop-monitor.ps1'
            Run-Script 'start-monitor.ps1'
            if (-not (Read-Status)) { throw '重啟後控制台沒有回應；請查看故障原因。' }
            $message = '監控已重新啟動；沒有更動帳密、購物車或下單設定。'
        }
        default { throw '缺少控制動作。' }
    }
    @{ ok = $true; message = $message } | ConvertTo-Json -Compress
} catch {
    @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($acquired) { $controlMutex.ReleaseMutex() }
    $controlMutex.Dispose()
}
