<#
Installs a prepared Newmark machine MSI with one elevation and verifies its bytes.
Examples (invoke with PowerShell -File; paths are ordinary PowerShell strings):
  ./install-windows-msi.ps1 -MsiPath '../../release/Newmark-Agent-0.5.15-x64.msi' -PrepareOnly
  ./install-windows-msi.ps1 -RequestPath '../../archive/<run>/request.json'
Preparation extracts an isolated administrative image; it does not install a product.
The worker uses MsiInstallProductW, not a shell/msiexec command line. The coordinator
waits for the worker and verifies result.json. It never kills Windows Installer.
#>
[CmdletBinding()]
param(
    [string]$MsiPath,
    [string]$EvidenceDirectory,
    [string]$RequestPath,
    [switch]$PrepareOnly,
    [switch]$NoElevate,
    [switch]$Worker,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'

function Write-InstallJson($Path, $Value) {
    $temporary = $Path + '.tmp'
    [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Depth 12), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-InstallSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function ConvertTo-PowerShellLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

function ConvertTo-WindowsArgument([string]$Value) {
    # CommandLineToArgvW / CRT escaping, including trailing slashes and quotes.
    return '"' + ([regex]::Replace(([regex]::Replace($Value, '(\\*)"', '$1$1\"')), '(\\+)$', '$1$1')) + '"'
}

function ConvertTo-MsiProperty([string]$Name, [string]$Value) {
    if ($Name -notmatch '^[A-Z][A-Z0-9_]*$' -or $Value -match '["\r\n]') { throw 'Invalid MSI property' }
    # MSI property values use MSI parsing, not Windows argv backslash escaping.
    return $Name + '="' + $Value + '"'
}

function Initialize-NewmarkMsiApi {
    if ('NewmarkInstaller.Native' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace NewmarkInstaller {
  public static class Native {
    [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern uint MsiInstallProductW(string packagePath, string properties);
    [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern uint MsiConfigureProductExW(string productCode, int level, int state, string properties);
    [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    public static extern uint MsiEnableLogW(uint logMode, string logPath, uint logAttributes);
    [DllImport("msi.dll", ExactSpelling=true)]
    public static extern uint MsiSetInternalUI(uint uiLevel, IntPtr window);
  }
}
'@
}

function Test-InstallAdministrator {
    return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-MsiIdentity([string]$Path) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $null
    try {
        $database = $installer.OpenDatabase($Path, 0)
        $identity = [ordered]@{}
        foreach ($name in @('ProductName', 'ProductVersion', 'ProductCode', 'UpgradeCode', 'ALLUSERS')) {
            $view = $database.OpenView(('SELECT `Value` FROM `Property` WHERE `Property` = ''' + $name + ''''))
            try {
                [void]$view.Execute()
                $record = $view.Fetch()
                $identity[$name] = if ($record) { [string]$record.StringData(1) } else { '' }
                if ($record) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
            } finally {
                [void]$view.Close()
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
            }
        }
        $summary = $database.SummaryInformation(0)
        try { $identity.PackageCode = [string]$summary.Property(9) }
        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($summary) }
        return [pscustomobject]$identity
    } finally {
        if ($database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
    }
}

function Get-NewmarkRegistrations {
    foreach ($hive in @('HKLM', 'HKCU')) {
        foreach ($branch in @('Software\Microsoft\Windows\CurrentVersion\Uninstall', 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
            Get-ChildItem -LiteralPath ($hive + ':\' + $branch) -ErrorAction SilentlyContinue | ForEach-Object {
                $entry = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
                if ($entry.DisplayName -eq 'Newmark Agent') {
                    [pscustomobject]@{ Hive=$hive; ProductCode=$_.PSChildName; Version=$entry.DisplayVersion; InstallLocation=$entry.InstallLocation }
                }
            }
        }
    }
}

function Get-RegisteredMsiPackageCode([string]$ProductCode) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    try { return [string]$installer.ProductInfo($ProductCode, 'PackageCode') }
    finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
}

function Get-InstalledCliVersion([string]$Root, [string]$Evidence) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $Root 'Newmark.exe'
    $start.Arguments = (@('install-update', '--version', '--root', (Join-Path $Evidence 'isolated-cli-state')) |
        ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $process = [Diagnostics.Process]::Start($start)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) {
        # Only this isolated CLI smoke process, never Windows Installer.
        $process.Kill()
        throw 'Installed CLI version check timed out'
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    [IO.File]::WriteAllText((Join-Path $Evidence 'installed-cli.stdout.txt'), $stdout)
    [IO.File]::WriteAllText((Join-Path $Evidence 'installed-cli.stderr.txt'), $stderr)
    if ($process.ExitCode -ne 0) { throw "Installed CLI failed: $($process.ExitCode); see installed-cli.stderr.txt" }
    $reply = $stdout | ConvertFrom-Json
    if (-not $reply.ok -or -not $reply.version) { throw 'Installed CLI did not return a valid version result' }
    return $reply.version
}

function Get-InstallManifest([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($prefix)
    while ($pending.Count) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse point in verification boundary: $($entry.FullName)"
            }
            if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName) }
            else {
                [pscustomobject]@{ Path=$entry.FullName.Substring($prefix.Length); Bytes=$entry.Length; Sha256=(Get-InstallSha256 $entry.FullName) }
            }
        }
    }
}

function Test-InstallManifest([string]$Root, $Manifest) {
    foreach ($entry in $Manifest) {
        $path = Join-Path $Root $entry.Path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { "Missing: $($entry.Path)"; continue }
        if ((Get-Item -LiteralPath $path).Length -ne $entry.Bytes -or (Get-InstallSha256 $path) -ne $entry.Sha256) {
            "Changed: $($entry.Path)"
        }
    }
}

function Get-MsiExitMeaning([int]$Code) {
    switch ($Code) {
        0 { 'success' }
        3010 { 'success-reboot-required' }
        1618 { 'another-installation-running' }
        1639 { 'invalid-command-line' }
        1603 { 'fatal-installation-error-read-log' }
        1602 { 'installation-cancelled' }
        1625 { 'installation-forbidden-by-policy' }
        default { 'installer-error-' + $Code }
    }
}

function Invoke-NewmarkMsi([string]$Package, [string]$Properties, [string]$LogBase, [string]$RemoveProductCode) {
    Initialize-NewmarkMsiApi
    [void][NewmarkInstaller.Native]::MsiSetInternalUI(2, [IntPtr]::Zero)
    for ($attempt=1; $attempt -le 6; $attempt++) {
        $logPath = $LogBase + '-' + $attempt + '.log'
        # All documented log categories through verbose/extra-debug; flush each line.
        $logCode = [NewmarkInstaller.Native]::MsiEnableLogW(0x3FFF, $logPath, 2)
        if ($logCode -ne 0) { throw "Cannot enable MSI log: $logCode" }
        try {
            $code = if ($RemoveProductCode) {
                [NewmarkInstaller.Native]::MsiConfigureProductExW($RemoveProductCode, 0, 2, $Properties)
            } else {
                [NewmarkInstaller.Native]::MsiInstallProductW($Package, $Properties)
            }
        } finally { [void][NewmarkInstaller.Native]::MsiEnableLogW(0, $null, 0) }
        $step = [pscustomobject]@{ ExitCode=$code; Meaning=(Get-MsiExitMeaning $code); Log=$logPath; Attempt=$attempt }
        Write-InstallJson ($LogBase + '-result.json') $step
        if ($code -eq 1618 -and $attempt -lt 6) { Start-Sleep -Seconds 10; continue }
        if ($code -notin @(0, 3010)) { throw "MSI failed: $code ($($step.Meaning)); log: $logPath" }
        $log = [IO.File]::ReadAllText($logPath)
        if ($log -match 'Return value 3|Error 1730|MainEngineThread is returning (1603|1639)' -or
            $log -notmatch 'MainEngineThread is returning (0|3010)\b') {
            throw "MSI return code and completion log disagree: $logPath"
        }
        return $step
    }
}

function Get-NewmarkShortcuts($Directories) {
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($directory in $Directories) {
            if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
            Get-ChildItem -LiteralPath $directory -Filter '*Newmark*.lnk' -Recurse -File | ForEach-Object {
                $shortcut = $shell.CreateShortcut($_.FullName)
                try { [pscustomobject]@{ Path=$_.FullName; Target=$shortcut.TargetPath; Arguments=$shortcut.Arguments } }
                finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
            }
        }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Stop-InstalledNewmark([string]$Root) {
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if ($resolvedRoot -eq [IO.Path]::GetPathRoot($resolvedRoot).TrimEnd('\')) {
        throw 'Stopping installed processes requires a specific installation directory'
    }
    $prefix = $resolvedRoot + '\'
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $unreadable = @($snapshot | Where-Object {
        $_.Name -in @('Newmark Agent.exe', 'Newmark.exe', 'Newmark Console Runtime.exe') -and -not $_.ExecutablePath
    })
    if ($unreadable.Count) {
        throw ('Cannot verify Newmark process ownership with the current token: ' + ($unreadable.ProcessId -join ', '))
    }
    $owned = @($snapshot | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($entry in $owned) {
        $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle) { [void]$process.CloseMainWindow() }
    }
    if ($owned.Count) { Start-Sleep -Seconds 3 }
    # Re-read paths to avoid terminating a recycled PID. Never terminate msiexec.
    Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object {
        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -InputObject $process -Force -ErrorAction Stop
            if (-not $process.WaitForExit(10000)) { throw "Installed process did not exit: $($_.ProcessId)" }
        }
    }
    $remaining = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($remaining.Count) { throw ('Installed processes remain before file replacement: ' + ($remaining.ProcessId -join ', ')) }
}

function Resolve-NewmarkPendingPath([string]$Path) {
    if ([string]::IsNullOrEmpty($Path)) { return '' }
    $normalized = [Environment]::ExpandEnvironmentVariables($Path)
    # Preserve the stored value verbatim; only normalize a copy for ownership.
    # Older installer entries on this machine use *1 before the NT path prefix.
    $normalized = $normalized -replace '^\*[0-9]+', ''
    $normalized = $normalized.TrimStart('!')
    if ($normalized.StartsWith('\??\') -or $normalized.StartsWith('\\?\')) {
        $normalized = $normalized.Substring(4)
    }
    if ($normalized.StartsWith('UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        $normalized = '\\' + $normalized.Substring(4)
    }
    if ($normalized -notmatch '^[A-Za-z]:[\\/]' -and -not $normalized.StartsWith('\\')) { return '' }
    try { return [IO.Path]::GetFullPath($normalized).TrimEnd('\') }
    catch { return '' }
}

function Get-NewmarkPendingPlan([string]$Root, [AllowEmptyCollection()][string[]]$Entries) {
    $resolvedRoot = Resolve-NewmarkPendingPath $Root
    if (-not $resolvedRoot -or
        $resolvedRoot.TrimEnd('\') -eq [IO.Path]::GetPathRoot($resolvedRoot).TrimEnd('\')) {
        throw 'Pending-operation cleanup requires a specific absolute installation directory'
    }
    if ($Entries.Count % 2) { throw 'Malformed pending-operation list has an unpaired path; registry unchanged' }
    $prefix = $resolvedRoot + '\'
    $kept = [Collections.Generic.List[string]]::new()
    $removed = [Collections.Generic.List[object]]::new()
    for ($i=0; $i -lt $Entries.Count; $i+=2) {
        $from = Resolve-NewmarkPendingPath $Entries[$i]
        $to = Resolve-NewmarkPendingPath $Entries[$i+1]
        $ownsFrom = $from -and ($from.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $from.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase))
        $ownsTo = $to -and ($to.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $to.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase))
        if ($ownsFrom -or $ownsTo) {
            [void]$removed.Add([pscustomobject]@{ Source=$Entries[$i]; Destination=$Entries[$i+1] })
        } else {
            [void]$kept.Add($Entries[$i])
            [void]$kept.Add($Entries[$i+1])
        }
    }
    return [pscustomobject]@{ Root=$resolvedRoot; EntriesBefore=[string[]]@($Entries);
        EntriesAfter=$kept.ToArray(); RemovedPairs=$removed.ToArray() }
}

function Read-NewmarkPendingEntries {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager', $false)
    if (-not $key) { throw 'Windows Session Manager registry key is unavailable' }
    try {
        $value = $key.GetValue('PendingFileRenameOperations', $null,
            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $value) { return ,([string[]]@()) }
        if ($key.GetValueKind('PendingFileRenameOperations') -ne [Microsoft.Win32.RegistryValueKind]::MultiString) {
            throw 'PendingFileRenameOperations is not REG_MULTI_SZ; registry unchanged'
        }
        return ,([string[]]$value)
    } finally { $key.Dispose() }
}

function Write-NewmarkPendingEntries([AllowEmptyCollection()][string[]]$Entries) {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager', $true)
    if (-not $key) { throw 'Windows Session Manager registry key is not writable' }
    try {
        if ($Entries.Count) {
            $key.SetValue('PendingFileRenameOperations', $Entries, [Microsoft.Win32.RegistryValueKind]::MultiString)
        } else { $key.DeleteValue('PendingFileRenameOperations', $false) }
        $key.Flush()
    } finally { $key.Dispose() }
}

function Clear-NewmarkPendingOperations([string]$Root, [string]$EvidenceBase = '') {
    $before = Read-NewmarkPendingEntries
    $plan = Get-NewmarkPendingPlan $Root $before
    if ($EvidenceBase) { Write-InstallJson ($EvidenceBase + '-before.json') $plan }
    if ($plan.RemovedPairs.Count) {
        # Do not overwrite another application's newly queued operation.
        $current = Read-NewmarkPendingEntries
        if ($current.Count -ne $before.Count -or
            [string]::Join([char]0, $current) -cne [string]::Join([char]0, $before)) {
            throw 'Pending operations changed during cleanup preparation; registry unchanged'
        }
        Write-NewmarkPendingEntries $plan.EntriesAfter
    }
    $after = Read-NewmarkPendingEntries
    if ($after.Count -ne $plan.EntriesAfter.Count -or
        [string]::Join([char]0, $after) -cne [string]::Join([char]0, $plan.EntriesAfter)) {
        throw 'Pending-operation registry readback differs from the preserved entries'
    }
    $receipt = [pscustomobject]@{ Success=$true; Root=$plan.Root;
        RemovedPairs=$plan.RemovedPairs; RemovedPairCount=$plan.RemovedPairs.Count;
        PreservedPairCount=($after.Count / 2); OtherEntriesPreserved=$true;
        RemainingOwnedPairCount=(Get-NewmarkPendingPlan $Root $after).RemovedPairs.Count }
    if ($EvidenceBase) { Write-InstallJson ($EvidenceBase + '-result.json') $receipt }
    return $receipt
}

function New-InstallRequest([string]$Package, [string]$Evidence) {
    $packagePath = (Resolve-Path -LiteralPath $Package).Path
    if ([IO.Path]::GetExtension($packagePath) -ne '.msi') { throw 'Expected an MSI file' }
    if (-not $Evidence) {
        $Evidence = Join-Path (Split-Path (Split-Path $PSScriptRoot)) ('archive\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-verified-msi-install')
    }
    $evidencePath = [IO.Path]::GetFullPath($Evidence)
    if (Test-Path -LiteralPath (Join-Path $evidencePath 'request.json')) { throw 'Use a new evidence directory for each preparation' }
    [void][IO.Directory]::CreateDirectory($evidencePath)
    $identity = Get-MsiIdentity $packagePath
    if ($identity.ProductName -ne 'Newmark Agent' -or $identity.ALLUSERS -ne '1' -or
        $identity.ProductCode -notmatch '^\{[A-Fa-f0-9-]{36}\}$') { throw 'MSI identity is not Newmark Agent machine package' }
    $packageHash = Get-InstallSha256 $packagePath
    $extractRoot = Join-Path $evidencePath 'administrative-image'
    [void][IO.Directory]::CreateDirectory($extractRoot)
    $extract = Invoke-NewmarkMsi $packagePath ('ACTION=ADMIN REBOOT=ReallySuppress ' + (ConvertTo-MsiProperty 'TARGETDIR' $extractRoot)) (Join-Path $evidencePath 'extract')
    if ((Get-InstallSha256 $packagePath) -ne $packageHash) { throw 'MSI changed during preparation' }
    $appRoots = @(Get-ChildItem -LiteralPath $extractRoot -Filter 'Newmark Agent.exe' -Recurse -File | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.DirectoryName 'resources\app.asar') -PathType Leaf
    })
    if ($appRoots.Count -ne 1) { throw 'MSI did not extract exactly one application payload' }
    $manifest = @(Get-InstallManifest $appRoots[0].DirectoryName)
    foreach ($required in @('Newmark Agent.exe', 'Newmark.exe', 'Newmark Console Runtime.exe', 'resources\app.asar')) {
        if ($required -notin $manifest.Path) { throw "MSI required file absent: $required" }
    }
    $request = [pscustomobject]@{
        Schema=1; MsiPath=$packagePath; MsiSha256=$packageHash; Identity=$identity
        InstallRoot=(Join-Path $env:ProgramFiles 'Newmark Agent'); EvidenceDirectory=$evidencePath
        ScriptPath=$PSCommandPath; ScriptSha256=(Get-InstallSha256 $PSCommandPath)
        UserStateRoot=(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.Newmark')
        ShortcutDirectories=@([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'),
            [Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('CommonDesktopDirectory'))
        Payload=$manifest; Extraction=$extract
    }
    $path = Join-Path $evidencePath 'request.json'
    Write-InstallJson $path $request
    Write-Output "PREPARED_REQUEST=$path"
    return $path
}

function Invoke-InstallWorker([string]$Path) {
    $request = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $evidence = $request.EvidenceDirectory
    $resultPath = Join-Path $evidence 'result.json'
    $stagePath = Join-Path $evidence 'status.json'
    $result = [ordered]@{ Success=$false; Started=(Get-Date).ToString('o'); Steps=@(); Error=$null }
    try {
        if (-not (Test-InstallAdministrator)) { throw 'Worker has no administrator token; installation was not attempted' }
        if ((Get-InstallSha256 $request.MsiPath) -ne $request.MsiSha256 -or
            (Get-InstallSha256 $PSCommandPath) -ne $request.ScriptSha256) { throw 'Prepared MSI or helper changed; prepare again' }
        $identity = Get-MsiIdentity $request.MsiPath
        if ($identity.ProductCode -ne $request.Identity.ProductCode -or $identity.PackageCode -ne $request.Identity.PackageCode) { throw 'Prepared MSI identity changed' }
        $before = @(Get-NewmarkRegistrations)
        Write-InstallJson (Join-Path $evidence 'registration-before.json') $before
        Write-InstallJson $stagePath @{ Stage='stopping-installed-app'; WorkerPid=$PID }
        Stop-InstalledNewmark $request.InstallRoot
        $userManifest = @(Get-InstallManifest $request.UserStateRoot)
        Write-InstallJson (Join-Path $evidence 'user-state-before.json') $userManifest
        Write-InstallJson $stagePath @{ Stage='clearing-stale-reboot-operations'; WorkerPid=$PID }
        $result.PendingBeforeInstall = Clear-NewmarkPendingOperations $request.InstallRoot (Join-Path $evidence 'pending-before-install')
        $properties = 'ALLUSERS=1 MSIINSTALLPERUSER="" ADDLOCAL=ALL REBOOT=ReallySuppress ' + (ConvertTo-MsiProperty 'APPLICATIONFOLDER' $request.InstallRoot)
        $sameProduct = @($before | Where-Object { $_.Hive -eq 'HKLM' -and $_.ProductCode -eq $identity.ProductCode }).Count -gt 0
        if ($sameProduct) { $properties += ' REINSTALL=ALL REINSTALLMODE=vamus' }
        Write-InstallJson $stagePath @{ Stage='installing'; WorkerPid=$PID }
        $result.Steps += Invoke-NewmarkMsi $request.MsiPath $properties (Join-Path $evidence 'install')
        $payloadErrors = @(Test-InstallManifest $request.InstallRoot $request.Payload)
        if (-not $sameProduct -and $payloadErrors.Count) {
            Write-InstallJson $stagePath @{ Stage='repairing-incomplete-upgrade'; WorkerPid=$PID }
            $result.Steps += Invoke-NewmarkMsi $request.MsiPath ($properties + ' REINSTALL=ALL REINSTALLMODE=vamus') (Join-Path $evidence 'repair')
            $payloadErrors = @(Test-InstallManifest $request.InstallRoot $request.Payload)
        }
        if ($payloadErrors.Count) {
            # A corrupt same-product feature state may survive repair. Recover once
            # within this elevation via MSI, preserving Windows Installer bookkeeping.
            $installedProduct = @(Get-NewmarkRegistrations | Where-Object { $_.Hive -eq 'HKLM' -and $_.ProductCode -eq $identity.ProductCode })
            if ($installedProduct.Count -ne 1) { throw 'Cannot recover: exact expected product is not registered' }
            Write-InstallJson $stagePath @{ Stage='recovering-corrupt-same-product'; WorkerPid=$PID }
            $result.Steps += Invoke-NewmarkMsi '' 'REMOVE=ALL REBOOT=ReallySuppress' (Join-Path $evidence 'recovery-uninstall') $identity.ProductCode
            $freshProperties = 'ALLUSERS=1 MSIINSTALLPERUSER="" ADDLOCAL=ALL REBOOT=ReallySuppress ' + (ConvertTo-MsiProperty 'APPLICATIONFOLDER' $request.InstallRoot)
            $result.Steps += Invoke-NewmarkMsi $request.MsiPath $freshProperties (Join-Path $evidence 'recovery-install')
            $payloadErrors = @(Test-InstallManifest $request.InstallRoot $request.Payload)
        }
        Write-InstallJson $stagePath @{ Stage='verifying-installed-files-and-state'; WorkerPid=$PID }
        $registrations = @(Get-NewmarkRegistrations)
        $shortcuts = @(Get-NewmarkShortcuts $request.ShortcutDirectories)
        $stateErrors = @(Test-InstallManifest $request.UserStateRoot $userManifest)
        $result.PayloadErrors = $payloadErrors
        $result.UserStateErrors = $stateErrors
        $result.Registrations = $registrations
        $result.Shortcuts = $shortcuts
        $result.MsiSha256 = $request.MsiSha256
        $result.ProductCode = $identity.ProductCode
        $result.PackageCode = $identity.PackageCode
        $result.Version = $identity.ProductVersion
        $result.VerifiedPayloadFileCount = $request.Payload.Count
        if ($payloadErrors.Count) { throw ('Installed payload mismatch: ' + ($payloadErrors -join '; ')) }
        if ($stateErrors.Count) { throw ('Existing .Newmark files changed: ' + ($stateErrors -join '; ')) }
        # Only discard newly queued install-root operations once all actual
        # installed payload bytes have passed verification.
        $result.PendingAfterInstall = Clear-NewmarkPendingOperations $request.InstallRoot (Join-Path $evidence 'pending-after-install')
        $registered = @($registrations | Where-Object { $_.Hive -eq 'HKLM' -and $_.ProductCode -eq $identity.ProductCode -and $_.Version -eq $identity.ProductVersion })
        if ($registered.Count -ne 1) { throw 'Exact expected machine ProductCode/version not registered' }
        $result.RegisteredPackageCode = Get-RegisteredMsiPackageCode $identity.ProductCode
        if ($result.RegisteredPackageCode -ne $identity.PackageCode) { throw 'Registered MSI PackageCode differs from prepared MSI' }
        $expectedExe = Join-Path $request.InstallRoot 'Newmark Agent.exe'
        $startMenuLinks = @($shortcuts | Where-Object { $_.Path -like '*\Start Menu\*' -and $_.Target -eq $expectedExe })
        if (-not $startMenuLinks.Count) { throw 'Start menu shortcut does not point to the verified machine EXE' }
        $staleLinks = @($shortcuts | Where-Object { [IO.Path]::GetFileName($_.Target) -eq 'Newmark Agent.exe' -and $_.Target -ne $expectedExe })
        if ($staleLinks.Count) { throw ('Stale Newmark shortcuts remain: ' + ($staleLinks.Path -join '; ')) }
        $result.InstalledAsarSha256 = Get-InstallSha256 (Join-Path $request.InstallRoot 'resources\app.asar')
        Write-InstallJson $stagePath @{ Stage='verifying-installed-cli'; WorkerPid=$PID }
        $result.CliVersion = Get-InstalledCliVersion $request.InstallRoot $evidence
        if ([version]$result.CliVersion -ne [version]($identity.ProductVersion -replace '\.0$', '')) { throw 'Installed CLI version differs from MSI version' }
        $result.GuiRuntimeVerified = $false
        $result.Success = $true
    } catch {
        $result.Error = $_.Exception.Message
        $result.ErrorDetail = $_.ScriptStackTrace
    } finally {
        $result.Finished = (Get-Date).ToString('o')
        Write-InstallJson $resultPath $result
        Write-InstallJson $stagePath @{ Stage=($(if ($result.Success) { 'verified' } else { 'failed' })); WorkerPid=$PID; Error=$result.Error }
    }
    if (-not $result.Success) { throw $result.Error }
}

function Invoke-InstallCoordinator([string]$Path, [bool]$AllowElevation = $true) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $request = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
    $resultPath = Join-Path $request.EvidenceDirectory 'result.json'
    if (Test-Path -LiteralPath $resultPath) { throw 'Request already completed; prepare a new run instead of reusing stale success' }
    if ((Get-InstallSha256 $request.MsiPath) -ne $request.MsiSha256 -or
        (Get-InstallSha256 $PSCommandPath) -ne $request.ScriptSha256) { throw 'Prepared MSI or helper changed; prepare again before elevation' }
    if (-not $AllowElevation -and -not (Test-InstallAdministrator)) { throw 'Installation requires elevation, disabled by NoElevate' }
    $command = '& ' + (ConvertTo-PowerShellLiteral $PSCommandPath) + ' -Worker -RequestPath ' + (ConvertTo-PowerShellLiteral $resolved)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    # Only flags and base64 cross ShellExecute/PowerShell. No user path is parsed
    # twice and MSI never receives shell arguments. At most one UAC transition.
    $launch = @{
        FilePath=(Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')
        ArgumentList=('-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $encoded)
        WindowStyle='Hidden'; PassThru=$true
    }
    if (-not (Test-InstallAdministrator)) { $launch.Verb = 'RunAs' }
    try { $process = Start-Process @launch }
    catch {
        Write-InstallJson $resultPath @{ Success=$false; Error=('Elevation/worker launch failed: ' + $_.Exception.Message); Finished=(Get-Date).ToString('o') }
        throw
    }
    Write-Output "INSTALL_WORKER_PID=$($process.Id)"
    Write-Output "INSTALL_EVIDENCE=$($request.EvidenceDirectory)"
    $lastStatus = ''
    while (-not $process.WaitForExit(1000)) {
        $statusPath = Join-Path $request.EvidenceDirectory 'status.json'
        try {
            if (Test-Path -LiteralPath $statusPath) {
                $status = Get-Content -LiteralPath $statusPath -Raw
                if ($status -ne $lastStatus) { Write-Output ("INSTALL_STATUS=" + ($status | ConvertFrom-Json).Stage); $lastStatus=$status }
            }
        } catch {
            # A transient read during atomic status replacement must never detach
            # monitoring from the elevated installer. Completion is checked below.
        }
    }
    if (-not (Test-Path -LiteralPath $resultPath)) { throw "Worker exited without completion evidence: $($process.ExitCode)" }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if (-not $result.Success -or $process.ExitCode -ne 0) { throw "Installation not verified: $($result.Error); worker exit $($process.ExitCode)" }
    # The caller independently checks the installed bytes after elevated completion.
    $errors = @(Test-InstallManifest $request.InstallRoot $request.Payload)
    if ($errors.Count) { throw ('Post-worker payload mismatch: ' + ($errors -join '; ')) }
    if ((Get-NewmarkPendingPlan $request.InstallRoot (Read-NewmarkPendingEntries)).RemovedPairs.Count) {
        throw 'Post-worker pending operations still target the verified installation'
    }
    Write-Output "INSTALL_VERIFIED version=$($result.Version) product=$($result.ProductCode) files=$($result.VerifiedPayloadFileCount) asar=$($result.InstalledAsarSha256)"
}

if ($LibraryOnly) { return }
try {
    if ($Worker) {
        if (-not $RequestPath) { throw 'Worker requires RequestPath' }
        Invoke-InstallWorker $RequestPath
    } else {
        if (-not $RequestPath) {
            if (-not $MsiPath) { throw 'Specify MsiPath for preparation or RequestPath for a prepared install' }
            $preparation = @(New-InstallRequest $MsiPath $EvidenceDirectory)
            $RequestPath = $preparation[-1]
            $preparation | Select-Object -SkipLast 1 | Write-Output
        }
        if ($PrepareOnly) { Write-Output "PREPARATION_ONLY=$RequestPath" }
        else { Invoke-InstallCoordinator $RequestPath (-not $NoElevate) }
    }
} catch { Write-Error $_; exit 1 }
