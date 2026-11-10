# Restart the QQ bot (Koishi) cleanly: one instance, no stale lock, no orphan.
#
# Why this exists (2026-10-30): the old way was "kill whatever listens on 5140, then start".
# When a previous start had already failed (lock held by another process), the listener and the
# lock owner could be two different processes: the kill took the listener, the lock owner kept
# running with old code, and every later "restart" silently did nothing. Instance kept serving
# 00:40 code for 14 hours while the source tree had moved on.
#
# Order: kill lock owner -> kill listener on 5140 -> drop lock -> start once -> verify the new
# process actually owns the lock and is not the one that logs "插件没有启动".
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$lock = Join-Path $repo 'runtime\bot-shadow\bot.lock'
$instance = Join-Path $repo 'runtime\koishi'
$botLog = Join-Path $repo 'runtime\bot-shadow\logs\{0}.log' -f (Get-Date -Format 'yyyy-MM-dd')

function Get-LockOwner {
    if (-not (Test-Path $lock)) { return $null }
    $raw = (Get-Content $lock -Raw).Trim()
    $pidNum = 0
    if ([int]::TryParse($raw, [ref]$pidNum) -and $pidNum -gt 0) { return $pidNum }
    return $null
}

$owner = Get-LockOwner
if ($owner) {
    $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($proc) { Stop-Process -Id $owner -Force; "stopped lock owner $owner" }
    else { "lock owner $owner already gone" }
}

$listeners = Get-NetTCPConnection -LocalPort 5140 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($pidNum in $listeners) {
    if ($pidNum -and (Get-Process -Id $pidNum -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $pidNum -Force; "stopped listener $pidNum"
    }
}

Start-Sleep -Seconds 3
Remove-Item $lock -Force -ErrorAction SilentlyContinue

$before = 0
if (Test-Path $botLog) { $before = (Get-Content $botLog).Count }

Start-Process -FilePath pwsh -ArgumentList '-NoProfile', '-File', (Join-Path $repo 'scripts\start-koishi.ps1') -WindowStyle Hidden
Start-Sleep -Seconds 30

$listening = Get-NetTCPConnection -LocalPort 5140 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) { "FAILED: nothing listening on 5140"; exit 1 }

$tail = @()
if (Test-Path $botLog) { $tail = (Get-Content $botLog | Select-Object -Skip $before) }
$failed = $tail | Where-Object { $_ -match '插件没有启动|已有一个 bot 在运行' }
if ($failed) {
    "FAILED: the new instance did not start:"
    $failed | Select-Object -First 3
    exit 1
}

$newOwner = Get-LockOwner
"OK: listening on 5140, lock owner = $newOwner"
$tail | Where-Object { $_ -match '真人例子|自己总结说话习惯|梗百科' } | Select-Object -First 5
