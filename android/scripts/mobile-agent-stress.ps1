[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    [int]$Port = 47991,
    [ValidateRange(10, 1000)][int]$BurstCount = 120,
    [ValidateRange(1, 300)][int]$UiLoops = 60,
    [switch]$KeepMockPair,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$archiveRoot = Join-Path $repoRoot 'archive'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportPath = Join-Path $archiveRoot "mobile-stress-$stamp.json"
$mockLogPath = Join-Path $archiveRoot "_mobile-mock-$stamp.log"
$mockErrorPath = Join-Path $archiveRoot "_mobile-mock-$stamp.err.log"
$uiDumpPath = Join-Path $archiveRoot "_mobile-stress-ui-$stamp.xml"
$apkPath = Join-Path $repoRoot 'android\app\build\outputs\apk\stress\app-stress.apk'
$mockScript = Join-Path $repoRoot 'DESKTOP\scripts\mobile-mock-server.cjs'
$adb = (Get-Command adb -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source
# The stress build is a fully isolated Android package.  It must never
# install over, move, remove, read, or restore the user's formal mobile app
# data (pairings, providers, drafts, local conversations or preferences).
$packageName = 'com.newmark.mobile.stress'
# The application id changes for the stress variant, while the Kotlin
# namespace (and therefore the concrete Activity class) stays unchanged.
$component = 'com.newmark.mobile.stress/com.newmark.mobile.MainActivity'
$token = 'mobile-stress-token'
# The deterministic fixture does not require a desktop pairing-window id.
# Keeping the URL to one query field prevents Windows adb/remote-shell
# parsing from treating an ampersand as command chaining.
$pairUrl = "newmark-pair://10.0.2.2:${Port}?token=$token"
$mockProcess = $null
$result = [ordered]@{
    timestamp = (Get-Date).ToString('o')
    serial = $Serial
    apk = @{}
    fixture = 'local-mobile-stress'
    burstCount = $BurstCount
    uiLoops = $UiLoops
    status = 'running'
    mock = $null
    launch = @{}
    graphics = @{}
    memory = @{}
    errors = @()
    warnings = @()
    gates = [ordered]@{}
}

function Invoke-Adb([string[]]$Arguments) {
    & $adb -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Arguments -join ' ')" }
}

function Invoke-AmViewIntent([string]$DataUrl, [string]$TargetComponent) {
    # `adb shell` invokes a remote shell. Quote the URL there, otherwise the
    # `&pairingId=…` query segment is interpreted as a second shell command.
    $escapedUrl = $DataUrl.Replace('"', '\"')
    $escapedComponent = $TargetComponent.Replace('"', '\"')
    $remote = 'am start -W -a android.intent.action.VIEW -d "' + $escapedUrl + '" -n "' + $escapedComponent + '"'
    $output = & $adb -s $Serial shell $remote
    if ($LASTEXITCODE -ne 0) { throw "am view intent failed: $output" }
    return ($output -join "`n")
}

function Test-AppPrivateFile([string]$Path) {
    # `adb shell run-as <package> <command>` transports argv directly. Avoid
    # `sh -c`: it is split differently by adb on Windows and previously made
    # the pairing backup silently fail.
    & $adb -s $Serial shell run-as $packageName ls $Path *> $null
    return $LASTEXITCODE -eq 0
}

function Read-GfxMetrics {
    $text = (& $adb -s $Serial shell dumpsys gfxinfo $packageName) -join "`n"
    $frames = [regex]::Match($text, 'Total frames rendered:\s*(\d+)').Groups[1].Value
    $jank = [regex]::Match($text, 'Janky frames:\s*(\d+)\s*\(([\d.]+)%\)').Groups
    $p90 = [regex]::Match($text, '90th percentile:\s*(\d+)ms').Groups[1].Value
    return [ordered]@{
        totalFrames = if ($frames) { [int]$frames } else { 0 }
        jankyFrames = if ($jank[1].Value) { [int]$jank[1].Value } else { 0 }
        jankyPercent = if ($jank[2].Value) { [double]$jank[2].Value } else { 0 }
        p90Ms = if ($p90) { [int]$p90 } else { 0 }
    }
}

function Reset-GfxMetrics {
    # This emulator's `cmd gfxinfo` service reports "No shell command
    # implementation."  `dumpsys gfxinfo <package> reset` is supported here:
    # it prints the *old* snapshot, then advances `Stats since` for the next
    # read.  Verify that advancement so no stale startup/JIT data can enter
    # the measured interaction window.
    $beforeText = (& $adb -s $Serial shell dumpsys gfxinfo $packageName) -join "`n"
    $beforeStats = [regex]::Match($beforeText, 'Stats since:\s*(\d+)').Groups[1].Value
    Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $packageName, 'reset') | Out-Null
    Start-Sleep -Milliseconds 120
    $afterText = (& $adb -s $Serial shell dumpsys gfxinfo $packageName) -join "`n"
    $afterStats = [regex]::Match($afterText, 'Stats since:\s*(\d+)').Groups[1].Value
    if ([string]::IsNullOrWhiteSpace($afterStats) -or $afterStats -eq $beforeStats) {
        throw 'Unable to establish a fresh gfxinfo sampling window'
    }
}

function Get-ForegroundPackage {
    $activityDump = (& $adb -s $Serial shell dumpsys activity activities) -join "`n"
    # Android 15 emulator output names this `topResumedActivity` / `ResumedActivity`
    # (no `mResumedActivity` prefix).  Capture the package immediately after
    # the user id, before the activity component separator.
    $resumed = [regex]::Match(
        $activityDump,
        '(?:mResumedActivity|topResumedActivity|ResumedActivity)\s*[:=].*?\bu\d+\s+([A-Za-z0-9._]+)/(?:[A-Za-z0-9._$]+)'
    ).Groups[1].Value
    if ($resumed) { return $resumed }
    $windowDump = (& $adb -s $Serial shell dumpsys window windows) -join "`n"
    return [regex]::Match($windowDump, '(?:mCurrentFocus|mFocusedApp)=.*?\bu\d+\s+([A-Za-z0-9._]+)/').Groups[1].Value
}

function Assert-AppForeground([string]$Stage) {
    $foreground = Get-ForegroundPackage
    if ($foreground -ne $packageName) {
        throw "$Stage left the fixture app foreground (actual: $foreground)"
    }
}

function Get-UiXml {
    $remotePath = '/sdcard/newmark-mobile-stress-window.xml'
    & $adb -s $Serial shell uiautomator dump $remotePath *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to dump Android UI hierarchy' }
    $xmlText = (& $adb -s $Serial exec-out cat $remotePath) -join "`n"
    if ([string]::IsNullOrWhiteSpace($xmlText)) { throw 'Android UI hierarchy dump was empty' }
    Set-Content -LiteralPath $uiDumpPath -Value $xmlText -Encoding utf8
    return [xml]$xmlText
}

function Get-UiNodeByDescription([string]$ContentDescription) {
    $xml = Get-UiXml
    return @($xml.SelectNodes("//*[@content-desc='$ContentDescription']")) | Select-Object -First 1
}

function Get-UiNodeByText([string]$Text) {
    $xml = Get-UiXml
    return @($xml.SelectNodes("//*[@text='$Text']")) | Select-Object -First 1
}

function Get-UiEditText {
    $xml = Get-UiXml
    return @($xml.SelectNodes("//*[@class='android.widget.EditText']")) | Select-Object -First 1
}

function Invoke-UiTapNode($Node, [string]$Label) {
    if ($null -eq $Node) { throw "Android UI node not found: $Label" }
    $bounds = [regex]::Match([string]$Node.bounds, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    if (-not $bounds.Success) { throw "Android UI node has invalid bounds: $Label" }
    $left = [int]$bounds.Groups[1].Value
    $top = [int]$bounds.Groups[2].Value
    $right = [int]$bounds.Groups[3].Value
    $bottom = [int]$bounds.Groups[4].Value
    $x = [int](($left + $right) / 2)
    $y = [int](($top + $bottom) / 2)
    Invoke-Adb @('shell', 'input', 'tap', "$x", "$y")
}

function Wait-ForUiNode([scriptblock]$Find, [string]$Label, [int]$TimeoutMs = 3000) {
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    do {
        $node = & $Find
        if ($null -ne $node) { return $node }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for Android UI node: $Label"
}

function Wait-ForMockSend {
    $deadline = (Get-Date).AddSeconds(8)
    do {
        $stats = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 2
        if ($stats.sends -ge 1) { return $stats }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    throw 'Remote fixture send was not received by the mock server'
}

try {
    # `-notmatch` applied to an array returns all non-matching rows (including
    # the adb header), which made a connected device look offline. Inspect the
    # selected device row instead.
    $deviceRow = (& $adb devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device$" } | Select-Object -First 1)
    if (-not $deviceRow) { throw "Device $Serial is not connected" }
    if (-not $SkipInstall) {
        if (-not (Test-Path -LiteralPath $apkPath)) { throw "Debug APK not found: $apkPath" }
        Invoke-Adb @('install', '-r', $apkPath)
    }
    $version = (& $adb -s $Serial shell dumpsys package $packageName | Select-String -Pattern 'versionName=|versionCode=' | ForEach-Object { $_.Line.Trim() }) -join '; '
    $result.apk.version = ($version -replace '\s+', ' ').Trim()

    # The fixture package owns its own private storage. No production data is
    # backed up, moved, read, or changed by this script.
    Invoke-Adb @('shell', 'run-as', $packageName, 'mkdir', '-p', 'files/newmark')
    Invoke-Adb @('shell', 'run-as', $packageName, 'rm', '-f', 'files/newmark/pairs.json.stress')
    Invoke-Adb @('shell', 'run-as', $packageName, 'rm', '-f', 'files/newmark/pairs.json')

    $env:NEWMARK_MOBILE_MOCK_PORT = "$Port"
    $env:NEWMARK_MOBILE_MOCK_TOKEN = $token
    # PowerShell refuses one shared target for stdout/stderr. Keep separate
    # fixture-only logs so a failed mock launch remains diagnosable without
    # preventing the pressure suite from starting.
    $mockProcess = Start-Process -FilePath $node -ArgumentList "`"$mockScript`"" -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $mockLogPath -RedirectStandardError $mockErrorPath -PassThru
    $deadline = (Get-Date).AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 150
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 1 } catch { $health = $null }
    } while ($null -eq $health -and (Get-Date) -lt $deadline)
    if ($null -eq $health) { throw 'Mobile mock server did not become ready' }

    Invoke-Adb @('logcat', '-c')
    Invoke-Adb @('shell', 'am', 'force-stop', $packageName)
    # The stress and formal packages share the public pairing scheme. Target
    # the isolated component explicitly so Android never routes a fixture
    # pairing request into the user's formal application.
    $launchOutput = Invoke-AmViewIntent -DataUrl $pairUrl -TargetComponent $component
    $result.launch.totalMs = [int]([regex]::Match($launchOutput, 'TotalTime:\s*(\d+)').Groups[1].Value)
    $sseDeadline = (Get-Date).AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 200
        $connectionStats = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 2
    } while ($connectionStats.sseConnections -lt 1 -and (Get-Date) -lt $sseDeadline)
    if ($connectionStats.sseConnections -lt 1) { throw 'Remote pairing/state hydration did not establish an SSE connection' }
    # The initial Compose/JIT pass is a startup metric, not an interaction
    # metric. Reset after the remote snapshot is rendered before evaluating UI
    # pressure frames.
    Assert-AppForeground 'Remote hydration'
    Reset-GfxMetrics
    Start-Sleep -Seconds 1

    # SSE burst includes deliberate duplicate start/text/done messages.
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/burst?count=$BurstCount" -TimeoutSec 20 | Out-Null
    Start-Sleep -Seconds 2

    # Remote send and high-frequency menu/open-close work stress the Compose
    # input, popup, gesture and event paths without any external provider.
    Assert-AppForeground 'SSE burst'
    $input = Wait-ForUiNode -Find ${function:Get-UiEditText} -Label 'chat input'
    Invoke-UiTapNode -Node $input -Label 'chat input'
    Invoke-Adb @('shell', 'input', 'text', 'fixture-stress')
    $send = Wait-ForUiNode -Find { Get-UiNodeByDescription '发送' } -Label '发送'
    Invoke-UiTapNode -Node $send -Label '发送'
    Wait-ForMockSend | Out-Null
    for ($i = 0; $i -lt $UiLoops; $i++) {
        Assert-AppForeground "UI loop $i precondition"
        $model = Wait-ForUiNode -Find { Get-UiNodeByDescription '模型' } -Label '模型'
        Invoke-UiTapNode -Node $model -Label '模型'
        Wait-ForUiNode -Find { Get-UiNodeByText '模型选择' } -Label '模型选择菜单' | Out-Null
        # Back is only valid once the popup is proven visible.  This keeps a
        # locator failure from navigating the fixture Activity to the launcher.
        Invoke-Adb @('shell', 'input', 'keyevent', '4')
        Assert-AppForeground "UI loop $i model menu"
        if (($i % 3) -eq 0) {
            Invoke-Adb @('shell', 'input', 'swipe', '900', '1180', '200', '1180', '110')
            Assert-AppForeground "UI loop $i right-sidebar swipe"
        }
        if (($i % 5) -eq 0) {
            Invoke-Adb @('shell', 'input', 'swipe', '530', '1800', '530', '600', '140')
            Invoke-Adb @('shell', 'input', 'swipe', '530', '700', '530', '1800', '140')
        }
    }
    Start-Sleep -Seconds 2

    $result.mock = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 5
    $result.graphics = Read-GfxMetrics
    $mem = (& $adb -s $Serial shell dumpsys meminfo $packageName) -join "`n"
    $result.memory.totalPssKb = [int]([regex]::Match($mem, 'TOTAL PSS:\s*(\d+)').Groups[1].Value)
    $fatalLines = @(& $adb -s $Serial logcat -d -v brief | Select-String -Pattern 'AndroidRuntime|FATAL EXCEPTION|ANR in' | ForEach-Object { $_.Line } | Select-Object -Last 50)
    $skippedFrames = @(& $adb -s $Serial logcat -d -v brief | Select-String -Pattern 'Skipped [0-9]+ frames' | ForEach-Object { $_.Line } | Select-Object -Last 50)
    if ($fatalLines.Count -gt 0) { $result.errors = $fatalLines }
    if ($skippedFrames.Count -gt 0) { $result.warnings = $skippedFrames }

    $result.gates = [ordered]@{
        sseConnected = $result.mock.sseConnections -ge 1
        sseBurstObserved = $result.mock.bursts -ge 1 -and $result.mock.emittedEvents -gt $BurstCount
        duplicateFixtureObserved = $result.mock.duplicateEvents -ge 1
        remoteSendObserved = $result.mock.sends -ge 1
        noFatalOrAnr = $result.errors.Count -eq 0
        uiFramesCaptured = $result.graphics.totalFrames -gt 0
    }
    $failedGates = @($result.gates.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    if ($failedGates.Count -gt 0) { throw "Pressure gates failed: $($failedGates -join ', ')" }
    $result.status = 'complete'
}
catch {
    $result.status = 'failed'
    $result.errors = @($result.errors) + $_.Exception.Message
    throw
}
finally {
    if ($mockProcess -and -not $mockProcess.HasExited) { Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue }
    if (-not $KeepMockPair) {
        & $adb -s $Serial shell am force-stop $packageName | Out-Null
        Invoke-Adb @('shell', 'run-as', $packageName, 'rm', '-f', 'files/newmark/pairs.json')
        & $adb -s $Serial shell am start -n $component | Out-Null
    }
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Output "MOBILE_STRESS_REPORT=$reportPath"
}
