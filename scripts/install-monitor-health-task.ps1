param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$hiddenLauncher = Join-Path $ProjectRoot 'scripts\monitor-health-hidden.vbs'
$taskName = '戰鬥陀螺監控自動復原'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$arguments = '"' + $hiddenLauncher + '"'
$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description '以無視窗方式每 5 分鐘檢查本機 3210 控制台；只有服務消失時才重新啟動。' -Force | Out-Null
Write-Host "已建立 Windows 自動復原工作：$taskName"
