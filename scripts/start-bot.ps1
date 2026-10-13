# Start the QQ bot (packages/bot) in this terminal. Stop it with Ctrl+C or by closing the window.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Needs: NapCat running (scripts/start-napcat.ps1), runtime/bot/config.json (see packages/bot/config.example.json),
# and the user environment variables QQBOT_LLM_API_KEY / QQBOT_ONEBOT_TOKEN.
# Only one bot may run at a time; a second one refuses to start (lock file runtime/bot/bot.lock).

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot 'runtime\bot\config.json'

if (-not $env:QQBOT_CONFIG -and -not (Test-Path $configPath)) {
    throw "Missing $configPath - copy packages\bot\config.example.json there and fill it in"
}

# The user-scope variables are the source of truth: a terminal opened before a key was set or changed
# still carries the old value, so take the user-scope one whenever it exists.
foreach ($name in 'QQBOT_LLM_API_KEY', 'QQBOT_ONEBOT_TOKEN') {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if ($value) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
}
if (-not $env:QQBOT_LLM_API_KEY) {
    throw "QQBOT_LLM_API_KEY is not set (see packages\bot\README.md)"
}

$nodeMajor = [int]((node -v) -replace '^v(\d+)\..*', '$1')
if ($nodeMajor -lt 24) { throw "Node >= 24 is required (found $(node -v))" }

# Expose the exact running checkout on the status page. Failure here must not block startup.
$env:QQBOT_GIT_COMMIT = 'unknown'
$env:QQBOT_GIT_BRANCH = 'unknown'
$env:QQBOT_GIT_DIRTY = 'unknown'
try {
    $env:QQBOT_GIT_COMMIT = (& git -C $repoRoot rev-parse HEAD).Trim()
    $env:QQBOT_GIT_BRANCH = (& git -C $repoRoot branch --show-current).Trim()
    if (-not $env:QQBOT_GIT_BRANCH) { $env:QQBOT_GIT_BRANCH = 'detached' }
    $dirty = & git -C $repoRoot -c submodule.recurse=false status --porcelain --ignore-submodules=all
    $env:QQBOT_GIT_DIRTY = if ($dirty) { 'true' } else { 'false' }
} catch { }

Push-Location $repoRoot
try {
    # With 'Stop', PowerShell 5.1 turns node's stderr output into a terminating error.
    $ErrorActionPreference = 'Continue'
    node packages\bot\src\main.ts
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $exitCode
