Option Explicit

Dim shell, fso, scriptDir, startScript, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
startScript = fso.BuildPath(scriptDir, "start-monitor.ps1")
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & startScript & """ -Scheduled"

' Window style 0 keeps the recurring health check completely invisible.
shell.Run command, 0, True
