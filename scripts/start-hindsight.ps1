# Start the Hindsight memory service (ADR 0004 decision 3) in this terminal. Stop it with Ctrl+C or by closing the window.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Set up once as described in docs/hindsight.md. Layout (all under runtime/hindsight/, not committed):
#   venv/       Python 3.12 venv with scripts/hindsight/requirements.txt installed (hindsight-api-slim, pg0, onnxruntime)
#   pgdata/     used only when the repo path is pure ASCII - otherwise %LOCALAPPDATA%\qqbot-hindsight\pgdata (see $pgData below).
#               PostgreSQL data of the pg0 instance "qqbot-hindsight", listening on 127.0.0.1:5433 only.
#   hf/         Hugging Face cache for the embedding model (intfloat/multilingual-e5-small, ONNX)
#   pgroonga/   the verified PGroonga 4.0.9 zip and its file list; the files themselves are unpacked into pg0's PostgreSQL
#
# Needs the VC++ 2015-2022 redistributable 14.40 or newer installed system-wide: onnxruntime and the bundled
# PostgreSQL crash (0xC0000005) on an older msvcp140.dll. The script checks this before starting anything.
#
# The API listens on 127.0.0.1:8888. Hindsight calls DeepSeek with the bot's key (QQBOT_LLM_API_KEY), thinking off.
# Start this before the bot (scripts/start-bot.ps1) when runtime/bot/config.json has a "memory" section.

param(
    [int]$Port = 8888,
    [int]$DbPort = 5433,
    [string]$Model = 'deepseek-flash'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repoRoot 'runtime\hindsight'
$venv = Join-Path $root 'venv'
$pg0 = Join-Path $venv 'Lib\site-packages\pg0\bin\pg0.exe'
$api = Join-Path $venv 'Scripts\hindsight-api.exe'
if (-not (Test-Path $api)) { throw "Hindsight is not installed at $venv (see docs\hindsight.md)" }

# The user-scope variable is the source of truth: a terminal opened before the key was set or changed
# still carries the old value, so take the user-scope one whenever it exists.
$userKey = [Environment]::GetEnvironmentVariable('QQBOT_LLM_API_KEY', 'User')
if ($userKey) { $env:QQBOT_LLM_API_KEY = $userKey }
if (-not $env:QQBOT_LLM_API_KEY) { throw 'QQBOT_LLM_API_KEY is not set (see packages\bot\README.md)' }

# Chinese keyword search needs PGroonga in pg0's PostgreSQL (docs/hindsight.md, "PGroonga").
if (-not (Get-ChildItem "$env:USERPROFILE\.pg0\installation\*\share\extension\pgroonga.control" -ErrorAction SilentlyContinue)) {
    throw 'PGroonga is not installed in pg0''s PostgreSQL (see docs\hindsight.md, section PGroonga)'
}

# onnxruntime and pg0's PostgreSQL are built with a newer MSVC and crash on msvcp140.dll older than 14.40 (docs/hindsight.md).
$msvcp = Join-Path $env:SystemRoot 'System32\msvcp140.dll'
$msvcpVersion = if (Test-Path $msvcp) { [version](Get-Item $msvcp).VersionInfo.FileVersion } else { [version]'0.0' }
if ($msvcpVersion -lt [version]'14.40') {
    throw "System msvcp140.dll is $msvcpVersion; install the latest VC++ redistributable (14.40 or newer, see docs\hindsight.md)"
}

# With 'Stop', PowerShell 5.1 turns native stderr output into a terminating error.
$ErrorActionPreference = 'Continue'

# PostgreSQL (pg0): start the instance unless it is already running.
# The data directory must be on a pure-ASCII path: pg0 (Rust) reads a file back as UTF-8 and dies with
# "Error: IO error: stream did not contain valid UTF-8" when the path contains non-ASCII characters.
# Measured 2026-10-06: the same command succeeded with -d C:\hindsight-pgdata and failed with
# -d <repo>\runtime\hindsight\pgdata on a repo under a folder with Chinese characters in its name.
# So: QQBOT_PGDATA if set; else runtime\hindsight\pgdata when the repo path is pure ASCII (where the existing data lives -
# switching an existing install to an empty directory would look like all memories were lost);
# else %LOCALAPPDATA%\qqbot-hindsight\pgdata.
$instance = 'qqbot-hindsight'
$repoPgData = Join-Path $root 'pgdata'
$pgData = if ($env:QQBOT_PGDATA) { $env:QQBOT_PGDATA }
          elseif ($repoPgData -notmatch '[^\x00-\x7F]') { $repoPgData }
          else { Join-Path $env:LOCALAPPDATA 'qqbot-hindsight\pgdata' }
if ($pgData -match '[^\x00-\x7F]') {
    throw "PostgreSQL data directory ('$pgData') contains non-ASCII characters; pg0 fails with 'stream did not contain valid UTF-8'. Set QQBOT_PGDATA to an ASCII path (docs\hindsight.md)"
}
New-Item -ItemType Directory -Force -Path $pgData | Out-Null
# Database password (ADR 0070 item 12). The default stays "hindsight" because the existing data directory was initialised with it:
# pg0 only applies -P when it creates the cluster, so changing QQBOT_HINDSIGHT_DB_PASSWORD on an existing one needs the ALTER ROLE
# step in docs\hindsight.md first. Only URL-safe characters, because the same value goes into the connection URL.
$dbPassword = if ($env:QQBOT_HINDSIGHT_DB_PASSWORD) { $env:QQBOT_HINDSIGHT_DB_PASSWORD } else { 'hindsight' }
if ($dbPassword -ne 'hindsight' -and $dbPassword -notmatch '^[A-Za-z0-9_-]{12,}$') {
    throw 'QQBOT_HINDSIGHT_DB_PASSWORD must be at least 12 characters of A-Z a-z 0-9 _ -'
}
$info = & $pg0 info --name $instance 2>&1 | Out-String
if ($info -notmatch 'is running') {
    & $pg0 start --name $instance --data-dir $pgData --port $DbPort -u hindsight -P $dbPassword -n hindsight
    if ($LASTEXITCODE -ne 0) { throw "pg0 start failed (exit $LASTEXITCODE)" }
}

$env:HF_HOME = Join-Path $root 'hf'
$env:PYTHONUTF8 = '1'
$env:HINDSIGHT_API_HOST = '127.0.0.1'
$env:HINDSIGHT_API_PORT = "$Port"
$env:HINDSIGHT_API_DATABASE_URL = "postgresql://hindsight:$dbPassword@127.0.0.1:$DbPort/hindsight"
$env:HINDSIGHT_API_LLM_PROVIDER = 'deepseek'
$env:HINDSIGHT_API_LLM_API_KEY = $env:QQBOT_LLM_API_KEY
$env:HINDSIGHT_API_LLM_MODEL = $Model
$env:HINDSIGHT_API_LLM_EXTRA_BODY = '{"thinking":{"type":"disabled"}}'
$env:HINDSIGHT_API_EMBEDDINGS_PROVIDER = 'onnx'
$env:HINDSIGHT_API_RERANKER_PROVIDER = 'rrf'
# Keyword search with TokenBigram: the default (native, english tsvector) cannot split Chinese, so a nickname
# inside a sentence ("tie-guo jin-tian you...") never matched. Switching needs empty memory tables (docs/hindsight.md).
$env:HINDSIGHT_API_TEXT_SEARCH_EXTENSION = 'pgroonga'
# Cap the connection pools (default 100): memory sims opened dozens of connections at once, and on this 6 GB machine
# PGroonga then failed to map memory inside one of them, which kept failing for two hours (docs/hindsight.md, "坏连接").
# 16 was still too many: every PGroonga connection holds about 200 MB, and on 10-09 20:44 one memory sim filled the
# pool to 16 idle connections (Postgres 4.2 GB, 125 MB commit headroom left). 6 is plenty for the bot plus one sim batch;
# requests queue for a connection instead of opening more. No parallel query workers either: each one is another backend.
if (-not $env:HINDSIGHT_API_DB_POOL_MIN_SIZE) { $env:HINDSIGHT_API_DB_POOL_MIN_SIZE = '2' }
if (-not $env:HINDSIGHT_API_DB_POOL_MAX_SIZE) { $env:HINDSIGHT_API_DB_POOL_MAX_SIZE = '6' }
if (-not $env:HINDSIGHT_API_READ_DB_POOL_MIN_SIZE) { $env:HINDSIGHT_API_READ_DB_POOL_MIN_SIZE = '1' }
if (-not $env:HINDSIGHT_API_READ_DB_POOL_MAX_SIZE) { $env:HINDSIGHT_API_READ_DB_POOL_MAX_SIZE = '4' }
if (-not $env:HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER) { $env:HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER = '0' }

# The watchdog drops connections whose PGroonga failed to initialize; the pool reconnects (scripts/hindsight-watchdog.mjs).
$watchdogLog = Join-Path $root 'watchdog.log'
$watchdog = Start-Process -FilePath 'node' -WindowStyle Hidden -PassThru `
    -ArgumentList @("`"$(Join-Path $PSScriptRoot 'hindsight-watchdog.mjs')`"", "`"$(Join-Path $pgData 'log')`"") `
    -RedirectStandardOutput $watchdogLog -RedirectStandardError "$watchdogLog.err"

try {
    & $api
    $exitCode = $LASTEXITCODE
} finally {
    Stop-Process -Id $watchdog.Id -ErrorAction SilentlyContinue
    & $pg0 stop --name $instance
}
exit $exitCode
