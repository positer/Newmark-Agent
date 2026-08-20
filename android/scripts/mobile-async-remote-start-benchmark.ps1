param(
    [string]$Serial = 'emulator-5554',
    [int]$Port = 47991,
    [ValidateRange(3, 20)][int]$Cycles = 5,
    [ValidateRange(500, 10000)][int]$ServerDelayMs = 3000,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$archiveRoot = Join-Path $repoRoot 'archive'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportPath = Join-Path $archiveRoot "mobile-async-remote-start-benchmark-$stamp.json"
$adb = (Get-Command adb -ErrorAction Stop).Source
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$packageName = 'com.newmark.mobile.benchmark'
$component = 'com.newmark.mobile.benchmark/com.newmark.mobile.MainActivity'
$formalComponent = 'com.newmark.mobile/com.newmark.mobile.MainActivity'
$apkPath = Join-Path $repoRoot 'android\app\build\outputs\apk\benchmark\app-benchmark.apk'
$fixtureScript = Join-Path $repoRoot 'DESKTOP\scripts\mobile-mock-server.cjs'
$token = 'mobile-stress-token'
$pairUrl = "newmark-pair://10.0.2.2:${Port}?token=$token"
$fixtureProcess = $null
$rows = @()
$result = [ordered]@{
    timestamp = (Get-Date).ToString('o')
    serial = $Serial
    cycles = $Cycles
    serverDelayMs = $ServerDelayMs
    status = 'running'
    rows = @()
    errors = @()
    gates = [ordered]@{}
}

function Invoke-Adb([string[]]$Arguments) {
    $output = & $adb -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Arguments -join ' ')`n$($output -join "`n")" }
    return $output
}

function Start-Fixture([string]$Label) {
    $out = Join-Path $archiveRoot "_async-start-$stamp-$Label.out.log"
    $err = Join-Path $archiveRoot "_async-start-$stamp-$Label.err.log"
    $env:NEWMARK_MOBILE_MOCK_PORT = "$Port"
    $env:NEWMARK_MOBILE_MOCK_TOKEN = $token
    $script:fixtureProcess = Start-Process -FilePath $nodeExe -ArgumentList "`"$fixtureScript`"" -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    $deadline = (Get-Date).AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 100
        try { $stats = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 1 } catch { $stats = $null }
    } while ($null -eq $stats -and (Get-Date) -lt $deadline)
    if ($null -eq $stats) { throw "Fixture $Label did not become ready" }
    return $stats
}

function Stop-Fixture {
    if ($script:fixtureProcess -and -not $script:fixtureProcess.HasExited) {
        Stop-Process -Id $script:fixtureProcess.Id -Force -ErrorAction SilentlyContinue
        try { Wait-Process -Id $script:fixtureProcess.Id -Timeout 5 -ErrorAction SilentlyContinue } catch {}
    }
    $script:fixtureProcess = $null
    $deadline = (Get-Date).AddSeconds(5)
    do {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
        if (-not $listener) { return }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    throw "Fixture port $Port was not released"
}

try {
    $device = & $adb devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device$" } | Select-Object -First 1
    if (-not $device) { throw "Device $Serial is not connected" }
    if (-not $SkipInstall) {
        if (-not (Test-Path -LiteralPath $apkPath)) { throw "Benchmark APK missing: $apkPath" }
        Invoke-Adb @('install', '-r', $apkPath) | Out-Null
    }

    Start-Fixture 'pair' | Out-Null
    $pairCommand = 'am start -W -a android.intent.action.VIEW -d "' + $pairUrl + '" -n "' + $component + '"'
    Invoke-Adb @('shell', $pairCommand) | Out-Null
    $deadline = (Get-Date).AddSeconds(35)
    do {
        Start-Sleep -Milliseconds 200
        $pairStats = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 2
    } while ($pairStats.sseConnections -lt 1 -and (Get-Date) -lt $deadline)
    if ($pairStats.sseConnections -lt 1) { throw 'Initial persisted pairing did not establish SSE' }
    Stop-Fixture

    Invoke-Adb @('logcat', '-c') | Out-Null
    for ($cycle = 1; $cycle -le $Cycles; $cycle++) {
        Invoke-Adb @('shell', 'am', 'force-stop', $packageName) | Out-Null
        $launch = (Invoke-Adb @('shell', 'am', 'start', '-W', '-n', $component)) -join "`n"
        $launchMs = [int]([regex]::Match($launch, 'TotalTime:\s*(\d+)').Groups[1].Value)
        $pidBefore = ((Invoke-Adb @('shell', 'pidof', $packageName)) | Select-Object -First 1).Trim()
        if (-not $pidBefore) { throw "Cycle $cycle app process missing before server startup" }
        Start-Sleep -Milliseconds $ServerDelayMs
        $serverStarted = Get-Date
        Start-Fixture "cycle-$cycle" | Out-Null
        $deadline = (Get-Date).AddSeconds(25)
        do {
            Start-Sleep -Milliseconds 100
            $stats = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 2
        } while ($stats.sseConnections -lt 1 -and (Get-Date) -lt $deadline)
        $connectedMs = [int]((Get-Date) - $serverStarted).TotalMilliseconds
        $pidAfter = ((Invoke-Adb @('shell', 'pidof', $packageName)) | Select-Object -First 1).Trim()
        $row = [ordered]@{
            cycle = $cycle
            launchMs = $launchMs
            pidBeforeServer = $pidBefore
            pidAfterConnect = $pidAfter
            sseConnections = [int]$stats.sseConnections
            connectAfterServerMs = $connectedMs
            pidStable = $pidBefore -eq $pidAfter
        }
        $rows += $row
        if ($stats.sseConnections -lt 1) { throw "Cycle $cycle did not reconnect after delayed server start" }
        if ($pidBefore -ne $pidAfter) { throw "Cycle $cycle process restarted during asynchronous connection" }
        Stop-Fixture
        Start-Sleep -Seconds 4
        $pidAfterDisconnect = ((Invoke-Adb @('shell', 'pidof', $packageName)) | Select-Object -First 1).Trim()
        if ($pidAfterDisconnect -ne $pidAfter) { throw "Cycle $cycle process died after server shutdown" }
    }

    $log = (& $adb -s $Serial logcat -d -v brief) -join "`n"
    $fatal = @($log -split "`n" | Where-Object { $_ -match 'FATAL EXCEPTION|ANR in com\.newmark\.mobile\.benchmark|Process: com\.newmark\.mobile\.benchmark' })
    $result.rows = $rows
    $result.errors = $fatal
    $result.gates = [ordered]@{
        allCyclesConnected = @($rows | Where-Object { $_.sseConnections -lt 1 }).Count -eq 0
        allCyclePidsStable = @($rows | Where-Object { -not $_.pidStable }).Count -eq 0
        noFatalOrAnr = $fatal.Count -eq 0
        launchUnderFourSeconds = @($rows | Where-Object { $_.launchMs -gt 4000 }).Count -eq 0
        delayedConnectUnderEightSeconds = @($rows | Where-Object { $_.connectAfterServerMs -gt 8000 }).Count -eq 0
    }
    $failed = @($result.gates.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    if ($failed.Count -gt 0) { throw "Async-start gates failed: $($failed -join ', ')" }
    $result.status = 'complete'
}
catch {
    $result.status = 'failed'
    $result.rows = $rows
    $result.errors = @($result.errors) + $_.Exception.Message
    throw
}
finally {
    try { Stop-Fixture } catch { $result.errors = @($result.errors) + $_.Exception.Message }
    & $adb -s $Serial shell am force-stop $packageName | Out-Null
    & $adb -s $Serial uninstall $packageName | Out-Null
    & $adb -s $Serial shell am start -n $formalComponent | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Output "MOBILE_ASYNC_START_REPORT=$reportPath"
}
