# 手动起 Hindsight 并把输出留在文件里（2026-11-01：查为什么卡在启动）
# 用法：pwsh -NoProfile -File scripts/hindsight-debug.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repo 'runtime\hindsight'
$venv = Join-Path $root 'venv'
$api = Join-Path $venv 'Scripts\python.exe'
$out = Join-Path $root 'dbg.log'

$env:HINDSIGHT_API_LLM_API_KEY = [Environment]::GetEnvironmentVariable('QQBOT_LLM_API_KEY', 'User')
$env:HINDSIGHT_API_LLM_MODEL = 'deepseek-flash'
$env:HINDSIGHT_API_LLM_EXTRA_BODY = '{"thinking":{"type":"disabled"}}'
$env:HINDSIGHT_API_EMBEDDINGS_PROVIDER = 'onnx'
$env:HINDSIGHT_API_RERANKER_PROVIDER = 'rrf'
$env:HINDSIGHT_API_TEXT_SEARCH_EXTENSION = 'pgroonga'
$env:HINDSIGHT_API_DB_POOL_MIN_SIZE = '2'
$env:HINDSIGHT_API_DB_POOL_MAX_SIZE = '6'
$env:HINDSIGHT_API_READ_DB_POOL_MIN_SIZE = '1'
$env:HINDSIGHT_API_READ_DB_POOL_MAX_SIZE = '4'
$env:HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER = '0'
$env:HINDSIGHT_API_LOG_LEVEL = 'DEBUG'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:HINDSIGHT_API_MODEL_INIT_TIMEOUT = '90'

Set-Location $root
& $api -c 'from hindsight_api.main import main; main()' *> $out
