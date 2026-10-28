# 启动常驻的她（独立进程；由 HKCU Run 或手动调用）
$repo = 'C:\Users\22601\Desktop\qqbot-dsh-control'
$dir = 'C:\Users\22601\.dsh\her'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$value = [Environment]::GetEnvironmentVariable('QQBOT_LLM_API_KEY', 'User')
if ($value) { $env:QQBOT_LLM_API_KEY = $value }
Set-Location $repo
node .\scripts\her-resident.mjs *>> (Join-Path $dir 'stdout.log')
