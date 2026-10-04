# Start the Hindsight memory service (ADR 0004 decision 3) in this terminal. Stop it with Ctrl+C or by closing the window.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Set up once as described in docs/hindsight.md. Layout (all under runtime/hindsight/, not committed):
#   venv/       Python 3.12 venv with scripts/hindsight/requirements.txt installed (hindsight-api-slim, pg0, onnxruntime)
#   pgdata/     PostgreSQL data of the pg0 instance "qqbot-hindsight", listening on 127.0.0.1:5433 only
#   hf/         Hugging Face cache for the embedding model (intfloat/multilingual-e5-small, ONNX)
#   vcruntime/  msvcp140*.dll 14.44 from Microsoft's VC++ redistributable; the system copy (14.36) is too old
#               for onnxruntime and the bundled PostgreSQL. Not needed once the latest VC++ redistributable is installed.
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

# A terminal opened before the variable was set does not have it yet; read it from the user scope.
if (-not $env:QQBOT_LLM_API_KEY) {
    $env:QQBOT_LLM_API_KEY = [Environment]::GetEnvironmentVariable('QQBOT_LLM_API_KEY', 'User')
}
if (-not $env:QQBOT_LLM_API_KEY) { throw 'QQBOT_LLM_API_KEY is not set (see packages\bot\README.md)' }

# With 'Stop', PowerShell 5.1 turns native stderr output into a terminating error.
$ErrorActionPreference = 'Continue'

# PostgreSQL (pg0): start the instance unless it is already running.
$instance = 'qqbot-hindsight'
$info = & $pg0 info --name $instance 2>&1 | Out-String
if ($info -notmatch 'is running') {
    & $pg0 start --name $instance --data-dir (Join-Path $root 'pgdata') --port $DbPort -u hindsight -P hindsight -n hindsight
    if ($LASTEXITCODE -ne 0) { throw "pg0 start failed (exit $LASTEXITCODE)" }
}

$env:QQBOT_VCRUNTIME_DIR = Join-Path $root 'vcruntime'
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

try {
    & $api
    $exitCode = $LASTEXITCODE
} finally {
    & $pg0 stop --name $instance
}
exit $exitCode
