param(
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ScriptArgs
)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Quote([string]$value) { return '"' + $value.Replace('"', '\"') + '"' }
$arguments = @()
foreach ($item in @($Script) + $ScriptArgs) { $arguments += (Quote $item) }
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:DSH_NODE_EXECUTABLE
$start.Arguments = [string]::Join(' ', $arguments)
$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$process = [System.Diagnostics.Process]::Start($start)
$stderr = $process.StandardError.ReadToEndAsync()
$stdout = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
[Console]::Out.Write($stdout)
[Console]::Error.Write($stderr.Result)
exit $process.ExitCode
