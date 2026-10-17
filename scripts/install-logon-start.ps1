# Register / remove the "start the whole qqbot stack when this user logs on" entry (docs/boot-start.md, section "Logon start").
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# What it writes: ONE value in HKCU\Software\Microsoft\Windows\CurrentVersion\Run named qqbot-boot. No password, no admin rights,
# nothing outside the current user's registry hive. The entry runs scripts\start-services-at-boot.ps1 (idempotent: it only starts what is
# missing, respects the maintenance flag) in a hidden PowerShell at every logon. It does NOT run when a Remote Desktop session is merely
# reconnected, only when a new session is created (after a reboot, or a sign-out and sign-in).
#
#   (no switch)  print the plan and the current state, change nothing
#   -Install     write the Run value (the path is the repo this script lives in: run it from the LIVE tree)
#   -Uninstall   remove the Run value (services that are already running are not touched)
param(
    [switch]$Install,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$bootScript = Join-Path $repoRoot 'scripts\start-services-at-boot.ps1'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'qqbot-boot'
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $bootScript

if ($Install -and $Uninstall) { throw 'Pass only one of -Install / -Uninstall' }
if (-not (Test-Path $bootScript)) { throw "Missing $bootScript" }

$current = (Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue).$name
Write-Host "Run key : $runKey"
Write-Host "Value   : $name"
Write-Host "Command : $command"
Write-Host ("Now     : {0}" -f $(if ($current) { "present -> $current" } else { 'not present' }))

if ($Install) {
    Set-ItemProperty -Path $runKey -Name $name -Value $command -Type String
    Write-Host 'Installed. Takes effect at the next logon; to try it now without logging off: run the Command above by hand (services that are up are left alone).'
} elseif ($Uninstall) {
    if ($current) { Remove-ItemProperty -Path $runKey -Name $name; Write-Host 'Removed.' } else { Write-Host 'Nothing to remove.' }
} else {
    Write-Host 'Plan only (no switch): nothing changed. Use -Install or -Uninstall.'
}
