<p align="center">
  <img src="SCRIPTS/assets/newmark-agent-social-preview.png" alt="Newmark Agent" width="760">
</p>

<h1 align="center">Newmark Agent</h1>

<p align="center">
  <a href="https://github.com/positer/Newmark-Agent/releases/latest"><img alt="Release" src="https://img.shields.io/badge/release-v1.0.2-blue"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-lightgrey">
  <img alt="Status" src="https://img.shields.io/badge/status-release--usable-green">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Electron%20%2B%20TypeScript-2ea44f">
</p>

Newmark Agent is a local-first desktop Agent terminal for coding, workflow automation, and model-provider experimentation. It packages an Electron desktop UI, a TypeScript agent runtime, workspace-scoped conversations, Flow workflows, subagents, skills, archives, browser/GitHub/automation tools, and configurable OpenAI-compatible or Anthropic-compatible LLM providers.

It is built for users who want an agent terminal that runs against their own provider credentials instead of a hosted per-seat service.

## At A Glance

| Area | What Newmark provides |
|---|---|
| Desktop shell | Portable Windows Electron app with local workspace state. |
| Agent modes | Build, Plan, Goal, and Flow for different work styles. |
| Provider model | Bring your own OpenAI-compatible or Anthropic-compatible API. |
| Local models | Works with user-installed local runtimes such as Ollama through normal provider configuration. |
| Automation | Flow workflows, subagents, archives, browser/GitHub tools, and scheduled automations. |
| Privacy posture | Local-first configuration; real provider keys stay in local runtime config or environment files. |

## Contents

- [Download](#download)
- [Highlights](#highlights)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Development](#development)
- [Brand Assets](#brand-assets)
- [Release v1.0.2](#release-v102)
- [Repository Hygiene](#repository-hygiene)
- [License](#license)

## Download

| Package | Release |
|---|---|
| Windows portable | [`Newmark-Agent-1.0.2-portable-x64.exe`](https://github.com/positer/Newmark-Agent/releases/latest) |

Run the portable executable directly. No installer is required for the current release.
The portable distribution includes `LICENSE` and `THIRD_PARTY_NOTICES.md`.

## Highlights

| Capability | Status |
|---|---|
| Workspace-scoped desktop Agent state | Available |
| Build / Plan / Goal / Flow modes | Available |
| Autonomous Goal continuation until completion or pause | Available |
| Multi-step Flow workflows | Available |
| Subagents with retained history | Available |
| Installable and refreshable skills | Available |
| OpenAI-compatible and Anthropic-compatible providers | Available |
| Fuzzy provider injection with endpoint/key parsing | Available |
| Model validation metadata, context size, vision/thinking flags, fallback behavior | Available |
| Chinese / English / auto language behavior | Available |

## Quick Start

```powershell
# From source
git clone https://github.com/positer/Newmark-Agent.git
cd Newmark-Agent
cd DESKTOP
npm.cmd install
npm.cmd test
npm.cmd run dist:portable
```

The packaged Windows executable is written to:

```text
release/Newmark-Agent-1.0.2-portable-x64.exe
```

## Configuration

Newmark stores runtime configuration locally. Keep real API keys out of Git. Use provider keys only in your local runtime config or environment-specific files.

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

For Anthropic-compatible providers, set `"protocol": "anthropic"`.

## Development

```powershell
cd DESKTOP
npm.cmd install
npm.cmd test
npm.cmd run release:cli-smoke
npm.cmd run release:ui-smoke
```

Useful release gates:

```powershell
cd DESKTOP
npm.cmd test
npm.cmd run dist:portable
npm.cmd run release:ui-smoke
npm.cmd run release:ui-icon-smoke
```

Opt-in real-provider validation is available through environment variables and is skipped when credentials are absent. These scripts are intended for maintainers who explicitly accept provider spend:

```powershell
cd DESKTOP
npm.cmd run release:real-provider-smoke
npm.cmd run release:real-provider-stress
```

## Brand Assets

Application icons live in `DESKTOP/assets`: `app-icon-dark.png`, `app-icon-light.png`, and the Windows packaging icon `icon.ico`. The Electron runtime uses the themed PNGs for windows and tray rendering, the frameless desktop UI renders the icon in the custom titlebar, and the Windows portable build uses `assets/icon.ico`.

Repository branding uses `SCRIPTS/assets/newmark-agent-social-preview.png` as the GitHub Social preview image. GitHub currently exposes this as a repository Settings upload rather than a public REST field.

## Release v1.0.2

The v1.0.2 release adds high-contrast themed application icons for dark and light environments, wires the Windows executable icon into packaging, renders the icon in the custom frameless titlebar with a runtime-verified animated color border, and keeps the v1.0.1 release validation baseline. The public release artifact is the Windows portable executable.

Maintenance log, 2026-06-29: README presentation was refreshed for GitHub rendering. The document now opens with the repository social preview image, centered title and badge block, an at-a-glance capability table, a contents list, and a status-oriented Highlights table while preserving setup, provider, release, hygiene, and license sections. Verification passed `cd DESKTOP && npm.cmd test` with 598 assertions. Evidence is stored in `archive/2026-06-29-readme-visual-refresh.md`.

Maintenance log, 2026-06-29: fuzzy provider injection now has a no-guide-model fallback. `DESKTOP/src/core/fuzzy.ts` tokenizes raw endpoint/key text, infers provider names from endpoint core domains, normalizes terminal API paths, probes common OpenAI-compatible and Anthropic-compatible suffixes, and is shared by both desktop Agent fuzzy injection and CLI `fuzzy-inject`. A live local mock injection found and fixed local-address naming so `127.0.0.1` maps to `LocalProvider` instead of a numeric fragment. Verification passed `cd DESKTOP && npm.cmd test` with 598 assertions. Evidence is stored in `archive/2026-06-29-fuzzy-inject-tokenizer-suffix-probing.md`.

Maintenance log, 2026-06-29: the built-in Gemma download entry was removed from the desktop UI and Electron IPC surface. Users can still install Gemma themselves through Ollama or another local runtime and add it as a normal OpenAI-compatible provider/model, including through fuzzy injection. Verification passed `cd DESKTOP && npm.cmd test` with 598 assertions. Evidence is stored in `archive/2026-06-29-remove-built-in-gemma-download.md`.

Maintenance log, 2026-06-29: project copyright and third-party license posture was audited and declared. Root `LICENSE` now states first-party Newmark Agent code/docs/design/assets are proprietary and all rights reserved unless a future written license says otherwise; `THIRD_PARTY_NOTICES.md` summarizes npm, NuGet, Lucide, branding-asset, internal-archive, and release notice boundaries. Electron packaging now includes both notice files. Verification passed dependency/license metadata scans and `cd DESKTOP && npm.cmd test` with 598 assertions. Evidence is stored in `archive/2026-06-29-copyright-license-audit.md`.

Maintenance log, 2026-06-29: open-source reference material was audited separately from bundled dependencies. `THIRD_PARTY_NOTICES.md` now declares local reference/vendor evidence for OpenCode, OpenCode goal plugin, Liquid Glass React, Liquid Glass Studio, liquid-dom, Apple Liquid Glass documentation references, and optional external Codex/OpenCode CLI integrations. The declaration distinguishes MIT-cleared reference material from uncleared reference-only material and states that `_vendor/`, `_ref/`, and `skills/` require release-time review before publication. Verification passed source/reference scans and `cd DESKTOP && npm.cmd test` with 598 assertions. Evidence is stored in `archive/2026-06-29-open-source-reference-audit.md`.

Maintenance log, 2026-06-28: `release:ui-icon-smoke` now validates the packaged renderer titlebar icon, decoded image dimensions, animated color border CSS, native runtime window icon capture, screenshot evidence, and release process cleanup. Evidence is stored under `archive/2026-06-28-v1.0.2-ui-icon-smoke.png` and `archive/2026-06-28-v1.0.2-runtime-window-icon.png`.

Current release judgment: `release-usable-with-operational-risks`.

Known remaining hardening areas:

- Code signing.
- Installer distribution.
- Longer field monitoring across more user machines.
- Public CI/release automation.

## Repository Hygiene

The public repository intentionally excludes local runtime state and internal project-management records, including:

- `config.json`
- `agent.md`
- `PC_Hash.config`
- `Work/`
- `archive/`
- `skills/`
- `OVERVIEW.md`
- `Design.md`
- generated `release/` output

If you add a real provider key locally, rotate it immediately if it is ever committed or pushed.

## License

Copyright (c) 2025 Newmark AI. All rights reserved.

Newmark Agent is currently distributed under a proprietary, all-rights-reserved
project license unless separate public release metadata explicitly grants
additional rights. Third-party dependencies and icon assets remain governed by
their own licenses. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
