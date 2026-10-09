# Start NapCat (official NapCat.Shell.Windows.Node release) from runtime/napcat/.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Layout (all under runtime/, not committed):
#   runtime/napcat/NapCat.Shell.Windows.Node-<version>/  unpacked release, never edited
#   runtime/napcat/workdir/                              NAPCAT_WORKDIR: config/ logs/ cache/
# Upgrading = unpack the new release next to the old one and change $Version.
# On first start NapCat prints a login QR code to the console (also saved under workdir/cache/).
# Quick login: with the user environment variable QQBOT_NAPCAT_QQ set to the bot's QQ number (or -QuickLogin <number>),
# NapCat logs in with the saved session (-q), also when its worker restarts; without a saved session it falls back
# to the QR code. The number stays out of the repo.

param(
    [string]$Version = 'v4.18.28',
    [string]$QuickLogin = [Environment]::GetEnvironmentVariable('QQBOT_NAPCAT_QQ', 'User')
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$napcatRoot = Join-Path $repoRoot 'runtime\napcat'
$appDir = Join-Path $napcatRoot "NapCat.Shell.Windows.Node-$Version"
$workDir = Join-Path $napcatRoot 'workdir'

if (-not (Test-Path (Join-Path $appDir 'index.js'))) {
    throw "NapCat $Version not found at $appDir"
}

$env:NAPCAT_WORKDIR = $workDir
Push-Location $appDir
try {
    # Use the node.exe shipped in this release (as its napcat.bat does), not the system Node.
    $ErrorActionPreference = 'Continue'
    if ($QuickLogin) {
        # Restart it when it exits: on 2026-10-09 21:29 it vanished without a log line while memory was full, and the bot
        # was cut off from QQ for 18 minutes. Five exits within ten minutes means something else is wrong (the account is
        # logged in elsewhere, the saved session expired): stop and leave it to a person. To stop NapCat for maintenance,
        # close this window (or Ctrl+C), not just its node process.
        $exits = @()
        while ($true) {
            Write-Host 'Quick login with the saved session (QQBOT_NAPCAT_QQ)'
            .\node.exe .\index.js -q $QuickLogin
            $code = $LASTEXITCODE
            $exits = @($exits | Where-Object { $_ -gt (Get-Date).AddMinutes(-10) }) + (Get-Date)
            if ($exits.Count -ge 5) {
                Write-Host 'NapCat exited 5 times within 10 minutes; not restarting (logged in elsewhere? session expired?)'
                break
            }
            Write-Host "NapCat exited (code $code) at $(Get-Date -Format HH:mm:ss); restarting in 10 s"
            Start-Sleep -Seconds 10
        }
    } else {
        .\node.exe .\index.js
    }
} finally {
    Pop-Location
}
