# Start the Hindsight memory service (ADR 0004 decision 3) in this terminal. Stop it with Ctrl+C or by closing the window.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Set up once as described in docs/hindsight.md. Layout (all under runtime/hindsight/, not committed):
#   venv/       Python 3.12 venv with scripts/hindsight/requirements.txt installed (hindsight-api-slim, pg0, onnxruntime)
#   pgdata/     NOT used when the repo path has non-ASCII characters - see $pgData below.
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
# -d <repo>\runtime\hindsight\pgdata on a repo under Desktop\astrbot创建\. Override with QQBOT_PGDATA.
$instance = 'qqbot-hindsight'
$pgData = if ($env:QQBOT_PGDATA) { $env:QQBOT_PGDATA } else { Join-Path $env:LOCALAPPDATA 'qqbot-hindsight\pgdata' }
if ($pgData -match '[^\x00-\x7F]') {
    throw "QQBOT_PGDATA ('$pgData') contains non-ASCII characters; pg0 fails with 'stream did not contain valid UTF-8' (docs\hindsight.md)"
}
New-Item -ItemType Directory -Force -Path $pgData | Out-Null
$info = & $pg0 info --name $instance 2>&1 | Out-String
if ($info -notmatch 'is running') {
    & $pg0 start --name $instance --data-dir $pgData --port $DbPort -u hindsight -P hindsight -n hindsight
    if ($LASTEXITCODE -ne 0) { throw "pg0 start failed (exit $LASTEXITCODE)" }
}

$env:HF_HOME = Join-Path $root 'hf'
$env:PYTHONUTF8 = '1'
$env:HINDSIGHT_API_HOST = '127.0.0.1'
$env:HINDSIGHT_API_PORT = "$Port"
$env:HINDSIGHT_API_DATABASE_URL = "postgresql://hindsight:hindsight@127.0.0.1:$DbPort/hindsight"
$env:HINDSIGHT_API_LLM_PROVIDER = 'deepseek'
$env:HINDSIGHT_API_LLM_API_KEY = $env:QQBOT_LLM_API_KEY
$env:HINDSIGHT_API_LLM_MODEL = $Model
$env:HINDSIGHT_API_LLM_EXTRA_BODY = '{"thinking":{"type":"disabled"}}'
$env:HINDSIGHT_API_EMBEDDINGS_PROVIDER = 'onnx'
$env:HINDSIGHT_API_RERANKER_PROVIDER = 'rrf'
# Keyword search with TokenBigram: the default (native, english tsvector) cannot split Chinese, so a nickname
# inside a sentence ("tie-guo jin-tian you...") never matched. Switching needs empty memory tables (docs/hindsight.md).
$env:HINDSIGHT_API_TEXT_SEARCH_EXTENSION = 'pgroonga'

try {
    & $api
    $exitCode = $LASTEXITCODE
} finally {
    & $pg0 stop --name $instance
}
exit $exitCode
