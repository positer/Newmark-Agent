<p align="center">
  <img src="SCRIPTS/assets/newmark-agent-social-preview.png" alt="Newmark Agent" width="760">
</p>

<h1 align="center">Newmark Agent</h1>

<p align="center">
  A local-first desktop workspace for multi-model coding, automation, research, and controlled computer operation.
</p>

<p align="center">
  <a href="https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.0"><img alt="Development" src="https://img.shields.io/badge/development-dev--0.1.0-blue"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Electron%20%2B%20TypeScript-2ea44f">
  <img alt="Status" src="https://img.shields.io/badge/status-development%20preview-orange">
</p>

Newmark Agent brings model routing, persistent workspaces, tools, subagents, workflows, and local state into one desktop application. It is designed for technical users who want to work with their own model providers without sending workspace prompts to an external routing service.

> Newmark Agent is under active development. The current Windows packages are unsigned prerelease builds.

## Why Newmark

- **One workspace for many models.** Connect OpenAI-compatible, Anthropic-compatible, GitHub Models, and custom endpoints.
- **Auditable Auto routing.** Select one model per turn from a global or provider-scoped pool using capability, quality, cost, speed, reliability, privacy, and user-preference constraints.
- **Persistent project context.** Conversations, plans, archives, skills, workflows, and user media remain attached to the correct workspace.
- **Tools with explicit boundaries.** CLI, terminal, browser, file, GitHub, SSH, automation, and Windows Computer Use tools are schema-validated and policy-checked before execution.
- **Local-first state.** Mutable data and credentials live under `~/.Newmark`, independently of the installation directory.

## Core Capabilities

### Multi-Model Routing

Auto is a persistent selection mode rather than a hidden model alias. Each turn resolves exactly one concrete provider deployment and records a redacted route decision. Global Auto can choose across enabled providers; provider Auto never leaves the selected provider. Preview models, unverified capabilities, insufficient context windows, incompatible tools, privacy conflicts, and budget violations are filtered before scoring.

Four policies are available:

| Policy | Intended use |
| --- | --- |
| Quality | Prefer the strongest validated result |
| Balanced | Trade small quality differences for cost, latency, and reliability |
| Cost | Prefer economical candidates within a wider quality band |
| Speed | Prefer low latency and throughput while retaining reliability limits |

Provider URL, credentials, protocol, and adapter are resolved again for every attempt. Equal model names at different providers are never assumed to be interchangeable.

### Model Validation

The shared validation service verifies text, streaming, strict JSON, tool selection, tool argument schemas, tool-result continuation, declared vision input, and image-output bytes. Models progress through `discovered`, `basic`, `standard`, and `extended`; only fresh Standard or Extended evidence is eligible for Auto.

### Agent Workspaces

- Workspace-scoped conversations and runtime isolation
- Build, Plan, Goal, Guide, and Flow modes
- Persistent Linked Plan and task/queue/goal controls
- One-click queue-to-Guide delivery with target, image, draft, and retry safety
- Parallel subagents with durable mailboxes
- Context compression and archived conversations
- Local, external-folder, WSL, and SSH-linked workspace support

### Tools and Automation

- Compact all-tool discovery with bounded, on-demand JSON Schema provisioning
- Native terminal and persistent terminal takeover
- Built-in browser with observe-then-act Browser Use
- Windows Computer Use with screenshots plus UI Automation targets
- Safe file editor, Markdown preview, PDF preview, and file routing
- Theme-aware native code editor with synchronized dark and light palettes
- Git and GitHub operations
- Skills, Flow workflows, recurring automation, and Memory Lab
- CLI mode with consistent schemas, policy enforcement, JSON envelopes, and exit codes

Computer Use follows an observe-before-act contract. Screenshots are one-use model inputs: they are removed after preparation and are not written to chat history, public work records, or archives.

## Download

### Windows and Linux: dev-0.1.0

The current public prerelease contains five unsigned artifacts:

| Package | Purpose | SHA256 |
| --- | --- | --- |
| [`Newmark-Agent-0.1.0-x64.msi`](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.0) | Windows per-machine installer | `54214E03DDF4C3829CC2FAB64723F5090DE02086ABA463392D55C1879FB761BB` |
| [`Newmark-Agent-0.1.0-win-unpacked-x64.zip`](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.0) | Windows portable archive | `AA105A696DF2ECF49FAE3BD7C3DF960F5F9D5F97983D5AD92E9C493819E783E1` |
| [`Newmark-Agent-0.1.0-x86_64.AppImage`](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.0) | Linux portable AppImage | `CDB7FE6A8C6B87EFBB2BD6B9569A66332FECA210D9FA368B7662D8426461A353` |
| [`Newmark-Agent-0.1.0-amd64.deb`](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.0) | Debian/Ubuntu package | `AF86AE0A616A2B6CA6B63E37C05086A3BC24254A10E4AAADEF023499B009B6F1` |
| [`Newmark-Agent-0.1.0-linux-unpacked-x64.zip`](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.0) | Linux portable archive | `A8CC6FF43D14FF0B3860FBB35086DA486838B3A60FAF85BD069F6C681534E11D` |

The MSI requests administrator elevation. Windows may show an unknown-publisher warning because the package is not code-signed.

The 0.1.0 performance line includes merged persistence writes, cached prompt/tool context, Linux-local WSL host bundles, runtime prewarming, and language-aware fenced Markdown code highlighting. The Next queue now advances automatically after terminal work events. In light mode, modal surfaces remain transparent while gaining a bright glass glow for readable foreground content.

## Quick Start

### Install a Release

1. Download the package for your platform from GitHub Releases.
2. Install the Windows MSI or extract the unpacked archive.
3. Open Settings and add a provider endpoint, API key, and models.
4. Validate the models. Standard-verified models can participate in Auto.
5. Open or create a workspace and start a conversation.

Existing user state under `~/.Newmark` is preserved during application upgrades.

### Run from Source

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

## Provider Configuration

Providers are configured in the desktop Settings page or through Newmark's CLI configuration flows. Typical fields are:

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

Supported protocol paths include OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, GitHub Models, and compatible custom gateways. Keep real credentials in your local `~/.Newmark/config.json` or an explicitly supported environment/key file. Never commit them.

## State and Privacy

Newmark separates application files from mutable user data:

```text
~/.Newmark/
├── config.json
├── agent.md
├── Work/
├── Flow/
├── skills/
├── archive/
├── Memory Lab/
└── conversation-media/
```

- Installing under `Program Files`, extracting to another drive, or moving application files does not move the state root.
- Explicit non-install `--root` paths remain available for isolated tests and temporary environments.
- Route and validation audit records exclude API keys, prompt bodies, tool arguments, and file contents.
- External black-box model routers are not required for Auto selection.

## Architecture

```text
Electron desktop / CLI
        |
        v
Shared Agent and Tool runtime
        |
        +-- Local Auto Router and Validation Service
        +-- Workspace/conversation runtime pools
        +-- Utility, WSL, and Electron host policy checks
        +-- OpenAI / Anthropic / GitHub provider adapters
        |
        v
User-selected model providers and local tools
```

Important boundaries:

- One concrete model answer is produced per turn; Newmark does not merge parallel model answers.
- Windows and WSL runtimes are isolated by workspace and conversation.
- Browser guests and utility runtimes are created on demand and retired when idle.
- Tool schemas are validated before policy checks and again at native host boundaries.
- The startup cover and hydrated application share one `BrowserWindow`; prewarm does not open a second splash window.

For a source-level map, see [OVERVIEW.md](OVERVIEW.md). Detailed release verification is kept in [the dev-0.0.11 release notes](SCRIPTS/release-notes-dev-0.0.11.md) and curated files under `archive/`.

## Development

Run commands from `DESKTOP/`:

| Command | Purpose |
| --- | --- |
| `npm.cmd run build` | Compile TypeScript and generated runtime assets |
| `npm.cmd run typecheck` | Type-check without emitting files |
| `npm.cmd run lint` | Run source lint checks |
| `npm.cmd test` | Run the complete source regression suite |
| `npm.cmd run test:dev010` | Run focused Auto, validation, startup, CLI, and Computer Use gates |
| `npm.cmd run dist:windows-release` | Build the Windows MSI and unpacked ZIP |
| `npm.cmd run dist:linux` | Build Linux packages through the Linux/WSL release path |

Generated directories such as `DESKTOP/dist/` and `release/` are not source files and should not be edited by hand.

## Platform Notes

- **Windows:** primary desktop and Computer Use platform; native and WSL Agent backends are available.
- **Linux:** GUI, CLI, terminal, packaging, and normal Agent tools are supported; Windows desktop Computer Use is unavailable.
- **WSL:** the Electron shell remains on Windows while the Agent backend can run in a selected Linux distribution after restart.
- **Signing:** current release artifacts are unsigned development previews.

## Contributing

Before submitting a change:

1. Keep mutable test state in an isolated `--root`.
2. Run `npm.cmd run typecheck`, `npm.cmd run lint`, and the relevant tests.
3. Do not commit provider keys, generated release output, local workspaces, or user state.
4. Update release notes for user-visible behavior; keep implementation history out of this README.

## License

Copyright (c) 2025 Newmark AI. All rights reserved.

Newmark Agent is currently distributed under the repository's proprietary, all-rights-reserved [LICENSE](LICENSE). Third-party dependencies and assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
