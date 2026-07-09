<p align="center">
  <img src="SCRIPTS/assets/newmark-agent-social-preview.png" alt="Newmark Agent" width="760">
</p>

<h1 align="center">Newmark Agent</h1>

<p align="center">
  <a href="https://github.com/positer/Newmark-Agent/releases/latest"><img alt="Release" src="https://img.shields.io/badge/release-dev%201.0.2-blue"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%2B%20Linux-lightgrey">
  <img alt="Status" src="https://img.shields.io/badge/status-development%20preview-orange">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Electron%20%2B%20TypeScript-2ea44f">
</p>

Newmark Agent is a local-first desktop Agent workspace for coding, automation, repository review, model-provider experimentation, and controlled desktop operation. It packages an Electron desktop UI, a TypeScript Agent runtime, workspace-scoped conversations, Flow workflows, subagents, skills, archives, browser/GitHub/automation tools, and configurable OpenAI-compatible, Anthropic-compatible, and GitHub Models providers.

The current public development release is **dev 1.0.2**. It is intended for technical users who want a portable desktop Agent app that runs against their own model credentials and keeps runtime state local. Windows is the primary Computer Use target; Linux GUI, CLI, packaging, and terminal workflows are supported.

## At A Glance

| Area | What Newmark provides |
|---|---|
| Desktop shell | Portable Windows Electron app plus Linux AppImage/deb builds with local workspace state. |
| Agent runtime | Build, Plan, Goal, Flow, subagents, queued input, and live work events. |
| Model providers | OpenAI-compatible, Anthropic-compatible, GitHub Models/Copilot login flow, and local runtimes through normal provider settings. |
| Repository work | Local Git inspection, GitHub audit, branch/fork/PR helpers, and remote-repository security review prompts. |
| Computer Use | Native Windows observe/action flow with ephemeral screenshots, UI Automation objects, app-scoped control, and a visible takeover border. Linux reports native desktop control as unsupported instead of crashing. |
| Terminal takeover | Persistent Agent-owned terminal sessions independent from one-shot shell tools, available in desktop and CLI Agent paths with PowerShell on Windows and bash on Linux. |
| Workspace control | Local, external, and SSH-linked workspaces with exact-folder uniqueness and parent/child folder support. |
| Privacy posture | Local-first config; provider keys stay in local runtime config or environment files and must not be committed. |

## Download

| Package | Release |
|---|---|
| Windows portable | `Newmark-Agent-1.0.2-portable-x64.exe` |
| Compiled zip pack | `Newmark-Agent-1.0.2-win-unpacked-x64.zip` |
| Linux AppImage | `Newmark-Agent-1.0.2-x86_64.AppImage` |
| Linux Debian package | `Newmark-Agent-1.0.2-amd64.deb` |

Download the assets from the latest GitHub release. On Windows, run the portable executable directly; no installer is required for the dev release. On Linux, run the AppImage or install the `.deb` package. The distributions include `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Quick Start

```powershell
git clone https://github.com/positer/Newmark-Agent.git
cd Newmark-Agent\DESKTOP
npm.cmd install
npm.cmd test
npm.cmd run dist:portable
```

The packaged Windows executable is written to:

```text
release/Newmark-Agent-1.0.2-portable-x64.exe
```

Linux and WSLg development builds use native Linux Node/npm inside the distro:

```bash
git clone https://github.com/positer/Newmark-Agent.git
cd Newmark-Agent/DESKTOP
npm install
npm test
npm run dist:linux
npm run release:linux-gui-smoke
```

Maintainers with a local real-provider config can also run the Linux packaged real-model gate. By default it reads the local `_local/real-ui-user-test/config.json` config and redacts API keys from output:

```bash
cd DESKTOP
npm run release:linux-real-provider-smoke
```

Linux artifacts are written to:

```text
release/Newmark-Agent-1.0.2-x86_64.AppImage
release/Newmark-Agent-1.0.2-amd64.deb
release/linux-unpacked/newmark-agent
```

The GUI smoke test expects WSLg or another Linux display server with `DISPLAY` or `WAYLAND_DISPLAY` set.

## Configuration

Newmark stores runtime configuration locally. Keep real API keys out of Git. Use provider keys only in local runtime config, local env files, or machine environment variables.

`DESKTOP/config.example.json` is included in source and packaged builds as a recovery template. If `config.json` is damaged, Newmark backs it up and recovers from the example/default config. Normal first-run defaults remain provider-empty.

Example provider shape:

```json
{
  "models": {
    "providers": [
      {
        "name": "my-provider",
        "base_url": "https://api.example.com/v1",
        "api_key": "YOUR_LOCAL_KEY",
        "protocol": "openai",
        "enabled": true,
        "models": [
          {
            "name": "my-model",
            "display": "My Model",
            "max_tokens": 128000,
            "vision": false,
            "thinking": false
          }
        ]
      }
    ],
    "default_model": "my-model"
  },
  "general": {
    "language": "auto"
  }
}
```

For Anthropic-compatible providers, set `"protocol": "anthropic"`. GitHub Models/Copilot uses the explicit browser-login flow in Settings and is not imported through fuzzy provider injection.

## Core Capabilities

| Capability | Status |
|---|---|
| Workspace-scoped conversations and archives | Available |
| Build / Plan / Goal / Flow modes | Available |
| Subagents and installable skills | Available |
| Safe Markdown display for headings, tables, links, images, and formulas | Available |
| Rootless pasted-image prompt attachments | Available |
| Model validation with multimodal metadata persistence | Available |
| Auto model switching and context-window checks | Available |
| GitHub file audit and repository security audit | Available |
| Native OpenSSH external workspace linking | Available |
| Computer Use with one-time screenshots and UI Automation summaries | Available |
| Single-conversation Computer Use ownership lock | Available |
| Continuous closed-loop Computer Use takeover border | Available |
| Persistent terminal takeover sessions | Available |
| Native built-in tool switches in Settings | Available |
| Layout/sidebar state memory and workspace/conversation pinning | Available |

## Development

```powershell
cd DESKTOP
npm.cmd install
npm.cmd test
npm.cmd run dist:portable
```

Useful release gates:

```powershell
cd DESKTOP
npm.cmd test
npm.cmd run release:cli-smoke
npm.cmd run release:111-cli-smoke
npm.cmd run release:111-ui-smoke
npm.cmd run release:computer-use-vision-smoke
npm.cmd run release:ui-media-md-smoke
npm.cmd run release:ui-conversation-queue-plan-smoke
npm.cmd run release:ui-fast-conversation-switch-smoke
npm.cmd run release:ui-workspace-conversation-isolation-smoke
npm.cmd run release:ui-multi-window-shared-backend-smoke
```

Linux/WSLg release gates:

```bash
cd DESKTOP
npm test
npm run dist:linux
npm run release:linux-gui-smoke
```

The `release:111-*` smoke names are historical regression gates for the current feature set; they are retained even though the public dev package version is now `1.0.2`.

Portable update dry-runs can be delegated to the packaged CLI before copying files:

```powershell
release\win-unpacked\Newmark Agent.exe install-update --check-github --repo positer/Newmark-Agent
release\win-unpacked\Newmark Agent.exe install-update --from-github --repo positer/Newmark-Agent --expected-version 1.0.2 --dry-run
release\win-unpacked\Newmark Agent.exe install-update --source C:\path\to\new\win-unpacked --target C:\path\to\current\install --expected-version 1.0.2 --dry-run
```

The update helper preserves local state by default, including `config.json`, `Work/`, `skills/`, `Memory Lab/`, and `archive/`.

Opt-in real-provider validation is available through environment variables and is skipped when credentials are absent. These scripts are intended for maintainers who explicitly accept provider spend:

```powershell
cd DESKTOP
npm.cmd run release:real-provider-smoke
npm.cmd run release:real-apinebula-memory-switch-smoke
npm.cmd run release:real-provider-stress
```

## Dev 1.0.2 Notes

The dev 1.0.2 release keeps the current native TypeScript desktop Agent stack while adding Linux artifacts to the public GitHub release. The package includes the latest shared-backend multi-window desktop flow, closed-loop Computer Use takeover border with startup liveness checks and filled corners, exact-folder workspace uniqueness, GitHub audit/security prompts, explicit GitHub Models login, native OpenSSH workspace linking, message Markdown/formula rendering, rootless pasted-image attachments, persistent terminal takeover, layout memory, native tool switches, Linux AppImage/deb packaging, and platform-aware terminal defaults.

The Windows dev 1.0.2 package was rebuilt on 2026-07-09 to fix clean-machine `win-unpacked` startup. Noncritical Windows automation wake scheduling now runs after the first desktop window is shown and Task Scheduler calls are timeout-bounded, preventing a no-window primary process from holding the single-instance lock. Packaged double-click startup also no longer uses protected install directories such as `C:\Program Files\Newmark Agent` as the writable runtime root; it falls back to the Electron user-data directory and logs fatal startup failures to `startup.log` instead of silently leaving a no-window background process. Startup now paints a lightweight Newmark shell before Agent/workspace/skills initialization and switches to the full UI after IPC and backend runtime are ready, so slow or SSH-configured roots do not look like a hung background Electron. The Windows executable registers and reports `Newmark Agent` through runtime app identity and patched version resources rather than `Electron`.

Follow-up source validation on 2026-07-09 hardened OpenAI-compatible Responses mode error handling and the active input control. Direct Responses API failures now return controlled `[LLM Error]` text to the Agent path instead of throwing through validation/UI loops, while model validation still treats that controlled text as unavailable. In the renderer, when the current conversation is running, the input action becomes a Newmark marquee-bordered Stop button if the prompt is empty and a marquee-bordered Send button if the prompt has text; `Esc` stops only the current running conversation in the empty-prompt state.

The same Responses follow-up also fixed tool-result continuation for direct Responses mode. Newmark now includes prior `function_call` items before matching `function_call_output` items in the Responses input history, which prevents APInebula/OpenAI-compatible Responses endpoints from rejecting the second tool round with `No tool call found for function call output`. This was verified with source regression coverage and a real APInebula `gpt-5.4-mini` Responses tool-result probe.

Lite responsiveness was then tightened without changing Agent behavior. The native Agent bridge now builds the Newmark tool schema once per Agent turn and reuses it for both provider streaming and tool execution instead of rebuilding the full schema on every model/tool round. Context conversion is skipped entirely when automatic context compression is disabled, and high-frequency workflow tool rows defer full conversation-state JSON writes until the normal turn persistence points. Local measurement showed tool schema construction at about `0.7 ms` per build on this machine, and the main practical gain is avoiding repeated schema work plus synchronous conversation-state writes during multi-tool turns on slower Lite or remote-backed environments. Verification passed `npm.cmd test` with `895` assertions, `npm.cmd run dist:portable`, and packaged `release:ui-smoke`; details are recorded in `archive/2026-07-09-lite-response-core-redundancy.md`.

Current Windows artifact SHA256 values:

- `Newmark-Agent-1.0.2-portable-x64.exe`: `4913C1E4B15DEE5775B7EEFFC4FFEC2031F866B642B9569A9780FBB3F1EA9DCC`
- `Newmark-Agent-1.0.2-win-unpacked-x64.zip`: `EE2C31F238563570990FA43851164EBA1C2DE6B74B4A60E532653FE151154729`

Release validation for this baseline should include source tests, Windows portable packaging, Linux packaging, Linux WSLg GUI smoke, and the Linux real-provider smoke before GitHub publication. Computer Use desktop screenshots are one-time inputs only and must not be archived. The current Computer Use takeover overlay compiles its WinForms form with explicit assembly references, checks startup liveness, keeps CLI timed overlays duration-bound, and uses a winding border region so the four corners stay closed.

## Repository Hygiene

The public repository intentionally excludes local runtime state and internal project-management records, including:

- `config.json`
- `agent.md`
- `PC_Hash.config`
- `Work/`
- `archive/`
- `skills/`
- `Memory Lab/`
- `OVERVIEW.md`
- `_local/`
- `vendor/` release bundles must be empty or absent; reference code is either ignored as `_ref/` material or reimplemented natively before release.
- `Design.md`
- generated `release/` output

If a real provider key is ever committed or pushed, rotate it immediately.

## License

Copyright (c) 2025 Newmark AI. All rights reserved.

Newmark Agent is currently distributed under a proprietary, all-rights-reserved project license unless separate public release metadata explicitly grants additional rights. Third-party dependencies and icon assets remain governed by their own licenses. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
