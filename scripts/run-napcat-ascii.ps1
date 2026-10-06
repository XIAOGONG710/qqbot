# ASCII ONLY on purpose (powershell -File reads non-BOM UTF-8 as ANSI, which nulls
# variables; and the whole point of this script is to keep non-ASCII characters
# out of the native code's paths).
#
# WHY THIS EXISTS (root cause, 2026-10-03 12:34, measured):
#   QQ's native core (wrapper.node) mis-handles non-ASCII characters in its own
#   paths. Running NapCat from a workspace whose name ends with two CJK characters
#   made the core's init chain break in native code:
#       [PATCH] startNT(0) failed: TypeError: t.startNT is not a function
#       [PATCH] dataPath native call failed: Error: Invalid argument
#       [AdapterManager] OneBot11 adapter init failed: addKernelMsgListener undefined
#   -> no message listener -> the RECEIVE direction was dead, while the worker
#   still reported "login ok" (login is not the core).
#   The same install, copied to a pure-ASCII path (C:\napcat-ascii) and started
#   there, attaches the kernel fine.
#
# MOVED 2026-10-06: this launcher used to live inside the old Python project.
# It now lives in the qqbot repo and reads its credentials from the ASCII runtime
# itself, so it no longer depends on any workspace path:
#     C:\napcat-ascii\data\napcat_cred.txt   (QQ_ACCOUNT=... / QQ_PASSWORD=...)
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-napcat-ascii.ps1

param(
    [string]$Runtime = 'C:\napcat-ascii'
)

$ErrorActionPreference = 'Stop'

$node = Join-Path $Runtime 'node.exe'
$entry = Join-Path $Runtime 'index_pipe.js'
if (-not (Test-Path $node)) { throw "node.exe not found at $node" }
if (-not (Test-Path $entry)) { throw "index_pipe.js not found at $entry" }

# NapCat writes to %TEMP%: keep it inside the ASCII runtime.
$tmp = Join-Path $Runtime 'tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TEMP = $tmp
$env:TMP = $tmp

# Quick login (needs one prior successful login) + password fallback.
$credFile = Join-Path $Runtime 'data\napcat_cred.txt'
if (Test-Path $credFile) {
    foreach ($line in Get-Content $credFile -Encoding UTF8) {
        if ($line -match '^\s*QQ_ACCOUNT\s*=\s*(\S+)')  { $env:NAPCAT_QUICK_ACCOUNT = $Matches[1] }
        if ($line -match '^\s*QQ_PASSWORD\s*=\s*(\S+)') { $env:NAPCAT_QUICK_PASSWORD = $Matches[1] }
    }
}

$proc = Start-Process -FilePath $node -ArgumentList 'index_pipe.js' `
    -WorkingDirectory $Runtime `
    -RedirectStandardOutput (Join-Path $Runtime 'napcat_ascii.log') `
    -RedirectStandardError (Join-Path $Runtime 'napcat_ascii.err.log') `
    -WindowStyle Hidden -PassThru

Write-Output ("napcat(ascii) started pid=" + $proc.Id + " runtime=" + $Runtime)
