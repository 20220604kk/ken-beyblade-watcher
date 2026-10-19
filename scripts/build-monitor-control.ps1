param([switch]$InstallDesktopShortcut, [switch]$UpdateDesktopIcon, [string]$OutputName = 'monitor-control')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($OutputName -notmatch '^monitor-control(?:-[a-z0-9]+)*$') { throw '輸出名稱只能使用 monitor-control 與英數短名稱。' }
$output = Join-Path (Join-Path $root 'artifacts') $OutputName
New-Item -ItemType Directory -Path $output -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$exePath = Join-Path $output 'Ken監控控制台.exe'
$webVersion = '1.0.4258.31'
$webRoot = Join-Path $root ('artifacts\monitor-control-deps\webview2-' + $webVersion)
if (-not (Test-Path -LiteralPath (Join-Path $webRoot 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'))) {
    $archive = Join-Path $root ('artifacts\monitor-control-deps\webview2-' + $webVersion + '.zip')
    New-Item -ItemType Directory -Path (Split-Path -Parent $archive) -Force | Out-Null
    Invoke-WebRequest -Uri ('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + $webVersion + '/microsoft.web.webview2.' + $webVersion + '.nupkg') -OutFile $archive -TimeoutSec 60
    Expand-Archive -LiteralPath $archive -DestinationPath $webRoot -Force
}
$webCore = Join-Path $webRoot 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$webForms = Join-Path $webRoot 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
Copy-Item -LiteralPath $webCore,$webForms -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $webRoot 'build\native\x64\WebView2Loader.dll') -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $webRoot 'LICENSE.txt') -Destination (Join-Path $output 'WebView2-LICENSE.txt') -Force
$iconDir = Join-Path $root 'src\monitor-control\assets'
$iconPath = Join-Path $iconDir 'ken-monitor.ico'
$builderPath = Join-Path $output 'IconBuilder.exe'
& $compiler /nologo /target:exe /codepage:65001 "/out:$builderPath" /reference:System.Drawing.dll (Join-Path $root 'src\monitor-control\IconArt.cs') (Join-Path $root 'src\monitor-control\IconBuilder.cs')
if ($LASTEXITCODE -ne 0) { throw '圖示工具編譯失敗。' }
& $builderPath $iconDir
if ($LASTEXITCODE -ne 0) { throw '圖示輸出失敗。' }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$exePath" "/win32icon:$iconPath" "/resource:$iconPath,KenMonitorControl.AppIcon" "/resource:$(Join-Path $root 'src\monitor-control\desktop-orders.js'),KenMonitorControl.DesktopOrders" "/reference:$webCore" "/reference:$webForms" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll /reference:System.Management.dll (Join-Path $root 'src\monitor-control\Program.cs') (Join-Path $root 'src\monitor-control\IconArt.cs') (Join-Path $root 'src\monitor-control\RoundedControls.cs') (Join-Path $root 'src\monitor-control\OrdersView.cs') (Join-Path $root 'src\monitor-control\BackgroundCheck.cs') (Join-Path $root 'src\monitor-control\LayoutEvidence.cs')
if ($LASTEXITCODE -ne 0) { throw '控制台編譯失敗。' }
if ($InstallDesktopShortcut -or $UpdateDesktopIcon) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Ken監控控制台.lnk'))
    $link.TargetPath = $exePath
    $link.WorkingDirectory = $root
    $link.Description = '開啟、關閉、重啟及查看陀螺監控實際狀態'
    $link.IconLocation = $iconPath + ',0'
    $link.Save()
}
if ($InstallDesktopShortcut) {
    # Keep the existing Startup entry, but scheduled starts must respect a manual stop.
    $startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) '戰鬥陀螺監控器.lnk'
    $startup = $shell.CreateShortcut($startupLink)
    $startup.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $startup.Arguments = '"' + (Join-Path $root 'scripts\monitor-health-hidden.vbs') + '"'
    $startup.WorkingDirectory = $root
    $startup.Description = '遵守手動停止與開機設定，無視窗啟動監控'
    $startup.Save()
}
if ($InstallDesktopShortcut -or $UpdateDesktopIcon) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class KenIconRefresh { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e,uint f,IntPtr a,IntPtr b); }'
    [KenIconRefresh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}
Write-Output $exePath
