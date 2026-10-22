<#
  Registers (or re-registers) the daily S4U task `openGym-Backup` -> host\backup.ps1 at 01:30,
  ahead of the 02:00-08:00 update-restart window. Missed runs catch up at next boot.
  Run once from an *Administrator* PowerShell:
    powershell -ExecutionPolicy Bypass -File C:\Users\jwcb2\opengym\app\host\register-backup-task.ps1
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'backup.ps1'

$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
$t = New-ScheduledTaskTrigger -Daily -At 1:30am
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'openGym-Backup' -Action $a -Trigger $t -Principal $p -Settings $s -Force `
  -Description "Daily zip of opengym\app\data to opengym\backups (keep 30). Script: $script" | Out-Null

Start-ScheduledTask -TaskName 'openGym-Backup'
Start-Sleep -Seconds 8
$i = Get-ScheduledTaskInfo -TaskName 'openGym-Backup'
Write-Host ("openGym-Backup registered. Test run result: {0} (0 = OK). Next run: {1}" -f $i.LastTaskResult, $i.NextRunTime)
Get-Content (Join-Path $PSScriptRoot 'logs\backup.log') -Tail 1
