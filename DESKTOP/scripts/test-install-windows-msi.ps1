[CmdletBinding()]
param([string]$PreparedRequest)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-windows-msi.ps1') -LibraryOnly
$passed = 0
function Assert-Install($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:passed++
    Write-Output "PASS $Message"
}

$helper = Join-Path $PSScriptRoot 'install-windows-msi.ps1'
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$parseErrors)
Assert-Install ($parseErrors.Count -eq 0) 'Windows PowerShell helper parses'

# Exercise a real native argv boundary. These are the spaces/backslashes which
# Start-Process -ArgumentList @(...) failed to preserve in the old installer.
$values = @('', 'Newmark Agent', 'C:\Program Files\Newmark Agent\',
    'C:\Users\user\Desktop\path with spaces\x.msi', 'literal"quote', 'a\\"b',
    'apostrophe''s', 'literal`$()&<>', ('unicode-' + [char]0x6D4B + [char]0x8BD5))
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = (Get-Command node.exe).Source
$start.Arguments = (@('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))') + $values |
    ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$process = [Diagnostics.Process]::Start($start)
$output = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
$received = ConvertFrom-Json -InputObject $output
Assert-Install ($process.ExitCode -eq 0 -and $received.Count -eq $values.Count) 'native argv preserves argument count'
for ($i=0; $i -lt $values.Count; $i++) {
    Assert-Install ($received[$i] -ceq $values[$i]) "native argv preserves argument $i"
}
$literal = ConvertTo-PowerShellLiteral "C:\Newmark Agent\apostrophe's\request.json"
$command = '[string]' + $literal
$decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))))
Assert-Install ((& ([scriptblock]::Create($decoded))) -ceq "C:\Newmark Agent\apostrophe's\request.json") 'encoded elevation command preserves exact path'
Assert-Install ((ConvertTo-MsiProperty 'APPLICATIONFOLDER' 'C:\Program Files\Newmark Agent\') -ceq 'APPLICATIONFOLDER="C:\Program Files\Newmark Agent\"') 'MSI API property quoting is separate from Windows argv quoting'
Assert-Install ((Get-MsiExitMeaning 1639) -eq 'invalid-command-line') '1639 means invalid arguments, never busy'
Assert-Install ((Get-MsiExitMeaning 1618) -eq 'another-installation-running') '1618 is the retryable busy response'

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('newmark installer verification ' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
try {
    Write-InstallJson (Join-Path $fixture 'empty.json') @()
    Assert-Install (([IO.File]::ReadAllText((Join-Path $fixture 'empty.json')) -replace '\s', '') -eq '[]') 'empty installation inventory remains valid JSON evidence'
    Remove-Item -LiteralPath (Join-Path $fixture 'empty.json')
    [void][IO.Directory]::CreateDirectory((Join-Path $fixture 'resources'))
    [IO.File]::WriteAllText((Join-Path $fixture 'Newmark Agent.exe'), 'exe-fixture')
    [IO.File]::WriteAllText((Join-Path $fixture 'resources\app.asar'), 'asar-one')
    $manifest = @(Get-InstallManifest $fixture)
    Assert-Install ($manifest.Count -eq 2) 'manifest includes executable and ASAR'
    Assert-Install (@(Test-InstallManifest $fixture $manifest).Count -eq 0) 'exact payload passes'
    [IO.File]::WriteAllText((Join-Path $fixture 'resources\app.asar'), 'asar-two')
    Assert-Install (@(Test-InstallManifest $fixture $manifest).Count -eq 1) 'same-size stale ASAR fails hash verification'
    Remove-Item -LiteralPath (Join-Path $fixture 'resources\app.asar')
    Assert-Install (@(Test-InstallManifest $fixture $manifest).Count -eq 1) 'successful installer with missing ASAR cannot pass'

    # Substitute only the native boundary in this disposable test process. The
    # supplied MSI path does not exist, so these tests cannot install a product.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
namespace NewmarkInstaller {
  public static class Native {
    public static uint[] Codes = new uint[] {0};
    public static int Calls;
    public static string LogPath;
    public static bool MissingCompletion;
    public static bool FailureInLog;
    public static uint MsiEnableLogW(uint mode, string path, uint attributes) { if (mode != 0) LogPath=path; return 0; }
    public static uint MsiSetInternalUI(uint level, IntPtr window) { return 2; }
    public static uint MsiInstallProductW(string package, string properties) {
      uint code = Codes[Math.Min(Calls++, Codes.Length-1)];
      File.WriteAllText(LogPath, (FailureInLog ? "Return value 3\n" : "") +
        (MissingCompletion ? "MSI started\n" : "MainEngineThread is returning " + code + "\n"));
      return code;
    }
    public static uint MsiConfigureProductExW(string code, int level, int state, string properties) {
      return MsiInstallProductW(code, properties);
    }
  }
}
'@
    function Start-Sleep { param([int]$Seconds) }
    [NewmarkInstaller.Native]::Codes = [uint32[]]@(1639)
    $failed = $false
    try { Invoke-NewmarkMsi 'C:\nonexistent-test-package.msi' '' (Join-Path $fixture 'invalid-arguments') | Out-Null }
    catch { $failed = $_.Exception.Message -match 'invalid-command-line' }
    Assert-Install ($failed -and [NewmarkInstaller.Native]::Calls -eq 1) 'invalid arguments fail immediately without blind retries'
    [NewmarkInstaller.Native]::Codes = [uint32[]]@(1618, 0)
    [NewmarkInstaller.Native]::Calls = 0
    $step = Invoke-NewmarkMsi 'C:\nonexistent-test-package.msi' '' (Join-Path $fixture 'busy-then-success')
    Assert-Install ($step.ExitCode -eq 0 -and [NewmarkInstaller.Native]::Calls -eq 2) 'busy MSI retries and accepts a verified completion'
    [NewmarkInstaller.Native]::Codes = [uint32[]]@(1618)
    [NewmarkInstaller.Native]::Calls = 0
    $failed = $false
    try { Invoke-NewmarkMsi 'C:\nonexistent-test-package.msi' '' (Join-Path $fixture 'always-busy') | Out-Null }
    catch { $failed = $_.Exception.Message -match 'another-installation-running' }
    Assert-Install ($failed -and [NewmarkInstaller.Native]::Calls -eq 6) 'busy retries are bounded at six attempts'
    [NewmarkInstaller.Native]::Codes = [uint32[]]@(0)
    [NewmarkInstaller.Native]::MissingCompletion = $true
    $failed = $false
    try { Invoke-NewmarkMsi 'C:\nonexistent-test-package.msi' '' (Join-Path $fixture 'missing-completion') | Out-Null }
    catch { $failed = $_.Exception.Message -match 'completion log disagree' }
    Assert-Install $failed 'MSI code zero without completion log is rejected'
    [NewmarkInstaller.Native]::MissingCompletion = $false
    [NewmarkInstaller.Native]::FailureInLog = $true
    $failed = $false
    try { Invoke-NewmarkMsi 'C:\nonexistent-test-package.msi' '' (Join-Path $fixture 'contradictory-log') | Out-Null }
    catch { $failed = $_.Exception.Message -match 'completion log disagree' }
    Assert-Install $failed 'MSI code zero with failed action in log is rejected'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'newmark installer verification *') { throw 'Unsafe fixture cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

if ($PreparedRequest) {
    $request = Get-Content -LiteralPath $PreparedRequest -Raw | ConvertFrom-Json
    $identity = Get-MsiIdentity $request.MsiPath
    Assert-Install ($identity -isnot [array]) 'MSI identity query emits exactly one object'
    Assert-Install ($identity.ProductCode -eq $request.Identity.ProductCode -and $identity.PackageCode -eq $request.Identity.PackageCode) 'prepared MSI ProductCode and PackageCode match source'
    Assert-Install ((Get-InstallSha256 $request.MsiPath) -eq $request.MsiSha256) 'prepared MSI hash still matches source'
    $roots = @(Get-ChildItem -LiteralPath (Join-Path $request.EvidenceDirectory 'administrative-image') -Filter 'Newmark Agent.exe' -Recurse -File)
    Assert-Install ($roots.Count -eq 1) 'real MSI administrative image has one application root'
    Assert-Install (@(Test-InstallManifest $roots[0].DirectoryName $request.Payload).Count -eq 0) 'real MSI administrative image matches every prepared payload hash'
    Assert-Install ($request.Extraction.ExitCode -eq 0 -or $request.Extraction.ExitCode -eq 3010) 'real MSI API extraction completed successfully without product installation'
}
Write-Output "INSTALL_HELPER_TESTS_PASS=$passed"
& (Join-Path $PSScriptRoot 'test-install-pending-operations.ps1')
if (-not $?) { throw 'Pending-operation regression failed' }
& (Join-Path $PSScriptRoot 'test-install-process-stop.ps1')
if (-not $?) { throw 'Installed-process stop regression failed' }
