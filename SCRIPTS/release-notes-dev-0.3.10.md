# Newmark Agent dev-0.3.10

Development prerelease for the durable Goal/Flow lifecycle and Build history hardening shipped in the local-first desktop, TUI, and CLI runtime.

## Highlights

- Every terminal Build Block writes one idempotent durable `work_overview` long-log entry at declaration end, including short replies and recovered terminal runs, and performs one Goal completion audit when a Goal is present.
- A user interruption pauses a running Goal/Flow; ordinary user input cannot accidentally resume or complete it. Explicit resume immediately claims the Goal/Flow continuation and starts a goal/flow-driven Build.
- Owner-scoped lifecycle markers distinguish a live backend from a frontend tracking timeout or a dead owner. Unexpected exits pause Goal/Flow on the first cold load and record recovery; backend timeout cold starts do not mutate live background state.
- Windows packaged Browser-Use native clicks now yield between focused native mouse events so webview guest transitions are delivered reliably.
- Context folding keeps evicted history in a conversation-isolated append-only archive while preserving the bounded hot cache and visible conversation history.

## Validation

- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed with 0 errors; the repository retains 56 existing warnings.
- `npm.cmd run dist:windows-release`: passed, including the complete release gate and packaging.
- `npm.cmd run dist:linux`: passed through WSL with the cached Electron 43.1.1 archive and the complete release gate.
- Final package smokes passed: Windows portable ZIP, Windows MSI, Linux AppImage, Linux deb, and Linux unpacked ZIP.
- Deterministic package smokes reported `real_api_called:false`.
- Linux 20-run latency benchmark passed: hot first-event p95 `13.548 ms`, hot first-token p95 `10 ms`, cold local-before-provider `52.681 ms`, two tool-provider requests, and zero hot persistence writes.

## Assets

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `Newmark-Agent-0.3.10-x64.msi` | 225847605 | `472E1445F32484861D7779E4054EB7C918234B62A2EE2FA968006221AFA4D869` |
| `Newmark-Agent-0.3.10-win-unpacked-x64.zip` | 291678940 | `DBD1745216220FFE11C035B4D43CE6258332C439B467FFF24ABE56035A657ACE` |
| `Newmark-Agent-0.3.10-x86_64.AppImage` | 175786564 | `89CA21E673FEBDC494674D155E377CDF32B3BF312E42D26975867FB7554ADB08` |
| `Newmark-Agent-0.3.10-amd64.deb` | 135458768 | `BC596453869FE5A542B7328A9261A780BD1C5A6569CE0B3EDA0621FD53A5320E` |
| `Newmark-Agent-0.3.10-linux-unpacked-x64.zip` | 171911069 | `5A92E4BC8EB428CCE335FE50D81B4E51C7308842BA53BD6C63E232E73D2A6160` |

These are unsigned prerelease packages. Verify the downloaded files against the SHA-256 values above.
