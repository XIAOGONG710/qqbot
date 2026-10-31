# 常驻的她（7777）看门狗：端口没在听就把她拉起来。
$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\22601\Desktop\qqbot-dsh-control'
$log = Join-Path $env:LOCALAPPDATA 'qqbot\resident-watchdog.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Write-Log($line) {
    Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $line) -ErrorAction SilentlyContinue
}

if (Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue) { exit 0 }

$lock = Join-Path $env:USERPROFILE '.dsh\her\resident.pid'
if (Test-Path $lock) {
    $pidNum = 0
    if ([int]::TryParse((Get-Content $lock -Raw).Trim(), [ref]$pidNum) -and (Get-Process -Id $pidNum -ErrorAction SilentlyContinue)) {
        Stop-Process -Id $pidNum -Force -ErrorAction SilentlyContinue
        Write-Log "killed stale resident pid=$pidNum"
    }
}

$env:QQBOT_LLM_API_KEY = [Environment]::GetEnvironmentVariable('QQBOT_LLM_API_KEY', 'User')
Start-Process -FilePath 'node' -ArgumentList 'scripts\her-resident.mjs' -WorkingDirectory $repo -WindowStyle Hidden
Start-Sleep -Seconds 8
if (Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue) {
    Write-Log 'resident started by watchdog'
} else {
    Write-Log 'resident FAILED to start'
    exit 1
}
