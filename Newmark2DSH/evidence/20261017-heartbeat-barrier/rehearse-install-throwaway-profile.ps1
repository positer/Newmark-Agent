# Rehearses "pack --apply" against a THROWAWAY profile, so the install path is seen to work before
# it touches the real one. The planted mutation is the dangerous one: the throwaway profile's
# node_modules/newmark2dsh is a JUNCTION into the live source tree, which is what the profile does
# for two other packages. If the install removed it with a recursive rm, the source tree would be
# deleted; the run must unlink the junction instead, and the source must be byte-identical after.
$ErrorActionPreference = 'Stop'
$src = 'Newmark2DSH\packages\newmark-core'
$realProfile = "$env:USERPROFILE\.dsh\profiles\desktop"
$fx = Join-Path $env:TEMP ('nm-profile-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path (Join-Path $fx 'node_modules') -Force | Out-Null
$manifest = [ordered]@{
  name = 'dsh-profile-desktop'
  private = $true
  dsh = [ordered]@{ profile = [ordered]@{ bundles = @('newmark2dsh') } }
  dependencies = [ordered]@{ 'newmark2dsh' = 'file:' + (Join-Path $realProfile 'newmark2dsh-0.3.14-official.tgz').Replace('\','/') }
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $fx 'package.json')
# the mutation: the "installed bundle" is a junction straight into the source tree
New-Item -ItemType Junction -Path (Join-Path $fx 'node_modules\newmark2dsh') -Target (Resolve-Path $src).Path | Out-Null
$srcBefore = Get-ChildItem -Recurse -File $src | Sort-Object FullName | ForEach-Object { $_.FullName + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
Write-Output ('throwawayProfile=' + $fx)
Write-Output ('sourceFilesBefore=' + $srcBefore.Count)
Write-Output ('junctionLinkType=' + (Get-Item (Join-Path $fx 'node_modules\newmark2dsh') -Force).LinkType)
Write-Output '--- pack --apply against the throwaway profile ---'
Push-Location 'C:\Users\12252\Desktop\Files\Code\Newmark Agent'
# stdout is the receipt and stderr is progress, so they are separated here rather than parsed out
# of a merged stream: a progress line can contain a brace and would break the JSON reader.
& node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs pack --apply --profile $fx 2> (Join-Path $fx 'stderr.txt') > (Join-Path $fx 'stdout.json')
$code = $LASTEXITCODE
Pop-Location
$r = Get-Content (Join-Path $fx 'stdout.json') -Raw | ConvertFrom-Json
Write-Output '--- progress ---'
Get-Content (Join-Path $fx 'stderr.txt') | ForEach-Object { Write-Output ('  ' + $_) }
Write-Output ('applyExit=' + $code + ' ok=' + $r.ok + ' performed=' + $r.install.performed + ' removedInstalledDir=' + $r.install.removedInstalledDir)
Write-Output ('installedVersion=' + $r.verification.installedVersion + ' matched=' + $r.verification.matched + '/' + $r.verification.checked + ' missing=' + @($r.verification.missing).Count + ' mismatched=' + @($r.verification.mismatched).Count + ' linked=' + @($r.verification.linked).Count)
Write-Output ('linkTypes=' + ($r.verification.linkTypes | ConvertTo-Json -Compress))
Write-Output ('installedDirIsLink=' + $r.verification.installedDirIsLink + ' backupDir=' + $r.install.plan.backupDir)
$srcAfter = Get-ChildItem -Recurse -File $src | Sort-Object FullName | ForEach-Object { $_.FullName + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
Write-Output ('sourceFilesAfter=' + $srcAfter.Count)
Write-Output ('sourceTreeUnchanged=' + (($srcBefore -join '|') -eq ($srcAfter -join '|')))
Write-Output ('throwawayBundleLinkTypeAfter=[' + ((Get-Item (Join-Path $fx 'node_modules\newmark2dsh') -Force).LinkType) + ']')
Write-Output '--- the installed heartbeat component in the throwaway profile ---'
$hb = Join-Path $fx 'node_modules\newmark2dsh\components\heartbeat\component.js'
Write-Output ('installedHeartbeatBytes=' + (Get-Item $hb).Length + ' broadcastOccurrences=' + ((Select-String -Path $hb -Pattern 'broadcast' -AllMatches -SimpleMatch | Measure-Object).Count))
Write-Output ('sourceHeartbeatBytes=' + (Get-Item "$src\components\heartbeat\component.js").Length)
Write-Output ('throwawayProfilePath=' + $fx)
