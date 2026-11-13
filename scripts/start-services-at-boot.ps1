# Start the whole qqbot stack after a reboot WITHOUT a desktop session (docs/boot-start.md).
# Meant to be run by the scheduled task that scripts/install-services-tasks.ps1 registers, but it is safe to run by hand:
# every step first checks whether that service is already up and only starts what is missing.
# (ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# Order (same as the manual go-live procedure): NapCat -> Hindsight -> Koishi -> services watchdog (kept in the foreground).
# Why the watchdog stays in the foreground: the Task Scheduler runs the action inside a job object, and the services started
# from it live as long as the task does. The watchdog (scripts/services-watchdog.mjs) is a long-running process anyway.
#
#   -DryRun   only print what would be done (checks ports / processes, starts nothing). Use this to review before installing.
#
# Born from 2026-10-15: Windows Update rebooted the VM at 03:29 and 03:33 and nothing came back until the user logged in
# over Remote Desktop at 09:25 - she was offline for six hours.
param(
    [switch]$DryRun,
    # Hindsight verifies the model API with a real call at startup and EXITS when that fails (10-15: DeepSeek was queueing,
    # the verification timed out for minutes and the process quit). After a reboot the network may not be ready either, so the
    # boot script skips that self-check; model errors still show up when the memory is used. Pass -SkipHindsightLlmCheck:$false to keep it.
    [bool]$SkipHindsightLlmCheck = $true,
    [int]$NetworkWaitSeconds = 180
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$bootDir = Join-Path $repoRoot 'runtime\boot'
New-Item -ItemType Directory -Force -Path $bootDir | Out-Null
$bootLog = Join-Path $bootDir 'boot.log'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say([string]$message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy/MM/dd HH:mm:ss'), $message
    Write-Host $line
    Add-Content -Path $bootLog -Value $line -Encoding UTF8
}

function Test-Port([int]$port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Test-Url([string]$url) {
    try { (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3).StatusCode -eq 200 } catch { $false }
}

function Wait-Until([scriptblock]$check, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (& $check) { return $true }
        Start-Sleep -Seconds 3
    }
    return [bool](& $check)
}

function Find-Processes([string]$name, [string]$pattern) {
    @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match $pattern })
}

# Start a repo script in a hidden PowerShell with its output in runtime\boot (a hidden window has nowhere else to print).
function Start-Hidden([string]$script, [string]$label) {
    $out = Join-Path $bootDir "$label-$stamp.out"
    $err = Join-Path $bootDir "$label-$stamp.err"
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $repoRoot `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $repoRoot "scripts\$script"))) `
        -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
}

$mode = if ($DryRun) { ' [dry run: nothing will be started]' } else { '' }
Say "boot start begins$mode (repo $repoRoot, user $env:USERNAME)"

# Node runs the TypeScript source straight from the working tree, so whatever is checked out here is what a start deploys.
# Record it (informational, never blocks: availability after an outage matters more) so a wrong checkout can be traced.
try {
    $gitRef = (& git -C $repoRoot rev-parse --short HEAD).Trim()
    $gitBranch = (& git -C $repoRoot branch --show-current).Trim()
    $gitDirty = if (& git -C $repoRoot -c submodule.recurse=false status --porcelain --ignore-submodules=all) { 'DIRTY' } else { 'clean' }
    Say ("working tree: branch {0} at {1}, {2}" -f $(if ($gitBranch) { $gitBranch } else { 'detached' }), $gitRef, $gitDirty)
} catch { Say 'working tree: could not read git state' }

# 1. Maintenance flag: somebody is doing a manual go-live / restart. A fresh flag means hands off; an old one is a leftover.
$flag = Join-Path $env:TEMP 'qqbot-maintenance'
if (Test-Path $flag) {
    $age = (Get-Date) - (Get-Item $flag).LastWriteTime
    if ($age.TotalHours -lt 2) {
        Say ("maintenance flag {0} is only {1} min old - leaving everything to the person doing maintenance, exiting" -f $flag, [int]$age.TotalMinutes)
        exit 0
    }
    Say ("maintenance flag {0} is {1} h old - treating it as a leftover" -f $flag, [int]$age.TotalHours)
    if (-not $DryRun) { Remove-Item $flag -Recurse -Force -ErrorAction SilentlyContinue }
}

# 2. Network: right after a boot the adapter and DNS can need a minute. Waiting is best effort; the services retry on their own.
$resolve = { try { [bool][System.Net.Dns]::GetHostAddresses('api.deepseek.com') } catch { $false } }
if ($DryRun) {
    Say ("network: api.deepseek.com resolves = {0}" -f (& $resolve))
} elseif (Wait-Until $resolve $NetworkWaitSeconds) {
    Say 'network: api.deepseek.com resolves'
} else {
    Say "network: api.deepseek.com did not resolve within $NetworkWaitSeconds s - starting anyway, the services and the watchdog keep retrying"
}

# 3. NapCat (QQ). start-napcat.ps1 restarts NapCat by itself when it exits and logs in with the saved session (QQBOT_NAPCAT_QQ).
if (Test-Port 3001) {
    Say 'NapCat: port 3001 is already listening - leaving it'
} elseif ($DryRun) {
    Say 'NapCat: would start scripts\start-napcat.ps1 and wait up to 120 s for port 3001'
} else {
    Say 'NapCat: starting scripts\start-napcat.ps1'
    Start-Hidden 'start-napcat.ps1' 'napcat'
    if (Wait-Until { Test-Port 3001 } 120) { Say 'NapCat: port 3001 is listening' } else { Say 'NapCat: port 3001 not listening after 120 s - continuing, the watchdog will retry (a QR login may be needed: check runtime\napcat\workdir\cache)' }
}

# 4. Hindsight (long-term memory): /health on 8899 (8888 is Anaconda Jupyter on this machine, docs/hindsight.md).
if (Test-Url 'http://127.0.0.1:8899/health') {
    Say 'Hindsight: /health is already ok - leaving it'
} elseif ($DryRun) {
    Say ("Hindsight: would start scripts\start-hindsight.ps1 (skip LLM startup check = {0}) and wait up to 300 s for /health" -f $SkipHindsightLlmCheck)
} else {
    Say ("Hindsight: starting scripts\start-hindsight.ps1 (skip LLM startup check = {0})" -f $SkipHindsightLlmCheck)
    # process-scope only, and removed again right after the child has inherited it
    if ($SkipHindsightLlmCheck) { $env:HINDSIGHT_API_SKIP_LLM_VERIFICATION = 'true' }
    try { Start-Hidden 'start-hindsight.ps1' 'hindsight' } finally { Remove-Item Env:\HINDSIGHT_API_SKIP_LLM_VERIFICATION -ErrorAction SilentlyContinue }
    if (Wait-Until { Test-Url 'http://127.0.0.1:8899/health' } 300) { Say 'Hindsight: /health ok' } else { Say 'Hindsight: /health not ok after 300 s - continuing without waiting, the watchdog will retry' }
}

# 5. Koishi (the bot itself).
$koishi = @(Find-Processes 'node.exe' 'koishi[\\/]+bin\.js')
if ($koishi.Count -gt 0) {
    Say ("Koishi: already running (pid {0}) - leaving it" -f (($koishi | ForEach-Object { $_.ProcessId }) -join ','))
} elseif ($DryRun) {
    Say 'Koishi: would start scripts\start-koishi.ps1'
} else {
    Say 'Koishi: starting scripts\start-koishi.ps1'
    Start-Hidden 'start-koishi.ps1' 'koishi'
    if (Wait-Until { @(Find-Processes 'node.exe' 'koishi[\\/]+bin\.js').Count -gt 0 } 60) { Say 'Koishi: process is up' } else { Say 'Koishi: no process after 60 s - see runtime\koishi\start-koishi.log and the koishi-*.err file in runtime\boot' }
}

# 5b. Observers (read-only, cheap): the heartbeat watcher (writes runtime\bot-shadow\ALERT.txt when the bot goes quiet) and the network probe
#     (one line per 30 s in %TEMP%\qqbot-net-probe\probe.log; on 2026-10-16 it is what showed a 20 h outage was not DNS). They died with the
#     reset on 2026-10-17 and nothing brought them back. Start them only once Koishi's heartbeat is fresh, otherwise the watcher would
#     see the hours-old heartbeat from before the reboot and raise a false alert.
#     The data dir is runtime\bot-shadow (koishi.yml dataDir); the old runtime\bot path has no heartbeat since 11-12.
$heartbeatFile = Join-Path $repoRoot 'runtime\bot-shadow\heartbeat.json'
$heartbeatFresh = { (Test-Path $heartbeatFile) -and (((Get-Date) - (Get-Item $heartbeatFile).LastWriteTime).TotalMinutes -lt 3) }
if ($DryRun) {
    Say ("observers: heartbeat is fresh = {0}" -f [bool](& $heartbeatFresh))
} elseif (Wait-Until $heartbeatFresh 150) {
    Say 'observers: heartbeat is fresh'
} else {
    Say 'observers: heartbeat not fresh after 150 s - starting the observers anyway (the watcher may alert until Koishi writes it)'
}
foreach ($observer in @(
        @{ Label = 'heartbeat watcher'; Pattern = 'heartbeat-watch-cli\.ts'; Script = 'packages\bot\src\ops\heartbeat-watch-cli.ts'; Args = @('--dir', 'runtime\bot-shadow') },
        @{ Label = 'network probe'; Pattern = 'net-probe\.ts'; Script = 'scripts\net-probe.ts'; Args = @() })) {
    $running = @(Find-Processes 'node.exe' $observer.Pattern)
    if ($running.Count -gt 0) {
        Say ("{0}: already running (pid {1}) - leaving it" -f $observer.Label, (($running | ForEach-Object { $_.ProcessId }) -join ','))
    } elseif (-not (Test-Path (Join-Path $repoRoot $observer.Script))) {
        Say ("{0}: {1} is missing - skipping" -f $observer.Label, $observer.Script)
    } elseif ($DryRun) {
        Say ("{0}: would start node {1} hidden" -f $observer.Label, $observer.Script)
    } else {
        $argList = @(('"{0}"' -f (Join-Path $repoRoot $observer.Script))) + @($observer.Args | ForEach-Object { '"{0}"' -f $_ })
        Start-Process -FilePath 'node' -ArgumentList $argList -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
        Say ("{0}: started" -f $observer.Label)
    }
}

# 6. Watchdog: kept in the foreground so the task (and the job object around the services above) stays alive.
$watchdog = @(Find-Processes 'node.exe' 'services-watchdog\.mjs')
if ($watchdog.Count -gt 0) {
    Say ("watchdog: already running (pid {0}) - nothing more to do" -f (($watchdog | ForEach-Object { $_.ProcessId }) -join ','))
    exit 0
}
if ($DryRun) {
    Say 'watchdog: would run node scripts\services-watchdog.mjs in the foreground'
    exit 0
}
Say 'watchdog: running node scripts\services-watchdog.mjs in the foreground (this task stays alive as long as it runs)'
# Start-Process -Wait keeps the redirected output byte for byte (the watchdog also writes its own runtime\services-watchdog.log)
$watchdogScript = Join-Path $repoRoot 'scripts\services-watchdog.mjs'
$process = Start-Process -FilePath 'node' -ArgumentList @("`"$watchdogScript`"") -WorkingDirectory $repoRoot -WindowStyle Hidden -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $bootDir "watchdog-$stamp.out") -RedirectStandardError (Join-Path $bootDir "watchdog-$stamp.err")
Say ("watchdog exited with code {0}" -f $process.ExitCode)
exit $process.ExitCode
