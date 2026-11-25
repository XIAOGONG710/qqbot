# Reload the DSH desktop app so plugin changes take effect.
#
# Why a full restart: the qqbot services plugin registers one prefix route
# (/api/qqbot-services) on the host web server. That registration cannot be
# undone at runtime, so disabling and re-enabling the plugin fails with
# "webserver: duplicate prefix route". Only a fresh host process can load new
# plugin code, and the GUI listens on a new port afterwards.
#
# Usage (any shell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reload-dsh.ps1
#
# The script detaches itself from the caller when started through
# Win32_Process, so it survives the app being killed:
#   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
#     CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "E:\qqbot-dsh-control\scripts\reload-dsh.ps1"'
#   }
#
# Afterwards run: node --import tsx scripts/dsh-panel-live-check.mjs

param(
  [string]$Log = (Join-Path $PSScriptRoot '..\runtime\log\dsh-reload.log'),
  [int]$WaitBeforeKill = 10,
  [int]$WaitForStart = 45
)

New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null

function Note($m) {
  "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $m" | Add-Content -Path $Log -Encoding utf8
}

Note 'reload script start'
Start-Sleep -Seconds $WaitBeforeKill

$mains = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*desktop-host*' -and $_.CommandLine -notlike '*runner.js*' })

foreach ($p in $mains) {
  Note "stopping main pid=$($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($mains.Count -eq 0) { Note 'no main process found' }

Start-Sleep -Seconds 8

$exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
Start-Process -FilePath $exe
Note 'app started'

Start-Sleep -Seconds $WaitForStart

$ports = 58842, 63264
foreach ($port in $ports) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5
    Note "web port=$port status=$($r.StatusCode)"
  } catch {
    Note "web port=$port error"
  }
}

Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -notlike '*--type=*' } |
  ForEach-Object { Note "pid=$($_.ProcessId) created=$($_.CreationDate)" }

Note 'reload script done'
