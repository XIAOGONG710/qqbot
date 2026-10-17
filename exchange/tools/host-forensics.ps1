# host-forensics.ps1 - READ-ONLY evidence collection, to be run ONCE on the VMware HOST (the physical machine that runs the qqbot VM).
# (ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.)
#
# It changes nothing: no setting, no service, no file except the one report it writes. It needs no administrator rights (a few items say so
# when they could not be read). It collects only: event-log lines inside fixed time windows, VMware log lines inside the same windows, the
# VMware services / adapters / routes, the NAMES (not command lines, not accounts) of VPN / proxy / accelerator style software, and power settings.
# No passwords, Wi-Fi names, MAC addresses, subscription links or file contents beyond the vmware.log lines described above.
#
# Run on the HOST in a normal PowerShell window:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\host-forensics.ps1
# It prints the path of the report (a .txt on the Desktop, usually 50-300 KB). Send that file back (copy/paste through the remote-desktop clipboard,
# or paste its text into the chat). Read it first if you like: everything in it is plain text.
#
# Why: on 2026-10-17 the VM was reset from outside at 02:46:03 (no bugcheck, no shutdown event) and its virtual NIC link flaps (disconnect, back after
# ~5 s) in bursts that grew from 1-8 a day to 31 (10-16) and 43 (10-17); on 10-16 05:31 -> 10-17 02:02 the VM could not open any NEW outside connection.
# The cause is on the host side (VMware virtual network, host sleep/power, VPN or proxy software, Hyper-V/WSL); the VM cannot see it.
param(
    [string]$OutDir = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = Join-Path $OutDir "host-forensics-$stamp.txt"
$lines = New-Object System.Collections.Generic.List[string]

function Add-Line([string]$text) { $lines.Add($text) | Out-Null }
function Section([string]$title, [scriptblock]$body) {
    Add-Line ''
    Add-Line ('=' * 8 + ' ' + $title)
    try {
        $out = & $body 2>&1 | Out-String -Width 220
        foreach ($l in ($out -split "`r?`n")) { if ($l.Trim()) { Add-Line $l.TrimEnd() } }
    } catch { Add-Line ("(could not read: {0})" -f $_.Exception.Message) }
}
function Short([string]$text, [int]$max = 190) {
    $t = ($text -replace '\s+', ' ').Trim()
    if ($t.Length -gt $max) { $t.Substring(0, $max) } else { $t }
}

# Windows (local time, the same clock as the VM). Each is: label, from, to.
$windows = @(
    @('10-16 05:25-05:40  outage starts', '2026-10-16 05:25', '2026-10-16 05:40'),
    @('10-16 08:40-08:47  NIC flaps', '2026-10-16 08:40', '2026-10-16 08:47'),
    @('10-16 10:24-10:35  NIC flaps', '2026-10-16 10:24', '2026-10-16 10:35'),
    @('10-17 01:55-02:10  outage ends', '2026-10-17 01:55', '2026-10-17 02:10'),
    @('10-17 02:40-02:50  VM reset 02:46:03', '2026-10-17 02:40', '2026-10-17 02:50'),
    @('10-17 02:55-03:10  VM boots 03:02', '2026-10-17 02:55', '2026-10-17 03:10'),
    @('10-17 19:45-19:56  NIC flaps', '2026-10-17 19:45', '2026-10-17 19:56'),
    @('10-17 20:40-20:52  NIC flaps', '2026-10-17 20:40', '2026-10-17 20:52')
)

Add-Line "host-forensics report, generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') on this machine (read-only collection)"

Section '1. This machine' {
    $cs = Get-CimInstance Win32_ComputerSystem
    $os = Get-CimInstance Win32_OperatingSystem
    "Manufacturer/Model : $($cs.Manufacturer) / $($cs.Model)"
    "OS                 : $($os.Caption) $($os.Version)"
    "Boot time          : $($os.LastBootUpTime)   (uptime $([int]((Get-Date) - $os.LastBootUpTime).TotalHours) h)"
    "HypervisorPresent  : $($cs.HypervisorPresent)   (True with VMware means Hyper-V/WSL2/VBS is active on the host, a known source of VMware network trouble)"
    "Time zone          : $((Get-TimeZone).Id)"
}

Section '2. Host start/stop/sleep events, last 5 days (System log)' {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 42, 105, 107, 506, 507, 1074, 6005, 6006, 6008; StartTime = (Get-Date).AddDays(-5) } -ErrorAction SilentlyContinue |
        Sort-Object TimeCreated | Select-Object -First 80 | ForEach-Object { "{0:MM-dd HH:mm:ss} {1,-34} id={2,-5} {3}" -f $_.TimeCreated, $_.ProviderName, $_.Id, (Short $_.Message 120) }
}

Section '3. VMware products, services and processes' {
    $exe = Get-Process -Name vmware -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe -and $exe.Path) { "vmware.exe : $($exe.Path)  version $((Get-Item $exe.Path).VersionInfo.ProductVersion)" } else { 'vmware.exe is not running (or its path could not be read)' }
    ''
    Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'VMware|VMnet|vmnat|vmnetdhcp|VMAuthd|VMUSB' -or $_.DisplayName -match 'VMware' } | Sort-Object Name | ForEach-Object { "service {0,-28} {1,-9} start={2}" -f $_.Name, $_.Status, $_.StartType }
    ''
    foreach ($n in 'vmnat', 'vmnetdhcp', 'vmware-vmx', 'vmware', 'vmware-authd') {
        Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { $t = try { $_.StartTime } catch { '(start time not readable without admin)' }; "process {0,-14} pid {1,-6} started {2}" -f $_.ProcessName, $_.Id, $t }
    }
}

# The running VM(s): find the .vmx path from the vmware-vmx command line (only the path is used).
$vmx = @()
try {
    $vmx = @(Get-CimInstance Win32_Process -Filter "Name='vmware-vmx.exe'" -ErrorAction Stop | ForEach-Object { if ($_.CommandLine -match '"([^"]+\.vmx)"') { $Matches[1] } } | Select-Object -Unique)
} catch { }

Section '4. The running VM: network adapter settings from its .vmx (only ethernet0.* and sizing lines are read)' {
    if (-not $vmx) { 'no running vmware-vmx found: run this while the VM is running, or the .vmx path could not be read' }
    foreach ($f in $vmx) {
        "vmx: $f"
        Get-Content -LiteralPath $f -ErrorAction SilentlyContinue | Where-Object { $_ -match '^(ethernet0\.|ethernet1\.|memsize|numvcpus|guestos|virtualhw\.version)' -and $_ -notmatch 'address|Address|uuid|UUID' } | ForEach-Object { "  $_" }
    }
}

Section '5. VMware log lines inside the windows (vmware.log and vmware-*.log next to the .vmx)' {
    if (-not $vmx) { 'no .vmx found, skipped' }
    $minutes = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($w in $windows) {
        $t = [datetime]$w[1]; $end = [datetime]$w[2]
        while ($t -le $end) { [void]$minutes.Add($t.ToString('yyyy-MM-ddTHH:mm')); $t = $t.AddMinutes(1) }
    }
    foreach ($f in $vmx) {
        $dir = Split-Path -Parent $f
        $logs = @(Get-ChildItem -LiteralPath $dir -Filter 'vmware*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 8)
        'log files (newest first):'
        $logs | ForEach-Object { "  {0}  {1:N0} KB  last written {2}" -f $_.Name, ($_.Length / 1KB), $_.LastWriteTime }
        foreach ($log in $logs) {
            ''
            "--- $($log.Name): header"
            [System.IO.File]::ReadLines($log.FullName) | Select-Object -First 80 | Where-Object { $_ -match 'VMware Workstation|build-|Host:|ProductVersion|Hostname|Windows' } | Select-Object -First 8 | ForEach-Object { "  " + (Short $_ 200) }
            "--- $($log.Name): lines inside the windows (Ethernet0 / link / vmnet / NAT / DHCP / power / reset / suspend / tools / warnings), capped at 250"
            $n = 0
            foreach ($l in [System.IO.File]::ReadLines($log.FullName)) {
                if ($l.Length -lt 20) { continue }
                if (-not $minutes.Contains($l.Substring(0, 16))) { continue }
                if ($l -match 'Ethernet0|[Ll]ink|vmnet|VMNet|NAT|DHCP|[Pp]ower|[Rr]eset|[Ss]uspend|[Rr]esum|Tools|panic|PANIC|Unrecoverable|\| W\d|\| E\d|MKS.*(disconnect|connect)') {
                    "  " + (Short $l 210); $n++
                    if ($n -ge 250) { '  (capped)'; break }
                }
            }
            if ($n -eq 0) { '  (no matching lines in the windows)' }
        }
    }
}

foreach ($w in $windows) {
    Section ("6. Host System log inside window: " + $w[0]) {
        $from = [datetime]$w[1]; $to = [datetime]$w[2]
        $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $from; EndTime = $to } -ErrorAction SilentlyContinue | Sort-Object TimeCreated
        $keep = $ev | Where-Object {
            $_.Level -le 3 -or
            $_.ProviderName -match 'VMware|vmnet|Kernel-Power|Power-Troubleshooter|Kernel-General|WLAN|NDIS|Tcpip|Dhcp|NetworkProfile|Netwtw|Wifi|WiFi|rtwlan|e1|Realtek|Intel|Hyper-V|HNS|Wintun|TAP' -or
            ($_.ProviderName -eq 'Service Control Manager' -and $_.Message -match 'VMware|vmnet|NAT|DHCP|Hyper-V|WSL|Wlan|WLAN')
        }
        if (-not $keep) { "(no matching System events; $((@($ev)).Count) events in the window in total)" }
        $keep | Select-Object -First 60 | ForEach-Object { "{0:HH:mm:ss} {1,-30} id={2,-5} L{3} {4}" -f $_.TimeCreated, $_.ProviderName, $_.Id, $_.Level, (Short $_.Message 170) }
        foreach ($log in 'Microsoft-Windows-NetworkProfile/Operational', 'Microsoft-Windows-WLAN-AutoConfig/Operational') {
            $o = Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $from; EndTime = $to } -ErrorAction SilentlyContinue | Sort-Object TimeCreated | Select-Object -First 25
            foreach ($e in $o) { "{0:HH:mm:ss} [{1}] id={2} {3}" -f $e.TimeCreated, ($log -replace 'Microsoft-Windows-|/Operational', ''), $e.Id, (Short ($e.Message -replace '(SSID|BSSID|Profile Name|Profile|Interface GUID|Interface Description)[^:]*:\s*\S+', '$1: <hidden>') 150) }
        }
    }
}

Section '7. Network adapters (no MAC addresses)' {
    Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { "{0,-28} {1,-52} {2,-12} {3}" -f $_.Name, (Short $_.InterfaceDescription 52), $_.Status, $_.LinkSpeed }
    ''
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' } | ForEach-Object { "{0,-28} {1}/{2}" -f $_.InterfaceAlias, $_.IPAddress, $_.PrefixLength }
}

Section '8. Default routes and interface metrics (which link the host sends internet traffic through)' {
    Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | ForEach-Object {
        $m = (Get-NetIPInterface -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).InterfaceMetric
        "{0,-28} nexthop {1,-16} route metric {2,-5} interface metric {3}" -f $_.InterfaceAlias, $_.NextHop, $_.RouteMetric, $m
    }
    ''
    'DNS servers per interface:'
    Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses } | ForEach-Object { "  {0,-28} {1}" -f $_.InterfaceAlias, ($_.ServerAddresses -join ', ') }
}

Section '9. Software that can touch routing or the VMware NAT: names only (processes, services, adapters)' {
    $pat = 'clash|v2ray|xray|sing-?box|wireguard|openvpn|vpn|tailscale|zerotier|accelerat|jiasu|netch|ghelper|watt|frpc|sakura|ngrok|drcom|srun|campus|proxifier|npcap|wireshark|virtualbox|vbox|hyper-v|vmms|vmcompute|hns|wslservice|docker|nvcontainer|killer|smartbyte|qos'
    'processes:'
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match $pat } | Sort-Object ProcessName | ForEach-Object { $t = try { $_.StartTime } catch { '' }; "  {0,-30} pid {1,-6} {2}" -f $_.ProcessName, $_.Id, $t }
    'services (running):'
    Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' -and ($_.Name -match $pat -or $_.DisplayName -match $pat) } | Sort-Object Name | ForEach-Object { "  {0,-30} {1}" -f $_.Name, (Short $_.DisplayName 60) }
    'virtual / tunnel adapters:'
    Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'TAP|TUN|Wintun|WireGuard|VPN|Npcap|Hyper-V|WSL|Clash|Meta|Virtual' } | ForEach-Object { "  {0,-28} {1,-50} {2}" -f $_.Name, (Short $_.InterfaceDescription 50), $_.Status }
}

Section '10. Power: battery, AC drops, sleep states, last wake, wake timers' {
    $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
    if ($bat) { $bat | ForEach-Object { "battery: $($_.Name)  status=$($_.BatteryStatus) (2 = on AC)  charge=$($_.EstimatedChargeRemaining)%" } } else { 'no battery found (a desktop machine?)' }
    'AC/battery changes (Kernel-Power id 105; AcOnline=false means the charger dropped), last 14 days:'
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 105; StartTime = (Get-Date).AddDays(-14) } -ErrorAction SilentlyContinue | Sort-Object TimeCreated | ForEach-Object {
        $x = [xml]$_.ToXml(); $d = @{}; $x.Event.EventData.Data | ForEach-Object { $d[$_.Name] = $_.'#text' }
        "  {0:MM-dd HH:mm:ss}  AcOnline={1}" -f $_.TimeCreated, $d['AcOnline']
    }
    'powercfg /a'; powercfg /a 2>&1 | ForEach-Object { "  $_" }
    'powercfg /lastwake'; powercfg /lastwake 2>&1 | ForEach-Object { "  $_" }
    'powercfg /waketimers'; powercfg /waketimers 2>&1 | ForEach-Object { "  $_" }
}

Section '11. Windows Update activity on the host, last 5 days (System log provider WindowsUpdateClient, summary)' {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WindowsUpdateClient'; StartTime = (Get-Date).AddDays(-5) } -ErrorAction SilentlyContinue |
        Sort-Object TimeCreated | Select-Object -Last 25 | ForEach-Object { "{0:MM-dd HH:mm:ss} id={1,-4} {2}" -f $_.TimeCreated, $_.Id, (Short $_.Message 130) }
}

Section '12. USB / dock / Ethernet device names (a flaky dock or charger can drop the network and the power together)' {
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Dock|Docking|Hub|Thunderbolt|USB-C|Type-C|Ethernet|LAN|Gigabit|Wi-?Fi|Wireless|Bluetooth' -and $_.Class -in 'Net', 'USB', 'System', 'USBDevice', 'Bluetooth' } |
        Sort-Object Class, FriendlyName | ForEach-Object { "  {0,-10} {1,-60} {2}" -f $_.Class, (Short $_.FriendlyName 60), $_.Status }
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
[System.IO.File]::WriteAllLines($report, $lines, (New-Object System.Text.UTF8Encoding($true)))
Write-Host ''
Write-Host "Report written: $report  ($([int]((Get-Item $report).Length / 1KB)) KB, $($lines.Count) lines)"
Write-Host 'Nothing was changed on this machine. Send that file back (or paste its text).'
