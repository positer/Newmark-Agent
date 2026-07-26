<p align="center">
  <img src="SCRIPTS/assets/newmark-agent-social-preview.png" alt="Newmark Agent" width="760">
</p>

<h1 align="center">Newmark Agent</h1>

<p align="center">
  A local-first desktop workspace for multi-model agents, coding, automation, research, and controlled computer operation.
</p>

<p align="center">
  <img alt="Development version" src="https://img.shields.io/badge/development-dev--0.1.8-blue">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Electron%20%2B%20TypeScript-2ea44f">
  <img alt="Status" src="https://img.shields.io/badge/status-development%20preview-orange">
</p>

Newmark Agent brings model routing, persistent workspaces, tools, subagents, workflows, and local state into one desktop application. Connect your own model providers and keep workspace prompts, credentials, conversations, and mutable state under your control.

> Newmark Agent is under active development. Current packages are unsigned prerelease builds.

## Highlights

- **Bring your own models.** Use OpenAI-compatible, Anthropic-compatible, GitHub Models, and custom endpoints.
- **Auditable Auto routing.** Select a concrete model for each turn using capability, quality, cost, speed, reliability, privacy, and user preferences.
- **Durable Agent workspaces.** Keep conversations, Build history, plans, queues, goals, archives, skills, workflows, and media attached to the correct workspace.
- **Controlled tools.** Use terminal, browser, files, GitHub, SSH, automation, MCP servers, and Windows Computer Use through schema validation and policy boundaries.
- **Recoverable long-running work.** Continue from compressed context and query historical Build details without treating unrelated unfinished tasks as the current request.
- **Local-first state.** Store mutable data and credentials under `~/.Newmark`, independently of the installation directory.

## Download

### dev-0.1.7

Download packages from the [dev-0.1.7 release](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.7).

| Package | Platform | SHA-256 |
| --- | --- | --- |
| `Newmark-Agent-0.1.7-x64.msi` | Windows x64 installer | `DDACFC5005FA0EFAE2496E56F88975A2EDDB640540235F7F2009B3D1A905F098` |
| `Newmark-Agent-0.1.7-win-unpacked-x64.zip` | Windows x64 portable | `0564B7BC182589630549523303356EFA76ED92AE86525226931C21D94582B06F` |
| `Newmark-Agent-0.1.7-x86_64.AppImage` | Linux x64 AppImage | `AC90395F1ED35F6FAAF4B2873D992A26C9F15049E15F571ADEBD00B9AC5D776F` |
| `Newmark-Agent-0.1.7-amd64.deb` | Debian/Ubuntu x64 package | `A826F2EB1C961C54D58BF7DFA4C88109398A909A40E6E048CFC3074216808A75` |
| `Newmark-Agent-0.1.7-linux-unpacked-x64.zip` | Linux x64 portable | `75DC6C60AD8520986A6CF85A10452D41454F34711A6E16E388A6873B941F3863` |

The Windows MSI requests administrator elevation. Windows and Linux may show an unknown-publisher warning because the packages are not code-signed.

## Quick Start

1. Download the package for your platform from [GitHub Releases](https://github.com/positer/Newmark-Agent/releases).
2. Install the Windows MSI, install the Debian package, run the AppImage, or extract a portable archive.
3. Open **Settings** and add a provider endpoint, API key, and models.
4. Validate the models. Standard-verified models can participate in Auto routing.
5. Create or open a workspace and start a conversation.

Application upgrades preserve existing user state under `~/.Newmark`.

The current source and packaged prerelease version is `dev-0.1.8`. The release separates the visible input mode from per-turn execution, keeps Plan selected while using a proactive read-only planning boundary, makes Goal continuation yield to queued user work, and routes selected Flow input through the workflow structure with Guide-only takeover. SubAgent dispatch remains recoverably queued until an executor is available, binds in headless runtimes, preserves exact provider deployments, releases stale providers during fallback, and aborts active children on close. The input's floating stack keeps the scroll-to-bottom control above the Flow takeover bubble and the Todo/Queue/Goal bars without changing input height; leaving Flow restores Next.

## Core Capabilities

### Models and Routing

Auto is a persistent selection mode rather than a hidden model alias. Each turn resolves one concrete provider deployment and records a redacted routing decision. Global Auto can choose across enabled providers; provider Auto remains within the selected provider.

Four routing policies are available:

| Policy | Intended use |
| --- | --- |
| Quality | Prefer the strongest validated result |
| Balanced | Balance quality, cost, latency, and reliability |
| Cost | Prefer economical candidates within a wider quality band |
| Speed | Prefer low latency while retaining reliability limits |

The validation service checks text, streaming, strict JSON, tool selection, argument schemas, tool-result continuation, declared vision input, and image output. Models progress through `discovered`, `basic`, `standard`, and `extended` verification levels.

### Agent Workspaces

- Workspace-scoped conversations and runtime isolation
- Build, Plan, Goal, Guide, and Flow modes
- Persistent linked plans, queues, goals, and Next handoff
- Parallel subagents with durable mailboxes
- Context compression and restart-safe conversation history
- Local folders, external folders, WSL, and SSH-linked workspaces
- Per-conversation model and input-mode preferences

Build history exposes a compact list of user input, final summary, and completion status. Detailed work events are loaded on demand through a read-only history tool. Unfinished work is ordered newest-to-oldest, while status questions remain read-only and do not silently resume an unrelated task.

### Tools, MCP, and Automation

- Compact tool discovery with on-demand JSON Schema provisioning
- Native terminal and persistent terminal takeover
- Built-in browser with observe-then-act Browser Use
- Windows Computer Use with screenshots and UI Automation targets
- Safe file editing, Markdown/PDF preview, and file routing
- Git and GitHub operations, including repository star/fork metadata
- Persistent stdio and HTTP MCP server management
- Skills, Flow workflows, recurring automation, and Memory Lab
- CLI mode with shared schemas, policy enforcement, JSON envelopes, and exit codes

One-use Computer Use screenshots are supplied to the active model request and removed before persistence or replay.

## Provider Configuration

Configure providers in desktop Settings or through Newmark's CLI configuration flows. A typical provider entry is:

```json
{
  "name": "Example Provider",
  "base_url": "https://api.example.com/v1",
  "api_key": "",
  "protocol": "openai",
  "enabled": true,
  "models": []
}
```

Supported paths include OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, GitHub Models, and compatible custom gateways. Keep real credentials in local configuration or an explicitly supported environment/key file. Never commit them.

## State and Privacy

Newmark separates installed application files from mutable user data:

```text
~/.Newmark/
|-- config.json
|-- agent.md
|-- Work/
|-- Flow/
|-- skills/
|-- archive/
|-- Memory Lab/
`-- conversation-media/
```

- Installing under `Program Files`, extracting to another drive, or moving application files does not move the state root.
- Explicit non-install `--root` paths remain available for isolated tests and temporary environments.
- Route, validation, and optional kernel diagnostics exclude API keys, prompt bodies, tool arguments, and file contents.
- External black-box model routers are not required for Auto selection.

## Run from Source

```powershell
git clone https://github.com/positer/Newmark-Agent.git
cd Newmark-Agent\DESKTOP
npm.cmd install
npm.cmd run build
npm.cmd start
```

CLI mode:

```powershell
npm.cmd run start:cli
```

On Windows PowerShell, prefer `npm.cmd` when script execution policy blocks `npm.ps1`.

## Architecture

```text
Electron desktop / CLI
        |
        v
Shared Agent and Tool runtime
        |
        +-- Local Auto Router and Validation Service
        +-- Workspace and conversation runtime pools
        +-- Tool policy and native host boundaries
        +-- OpenAI / Anthropic / GitHub provider adapters
        |
        v
User-selected model providers and local tools
```

Important boundaries:

- One concrete model answer is produced per turn; Newmark does not merge parallel model answers.
- Tool schemas are validated before policy checks and again at native host boundaries.
- OpenAI Chat history is repaired at the transport boundary so every persisted tool call has a matching result before continuation.
- Windows, WSL, and Linux runtimes remain isolated by workspace and conversation.
- Context compression atomically replaces active and persisted Kernel context while preserving the current task boundary.
- Build blocks contain process events; the final Agent response appears once outside its owning Build.
- Build tool activity groups commands and file edits in call order, with expandable per-file change counts and line diffs.
- Diagnostics are disabled by default and expose fingerprints, counts, estimated tokens, cache metrics, and ratios rather than user content.

See [OVERVIEW.md](OVERVIEW.md) for the source tree, subsystem responsibilities, and architecture details. Release-specific changes and validation evidence belong in [GitHub Releases](https://github.com/positer/Newmark-Agent/releases) and the local `archive/` records rather than this product overview.

## Development

### Maintenance Log

- 2026-07-26: Built and validated the `dev-0.1.8` Windows/Linux prerelease. Source tests passed on Windows and isolated Ubuntu-24.04, packaged CLI/ZIP/MSI and Flow/SubAgent UI smokes passed, Linux GUI/AppImage/deb/ZIP and exit-lifecycle smokes passed, and production dependency audit reports zero vulnerabilities after upgrading the directly used `glob` runtime to the supported v13 line. See `archive/20260726-dev-0.1.8-release.md`.
- 2026-07-26: Hardened `dev-0.1.8` SubAgent execution and input overlays. Late executor binding no longer loses accepted work, agent-only runtimes execute children inside their explicit root, duplicate model names preserve provider identity, fallback releases stale providers, active close aborts the child, and settlement waiters are cleaned up. The shared floating stack orders scroll-to-bottom above the Flow takeover bubble and persistent input bars with measured 8 px separation; exiting Flow re-enables Next. See `archive/20260726-dev-0.1.8-subagent-reliability-input-float-stack.md`.
- 2026-07-26: Advanced source development to `dev-0.1.8`. Build/Plan/Goal/Flow no longer overwrite the selected input mode during send; Plan maintains the linked plan and offers execute-or-supplement feedback, Goal Guide/Next updates the Goal bar and yields hidden continuation to queued input, and Flow enforces Guide-only structure-driven Builds with a floating Newmark UI takeover bubble and explicit interruption.

- 2026-07-25: Fixed the dev-0.1.7 inline branch pager disappearing after Build completion or a partial state refresh. Branch metadata now hydrates before destructive transcript redraw and partial responses preserve fields they do not contain; packaged Electron, ZIP, and MSI smoke tests passed. See `archive/20260725-dev-0.1.7-branch-pager-completion-fix.md`.
- 2026-07-25: Rebuilt conversation persistence as a validated tree with a full node index directory, stable viewed-path editing, per-page anchors, cloned Guide Builds, runtime completion isolation, old-version failure canary, and deep/wide branch stress coverage. See `archive/20260725-dev-0.1.7-branch-tree-stability.md`.
- 2026-07-25: Repaired consumer startup and config-refresh reliability for `dev-0.1.7`. The installed payload is now hash-verified, stale temporary shortcuts are removed, one-shot startup state cannot survive a normal reload, runtime cleanup is bounded, renderer/second-instance recovery is explicit, and running Builds show compact changed-file totals. See `archive/20260725-dev-0.1.7-desktop-stability.md`.
- 2026-07-24: Repaired and locally installed the final `dev-0.1.7` Windows build. Real packaged Electron validation now proves `<1/2>`-style navigation stays under the edited node, Guide exposes Copy/Edit, branch switching replaces old Build runs, and edited-file icon/text geometry matches terminal activity rows. See `archive/20260724-dev-0.1.7-local-install.md`.
- 2026-07-24: Advanced the source version to `dev-0.1.7`. Refined branch pagination, active Build restoration, global Guide/Next preference, queue/Goal editing, context-compression feedback, and Build/file disclosure defaults. See `OVERVIEW.md` for details.
- 2026-07-24: Advanced the source version to `dev-0.1.6`. Added a "Default expand tool usage" toggle in General Settings; build blocks now auto-expand while working, auto-collapse when done, and stop auto-managing after the user manually toggles a block. Settings tabs load lazily for faster first-open, and Memory Lab panels fade in to avoid visual flash. See `OVERVIEW.md` for details.
- 2026-07-23: Corrected the first generic-select build's severe layout regression. Enhanced selects now reuse the model selector's actual button/menu classes and one top-layer directional popup positioner; compact labels reserve readable width, repeated clicks fully close generic and model Popovers, popup opening leaves toolbar geometry unchanged, and the terminal shell selector uses the same rounded glass surface. Right-panel file-tree and Flow indicators point right when collapsed and down when expanded. Real Electron acceptance is recorded in `archive/20260723-dev-0.1.5-select-popup-regression.md`.
- 2026-07-23: Built and verified the `0.1.5` Windows MSI and portable ZIP. Machine-wide UAC was cancelled, so the matching package is installed and running from the current-user Programs directory with user configuration unchanged; see `archive/20260723-dev-0.1.5-windows-package-install.md`.
- 2026-07-23: Unified ordinary popup lists with the rounded, scrollable model-selector surface, including mode/intelligence, General settings, GitHub repository, and new-conversation workspace choices. Workspace changes now return the persisted active-conversation snapshot immediately, while cold conversation activation paints disk history before isolated runtime startup; see `archive/20260723-dev-0.1.5-cold-load-select-surfaces.md`.
- 2026-07-23: Advanced the source version to `dev-0.1.5`, inset Build status/chevron controls from the user timeline, and made Memory Lab dragging a lightweight GPU translation with paused simulation and load-time relationship indexes; see `archive/20260723-dev-0.1.5-build-memory-drag.md`.
- 2026-07-22: Corrected the global `Agent.md` editor to use Newmark's theme-native input styling, registered the model-validation background note, deduplicated concurrent validation clicks, preserved manual folding after force stop, and repaired text-usable model false negatives such as DeepSeek v4; see `archive/20260722-agent-prompt-validation-lifecycle.md`.
- 2026-07-21: Prepared the cross-platform `0.1.4` release: General settings can open and refresh the user `config.json`, Models & Providers provides a live user-level `Agent.md` editor, prompt layering normalizes and deduplicates global/workspace prompts, model validation keeps text-usable models available when optional capabilities are unsupported, and explicit Linux tray exit now has a bounded shutdown fallback so it cannot leave a ghost process holding the single-instance lock. Evidence is in `archive/20260721-dev-0.1.4-settings-prompts-validation.md`.
- 2026-07-21: Recovered a local Windows startup failure caused by an incomplete machine-wide installation missing `resources/app.asar`. The verified `0.1.3` unpacked build now runs from the current-user installation path with existing `~/.Newmark` state preserved; see `archive/20260721-213821-startup-recovery.md`.

Run commands from `DESKTOP/`:

| Command | Purpose |
| --- | --- |
| `npm.cmd run build` | Compile TypeScript and generated runtime assets |
| `npm.cmd run typecheck` | Type-check without emitting files |
| `npm.cmd run lint` | Run source lint checks |
| `npm.cmd test` | Run the complete source regression suite |
| `npm.cmd run dist:windows-release` | Build the Windows MSI and portable ZIP |
| `npm.cmd run dist:linux` | Build Linux packages through the Linux/WSL release path |

Generated directories such as `DESKTOP/dist/` and `release/` are not source files and should not be edited by hand.

## Platform Notes

- 2026-07-24: Fixed nested edit pagination so a Guide edit preserves an existing Build-start page group and all earlier path information. Packaged UI validation confirms independent start and Guide pagers; see `archive/20260724-nested-start-guide-branch-pagination.md`.
- 2026-07-25: Queue, Next, and Goal stay bound to the running branch even while a sibling is viewed. The Queue header now has pause/resume beside expand; pausing preserves the queue, activating another running branch atomically rebinds the whole queue, and an explicit Stop/Force Stop pauses injection automatically.

- **Windows:** primary desktop and Computer Use platform; native and WSL Agent backends are available.
- **Linux:** GUI, CLI, terminal, packaging, and normal Agent tools are supported; Windows desktop Computer Use is unavailable.
- **WSL:** the Electron shell remains on Windows while the Agent backend can run in a selected Linux distribution after restart.
- **Signing:** current release artifacts are unsigned development previews.

## Contributing

1. Keep mutable test state in an isolated `--root`.
2. Run `npm.cmd run typecheck`, `npm.cmd run lint`, and relevant tests.
3. Do not commit provider keys, generated release output, local workspaces, or user state.
4. Put release-specific implementation history in release notes or `archive/`, not in this README.

## License

Copyright (c) 2025 Newmark AI. All rights reserved.

Newmark Agent is distributed under the repository's proprietary, all-rights-reserved [LICENSE](LICENSE). Third-party dependencies and assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
