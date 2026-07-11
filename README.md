<p align="center">
  <img src="SCRIPTS/assets/newmark-agent-social-preview.png" alt="Newmark Agent" width="760">
</p>

<h1 align="center">Newmark Agent</h1>

<p align="center">
  <a href="https://github.com/positer/Newmark-Agent/releases/latest"><img alt="Development" src="https://img.shields.io/badge/development-dev--0.0.6-blue"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%2B%20Linux-lightgrey">
  <img alt="Status" src="https://img.shields.io/badge/status-development%20preview-orange">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Electron%20%2B%20TypeScript-2ea44f">
</p>

Newmark Agent is a local-first desktop Agent workspace for coding, automation, repository review, model-provider experimentation, and controlled desktop operation. It packages an Electron desktop UI, a TypeScript Agent runtime, workspace-scoped conversations, Flow workflows, subagents, skills, archives, browser/GitHub/automation tools, and configurable OpenAI-compatible, Anthropic-compatible, and GitHub Models providers.

The current source development version is **dev-0.0.6**. The latest published packages remain **dev-0.0.5** until dev-0.0.6 is explicitly released. Newmark is intended for technical users who want an installer-backed desktop Agent app that runs against their own model credentials and keeps mutable runtime state local under `~/.Newmark`. Windows is the primary Computer Use target; Linux GUI, CLI, packaging, and terminal workflows are supported.

WSL Agent backend preview (2026-07-11): Windows settings now provide a restart-required `Windows native / WSL based` Agent backend choice. WSL mode is selectable only when at least one installed distribution is detected, and the chosen distribution is locked at application startup so active conversations are never hot-migrated between runtimes. The Electron UI and executable remain native Windows components; only the Agent backend runs as a persistent JSONL-controlled Linux process, maps Windows workspaces through `/mnt/<drive>`, and keeps configuration, conversations, and archives under the normal `~/.Newmark` user-state root. Packaged validation covers restart activation, real Linux PID reporting, WSL-local provider requests, tool writes into a Windows external workspace, and conversation isolation.

Maintenance update (2026-07-11): same-workspace conversations now remain strictly isolated. Conversation-scoped state reads no longer overwrite the requested transcript with the shared backend host transcript, delayed conversation loads are rejected after a switch, and completed runner state is merged directly into its own persisted conversation key. Packaged Windows validation covers rapid switch-back, deliberately out-of-order state responses, multi-window shared-backend operation, and cross-workspace isolation.

Archive and narrow-window follow-up (2026-07-11): archiving a conversation now atomically writes its Markdown archive and removes the target conversation from persisted and in-memory registries, including exact non-empty duplicate registrations, so it stays absent after refresh and restart. Distinct conversations that only share a title remain separate and receive a short id suffix in the list. The input toolbar now preserves a readable model label and fixed send action across narrow layouts, temporarily hiding sidebars only while the window is very narrow without changing saved layout state.

Model validation follow-up (2026-07-11): Newmark now runs its own two-stage model validation. It gathers network evidence from the provider model catalog and Newmark's built-in web search restricted to the provider's official domain, then submits real text, visual recognition, and image-generation tasks. Vision and image output are confirmed only by successful task results; names and catalog hints only decide which probes to run. The model selector shows validated-available and unvalidated models while hiding validated-unavailable/error models.

Native editor follow-up (2026-07-11): the right sidebar now contains a dependency-free Newmark text/code editor with line numbers, built-in syntax highlighting, a compact Vim command mode, undo/redo, save/dirty state, and Agent assistance. Markdown preview is an editor view toggle shown only for Markdown files. Copilot prediction is opt-in and debounced; it prefers a validated GitHub Copilot provider, cancels stale candidates while typing, accepts with `Tab`, and dismisses with `Esc`. The implementation was designed after reviewing Ace, CodeMirror, Monaco, Neovim, and CodeMirror Vim architecture, but no editor runtime or source code was imported.

File-tree polish (2026-07-11): expanding an empty child directory now leaves the branch empty instead of rendering an extra “Empty directory” row. The root-level empty-workspace message remains available.

Conversation actions (2026-07-11): user and Agent messages now expose a compact Copy action. User messages also expose Edit, which rewinds the current conversation to the selected user node, removes that node and all later model/display history, restores the original text to the prompt, and lets the user resend an edited branch. Rewind is conversation-scoped, persisted, and blocked while that conversation is running.

Provider compatibility follow-up (2026-07-11): OpenAI-compatible parsing now accepts Chat Completions string/content-part arrays, legacy `choices[].text`, Responses `output_text`, nested `output[].content[].text`, and compatibility-gateway `text.value` shapes. Context compression treats empty or controlled error responses as failures and uses the local fallback summary instead of persisting a false model-generated summary.

Copilot startup and editor binding follow-up (2026-07-11): model startup skips empty provider groups and replaces an empty or unavailable saved model with the first selectable model, synchronizing it to the backend. Editor prediction/Agent assist is bound to the model selected in the current conversation toolbar; it no longer forces GitHub Copilot. Real local validation showed 21 selectable GitHub Copilot models and 7 APInebula models, with editor requests returning the selected provider in both directions.

Context-limit compression follow-up (2026-07-11): compression is now driven by the selected model's context window instead of only a fixed character threshold. Newmark reserves output capacity, starts compression near 78% of the usable window, targets roughly 55% after compression, caps summary input/output, and retains recent history from a complete user turn so tool results are not detached from their request. The implementation remains native and compact with no tokenizer or summarization dependency. OpenAI Chat/Responses and Anthropic normal/tool/stream response text all pass through one recursive text normalizer.

Tray lifecycle follow-up (2026-07-11): the desktop tray icon is now created when the main window starts and remains the same live tray instance while the window is visible, hidden, restored, or minimized. Minimize behavior follows `ui.minimize_to_tray`, while the close button independently follows `general.close_behavior`; choosing direct close exits the process and removes the tray without leaving a background instance.

Editor prediction follow-up (2026-07-11): model code predictions now render directly at the caret as subdued gray ghost text on the code layer instead of appearing in a detached dark popup. `Tab` accepts the complete candidate into the editor, while `Esc` dismisses it; the request remains bound to the model selected by the current conversation.

## At A Glance

| Area | What Newmark provides |
|---|---|
| Desktop shell | Windows MSI install plus `win-unpacked` update pack, with Linux AppImage/deb builds and local user-state storage. |
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
| Windows MSI installer | `Newmark-Agent-0.0.5-x64.msi` |
| Windows unpacked update pack | `Newmark-Agent-0.0.5-win-unpacked-x64.zip` |
| Linux AppImage | `Newmark-Agent-0.0.5-x86_64.AppImage` |
| Linux Debian package | `Newmark-Agent-0.0.5-amd64.deb` |
| Linux unpacked update pack | `Newmark-Agent-0.0.5-linux-unpacked-x64.zip` |

Download the assets from the latest GitHub release. On Windows, install the MSI for managed desktops or use the `win-unpacked` zip as the no-loss update source. On Linux, run the AppImage or install the `.deb` package. The distributions include `LICENSE` and `THIRD_PARTY_NOTICES.md`.

The Windows MSI is a per-machine installer and targets `Program Files`, requesting elevation through Windows Installer. Mutable configuration, conversations, archives, and credentials remain under `~/.Newmark` and are preserved across upgrades.

## Quick Start

```powershell
git clone https://github.com/positer/Newmark-Agent.git
cd Newmark-Agent\DESKTOP
npm.cmd install
npm.cmd test
npm.cmd run dist:windows-release
```

The packaged Windows executable is written to:

```text
release/Newmark-Agent-0.0.5-x64.msi
release/Newmark-Agent-0.0.5-win-unpacked-x64.zip
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
release/Newmark-Agent-0.0.2-x86_64.AppImage
release/Newmark-Agent-0.0.2-amd64.deb
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
npm.cmd run dist:windows-release
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

The `release:111-*` smoke names are historical regression gates for the current feature set; they are retained even though the source development version is now `0.0.5`.

Unpacked update dry-runs can be delegated to the packaged CLI before copying files:

```powershell
release\win-unpacked\Newmark Agent.exe install-update --check-github --repo positer/Newmark-Agent
release\win-unpacked\Newmark Agent.exe install-update --from-github --repo positer/Newmark-Agent --expected-version 0.0.5 --dry-run
release\win-unpacked\Newmark Agent.exe install-update --source C:\path\to\new\win-unpacked --target C:\path\to\current\install --expected-version 0.0.5 --dry-run
```

The update helper preserves local state by default. Current installer/update builds also keep mutable state outside the installation directory under `~/.Newmark`, including `config.json`, `Work/`, `skills/`, `Memory Lab/`, and `archive/`.

Opt-in real-provider validation is available through environment variables and is skipped when credentials are absent. These scripts are intended for maintainers who explicitly accept provider spend:

```powershell
cd DESKTOP
npm.cmd run release:real-provider-smoke
npm.cmd run release:real-apinebula-memory-switch-smoke
npm.cmd run release:real-provider-stress
```

## dev-0.0.5 Notes

The dev-0.0.5 source line adds application-lifetime tray continuity, independent minimize-to-tray and close behavior, inline subdued-gray editor predictions accepted with `Tab`, context-window-aware compaction and broader OpenAI/Anthropic response normalization, stricter same-workspace conversation isolation, native editor/Markdown improvements, and the current SSH/remote-workspace follow-up work. Windows validation passed 948 source assertions, packaged tray/editor/conversation/media/startup smokes, real APInebula CLI/UI requests, and a real `GitHub Copilot/openai/gpt-4.1` editor prediction accepted with `Tab` and persisted to disk. The same unpacked build was then installed into Program Files through an uninstall/reinstall cycle; Windows registered only `0.0.5.0`, the installed `app.asar` matched the tested unpacked hash, mutable settings wrote only to `~/.Newmark`, and Program Files tray/Copilot tests passed. Linux validation passed 936 native assertions, WSLg GUI startup from the build directory, GUI startup after extracting the `linux-unpacked` upgrade zip, and GUI startup from the extracted deb installation layout. The AppImage is the direct-run package, the deb is the system installer, and the unpacked zip supports no-loss replacement while preserving mutable state under `~/.Newmark`.

Current dev-0.0.5 Windows artifact SHA256 values:

- `Newmark-Agent-0.0.5-x64.msi`: `8928DA32E99FA1F192723C17E49368F2574CCF35AC1CF45B2680C19076F43695`
- `Newmark-Agent-0.0.5-win-unpacked-x64.zip`: `E19C649D85D73567947BB160A245C46D0669C458882251D4809FDEB4E706EECC`
- `release/win-unpacked/resources/app.asar`: `334C4AF6137EA340F9AD5B1391882A746077BED5816D3649B1640552C0EFA573`
- `release/win-unpacked/Newmark Agent.exe`: `34C85FCADD492A587D13343568D5D0C111B217E325D5F5E4C9B1DF13BBCDDE23`
- `Newmark-Agent-0.0.5-x86_64.AppImage`: `30359DF4EC0C860A900FC8B811DDC1D0E750D2AA35823B7775D1249297A0A5B5`
- `Newmark-Agent-0.0.5-amd64.deb`: `6467255870F5CAAB7AB9D0B318560B67999507BBDA8DA4680F8384A5DC57E7B4`
- `Newmark-Agent-0.0.5-linux-unpacked-x64.zip`: `FDEF9732F9D774BA70B5F2566D623B55A8BD47BA5E9A0FF0755632EC00267914`

## dev-0.0.4 Published Notes

The dev-0.0.4 release keeps the current native TypeScript desktop Agent stack and publishes Windows MSI/update-pack plus Linux AppImage/deb/unpacked update assets. GitHub Models login now imports the real external catalog, reports its actual count, redraws the Models settings panel, and keeps provider credentials/catalogs in user-level `~/.Newmark` state so an empty workspace `config.json` cannot hide them.

The Windows dev-0.0.3 package was rebuilt on 2026-07-09 to fix clean-machine `win-unpacked` startup. Noncritical Windows automation wake scheduling now runs after the first desktop window is shown and Task Scheduler calls are timeout-bounded, preventing a no-window primary process from holding the single-instance lock. Packaged double-click startup also no longer uses protected install directories such as `C:\Program Files\Newmark Agent` as the writable runtime root; it falls back to the Electron user-data directory and logs fatal startup failures to `startup.log` instead of silently leaving a no-window background process. Startup now paints a lightweight Newmark shell before Agent/workspace/skills initialization and switches to the full UI after IPC and backend runtime are ready, so slow or SSH-configured roots do not look like a hung background Electron. The Windows executable registers and reports `Newmark Agent` through runtime app identity and patched version resources rather than `Electron`.

Follow-up protected-root hardening on 2026-07-10 separates installed program files from mutable user state. The executable and packaged application files may live in `Program Files`, `/opt`, or another managed install directory, but mutable Newmark state now defaults to `~/.Newmark`, including `config.json`, `agent.md`, `PC_Hash.config`, `Work/`, `Flow/`, `skills/`, `archive/`, and `Memory Lab/`. Existing state from the older Electron user-data directory is copied forward on first run when the new files are absent, and internal workspace absolute paths are normalized under the current runtime root after migration. Explicit `--root` remains available for tests or isolated runs; if that explicit root is protected or unwritable, it is remapped under `~/.Newmark/Roots/<source>-<hash>`.

Follow-up source validation on 2026-07-09 hardened OpenAI-compatible Responses mode error handling and the active input control. Direct Responses API failures now return controlled `[LLM Error]` text to the Agent path instead of throwing through validation/UI loops, while model validation still treats that controlled text as unavailable. In the renderer, when the current conversation is running, the input action becomes a Newmark marquee-bordered Stop button if the prompt is empty and a marquee-bordered Send button if the prompt has text; `Esc` stops only the current running conversation in the empty-prompt state.

The same Responses follow-up also fixed tool-result continuation for direct Responses mode. Newmark now includes prior `function_call` items before matching `function_call_output` items in the Responses input history, which prevents APInebula/OpenAI-compatible Responses endpoints from rejecting the second tool round with `No tool call found for function call output`. This was verified with source regression coverage and a real APInebula `gpt-5.4-mini` Responses tool-result probe.

Lite responsiveness was then tightened without changing Agent behavior. The native Agent bridge now builds the Newmark tool schema once per Agent turn and reuses it for both provider streaming and tool execution instead of rebuilding the full schema on every model/tool round. Context conversion is skipped entirely when automatic context compression is disabled, and high-frequency workflow tool rows defer full conversation-state JSON writes until the normal turn persistence points. Local measurement showed tool schema construction at about `0.7 ms` per build on this machine, and the main practical gain is avoiding repeated schema work plus synchronous conversation-state writes during multi-tool turns on slower Lite or remote-backed environments. Verification passed `npm.cmd test` with `895` assertions, `npm.cmd run dist:portable`, and packaged `release:ui-smoke`; details are recorded in `archive/2026-07-09-lite-response-core-redundancy.md`.

Published artifact SHA256 values for dev-0.0.4:

- `Newmark-Agent-0.0.4-x64.msi`: `26399EAFA3DD76A005933BF1BE92EB126B46D9BD6EF0975C32965D0139A4B9CF`
- `Newmark-Agent-0.0.4-win-unpacked-x64.zip`: `12BA564B0056639A058F52609CEC87172C1E411C84DFF719B4747E749086078A`
- `Newmark-Agent-0.0.4-x86_64.AppImage`: `44D70F2358EE07469CEB8854E4763F57545C0D6B0F70127F70ADB887AB995F37`
- `Newmark-Agent-0.0.4-amd64.deb`: `BF8E07F8DA1274C6A3536A9471DDDD64C193684EA5B64573BE68CE5BEA2743E1`
- `Newmark-Agent-0.0.4-linux-unpacked-x64.zip`: `DE2105907C70E444325480B0C97CE2FD3D355A9AF4AB5F64641C329DEAB57C6F`
- `release/win-unpacked/Newmark Agent.exe`: `ACC37626CB1A875A1F19CE462B91E90E2DAAECA30FFB91925B908B3AF57D4D07`

The packaged `install-update` path now reconstructs space-containing `--source`, `--target`, and `--target-file` arguments when launched through PowerShell `Start-Process`, and it preflights target writability before copying. Non-admin updates into `C:\Program Files\Newmark Agent` fail before partial copy with a clear instruction to use the MSI or rerun with administrator privileges.

Release validation for this baseline should include source tests, Windows MSI/update-pack packaging, Program Files state-root verification, Linux packaging, Linux WSLg GUI smoke, and the Linux real-provider smoke before GitHub publication. Computer Use desktop screenshots are one-time inputs only and must not be archived. The current Computer Use takeover overlay compiles its WinForms form with explicit assembly references, checks startup liveness, keeps CLI timed overlays duration-bound, and uses a winding border region so the four corners stay closed.

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
