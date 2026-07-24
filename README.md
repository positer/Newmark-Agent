<p align="center">
  <img src="SCRIPTS/assets/newmark-agent-social-preview.png" alt="Newmark Agent" width="760">
</p>

<h1 align="center">Newmark Agent</h1>

<p align="center">
  A local-first desktop workspace for multi-model agents, coding, automation, research, and controlled computer operation.
</p>

<p align="center">
  <img alt="Development version" src="https://img.shields.io/badge/development-dev--0.1.7-blue">
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

### dev-0.1.6

Download packages from the [dev-0.1.6 release](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.6).

| Package | Platform | SHA-256 |
| --- | --- | --- |
| `Newmark-Agent-0.1.6-x64.msi` | Windows x64 installer | `AC008F0BF351F25092CDD215950E3F2973C6396D745AA6DCD54FE3CC96DC8A26` |
| `Newmark-Agent-0.1.6-win-unpacked-x64.zip` | Windows x64 portable | `7F280D0ED600C79D673AD8B772A241CB80A8648E3224872829972AAE3F226990` |
| `Newmark-Agent-0.1.6-x86_64.AppImage` | Linux x64 AppImage | `AC8A5E2033D66DCDA97F1949DF2AB6C2806E1FA6614883E0AC95CE1F6FDFEB6F` |
| `Newmark-Agent-0.1.6-amd64.deb` | Debian/Ubuntu x64 package | `35FE64695906F95CA6CE86C933EF624477896DFA1BA6AFDF1FE09DBB8BFA6BA9` |
| `Newmark-Agent-0.1.6-linux-unpacked-x64.zip` | Linux x64 portable | `B7CA1150F995F0CF51E586857550893238EDD33BFA572BA35501C041D3CF54E1` |

The Windows MSI requests administrator elevation. Windows and Linux may show an unknown-publisher warning because the packages are not code-signed.

## Quick Start

1. Download the package for your platform from [GitHub Releases](https://github.com/positer/Newmark-Agent/releases).
2. Install the Windows MSI, install the Debian package, run the AppImage, or extract a portable archive.
3. Open **Settings** and add a provider endpoint, API key, and models.
4. Validate the models. Standard-verified models can participate in Auto routing.
5. Create or open a workspace and start a conversation.

Application upgrades preserve existing user state under `~/.Newmark`.

The current source and packaged release version is `dev-0.1.7`. This release refines non-destructive conversation branching with a durable tree format, independent pagination at every edited node, target-only stop-and-rerun behavior, editable/copyable Guide rows, branch-owned Build truncation, archive/restore support for complete trees, and aligned edited-file activity rows.

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
