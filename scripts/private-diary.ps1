# 私密日记的加密读写（Windows DPAPI，绑定当前用户）
# 用法：
#   powershell -File scripts\private-diary.ps1 -Action read -Path C:\Users\22601\.dsh\linmengyao\PRIVATE.dat
#   powershell -File scripts\private-diary.ps1 -Action append -Path ... -Base64 <utf8-base64>
param(
    [ValidateSet('read', 'append')][string]$Action = 'read',
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Base64 = ''
)
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Security } catch { }

$bytes = if (Test-Path $Path) { [IO.File]::ReadAllBytes($Path) } else { [byte[]]@() }
$plain = if ($bytes.Length -gt 0) {
    [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'))
} else { '' }

if ($Action -eq 'read') { Write-Output $plain; exit 0 }

$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64))
$plain = $plain.TrimEnd() + "`n`n## " + (Get-Date).ToString('yyyy-MM-dd') + "`n" + $text + "`n"
$protected = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, 'CurrentUser')
[IO.File]::WriteAllBytes($Path, $protected)
Write-Output 'ok'
