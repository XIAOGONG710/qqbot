# enable-autologon.ps1 - let this VM sign in by itself after a reboot, so the logon-time start (scripts\install-logon-start.ps1) can bring the bot back
# without anybody logging in. (ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Why: on 2026-10-15 03:33 a Windows Update restart left the stack down for six hours, because nobody logged in until 09:25. The logon-time start only
# fires at a logon.
#
# What it changes (HKLM, needs an ELEVATED PowerShell, so the person who owns this machine runs it once): the Winlogon values
#   AutoAdminLogon = 1, DefaultUserName = <this account>, DefaultDomainName = <computer name>, DefaultPassword = "" (empty)
# It REFUSES to run if the account has a password: it never writes a password anywhere. The account XG has no password (PasswordRequired = False).
# Before any change it writes the previous values to a backup file on the Desktop, and -Undo puts them back.
#
# What it costs: anybody who can reach this VM's console is signed in as this account right after boot. That was already the case in practice (no
# password), the difference is that they no longer have to click. Remote Desktop and its rules are not touched.
#
#   (no switch)  print the current values and the plan; changes nothing (works without admin)
#   -Apply       write the values (elevated PowerShell)
#   -Undo        restore the values saved by the last -Apply (elevated PowerShell)
#   -User <name> account to sign in (default: the current user)
#
# Test after -Apply, with the owner present: restart the VM; within a minute or two it should sign in by itself, the Run entry qqbot-boot should start the
# services (runtime\boot\boot.log), and the bot should log "NapCat account ... ready". If something looks wrong: -Undo.
param(
    [switch]$Apply,
    [switch]$Undo,
    [string]$User = $env:USERNAME
)

$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$names = 'AutoAdminLogon', 'DefaultUserName', 'DefaultDomainName', 'DefaultPassword'
$backupDir = [Environment]::GetFolderPath('Desktop')

if ($Apply -and $Undo) { throw 'Pass only one of -Apply / -Undo' }

function Show-Current {
    $p = Get-ItemProperty -Path $key
    foreach ($n in $names) {
        $has = $null -ne $p.PSObject.Properties[$n]
        if ($n -eq 'DefaultPassword') { "  {0,-18} {1}" -f $n, $(if ($has) { if ([string]::IsNullOrEmpty($p.$n)) { '(present, empty)' } else { '(present, NOT empty - not shown)' } } else { '(absent)' }) }
        else { "  {0,-18} {1}" -f $n, $(if ($has) { $p.$n } else { '(absent)' }) }
    }
}

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Write-Host "Winlogon key: $key"
Write-Host 'Current values:'
Show-Current
$account = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
if ($account) { Write-Host ("Account {0}: PasswordRequired = {1}" -f $User, $account.PasswordRequired) } else { Write-Host "Account $User : not a local account (cannot check)" }

if ($Apply) {
    if (-not (Test-Admin)) { throw 'Not elevated: open PowerShell with "Run as administrator" and run this again.' }
    if (-not $account) { throw "Account $User is not a local account; refusing." }
    if ($account.PasswordRequired) { throw "Account $User has a password; this script never stores a password. Refusing." }
    $before = @{}
    $p = Get-ItemProperty -Path $key
    foreach ($n in $names) { $before[$n] = if ($null -ne $p.PSObject.Properties[$n]) { [string]$p.$n } else { $null } }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $backupDir "autologon-backup-$stamp.json"
    $before | ConvertTo-Json | Set-Content -Path $backup -Encoding UTF8
    Write-Host "Previous values saved: $backup"
    Set-ItemProperty -Path $key -Name AutoAdminLogon -Value '1' -Type String
    Set-ItemProperty -Path $key -Name DefaultUserName -Value $User -Type String
    Set-ItemProperty -Path $key -Name DefaultDomainName -Value $env:COMPUTERNAME -Type String
    Set-ItemProperty -Path $key -Name DefaultPassword -Value '' -Type String
    Write-Host 'Applied. New values:'
    Show-Current
    Write-Host 'Takes effect at the next restart. Undo: .\enable-autologon.ps1 -Undo'
} elseif ($Undo) {
    if (-not (Test-Admin)) { throw 'Not elevated: open PowerShell with "Run as administrator" and run this again.' }
    $latest = Get-ChildItem -Path $backupDir -Filter 'autologon-backup-*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) {
        $saved = Get-Content -Path $latest.FullName -Raw | ConvertFrom-Json
        foreach ($n in $names) {
            $value = $saved.$n
            if ($null -eq $value) { Remove-ItemProperty -Path $key -Name $n -ErrorAction SilentlyContinue } else { Set-ItemProperty -Path $key -Name $n -Value $value -Type String }
        }
        Write-Host "Restored from $($latest.Name)."
    } else {
        Set-ItemProperty -Path $key -Name AutoAdminLogon -Value '0' -Type String
        Remove-ItemProperty -Path $key -Name DefaultPassword -ErrorAction SilentlyContinue
        Write-Host 'No backup file found: set AutoAdminLogon = 0 and removed DefaultPassword.'
    }
    Write-Host 'Values now:'
    Show-Current
} else {
    Write-Host ''
    Write-Host 'Plan (nothing changed): AutoAdminLogon = 1, DefaultUserName = ' -NoNewline; Write-Host "$User, DefaultDomainName = $env:COMPUTERNAME, DefaultPassword = (empty)"
    Write-Host 'Run with -Apply in an elevated PowerShell to do it; -Undo restores the previous values from the backup it writes.'
}
