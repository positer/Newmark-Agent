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

Download packages from the [GitHub releases page](https://github.com/positer/Newmark-Agent/releases).

### Windows

- `Newmark-Agent-0.3.4-x64.msi`: per-machine Windows installer.
- `Newmark-Agent-0.3.4-win-unpacked-x64.zip`: portable Windows directory with GUI, TUI, CLI, and launcher files.

### Linux

- `Newmark-Agent-0.3.4-x86_64.AppImage`: portable Linux desktop package.
- `Newmark-Agent-0.3.4-amd64.deb`: Debian/Ubuntu package.
- `Newmark-Agent-0.3.4-linux-unpacked-x64.zip`: unpacked Linux distribution.

Packages are unsigned prerelease builds. Verify downloaded artifacts with the SHA-256 values published in the release notes.

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
