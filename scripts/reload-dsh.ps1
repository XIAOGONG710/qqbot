# Reload the DSH desktop app so plugin changes take effect.
#
# Why a full restart: the qqbot services plugin registers one prefix route
# (/api/qqbot-services) on the host web server. That registration cannot be
# undone at runtime, so disabling and re-enabling the plugin fails with
# "webserver: duplicate prefix route". Only a fresh host process can load new
# plugin code, and the GUI listens on a new port afterwards.
#
# Usage (any shell, no detaching needed):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reload-dsh.ps1
#
# The script re-launches itself through Win32_Process and returns immediately,
# so the restart survives the caller and the app being killed. Pass -Detached
# to skip that step (the script then stops the app in the current process tree,
# which also kills itself when started from inside DSH).
#
# Afterwards read the log and run:
#   node --import tsx scripts/dsh-panel-live-check.mjs

param(
  [string]$Log = (Join-Path $PSScriptRoot '..\runtime\log\dsh-reload.log'),
  [int]$WaitBeforeKill = 10,
  [int]$WaitForStart = 45,
  [switch]$Detached
)

New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null

function Note($m) {
  "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $m" | Add-Content -Path $Log -Encoding utf8
}

if (-not $Detached) {
  $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' +
    $PSCommandPath + '" -Detached -WaitBeforeKill ' + $WaitBeforeKill +
    ' -WaitForStart ' + $WaitForStart + ' -Log "' + $Log + '"'
  $started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command }
  Note "reload script detached pid=$($started.ProcessId) wait=${WaitBeforeKill}s"
  return
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

# The GUI picks a new loopback port on every start, so record what is listening
# instead of probing remembered ports.
$listening = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
  Select-Object -ExpandProperty LocalPort -Unique | Sort-Object)
Note "loopback ports listening: $($listening -join ',')"

Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -notlike '*--type=*' } |
  ForEach-Object { Note "pid=$($_.ProcessId) created=$($_.CreationDate)" }

Note 'reload script done'
