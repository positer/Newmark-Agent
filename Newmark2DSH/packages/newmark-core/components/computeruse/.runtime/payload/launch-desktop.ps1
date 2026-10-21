param(
  [Parameter(Mandatory = $true)][string]$DesktopName,
  [Parameter(Mandatory = $true)][string]$AgentCommandLineB64,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$CsharpDir,
  [int]$ReadyWaitMs = 60000,
  [switch]$ReuseExisting
)

$ErrorActionPreference = 'Stop'
# The agent command line arrives base64 encoded, and that is not obfuscation. powershell.exe
# parses the arguments of a -File call itself, and it does NOT use the C runtime rule the
# quoting was written for: a quoted argument whose CONTENT contains quotes is split, so
# -DesktopName from inside the agent command line was bound again at the outer level and the
# launcher refused with "the parameter DesktopName is specified more than once". Base64 has no
# quotes and no spaces, so there is nothing left for either parser to disagree about.
$AgentCommandLine = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($AgentCommandLineB64))
$report = @{}
$report.desktop = $DesktopName
$report.created = $false
$report.existed_before = $false
$report.agent_pid = 0

$makerPath = [System.IO.Path]::Combine($CsharpDir, 'NmHiddenMaker.cs')
$launcherPath = [System.IO.Path]::Combine($CsharpDir, 'NmHiddenLauncher.cs')
# Two Add-Type calls, two assemblies, two types. The maker never declares CreateProcessW and
# the launcher never declares CreateDesktopW: a previous phase measured that compiling them
# into one type gives a child that dies before its first instruction.
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($makerPath, [System.Text.Encoding]::UTF8)) -ErrorAction Stop
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($launcherPath, [System.Text.Encoding]::UTF8)) -ErrorAction Stop

$errorCode = 0
$desktop = [IntPtr]::Zero
$probe = [NmHiddenMaker]::OpenByName($DesktopName, [ref]$errorCode)
$report.existed_before = ($probe -ne [IntPtr]::Zero)
if ($report.existed_before) {
  [void][NmHiddenMaker]::CloseDesktop($probe)
  if (-not $ReuseExisting) {
    $report.ok = $false
    $report.error = 'a desktop with this name already exists; refusing to adopt it'
    $report | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }
  # Adopting an existing desktop. This path exists for one reason: the interactive desktop is
  # already there and cannot be created, so the ONLY way to run the identical agent against the
  # identical application on the interactive desktop is to start it onto a desktop somebody else
  # owns. There is no handle to hold and none to close - the desktop outlives this process, which
  # is exactly what the control needs and exactly what the hidden case must not do.
  $report.adopted = $true
} else {
  $desktop = [NmHiddenMaker]::CreateByName($DesktopName, [ref]$errorCode)
  if ($desktop -eq [IntPtr]::Zero) {
    $report.ok = $false
    $report.create_error = [int]$errorCode
    $report.error = 'CreateDesktopW returned a null handle'
    $report | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }
  $report.created = $true
  $report.create_error = [int]$errorCode
  $report.desktop_kernel_name = [NmHiddenMaker]::KernelName($desktop)
}
$report.launcher_thread_desktop = [NmHiddenMaker]::DesktopName()
$report.window_station = [NmHiddenMaker]::WindowStationName()

$launchError = 0
$agentPid = [NmHiddenLauncher]::Launch($DesktopName, $AgentCommandLine, [ref]$launchError)
$report.launch_error = [int]$launchError
$report.agent_pid = [int]$agentPid
if ($agentPid -eq 0) {
  [void][NmHiddenMaker]::CloseDesktop($desktop)
  $report.ok = $false
  $report.error = 'CreateProcessW returned pid 0'
  $report | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

# Wait for the agent to publish that it holds its own handle to this desktop, then let go.
$waited = 0
$readyText = ''
while ($waited -lt $ReadyWaitMs) {
  if ([System.IO.File]::Exists($ReadyFile)) {
    try { $readyText = [System.IO.File]::ReadAllText($ReadyFile, [System.Text.Encoding]::UTF8) } catch { $readyText = '' }
    if ($readyText.Length -gt 0) { break }
  }
  Start-Sleep -Milliseconds 100
  $waited = $waited + 100
}
$report.ready_waited_ms = $waited
$report.ready_text = $readyText
$report.handover = ($readyText.Length -gt 0)

# This is the handover. Closing the launcher's handle is what makes the agent's own handle the
# one that decides the desktop's lifetime - and it happens ONLY when this process created the
# desktop. An adopted desktop is someone else's and is left strictly alone.
if ($report.created) {
  $report.closed_launcher_handle = [NmHiddenMaker]::CloseDesktop($desktop)
} else {
  $report.closed_launcher_handle = $false
  $report.close_skipped = 'the desktop was adopted, not created'
}
$report.ok = $true
$report | ConvertTo-Json -Depth 6 -Compress
exit 0
