// Compile a disposable non-product MSI, inspect its actual tables, format its
// command through msi.dll, and execute the exact command in empty directories.
// MsiOpenPackageEx uses IGNOREMACHINESTATE: this test never installs any MSI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const patchProject = require('./patch-msi-project.cjs');
const root = path.resolve(__dirname, '../..');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const evidence = path.resolve(process.argv[2] || path.join(root, 'archive', `${stamp}-msi-authoring-regression`));
fs.mkdirSync(evidence, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark msi authoring '));
const psLiteral = value => `'${value.replace(/'/g, "''")}'`;
const xml = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function run(file, args, name) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(evidence, `${name}.log`), (result.stdout || '') + (result.stderr || ''));
  if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error || result.stderr || result.stdout}`);
  return result.stdout;
}

(async () => {
  const wixCache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'wix-4.0.0.5512.2');
  const candleRelative = fs.readdirSync(wixCache, { recursive: true }).find(name => path.basename(name) === 'candle.exe');
  assert.ok(candleRelative, 'electron-builder cached WiX compiler is required');
  const wix = path.dirname(path.join(wixCache, candleRelative));
  const file = path.join(fixture, 'Newmark.exe');
  fs.writeFileSync(file, 'Harmless text fixture; this is not an executable.\n');
  const project = path.join(evidence, 'fixture.wxs');
  fs.writeFileSync(project, `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Product Id="*" Name="Newmark MSI authoring regression fixture" Version="0.0.1" Language="1033" Codepage="65001" Manufacturer="Regression fixture" UpgradeCode="05B07A18-ECAA-494C-982F-C31584D5AAE7">
    <Package Compressed="yes" InstallerVersion="500" InstallScope="perMachine"/>
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="Newer fixture exists"/>
    <MediaTemplate CompressionLevel="none" EmbedCab="yes"/>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder"><Directory Id="APPLICATIONFOLDER" Name="Newmark regression fixture"/></Directory>
    </Directory>
    <Feature Id="ProductFeature" Level="1"><ComponentGroupRef Id="ProductComponents"/></Feature>
    <ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER">
      <Component Id="ConsoleComponent" Guid="*" Win64="yes">
        <File Name="Newmark.exe" Id="ConsoleFile" Source="${xml(file)}" KeyPath="yes"/>
      </Component>
    </ComponentGroup>
  </Product>
</Wix>
`);
  const unpatched = fs.readFileSync(project, 'utf8');
  assert.ok(!unpatched.includes('<Directory Id="SystemFolder"'), 'fixture starts with the production template missing SystemFolder');
  const withSystemFolder = patchProject.ensureSystemFolderDirectory(unpatched);
  assert.equal(patchProject.ensureSystemFolderDirectory(withSystemFolder), withSystemFolder, 'an existing SystemFolder declaration is preserved without duplication');
  await patchProject(project);
  const expectedScript = patchProject.buildPreInstallScript();
  const expectedEarlyScript = patchProject.buildPreUpgradeScript('05B07A18-ECAA-494C-982F-C31584D5AAE7');
  fs.writeFileSync(path.join(evidence, 'embedded-action.ps1'), expectedScript);
  fs.writeFileSync(path.join(evidence, 'embedded-early-action.ps1'), expectedEarlyScript);
  const object = path.join(evidence, 'fixture.wixobj');
  const msi = path.join(evidence, 'fixture.msi');
  run(path.join(wix, 'candle.exe'), ['-arch', 'x64', '-out', object, project], 'candle');
  run(path.join(wix, 'light.exe'), ['-sval', '-out', msi, object], 'light');
  const check = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$passed = 0
function Assert-Authoring($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:passed++
    Write-Output ('PASS ' + $Message)
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MsiAuthoringNative {
  [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] public static extern uint MsiOpenPackageExW(string path, uint options, out uint handle);
  [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] public static extern uint MsiSetPropertyW(uint handle, string name, string value);
  [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] public static extern uint MsiDoActionW(uint handle, string action);
  [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] public static extern uint MsiGetComponentStateW(uint handle, string component, out int installed, out int action);
  [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] public static extern uint MsiGetTargetPathW(uint handle, string directory, StringBuilder result, ref uint length);
  [DllImport("msi.dll", ExactSpelling=true)] public static extern uint MsiSetInternalUI(uint level, IntPtr window);
  [DllImport("msi.dll", ExactSpelling=true)] public static extern uint MsiCreateRecord(uint fields);
  [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] public static extern uint MsiRecordSetStringW(uint record, uint field, string value);
  [DllImport("msi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] public static extern uint MsiFormatRecordW(uint handle, uint record, StringBuilder result, ref uint length);
  [DllImport("msi.dll", ExactSpelling=true)] public static extern uint MsiCloseHandle(uint handle);
}
'@
function Format-Msi([uint32]$Handle, [string]$Value) {
    $record = [MsiAuthoringNative]::MsiCreateRecord(0)
    try {
        if ([MsiAuthoringNative]::MsiRecordSetStringW($record, 0, $Value)) { throw 'Cannot set MSI format record' }
        $length = [uint32]65536
        $buffer = [Text.StringBuilder]::new([int]$length)
        if ([MsiAuthoringNative]::MsiFormatRecordW($Handle, $record, $buffer, [ref]$length)) { throw 'MsiFormatRecord failed' }
        return $buffer.ToString()
    } finally { [void][MsiAuthoringNative]::MsiCloseHandle($record) }
}
$msi = ${psLiteral(msi)}
$fixture = ${psLiteral(fixture)}
$evidence = ${psLiteral(evidence)}
$expectedScript = [IO.File]::ReadAllText((Join-Path $evidence 'embedded-action.ps1'))
$expectedEarlyScript = [IO.File]::ReadAllText((Join-Path $evidence 'embedded-early-action.ps1'))
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.OpenDatabase($msi, 0)
function Read-Row([string]$Sql) {
    $view = $db.OpenView($Sql)
    try {
        [void]$view.Execute(); $record = $view.Fetch()
        if ($null -eq $record) { return $null }
        try {
            $values = @()
            for ($index=1; $index -le $record.FieldCount(); $index++) { $values += $record.StringData($index) }
            return ,$values
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
    }
    finally { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
}
$action = Read-Row 'SELECT Type, Source, Target FROM CustomAction WHERE Action = ''StopRunningNewmark'''
$type = [int]$action[0]
$directory = $action[1]
$command = $action[2]
Assert-Authoring (($type -band 63) -eq 34 -and $directory -eq 'APPLICATIONFOLDER') 'compiled MSI uses directory-based Type 34'
Assert-Authoring (($type -band 1024) -and ($type -band 2048) -and -not ($type -band 64)) 'deferred system action checks failure instead of ignoring it'
$earlyAction = Read-Row 'SELECT Type, Source, Target FROM CustomAction WHERE Action = ''StopRegisteredNewmarkBeforeUpgrade'''
Assert-Authoring ([int]$earlyAction[0] -eq 34 -and $earlyAction[1] -eq 'SystemFolder') 'early process stop is checked immediate Type 34 in an existing system directory'
$systemFolder = Read-Row 'SELECT Directory_Parent FROM Directory WHERE Directory = ''SystemFolder'''
Assert-Authoring ($null -ne $systemFolder -and $systemFolder[0] -eq 'TARGETDIR') 'hook supplies the absent production SystemFolder as a direct TARGETDIR child'
$earlyCommand = $earlyAction[2]
$sequences = @{}
foreach ($name in @('InstallInitialize', 'StopRegisteredNewmarkBeforeUpgrade', 'RemoveExistingProducts', 'RemoveFiles', 'CreateFolders', 'StopRunningNewmark', 'InstallFiles')) {
    $row = Read-Row ("SELECT Sequence FROM InstallExecuteSequence WHERE Action = '" + $name + "'")
    $sequences[$name] = [int]$row[0]
}
Assert-Authoring ($sequences.CreateFolders -lt $sequences.StopRunningNewmark -and $sequences.StopRunningNewmark -lt $sequences.InstallFiles) 'compiled scheduling creates the working directory before cleanup and file installation'
Assert-Authoring ($sequences.RemoveFiles -lt $sequences.StopRunningNewmark -and $sequences.RemoveExistingProducts -lt $sequences.StopRunningNewmark) 'cleanup follows old-file removal that can queue delayed deletes'
Assert-Authoring ($sequences.StopRegisteredNewmarkBeforeUpgrade -lt $sequences.RemoveExistingProducts -and $sequences.RemoveExistingProducts -lt $sequences.InstallInitialize) 'registered old processes stop before default major-upgrade removal without moving its transaction boundary'
$folder = Read-Row 'SELECT Directory_, Component_ FROM CreateFolder WHERE Component_ = ''ConsoleComponent'''
Assert-Authoring ($null -ne $folder -and $folder[0] -eq 'APPLICATIONFOLDER') 'compiled CreateFolder row covers a fresh custom installation directory'
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($db)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
. ${psLiteral(path.join(__dirname, 'install-windows-msi.ps1'))} -LibraryOnly
$registryBefore = Read-NewmarkPendingEntries
$cases = @()
$previousUi = [MsiAuthoringNative]::MsiSetInternalUI(2, [IntPtr]::Zero)
try {
  foreach ($leaf in @('space path', '中文目录', "apostrophe's [literal] & dollar$ percent%")) {
    $customRoot = Join-Path $fixture $leaf
    Assert-Authoring (-not (Test-Path -LiteralPath $customRoot)) ('custom directory starts absent: ' + $leaf)
    $handle = [uint32]0
    Assert-Authoring ([MsiAuthoringNative]::MsiOpenPackageExW($msi, 1, [ref]$handle) -eq 0) 'restricted MSI session opens without install permission'
    try {
      [void][MsiAuthoringNative]::MsiSetPropertyW($handle, 'APPLICATIONFOLDER', $customRoot + '\')
      [void][MsiAuthoringNative]::MsiSetPropertyW($handle, 'ADDLOCAL', 'ALL')
      foreach ($standard in @('CostInitialize', 'FileCost', 'CostFinalize')) {
        Assert-Authoring ([MsiAuthoringNative]::MsiDoActionW($handle, $standard) -eq 0) ('restricted MSI costing: ' + $standard)
      }
      $installed = 0; $state = 0
      Assert-Authoring ([MsiAuthoringNative]::MsiGetComponentStateW($handle, 'ConsoleComponent', [ref]$installed, [ref]$state) -eq 0 -and $state -eq 3) 'CreateFolder component is scheduled locally for an absent directory'
      $length = [uint32]4096
      $buffer = [Text.StringBuilder]::new([int]$length)
      Assert-Authoring ([MsiAuthoringNative]::MsiGetTargetPathW($handle, 'APPLICATIONFOLDER', $buffer, [ref]$length) -eq 0 -and $buffer.ToString().TrimEnd('\') -ceq $customRoot) 'MSI resolves the exact custom directory without shell quoting'
      $old = Format-Msi $handle '$root=[IO.Path]::GetFullPath(''[APPLICATIONFOLDER]''); if($true){ $from=[string]$pending[$i] }'
      Assert-Authoring (-not $old.Contains('[IO.Path]') -and -not $old.Contains('$from=')) 'real MSI formatter reproduces the old swallowed type and script block'
      $formatted = Format-Msi $handle $command
      Assert-Authoring ($formatted -match '^"([^"]+)" (.+)$') 'formatted action retains one quoted native executable'
      $executable = $Matches[1]; $arguments = $Matches[2]
      Assert-Authoring ($arguments -match '-EncodedCommand ([A-Za-z0-9+/=]+)$') 'MSI formatting preserves the encoded payload'
      $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
      Assert-Authoring ($decoded -ceq $expectedScript) 'decoded actual MSI command is byte-identical to shared script definitions'
      if ($cases.Count -eq 0) {
        $earlyFormatted = Format-Msi $handle $earlyCommand
        Assert-Authoring ($earlyFormatted -match '^"([^"]+)" (.+)$') 'early command survives actual MSI formatting'
        $earlyExe = $Matches[1]; $earlyArgs = $Matches[2]
        Assert-Authoring ($earlyArgs -match '-EncodedCommand ([A-Za-z0-9+/=]+)$' -and [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1])) -ceq $expectedEarlyScript) 'early encoded process lookup is byte-identical after MSI formatting'
        $earlyStart = [Diagnostics.ProcessStartInfo]::new()
        $earlyStart.FileName=$earlyExe; $earlyStart.Arguments=$earlyArgs; $earlyStart.WorkingDirectory=[Environment]::SystemDirectory
        $earlyStart.UseShellExecute=$false; $earlyStart.CreateNoWindow=$true
        $earlyStart.RedirectStandardOutput=$true; $earlyStart.RedirectStandardError=$true
        $earlyProcess=[Diagnostics.Process]::Start($earlyStart)
        $earlyOutput=$earlyProcess.StandardOutput.ReadToEnd(); $earlyError=$earlyProcess.StandardError.ReadToEnd()
        $earlyProcess.WaitForExit()
        if ($earlyProcess.ExitCode -ne 0) { throw ('Early encoded action failed: ' + $earlyError) }
        Assert-Authoring ($earlyOutput.Contains('registered roots: 0')) 'exact early action executes the fresh no-related-products branch without terminating any application'
      }
      Assert-Authoring ((Get-NewmarkPendingPlan $customRoot $registryBefore).RemovedPairs.Count -eq 0) 'empty fixture cannot own an existing delayed operation'
      # Simulate the preceding standard CreateFolders action, then run the exact
      # formatted EXE target. Neither this test nor the restricted MSI can install.
      [void][IO.Directory]::CreateDirectory($customRoot)
      $start = [Diagnostics.ProcessStartInfo]::new()
      $start.FileName = $executable; $start.Arguments = $arguments
      $start.WorkingDirectory = $customRoot
      $start.UseShellExecute = $false; $start.CreateNoWindow = $true
      $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
      $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
      $process = [Diagnostics.Process]::Start($start)
      $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd()
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) { throw ('Actual encoded action failed: ' + $stderr) }
      Assert-Authoring ($stdout.Contains('cleanup completed: ' + $customRoot)) ('actual encoded action executes its no-owned-pairs branch: ' + $leaf)
      $cases += [pscustomobject]@{ Root=$customRoot; StartedAbsent=$true; ComponentAction=$state; ExactWorkingDirectory=$true; ExitCode=$process.ExitCode; ScriptPreserved=$true }
    } finally { if ($handle) { [void][MsiAuthoringNative]::MsiCloseHandle($handle) } }
  }
} finally { [void][MsiAuthoringNative]::MsiSetInternalUI($previousUi, [IntPtr]::Zero) }
$registryAfter = Read-NewmarkPendingEntries
Assert-Authoring ([string]::Join([char]0, $registryBefore) -ceq [string]::Join([char]0, $registryAfter)) 'actual action leaves every real pending-operation entry unchanged'
[ordered]@{ Success=$true; Passed=$passed; InstalledAnyMsi=$false; RestrictedMsiHandle=$true; Sequence=$sequences; Cases=$cases; PendingRegistryUnchanged=$true } |
  ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding UTF8
Write-Output ("PASS MSI authoring native-boundary checks: " + $passed)
`;
  fs.writeFileSync(path.join(evidence, 'verify-native.ps1'), '\ufeff' + check);
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(evidence, 'verify-native.ps1')], 'verification');
  console.log(output.trim());
  console.log(`Evidence: ${evidence}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  const resolved = path.resolve(fixture);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith('newmark msi authoring '));
  fs.rmSync(resolved, { recursive: true, force: true });
});
