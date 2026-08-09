# Newmark Agent

Newmark Agent is a local-first desktop workspace for AI-assisted software development, research, automation, and controlled computer operation. It combines a graphical desktop application, terminal interface, and CLI around the same local configuration, workspaces, conversations, tools, workflows, and archives.

The application connects to user-selected model providers through OpenAI-compatible, Anthropic-compatible, GitHub Models, and custom endpoints. Provider credentials and mutable workspace state remain under the user's Newmark data directory rather than inside the installation or repository.

## Capabilities

- **Multi-model work:** fixed deployments and audited Auto routing with model capability, quality, cost, speed, privacy, and reliability signals.
- **Persistent workspaces:** conversations, drafts, Build history, plans, goals, queues, archives, media, skills, and workflows are scoped to the correct workspace and conversation.
- **Three interfaces:** Electron GUI, `Newmark --TUI`, and `Newmark --cli` share the same backend contracts and local state.
- **Build, Plan, Goal, and Flow modes:** direct execution, structured planning, persistent objectives, and reusable workflows with resumable execution.
- **Controlled tools:** terminal, files, browser use, GitHub, SSH, MCP, automation, image display, OCR, and Windows computer use are exposed through policy and approval boundaries.
- **Long-running work:** context compression, durable work runs, public progress events, queue control, graceful interruption, and force-stop without replacing the runtime.
- **Local memory and archives:** Memory Lab, conversation archives, and workspace history provide inspectable continuity without requiring a hosted application backend.
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

### CLI

The CLI exposes non-interactive commands for provider configuration, model validation, skills, Memory Lab, archives, automation, and scripted agent use:

```text
Newmark --cli --help
```

## Installation

Download published packages from the [GitHub releases page](https://github.com/positer/Newmark-Agent/releases). The current `dev-0.3.10` source is configured to produce the following artifact names when its release workflow is run.

### Windows

- `Newmark-Agent-0.3.10-x64.msi`: per-machine Windows installer.
- `Newmark-Agent-0.3.10-win-unpacked-x64.zip`: portable Windows directory with GUI, TUI, CLI, and launcher files.

### Linux

- `Newmark-Agent-0.3.10-x86_64.AppImage`: portable Linux desktop package.
- `Newmark-Agent-0.3.10-amd64.deb`: Debian/Ubuntu package.
- `Newmark-Agent-0.3.10-linux-unpacked-x64.zip`: unpacked Linux distribution.

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

The project includes source-contract, runtime-isolation, context, provider, tool exposure, GUI, TUI, CLI, SSH, WSL, and shared-backend stress suites.

```powershell
cd DESKTOP
npm run test:desktop
npm run test:full-release
```

Package validation scripts cover the Windows MSI administrative image, Windows portable output, Linux AppImage, Debian, Linux unpacked output, startup behavior, process cleanup, and release CLI behavior. Real-provider stress is opt-in and requires credentials supplied through environment variables; the harness redacts secrets and skips rather than fabricates evidence when credentials are absent.

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

- **2026-08-09 — dev-0.3.10 Windows/Linux prerelease:** Bumped package metadata to `0.3.10`, rebuilt Windows MSI/portable ZIP and Linux AppImage/deb/unpacked ZIP, and passed the complete release gate plus all five final package smokes. [GitHub release dev-0.3.10](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.3.10) was then re-downloaded and hash-audited successfully; artifact names and SHA-256 values are recorded in [OVERVIEW.md](OVERVIEW.md), the release notes, and [`archive/2026-08-09-dev-0.3.10-win-linux-release.md`](archive/2026-08-09-dev-0.3.10-win-linux-release.md).
- **2026-08-09 — dev-0.3.9 local Windows package/install:** Ran `npm.cmd run dist:windows-release` from the dev-0.3.9 source; the full release gate plus final `verify.js` passed 1461/1461. The generated MSI and portable ZIP were installed/validated locally: installed 0.3.9.0 at `C:\Program Files\Newmark Agent`, installed `resources/app.asar` matched the packaged SHA-256, installed CLI smoke passed, and `~/.Newmark` stayed byte-identical. Artifacts and MSI logs: [`archive/2026-08-09-dev039-local-package-install.md`](archive/2026-08-09-dev039-local-package-install.md).
- **2026-08-09 — dev-0.3.10 Goal/Build lifecycle hardening:** Every terminal Build Block now writes one idempotent `work_overview` entry with the startup input, final summary, event/Guide counts, and one terminal Goal audit. User Stop pauses an active Goal, ordinary input cannot resume or complete a paused Goal, and explicit resume immediately starts a Goal-driven Build. Runtime lifecycle markers distinguish a live backend from an unexpected process exit; owner-PID checks preserve backend WorkRuns after a frontend tracking timeout, while the first load after a real crash pauses Goal/Flow and records interrupted recovery. Focused lifecycle assertions, typecheck, build, and the complete 1461-assertion desktop gate passed. Evidence: [`archive/2026-08-09-dev-0.3.10-goal-build-lifecycle.md`](archive/2026-08-09-dev-0.3.10-goal-build-lifecycle.md).
- **2026-08-08 — dev-0.3.9 installed real-model stress:** Executed the machine-wide 0.3.9.0 installation against APInebula `gpt-5.4-mini` over the OpenAI protocol with an isolated temporary root and secret redaction. The full pass covered 3 CLI rounds, 3 UI rounds, Goal continuation, queue drain, conversation isolation, long-context compression, and exact installed-process cleanup. Two first-pass harness false negatives were corrected: Goal completion is asynchronous, and 40,600 ASCII characters estimate below the 12,800-token trigger of a 16k test window. A targeted 8k-window retest passed Goal in 22.173 s with 2 assistant calls and compressed 52,419 original characters to 463 estimated tokens in 36.441 s; no installed process remained and the real user config hash was unchanged. See [`archive/2026-08-08-dev039-real-model-stress.md`](archive/2026-08-08-dev039-real-model-stress.md).
- **2026-08-08 — dev-0.3.9 local package/install stress:** Built and file-smoked the Windows MSI/portable ZIP, upgraded the machine-wide installation to 0.3.9.0, and proved the installed `app.asar` matches the package while `~/.Newmark/config.json` stayed byte-identical. Stress testing fixed a real utility/WSL second-stop termination defect and refreshed two stale packaged-smoke contracts. Source, package, installed dev-0.0.8/dev-0.1.0, startup recovery, tray lifecycle, SSH/WSL, and shared-backend gates pass. Installed dev-0.0.9 remains unstable in its Browser/UI tail, and the formal performance preflight fails at 584.53 MiB startup private memory and 534.1 ms input latency under 4× CPU throttling; the 20-run acceptance set was therefore not claimed. See [`archive/2026-08-08-dev039-local-package-install-stress.md`](archive/2026-08-08-dev039-local-package-install-stress.md).
- **2026-08-08 — dev-0.3.9:** Added Prime Agent-informed durable context folding: bounded hot cache, append-only per-conversation cold archive, explicit bounded `read`, hot/cold `search`, cold restore tombstones, and archive status. Typecheck and 1461 desktop assertions pass. See [`archive/2026-08-08-dev039-prime-agent-context-archive.md`](archive/2026-08-08-dev039-prime-agent-context-archive.md).
