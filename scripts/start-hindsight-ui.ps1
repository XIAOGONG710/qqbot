# Start the Hindsight Control Plane (web UI for browsing the memory banks) in this terminal, then open http://localhost:9999.
# Stop it with Ctrl+C or by closing the window.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Install it once with scripts/hindsight/install-control-plane.ps1. It needs the Hindsight API (scripts/start-hindsight.ps1);
# the UI's own server talks to the API, the browser only talks to the UI.
# Bound to the loopback address only: the default (0.0.0.0) would show memories taken from real chats to the whole LAN.
# The bot sets each bank's missions (packages/bot/src/memory/long-term.ts); edits made here are not synced back to it.

param(
    [int]$Port = 9999,
    [int]$ApiPort = 8888
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repoRoot 'runtime\hindsight\control-plane\bin\cli.js'
if (-not (Test-Path $cli)) { throw 'Hindsight Control Plane is not installed (run scripts\hindsight\install-control-plane.ps1)' }

$env:NEXT_TELEMETRY_DISABLED = '1'

# With 'Stop', PowerShell 5.1 turns node's stderr output into a terminating error.
$ErrorActionPreference = 'Continue'
node $cli --hostname 127.0.0.1 --port $Port --api-url "http://127.0.0.1:$ApiPort"
exit $LASTEXITCODE
