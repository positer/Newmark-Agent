# Newmark Agent

Newmark Agent is a local-first desktop workspace for AI-assisted software development, research, automation, and controlled computer operation. It combines a graphical desktop application, terminal interface, and CLI around the same local configuration, workspaces, conversations, tools, workflows, and archives.

The application connects to user-selected model providers through OpenAI-compatible, Anthropic-compatible, GitHub Models, and custom endpoints. Provider credentials and mutable workspace state remain under the user's Newmark data directory rather than inside the installation or repository.

## Capabilities

- **Multi-model work:** fixed deployments and audited Auto routing with model capability, quality, cost, speed, privacy, and reliability signals.
- **Persistent workspaces:** conversations, drafts, Build history, plans, goals, queues, archives, media, skills, and workflows are scoped to the correct workspace and conversation.
- **Three interfaces:** Electron GUI, `Newmark --TUI`, and `Newmark --cli` share the same backend contracts and local state.
- **Build, Plan, Goal, and Flow modes:** direct execution, structured planning, persistent objectives, and reusable workflows with resumable execution.
- **Controlled tools:** terminal, files, browser use, GitHub, SSH, MCP, automation, image display, OCR, and Windows computer use are exposed through policy and approval boundaries.
- **Conversation-bound BrowserUse:** the built-in browser guest and right browser sidebar resolve to the same workspace/conversation target as BrowserUse calls; switching conversations never reuses another conversation's page.
- **Conversation-bound ComputerUse:** ComputerUse is an explicit per-conversation toggle independent of Build lifetime. Build blocks only switch it and request screenshots/actions; a process-wide lease permits one conversation at a time and reports `computerUse occupied` to competing conversations.
- **Long-running work:** context compression, durable work runs, public progress events, queue control, graceful interruption, and force-stop without replacing the runtime.
- **Local memory and archives:** Memory Lab, conversation archives, and workspace history provide inspectable continuity without requiring a hosted application backend. Conversation archive clicks remove the row optimistically, can interrupt any target runtime, and persist archive payloads without blocking the interface.
- **Agent-driven context management:** The Agent can actively compress its LLM context, inspect current entries, or search/read/restore folded history through `context_compress` and `context_history_manage`. A bounded hot cache keeps normal turns lean while evicted folds remain in a conversation-isolated append-only local archive. These operations affect only model context; displayed conversation history is never altered.
- **Cross-platform packaging:** Windows MSI and portable packages, plus Linux AppImage, Debian, and unpacked distributions.

## Interfaces

### GUI

The Electron application provides the primary workspace surface: conversation navigation, model and reasoning controls, Build timeline, plan and goal panels, Flow execution, tool activity, file tree, Memory Lab, archives, and settings.

### TUI

Launch the terminal interface from an installed package or source checkout:

```text
Newmark --TUI
```

The TUI uses the same conversation and workspace model as the GUI, including drafts, Flow state, model selection, work runs, and theme preferences.

Its light theme hydrates readable foreground/background defaults from the shared user configuration and keeps a full ANSI canvas painted when legacy or low-contrast color pairs are present.

### CLI

The CLI exposes non-interactive commands for provider configuration, model validation, skills, Memory Lab, archives, automation, and scripted agent use:

```text
Newmark --cli --help
```

## Installation

Download published packages from the [GitHub releases page](https://github.com/positer/Newmark-Agent/releases). The `dev-0.3.12` release is built from the same source gate used by the local package and Linux workflow.

For first-time discovery, run `Newmark Agent.exe --help` for the desktop package or `Newmark.exe --help` for the console launcher. These commands terminate after printing the GUI, TUI, CLI, Flow, edit, and non-interactive command surface; `--TUI --help` and `--cli --help` use the same terminating help contract.

### Windows

- `Newmark-Agent-0.3.12-x64.msi`: per-machine Windows installer.
- `Newmark-Agent-0.3.12-win-unpacked-x64.zip`: portable Windows directory with GUI, TUI, CLI, and launcher files.

### Linux

- `Newmark-Agent-0.3.12-x86_64.AppImage`: portable Linux desktop package.
- `Newmark-Agent-0.3.12-amd64.deb`: Debian/Ubuntu package.
- `Newmark-Agent-0.3.12-linux-unpacked-x64.zip`: unpacked Linux distribution.

Availability depends on release publication. Packages are unsigned prerelease builds; verify downloaded artifacts with the SHA-256 values published in their release notes.

## Configuration

Newmark stores user configuration, credentials, conversations, runtime state, caches, and archives under:

```text
~/.Newmark/
```

The repository contains `DESKTOP/config.example.json` as a starting point. Providers can be configured from the GUI, TUI, or CLI. Never commit a populated `config.json`, API keys, tokens, or generated user data.

Provider selection is deployment-aware: two providers may expose the same model name without sharing credentials, validation evidence, routing state, or conversation selection.

## Architecture

```text
GUI / TUI / CLI
        |
        v
Target-bound desktop and terminal adapters
        |
        v
Conversation kernel and Agent runtime
        |
        +--> Electron utility runtime pool
        +--> WSL runtime pool
        +--> Context orchestrator and provider adapters
        +--> Native tools, MCP, browser, files, and automation
        |
        v
Local workspace, conversation, archive, and runtime stores
```

Conversation and workspace identity are composite target identities. Runtime events, queues, drafts, work runs, Flow suspensions, and snapshots are routed by target rather than by a mutable foreground selection.

Conversation archiving is a destructive target operation: the GUI removes the row immediately, the desktop backend force-stops a running or stopping target, and archive Markdown/manifest writes use unique names and asynchronous atomic files. Concurrent targets may write archive payloads in parallel; each final state deletion merges against the latest lock-protected workspace snapshot so rapid clicks cannot resurrect or overwrite sibling conversations. A failed backend receipt is reported without renderer-side rollback.

Flow takeover is strictly conversation-local on both the backend and the GUI. A running or paused Flow belongs to the conversation that started it: `flow:run`, `flow:resume`, `flow:guide`, and `flow:stop` all resolve the owning conversation target first, the persisted suspension is stored per conversation, and the takeover bubble only reflects the active conversation's own Flow state. Switching conversations never surfaces, mutates, or clears another conversation's Flow, and the whole takeover bubble is the single interactive affordance (click to pause while running, click to resume while paused).

Subagent identity is decoupled: the caller-supplied `name` is a stable human-readable label that never contains the id, while `id`/`shortId`/`displayName`/`qualifiedName` carry identity. The frontend renders only the display name, and Agent tool interactions accept both the name and the exact id (`subagent_list` returns both for precise targeting).

## Development

The desktop source lives in `DESKTOP/` and requires Node.js with npm. From the repository root:

```powershell
cd DESKTOP
npm ci
npm run build
```

Run the development GUI or interfaces:

```powershell
npm start
npm run start:cli
node dist/launcher.js --TUI
```

## Verification

The `dev-0.3.12` safe product gates pass the temporary-root, rebuilt Windows-package, protected-install-shape, expanded GUI/TUI/CLI, and current Flow lifecycle scopes. The earlier independent no-context release-flow `FAIL/HOLD` remains historical evidence about a prior package boundary and was not silently reclassified. This Flow repair was verified in disposable roots and was not UAC-installed; the machine-wide copy was not touched. The current safe package boundary is app.asar `157,099,444` bytes / SHA-256 `5A4EC8CF1E4BC3F1E16749A822E62A4BFEC43B2588A8DA26405BDD064078C8D4`, MSI `225,884,568` bytes / `27CD340EBAA71CF088905007A171D4AE24A474F0617E1FF180F1A52FE0F02C45`, and portable ZIP `291,752,665` bytes / `D13376B03D541423C912049E82AD9FCF1FD9ADB3A4ED5641D0CA2928F0F9A688`. No-provider and unavailable explicit-model requests still fail closed in the rebuilt source/package gate, while default `validate-models` loads fresh durable evidence read-only and never writes config unless `--persist` is explicit. Detailed current evidence is [`archive/20260813-dev-0.3.12-flow-lifecycle-repair-and-release-gates.md`](archive/20260813-dev-0.3.12-flow-lifecycle-repair-and-release-gates.md); prior release-flow adjudication remains [`archive/20260812-1630-dev-0.3.12-blackbox-release-flow-adjudication.md`](archive/20260812-1630-dev-0.3.12-blackbox-release-flow-adjudication.md).

The project includes source-contract, runtime-isolation, context, provider, tool exposure, GUI, TUI, CLI, SSH, WSL, and shared-backend stress suites.

```powershell
cd DESKTOP
npm run test:desktop
npm run test:full-release
```

Package validation scripts cover the Windows MSI administrative image, Windows portable output, protected-install root redirection, Linux AppImage, Debian, Linux unpacked output, startup behavior, process cleanup, release CLI behavior, and the installed-local surface gate. The current rebuilt package boundary is `release/win-unpacked/resources/app.asar` (157,068,983 bytes, SHA-256 `1A7C444A4DF068E2BBE62D72B6CE17EED7ADBAB40F51697A3619CC303E32A324`), MSI (225,888,664 bytes, SHA-256 `426F7A010C76AAA04C043C8E03644010C5A1317F5B254FD6F7B3C53E7386E774`), and portable ZIP (291,743,396 bytes, SHA-256 `6AAD7C293761939CF0C739F82EBB7D651B438994124A413322BD1437C3B118BA`). The Browser guest keeps the five-second creation floor for background demand but bypasses it for an explicit visible-tab activation; startup recovery measured `startupMs=1046` and `browserOpenMs=45`. The rebuilt package was not reinstalled machine-wide; the actual Program Files package remains stale. The `_ref` APInebula key was used only through an environment variable for one current real-model CLI probe; the provider path timed out in-app and was separately observed rate-limited, so real-model acceptance is not claimed. WSL TUI remains an environment skip because `Ubuntu-24.04` is unavailable. The latest no-model GUI evidence is [`archive/2026-08-12-blackbox-gui-no-model-repair.md`](archive/2026-08-12-blackbox-gui-no-model-repair.md); broader evidence remains in [`archive/2026-08-12-dev-0.3.12-subagent-findings-repair-and-expanded-release-gates.md`](archive/2026-08-12-dev-0.3.12-subagent-findings-repair-and-expanded-release-gates.md), [`archive/2026-08-12-dev-0.3.12-user-pressure-browser-interaction-and-release-gates.md`](archive/2026-08-12-dev-0.3.12-user-pressure-browser-interaction-and-release-gates.md), and [`archive/2026-08-12-real-provider-stress-debug.md`](archive/2026-08-12-real-provider-stress-debug.md).

## Building Releases

Windows packages:

```powershell
cd DESKTOP
npm run dist:windows-release
```

Linux packages are built natively or through WSL:

```powershell
cd DESKTOP
npm run dist:linux
```

The resulting artifacts are written to the repository-level `release/` directory. Release upload is intentionally separate from local packaging.

## Security and Privacy

- Credentials are loaded from local configuration and are redacted from diagnostics and stress reports.
- Hidden provider chain-of-thought is not rendered as public work text or persisted as ordinary conversation prose.
- Tool access is schema-validated and policy-bound; high-risk capabilities require explicit authorization or approval.
- Browser actions use scoped capabilities, rendered-content boundaries, and stale-page guards.
- Workspace and conversation state is target-bound to prevent cross-conversation writes and UI leakage.

## License

Newmark Agent is distributed under the license in [`LICENSE`](LICENSE). Third-party notices are included in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Maintenance Log

- **2026-08-13 — Flow continuation/archive interruption and background lifecycle repair:** A paused Flow no longer hits the stale `Flow component #0 cannot start before the previous Build block has terminated` guard on explicit resume: only the interrupted target's running WorkRun ledger is finalized before the resumed component starts, while genuine concurrent Build protection remains. Stop/Esc during a resumed Flow is resumable; archive synchronously marks and aborts the Flow owner, force-finalizes its target ledger, clears suspension state, starts runtime hard-stop in the background, and single-flights duplicate archive IPC. The GUI removes the target row and Flow takeover on the first click and never rolls the row back; late Flow completion cannot recreate archived state. Renderer/window lifecycle diagnostics now record unresponsive/responsive, close, hide-to-tray, and will-quit transitions. Source feature gate passed `1482/1482`; Flow pressure, archive concurrency/runtime, compression, performance, TUI/SSH/WSL/CLI, GUI/TUI/CLI shared-backend, packaged Flow pause/resume/archive/switch, tray, direct-close, and startup-recovery gates passed. The rebuilt safe artifacts are app.asar `157,099,444` bytes / `5A4EC8CF1E4BC3F1E16749A822E62A4BFEC43B2588A8DA26405BDD064078C8D4`, MSI `225,884,568` bytes / `27CD340EBAA71CF088905007A171D4AE24A474F0617E1FF180F1A52FE0F02C45`, and portable ZIP `291,752,665` bytes / `D13376B03D541423C912049E82AD9FCF1FD9ADB3A4ED5641D0CA2928F0F9A688`. No global UAC installation or Program Files process termination was performed. Evidence: [`archive/20260813-dev-0.3.12-flow-lifecycle-repair-and-release-gates.md`](archive/20260813-dev-0.3.12-flow-lifecycle-repair-and-release-gates.md).
- **2026-08-12 — independent no-context release-flow audit: `FAIL/HOLD`:** A fresh black-box tester passed the primary safe package probes but found a P1 release-boundary mismatch (`release/win-unpacked` has post-package `conversations/state.json` not present in the portable ZIP), a P2 `--help` side-effect risk in `release-installed-readonly-validation-stress.cjs`, a P2 PowerShell GUI exit-code gate hazard, and a P3 invalid-model validation result of `[]` with exit `0`. TUI functional interaction was blocked by the host's lack of an interactive PTY. No source, release artifact, Program Files path, or MSI installation was modified. Evidence: [`archive/20260812-1630-dev-0.3.12-blackbox-release-flow-adjudication.md`](archive/20260812-1630-dev-0.3.12-blackbox-release-flow-adjudication.md) and delegated raw report [`archive/20260812-1610-dev-0.3.12-blackbox-release-report.md`](archive/20260812-1610-dev-0.3.12-blackbox-release-report.md).
- **2026-08-12 — `BLACKBOX_GUI_NO_MODEL` GUI failure convergence repair:** The renderer now latches IPC/rejected-send failures and settles a matching provisional conversation as `error`, preventing a no-model request from being painted or returned as a false `completed` run while the target-scoped error event is still in flight. Added the real packaged GUI/CDP gate `DESKTOP/scripts/release-gui-no-model-smoke.cjs`, wired it into `release-safe-blackbox-gates`, and added a source contract assertion. The rebuilt package passed the dedicated gate, safe black-box `28`-case matrix, protected-install shape, and full source gate (`1478/1478`, TUI `55/55`, launcher `25/25`, SSH/PTY four restarts, CLI `46`, shared GUI/TUI/CLI `21` requests). Latest fingerprints are app.asar `157,068,983` bytes / `1A7C444A4DF068E2BBE62D72B6CE17EED7ADBAB40F51697A3619CC303E32A324`, MSI `225,888,664` bytes / `426F7A010C76AAA04C043C8E03644010C5A1317F5B254FD6F7B3C53E7386E774`, and portable ZIP `291,743,396` bytes / `6AAD7C293761939CF0C739F82EBB7D651B438994124A413322BD1437C3B118BA`. No UAC installation was performed. Evidence: [`archive/2026-08-12-blackbox-gui-no-model-repair.md`](archive/2026-08-12-blackbox-gui-no-model-repair.md).
- **2026-08-12 — dev-0.3.12 TUI light-theme repair:** Shared-config hydration now chooses theme-specific readable defaults when light mode has missing legacy color fields, and the renderer normalizes low-contrast persisted pairs before painting the complete ANSI canvas. Added regressions for missing colors and the `#B7E4FF`/`#F0F2F8` low-contrast case. TUI passes `55/55`, built GUI/TUI launcher checks pass `25/25`, SSH/PTY light-theme plus four-restart stress passes, the complete source release gate passes, and the rebuilt safe package passes protected-install-shape plus `28/28` black-box gates. Latest package fingerprints are app.asar `157,067,747` bytes / `82C2CA9A59FC5EBCE733F5FCEB985C9931EDE25539742182C1671B49422D6DB7`, MSI `225,884,568` bytes / `0BCF5A7B05C778B213A433ED577C4FAD2F7A55D6C46377AA1F4CE27DAE82FEE6`, and portable ZIP `291,743,065` bytes / `4C1FB4FAA470077B748AE8ADFF1961BE17038A1D49D51B160CF4EFCB4FBB4846`. No UAC installation was performed; the existing Program Files copy remains outside this latest package gate. Evidence: [`archive/2026-08-12-tui-light-theme-repair.md`](archive/2026-08-12-tui-light-theme-repair.md).
- **2026-08-12 — dev-0.3.12 subAgent finding repair and expanded release gates:** Repaired D1 protected-install shared GUI/TUI restart routing, D2 strict top-level/CLI argument validation, D3 cross-entry workspace live refresh, D4 no-model terminal error versus false completion, D5 embedded PowerShell CR/echo corruption, and D6 archive-list refresh lag. Archive performance remains parallel/atomic and target-force-stopping; the renderer removes archive rows optimistically and coalesces refreshes, while the backend single-flights duplicate target archives. Added the protected-install shared-root/restart stress gate and repaired the single-instance shared-backend release contract to verify forwarded launches preserve the original renderer and conversation. Final source `test:full-release` passed (`1477/1477`, Context System V2 `1461/1461`, TUI `53/53`, SSH TUI with four restarts, CLI `46`, shared GUI/TUI/CLI `21` requests); expanded packaged Flow/Subagent, Memory Lab, model settings, option feedback, Skills/MCP, ZIP/MSI, startup, compression, archive, terminal, queue, conversation-isolation, GUI↔CLI, and shared-backend gates passed. The current `_ref` APInebula real-model probe was not a pass: the app reported a provider timeout and the endpoint returned a rate-limit response; no secret was recorded, no user config was changed, no UAC installation was performed, and the stale Program Files package remains a separate `HOLD/NO-GO`. Evidence: [`archive/2026-08-12-dev-0.3.12-subagent-findings-repair-and-expanded-release-gates.md`](archive/2026-08-12-dev-0.3.12-subagent-findings-repair-and-expanded-release-gates.md).
- **2026-08-12 — dev-0.3.12 Browser interaction repair and expanded release gates:** A user-visible Browser tab activation no longer waits behind the five-second background guest-creation floor; background/prewarm requests retain the floor, while the target-bound Browser partition remains isolated per workspace/conversation. The stale startup-recovery assertion was updated to accept the intended `persist:newmark-browser-<target>` partition shape. Typecheck, build, focused startup/performance/compression regressions, the full source release gate (`1477/1477`, Context System V2 `1461/1461`, Browser-Use `81`, SSH TUI with four restarts, shared GUI/TUI/CLI backend `21` requests), current-package safe black-box `28/28`, protected-install-shape, startup recovery (`1046 ms` startup / `45 ms` Browser open), ZIP/MSI/tray/GUI↔CLI sync, console boundary, context compression, and two-round real-model read-only validation passed. `~/.Newmark/config.json` remained hash/size/mtime identical; no UAC installation was performed and the stale Program Files package remains outside the latest package gate. Evidence: [`archive/2026-08-12-dev-0.3.12-user-pressure-browser-interaction-and-release-gates.md`](archive/2026-08-12-dev-0.3.12-user-pressure-browser-interaction-and-release-gates.md).
- **2026-08-12 — independent no-context installed-directory gate: `NO-GO`:** Without reading project documentation or source, the tester exercised the actual `C:\Program Files\Newmark Agent` GUI/TUI/CLI and shared-state restart paths. It reproduced a P1 shared GUI/TUI restart failure that attempted `C:\Program Files\Newmark Agent\conversations`, found non-strict unknown/missing CLI arguments, GUI/TUI workspace refresh lag, a no-model GUI completion/error mismatch, malformed PowerShell terminal echo, and a manual-refresh archive-list gap. Temporary roots and installed files were cleaned; no UAC or real credentials were used. Real-model pressure was not passable because the compliant temporary root had no configured model. Evidence: [`archive/2026-08-12-no-context-installed-directory-blackbox-release-gate.md`](archive/2026-08-12-no-context-installed-directory-blackbox-release-gate.md).
- **2026-08-11 — dev-0.3.12 user-pressure cache/root repair and final safe gates:** Read-only `validate-models` now loads fresh durable evidence without writing config, explicit CLI model selections fail before provider transport, and unambiguous `provider/model` selections are normalized. The new protected-install-shape gate passed CLI/TUI/GUI root redirection with Program Files mutable paths unchanged. The final source gate, rebuilt Windows package, safe black-box `28/28`, ZIP/MSI administrative-image smoke, tray lifecycle, context compression, archive pressure, and final real-model validation/cache-reuse gate passed. Real-model TUI/CLI was blocked only by provider HTTP `403 bad response 808`; no UAC install was performed. Evidence: [`archive/2026-08-11-dev-0.3.12-user-pressure-cache-root-repair-and-final-gates.md`](archive/2026-08-11-dev-0.3.12-user-pressure-cache-root-repair-and-final-gates.md).
- **2026-08-11 — fresh no-context real-install audit: `NO-GO`:** A long-running tester used only the actual `C:\Program Files\Newmark Agent` installation, executable probes, and observed GUI/TUI/CLI behavior. It found a P0 TUI `EACCES` crash while creating `Program Files\Newmark Agent\conversations`, a P1 `validate-models` process-leak/no-output case, a P1 GUI close/child-cleanup delay, and a P2 invalid-model request reaching a real Provider. GUI chat/Plan/Goal/Flow/archive, CLI discovery/exit contracts, and TUI startup passed; the rest of the three-entry pressure matrix was blocked by the P0 and real-provider quota. No UAC operation was performed. Evidence: [`archive/2026-08-11-no-context-installed-directory-full-pressure-audit.md`](archive/2026-08-11-no-context-installed-directory-full-pressure-audit.md).
- **2026-08-11 — dev-0.3.12 user-pressure fail-closed repair and post-build gates:** Empty-provider and unavailable fixed-model requests now reject as real terminal errors, persist an error WorkRun, omit synthetic `done/final_response`, and return CLI exit `1`; archive remains immediate, parallel, atomic, and force-interrupting. The final source gate, safe packaged black-box `28/28`, ZIP/MSI administrative-image smoke, active compression, queue/Plan/Flow, rapid conversation switching, real-model GUI/TUI/CLI, and two read-only validation rounds passed. WSL is an environment skip; the optional multi-window probe was not counted because the product's single-instance focus behavior differs from that stale test contract. This slice did not re-run global UAC. Evidence: [`archive/2026-08-11-dev-0.3.12-user-pressure-fail-closed-and-release-gates.md`](archive/2026-08-11-dev-0.3.12-user-pressure-fail-closed-and-release-gates.md).
- **2026-08-11 — dev-0.3.12 user-level pressure repair, package gate, and authorized global install:** Fixed GUI Electron `--root` profile isolation, terminating `-version`/unknown-command discovery, invalid-model fail-closed semantics, CLI error exits, empty-Flow feedback, Stop/Esc and large-stream behavior, and the Windows console wrapper's Electron `--` argument boundary plus ConPTY handoff. The source full-release gate, packaged GUI/TUI/CLI/shared-backend stress, ZIP smoke, MSI administrative-image smoke, active model-dispatched context compression, and console colon/spaced-root probe passed. After explicit authorization, the MSI was elevated-installed and repaired with `REINSTALL=ALL` so the native wrapper component was present; the installed-directory GUI/TUI/CLI/shared-backend/compression gate, PATH registration, artifact hashes, config immutability, and process cleanup passed. Real-provider validation was not claimed without supplied credentials. Evidence: [`archive/2026-08-11-dev-0.3.12-safe-temp-gate-wrapper-and-optimization.md`](archive/2026-08-11-dev-0.3.12-safe-temp-gate-wrapper-and-optimization.md).
- **2026-08-11 — latest no-context installed-directory audit blocks release:** The independent tester used only the real installation and executable/probe feedback, without README or source context. It confirmed installed binary integrity, terminating version/unknown-command behavior, and real endpoint validation for `APInebula/gpt-5.4-mini` (`44.724 s`), but `Newmark.exe help` hung for `8.2 s`, real GUI/TUI/CLI conversation pressure and shared-backend/compression scenarios were not completed, and `C:\Users\12252\.Newmark\config.json` changed from SHA-256 `428F...` to `9A0B...` during validation. Verdict: P1 release blocker; no automatic config restoration was performed. Evidence: [`archive/2026-08-11-installed-no-context-blackbox-pressure-audit.md`](archive/2026-08-11-installed-no-context-blackbox-pressure-audit.md).
- **2026-08-11 — latest independent no-context release audit:** A long-running first-time-user tester used README/`--help` discovery and real installed/portable GUI-TUI-CLI entrypoints. It passed 72/72 public help/version probes, 26/26 safe black-box cases, 20 real CLI rounds, six GUI rounds, installed TUI/CLI recovery, compression 34/34, SSH PTY, and shared-backend 21 fixtures. It blocked MSI/UAC because GUI `--root` wrote Chromium user data under the real `%APPDATA%`, the installed and portable `app.asar` hashes differed, literal `-version` and an unknown command hung, GUI `Esc` was not proven to stop, and invalid-model CLI returned exit `0`. Real config hash stayed unchanged and all processes were cleaned. Evidence: [`archive/2026-08-11-no-context-subagent-blackbox-final.md`](archive/2026-08-11-no-context-subagent-blackbox-final.md).

- **2026-08-11 — dev-0.3.12 safe portable release gate:** Repaired CLI error exit semantics, empty Flow feedback, the GUI provisional-`Esc` stop race, and large-stream rendering cost. Safe temporary-root black-box testing passed `26/26` help probes and empty-provider failure behavior; the deterministic full-release gate passed, compression passed `34/34`, and final portable GUI/TUI/CLI real-model lanes passed with the real user config hash unchanged and no leftover Newmark processes. The MSI was generated and verified but deliberately not installed machine-wide; global UAC installation is waiting for explicit authorization. Evidence: [`archive/2026-08-11-dev-0.3.12-safe-portable-release-gates.md`](archive/2026-08-11-dev-0.3.12-safe-portable-release-gates.md).

- **2026-08-10 — independent no-context black-box gate:** A long-running tester using only README/help completed 20/20 real-model CLI Build rounds and basic GUI/help/security checks, but blocked release on incomplete TUI and three-entry shared-backend coverage, Plan/Goal provider/runtime failures, CLI empty-config exit-code behavior, GUI Esc/Flow risks, and a hard-link-based isolation test that changed the real config inode. The hard-link finding is classified as invalid test isolation plus an unresolved configuration-boundary risk, not silently accepted. Evidence: archive/2026-08-10-no-context-subagent-blackbox-final.md.

- **2026-08-10 — dev-0.3.12 full-feature black-box retest:** A first-time-user pass used only README/help discovery, then exercised the real installed GUI/TUI/CLI with APInebula `gpt-5.4-mini`. Help and local CLI management passed; GUI queue/isolation/long-context/Goal, TUI Stop/recovery/restart, and CLI Plan/Goal/Flow passed. Sustained GUI round 5, CLI 20-round, and model-validation timeout risks were reproduced and retained, so an unqualified release claim is not accepted. Evidence: [`archive/2026-08-10-blackbox-dev-0.3.12-full-feature-pressure.md`](archive/2026-08-10-blackbox-dev-0.3.12-full-feature-pressure.md).

- **2026-08-10 — dev-0.3.12 source repair and package gate:** Repaired help termination, provider timeout cascades, stalled stream cancellation, TUI recovery serialization, context-preparation repeated serialization, and compatibility metadata redaction. The full deterministic source gate exits 0, performance optimization passes 12/12, compression passes 34/34, and the direct Windows MSI/portable packaging body exits 0 with the package boundary recorded in `OVERVIEW.md` and the repair archive. WSL TUI is recorded as an environment skip; publication/upload remains a separate action.
- **2026-08-10 — dev-0.3.12 final installed acceptance:** The independent installed leak is closed by exact same-version product removal and elevated MSI installation: final package and `C:\Program Files\Newmark Agent` `app.asar` are byte-identical, the nested compatibility key is `[REDACTED]`, and the four-executable help matrix passes 72/72. Final installed real-model GUI passes six UI rounds, two Goals, queue drain, conversation isolation, and long context; final installed TUI/CLI passes Stop/Esc/recovery/restart plus direct CLI; an additional installed CLI lane passes 8/8 rounds in 61.0 seconds; all exact target processes and temporary roots are cleaned. The previous 20-round provider timeout remains an explicit sustained-risk boundary. Evidence: [`archive/2026-08-10-dev-0.3.12-user-pressure-repair-and-gates.md`](archive/2026-08-10-dev-0.3.12-user-pressure-repair-and-gates.md).

- **2026-08-10 — dev-0.3.11 installed black-box release pressure audit:** From the real `C:\Program Files\Newmark Agent` installation, top-level help/version, APInebula `gpt-5.4-mini` CLI/GUI matrix, independent `Newmark.exe` CLI 20-round control, TUI 10-round/restart control, package hash, and `npm.cmd test` all passed. The full-feature release remains not ready because TUI long-task Stop/Esc recovery stalled in a real PTY and subcommand `--help` was inconsistent, with `validate-models --help` not terminating within 30 seconds. Scenario design and evidence: [`archive/2026-08-10-blackbox-release-pressure-test-dev-0.3.11.md`](archive/2026-08-10-blackbox-release-pressure-test-dev-0.3.11.md).
- **2026-08-09 — dev-0.3.10 Windows/Linux prerelease:** Bumped package metadata to `0.3.10`, rebuilt Windows MSI/portable ZIP and Linux AppImage/deb/unpacked ZIP, and passed the complete release gate plus all five final package smokes. [GitHub release dev-0.3.10](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.3.10) was then re-downloaded and hash-audited successfully; artifact names and SHA-256 values are recorded in [OVERVIEW.md](OVERVIEW.md), the release notes, and [`archive/2026-08-09-dev-0.3.10-win-linux-release.md`](archive/2026-08-09-dev-0.3.10-win-linux-release.md).
- **2026-08-09 — dev-0.3.10 black-box real-model stress:** A tester-facing run using only packaged help discovery and isolated real-model sessions passed sustained CLI, queue, conversation-isolation, and long-context lanes, but found a fresh-start Goal activation failure (`Electron utility runtime stop could not confirm child exit`), an intermittent 20-round UI `Guide · Rejected` timeout, and non-terminating/incomplete `--help` behavior. Verdict: not ready for real-model acceptance. Full matrix: [`archive/2026-08-09-blackbox-real-model-release-test.md`](archive/2026-08-09-blackbox-real-model-release-test.md).
- **2026-08-09 — dev-0.3.9 local Windows package/install:** Ran `npm.cmd run dist:windows-release` from the dev-0.3.9 source; the full release gate plus final `verify.js` passed 1461/1461. The generated MSI and portable ZIP were installed/validated locally: installed 0.3.9.0 at `C:\Program Files\Newmark Agent`, installed `resources/app.asar` matched the packaged SHA-256, installed CLI smoke passed, and `~/.Newmark` stayed byte-identical. Artifacts and MSI logs: [`archive/2026-08-09-dev039-local-package-install.md`](archive/2026-08-09-dev039-local-package-install.md).
- **2026-08-09 — dev-0.3.10 Goal/Build lifecycle hardening:** Every terminal Build Block now writes one idempotent `work_overview` entry with the startup input, final summary, event/Guide counts, and one terminal Goal audit. User Stop pauses an active Goal, ordinary input cannot resume or complete a paused Goal, and explicit resume immediately starts a Goal-driven Build. Runtime lifecycle markers distinguish a live backend from an unexpected process exit; owner-PID checks preserve backend WorkRuns after a frontend tracking timeout, while the first load after a real crash pauses Goal/Flow and records interrupted recovery. Focused lifecycle assertions, typecheck, build, and the complete 1461-assertion desktop gate passed. Evidence: [`archive/2026-08-09-dev-0.3.10-goal-build-lifecycle.md`](archive/2026-08-09-dev-0.3.10-goal-build-lifecycle.md).
- **2026-08-08 — dev-0.3.9 installed real-model stress:** Executed the machine-wide 0.3.9.0 installation against APInebula `gpt-5.4-mini` over the OpenAI protocol with an isolated temporary root and secret redaction. The full pass covered 3 CLI rounds, 3 UI rounds, Goal continuation, queue drain, conversation isolation, long-context compression, and exact installed-process cleanup. Two first-pass harness false negatives were corrected: Goal completion is asynchronous, and 40,600 ASCII characters estimate below the 12,800-token trigger of a 16k test window. A targeted 8k-window retest passed Goal in 22.173 s with 2 assistant calls and compressed 52,419 original characters to 463 estimated tokens in 36.441 s; no installed process remained and the real user config hash was unchanged. See [`archive/2026-08-08-dev039-real-model-stress.md`](archive/2026-08-08-dev039-real-model-stress.md).
- **2026-08-08 — dev-0.3.9 local package/install stress:** Built and file-smoked the Windows MSI/portable ZIP, upgraded the machine-wide installation to 0.3.9.0, and proved the installed `app.asar` matches the package while `~/.Newmark/config.json` stayed byte-identical. Stress testing fixed a real utility/WSL second-stop termination defect and refreshed two stale packaged-smoke contracts. Source, package, installed dev-0.0.8/dev-0.1.0, startup recovery, tray lifecycle, SSH/WSL, and shared-backend gates pass. Installed dev-0.0.9 remains unstable in its Browser/UI tail, and the formal performance preflight fails at 584.53 MiB startup private memory and 534.1 ms input latency under 4× CPU throttling; the 20-run acceptance set was therefore not claimed. See [`archive/2026-08-08-dev039-local-package-install-stress.md`](archive/2026-08-08-dev039-local-package-install-stress.md).
- **2026-08-08 — dev-0.3.9:** Added Prime Agent-informed durable context folding: bounded hot cache, append-only per-conversation cold archive, explicit bounded `read`, hot/cold `search`, cold restore tombstones, and archive status. Typecheck and 1461 desktop assertions pass. See [`archive/2026-08-08-dev039-prime-agent-context-archive.md`](archive/2026-08-08-dev039-prime-agent-context-archive.md).
