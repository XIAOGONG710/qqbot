# Install the Hindsight Control Plane (web UI for the memory banks) into runtime/hindsight/control-plane.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Downloads the pinned npm tarball and checks its SHA-256 before extracting anything. The pinned value equals the asset of
# the same name in the GitHub release vectorize-io/hindsight v0.10.2, and the tarball matches the npm registry's
# dist.integrity and signature (see docs/hindsight.md). The tarball ships a prebuilt Next.js standalone server with its
# own node_modules, so no npm install runs and no install scripts run.
# Keep the version in step with hindsight-api-slim in scripts/hindsight/requirements.txt.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$version = '0.10.2'
$sha256 = 'ede0825aad2a87500c70b3d204aa1d3cff5de59557764eba281ced8b34a7d6c4'
$url = "https://registry.npmjs.org/@vectorize-io/hindsight-control-plane/-/hindsight-control-plane-$version.tgz"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$target = Join-Path $repoRoot 'runtime\hindsight\control-plane'
$staging = "$target.new"
$tarball = Join-Path ([IO.Path]::GetTempPath()) "hindsight-control-plane-$version.tgz"

Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $tarball
$actual = (Get-FileHash -Algorithm SHA256 $tarball).Hash.ToLowerInvariant()
if ($actual -ne $sha256) {
    Remove-Item $tarball
    throw "SHA-256 mismatch for $url (expected $sha256, got $actual)"
}

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory $staging | Out-Null
& "$env:SystemRoot\System32\tar.exe" -xzf $tarball -C $staging --strip-components=1
if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
Remove-Item $tarball

if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Move-Item $staging $target
Write-Output "Hindsight Control Plane $version installed at $target"
