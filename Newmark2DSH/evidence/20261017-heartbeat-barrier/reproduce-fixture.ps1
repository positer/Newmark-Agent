# Reproduces the push/pull rehearsal: a throwaway repo with a bare remote, a pre-staged junk
# entry in the REAL index, and one modified named path. The junk is the mutation that proves the
# commit and the push carry only the named path.
$ErrorActionPreference = 'Stop'
$fx = Join-Path $env:TEMP ('nm-roundtrip-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$repo = Join-Path $fx 'repo'
$remote = Join-Path $fx 'remote.git'
New-Item -ItemType Directory -Path (Join-Path $repo 'work') -Force | Out-Null
git init --bare -b master $remote | Out-Null
git -C $repo init -b master | Out-Null
git -C $repo config user.email 'fixture@example.invalid'
git -C $repo config user.name 'fixture'
Set-Content -Path (Join-Path $repo 'work\keep.txt')   -Value 'keep'
Set-Content -Path (Join-Path $repo 'work\target.txt') -Value 'target'
Set-Content -Path (Join-Path $repo 'work\junk.txt')   -Value 'junk that was pre-staged by nobody-task'
git -C $repo add work/keep.txt work/target.txt
git -C $repo commit -q -m 'base'
git -C $repo remote add origin $remote
git -C $repo push -q -u origin master
Set-Content -Path (Join-Path $repo 'work\target.txt') -Value 'target v2'
git -C $repo add work/junk.txt
Write-Output ('fixture=' + $fx)
Write-Output ('realIndexStagedBefore=[' + ((git -C $repo diff --cached --name-only) -join ';') + ']')
Write-Output ('realIndexFileSha256Before=' + (Get-FileHash (Join-Path $repo '.git\index') -Algorithm SHA256).Hash)
Write-Output '--- node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs push-pull --repo <fixture> --paths work/target.txt ---'
Push-Location 'C:\Users\12252\Desktop\Files\Code\Newmark Agent'
node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs push-pull --repo $repo --paths work/target.txt --message 'fixture: only the named path' 2>&1
$scriptExit = $LASTEXITCODE
Pop-Location
Write-Output ('scriptExit=' + $scriptExit)
Write-Output ('realIndexStagedAfter=[' + ((git -C $repo diff --cached --name-only) -join ';') + ']')
Write-Output ('realIndexFileSha256After=' + (Get-FileHash (Join-Path $repo '.git\index') -Algorithm SHA256).Hash)
Write-Output '--- the commit (changed paths only) ---'
git -C $repo show --pretty=format:'%H%n%s' --name-only HEAD
Write-Output '--- refs ---'
Write-Output ('HEAD=' + (git -C $repo rev-parse HEAD))
Write-Output ('origin/master=' + (git -C $repo rev-parse origin/master))
Write-Output ('ls-remote=' + ((git -C $repo ls-remote origin refs/heads/master) -split '\s')[0])
Write-Output ('statusOnNamedPath=[' + ((git -C $repo status --porcelain -- work/target.txt) -join ';') + ']')
Write-Output ('logCount=' + (git -C $repo rev-list --count HEAD))
