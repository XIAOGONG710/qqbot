# 让她暂时走免费线路（2026-10-31 用户：「能把她的回复暂时换成这个免费的吗」）
#
# 做法：把主线路指到 ginka，官方线路配成 fallback——
# 免费组 12:00–14:00 / 23:30 之后关着，那几段时间会自动退回官方，她不会哑掉。
# 恢复：跑 scripts\restart-koishi.ps1（不带这个脚本）就回到官方线路。
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $repoRoot 'runtime\bot-shadow\secrets\ginka.json'
if (-not (Test-Path $secretPath)) { throw "找不到 ginka 密钥：$secretPath" }
$ginka = Get-Content $secretPath -Raw | ConvertFrom-Json

# 官方线路的 key 从用户变量取（start-koishi.ps1 默认也是这么取的），配成 fallback
$officialKey = [Environment]::GetEnvironmentVariable('QQBOT_LLM_API_KEY', 'User')
if (-not $officialKey) { throw '用户环境变量里没有 QQBOT_LLM_API_KEY（官方线路的 key），没法配 fallback' }

# 先探一下窗口开没开：关着就别切，浪费一次重启
try {
    $probe = Invoke-WebRequest -Uri "$($ginka.baseUrl)/v1/chat/completions" -Method Post -TimeoutSec 20 `
        -Headers @{ Authorization = "Bearer $($ginka.apiKey)" } -ContentType 'application/json' `
        -Body (@{ model = 'deepseek-v4-flash'; max_tokens = 4; messages = @(@{ role = 'user'; content = 'hi' }) } | ConvertTo-Json -Depth 5)
} catch {
    Write-Host "免费组现在关着（$($_.Exception.Message)），先不切。仍走官方线路。"
    exit 1
}

$env:QQBOT_KEEP_PROCESS_ENV = '1'
$env:QQBOT_LLM_BASE_URL = $ginka.baseUrl
$env:QQBOT_LLM_MODEL = 'deepseek-v4-flash'
$env:QQBOT_LLM_API_KEY = $ginka.apiKey
$env:QQBOT_LLM_FALLBACK_BASE_URL = 'https://api.deepseek.com'
$env:QQBOT_LLM_FALLBACK_MODEL = 'deepseek-flash'
$env:QQBOT_LLM_FALLBACK_API_KEY = $officialKey

Write-Host "切到免费线路：$($ginka.baseUrl) / deepseek-v4-flash（关窗时自动退回官方）"
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'restart-koishi.ps1')
