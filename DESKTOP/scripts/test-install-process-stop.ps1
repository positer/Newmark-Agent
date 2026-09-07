[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-windows-msi.ps1') -LibraryOnly
$passed = 0
function Assert-ProcessStop($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:passed++
    Write-Output "PASS $Message"
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('newmark process regression ' + [guid]::NewGuid().ToString('N'))
$inside = $null
$outside = $null
try {
    [void][IO.Directory]::CreateDirectory($fixture)
    $node = (Get-Command node.exe).Source
    $fixtureNode = Join-Path $fixture 'Newmark Agent.exe'
    Copy-Item -LiteralPath $node -Destination $fixtureNode
    function Start-FixtureNode([string]$Executable) {
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $Executable
        $start.Arguments = '-e "setInterval(() => {}, 1000)"'
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        return [Diagnostics.Process]::Start($start)
    }
    $inside = Start-FixtureNode $fixtureNode
    $outside = Start-FixtureNode $node
    Start-Sleep -Milliseconds 150
    Assert-ProcessStop (-not $inside.HasExited -and -not $outside.HasExited) 'isolated real child processes start'
    Stop-InstalledNewmark $fixture
    Assert-ProcessStop $inside.HasExited 'exact installation-directory child actually exits'
    Assert-ProcessStop (-not $outside.HasExited) 'other-directory child remains running'

    # A protected process must stop the transaction before any attempted kill.
    function Get-CimInstance {
        param($ClassName, $ErrorAction)
        [pscustomobject]@{Name='Newmark Agent.exe'; ExecutablePath=$null; ProcessId=90001}
    }
    $failed = $false
    try { Stop-InstalledNewmark $fixture } catch { $failed = $_.Exception.Message -like '*Cannot verify*ownership*' }
    Assert-ProcessStop $failed 'unreadable Newmark process ownership fails explicitly'

    # Reproduce a process that reappears between the kill scan and final scan.
    $script:SnapshotCount = 0
    function Get-CimInstance {
        param($ClassName, $ErrorAction)
        $script:SnapshotCount++
        if ($script:SnapshotCount -eq 3) {
            [pscustomobject]@{Name='Newmark Agent.exe'; ExecutablePath=$fixtureNode; ProcessId=90002}
        }
    }
    $failed = $false
    try { Stop-InstalledNewmark $fixture } catch { $failed = $_.Exception.Message -like '*processes remain*' }
    Assert-ProcessStop ($failed -and $script:SnapshotCount -eq 3) 'a late remaining process cannot pass early-stop verification'
    $failed = $false
    try { Stop-InstalledNewmark 'C:\' } catch { $failed = $_.Exception.Message -like '*specific installation directory*' }
    Assert-ProcessStop $failed 'drive-wide process termination is rejected'
} finally {
    foreach ($ownedProcess in @($inside, $outside)) {
        if ($ownedProcess) {
            if (-not $ownedProcess.HasExited) { $ownedProcess.Kill(); [void]$ownedProcess.WaitForExit(10000) }
            $ownedProcess.Dispose()
        }
    }
    $resolved = [IO.Path]::GetFullPath($fixture)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'newmark process regression *') { throw 'Unsafe test cleanup boundary' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
Write-Output "INSTALL_PROCESS_STOP_TESTS_PASS=$passed"
