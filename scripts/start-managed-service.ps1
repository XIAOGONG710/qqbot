# All managed launchers use the same exclusive Windows file handle.
# The handle lasts until the foreground service script exits, including startup.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('napcat', 'hindsight', 'koishi')]
    [string]$Service
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$locks = Join-Path $repo 'runtime\boot\service-locks'
New-Item -ItemType Directory -Force -Path $locks | Out-Null
$name = $Service.ToLowerInvariant()

try {
    $lease = [IO.File]::Open((Join-Path $locks "$name.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    $win32 = $_.Exception.GetBaseException().HResult -band 0xffff
    if ($win32 -in 32, 33) {
        Write-Output "Already managed: $name"
        exit 0
    }
    throw
}

try {
    $port = @{ napcat = 3001; hindsight = 8899; koishi = 5140 }[$name]
    if ($name -eq 'hindsight' -and $env:QQBOT_HINDSIGHT_URL) {
        $port = ([uri]$env:QQBOT_HINDSIGHT_URL).Port
    }
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        Write-Output "Already listening: $name"
        exit 0
    }
    & (Join-Path $PSScriptRoot "start-$name.ps1")
} finally {
    $lease.Dispose()
}
