param(
  [Parameter(Mandatory = $true)][string]$DesktopName,
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$LedgerPath,
  [Parameter(Mandatory = $true)][string]$CsharpDir,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$LogPath = '',
  [int]$OwnerPid = 0,
  [switch]$NoJob
)

$ErrorActionPreference = 'Stop'
$NewLine = [System.Environment]::NewLine
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:nmStop = $false

# A trap at script scope, and an explicit log file, because the agent runs on a desktop nobody
# is looking at: an unhandled error would otherwise go to a console window that no one can see,
# and a bring-up that fails silently is a bring-up that cannot be debugged. The log is a file
# the caller named on the command line - never an environment variable, which is the channel
# measured to kill a child before its first instruction.
trap {
  Write-NmLog -Message ('unhandled: ' + [string]$_)
  exit 9
}

function Write-NmLog {
  param([string]$Message)
  if ($LogPath -eq '') { return }
  try {
    $stamp = [DateTime]::UtcNow.ToString('o')
    [System.IO.File]::AppendAllText($LogPath, ($stamp + ' ' + $Message + $NewLine), $Utf8)
  } catch { }
}

function ConvertTo-NmHandle {
  param([string]$Value)
  if ($Value -eq $null -or $Value -eq '') { return [IntPtr]::Zero }
  $text = $Value.Trim()
  if ($text.StartsWith('0x') -or $text.StartsWith('0X')) { $text = $text.Substring(2) }
  if ($text.Length -eq 0) { return [IntPtr]::Zero }
  # PowerShell does not parse a hexadecimal literal in a cast, so the conversion is explicit and
  # unsigned first: a handle with the top bit set is a legal handle and not a negative number.
  $raw = [System.Convert]::ToUInt64($text, 16)
  return [IntPtr][long]$raw
}

# JSON numbers are read with TryParse in the INVARIANT culture, never with a cast.
#
# A cast THROWS on a value that is not a number, and an uncaught throw reaches the script-scope trap
# at the top of this payload, which exits the agent: one malformed request would cost the whole
# hidden desktop. The invariant culture is the other half - a locale whose decimal separator is a
# comma would fail to parse every legal number that JSON writes with a point.
function Read-NmNumber {
  param([object]$Value, [ref]$Result)
  if ($Value -eq $null) { return $false }
  $parsed = [double]0
  $styles = [System.Globalization.NumberStyles]::Float
  $culture = [System.Globalization.CultureInfo]::InvariantCulture
  if (-not [double]::TryParse([string]$Value, $styles, $culture, [ref]$parsed)) { return $false }
  # TryParse accepts the words NaN and Infinity, and neither is a displacement this desktop can
  # inject, so both are refused here rather than compared later.
  if ([double]::IsNaN($parsed)) { return $false }
  if ([double]::IsInfinity($parsed)) { return $false }
  $Result.Value = $parsed
  return $true
}

# A count is whole or it is refused. Truncating 2.7 steps would inject motion nobody asked for and
# then report it as the number that was asked for.
function Test-NmWholeNumber {
  param([double]$Value)
  return ($Value -eq [Math]::Floor($Value))
}

function Write-NmLedger {
  param([hashtable]$Entry)
  try {
    $line = ($Entry | ConvertTo-Json -Depth 6 -Compress)
    [System.IO.File]::AppendAllText($LedgerPath, $line + $NewLine, $Utf8)
  } catch { }
}

function New-NmLine {
  param([string]$Id, [bool]$Ok, [hashtable]$Fields)
  $envelope = @{ id = $Id; ok = $Ok }
  if ($Fields -ne $null) {
    foreach ($key in $Fields.Keys) { $envelope[$key] = $Fields[$key] }
  }
  return ($envelope | ConvertTo-Json -Depth 6 -Compress)
}

function New-NmError {
  param([string]$Id, [string]$Message)
  return (New-NmLine -Id $Id -Ok $false -Fields @{ error = $Message })
}

function Get-NmStartTimeIso {
  param([int]$ProcessId)
  try { return [NmProcessFacts]::StartTimeUtc($ProcessId) } catch { return '' }
}

function Get-NmHostedPids {
  $listed = @()
  if ($script:nmJob -ne [IntPtr]::Zero) {
    $errorCode = 0
    $assigned = 0
    $pids = [NmAgentJob]::MemberPids($script:nmJob, [ref]$errorCode, [ref]$assigned)
    foreach ($memberPid in $pids) {
      $listed += @{
        pid = [int]$memberPid
        start_time_utc = (Get-NmStartTimeIso -ProcessId ([int]$memberPid))
        start_time_ticks = [string][NmProcessFacts]::StartTimeTicks([int]$memberPid)
      }
    }
  }
  return $listed
}

# The processes that OWN A WINDOW ON THIS AGENT'S OWN DESKTOP and are not held by the job.
#
# This is the second half of the ownership question, and it exists because inheritance is not
# the whole story. A launch whose target hands its work to a process this agent did not create
# - a packaged application is the measured case - leaves a process ON this desktop that the
# job does not hold, so 'hosted' (job members) misses it and the teardown would report a clean
# end while something still occupies the desktop. A window is bound to its desktop, so every
# pid listed here is a process that is really on this agent's desktop; the read is by pid and
# never by name, and nothing here terminates anything.
function Get-NmUnheldWindowPids {
  $listed = @()
  $seen = @{}
  foreach ($fact in [NmAgentWindow]::TopLevelWindows()) {
    $ownerPid = [int]$fact.ProcessId
    if ($ownerPid -le 0 -or $ownerPid -eq $PID -or $seen.ContainsKey($ownerPid)) { continue }
    $seen[$ownerPid] = $true
    $membership = -1
    if ($script:nmJob -ne [IntPtr]::Zero) {
      $membershipError = 0
      $membership = [NmAgentJob]::PidMembership($script:nmJob, $ownerPid, [ref]$membershipError)
    }
    if ($membership -eq 1) { continue }
    $listed += @{
      pid = $ownerPid
      held = $false
      membership = [int]$membership
      title = [string]$fact.Title
      class_name = [string]$fact.ClassName
      start_time_utc = (Get-NmStartTimeIso -ProcessId $ownerPid)
      start_time_ticks = [string][NmProcessFacts]::StartTimeTicks($ownerPid)
    }
  }
  return $listed
}

function Invoke-NmAgentRequest {
  param([string]$Line)
  $request = $null
  try { $request = ConvertFrom-Json -InputObject $Line } catch { return (New-NmError -Id '' -Message ('the request is not JSON: ' + [string]$_.Exception.Message)) }
  $id = [string]$request.id
  $token = [string]$request.token
  if ($token -ne $Token) { return (New-NmError -Id $id -Message 'token mismatch') }
  $op = [string]$request.op

  if ($op -eq 'state') {
    return (New-NmLine -Id $id -Ok $true -Fields @{
      desktop_requested = $DesktopName
      desktop_thread = [NmAgentDesktop]::ThreadDesktopName()
      window_station = [NmAgentDesktop]::WindowStationName()
      desktop_hold = [NmAgentDesktop]::HoldName($script:nmDesktopHold)
      desktop_hold_value = ('0x' + $script:nmDesktopHold.ToInt64().ToString('x'))
      pid = $PID
      start_time_utc = (Get-NmStartTimeIso -ProcessId $PID)
      no_job = [bool]$NoJob
      job_created = $script:nmJobCreated
      job_assigned = $script:nmJobAssigned
      job_in_job = $script:nmJobInJob
      job_limit_flags = ('0x' + ([int]$script:nmJobLimit).ToString('x'))
      job_kill_on_close = (($script:nmJobLimit -band 0x2000) -ne 0)
      job_handle = ('0x' + $script:nmJob.ToInt64().ToString('x'))
      hosted = @(Get-NmHostedPids)
      # Every process on THIS desktop that owns a window and is not a job member. It is reported
      # by the state read, which the teardown asks BEFORE the exit, so a launch that the job does
      # not hold is inside the question the teardown asks rather than outside it.
      unheld_window_pids = @(Get-NmUnheldWindowPids)
      launched_this_agent = @($script:nmLaunched)
      token_match = $true
      shell = 'Windows PowerShell 5.1'
      types = @('NmAgentDesktop', 'NmAgentJob', 'NmAgentProcess', 'NmAgentWindow', 'NmAgentInput', 'NmProcessFacts')
    })
  }

  if ($op -eq 'enumerate') {
    $windows = @()
    foreach ($fact in [NmAgentWindow]::TopLevelWindows()) {
      $windows += @{
        handle = ('0x' + ([long]$fact.Handle).ToString('x'))
        title = [string]$fact.Title
        class_name = [string]$fact.ClassName
        pid = [int]$fact.ProcessId
        thread_id = [int]$fact.ThreadId
        rect = @{ x = [int]$fact.Left; y = [int]$fact.Top; width = [int]($fact.Right - $fact.Left); height = [int]($fact.Bottom - $fact.Top) }
        client = @{ width = [int]$fact.ClientWidth; height = [int]$fact.ClientHeight }
        visible = [bool]$fact.Visible
        minimized = [bool]$fact.Minimized
      }
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      desktop = [NmAgentDesktop]::ThreadDesktopName()
      window_station = [NmAgentDesktop]::WindowStationName()
      window_count = $windows.Count
      windows = $windows
      foreground = ('0x' + [NmAgentWindow]::GetForegroundWindow().ToInt64().ToString('x'))
    })
  }

  if ($op -eq 'children') {
    $parent = ConvertTo-NmHandle -Value ([string]$request.handle)
    $children = @()
    foreach ($fact in [NmAgentWindow]::ChildWindows($parent)) {
      $children += @{
        handle = ('0x' + ([long]$fact.Handle).ToString('x'))
        title = [string]$fact.Title
        class_name = [string]$fact.ClassName
        pid = [int]$fact.ProcessId
        client = @{ width = [int]$fact.ClientWidth; height = [int]$fact.ClientHeight }
        visible = [bool]$fact.Visible
      }
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      is_window = [bool][NmAgentWindow]::IsWindow($parent)
      child_count = $children.Count
      children = $children
    })
  }

  if ($op -eq 'capture') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $outPath = [string]$request.path
    $width = 0; $height = 0; $route = 0; $printError = 0
    $ok = [NmAgentWindow]::Capture($target, $outPath, [ref]$width, [ref]$height, [ref]$route, [ref]$printError)
    if ($ok -ne 1) {
      return (New-NmLine -Id $id -Ok $false -Fields @{
        error = 'PrintWindow and BitBlt both produced nothing'
        print_window_error = [int]$printError
        is_window = [bool][NmAgentWindow]::IsWindow($target)
      })
    }
    $bytes = [System.IO.File]::ReadAllBytes($outPath)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $digest = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      path = $outPath
      bytes = [int]$bytes.Length
      sha256 = $digest
      width = [int]$width
      height = [int]$height
      route = [int]$route
      desktop = [NmAgentDesktop]::ThreadDesktopName()
    })
  }

  if ($op -eq 'click') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $x = [int]$request.x
    $y = [int]$request.y
    $point = [NmAgentWindow]::PointLParam($x, $y)
    $moved = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_MOUSEMOVE, [IntPtr]::Zero, [IntPtr][long]$point)
    $down = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_LBUTTONDOWN, [IntPtr][long]1, [IntPtr][long]$point)
    $up = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_LBUTTONUP, [IntPtr]::Zero, [IntPtr][long]$point)
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      x = $x
      y = $y
      is_window = [bool][NmAgentWindow]::IsWindow($target)
      posted = @{ moved = [bool]$moved; down = [bool]$down; up = [bool]$up }
    })
  }

  if ($op -eq 'type') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $edit = [NmAgentWindow]::FindEditChild($target)
    $landed = $target
    if ($edit -ne [IntPtr]::Zero) { $landed = $edit }
    $text = [string]$request.text
    $posted = 0
    foreach ($character in $text.ToCharArray()) {
      $code = [int][char]$character
      if ([NmAgentWindow]::Post($landed, [NmAgentWindow]::WM_CHAR, [IntPtr][long]$code, [IntPtr]::Zero)) { $posted = $posted + 1 }
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      target_handle = ('0x' + $landed.ToInt64().ToString('x'))
      used_edit_child = ($edit -ne [IntPtr]::Zero)
      characters = $text.Length
      posted = [int]$posted
    })
  }

  if ($op -eq 'key') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $virtualKey = [int]$request.vk
    $down = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_KEYDOWN, [IntPtr][long]$virtualKey, [IntPtr]::Zero)
    $up = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_KEYUP, [IntPtr][long]$virtualKey, [IntPtr]::Zero)
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      vk = $virtualKey
      posted = @{ down = [bool]$down; up = [bool]$up }
    })
  }

  if ($op -eq 'scroll') {
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $delta = [int]$request.delta
    $screenX = 0
    $screenY = 0
    $centered = [NmAgentWindow]::ClientCenterOnScreen($target, [ref]$screenX, [ref]$screenY)
    $wheelParam = [NmAgentWindow]::WheelWParam($delta)
    $pointParam = [NmAgentWindow]::PointLParam($screenX, $screenY)
    $posted = [NmAgentWindow]::Post($target, [NmAgentWindow]::WM_MOUSEWHEEL, [IntPtr][long]$wheelParam, [IntPtr][long]$pointParam)
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      delta = $delta
      posted = [bool]$posted
      centered = [bool]$centered
      screen = @{ x = [int]$screenX; y = [int]$screenY }
    })
  }

  if ($op -eq 'sweep') {
    # Two separate jobs, in two places. What a JSON number can BE is decided here; what this
    # desktop will PERFORM is decided inside the injector, because the injector is the only thing
    # that moves the pointer and a bound enforced anywhere else is bypassed by the next caller.
    $sweepDx = [double]0
    $sweepDy = [double]0
    $sweepSteps = [double]0
    $sweepDuration = [double]0
    if (-not (Read-NmNumber -Value $request.dx -Result ([ref]$sweepDx))) { return (New-NmError -Id $id -Message 'sweep needs a number for dx') }
    if (-not (Read-NmNumber -Value $request.dy -Result ([ref]$sweepDy))) { return (New-NmError -Id $id -Message 'sweep needs a number for dy') }
    if (-not (Read-NmNumber -Value $request.steps -Result ([ref]$sweepSteps))) { return (New-NmError -Id $id -Message 'sweep needs a number for steps') }
    if (-not (Read-NmNumber -Value $request.duration_ms -Result ([ref]$sweepDuration))) { return (New-NmError -Id $id -Message 'sweep needs a number for duration_ms') }
    if (-not (Test-NmWholeNumber -Value $sweepDx) -or -not (Test-NmWholeNumber -Value $sweepDy) -or -not (Test-NmWholeNumber -Value $sweepSteps)) {
      return (New-NmError -Id $id -Message 'sweep dx, dy and steps must be whole numbers of pixels and steps')
    }
    # The button name is decoded here so the three accepted spellings live next to the JSON field
    # that carries them; the injector is handed an integer and bounds it.
    $buttonName = 'none'
    if ($request.button -ne $null) { $buttonName = ([string]$request.button).Trim().ToLowerInvariant() }
    $buttonCode = -1
    if ($buttonName -eq 'none' -or $buttonName -eq '') { $buttonCode = [NmAgentInput]::BUTTON_NONE }
    elseif ($buttonName -eq 'left') { $buttonCode = [NmAgentInput]::BUTTON_LEFT }
    elseif ($buttonName -eq 'right') { $buttonCode = [NmAgentInput]::BUTTON_RIGHT }
    if ($buttonCode -lt 0) { return (New-NmError -Id $id -Message ('sweep button must be none, left or right, not ' + $buttonName)) }
    # A named window is brought to THIS desktop's foreground first, so a held gesture steers the
    # window the caller pointed at instead of whatever held the focus. A refused activation is
    # reported and not fatal: the injection is desktop-wide, so it happens either way, and the
    # caller can read foreground_granted instead of trusting the request it made.
    $target = ConvertTo-NmHandle -Value ([string]$request.handle)
    $foregroundGranted = $false
    if ($target -ne [IntPtr]::Zero) { $foregroundGranted = [NmAgentInput]::BringForeground($target) }
    # A duration is a TIME and not a count, so it is rounded rather than refused: the lane's own
    # plan accepts a fractional duration_ms and derives dx/dy from it, and this loop times against
    # whole milliseconds. The receipt reports the value that was used.
    $sweepMs = [int][Math]::Round($sweepDuration)
    $fact = [NmAgentInput]::SweepMeasured([int]$sweepDx, [int]$sweepDy, [int]$sweepSteps, $sweepMs, $buttonCode)
    $cursorBefore = $null
    $cursorAfter = $null
    $cursorDisplacement = $null
    if ($fact.CursorRestorable) { $cursorBefore = @{ x = [int]$fact.CursorBeforeX; y = [int]$fact.CursorBeforeY } }
    if ($fact.CursorAfterMeasured) { $cursorAfter = @{ x = [int]$fact.CursorAfterX; y = [int]$fact.CursorAfterY } }
    if ($fact.CursorRestorable -and $fact.CursorMeasured) { $cursorDisplacement = @{ x = [int]($fact.CursorMovedX - $fact.CursorBeforeX); y = [int]($fact.CursorMovedY - $fact.CursorBeforeY) } }
    if (([string]$fact.Error -ne '') -or ([int]$fact.Injected -le 0)) {
      # The refusal the injector measured, in its own words. Never a clamped success, and a partial
      # injection says how far it got before it failed.
      $refusal = [string]$fact.Error
      if ($refusal -eq '') { $refusal = 'the sweep injected no relative move on this desktop' }
      if ([int]$fact.Injected -gt 0) { $refusal = ($refusal + ' (injected ' + [string]$fact.Injected + ' of ' + [string]$fact.Steps + ' steps)') }
      return (New-NmError -Id $id -Message $refusal)
    }
    # THREE STATES, NAMED. "restored" and "cannot be restored on this desktop" are different
    # facts and only one of them is a defect, so the receipt says which one happened instead of
    # leaving a caller to infer it from a false. A position is reported only when its own read
    # answered: a null means this desktop has no readable pointer, not that it is at the origin.
    $cursorRestore = 'failed'
    if (-not $fact.CursorRestorable) { $cursorRestore = 'impossible-on-this-desktop' }
    elseif ($fact.CursorRestored) { $cursorRestore = 'restored' }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      handle = [string]$request.handle
      button = $buttonName
      dx = [int]$fact.Dx
      dy = [int]$fact.Dy
      steps = [int]$fact.Steps
      duration_ms = [int]$fact.DurationMs
      injected = [int]$fact.Injected
      # The sum of the deltas ACTUALLY injected, so a receipt can show a lost remainder instead of
      # repeating the request back.
      sum_dx = [int]$fact.SumDx
      sum_dy = [int]$fact.SumDy
      elapsed_ms = [int]$fact.ElapsedMs
      button_held_ms = [int]$fact.ButtonHeldMs
      button_released = [bool]$fact.ButtonReleased
      cursor_restorable = [bool]$fact.CursorRestorable
      cursor_restore = $cursorRestore
      cursor_before = $cursorBefore
      # Where this desktop's own pointer had got to before the restore: the evidence that the
      # injection moved THIS desktop's cursor rather than another one. Null when this desktop has
      # no readable pointer, which is the case on a hidden desktop.
      cursor_displacement = $cursorDisplacement
      cursor_after = $cursorAfter
      cursor_restored = [bool]$fact.CursorRestored
      foreground = ('0x' + [NmAgentInput]::Foreground().ToInt64().ToString('x'))
      foreground_granted = [bool]$foregroundGranted
      injection = 'relative-mouse-event'
      desktop = [NmAgentDesktop]::ThreadDesktopName()
    })
  }

  if ($op -eq 'launch') {
    $commandLine = [string]$request.command_line
    $errorCode = 0
    # WHEN THIS LAUNCH BEGAN, so a pid that answered can be told from a process this launch made.
    # The boundary below is 5 seconds in FILETIME ticks (10^7 per second), which is far longer than
    # a create-and-answer round trip and far shorter than any plausible pre-existing process.
    $launchMarkTicks = [long][DateTime]::UtcNow.ToFileTimeUtc()
    $started = [NmAgentProcess]::LaunchOn($DesktopName, $commandLine, [ref]$errorCode)
    if ($started -eq 0) {
      return (New-NmLine -Id $id -Ok $false -Fields @{
        error = 'CreateProcessW refused the launch'
        last_error = [int]$errorCode
        command_line = $commandLine
        desktop = $DesktopName
      })
    }
    # THE MEMBERSHIP IS MEASURED AFTER THE LAUNCH, IN THREE STEPS, AND EACH ONE IS REPORTED.
    #
    # Inheritance is the mechanism that is supposed to make this unnecessary - a child of a job
    # member is in the job - and it is not sufficient. Measured on this station: an agent that
    # reported job_in_job: true launched notepad.exe and the child came back NOT a member,
    # while the same agent launching a plain Win32 program produced a member. A process outside
    # the job is not killed by KILL_ON_JOB_CLOSE, so the desktop it sits on outlives the agent
    # that made it, invisibly.
    #
    # So: read membership as a three-valued answer (a failed OpenProcess is NOT "not a member"),
    # cross-check it against the job's own member list, and if the child is not a member PUT IT
    # THERE and read again. 'held' is the answer after all of that; a launch that could not be
    # held says so, with the reason, and the caller reports it as unowned rather than absent.
    $startTicks = 0
    try { $startTicks = [NmProcessFacts]::StartTimeTicks([int]$started) } catch { }
    $membership = -1
    $membershipError = 0
    $memberListed = $false
    $maybe = $true
    if ($script:nmJob -ne [IntPtr]::Zero) {
      try { $membership = [NmAgentJob]::PidMembership($script:nmJob, [int]$started, [ref]$membershipError) } catch { $membership = -1 }
    } else {
      $maybe = $false
    }
    $membershipBefore = [int]$membership
    $inherited = ($membership -eq 1)
    # OURS, OR MERELY THE PID THAT ANSWERED.
    #
    # A launch that hands its work to the shell's activation host can answer with a process this
    # launch did not create - including one that was already running. Assigning THAT to the job
    # would claim, and later kill, something that was never this route's. So a process whose
    # creation time predates the launch is reported as NOT ours: it is checked by the teardown and
    # named as a survivor, but it is never adopted.
    $ours = $true
    if ($startTicks -gt 0) {
      if ([long]$startTicks -lt ([long]$launchMarkTicks - 50000000)) { $ours = $false }
    }
    $assigned = $false
    $assignError = 0
    if (-not $inherited -and $maybe -and $ours) {
      try { $assigned = [NmAgentJob]::AssignPid($script:nmJob, [int]$started, [ref]$assignError) } catch { $assigned = $false }
      if ($assigned) {
        $membershipError = 0
        try { $membership = [NmAgentJob]::PidMembership($script:nmJob, [int]$started, [ref]$membershipError) } catch { $membership = -1 }
      }
    }
    if ($maybe) {
      $listError = 0
      $assignedCount = 0
      # @(...) on purpose: PowerShell unwraps a one-element array returned from a method into a
      # scalar, and '-contains' against a scalar is a different question from '-contains' against
      # the list the kernel answered with.
      $members = @()
      try { $members = @([NmAgentJob]::MemberPids($script:nmJob, [ref]$listError, [ref]$assignedCount)) } catch { $members = @() }
      $memberListed = ($members -contains [int]$started)
    }
    $held = ($membership -eq 1)
    # A second, independent read: a process on THIS desktop that is not held. It catches a target
    # that handed its work to a process this agent never created, which no membership read of the
    # created pid can see.
    $unheld = @()
    try { $unheld = @(Get-NmUnheldWindowPids) } catch { $unheld = @() }
    $unheldPids = @($unheld | ForEach-Object { [int]$_.pid })
    # No ternary: this payload runs under Windows PowerShell 5.1, which has no '? :' operator.
    $ownership = 'unowned'
    if ($held) {
      if ($inherited) { $ownership = 'inherited' } else { $ownership = 'assigned' }
    }    $script:nmLaunched += @{ pid = [int]$started; start_time_ticks = [string]$startTicks; command_line = $commandLine; held = [bool]$held; ownership = $ownership }
    Write-NmLedger -Entry @{
      kind = 'hosted'
      at = [DateTime]::UtcNow.ToString('o')
      desktop = $DesktopName
      pid = [int]$started
      start_time_utc = (Get-NmStartTimeIso -ProcessId ([int]$started))
      # A STRING, and that is not tidiness. A FILETIME tick count is about 1.3e17 and a JSON number
      # is an IEEE double, so anything above 2^53 - every real start time - is rounded on the way
      # through and stops matching the process it describes. Measured: the whole ownership
      # measurement came back "pid reuse" for its own processes because of exactly this, and the
      # reaper then refused to terminate anything.
      start_time_ticks = [string]$startTicks
      in_job = [bool]$held
      ownership = $ownership
      agent_pid = $PID
      command_line = $commandLine
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      pid = [int]$started
      start_time_utc = (Get-NmStartTimeIso -ProcessId ([int]$started))
      start_time_ticks = [string]$startTicks
      in_job = [bool]$held
      held = [bool]$held
      ownership = $ownership
      inherited = [bool]$inherited
      assigned_after_launch = [bool]$assigned
      assign_error = [int]$assignError
      membership_before = [int]$membershipBefore
      membership_error = [int]$membershipError
      created_by_this_launch = [bool]$ours
      started_before_this_launch = [bool](-not $ours)
      launch_mark_ticks = [string]$launchMarkTicks
      member_listed = [bool]$memberListed
      job_present = [bool]$maybe
      job_in_job = [bool]$script:nmJobInJob
      unheld_window_pids = @($unheld)
      unheld_pids = @($unheldPids)
      desktop_requested = $DesktopName
      command_line = $commandLine
    })
  }

  if ($op -eq 'job') {
    $errorCode = 0
    $assigned = 0
    $pids = @()
    if ($script:nmJob -ne [IntPtr]::Zero) { $pids = [NmAgentJob]::MemberPids($script:nmJob, [ref]$errorCode, [ref]$assigned) }
    $members = @()
    foreach ($memberPid in $pids) {
      $members += @{
        pid = [int]$memberPid
        start_time_utc = (Get-NmStartTimeIso -ProcessId ([int]$memberPid))
        start_time_ticks = [string][NmProcessFacts]::StartTimeTicks([int]$memberPid)
      }
    }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      no_job = [bool]$NoJob
      job_created = $script:nmJobCreated
      job_assigned = $script:nmJobAssigned
      job_kill_on_close = (($script:nmJobLimit -band 0x2000) -ne 0)
      assigned_count = [int]$assigned
      listed_count = [int]$members.Count
      members = $members
      agent_pid = $PID
    })
  }

  if ($op -eq 'pidalive') {
    $processId = [int]$request.pid
    # The expected start time arrives as a STRING and is parsed here: as a JSON number it would have
    # been rounded past 2^53 before it ever reached this line.
    $expected = [long]0
    try { $expected = [long][string]$request.start_time_ticks } catch { $expected = [long]0 }
    $ticks = [NmProcessFacts]::StartTimeTicks($processId)
    # alive means RUNNING, not "the pid resolves": a terminated process keeps answering OpenProcess
    # for seconds, and a liveness test built on that reports a corpse as alive.
    $running = $false
    if ($ticks -gt 0) { $running = [NmProcessFacts]::Running($processId) }
    return (New-NmLine -Id $id -Ok $true -Fields @{
      pid = $processId
      alive = $running
      same_process = ($running -and ($expected -le 0 -or $ticks -eq $expected))
      start_time_utc = (Get-NmStartTimeIso -ProcessId $processId)
      start_time_ticks = [string]$ticks
      image = [NmProcessFacts]::ImagePath($processId)
    })
  }

  if ($op -eq 'close_desktop') {
    $holdValue = ('0x' + $script:nmDesktopHold.ToInt64().ToString('x'))
    $closed = [NmAgentDesktop]::Close($script:nmDesktopHold)
    $script:nmDesktopHold = [IntPtr]::Zero
    $reopenError = 0
    $reopen = [NmAgentDesktop]::OpenByName($DesktopName, [ref]$reopenError)
    $reopenName = ''
    if ($reopen -ne [IntPtr]::Zero) {
      $reopenName = [NmAgentDesktop]::HoldName($reopen)
      [void][NmAgentDesktop]::Close($reopen)
    }
    # The agent does NOT stop here. Closing a desktop handle and ending the agent are two different
    # acts and the caller has to be able to measure the first without the second: a version of this
    # that also stopped the agent closed the job handle on the way out, and the processes died of
    # THAT rather than of the CloseDesktop the measurement was trying to isolate.
    return (New-NmLine -Id $id -Ok $true -Fields @{
      closed = [bool]$closed
      hold_before = $holdValue
      reopen_handle = ('0x' + $reopen.ToInt64().ToString('x'))
      reopen_error = [int]$reopenError
      reopen_name = $reopenName
      agent_still_running = $true
      desktop_thread_still = [NmAgentDesktop]::ThreadDesktopName()
    })
  }

  if ($op -eq 'exit') {
    Write-NmLedger -Entry @{
      kind = 'exit'
      at = [DateTime]::UtcNow.ToString('o')
      desktop = $DesktopName
      agent_pid = $PID
      reason = 'requested'
    }
    $script:nmStop = $true
    return (New-NmLine -Id $id -Ok $true -Fields @{ exiting = $true; desktop = $DesktopName; agent_pid = $PID })
  }

  return (New-NmError -Id $id -Message ('unsupported op: ' + $op))
}

# ---------------------------------------------------------------------------- bring-up ---

$script:nmJob = [IntPtr]::Zero
$script:nmJobCreated = $false
$script:nmJobAssigned = $false
$script:nmJobInJob = $false
$script:nmJobLimit = 0
$script:nmLaunched = @()

$types = @('NmAgentDesktop', 'NmAgentJob', 'NmAgentProcess', 'NmAgentWindow', 'NmAgentInput', 'NmProcessFacts')
foreach ($typeName in $types) {
  $sourcePath = [System.IO.Path]::Combine($CsharpDir, $typeName + '.cs')
  $source = [System.IO.File]::ReadAllText($sourcePath, [System.Text.Encoding]::UTF8)
  if (-not ($typeName -as [type])) {
    try {
      Add-Type -TypeDefinition $source -ErrorAction Stop
    } catch {
      $message = ($typeName + ' did not compile under Windows PowerShell 5.1: ' + [string]$_.Exception.Message)
      $failure = @{ ok = $false; event = 'bringup_failed'; stage = 'compile'; type = $typeName; error = $message; pid = $PID } | ConvertTo-Json -Depth 6 -Compress
      [System.IO.File]::WriteAllText($ReadyFile, $failure, $Utf8)
      exit 1
    }
  }
}

if ($OwnerPid -gt 0) { [NmProcessFacts]::WatchOwner($OwnerPid) }
$desktopError = 0
$script:nmDesktopHold = [NmAgentDesktop]::OpenByName($DesktopName, [ref]$desktopError)
$threadDesktop = [NmAgentDesktop]::ThreadDesktopName()
if ($script:nmDesktopHold -eq [IntPtr]::Zero) {
  $failure = @{ ok = $false; event = 'bringup_failed'; stage = 'open_desktop'; desktop = $DesktopName; desktop_error = [int]$desktopError; thread_desktop = $threadDesktop; pid = $PID } | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($ReadyFile, $failure, $Utf8)
  exit 1
}

$jobError = 0
if (-not $NoJob) {
  $script:nmJob = [NmAgentJob]::CreateKillOnClose([ref]$jobError)
  if ($script:nmJob -ne [IntPtr]::Zero) {
    $script:nmJobCreated = $true
    $script:nmJobAssigned = [NmAgentJob]::AssignSelf($script:nmJob, [ref]$jobError)
    $script:nmJobInJob = [NmAgentJob]::SelfInJob($script:nmJob)
    $limitError = 0
    $script:nmJobLimit = [NmAgentJob]::LimitFlags($script:nmJob, [ref]$limitError)
  }
}

# 254 is PIPE_UNLIMITED_INSTANCES minus one, and the number is not free: NamedPipeServerStream
# refuses 255 outright ("maxNumberOfServerInstances must be between 1 and 254"), which the agent
# reported from the hidden desktop through its own log file rather than dying silently.
function New-NmPipe {
  return (New-Object System.IO.Pipes.NamedPipeServerStream($PipeName, [System.IO.Pipes.PipeDirection]::InOut, 254, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::None, 1048576, 1048576))
}

$script:nmAcceptFailures = 0
$pipe = New-NmPipe

$ready = @{
  ok = $true
  event = 'ready'
  agent = 'newmark-computeruse-hidden-agent'
  protocol = 1
  token = $Token
  pid = $PID
  start_time_utc = (Get-NmStartTimeIso -ProcessId $PID)
  pipe = $PipeName
  desktop_requested = $DesktopName
  desktop_thread = $threadDesktop
  window_station = [NmAgentDesktop]::WindowStationName()
  desktop_hold = [NmAgentDesktop]::HoldName($script:nmDesktopHold)
  desktop_hold_value = ('0x' + $script:nmDesktopHold.ToInt64().ToString('x'))
  desktop_open_error = [int]$desktopError
  no_job = [bool]$NoJob
  job_created = $script:nmJobCreated
  job_assigned = $script:nmJobAssigned
  job_in_job = $script:nmJobInJob
  job_limit_flags = ('0x' + ([int]$script:nmJobLimit).ToString('x'))
  job_kill_on_close = (($script:nmJobLimit -band 0x2000) -ne 0)
  job_handle = ('0x' + $script:nmJob.ToInt64().ToString('x'))
  job_error = [int]$jobError
  shell = 'Windows PowerShell 5.1'
  types = $types
  csharp_dir = $CsharpDir
}
[System.IO.File]::WriteAllText($ReadyFile, ($ready | ConvertTo-Json -Depth 6 -Compress), $Utf8)

Write-NmLedger -Entry @{
  kind = 'agent_start'
  at = [DateTime]::UtcNow.ToString('o')
  desktop = $DesktopName
  agent_pid = $PID
  start_time_utc = (Get-NmStartTimeIso -ProcessId $PID)
  job_created = $script:nmJobCreated
  job_assigned = $script:nmJobAssigned
  no_job = [bool]$NoJob
  token = $Token
}

while (-not $script:nmStop) {
  # Accept, serve, disconnect, accept again - for the whole life of the agent, from any number of
  # callers. A resident agent that stops being resident after one client is not an agent.
  $connected = $false
  try {
    $pipe.WaitForConnection()
    $connected = $true
  } catch {
    # An abrupt client disconnect can leave the pipe INSTANCE broken rather than merely idle, and
    # the first version of this loop treated that as the end of the agent: it broke out, the script
    # ended, the job handle closed and the whole tree went with it. The instance is therefore
    # rebuilt instead, and only a bounded run of consecutive rebuild failures is fatal.
    Write-NmLog -Message ('wait_for_connection failed: ' + [string]$_.Exception.Message)
    $script:nmAcceptFailures = $script:nmAcceptFailures + 1
    if ($script:nmAcceptFailures -gt 20) { Write-NmLog -Message 'giving up after 20 consecutive accept failures'; break }
    try { $pipe.Dispose() } catch { }
    try { $pipe = New-NmPipe } catch { Write-NmLog -Message ('rebuilding the pipe failed: ' + [string]$_.Exception.Message); break }
    continue
  }
  $script:nmAcceptFailures = 0
  if (-not $connected) { break }
  $reader = New-Object System.IO.StreamReader($pipe, (New-Object System.Text.UTF8Encoding($false)), $false, 4096, $true)
  $writer = New-Object System.IO.StreamWriter($pipe, (New-Object System.Text.UTF8Encoding($false)), 4096, $true)
  $writer.AutoFlush = $true
  while (-not $script:nmStop) {
    $line = $null
    try { $line = $reader.ReadLine() } catch { break }
    if ($line -eq $null) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $response = Invoke-NmAgentRequest -Line $line
    try { $writer.WriteLine($response) } catch { break }
  }
  try { $writer.Flush() } catch { }
  if ($script:nmStop) {
    # The answer to the exit request has been written and flushed, but this process is about to
    # close the job handle - which terminates the agent itself along with every member. Without this
    # pause the pipe is torn down under the caller, who sees "read EPIPE" instead of the answer that
    # was actually sent. Measured: the first version lost the exit receipt exactly that way.
    Start-Sleep -Milliseconds 400
  }
  try { $pipe.Disconnect() } catch { }
}

Write-NmLedger -Entry @{
  kind = 'agent_stop'
  at = [DateTime]::UtcNow.ToString('o')
  desktop = $DesktopName
  agent_pid = $PID
  reason = 'loop_finished'
  job_created = $script:nmJobCreated
}

# The job handle is NOT released here, and that is deliberate.
#
# It used to be, with a comment about closing the handle being what terminates the members - and
# that is true, but doing it HERE meant the agent killed ITSELF while the caller was still reading the
# answer to the exit request. Measured: every exit came back as "read EPIPE" instead of the receipt
# that had actually been sent, and a caller had no way to tell a clean shutdown from a crash. Nothing
# is lost by removing it: this process is about to terminate, the kernel closes every handle it holds
# as it does so, and KILL_ON_JOB_CLOSE fires on the last handle closing however that happens. The
# members still die with the agent; the caller now finds out first.
exit 0
