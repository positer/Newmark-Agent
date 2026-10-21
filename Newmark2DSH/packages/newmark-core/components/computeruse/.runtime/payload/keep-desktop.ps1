param(
  [Parameter(Mandatory = $true)][string]$DesktopName,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$CsharpDir
)

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$makerPath = [System.IO.Path]::Combine($CsharpDir, 'NmHiddenMaker.cs')
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($makerPath, [System.Text.Encoding]::UTF8)) -ErrorAction Stop

$errorCode = 0
$hold = [NmHiddenMaker]::OpenByName($DesktopName, [ref]$errorCode)
$report = @{
  ok = ($hold -ne [IntPtr]::Zero)
  event = 'keeper_ready'
  desktop = $DesktopName
  pid = $PID
  open_error = [int]$errorCode
  hold_value = ('0x' + $hold.ToInt64().ToString('x'))
}
[System.IO.File]::WriteAllText($ReadyFile, ($report | ConvertTo-Json -Depth 6 -Compress), $Utf8)
if ($hold -eq [IntPtr]::Zero) { exit 1 }

# Hold until standard input ends. Nothing else: no window, no message loop, no process.
while ($true) {
  $line = [System.Console]::In.ReadLine()
  if ($line -eq $null) { break }
}
[void][NmHiddenMaker]::CloseDesktop($hold)
exit 0
