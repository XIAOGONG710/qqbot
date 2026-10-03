# Start SillyTavern from the vendor submodule, keeping config and data in runtime/sillytavern/.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Both paths must be absolute: server.js chdirs into the SillyTavern directory after parsing
# the arguments, so a relative --dataRoot would end up inside the submodule.
# Extra arguments are passed through to server.js, e.g. -- --port 8001

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$stDir = Join-Path $repoRoot 'vendor\SillyTavern'
$runtimeDir = Join-Path $repoRoot 'runtime\sillytavern'
$configPath = Join-Path $runtimeDir 'config.yaml'
$dataRoot = Join-Path $runtimeDir 'data'

if (-not (Test-Path (Join-Path $stDir 'server.js'))) {
    throw "SillyTavern submodule is missing. Run: git submodule update --init"
}

New-Item -ItemType Directory -Force $runtimeDir | Out-Null

Push-Location $stDir
try {
    if (-not (Test-Path 'node_modules')) {
        # Same flags as upstream Start.bat; npm ci never rewrites package-lock.json.
        npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
    }
    $env:NODE_ENV = 'production'
    # With 'Stop', PowerShell 5.1 turns node's stderr warnings into a terminating error when output is redirected.
    $ErrorActionPreference = 'Continue'
    node server.js --configPath $configPath --dataRoot $dataRoot @args
} finally {
    Pop-Location
}
