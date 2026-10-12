param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $scriptsDir 'stop-monitor.ps1')
Start-Sleep -Milliseconds 800
if ($NoBrowser) {
    & (Join-Path $scriptsDir 'start-monitor.ps1')
} else {
    & (Join-Path $scriptsDir 'start-monitor.ps1') -OpenBrowser
}
