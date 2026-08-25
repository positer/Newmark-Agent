param(
    [string]$Serial = 'emulator-5554',
    [int]$Port = 47991,
    [ValidateRange(10, 200)][int]$Cycles = 60,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$archiveRoot = Join-Path $repoRoot 'archive'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportPath = Join-Path $archiveRoot "mobile-queue-animation-benchmark-$stamp.json"
$fixtureOut = Join-Path $archiveRoot "_mobile-queue-benchmark-$stamp.out.log"
$fixtureErr = Join-Path $archiveRoot "_mobile-queue-benchmark-$stamp.err.log"
$preSampleDump = Join-Path $archiveRoot "_mobile-queue-benchmark-$stamp.xml"
$adb = (Get-Command adb -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source
$packageName = 'com.newmark.mobile.benchmark'
$component = 'com.newmark.mobile.benchmark/com.newmark.mobile.MainActivity'
$formalComponent = 'com.newmark.mobile/com.newmark.mobile.MainActivity'
$apkPath = Join-Path $repoRoot 'android\app\build\outputs\apk\benchmark\app-benchmark.apk'
$fixtureScript = Join-Path $repoRoot 'DESKTOP\scripts\mobile-mock-server.cjs'
$token = 'mobile-stress-token'
$pairUrl = "newmark-pair://10.0.2.2:${Port}?token=$token"
$fixtureProcess = $null
$batteryWhitelistInstalled = $false
$result = [ordered]@{
    timestamp = (Get-Date).ToString('o')
    serial = $Serial
    package = $packageName
    cycles = $Cycles
    observerFreeWindow = $true
    status = 'running'
    launchMs = 0
    pid = ''
    workload = @{}
    coordinates = @{}
    graphics = @{}
    memory = @{}
    errors = @()
    warnings = @()
    gates = [ordered]@{}
}

function Invoke-Adb([string[]]$Arguments) {
    $output = & $adb -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Arguments -join ' ')`n$($output -join "`n")" }
    return $output
}

function Get-GfxStatsSince {
    $text = (Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $packageName)) -join "`n"
    $jank = [regex]::Match($text, 'Janky frames:\s*(\d+)\s*\(([\d.]+)%\)').Groups
    return [ordered]@{
        totalFrames = [int]([regex]::Match($text, 'Total frames rendered:\s*(\d+)').Groups[1].Value)
        jankyFrames = [int]($jank[1].Value)
        jankyPercent = [double]($jank[2].Value)
        p50Ms = [int]([regex]::Match($text, '50th percentile:\s*(\d+)ms').Groups[1].Value)
        p90Ms = [int]([regex]::Match($text, '90th percentile:\s*(\d+)ms').Groups[1].Value)
        p95Ms = [int]([regex]::Match($text, '95th percentile:\s*(\d+)ms').Groups[1].Value)
        p99Ms = [int]([regex]::Match($text, '99th percentile:\s*(\d+)ms').Groups[1].Value)
    }
}

function Reset-GfxStats {
    $before = (Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $packageName)) -join "`n"
    $beforeSince = [regex]::Match($before, 'Stats since:\s*(\d+)').Groups[1].Value
    Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $packageName, 'reset') | Out-Null
    Start-Sleep -Milliseconds 150
    $after = (Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $packageName)) -join "`n"
    $afterSince = [regex]::Match($after, 'Stats since:\s*(\d+)').Groups[1].Value
    if (-not $afterSince -or $afterSince -eq $beforeSince) { throw 'Unable to establish a fresh gfxinfo window' }
}

function Read-QueueUiXml {
    $remote = '/sdcard/newmark-queue-benchmark.xml'
    Invoke-Adb @('shell', 'rm', '-f', $remote) | Out-Null
    & $adb -s $Serial shell uiautomator dump $remote *> $null
    $text = (& $adb -s $Serial exec-out cat $remote 2>$null) -join "`n"
    if ([string]::IsNullOrWhiteSpace($text) -or -not $text.TrimStart().StartsWith('<?xml')) { return $null }
    $text | Set-Content -LiteralPath $preSampleDump -Encoding utf8
    try { return [xml]$text } catch { return $null }
}

function Get-BoundsCenter([string]$Bounds, [string]$Label) {
    $match = [regex]::Match($Bounds, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    if (-not $match.Success) { throw "Invalid $Label bounds: $Bounds" }
    return [pscustomobject]@{
        x = [int](([int]$match.Groups[1].Value + [int]$match.Groups[3].Value) / 2)
        y = [int](([int]$match.Groups[2].Value + [int]$match.Groups[4].Value) / 2)
    }
}

function Find-QueueToggleCoordinates {
    $deadline = (Get-Date).AddSeconds(20)
    do {
        $xml = Read-QueueUiXml
        if ($null -eq $xml) { Start-Sleep -Milliseconds 250; continue }
        $node = @($xml.SelectNodes("//*[@content-desc='展开']")) | Select-Object -First 1
        if ($null -ne $node) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    if ($null -eq $node) { throw 'Queue expand control was not visible before the sample window' }
    $expand = Get-BoundsCenter ([string]$node.bounds) 'Queue expand control'
    Invoke-Adb @('shell', 'input', 'tap', "$($expand.x)", "$($expand.y)") | Out-Null
    Start-Sleep -Milliseconds 300

    $deadline = (Get-Date).AddSeconds(12)
    do {
        $xml = Read-QueueUiXml
        if ($null -eq $xml) { Start-Sleep -Milliseconds 250; continue }
        $node = @($xml.SelectNodes("//*[@content-desc='折叠']")) | Select-Object -First 1
        if ($null -ne $node) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    if ($null -eq $node) { throw 'Queue collapse control was not visible before the sample window' }
    $collapse = Get-BoundsCenter ([string]$node.bounds) 'Queue collapse control'
    Invoke-Adb @('shell', 'input', 'tap', "$($collapse.x)", "$($collapse.y)") | Out-Null
    Start-Sleep -Milliseconds 300
    return [pscustomobject]@{ expand = $expand; collapse = $collapse }
}

try {
    $device = & $adb devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device$" } | Select-Object -First 1
    if (-not $device) { throw "Device $Serial is not connected" }
    if (-not $SkipInstall) {
        if (-not (Test-Path -LiteralPath $apkPath)) { throw "Benchmark APK missing: $apkPath" }
        Invoke-Adb @('install', '-r', $apkPath) | Out-Null
    }
    if ([int]((& $adb -s $Serial shell getprop ro.build.version.sdk) -join '') -ge 33) {
        Invoke-Adb @('shell', 'pm', 'grant', $packageName, 'android.permission.POST_NOTIFICATIONS') | Out-Null
    }
    Invoke-Adb @('shell', 'dumpsys', 'deviceidle', 'whitelist', "+$packageName") | Out-Null
    $batteryWhitelistInstalled = $true

    $env:NEWMARK_MOBILE_MOCK_PORT = "$Port"
    $env:NEWMARK_MOBILE_MOCK_TOKEN = $token
    $fixtureProcess = Start-Process -FilePath $node -ArgumentList "`"$fixtureScript`"" -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $fixtureOut -RedirectStandardError $fixtureErr -PassThru
    $deadline = (Get-Date).AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 150
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 1 } catch { $health = $null }
    } while ($null -eq $health -and (Get-Date) -lt $deadline)
    if ($null -eq $health) { throw 'Fixture did not become ready' }

    Invoke-Adb @('shell', 'am', 'force-stop', $packageName) | Out-Null
    $remoteStart = 'am start -W -a android.intent.action.VIEW -d "' + $pairUrl + '" -n "' + $component + '"'
    $launch = (Invoke-Adb @('shell', $remoteStart)) -join "`n"
    $result.launchMs = [int]([regex]::Match($launch, 'TotalTime:\s*(\d+)').Groups[1].Value)
    $deadline = (Get-Date).AddSeconds(35)
    do {
        Start-Sleep -Milliseconds 250
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 2
    } while ($health.sseConnections -lt 1 -and (Get-Date) -lt $deadline)
    if ($health.sseConnections -lt 1) { throw 'Benchmark package did not establish SSE ownership' }
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/burst?count=600&intervalMs=100" -TimeoutSec 5 | Out-Null

    # This benchmark owns one variable: queue expand/collapse animation cost.
    # The broader mobile-agent-stress suite already measures behavior while the
    # 10 Hz remote stream is active. Wait for that stream to finish here so its
    # snapshot/layout work cannot contaminate gfxinfo or move fixed tap targets.
    $burstDeadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Milliseconds 500
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 2
    } while ($health.activeBursts -gt 0 -and (Get-Date) -lt $burstDeadline)
    if ($health.activeBursts -gt 0) { throw 'Remote stress burst did not settle before the animation sample window' }
    if ($health.lastBurstError) { throw "Remote stress burst failed: $($health.lastBurstError)" }
    $result.workload = [ordered]@{
        emittedEvents = [int]$health.emittedEvents
        completedBursts = [int]$health.completedBursts
        activeBursts = [int]$health.activeBursts
    }
    Start-Sleep -Milliseconds 750

    $toggleCoordinates = Find-QueueToggleCoordinates
    $result.coordinates = [ordered]@{
        expand = [ordered]@{ x = $toggleCoordinates.expand.x; y = $toggleCoordinates.expand.y }
        collapse = [ordered]@{ x = $toggleCoordinates.collapse.x; y = $toggleCoordinates.collapse.y }
    }

    # From this point through the gfxinfo read there is deliberately no
    # uiautomator, screenshot, hierarchy observer, or remote API polling from
    # the host. Only fixed-coordinate input events drive the 150 ms animation.
    Invoke-Adb @('logcat', '-c') | Out-Null
    Reset-GfxStats
    for ($i = 0; $i -lt $Cycles; $i++) {
        Invoke-Adb @('shell', 'input', 'tap', "$($toggleCoordinates.expand.x)", "$($toggleCoordinates.expand.y)") | Out-Null
        Start-Sleep -Milliseconds 220
        Invoke-Adb @('shell', 'input', 'tap', "$($toggleCoordinates.collapse.x)", "$($toggleCoordinates.collapse.y)") | Out-Null
        Start-Sleep -Milliseconds 220
    }
    Start-Sleep -Milliseconds 500
    $result.graphics = Get-GfxStatsSince
    $result.pid = ((Invoke-Adb @('shell', 'pidof', $packageName)) | Select-Object -First 1).Trim()
    $mem = (Invoke-Adb @('shell', 'dumpsys', 'meminfo', $packageName)) -join "`n"
    $result.memory = [ordered]@{
        totalPssKb = [int]([regex]::Match($mem, 'TOTAL PSS:\s*(\d+)').Groups[1].Value)
        totalRssKb = [int]([regex]::Match($mem, 'TOTAL RSS:\s*(\d+)').Groups[1].Value)
        swapKb = [int]([regex]::Match($mem, 'TOTAL SWAP \(KB\):\s*(\d+)').Groups[1].Value)
    }
    $log = (& $adb -s $Serial logcat -d -v brief) -join "`n"
    $result.errors = @($log -split "`n" | Where-Object { $_ -match 'FATAL EXCEPTION|ANR in com\.newmark\.mobile\.benchmark|Process: com\.newmark\.mobile\.benchmark|Fatal signal.*(?:newmark|mobile)|Cmdline: com\.newmark\.mobile\.benchmark|data_app_native_crash' })
    $result.warnings = @($log -split "`n" | Where-Object { $_ -match 'Skipped \d+ frames' })
    $result.gates = [ordered]@{
        optimizedIsolatedPackageAlive = -not [string]::IsNullOrWhiteSpace($result.pid)
        observerFreeFrameWindow = $result.graphics.totalFrames -ge ($Cycles * 2)
        noFatalOrAnr = $result.errors.Count -eq 0
        noSkippedFrameWarning = $result.warnings.Count -eq 0
        noSwap = $result.memory.swapKb -eq 0
    }
    $failed = @($result.gates.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    if ($failed.Count -gt 0) { throw "Queue animation gates failed: $($failed -join ', ')" }
    $result.status = 'complete'
}
catch {
    $result.status = 'failed'
    $result.errors = @($result.errors) + $_.Exception.Message
    throw
}
finally {
    if ($fixtureProcess -and -not $fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue }
    if ($batteryWhitelistInstalled) {
        & $adb -s $Serial shell dumpsys deviceidle whitelist "-$packageName" | Out-Null
    }
    & $adb -s $Serial shell am force-stop $packageName | Out-Null
    & $adb -s $Serial uninstall $packageName | Out-Null
    & $adb -s $Serial shell am start -n $formalComponent | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Output "MOBILE_QUEUE_ANIMATION_REPORT=$reportPath"
}
