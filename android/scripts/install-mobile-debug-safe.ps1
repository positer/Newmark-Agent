[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    [ValidateSet('Debug', 'Release')][string]$Variant = 'Debug',
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
$variantLower = $Variant.ToLowerInvariant()
$apkPath = Join-Path $androidRoot "app\build\outputs\apk\$variantLower\app-$variantLower.apk"
$adb = (Get-Command adb -ErrorAction Stop).Source

function Get-AppDataFingerprint {
    $runAsWorks = (& $adb -s $Serial shell run-as $packageName id 2>$null) -match "uid="
    $dataRoot = "/data/user/0/$packageName"
    $paths = if ($runAsWorks) {
        @(& $adb -s $Serial shell run-as $packageName find files shared_prefs -type f 2>$null)
    } else {
        # Optimized Release is intentionally non-debuggable. On the project
        # emulator (userdebug), use root only for path + SHA-256 metadata; file
        # contents are never copied or printed.
        & $adb -s $Serial root *> $null
        Start-Sleep -Milliseconds 400
        @(& $adb -s $Serial shell find "$dataRoot/files" "$dataRoot/shared_prefs" -type f 2>$null)
    }
    $paths = @($paths |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { throw "Unable to enumerate private data for $packageName" }
    $rows = foreach ($path in $paths) {
        $row = if ($runAsWorks) {
            @(& $adb -s $Serial shell run-as $packageName sha256sum $path 2>$null) -join "`n"
        } else {
            @(& $adb -s $Serial shell sha256sum $path 2>$null) -join "`n"
        }
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($row)) {
            throw "Unable to fingerprint protected private file"
        }
        "$path`t$($row.Split()[0])"
    }
    $canonical = ($rows | Sort-Object) -join "`n"
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $digestBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))
    } finally {
        $sha256.Dispose()
    }
    [pscustomobject]@{
        Count = $paths.Count
        Digest = ([BitConverter]::ToString($digestBytes)).Replace('-', '')
    }
}

if ((& $adb devices) -notmatch "^$([regex]::Escape($Serial))\s+device$") {
    $deviceRow = (& $adb devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device$" } | Select-Object -First 1)
    if (-not $deviceRow) { throw "Device $Serial is not connected" }
}
if (-not $SkipBuild) {
    Push-Location $androidRoot
    try {
        & .\gradlew.bat ":app:assemble$Variant"
        if ($LASTEXITCODE -ne 0) { throw "assemble$Variant failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath $apkPath)) { throw "$Variant APK not found: $apkPath" }

$before = Get-AppDataFingerprint
& $adb -s $Serial install -r $apkPath
if ($LASTEXITCODE -ne 0) { throw "APK update failed with exit code $LASTEXITCODE" }
$afterInstall = Get-AppDataFingerprint
if ($before.Count -ne $afterInstall.Count -or $before.Digest -ne $afterInstall.Digest) {
    throw 'Refusing to start updated app: formal mobile private data changed during adb install -r.'
}

# adb side-loading leaves the package at the `verify` compiler filter even
# though the Release APK contains assets/dexopt/baseline.prof. Install that
# profile and compile only its hot methods before measuring or handing the app
# back; otherwise every fresh process JIT-compiles the full Compose root and
# can hit Android's launch-timeout watchdog. This changes code artifacts only,
# never the protected files fingerprinted above.
if ($Variant -eq 'Release') {
    & $adb -s $Serial shell am force-stop $packageName
    & $adb -s $Serial shell am broadcast `
        -a androidx.profileinstaller.action.INSTALL_PROFILE `
        -n "$packageName/androidx.profileinstaller.ProfileInstallReceiver" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Baseline profile installation failed' }
    & $adb -s $Serial shell cmd package compile -f -m speed-profile $packageName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Baseline profile compilation failed' }
}

& $adb -s $Serial shell am force-stop $packageName
& $adb -s $Serial shell am start -n $component | Out-Null
Start-Sleep -Seconds 2
$version = (& $adb -s $Serial shell dumpsys package $packageName | Select-String -Pattern 'versionName=|versionCode=' | ForEach-Object { $_.Line.Trim() }) -join '; '
$appPid = ''
for ($attempt = 0; $attempt -lt 10 -and -not $appPid; $attempt++) {
    $pidOutput = @(& $adb -s $Serial shell pidof $packageName 2>$null) -join ''
    $appPid = $pidOutput.Trim()
    if (-not $appPid) { Start-Sleep -Milliseconds 300 }
}
if (-not $appPid) { throw 'Updated formal mobile app did not remain running' }
Write-Output "FORMAL_MOBILE_UPDATE_DATA_GUARD_PASS files=$($before.Count) version=$version pid=$appPid"
