param(
  [int]$MaxWaitSeconds = 180,
  [switch]$AllowEsliteInteractiveLoginStop
)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds($MaxWaitSeconds)
$idleSamples = 0
while ([DateTime]::UtcNow -lt $deadline) {
  $status = Invoke-RestMethod -Uri http://127.0.0.1:3210/api/status -TimeoutSec 10
  $esliteAccountBusy = @($status.autoPurchase.runtime.eslite.accounts | Where-Object {
    $_.state -eq 'busy' -or $_.busy -or ($_.interactiveLoginOpen -and -not $AllowEsliteInteractiveLoginStop) -or $_.loginState -eq 'checking' -or $_.sessionRecoveryState -eq 'recovering'
  }).Count -gt 0
  $funboxAccountBusy = @($status.autoPurchase.runtime.funbox.accounts | Where-Object {
    $_.busy -or $_.interactiveLoginOpen -or $_.loginState -eq 'checking'
  }).Count -gt 0
  $busy = $status.scanning -or $status.funboxScanning -or $status.funboxSandboxScanning -or
    $status.shoppingScanning -or $status.japanScanning -or $status.amazonJpScanning -or
    $status.autoPurchase.processing -or ($status.autoPurchase.notificationPending -gt 0) -or $esliteAccountBusy -or $funboxAccountBusy -or $status.autoPurchase.maintenance.running -or ($status.autoPurchase.queued -gt 0) -or
    $status.japanAuctions.amazonJpSingleOrder.running -or $status.japanAuctions.amazonJpProductOrder.running -or
    $status.japanAuctions.amazonJpSingleOrder.interactive -or $status.japanAuctions.amazonJpProductOrder.interactive
  if ($busy) { $idleSamples = 0 } else { $idleSamples += 1 }
  if ($idleSamples -ge 2) {
    Write-Host ('Idle window found at '+(Get-Date -Format 'HH:mm:ss')+'. Reloading service once.')
    & (Join-Path $PSScriptRoot 'restart-monitor.ps1') -NoBrowser
    exit $LASTEXITCODE
  }
  Start-Sleep -Milliseconds 600
}
throw 'No idle window found. The production service was left running without a restart.'
