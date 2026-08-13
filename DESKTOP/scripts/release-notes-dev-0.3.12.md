# Newmark Agent `dev-0.3.12`

This release hardens the user-level pressure paths found during the `dev-0.3.11` installed-directory audit and reduces repeated work during large-context preparation. The published Windows payload was rebuilt after a real installed-directory startup regression was found and repaired.

## Fixed

- CLI help/version discovery and unknown-command failures now terminate before provider/runtime startup and preserve actionable exit codes.
- Explicit `--root` runs no longer inherit legacy AppData conversations, archives, providers, or external workspaces; installed writable state remains user-scoped.
- Older persisted external/current workspace entries pointing at the Windows installation directory are now filtered and migrated before conversation hydration, so a shortcut-started GUI cannot attempt to create `C:\Program Files\Newmark Agent\conversations`.
- Fresh GUI roots default to deterministic exit-on-close behavior while existing explicit minimize preferences remain supported; shutdown cleanup is bounded.
- The packaged `Newmark Console Runtime.exe` now enters the same terminal sidecar path as the native console launcher, so direct Runtime TUI sessions inherit PTY handles and honor `q`/`Q` exits.
- TUI stop/escape races, provider timeout cleanup, archive force-stop/parallel persistence, context compression idempotency, and shared GUI/TUI/CLI conversation state are hardened.
- Release pressure scripts now propagate batch exit codes, retry Windows temporary-root cleanup without false `EPERM` failures, and use visible work-run completion rather than an obsolete renderer promise.

## Validation

- `npm.cmd run test:full-release` exits `0`, including the source feature suite, intelligence-tier stress, TUI/SSH/WSL lanes, CLI contracts, and GUI/TUI/CLI shared-backend stress.
- Packaged safe gates pass CLI/GUI help and failure boundaries, explicit-root isolation, protected-install restart, archive/context-compression pressure, loopback PTY/light-theme/restart checks, and console-wrapper argument boundaries.
- The repaired MSI was installed with elevated Windows Installer and the real no-`--root` GUI recovered a stale Program Files workspace in about 2.1 seconds; the promoted CDP UI appeared, no new EPERM/startup fallback was logged, and `State.json`/`External.json` no longer contained the protected path.
- The installed-directory gate passed GUI↔CLI sync, SSH/PTTY TUI with four restarts, context compression (`9` requests, `fallback=false`), two read-only validation rounds, real-model CLI/TUI roundtrip with Esc stop/recovery/restart, protected-root redirection, and ZIP unpacked smoke (`22` assertions).
- The startup/memory benchmark's Browser demand assertion now accepts the target-bound persistent partition used by the shipped UI (`persist:newmark-browser-<workspace/conversation>`), preventing a stale release gate from masking the preceding input-interactivity result.
- Temporary-root context pressure passes 120 rapid conversation creations and 120 rapid archives with no missing or pending archive; the full memory/restart lane passes 300 components and 600 queries.
- Three consecutive no-context black-box canaries, all `gpt-5.6-luna` with `max` reasoning, reported no new product problem and cleaned their temporary roots/processes.
- The generated Windows MSI was installed locally with elevated Windows Installer and the installed GUI, console, Runtime, and isolated state probes report `0.3.12` successfully.

## Artifacts

- `Newmark-Agent-0.3.12-x64.msi` — per-machine Windows installer.
- `Newmark-Agent-0.3.12-win-unpacked-x64.zip` — portable Windows directory with GUI, TUI, CLI, and console launchers.

The release is an unsigned prerelease build. Verify downloaded artifacts against these SHA-256 fingerprints:

- `Newmark-Agent-0.3.12-x64.msi` — `4D42B3AD865765A3944C349FAB638A1835E97FCB76DC1315588A9088DF7B62FE`.
- `Newmark-Agent-0.3.12-win-unpacked-x64.zip` — `A56B37A7173BB69441BBCDCAEBF5DC7D77C7F6D0C45FA799E6BF82FCCA4BDF8E`.
- Packaged `resources/app.asar` — `84D65F79E82FE5CCB47BD01CAFADDDDA3B1EEE5E7173EEDECA5D0F005B7C0433`.
