[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    [switch]$SkipBuild
)

# Installs only the formal mobile package while proving that adb's update path
# preserves every persisted application file.  It intentionally never reads
# file contents: the fingerprint is computed on-device from paths + SHA-256.
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$androidRoot = Join-Path $repoRoot 'android'
$packageName = 'com.newmark.mobile'
$component = 'com.newmark.mobile/.MainActivity'
$apkPath = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
$adb = (Get-Command adb -ErrorAction Stop).Source

function Get-AppDataFingerprint {
    $paths = @(& $adb -s $Serial shell run-as $packageName find files shared_prefs -type f 2>$null |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { throw "Unable to enumerate private data for $packageName" }
    $rows = foreach ($path in $paths) {
        $row = @(& $adb -s $Serial shell run-as $packageName sha256sum $path 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($row)) {
            throw "Unable to fingerprint protected private file"
        }
        "$path`t$($row.Split()[0])"
    }
    $canonical = ($rows | Sort-Object) -join "`n"
    [pscustomobject]@{
        Count = $paths.Count
        Digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical)))
    }
}

if ((& $adb devices) -notmatch "^$([regex]::Escape($Serial))\s+device$") {
    $deviceRow = (& $adb devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device$" } | Select-Object -First 1)
    if (-not $deviceRow) { throw "Device $Serial is not connected" }
}
if (-not $SkipBuild) {
    Push-Location $androidRoot
    try {
        & .\gradlew.bat :app:assembleDebug
        if ($LASTEXITCODE -ne 0) { throw "assembleDebug failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath $apkPath)) { throw "Debug APK not found: $apkPath" }

$before = Get-AppDataFingerprint
& $adb -s $Serial install -r $apkPath
if ($LASTEXITCODE -ne 0) { throw "APK update failed with exit code $LASTEXITCODE" }
$afterInstall = Get-AppDataFingerprint
if ($before.Count -ne $afterInstall.Count -or $before.Digest -ne $afterInstall.Digest) {
    throw 'Refusing to start updated app: formal mobile private data changed during adb install -r.'
}

& $adb -s $Serial shell am force-stop $packageName
& $adb -s $Serial shell am start -n $component | Out-Null
Start-Sleep -Seconds 2
$version = (& $adb -s $Serial shell dumpsys package $packageName | Select-String -Pattern 'versionName=|versionCode=' | ForEach-Object { $_.Line.Trim() }) -join '; '
$appPid = (& $adb -s $Serial shell pidof $packageName).Trim()
if (-not $appPid) { throw 'Updated formal mobile app did not remain running' }
Write-Output "FORMAL_MOBILE_UPDATE_DATA_GUARD_PASS files=$($before.Count) version=$version pid=$appPid"
