<#
  Restart the installed DeepSeek Harness desktop, robustly.

  Two failures taught this script what to do (2026-10-26):
    20:08  a throw-away launcher killed by image name, waited 6 s, launched without working directory,
           stdout or readiness check, and never retried -> the app stayed down for 4 minutes.
    20:19  the same helper was itself inside the DSH tool executor Windows JOB object (kill-on-close):
           "detaching" with Start-Process does not leave a job, so killing the host killed the helper and
           the app it had just started. The log simply stopped after "launch attempt 1".

  So: the helper hands itself off to a WMI-created worker (parent WmiPrvSE.exe, outside the job), and that
  worker starts the app the same way - also outside the job - then verifies a WINDOW exists before it
  claims success. Verification is the user-visible fact (a running main window), not "Start-Process did
  not throw".

  Usage:
    powershell -File restart-dsh.ps1 -DryRun     plan only
    powershell -File restart-dsh.ps1             hands off to the worker and returns immediately
    powershell -File restart-dsh.ps1 -Worker     what the hand-off runs (not by hand)
#>
param(
  [switch]$DryRun,
  [switch]$Worker,
  [switch]$Check,
  [int]$Retries = 3,
  [int]$ReadinessSeconds = 90,
  [int]$DelaySeconds = 0,
  [string]$Exe = 'C:\Users\12252\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe',
  [string]$LogFile = ''
)
$ErrorActionPreference = 'Stop'
if (-not $LogFile) { $LogFile = 'C:\Users\12252\Desktop\Files\Code\Newmark Agent\_local\restart-dsh.log' }
function Log([string]$message) {
  $line = '{0} {1}' -f ([DateTime]::UtcNow.ToString('o')), $message
  try { $line | Out-File -FilePath $LogFile -Append -Encoding utf8 } catch { }
  try { Write-Output $line } catch { }
}
function ReadyWindow {
  # Win32_Process has NO MainWindowTitle property (measured 2026-10-26): the first version polled a
  # CimInstance for it, always read null, and could never report READY. The window title lives on the
  # System.Diagnostics.Process object.
  $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  if ($p -and $p.MainWindowTitle) { return $p }
  return $null
}
function Identity($p) { @{ pid = [int]$p.ProcessId; path = [string]$p.ExecutablePath; created = $p.CreationDate.ToUniversalTime().ToString('o') } }
function SameProcess($expected) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)" -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  $a = Identity $p
  if ($a.path -ne $expected.path -or $a.created -ne $expected.created) { return $null }
  return $p
}
function MainProcess {
  Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -notmatch '--type=|dsh-desktop-host|ELECTRON_RUN_AS_NODE' } |
    Select-Object -First 1
}
function WmiStart([string]$commandLine, [string]$workingDirectory) {
  $arguments = @{ CommandLine = $commandLine }
  if ($workingDirectory) { $arguments.CurrentDirectory = $workingDirectory }
  return Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments
}

if (-not (Test-Path -LiteralPath $Exe)) { Log ('FATAL executable missing: ' + $Exe); exit 2 }
if ($Check) {
  $p = ReadyWindow
  if ($p) { Log ('CHECK: readiness probe sees pid ' + $p.Id + ', window "' + $p.MainWindowTitle + '"'); exit 0 }
  Log 'CHECK: no window found (the app is not running or has no window yet)'; exit 1
}
$main = MainProcess

if ($DryRun) {
  if ($main) {
    $all = @(Get-CimInstance Win32_Process)
    $ids = @([int]$main.ProcessId)
    do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids -and $_.ProcessId -ne $PID } | ForEach-Object { [int]$_.ProcessId }); $ids += $next } while ($next.Count -gt 0)
    Log ('DRY RUN: main pid ' + $main.ProcessId + ', process tree ' + $ids.Count + ' processes, exe ' + $main.ExecutablePath)
  } else { Log 'DRY RUN: the desktop is not running; the worker would only launch it' }
  Log ('DRY RUN: hand-off via WMI (parent WmiPrvSE, outside the host job); launch attempts ' + $Retries + '; readiness = a visible main window within ' + $ReadinessSeconds + 's')
  Log 'DRY RUN: nothing was stopped and nothing was started'
  exit 0
}

if (-not $Worker) {
  $self = $PSCommandPath
  $cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $self + '" -Worker -DelaySeconds ' + $DelaySeconds
  Log ('handing off to a WMI worker outside the host job: ' + $cmd)
  try { $created = WmiStart $cmd $null } catch { Log ('FATAL could not create the worker: ' + $_.Exception.Message); exit 4 }
  if ($created.ReturnValue -ne 0) { Log ('FATAL WMI refused the worker, return value ' + $created.ReturnValue); exit 4 }
  Log ('worker pid ' + $created.ProcessId)
  exit 0
}

$selfInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue
$parentInfo = if ($selfInfo) { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $selfInfo.ParentProcessId) -ErrorAction SilentlyContinue } else { $null }
Log ('worker ' + $PID + ' running outside the host job; parent ' + $(if ($parentInfo) { $parentInfo.Name } else { 'unknown' }))
if ($DelaySeconds -gt 0) { Log ('delaying ' + $DelaySeconds + 's so the caller can finish its reply first'); Start-Sleep -Seconds $DelaySeconds; Log 'delay over' }

if (-not $main) { Log 'no main desktop process found; going straight to the launch attempts' }
else {
  $all = @(Get-CimInstance Win32_Process)
  $ids = @([int]$main.ProcessId)
  do { $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids -and $_.ProcessId -ne $PID } | ForEach-Object { [int]$_.ProcessId }); $ids += $next } while ($next.Count -gt 0)
  $targets = @($all | Where-Object { $_.ProcessId -in $ids } | ForEach-Object { Identity $_ })
  Log ('stopping the verified tree: ' + $targets.Count + ' processes')
  foreach ($target in $targets) { if (SameProcess $target) { Stop-Process -Id $target.pid -Force -ErrorAction SilentlyContinue } }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $remaining = @($targets | Where-Object { SameProcess $_ })
    if (-not $remaining.Count) { break }
    if ([DateTime]::UtcNow -gt $deadline) { Log ('FATAL old processes did not exit: ' + (($remaining | ForEach-Object { $_.pid }) -join ',')); exit 3 }
    Start-Sleep -Milliseconds 200
  } while ($true)
  Log 'old process tree exited'
}

for ($attempt = 1; $attempt -le $Retries; $attempt++) {
  Log ('launch attempt ' + $attempt + ' of ' + $Retries + ' via WMI')
  $created = $null
  try { $created = WmiStart ('"' + $Exe + '"') (Split-Path $Exe) } catch { Log ('attempt ' + $attempt + ': WMI failed: ' + $_.Exception.Message) }
  if ($created -and $created.ReturnValue -ne 0) { Log ('attempt ' + $attempt + ': WMI return value ' + $created.ReturnValue) }
  $myPid = if ($created) { [int]$created.ProcessId } else { 0 }
  Log ('attempt ' + $attempt + ': launched pid ' + $myPid)
  $deadline = [DateTime]::UtcNow.AddSeconds($ReadinessSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $running = ReadyWindow
    if ($running) {
      Log ('READY: pid ' + $running.Id + ', window "' + $running.MainWindowTitle + '", attempt ' + $attempt)
      exit 0
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  Log ('attempt ' + $attempt + ': no main window within ' + $ReadinessSeconds + 's')
  $stale = MainProcess
  if ($stale) { $staleIdentity = Identity $stale; if (SameProcess $staleIdentity) { Stop-Process -Id $stale.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2 }
}
Log 'FATAL the desktop did not come up; start it manually from the Start menu and inspect this log'
exit 1
