# 启动常驻的她（独立进程；由 HKCU Run 或手动调用）
# 仓库 = 这个脚本所在目录的上一级；常驻目录默认 ~/.dsh/her（HER_DIR 可以改，和 her-resident.mjs 一致）
$repo = Split-Path -Parent $PSScriptRoot
$dir = if ($env:HER_DIR) { $env:HER_DIR } else { Join-Path $env:USERPROFILE '.dsh\her' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$value = [Environment]::GetEnvironmentVariable('QQBOT_LLM_API_KEY', 'User')
if ($value) { $env:QQBOT_LLM_API_KEY = $value }
Set-Location $repo
node .\scripts\her-resident.mjs *>> (Join-Path $dir 'stdout.log')
