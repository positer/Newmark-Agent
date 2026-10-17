# Runs every refusal case of release-heartbeat-0.3.16.mjs and records the real exit code of each,
# so the guard matrix in REPORT.md is regenerated from the commands rather than transcribed.
$E = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '.'
Push-Location 'C:\Users\12252\Desktop\Files\Code\Newmark Agent'
$cases = @(
  @{ n='empty path list';       a='push-pull --paths' },
  @{ n='git-ignored path';      a='push-pull --paths Newmark2DSH/archive/20261017-155232-preset-cwd-fix/RESULT.md' },
  @{ n='path does not exist';   a='push-pull --paths Newmark2DSH/scripts/does-not-exist.mjs' },
  @{ n='cu-hidden-agent tree';  a='push-pull --paths Newmark2DSH/evidence/cu-hidden-agent' },
  @{ n='path outside the repo'; a='push-pull --paths C:\Windows\win.ini' },
  @{ n='pack, neither flag';    a='pack' },
  @{ n='pack, both flags';      a='pack --dry-run --apply' },
  @{ n='unknown command';       a='frobnicate' },
  @{ n='pack --dry-run';        a='pack --dry-run' }
)
$lines = @('# Guard matrix: the exact command, its real exit code, and the refusal it produced.', '')
foreach ($c in $cases) {
  $out = Invoke-Expression ("node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs " + $c.a + " 2>&1")
  $code = $LASTEXITCODE
  $why = ($out | Where-Object { $_ -match 'refusing:|FAIL - ' } | Select-Object -Last 1)
  $lines += ('exit=' + $code + '  case=' + $c.n)
  $lines += ('    ' + $c.a)
  $lines += ('    ' + ($why -replace '\s+$',''))
}
$lines | Set-Content (Join-Path $E 'raw-01-guard-matrix.txt')
Get-Content (Join-Path $E 'raw-01-guard-matrix.txt') | Out-String -Width 200
Pop-Location
