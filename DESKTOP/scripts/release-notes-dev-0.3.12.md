# Newmark Agent `dev-0.3.12`

This release hardens the user-level pressure paths found during the `dev-0.3.11` installed-directory audit and reduces repeated work during large-context preparation.

## Fixed

- CLI help/version discovery and unknown-command failures now terminate before provider/runtime startup and preserve actionable exit codes.
- Explicit `--root` runs no longer inherit legacy AppData conversations, archives, providers, or external workspaces; installed writable state remains user-scoped.
- Fresh GUI roots default to deterministic exit-on-close behavior while existing explicit minimize preferences remain supported; shutdown cleanup is bounded.
- The packaged `Newmark Console Runtime.exe` now enters the same terminal sidecar path as the native console launcher, so direct Runtime TUI sessions inherit PTY handles and honor `q`/`Q` exits.
- TUI stop/escape races, provider timeout cleanup, archive force-stop/parallel persistence, context compression idempotency, and shared GUI/TUI/CLI conversation state are hardened.
- Release pressure scripts now propagate batch exit codes, retry Windows temporary-root cleanup without false `EPERM` failures, and use visible work-run completion rather than an obsolete renderer promise.

## Validation

- `npm.cmd run test:full-release` exits `0`, including the source feature suite, intelligence-tier stress, TUI/SSH/WSL lanes, CLI contracts, and GUI/TUI/CLI shared-backend stress.
- Packaged safe gates pass CLI/GUI help and failure boundaries, explicit-root isolation, protected-install restart, archive/context-compression pressure, loopback PTY/light-theme/restart checks, and console-wrapper argument boundaries.
- Temporary-root context pressure passes 120 rapid conversation creations and 120 rapid archives with no missing or pending archive; the full memory/restart lane passes 300 components and 600 queries.
- Three consecutive no-context black-box canaries, all `gpt-5.6-luna` with `max` reasoning, reported no new product problem and cleaned their temporary roots/processes.
- The generated Windows MSI was installed locally with elevated Windows Installer and the installed GUI, console, Runtime, and isolated state probes report `0.3.12` successfully.

## Artifacts

- `Newmark-Agent-0.3.12-x64.msi` — per-machine Windows installer.
- `Newmark-Agent-0.3.12-win-unpacked-x64.zip` — portable Windows directory with GUI, TUI, CLI, and console launchers.

The release is an unsigned prerelease build. Verify downloaded artifacts against these SHA-256 fingerprints:

- `Newmark-Agent-0.3.12-x64.msi` — `5FBB848EFEACDA751569B2BF3C1B57D3A0DCF1CA894AF343AB5352053DA0D110`.
- `Newmark-Agent-0.3.12-win-unpacked-x64.zip` — `870DCEADF81305B070E0E684BF0619D9D28C952BFE731C2853863B4A89E246D7`.
- Packaged `resources/app.asar` — `D14212C88D51C30A9E01542B1CD80BBEFC268D14E1077120AADB2552DC393D8A`.
