# Newmark Agent

![Release](https://img.shields.io/badge/release-v1.0.2-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Status](https://img.shields.io/badge/status-release--usable-green)

Newmark Agent is a local-first desktop Agent terminal for coding, workflow automation, and model-provider experimentation. It packages an Electron desktop UI, a TypeScript agent runtime, workspace-scoped conversations, Flow workflows, subagents, skills, archives, browser/GitHub/automation tools, and configurable OpenAI-compatible or Anthropic-compatible LLM providers.

The project is built for users who want an agent terminal that runs against their own provider credentials instead of a hosted per-seat service.

## Download

| Package | Release |
|---|---|
| Windows portable | [`Newmark-Agent-1.0.2-portable-x64.exe`](https://github.com/positer/Newmark-Agent/releases/latest) |

Run the portable executable directly. No installer is required for the current release.

## Highlights

- Local-first desktop Agent terminal with workspace-scoped state.
- Four modes: Build, Plan, Goal, and Flow.
- Goal mode can continue autonomously until the objective is completed or paused.
- Flow workflows support multi-step scripted agent runs.
- Subagents support delegated work with retained history.
- Skills can be installed, enabled, disabled, refreshed, and removed.
- Provider configuration supports OpenAI-compatible and Anthropic-compatible APIs.
- Model settings include validation metadata, context size, vision/thinking flags, and fallback behavior.
- Conversation state, archives, plans, and workspace selection are persisted locally.
- Packaged UI supports Chinese/English/auto language behavior.

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
```

Opt-in real-provider validation is available through environment variables and is skipped when credentials are absent. These scripts are intended for maintainers who explicitly accept provider spend:

```powershell
cd DESKTOP
npm.cmd run release:real-provider-smoke
npm.cmd run release:real-provider-stress
```

## Brand Assets

Application icons live in `DESKTOP/assets`: `app-icon-dark.png`, `app-icon-light.png`, and the Windows packaging icon `icon.ico`. The Electron runtime uses the themed PNGs for windows and tray rendering, while the Windows portable build uses `assets/icon.ico`.

## Release v1.0.2

The v1.0.2 release adds high-contrast themed application icons for dark and light environments, wires the Windows executable icon into packaging, and keeps the v1.0.1 release validation baseline. The public release artifact is the Windows portable executable.

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
- `OVERVIEW.md`
- `Design.md`
- generated `release/` output

If you add a real provider key locally, rotate it immediately if it is ever committed or pushed.

## License

License information will be published with the public repository metadata.
