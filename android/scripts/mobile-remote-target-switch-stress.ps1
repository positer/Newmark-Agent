param(
    [string]$Serial = 'emulator-5554',
    [int]$Port = 47991,
    [int]$SwitchCycles = 2,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$archiveRoot = Join-Path $repoRoot 'archive'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportPath = Join-Path $archiveRoot "mobile-remote-target-switch-$stamp.json"
$fixtureOut = Join-Path $archiveRoot "_mobile-target-switch-$stamp.out.log"
$fixtureErr = Join-Path $archiveRoot "_mobile-target-switch-$stamp.err.log"
$uiDumpPath = Join-Path $archiveRoot "_mobile-target-switch-$stamp.xml"
$adb = (Get-Command adb -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source
$packageName = 'com.newmark.mobile.stress'
$component = 'com.newmark.mobile.stress/com.newmark.mobile.MainActivity'
$formalComponent = 'com.newmark.mobile/com.newmark.mobile.MainActivity'
$token = 'mobile-stress-token'
$pairUrl = "newmark-pair://10.0.2.2:${Port}?token=$token"
$apkPath = Join-Path $repoRoot 'android\app\build\outputs\apk\stress\app-stress.apk'
$fixtureScript = Join-Path $repoRoot 'DESKTOP\scripts\mobile-mock-server.cjs'
$fixtureProcess = $null
$initialPid = ''
$result = [ordered]@{
    timestamp = (Get-Date).ToString('o')
    serial = $Serial
    switchCycles = $SwitchCycles
    status = 'running'
    initialPid = ''
    finalPid = ''
    targetReads = @()
    errors = @()
    gates = [ordered]@{}
}

function Invoke-Adb([string[]]$Arguments) {
    $output = & $adb -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Arguments -join ' ')`n$($output -join "`n")" }
    return $output
}

function Get-UiXml {
    $remotePath = '/sdcard/newmark-target-switch.xml'
    Invoke-Adb @('shell', 'uiautomator', 'dump', $remotePath) | Out-Null
    $text = (Invoke-Adb @('exec-out', 'cat', $remotePath)) -join "`n"
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'Android UI hierarchy dump was empty' }
    $text | Set-Content -LiteralPath $uiDumpPath -Encoding utf8
    return [xml]$text
}

function Get-TextNode($Xml, [string]$Text) {
    return @($Xml.SelectNodes("//*[@text='$Text']")) | Select-Object -First 1
}

function Get-DescriptionNode($Xml, [string]$Description) {
    return @($Xml.SelectNodes("//*[@content-desc='$Description']")) | Select-Object -First 1
}

function Get-ContainingTextNode($Xml, [string]$Text) {
    return @($Xml.SelectNodes("//*[contains(@text,'$Text')]")) | Select-Object -First 1
}

function Tap-Node($Node, [string]$Label) {
    if ($null -eq $Node) { throw "UI node not found: $Label" }
    $match = [regex]::Match([string]$Node.bounds, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    if (-not $match.Success) { throw "Invalid bounds for $Label" }
    $x = [int](([int]$match.Groups[1].Value + [int]$match.Groups[3].Value) / 2)
    $y = [int](([int]$match.Groups[2].Value + [int]$match.Groups[4].Value) / 2)
    Invoke-Adb @('shell', 'input', 'tap', "$x", "$y") | Out-Null
}

function Open-RemoteConversation([string]$WorkspaceName, [string]$ConversationTitle) {
    $xml = Get-UiXml
    $workspaceNode = Get-TextNode $xml $WorkspaceName
    if ($null -eq $workspaceNode) {
        $menuNode = Get-DescriptionNode $xml '菜单'
        if ($null -ne $menuNode) {
            Tap-Node $menuNode '菜单'
            Start-Sleep -Milliseconds 650
            $xml = Get-UiXml
            $workspaceNode = Get-TextNode $xml $WorkspaceName
        }
    }
    if ($null -eq $workspaceNode) {
        Tap-Node (Get-TextNode $xml 'Mobile Stress Mock') 'paired fixture device'
        Start-Sleep -Milliseconds 650
        $xml = Get-UiXml
        $workspaceNode = Get-TextNode $xml $WorkspaceName
    }
    Tap-Node $workspaceNode $WorkspaceName
    Start-Sleep -Milliseconds 850
    $xml = Get-UiXml
    Tap-Node (Get-ContainingTextNode $xml $ConversationTitle) $ConversationTitle
    Start-Sleep -Milliseconds 1400
    $xml = Get-UiXml
    $drawerStillVisible = $null -ne (Get-TextNode $xml '设备') -and $null -eq (Get-DescriptionNode $xml '菜单')
    if ($drawerStillVisible) {
        Invoke-Adb @('shell', 'input', 'keyevent', '4') | Out-Null
        Start-Sleep -Milliseconds 700
    }
}

function Assert-Contains($Xml, [string]$Text, [string]$Stage) {
    if (@($Xml.SelectNodes("//*[contains(@text,'$Text')]")).Count -eq 0) {
        throw "$Stage did not render '$Text'"
    }
}

function Assert-Omits($Xml, [string]$Text, [string]$Stage) {
    if (@($Xml.SelectNodes("//*[contains(@text,'$Text')]")).Count -gt 0) {
        throw "$Stage leaked '$Text'"
    }
}

try {
    $device = & $adb devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device$" } | Select-Object -First 1
    if (-not $device) { throw "Device $Serial is not connected" }
    if (-not $SkipInstall) {
        if (-not (Test-Path -LiteralPath $apkPath)) { throw "Stress APK missing: $apkPath" }
        Invoke-Adb @('install', '-r', $apkPath) | Out-Null
    }

    Invoke-Adb @('shell', 'am', 'force-stop', $packageName) | Out-Null
    Invoke-Adb @('shell', 'run-as', $packageName, 'rm', '-f', 'files/newmark/pairs.json') | Out-Null
    $env:NEWMARK_MOBILE_MOCK_PORT = "$Port"
    $env:NEWMARK_MOBILE_MOCK_TOKEN = $token
    $fixtureProcess = Start-Process -FilePath $node -ArgumentList "`"$fixtureScript`"" -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $fixtureOut -RedirectStandardError $fixtureErr -PassThru
    $deadline = (Get-Date).AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 150
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 1 } catch { $health = $null }
    } while ($null -eq $health -and (Get-Date) -lt $deadline)
    if ($null -eq $health) { throw 'Fixture did not become ready' }

    Invoke-Adb @('logcat', '-c') | Out-Null
    $remoteStart = 'am start -W -a android.intent.action.VIEW -d "' + $pairUrl + '" -n "' + $component + '"'
    Invoke-Adb @('shell', $remoteStart) | Out-Null
    $deadline = (Get-Date).AddSeconds(35)
    do {
        Start-Sleep -Milliseconds 250
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 2
    } while ($health.sseConnections -lt 1 -and (Get-Date) -lt $deadline)
    if ($health.sseConnections -lt 1) { throw 'SSE connection was not established' }
    $initialPid = (Invoke-Adb @('shell', 'pidof', $packageName) | Select-Object -First 1).Trim()
    $result.initialPid = $initialPid
    if (-not $initialPid) { throw 'Stress app process is not alive after pairing' }

    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/burst?count=1000&intervalMs=150" -TimeoutSec 5 | Out-Null
    Start-Sleep -Seconds 2
    for ($cycle = 1; $cycle -le $SwitchCycles; $cycle++) {
        Open-RemoteConversation 'Secondary static workspace' 'Secondary static conversation'
        $secondary = Get-UiXml
        Assert-Contains $secondary 'SECONDARY_TARGET_ONLY_MARKER' "cycle $cycle secondary"
        Assert-Contains $secondary 'SECONDARY_TARGET_GOAL' "cycle $cycle secondary"
        Assert-Omits $secondary 'Stress Goal' "cycle $cycle secondary"
        Assert-Omits $secondary 'Flow prompt remains visible' "cycle $cycle secondary"
        Assert-Omits $secondary '处理中' "cycle $cycle secondary"

        Open-RemoteConversation 'Primary live workspace' 'Primary live conversation'
        $primary = Get-UiXml
        Assert-Contains $primary 'Stress Goal' "cycle $cycle primary"
        Assert-Contains $primary 'Flow prompt remains visible' "cycle $cycle primary"
        Assert-Contains $primary '处理中' "cycle $cycle primary"
        Assert-Omits $primary 'SECONDARY_TARGET_ONLY_MARKER' "cycle $cycle primary"
    }

    $finalPid = (Invoke-Adb @('shell', 'pidof', $packageName) | Select-Object -First 1).Trim()
    $result.finalPid = $finalPid
    $stats = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__stress/stats" -TimeoutSec 3
    $result.targetReads = @($stats.targetReads)
    $fatal = @(& $adb -s $Serial logcat -d -v brief | Select-String -Pattern 'FATAL EXCEPTION|ANR in com\.newmark\.mobile\.stress|Process: com\.newmark\.mobile\.stress' | ForEach-Object { $_.Line })
    $primaryReads = @($stats.targetReads | Where-Object { $_.workspaceId -eq 'mobile-stress-workspace' -and $_.conversationId -eq 'mobile-stress-conversation' })
    $secondaryReads = @($stats.targetReads | Where-Object { $_.workspaceId -eq 'mobile-stress-workspace-b' -and $_.conversationId -eq 'mobile-stress-conversation-b' })
    $result.gates = [ordered]@{
        pidStable = $initialPid -and $initialPid -eq $finalPid
        noFatalOrAnr = $fatal.Count -eq 0
        primaryTargetRead = $primaryReads.Count -ge $SwitchCycles
        secondaryTargetRead = $secondaryReads.Count -ge $SwitchCycles
        sseRemainedConnected = $stats.sseConnections -ge 1 -and $stats.sseDisconnects -eq 0
        liveRunStillActive = $stats.activeBursts -eq 1
    }
    $failed = @($result.gates.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    if ($failed.Count -gt 0) { throw "Target-switch gates failed: $($failed -join ', ')" }
    $result.status = 'complete'
}
catch {
    $result.status = 'failed'
    $result.errors = @($result.errors) + $_.Exception.Message
    throw
}
finally {
    if ($fixtureProcess -and -not $fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue }
    & $adb -s $Serial shell am force-stop $packageName | Out-Null
    & $adb -s $Serial shell am start -n $formalComponent | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
    Write-Output "MOBILE_TARGET_SWITCH_REPORT=$reportPath"
}
