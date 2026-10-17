# Newmark2DSH 0.3.16 — release / install heartbeat (task-3)

Owner: teammate **release-install**. Task: `task-3` on the shared board. Date: 2026-10-17.
Status: **dry run GREEN; the install was NOT run** (by instruction — it happens only after the
barrier gate is green, on the Lead's word). The push/pull half is written and rehearsed; the real
push awaits the Lead's explicit path list.

Everything below is either **measured** (a command that ran, with its output), **read** (a quote
from a file, with the file named), or marked uncertain. No number here was estimated.

---

## 1. Findings that had to come before the code

### 1.1 The profile installs the plugin with pnpm from a `file:` tarball — not a copy

**Read**, four independent lines that agree:

| # | Evidence | What it shows |
|---|---|---|
| 1 | `<profile>/package.json` → `dependencies.newmark2dsh = "file:C:/Users/12252/.dsh/profiles/desktop/newmark2dsh-0.3.14-official.tgz"` | the profile depends on a tarball by path |
| 2 | `<profile>/pnpm-lock.yaml` importer `.` → `specifier: file:C:/…/newmark2dsh-0.3.14-official.tgz`, `version: file:newmark2dsh-0.3.14-official.tgz`, and `newmark2dsh@file:newmark2dsh-0.3.14-official.tgz` with `resolution: {integrity: sha512-1cs8dQOjn6NSCuRvjnkFi688q2aUDgEu4f5qmssPXxAXb7gxgSRYH6iuq8Im6B5y544RsnB0pK1PNOO5Jk6OAg==, tarball: file:…}` | pnpm resolved it and recorded the tarball's integrity |
| 3 | `<profile>/pnpm-workspace.yaml` → `nodeLinker: hoisted`; `Get-ChildItem <profile>/node_modules/newmark2dsh` → `LinkType: HardLink` on every file | pnpm materialised it as a real directory of store hardlinks, not a symlink and not a manual copy |
| 4 | `Newmark2DSH/archive/20261013-release-0.3.14/windows-install.log` = pnpm progress output ("Packages: +1 … Done in 1.2s using pnpm v11.11.0"), and `pnpm --version` here is 11.11.0 | the 0.3.14 install was a pnpm install |

**Conclusion:** pnpm + `file:` tarball + hoisted linker. The script reproduces that
mechanism (declare the tarball in the profile manifest, then `pnpm install` in the profile).

**Uncertain, stated as such:** no log records the pnpm *verb* the plugin manager issues — only
pnpm's own progress output is written to `.plugin-manager/logs/operation-*/pnpm.log`. Both
`pnpm add` and `pnpm install` print those same lines, so the script cannot claim
to reproduce the identical verb, only the identical mechanism and the identical resulting
specifier and lockfile shape.

### 1.2 The install is a hybrid: two components are `link:`s into the live workspace

**Read:** `<profile>/package.json` declares `newmark2dsh-memorylab` and
`newmark2dsh-computeruse` as
`link:C:/Users/…/Newmark2DSH/packages/newmark-core/components/{memorylab,computeruse}`, and
`<profile>/node_modules/` holds them as **junctions** to those workspace directories.

Consequence, stated plainly: installing the 0.3.16 tarball does **not** pin the bytes of those two
component trees. The core row composes `./components/<name>/index.js` relative to the
*installed* bundle, so the runtime that loads is the installed copy — but a reader of the profile
dependency list should know the two links exist and point at a working tree that is being edited by
other teammates. This task neither created nor changed them (out of scope).

### 1.3 The repository's index is dirty, and not only in the working tree

**Measured** at the start of this task:

* `git status --porcelain | Measure-Object -Line` → **5104** lines.
* `git status --porcelain Newmark2DSH/scripts` → lines beginning `A ` —
  thousands of paths are already **staged**, not merely untracked. A bare `git commit`
  would publish them; `git add -A` would enlarge that set.

**Read** — the root `.gitignore` ignores, at *any* depth: `archive/`,
`OVERVIEW.md`, `*.log`, `node_modules/`, `dist/`. Two
consequences that shaped the script:

* `Newmark2DSH/archive/**` and `Newmark2DSH/OVERVIEW.md` **cannot be committed**
  here without `-f`. (`git check-ignore -v` confirms:
  `.gitignore:66:OVERVIEW.md  Newmark2DSH/OVERVIEW.md` and
  `.gitignore:62:archive/  Newmark2DSH/archive/a.mjs`.)
* A `*.log` evidence file named in a path list would be **silently omitted** by
  `git add`. The script therefore refuses an ignored path outright instead of reporting a
  commit it did not make.

Also read: `core.autocrlf=true`, so git normalises text blobs to LF in the object store.
The round-trip proof below is therefore about the paths and blobs **git records**, never about raw
working-tree bytes for text files.

---

## 2. What was written

**`Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs`** (new, 41.8 kB) — one file, two
subcommands, plus the round-trip proof:

    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs pack --dry-run
    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs pack --apply
    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs push-pull --paths <p> [<p> ...]

Design points that exist for a reason, each explained in the file's header:

* **`pack` refuses unless given exactly one of `--dry-run` / `--apply`.**
  A release script whose default mode writes into the live profile is the failure this task exists
  to prevent.
* **The tarball name carries its content hash**
  (`newmark2dsh-0.3.16-heartbeat-<sha256[:8]>.tgz`), and the installed directory is
  removed before `pnpm install`. pnpm keys a `file:` dependency by the integrity
  in the lockfile; without a name that changes with the bytes, a re-run can keep the previous
  contents. This is what makes "re-runnable" a property of the mechanism.
* **The tarball is re-read with a hand-rolled tar reader** (gzip + 512-byte headers, zero-block
  terminator, non-zero trailing bytes REFUSE) and cross-checked against npm's own file list. Asking
  the archiver that wrote the file to confirm it would be the wrong witness. A set disagreement
  fails the run rather than picking one reader to trust.
* **`git add -- <paths>` (never `-A`) then `git commit -- <paths>`.**
  The pathspec on `commit` is what leaves the ~5000 already-staged entries staged and
  uncommitted. The index is fingerprinted with `git ls-files -s` **before and after** the
  staging, so "only the named paths were staged" is measured, not promised — then the new commit's
  own file list is read back and the run **refuses to push** if it names anything else. The guard
  runs before the push, which is the only moment a commit becomes dangerous.
* **Refusals before any write:** an empty path list (exit 2); a path outside the repository
  (exit 3); a path under `~/.dsh` (exit 3); a path under
  `Newmark2DSH/evidence/cu-hidden-agent/` (exit 3); a git-ignored path (exit 1, before any
  git command runs).
* **stdout is one JSON receipt**; progress goes to stderr. Exit codes: `0` ok,
  `1` a step ran and failed, `2` usage refusal, `3` preflight refusal
  (nothing written).

---

## 3. Measured results

### 3.1 `pack --dry-run` — GREEN, exit 0

    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs pack --dry-run

| Quantity | Value |
|---|---|
| package manifest version | `0.3.16` (already bumped by the Lead; this task did not change it) |
| manifest sha256 | `a09e8d50c6a1ac108ab81e87860a7fff7a4eb95d9542f78e75dc10687d6be758` |
| tarball | `newmark2dsh-0.3.16.tgz`, **1 163 467** bytes |
| tarball sha256 | `767fbdfb1344d4a686b8535ad5425e66170e5321d765f0ed032fedb08681d2e4` |
| npm shasum / integrity | `b5a157c5dd3543b2a9e4214d163717dd907e09cb` / `sha512-CJRgXcugAzmoFwNB3tXLetTGGdLLj9/9tHGtPaQ+7n1ZvB1pEFP3//b04pCV0PB7iSW3clZf04ewxDHeR38LSA==` |
| members shipped | **92**, unpacked 3 283 672 bytes |
| tarball vs source | **92 / 92 byte-identical**, 0 mismatched |
| files in the package tree that are NOT shipped | **12** |

The 12 unshipped files are runtime byproducts, and they are *outside* every `files`
pattern: 11 under `components/computeruse/.runtime/` (a hidden-desktop agent payload plus
its ledger) and `components/computeruse/lib/__pycache__/linux-desktop.cpython-312.pyc`.
They come from real hidden-desktop runs in the working tree; the package correctly does not carry
them.

Measured **determinism**: two consecutive dry runs produced the same tarball sha256
(`767fbdfb` … `d2e4`) and the same size, so the content-addressed specifier is
stable while the source is (raw-03).

### 3.2 The dry run does not touch the profile

Before and after two `pack --dry-run` runs (raw-03), the profile fingerprint is
**identical**:

    package.json         3004B3AE77BB7716B0E73EF5F64F89D7152B0E69AB8214D61DD56F6415B407A4
    pnpm-lock.yaml       0B93B36AF943C132AC8F1748B6566EC29DCF62BF6245BA6F7C79448DAA2B7784
    pnpm-workspace.yaml  A9688923752E9798ABB52167551E368E1E3298B268E1BB8477025E2044A33FCD
    cordis.yml           C300DCF2EBC5F02062D6591268D29D3DB6FE45E0CB138F5467276FE2BA06076E
    cordis.patch.yml     EC0E535344073E49350CE4214774426014DF4997CF118B2FB7CF68A125A40663

    backupDirs 1 -> 1 | *.tgz 4 -> 4 | installed version 0.3.14 -> 0.3.14 | profile entries 21 -> 21

### 3.3 Every guard was seen to go RED

    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs <case>      (raw-01)

| Case | Exit | Refusal |
|---|---|---|
| `push-pull --paths` (empty) | **2** | the path list is empty … never runs a bare `git add` or `git add -A` |
| `push-pull --paths Newmark2DSH/archive/…/RESULT.md` | **1** | caught by the ignore check *before* any git command (`commands: []`) |
| `push-pull --paths Newmark2DSH/scripts/does-not-exist.mjs` | **3** | path does not exist |
| `push-pull --paths Newmark2DSH/evidence/cu-hidden-agent` | **3** | refusing to stage the pre-existing browser-cache tree |
| `push-pull --paths C:\Windows\win.ini` | **3** | path is outside the repository |
| `pack` (neither flag) | **2** | pass exactly one of `--dry-run` / `--apply` |
| `pack --dry-run --apply` | **2** | same |
| `frobnicate` | **2** | unknown command |
| `pack --dry-run` | **0** | — |

One defect was found and fixed by this exercise rather than left as dead code:
`git check-ignore --stdin` was called **without stdin**, so the ignore guard produced no
output and never fired (the case above first died later, inside `git add`). It is now
passed the candidate list on stdin, and the case is caught before any git command runs. A check that
cannot fire reads like coverage, which is why it is recorded here.

### 3.4 The push/pull mechanism, rehearsed end to end in a throwaway repository

`reproduce-fixture.ps1` builds a throwaway repo with a **bare remote**, commits a base,
then plants the mutation this whole design exists for: a **junk path already staged in the real
index** while `work/target.txt` is the one named path. It then runs the script against the
fixture with `--repo`.

Result (raw-02 + `fixture-roundtrip.json`, exit 0, all 10 steps green):

| Proof | Value |
|---|---|
| commit | `2100b8e60802af03fdb8d07ba97670e45f9e9a4e` |
| commit's changed paths | `work/target.txt` — only the named path |
| index entries changed by staging | `work/target.txt` — `strayEntries: []` |
| the planted junk | still staged after the run (`realIndexStagedAfter=[work/junk.txt]`), **never committed** |
| `git rev-parse HEAD` | `2100b8e6…` |
| `git rev-parse origin/master` | `2100b8e6…` |
| `git ls-remote origin refs/heads/master` | `2100b8e6…` |
| `git pull --ff-only origin master` | `Already up to date.` |
| `git status --porcelain -- work/target.txt` | empty |
| commit count | 2 (base + the one commit) |

The fixture is the RED case in miniature: an `add -A` plus a bare `commit`
would have published `work/junk.txt`, and the measurement shows it did not.

---

## 4. Deliberately NOT done, and what is still uncertain

1. **The install was not run.** By instruction and by the handover order (gates green -> push/pull
   -> install -> restart). `pack --apply` is implemented and refuses without the flag; it
   will back the installed plugin up into
   `<profile>/.newmark-install-backups/<stamp>-newmark2dsh-0.3.14-before-0.3.16/`
   (plugin copy + profile manifest/lock/workspace/cordis files) before writing anything, and rolls
   back on a failed verification.
2. **No real push has happened.** It needs the Lead's explicit path list; the script takes one and
   refuses an empty one. The plugin and profile paths are outside the repository, so `~/.dsh`
   can never be in the commit.
3. **`git rev-parse origin/master` in this repository reflects the local remote-tracking
   ref.** On a stale clone it can disagree with the remote; the script therefore also reads
   `git ls-remote origin refs/heads/master` and requires all three (HEAD, tracking ref,
   remote ref) to be the same commit.
4. **The exact pnpm verb the DSH plugin manager issues is not recoverable from anything readable
   here** (see 1.1).
5. **The two `link:` component dependencies remain** (see 1.2); the install will not pin
   those bytes.
6. **npm pack determinism was measured for this source only** (two runs, identical sha256). It is
   not a general claim about npm across versions.
7. **The governance write-back is outside this task's write scope.** `Newmark2DSH/README.md`,
   `OVERVIEW.md`, `VERSION.md` and `taste.md` were not edited by this
   task; the Lead owns them, and `OVERVIEW.md` is git-ignored anyway (see 1.3).

---

## 5. Reproduce

    # pack + verify + print the plan, touching nothing outside a temp dir
    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs pack --dry-run

    # the guard matrix, with real exit codes
    pwsh -NoProfile -File Newmark2DSH/evidence/20261017-heartbeat-barrier/run-guard-matrix.ps1

    # the fixture round trip (throwaway repo + bare remote + planted staged junk)
    pwsh -NoProfile -File Newmark2DSH/evidence/20261017-heartbeat-barrier/reproduce-fixture.ps1

    # install, only after the barrier gate is green and the Lead says so
    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs pack --apply

    # the real round trip, with the Lead's path list
    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs push-pull --paths <path> [<path> ...]

## 6. Files in this folder

| File | What it is |
|---|---|
| `install-before.json` | the installed 0.3.14 plugin's before-state: 104 files with per-file sha256, plus the profile file hashes and the dependency specifier |
| `pack-dry-run-<stamp>.json` | the full machine-readable receipt of a dry run |
| `fixture-roundtrip.json` | the receipt of the green fixture round trip |
| `raw-01-guard-matrix.txt` | every guard case, its command, and its real exit code |
| `raw-02-fixture-roundtrip.txt` | the fixture transcript, verbatim |
| `raw-03-dry-run-isolation.txt` | pack determinism and the profile before/after fingerprints |
| `red-proofs/*.json` | the refusal receipts behind section 3.3 |
| `reproduce-fixture.ps1` | the fixture builder + runner behind section 3.4 |
| `run-guard-matrix.ps1` | the command behind the exit-code matrix in section 3.3 |
---

## 7. Append-only additions, 2026-10-17 (after the Lead's path list and target decision)

This section is **appended**; nothing above was rewritten. Where a number below differs from a
number above, both are real and were measured at different moments — the tree is moving because
other teammates are writing into `archive/` and `evidence/` concurrently.

### 7.1 Target decision, recorded as the Lead's (not this task's guess)

**Read** from the Lead's message: push to the **workspace remote**
`origin = https://github.com/positer/Newmark-Agent.git`, branch `master`, as **one
commit on top of `419428f329ec294a2ef128255b1090817f8ee061`**, then `git pull --ff-only`
to prove the round trip. The Lead's stated reason: the handover allows "github.com/positer/newmark2dsh
或本工作区 remote", and the release repo's own workflow (`sync-release-repo.mjs` +
`prepare.mjs`) copies the package into a separate stage — a publish step this round does
not ask for.

**Measured** agreement with that premise, before anything was staged:
`git rev-parse HEAD` = `git rev-parse origin/master` =
`419428f329ec294a2ef128255b1090817f8ee061`, and `git status --porcelain | Measure-Object
-Line` = **5104** lines, none of them committed.

### 7.2 The Lead's path list, pre-flighted with `push-pull --dry-run` — two decisions needed

    node Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs push-pull --dry-run --paths <the 23 paths>

**Measured** (2026-10-17T09:00Z and 09:01Z):

| Quantity | Value |
|---|---|
| named paths given | 23 |
| named paths that do not exist | **0** |
| named paths that are git-ignored | **2** |
| files behind those two ignored paths | **41** (at 09:01Z; 40 at 09:00Z — a file appeared between the two runs) |
| files to stage with `--include-ignored` | **90**, 5 422 329 bytes |
| files to stage without the ignored ones | **49** |
| exit of the dry run with no flag | **1** — "refusing: 2 path(s) are git-ignored" |
| exit of the dry run with `--include-ignored` | **0**, `staged: false`, `pushed: false` |

The two ignored named paths, with the rule that ignores each (`git check-ignore -v`):

    .gitignore:66:OVERVIEW.md   Newmark2DSH/OVERVIEW.md
    .gitignore:62:archive/      Newmark2DSH/archive/20261017-084527-heartbeat-restart-barrier

**The conflict, named rather than silently resolved.** The root `.gitignore` introduces
those rules with the comment `# Local-only reports and evidence; never publish archive
contents.` The Lead's list asks for exactly those contents to be published. The script will not
paper over it: it refuses an ignored path unless the caller passes `--include-ignored`,
which force-adds **only the named paths** (`git add -f -- <paths>`, never
`-A`), and records in the receipt which entries needed it. Either way the decision is the
Lead's; two runs of the same command differ only by that one flag.

**Second gap in the list:** `Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs` — the file
this task created — is **not** in the 23 paths, so the release script itself would not be published.

### 7.3 What was re-measured after the push-side changes

The push half gained `--dry-run` and `--include-ignored`, so both were re-proven
rather than assumed:

* the fixture round trip still ends green: commit `d590cc6bca25719b3a19c3f66e7ae82e7595e01a`,
  changed paths `[work/target.txt]`, `strayEntries: []`, HEAD ==
  `origin/master` == `ls-remote`, `status --porcelain` on the named path
  empty, and the planted junk still staged and uncommitted;
* the guard matrix exit codes are unchanged: `2, 1, 3, 3, 3, 2, 2, 2, 0`
  (`raw-01-guard-matrix.txt`).

### 7.4 Housekeeping the Lead asked for

No `.tmp-*` file remains in this folder — `.tmp-diff.js` and
`.tmp-fixture.ps1` were removed, and the four scratch scripts that remain are named for
what they are (`reproduce-fixture.ps1`, `run-guard-matrix.ps1`) rather than
`.tmp-`.

### 7.5 Still not done

The **install and the push are both still not run**. The push waits on the Lead's word and on the
two decisions in 7.2; the install waits on the full gate going green. Nothing here has been written
to the profile or to the remote.

---

## 8. Append-only additions, 2026-10-17 (Lead's decisions, the install rehearsal, and three defects found by it)

### 8.1 The Lead's decisions, recorded

* **A = (ii)**: do **not** force-add. `Newmark2DSH/OVERVIEW.md` and
  `Newmark2DSH/archive/20261017-084527-heartbeat-restart-barrier` are dropped from the
  commit, because the repository's own `.gitignore` introduces those rules with
  `# Local-only reports and evidence; never publish archive contents.`
* **B = yes**: `Newmark2DSH/scripts/release-heartbeat-0.3.16.mjs` is added to the list.
* **Final list: 22 paths, no `--include-ignored`.**

**Measured** with `push-pull --dry-run --paths <the 22 paths>` (exit **0**):
**55 files, 2 156 588 bytes, 0 ignored, `staged: false`, `pushed: false`.**
This differs from the Lead's earlier 71 files / ~5.0 MB because that measurement included the two
dropped paths (90 files then) and because this folder has grown since — the tree is moving while
other teammates write evidence.

**Finding to report to the user, not to resolve here:** the project protocol requires
`OVERVIEW.md` to be maintained per project, and this repository's global ignore rule
ignores every `OVERVIEW.md` at any depth. So this round's `OVERVIEW.md` write-back
and its archive entry stay **local-only**, and the governance requirement is in direct conflict
with the ignore rule. That conflict is named here rather than papered over with a force-add.

### 8.2 What "installed" actually means in this profile — measured link structure

| Path | LinkType | Points at |
|---|---|---|
| `<profile>/node_modules/newmark2dsh` | *(none)* — a real directory | — |
| `<profile>/node_modules/newmark2dsh-memorylab` | **Junction** | `Newmark2DSH/packages/newmark-core/components/memorylab` |
| `<profile>/node_modules/newmark2dsh-computeruse` | **Junction** | `Newmark2DSH/packages/newmark-core/components/computeruse` |
| inside the bundle: `components/{agent-api,computeruse,heartbeat,memorylab,newmate}` | *(none)* — real directories | — |
| the bundle's 104 files | **93 HardLink** (pnpm store), 0 other reparse points | the pnpm store entry materialised from the tarball |

Which one the runtime loads is **read**, not guessed: the installed `index.js` composes each
component with a bundle-relative path —
`load: () => import('./components/memorylab/index.js')` (line 177), `./components/computeruse/index.js` (185),
`./components/agent-api/index.js` (193), `./components/newmate/index.js` (197),
`./components/heartbeat/index.js` (201) — so the core row loads the **installed bundle's own**
components; the two profile junctions are not on that path.

**The decisive non-vacuous check, measured before the install:**

| File | installed 0.3.14 (bytes / sha256 first 16) | source 0.3.16 | `broadcast` occurrences |
|---|---|---|---|
| `components/heartbeat/component.js` | 4 604 / `1b6278ddfc6c8676` | 24 286 / `400e69a1a9f2e758` | installed **0**, source **4** |
| `components/heartbeat/index.js` | 2 691 / `c5e4fd25d5476eb3` | 6 716 / `80926f83dfe41eff` | — |
| `components/memorylab/component.js` | 79 063 / `d1ae2fd3bfbe85c1` | identical | — |

The heartbeat files differ, so the post-install comparison for them cannot pass vacuously. The
memorylab file does **not** differ, which is exactly why a hash comparison alone is not evidence:
it is why the verifier now reports the link structure per path.

### 8.3 Three defects the rehearsal found, and the fix for each

The whole install path was rehearsed against a **throwaway profile** whose
`node_modules/newmark2dsh` was a **junction straight into the live source tree** — the
dangerous shape, and the shape the profile already uses for two other packages
(`rehearse-install-throwaway-profile.ps1`, transcript `raw-04-install-rehearsal.txt`).

1. **A recursive remove could have deleted the source tree.** `fs.rmSync(dir, { recursive: true })`
   against a directory junction can recurse into the junction's target. The install removes the
   materialised package before reinstalling, so a junctioned bundle would have taken the source with
   it. Fixed with `removeInstalledDir()`: a reparse point is removed with `unlinkSync`
   (which takes the link and leaves the target alone), a real directory with `rmSync`.
   **Measured proof:** `removedInstalledDir=unlinked-reparse-point` and
   `sourceFilesBefore=104`, `sourceFilesAfter=104`,
   `sourceTreeUnchanged=True` (all 104 file hashes compared).
2. **The backup died on a junction.** `fs.cpSync` defaults to `dereference: false`,
   so it tried to recreate the junction as a symlink inside the backup and failed with
   `EPERM` — before anything else ran. Fixed with `dereference: true`, which copies
   the contents.
3. **An unexpected exception produced no receipt at all.** The EPERM above ended the process with a
   bare stack trace, so a caller could not tell what had happened. Every path through the script is
   supposed to end in a machine-readable receipt, so `main()` now wraps the run and emits
   `{ ok: false, unhandled: <stack> }` with exit 1.

A fourth, smaller finding: the first success criterion required the top-level installed entry not to
be a link. That is right for this profile (`nodeLinker: hoisted`) and **wrong** for pnpm's
default isolated linker, where `node_modules/<pkg>` is legitimately a link into
`node_modules/.pnpm`. The criterion now accepts a top-level link **only** when it resolves
inside the profile's own `.pnpm` store, and records the resolved path either way.

### 8.4 The rehearsal's own numbers (green, exit 0)

    pack -> 92/92 source-identical -> backup (104 files) -> manifest -> pnpm install (1.3 s)
      -> "installed 92/92 files match the tarball byte for byte" -> install-after evidence written

`matched 92/92`, `missing 0`, `mismatched 0`, `linked 0`,
`linkTypes { file: 0, hardLinkedFile: 92, reparsePoint: 0 }`, installed version
`0.3.16`, and the heartbeat component read back as 24 286 bytes with 4
`broadcast` occurrences. The receipt is `rehearsal-install-after.json`.

### 8.5 New guard, for the reason the Lead gave

`verification.linked` is now a **failure**, not a footnote, and it is computed from a
reparse-point check on the file **and on every ancestor directory** under the bundle
(`linkOnPath`). A per-file `lstat` alone would miss a junctioned directory: every
file below it would look like an ordinary file whose bytes happen to match the source the tarball
was packed from — a hash comparison that passes while nothing was installed.

### 8.6 Still not done

Neither the push nor the install has run against the real profile or the real remote. Both wait on
the Lead's explicit go.

