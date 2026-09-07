[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-windows-msi.ps1') -LibraryOnly
$passed = 0
function Assert-Pending($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:passed++
    Write-Output "PASS $Message"
}
function Same-PendingEntries($Left, $Right) {
    return $Left.Count -eq $Right.Count -and
        [string]::Join([char]0, $Left) -ceq [string]::Join([char]0, $Right)
}

$root = 'C:\Program Files\Newmark Agent'
$original = [string[]]@(
    '*1\??\C:\Program Files\Other Application\old.dll', '',
    '*1\??\C:\Program Files\Newmark Agent\resources\app.asar', '',
    '*1\??\C:\Program Files\Newmark Agent\resources\app.asar', '',
    '*1\??\C:\Program Files\Newmark Agent\resources\TBM40E9.tmp',
        '*1\??\C:\Program Files\Newmark Agent\resources\app.asar',
    '\??\C:\Program Files\Newmark Agent Backup\app.asar', '',
    '\??\C:\Other\new.tmp', '!\??\C:\Other\active.dll'
)
$expected = [string[]]@(
    '*1\??\C:\Program Files\Other Application\old.dll', '',
    '\??\C:\Program Files\Newmark Agent Backup\app.asar', '',
    '\??\C:\Other\new.tmp', '!\??\C:\Other\active.dll'
)
$plan = Get-NewmarkPendingPlan $root $original
Assert-Pending ($plan.RemovedPairs.Count -eq 3) 'all three observed stale Newmark operations are selected'
Assert-Pending (Same-PendingEntries $plan.EntriesAfter $expected) 'other applications and lookalike directory remain byte-for-byte in order'
Assert-Pending (Same-PendingEntries $plan.EntriesBefore $original) 'original raw strings including empty deletion targets are retained'
Assert-Pending ((Resolve-NewmarkPendingPath '*1\??\C:\Program Files\Newmark Agent\resources\app.asar') -ceq ($root + '\resources\app.asar')) 'observed star-one NT prefix resolves'
Assert-Pending ((Resolve-NewmarkPendingPath '!\??\C:\Program Files\Newmark Agent\a') -ceq ($root + '\a')) 'replace-existing NT prefix resolves'
Assert-Pending ((Resolve-NewmarkPendingPath '\\?\C:\Program Files\Newmark Agent\a') -ceq ($root + '\a')) 'extended Win32 prefix resolves'
Assert-Pending ((Resolve-NewmarkPendingPath '\??\UNC\server\share\file') -ceq '\\server\share\file') 'UNC prefix resolves without attributing another share to local app'
Assert-Pending ((Resolve-NewmarkPendingPath 'C:relative\app.asar') -ceq '') 'drive-relative paths are never guessed'
Assert-Pending ((Resolve-NewmarkPendingPath 'relative\app.asar') -ceq '') 'relative paths are never guessed'
$escape = Get-NewmarkPendingPlan $root @(($root + '\..\Another App\a'), '')
Assert-Pending ($escape.RemovedPairs.Count -eq 0) 'parent traversal outside the installation boundary is retained'
$destination = Get-NewmarkPendingPlan $root @('C:\Elsewhere\old.tmp', ('!' + '\??\' + $root + '\app.asar'))
Assert-Pending ($destination.RemovedPairs.Count -eq 1) 'outside source that would overwrite the installed app is selected'
$case = Get-NewmarkPendingPlan $root @('\??\c:\program files\NEWMARK AGENT\a', '')
Assert-Pending ($case.RemovedPairs.Count -eq 1) 'Windows installation ownership is case insensitive'
$unicodeRoot = 'C:\Apps\user''s [' + [char]0x4E2D + [char]0x6587 + '] Newmark Agent'
$unicode = Get-NewmarkPendingPlan $unicodeRoot @(('\??\' + $unicodeRoot + '\a'), '', 'C:\Another App\b', '')
Assert-Pending ($unicode.RemovedPairs.Count -eq 1 -and $unicode.EntriesAfter.Count -eq 2) 'spaces Unicode apostrophe and brackets are ordinary path data'
$empty = Get-NewmarkPendingPlan $root @()
Assert-Pending ($empty.RemovedPairs.Count -eq 0 -and $empty.EntriesAfter.Count -eq 0) 'empty pending queue is valid'
foreach ($badRoot in @('', 'C:\', 'C:')) {
    $failed = $false
    try { Get-NewmarkPendingPlan $badRoot $original | Out-Null } catch { $failed = $true }
    Assert-Pending $failed ('reject broad or relative root: ' + $badRoot)
}
$failed = $false
try { Get-NewmarkPendingPlan $root @('C:\Unpaired\file') | Out-Null } catch { $failed = $true }
Assert-Pending $failed 'odd pending list fails closed without dropping an unpaired path'

# Replace only the registry boundary in this process. No HKLM value is written.
$script:PendingState = $original
$script:ReadCalls = 0
$script:WriteCalls = 0
$script:ConcurrentChange = $false
$script:CorruptReadback = $false
function Read-NewmarkPendingEntries {
    $script:ReadCalls++
    if ($script:ConcurrentChange -and $script:ReadCalls -eq 2) {
        $script:PendingState = [string[]]@($script:PendingState + @('C:\Another Installer\queued.dll', ''))
    }
    return ,([string[]]$script:PendingState)
}
function Write-NewmarkPendingEntries([AllowEmptyCollection()][string[]]$Entries) {
    $script:WriteCalls++
    $script:PendingState = [string[]]$Entries
    if ($script:CorruptReadback) { $script:PendingState = [string[]]@('C:\Unexpected\entry', '') }
}
$receipt = Clear-NewmarkPendingOperations $root
Assert-Pending ($receipt.Success -and $receipt.RemovedPairCount -eq 3 -and $receipt.RemainingOwnedPairCount -eq 0) 'cleanup reports verified removal of actual historical shape'
Assert-Pending ($script:WriteCalls -eq 1 -and (Same-PendingEntries $script:PendingState $expected)) 'registry boundary receives exactly the preserved pairs once'
$receipt = Clear-NewmarkPendingOperations $root
Assert-Pending ($receipt.RemovedPairCount -eq 0 -and $script:WriteCalls -eq 1) 'repeated cleanup is read-only when nothing belongs to the app'
$script:PendingState = [string[]]@(($root + '\app.asar'), '')
$script:WriteCalls = 0
$receipt = Clear-NewmarkPendingOperations $root
Assert-Pending ($script:PendingState.Count -eq 0 -and $receipt.PreservedPairCount -eq 0 -and $script:WriteCalls -eq 1) 'all-owned queue produces a verified empty result'
$script:PendingState = $original
$script:ReadCalls = 0
$script:WriteCalls = 0
$script:ConcurrentChange = $true
$failed = $false
try { Clear-NewmarkPendingOperations $root | Out-Null } catch { $failed = $_.Exception.Message -like '*changed during*' }
Assert-Pending ($failed -and $script:WriteCalls -eq 0) 'concurrent enqueue is detected before any registry write'
Assert-Pending ($script:PendingState.Count -eq $original.Count + 2) 'concurrently added unrelated operation is preserved'
$script:ConcurrentChange = $false
$script:CorruptReadback = $true
$script:PendingState = $original
$script:ReadCalls = 0
$failed = $false
try { Clear-NewmarkPendingOperations $root | Out-Null } catch { $failed = $_.Exception.Message -like '*readback differs*' }
Assert-Pending $failed 'unexpected registry readback cannot report success'
Write-Output "PENDING_OPERATIONS_TESTS_PASS=$passed"
