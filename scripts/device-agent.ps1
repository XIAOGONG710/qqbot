<#
  device-agent.ps1 -- runs on the HOST computer (Windows PowerShell 5.1+), ADR 0148.

  It makes OUTBOUND connections only: it long-polls the bot's "device hub" for jobs and posts results back.
  It opens no listening port. Every job is validated AGAIN here against device-agent.config.json, which only
  the owner of this computer controls -- the host is always the final authority.

  Whitelisted actions: notify, timer, media, volume, open_url, open_app, lock, sleep, capture_screen, capture_camera.
  There is no "run command", no file access, no keyboard/mouse input, no install/delete, no payments. Parameters are never
  put into a shell command line; text for toasts goes through XML InnerText / base64.

  Stop it: Ctrl+C, or create a file named device-agent.stop next to this script, or set "enabled": false in the config.
  Log: device-agent.log next to this script (time, action, ok/error -- never the content).
  Keep this file ASCII-only (Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM). Names and messages that
  contain Chinese live in the JSON config, which is read as UTF-8.
#>
param(
    [string]$Config = (Join-Path $PSScriptRoot 'device-agent.config.json'),
    [int]$MaxJobs = 0   # 0 = run until stopped; a positive number is for tests
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $Config | ConvertFrom-Json
if ($cfg.PSObject.Properties.Name -contains 'enabled' -and -not $cfg.enabled) { Write-Host 'disabled in config'; exit 0 }
$hub = ([string]$cfg.hub).TrimEnd('/')
$headers = @{ Authorization = "Bearer $($cfg.token)" }
$logFile = Join-Path $PSScriptRoot 'device-agent.log'
$stopFile = Join-Path $PSScriptRoot 'device-agent.stop'
$maxVolume = if ($cfg.PSObject.Properties.Name -contains 'maxVolume') { [int]$cfg.maxVolume } else { 60 }

function Write-Log([string]$message) {
    Add-Content -LiteralPath $logFile -Value ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message) -Encoding UTF8
}
function Test-Allowed([string]$action) {
    # default deny: only the actions explicitly set to true in "allow" may run
    return ($cfg.PSObject.Properties.Name -contains 'allow') -and ($cfg.allow.PSObject.Properties.Name -contains $action) -and ($cfg.allow.$action -eq $true)
}
function Get-Prop($object, [string]$name) {
    if ($null -ne $object -and $object.PSObject.Properties.Name -contains $name) { return $object.$name }
    return $null
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Native -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'
function Send-Key([byte]$vk) { [Native.Keys]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); [Native.Keys]::keybd_event($vk, 0, 2, [UIntPtr]::Zero) }

# The toast code is also run inside a detached process for timers, so keep it as text.
$toastCode = @'
function Show-Toast([string]$title, [string]$text) {
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text/><text/></binding></visual></toast>")
        $nodes = $xml.GetElementsByTagName('text')
        $nodes.Item(0).InnerText = $title
        $nodes.Item(1).InnerText = $text
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    } catch {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Information
        $icon.BalloonTipTitle = $title
        $icon.BalloonTipText = $text
        $icon.Visible = $true
        $icon.ShowBalloonTip(8000)
        Start-Sleep -Seconds 9
        $icon.Dispose()
    }
}
'@
Invoke-Expression $toastCode   # fixed text defined above, never job data

function ConvertTo-B64([string]$text) { return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }
$titleText = if ($null -ne (Get-Prop $cfg 'title')) { [string]$cfg.title } else { 'Assistant' }

function Start-DelayedToast([int]$seconds, [string]$title, [string]$text) {
    $script = "Start-Sleep -Seconds $seconds`n" + $toastCode + "`n" +
        "`$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(ConvertTo-B64 $title)'))`n" +
        "`$m = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(ConvertTo-B64 $text)'))`n" +
        'Show-Toast $t $m'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile', '-EncodedCommand', $encoded | Out-Null
}

function Test-Text([object]$value, [int]$max) {
    return ($value -is [string]) -and $value.Length -ge 1 -and $value.Length -le $max -and ($value -notmatch '[\x00-\x1f<>]')
}

function Get-ScreenPng {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $g.Dispose()
    $width = [Math]::Min(1280, $bounds.Width)
    $height = [int][Math]::Round($bounds.Height * $width / $bounds.Width)
    $small = New-Object System.Drawing.Bitmap $bmp, $width, $height
    $bmp.Dispose()
    $stream = New-Object System.IO.MemoryStream
    $small.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $small.Dispose()
    $bytes = $stream.ToArray()
    $stream.Dispose()
    return $bytes
}

function Get-CameraJpeg {
    $ffmpeg = [string](Get-Prop $cfg 'ffmpeg'); $camera = [string](Get-Prop $cfg 'cameraName')
    if (-not $ffmpeg -or -not $camera -or -not (Test-Path -LiteralPath $ffmpeg)) { throw 'camera is not configured (ffmpeg / cameraName)' }
    $out = Join-Path ([IO.Path]::GetTempPath()) ("device-agent-{0}.jpg" -f [guid]::NewGuid().ToString('N'))
    try {
        & $ffmpeg '-loglevel' 'error' '-f' 'dshow' '-i' "video=$camera" '-frames:v' '1' '-vf' 'scale=1280:-2' '-y' $out | Out-Null
        if (-not (Test-Path -LiteralPath $out)) { throw 'camera capture failed' }
        return [IO.File]::ReadAllBytes($out)
    } finally { Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue }
}

function Invoke-Job($job) {
    $action = [string]$job.action
    $p = $job.params
    if (-not (Test-Allowed $action)) { throw "action not allowed on this computer: $action" }
    switch ($action) {
        'notify' {
            if (-not (Test-Text (Get-Prop $p 'text') 60)) { throw 'bad text' }
            Show-Toast $titleText ([string]$p.text)
        }
        'timer' {
            $seconds = Get-Prop $p 'seconds'
            if (-not ($seconds -is [int] -or $seconds -is [long]) -or $seconds -lt 10 -or $seconds -gt 86400 -or -not (Test-Text (Get-Prop $p 'label') 30)) { throw 'bad timer' }
            Start-DelayedToast ([int]$seconds) $titleText ([string]$p.label)
        }
        'media' {
            $keys = @{ play_pause = 0xB3; next = 0xB0; prev = 0xB1 }
            $op = [string](Get-Prop $p 'op')
            if (-not $keys.ContainsKey($op)) { throw 'bad media op' }
            Send-Key ([byte]$keys[$op])
        }
        'volume' {
            $op = [string](Get-Prop $p 'op')
            switch ($op) {
                'up' { Send-Key 0xAF }
                'down' { Send-Key 0xAE }
                'mute' { Send-Key 0xAD }
                'set' {
                    $level = Get-Prop $p 'level'
                    if (-not ($level -is [int] -or $level -is [long]) -or $level -lt 0 -or $level -gt $maxVolume) { throw 'bad volume level' }
                    1..50 | ForEach-Object { Send-Key 0xAE }
                    1..([int][Math]::Round($level / 2)) | ForEach-Object { Send-Key 0xAF }
                }
                default { throw 'bad volume op' }
            }
        }
        'open_url' {
            $name = [string](Get-Prop $p 'name')
            $url = [string](Get-Prop (Get-Prop $cfg 'links') $name)
            if (-not $url -or $url -notmatch '^https://') { throw 'link is not registered on this computer' }
            Start-Process -FilePath $url | Out-Null
        }
        'open_app' {
            $name = [string](Get-Prop $p 'name')
            $path = [string](Get-Prop (Get-Prop $cfg 'apps') $name)
            if (-not $path -or -not (Test-Path -LiteralPath $path)) { throw 'app is not registered on this computer' }
            Start-Process -FilePath $path | Out-Null
        }
        'lock' { & rundll32.exe user32.dll,LockWorkStation }
        'sleep' { & rundll32.exe powrprof.dll,SetSuspendState 0,1,0 }
        'capture_screen' {
            if ($null -ne (Get-Prop $cfg 'announceText')) { Show-Toast $titleText ([string]$cfg.announceText) }
            return @{ mime = 'image/png'; bytes = (Get-ScreenPng) }
        }
        'capture_camera' {
            if ($null -ne (Get-Prop $cfg 'announceText')) { Show-Toast $titleText ([string]$cfg.announceText) }
            return @{ mime = 'image/jpeg'; bytes = (Get-CameraJpeg) }
        }
        default { throw "unknown action: $action" }
    }
    return $null
}

function Send-Result([string]$id, [bool]$ok, [string]$err, $image) {
    $body = @{ id = $id; ok = $ok }
    if ($err) { $body.error = $err }
    if ($image) { $body.mime = $image.mime; $body.imageBase64 = [Convert]::ToBase64String($image.bytes) }
    $json = $body | ConvertTo-Json -Compress -Depth 4
    Invoke-RestMethod -Method Post -Uri "$hub/result" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 30 | Out-Null
}

Write-Log "agent started, hub $hub"
$handled = 0
$backoff = 5
while ($true) {
    if (Test-Path -LiteralPath $stopFile) { Write-Log 'stop file found, exiting'; break }
    try {
        $job = Invoke-RestMethod -Uri "$hub/poll?wait=25" -Headers $headers -TimeoutSec 40
        $backoff = 5
    } catch {
        Write-Log ("poll failed: {0}" -f $_.Exception.Message)
        Start-Sleep -Seconds $backoff
        $backoff = [Math]::Min($backoff * 2, 60)
        continue
    }
    if ($null -eq $job -or -not ($job.PSObject.Properties.Name -contains 'id')) { continue }
    $id = [string]$job.id
    try {
        $image = Invoke-Job $job
        Write-Log ("ok {0}" -f $job.action)
        Send-Result $id $true '' $image
    } catch {
        $message = $_.Exception.Message
        if ($message.Length -gt 100) { $message = $message.Substring(0, 100) }
        Write-Log ("error {0}: {1}" -f $job.action, $message)
        try { Send-Result $id $false $message $null } catch { Write-Log 'could not report the error to the hub' }
    }
    $handled++
    if ($MaxJobs -gt 0 -and $handled -ge $MaxJobs) { break }
}
Write-Log 'agent stopped'
