# Start Koishi with the qqbot plugin (ADR 0008) in this terminal. Stop it with Ctrl+C or by closing the window.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Instance directory: runtime/koishi (koishi.yml copied from packages/koishi-app/koishi.example.yml; Koishi's own data/ lands here).
# QQBOT_KOISHI_DIR points somewhere else (smoke tests with a temporary instance).
# Needs: npm install at the repo root, NapCat running (scripts/start-napcat.ps1),
# and the user environment variables QQBOT_LLM_API_KEY / QQBOT_ONEBOT_TOKEN / QQBOT_KOISHI_PASSWORD (see docs/koishi.md).
# The plugin shares runtime/bot (chats, lock) with scripts/start-bot.ps1: only one of the two can run at a time.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$instance = if ($env:QQBOT_KOISHI_DIR) { $env:QQBOT_KOISHI_DIR } else { Join-Path $repoRoot 'runtime\koishi' }
$configPath = Join-Path $instance 'koishi.yml'

if (-not (Test-Path $configPath)) {
    throw "Missing $configPath - copy packages\koishi-app\koishi.example.yml there and fill it in (docs\koishi.md)"
}

# The user-scope variables are the source of truth: a terminal opened before a key was set or changed
# still carries the old value, so take the user-scope one whenever it exists.
foreach ($name in 'QQBOT_LLM_API_KEY', 'QQBOT_ONEBOT_TOKEN', 'QQBOT_KOISHI_PASSWORD') {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if ($value) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
}
if (-not $env:QQBOT_LLM_API_KEY) {
    throw "QQBOT_LLM_API_KEY is not set (see packages\bot\README.md)"
}
if (-not $env:QQBOT_KOISHI_PASSWORD) {
    throw "QQBOT_KOISHI_PASSWORD is not set (console admin password, see docs\koishi.md)"
}
# The docs show '...' as the placeholder; it was once set literally
if ($env:QQBOT_KOISHI_PASSWORD -eq '...') {
    throw "QQBOT_KOISHI_PASSWORD is still the placeholder '...' - set your own password (docs\koishi.md)"
}

$nodeMajor = [int]((node -v) -replace '^v(\d+)\..*', '$1')
if ($nodeMajor -lt 24) { throw "Node >= 24 is required (found $(node -v))" }

$koishi = Join-Path $repoRoot 'node_modules\koishi\bin.js'
if (-not (Test-Path $koishi)) { throw "Koishi is not installed - run npm install at the repo root" }

# Koishi's loader reads package.json in the working directory and adds these two if they are missing;
# the real dependencies are declared in packages/koishi-app.
$manifest = Join-Path $instance 'package.json'
if (-not (Test-Path $manifest)) {
    Set-Content -Path $manifest -Encoding ascii -Value '{ "private": true, "dependencies": { "@koishijs/plugin-http": "*", "@koishijs/plugin-proxy-agent": "*" } }'
}

# One line when Koishi starts and one when node exits (runtime/koishi/start-koishi.log).
# 10-11 20:00-20:25 the watchdog opened this script six times and every window was gone within seconds with no Koishi log:
# a start line without an exit line means the window was closed from outside; an exit line gives node's code and how long it ran.
# Logging never blocks the start (ErrorActionPreference is 'Stop' up to here).
$startLog = Join-Path $instance 'start-koishi.log'
$started = Get-Date
try { Add-Content -Path $startLog -Encoding ascii -Value "$($started.ToString('yyyy-MM-dd HH:mm:ss')) start pid=$PID" } catch { }

# Koishi resolves data/ (sqlite, its own logs) against the working directory
Push-Location $instance
try {
    # With 'Stop', PowerShell 5.1 turns node's stderr output into a terminating error.
    $ErrorActionPreference = 'Continue'
    node $koishi start koishi.yml
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
    $ran = [int]((Get-Date) - $started).TotalSeconds
    try { Add-Content -Path $startLog -Encoding ascii -Value "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) exit code=$exitCode after ${ran}s pid=$PID" } catch { }
}
exit $exitCode
