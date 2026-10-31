# 用免费的 ginka 网关起一个 DSH 会话（2026-10-31 用户：「现在能只用这个免费的吗」）
#
# 说明：正在跑的那个会话换不了线路（env 在启动时就定了）。这个脚本是**新开**一个：
# 把 ANTHROPIC_* 指到 ginka（它确实实现了 Anthropic 协议的 /v1/messages），模型用 v4 系列。
#
# 用法：
#   pwsh -File scripts\dsh-ginka.ps1                # 交互式（和现在这个一样）
#   pwsh -File scripts\dsh-ginka.ps1 -Model deepseek-v4-pro
#
# 注意两条硬事实：
#   1. 免费组 10:00–12:00 / 14:00–23:30 开放，其他时间 403——这个窗口外起会话会直接报错；
#   2. 这是"另一个会话"，不共享当前对话的上下文，只共享文件和 git。
param(
    [string]$Model = 'deepseek-v4-flash',
    [string]$Profile = 'lmy',
    [switch]$Check
)

$secretPath = Join-Path $env:USERPROFILE 'Desktop\qqbot-dsh-control\runtime\bot-shadow\secrets\ginka.json'
if (-not (Test-Path $secretPath)) { throw "找不到密钥：$secretPath" }
$secret = Get-Content $secretPath -Raw | ConvertFrom-Json
$base = $secret.baseUrl.TrimEnd('/')

if ($Check) {
    # 先探一下现在能不能用（窗口关着会 403）
    try {
        $r = Invoke-WebRequest -Uri "$base/v1/chat/completions" -Method Post -TimeoutSec 20 `
            -Headers @{ Authorization = "Bearer $($secret.apiKey)" } -ContentType 'application/json' `
            -Body (@{ model = $Model; max_tokens = 8; messages = @(@{ role = 'user'; content = 'hi' }) } | ConvertTo-Json -Depth 5)
        "可用：$($r.StatusCode)"
    } catch {
        "现在不可用（多半是免费组关着）：$($_.Exception.Message)"
    }
    return
}

$env:ANTHROPIC_BASE_URL = $base
$env:ANTHROPIC_AUTH_TOKEN = $secret.apiKey
$env:ANTHROPIC_API_KEY = $secret.apiKey
$env:ANTHROPIC_MODEL = $Model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $Model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $Model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $Model

"用 ginka 起会话：$base / $Model / profile=$Profile"
dsh --profile $Profile
