$ErrorActionPreference='Stop'
$taskSource=Get-Content -LiteralPath Newmark2DSH/packages/newmark-core/lib/core-restart.ps1 -Raw
$functions=$taskSource.Substring($taskSource.IndexOf('function Identity'),$taskSource.IndexOf("if (`$Mode -eq 'Probe')")-$taskSource.IndexOf('function Identity'))
Invoke-Expression $functions
function Get-CimInstance { param($ClassName,$Filter) return $script:taskProcessFixture }
$taskCreated=[DateTime]::Parse('2026-10-12T01:00:00Z').ToUniversalTime()
$taskExpected=@{pid=42;path='C:\QA\dsh.exe';created=$taskCreated.ToString('o')}
$script:taskProcessFixture=[pscustomobject]@{ProcessId=42;ExecutablePath=$taskExpected.path;CreationDate=$taskCreated}
if (!(SameProcess $taskExpected)) {throw 'original identity not recognized'}
$script:taskProcessFixture.ExecutablePath='C:\QA\unrelated.exe'
if (SameProcess $taskExpected) {throw 'reused PID would be stopped'}
$script:taskProcessFixture.ExecutablePath=$taskExpected.path
$script:taskProcessFixture.CreationDate=$taskCreated.AddSeconds(1)
if (SameProcess $taskExpected) {throw 'same path with new creation time would be stopped'}
$script:taskProcessFixture=$null
if (SameProcess $taskExpected) {throw 'exited identity should be absent'}
Write-Output 'PASS 4 restart process-identity safety checks; no real process stopped'
