[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    [string]$NewmarkCli = 'C:\Program Files\Newmark Agent\Newmark.exe'
)

# Restores the formal mobile app through its real PairInvite confirmation
# path. No token, URI, QR payload, provider setting, or private app content
# is written to stdout, a repository file, or archive. The one-time desktop
# pairing process is terminated in every exit path.
$ErrorActionPreference = 'Stop'
$packageName = 'com.newmark.mobile'
$component = 'com.newmark.mobile/com.newmark.mobile.MainActivity'
$adb = (Get-Command adb -ErrorAction Stop).Source
$pairOutput = [IO.Path]::GetTempFileName()
$pairError = [IO.Path]::GetTempFileName()
$pairProcess = $null

function Invoke-AmPairIntent([string]$PairUrl) {
    $escapedUrl = $PairUrl.Replace('"', '\"')
    $remote = 'am start -W -a android.intent.action.VIEW -d "' + $escapedUrl + '" -n "' + $component + '"'
    $output = & $adb -s $Serial shell $remote
    if ($LASTEXITCODE -ne 0) { throw "Android pairing intent failed: $output" }
}

try {
    $deviceRow = (& $adb devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device$" } | Select-Object -First 1)
    if (-not $deviceRow) { throw "Device $Serial is not connected" }
    if (-not (Test-Path -LiteralPath $NewmarkCli)) { throw 'Newmark desktop CLI was not found' }

    $pairProcess = Start-Process -FilePath $NewmarkCli -ArgumentList @('pair') -WindowStyle Hidden -RedirectStandardOutput $pairOutput -RedirectStandardError $pairError -PassThru
    $deadline = (Get-Date).AddSeconds(20)
    $pairUri = $null
    do {
        Start-Sleep -Milliseconds 200
        $text = Get-Content -LiteralPath $pairOutput -Raw -ErrorAction SilentlyContinue
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            $match = [regex]::Match($text, 'Pairing URL:\s*(newmark-pair://\S+)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($match.Success) { $pairUri = [Uri]$match.Groups[1].Value }
        }
    } while ($null -eq $pairUri -and (Get-Date) -lt $deadline -and -not $pairProcess.HasExited)
    if ($null -eq $pairUri) { throw 'Desktop pairing session did not become available' }

    # The Android emulator reaches the Windows host through 10.0.2.2. Keep
    # the opaque query (token + pairing id) untouched, but use the emulator's
    # host alias only for the local transport destination.
    $port = if ($pairUri.Port -gt 0) { $pairUri.Port } else { 47890 }
    $emulatorPairUri = "newmark-pair://10.0.2.2:$port$($pairUri.Query)"
    & $adb -s $Serial shell am force-stop $packageName | Out-Null
    Invoke-AmPairIntent $emulatorPairUri

    # A formal Release is intentionally non-debuggable, so `run-as` cannot be
    # used as its persistence oracle.  Keep the private-file probe for a
    # debuggable build, but use the desktop pairing session's successful exit
    # as the authoritative confirmation for a Release build.
    $packageDump = (& $adb -s $Serial shell dumpsys package $packageName | Out-String)
    $debuggable = $packageDump -match '\bDEBUGGABLE\b'
    $saved = -not $debuggable
    if ($debuggable) {
        $savedDeadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            & $adb -s $Serial shell run-as $packageName ls files/newmark/pairs.json *> $null
            $saved = $LASTEXITCODE -eq 0
        } while (-not $saved -and (Get-Date) -lt $savedDeadline)
    }

    $null = $pairProcess.WaitForExit(10000)
    if (-not $pairProcess.HasExited) { throw 'Desktop pairing confirmation did not complete' }
    if ($pairProcess.ExitCode -ne 0) { throw 'Desktop pairing confirmation failed' }
    if (-not $saved) { throw 'Formal mobile app did not persist the recovered desktop pairing' }
    & $adb -s $Serial shell am start -n $component | Out-Null
    Start-Sleep -Seconds 2
    $appPid = (& $adb -s $Serial shell pidof $packageName).Trim()
    if (-not $appPid) { throw 'Formal mobile app did not remain running after pairing' }
    Write-Output 'FORMAL_MOBILE_PAIR_RESTORED'
}
finally {
    if ($pairProcess -and -not $pairProcess.HasExited) { Stop-Process -Id $pairProcess.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pairOutput, $pairError -Force -ErrorAction SilentlyContinue
}
