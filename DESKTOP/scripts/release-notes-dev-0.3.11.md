# Newmark Agent `dev-0.3.11`

This prerelease closes the tester-facing blockers found in the `dev-0.3.10` real-model pressure audit.

## Fixes

- `--help` / `-h` and `--version` / `-v` now terminate before GUI, TUI, CLI, server, or first-run runtime initialization. The help text exposes the GUI, TUI, CLI, Flow, editor, and non-interactive command surface from one contract.
- Electron utility graceful shutdown now confirms Windows process-tree quiescence using the captured root creation identity when Electron delays or returns a false child-handle kill result. Unknown descendants still keep the runtime quarantined; a dead root handle is detached without clearing that quarantine.
- A stale renderer runtime state can no longer lose an ordinary user input as `Guide · Rejected`. Explicit lifecycle rejections caused by an ended run or mismatched run ID are recorded as deferred and replayed with the same payload as a fresh Build after an authoritative state refresh.
- Deferred Guide/Goal continuations are resumed after the finalization barrier settles, and a tracked Goal is audited and synchronized at every terminal Build Block.
- Provider empty responses receive bounded same-deployment retries instead of silently completing a Build. The renderer also clears a stale local send lock when an authoritative target snapshot is already idle, preventing the next prompt from disappearing during rapid user turns.
- BrowserUse is bound to the conversation's built-in browser and right sidebar. ComputerUse is an explicit conversation-bound toggle independent of Build lifetime, with one process-wide lease and `computerUse occupied` contention feedback. High-frequency public Build events are frame-coalesced while durable event history remains complete.
- Added source, real Electron, packaged CLI/TUI, and real-provider regression coverage for help termination, stale Guide recovery, graceful utility stop, identity-bound process-tree failure, quarantine cleanup, ComputerUse contention, BrowserUse target binding, long UI event streams, and rapid consecutive sends.

## Validation

- The deterministic gate passes 1465/1465 assertions. The final packaged real-provider matrix passes 20 CLI rounds, 20 GUI rounds, three Goal continuations, queue drain, conversation isolation, and a 600-fragment long-context run; process cleanup reports `remaining=0`.
- Windows MSI, portable ZIP, CLI smoke, and SSH-TUI four-restart stress passed locally. Linux artifacts are built and smoke-tested by `.github/workflows/release-linux.yml` on Ubuntu; the remote hashes are filled after the workflow download audit.

Packages are unsigned prerelease builds. Verify the SHA-256 values below before installing:

| Asset | SHA-256 |
| --- | --- |
| `Newmark-Agent-0.3.11-x64.msi` | `E9BFB514B583556BFB64E8B35815EE8CD916CAC4FACC43EE0AC1FFD87D305817` |
| `Newmark-Agent-0.3.11-win-unpacked-x64.zip` | `B8E287CDB393482EF1B3CEB9A91AB4BF86328C06AF8A13A80239DD4778ECFDFB` |
| `Newmark-Agent-0.3.11-x86_64.AppImage` | `CC3CB39D4F011E81330E4F097A5A1029E13CC00026E8799FCB7379AD8B008E0D` |
| `Newmark-Agent-0.3.11-amd64.deb` | `F4FE914FE8DA3BE65CF055C0F2E86DC44D4D078771D94009D4E6AB81496A2767` |
| `Newmark-Agent-0.3.11-linux-unpacked-x64.zip` | `3CDE1AAEFFBACA2E6B9F3E5AAB9FFE0C2899308716DDA83B6DD5C32868E3DAB2` |

The checksum manifest is attached to the GitHub release as `SHA256SUMS`; the tagged release URL is https://github.com/positer/Newmark-Agent/releases/tag/dev-0.3.11.
