# Register (or remove) the scheduled task that brings the whole qqbot stack up after a reboot, with or without anyone logged in.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.) Read docs/boot-start.md first.
#
#   .\scripts\install-services-tasks.ps1               print the plan, change nothing (default)
#   .\scripts\install-services-tasks.ps1 -Install      register the task; asks for the Windows password in a credential prompt
#   .\scripts\install-services-tasks.ps1 -Uninstall    remove the task again
#
# Why a password: "run whether the user is logged on or not" is what makes the task start at boot with nobody on the desktop,
# and Windows only allows that with a stored credential. This script never sees the password in a file or on the command line:
# Get-Credential prompts for it and hands it straight to the Task Scheduler. An "Interactive" task (no password) was tried before
# and failed with 0x800710E0, and it would not start without a logged-on session anyway.
#
# The task runs scripts\start-services-at-boot.ps1, which starts only what is not already up, so a second run does no harm.
param(
    [switch]$Install,
    [switch]$Uninstall,
    [string]$TaskName = 'qqbot-boot',
    [int]$DelaySeconds = 60
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repoRoot 'scripts\start-services-at-boot.ps1'
if (-not (Test-Path $script)) { throw "missing $script" }
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$account = "$env:USERDOMAIN\$env:USERNAME"

if ($Uninstall) {
    if (-not $existing) { Write-Host "Task '$TaskName' is not registered - nothing to remove."; exit 0 }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Task '$TaskName' removed. The services that are running now are untouched."
    exit 0
}

Write-Host "Plan for task '$TaskName':"
Write-Host "  runs as        $account (password asked once, stored by the Task Scheduler)"
Write-Host "  triggers       at system start (+$DelaySeconds s), and at logon of $account (the script is idempotent)"
Write-Host "  action         powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
Write-Host "  settings       no time limit, one instance at a time, start as soon as possible after a missed start"
Write-Host "  already there  $(if ($existing) { 'YES - -Install would replace it' } else { 'no' })"
if (-not $Install) {
    Write-Host ''
    Write-Host 'Dry run only. Review the plan, run  .\scripts\start-services-at-boot.ps1 -DryRun  to see what the boot script would do right now,'
    Write-Host 'then add -Install. Rollback: -Uninstall.'
    exit 0
}

$credential = Get-Credential -UserName $account -Message "Windows password of $account (for the '$TaskName' scheduled task; stored by the Task Scheduler, not by this script)"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $repoRoot `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$atStart = New-ScheduledTaskTrigger -AtStartup
$atStart.Delay = "PT$($DelaySeconds)S"
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $account
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atStart, $atLogon) -Settings $settings `
    -User $credential.UserName -Password $credential.GetNetworkCredential().Password -RunLevel Limited `
    -Description 'qqbot: start NapCat, Hindsight, Koishi and the services watchdog after a reboot (scripts\start-services-at-boot.ps1)' | Out-Null
$credential = $null
Write-Host "Task '$TaskName' registered. Test it without rebooting:  Start-ScheduledTask -TaskName $TaskName  (it only starts what is missing),"
Write-Host 'then look at runtime\boot\boot.log. Rollback: .\scripts\install-services-tasks.ps1 -Uninstall'
