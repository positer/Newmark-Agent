<p align="center">
  <img src="SCRIPTS/assets/newmark-agent-social-preview.png" alt="Newmark Agent" width="760">
</p>

<h1 align="center">Newmark Agent</h1>

<p align="center">
  <a href="https://github.com/positer/Newmark-Agent/releases/latest"><img alt="Release" src="https://img.shields.io/badge/release-v1.1.1-blue"></a>
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
| Updates | CLI-assisted portable updates can copy new app files while preserving local state. |
| Automation | Flow workflows, subagents, archives, browser/GitHub tools, and scheduled automations. |
| Agent kernel | Native TypeScript agent loop with live work events, queued same-conversation input, and parallel conversations. |
| Privacy posture | Local-first configuration; real provider keys stay in local runtime config or environment files. |

## Contents

- [Download](#download)
- [Highlights](#highlights)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Development](#development)
- [Brand Assets](#brand-assets)
- [Release v1.1.1](#release-v111)
- [Repository Hygiene](#repository-hygiene)
- [License](#license)

## Download

| Package | Release |
|---|---|
| Windows portable | [`Newmark-Agent-1.1.1-portable-x64.exe`](https://github.com/positer/Newmark-Agent/releases/latest) |
| Compiled zip pack | [`Newmark-Agent-1.1.1-win-unpacked-x64.zip`](https://github.com/positer/Newmark-Agent/releases/latest) |

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
| Installable, refreshable, and source-managed skills | Available |
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
release/Newmark-Agent-1.1.1-portable-x64.exe
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
npm.cmd run release:cli-ui-conversation-sync-smoke
npm.cmd run release:ui-smoke
npm.cmd run release:ui-model-auto-context-smoke
npm.cmd run release:ui-gemma-removal-smoke
npm.cmd run release:ui-icon-smoke
```

Portable update dry-runs can be delegated to the CLI before copying files:

```powershell
release\win-unpacked\Newmark Agent.exe install-update --check-github --repo positer/Newmark-Agent
release\win-unpacked\Newmark Agent.exe install-update --from-github --repo positer/Newmark-Agent --expected-version 1.1.1 --dry-run
release\win-unpacked\Newmark Agent.exe install-update --source C:\path\to\new\win-unpacked --target C:\path\to\current\install --expected-version 1.1.1 --dry-run
```

The update helper preserves local state by default, including `config.json`, `Work/`, `skills/`, `Memory Lab/`, and `archive/`.

Opt-in real-provider validation is available through environment variables and is skipped when credentials are absent. These scripts are intended for maintainers who explicitly accept provider spend:

```powershell
cd DESKTOP
npm.cmd run release:real-provider-smoke
npm.cmd run release:real-apinebula-memory-switch-smoke
npm.cmd run release:real-provider-stress
```

## Brand Assets

Application icons live in `DESKTOP/assets`: `app-icon-dark.png`, `app-icon-light.png`, and the Windows packaging icon `icon.ico`. The Electron runtime uses the themed PNGs for windows and tray rendering, the frameless desktop UI renders the icon in the custom titlebar, and the Windows portable build uses `assets/icon.ico`.

Repository branding uses `SCRIPTS/assets/newmark-agent-social-preview.png` as the GitHub Social preview image. GitHub currently exposes this as a repository Settings upload rather than a public REST field.

## Release v1.1.1

The v1.1.1 release adds native file and remote GitHub audit tools, proactive remote-repository security review, persistent Agent terminal takeover for desktop and CLI Agent paths, native OpenSSH remote workspace linking, GitHub Copilot / Models provider support through precise browser login, a dedicated Settings > Tools page for native built-in tool switches, and native Windows Computer Use with synchronized one-time screenshot vision plus UI Automation semantic objects when the selected model supports vision. OpenSSH support lets the UI or Agent create/edit SSH connection metadata, validate the link through the system `ssh` executable, create remote workspace directories, read/create the remote `PC_Hash.config`, and relink previously saved SSH external workspaces when the remote PC hash matches. SSH passwords are not stored; use SSH agent, SSH config, or identity files. Computer Use screenshots are never archived: vision-capable turns attach the image to the next model input and delete it immediately after preparing the request, while non-vision or direct tool paths delete the screenshot before returning. Computer Use now exposes stable semantic target IDs, high-priority object summaries, scroll actions, a full-desktop dynamic gradient edge indicator while the Agent is taking over the desktop, taskbar/visible-application scoped screenshots and actions through app title, process name, PID, or window handle, and a single-conversation ownership lock so parallel conversations cannot control the desktop at the same time. GitHub/Copilot remains excluded from fuzzy provider injection; login-based providers require explicit user action.

Release validation, 2026-07-03: source tests passed with 843 assertions, packaged CLI smoke passed, packaged UI language/secondary-window smoke passed, packaged Settings > Tools CDP validation passed native tool visibility and persistence, `release:111-cli-smoke` passed file/GitHub audit, branch/fork status, remote security audit, Computer Use dry-run move/scroll/`target_id` guard, OpenSSH tool availability, and CLI Agent terminal takeover checks, `release:111-ui-smoke` passed GitHub/Copilot exact-login UI, fuzzy-exclusion, and bottom-terminal takeover marquee-border checks, `release:computer-use-vision-smoke` passed packaged vision/non-vision Computer Use behavior with no temporary screenshot path leaks or screenshot residue plus takeover-stop and application-scoped control checks, and `release:ui-media-md-smoke` passed packaged conversation Markdown rendering for headings, image/file links, tables, inline formulas, and block formulas. Real packaged APInebula validation was refreshed against `gpt-5.4-mini` with `release:real-provider-smoke`, covering real CLI send, CLI UTF-8 send, real `validate-models`, real UI send, UI UTF-8 send, key redaction, and screenshot evidence; `release:real-provider-stress` also passed CLI rounds, UI rounds, Goal continuation, queue drain, conversation isolation, long-context send, and process cleanup. The release also carries `config.example.json` in source and package form; damaged `config.json` files are backed up and recovered from the example/default config, while normal first-run defaults remain provider-empty. CLI stdout/stderr now suppress asynchronous closed-pipe `EPIPE` events so redirected or prematurely closed pipelines do not surface Electron main-process error dialogs. Follow-up packaged validation fixed GitHub Copilot login for current GitHub CLI by using `gh auth refresh --scopes models:read` without the unsupported `--web`, added explicit browser fallback, and confirmed `--root` paths with spaces load the real APInebula `gpt-5.4-mini` UI test root. The final follow-up moved the Computer Use takeover indicator to a single forced, click-through full-virtual-desktop overlay that reuses shared `ui.gradient_colors`, `ui.gradient_speed`, and `ui.gradient_width` settings, and `release:real-ui-copilot-computeruse-smoke` confirmed the real APInebula UI root, GitHub Copilot provider import as `github_models`, and screenshot evidence without token leakage. Whiteboard hardening then replaced color-key/layered overlay transparency with a Region-cut edge-only overlay and WMI-created detached process; packaged pixel validation confirmed the overlay survives CLI exit, leaves the desktop center transparent, renders configured width and continuous interpolated edge colors rather than solid color blocks, and deletes the one-time screenshot immediately. On 2026-07-04, Computer Use gained a single-conversation lock in the native tool executor; the owning conversation can continue sequential actions until `takeover_stop`, while another parallel conversation receives a structured occupied error. Source validation passed with 851 assertions, `dist:portable` passed with packaged release CLI smoke, and packaged `release:ui-conversation-queue-plan-smoke` passed live text binding, foreground/background replay, tool-result persistence, queue drain, and no cross-conversation leakage after rebuilding. Follow-up real validation passed `release:cli-smoke`, `release:111-cli-smoke`, `release:111-ui-smoke`, `release:real-provider-smoke`, `release:real-ui-copilot-computeruse-smoke`, `release:computer-use-vision-smoke`, `release:ui-icon-smoke`, `release:ui-conversation-queue-plan-smoke`, and a direct real `gpt-5.4-mini` packaged `computer_use observe` turn; Codex desktop Computer Use also inspected the visible packaged UI and confirmed the real APInebula model selector, Build/Guide controls, terminal panel, titlebar/icon, and sidebar rendering. Follow-up rapid-switch validation added `release:ui-fast-conversation-switch-smoke`; source validation passed with 855 assertions, and packaged CDP visual validation switched A/B conversations twenty times by conversation ID while proving the visible `#chat-area` never showed the other conversation's prompt/reply markers and captured final A/B screenshots. The 2026-07-05 follow-up fixed remaining duplicate-reply reconciliation by normalizing same-conversation streamed/final response matching across both token and response return paths, replaced TeX source boxes with local rendered formula structure, added rootless pasted-image prompt attachments, and changed the Computer Use desktop overlay from integer color-index stepping to a shared stopwatch-driven perimeter offset so all four edges animate as one continuous gradient. Validation passed `npm.cmd test` with 855 assertions, refreshed `dist:portable` artifacts, packaged `release:cli-smoke`, packaged `release:ui-media-md-smoke` including rootless paste and rendered formula checks, packaged `release:computer-use-vision-smoke`, packaged conversation queue/plan and fast-switch isolation smokes, real APInebula `release:real-provider-smoke`, a dedicated real APInebula CDP check proving one backend assistant row and one visible DOM assistant row for a formula reply, and in-memory Computer Use overlay pixel sampling without saving a desktop screenshot. The current v1.1.1 artifact SHA256 values are `3D6DAB4AC9A5AC392C23275C6607C86A6EA590FA0594E3BAA402DD05C31C36AE` for `Newmark-Agent-1.1.1-portable-x64.exe` and `7A410E2D41115AE8BC68FA3BC553E33B8033AEA7768648EA78B94006AC6679DC` for `Newmark-Agent-1.1.1-win-unpacked-x64.zip`. Evidence is stored in `archive/2026-07-03-release-1.1.1.md`, `archive/2026-07-03-real-release-ui-cli-visual-validation.md`, `archive/2026-07-03-config-example-recovery.md`, `archive/2026-07-03-copilot-login-root-ui-followup.md`, `archive/2026-07-03-real-ui-copilot-computeruse-followup.md`, `archive/2026-07-03-computer-use-overlay-whiteboard-fix.md`, `archive/2026-07-04-computer-use-single-conversation-lock.md`, `archive/2026-07-04-conversation-live-feedback-binding.md`, `archive/2026-07-04-real-model-computeruse-desktop-validation.md`, `archive/2026-07-04-fast-conversation-switch-visual-isolation.md`, `archive/2026-07-04-md-image-paste-computeruse-followup.md`, `archive/2026-07-03-real-provider-stress-debug.md`, `archive/2026-07-03-conversation-markdown-rendering.md`, `archive/2026-07-03-model-validation-multimodal-fix.md`, `archive/2026-07-03-native-tool-settings.md`, `archive/2026-07-03-computer-use-ephemeral-vision.md`, `archive/2026-07-03-computer-use-takeover-app-scope.md`, and `archive/2026-07-03-release-computer-use-vision-smoke.json`.

## Release v1.1.0

The v1.1.0 release adds Memory Lab persistent memory, OpenAI Responses / Chat transport selection, Auto-model switching controls, Agent compatibility surfaces, Skills Market source management, and the v1.0.2 icon/runtime baseline. The public release artifact is the Windows portable executable.

Maintenance log, 2026-06-29: README presentation was refreshed for GitHub rendering. The document now opens with the repository social preview image, centered title and badge block, an at-a-glance capability table, a contents list, and a status-oriented Highlights table while preserving setup, provider, release, hygiene, and license sections. Verification passed `cd DESKTOP && npm.cmd test` with 598 assertions. Evidence is stored in `archive/2026-06-29-readme-visual-refresh.md`.

Maintenance log, 2026-07-01: Agent plugin/skill/tool/subagent interface compatibility was audited against current OpenAI/Codex, Claude Code, OpenCode, and Agent Skills conventions. Newmark already matches the OpenAI-style function-tool definition baseline and basic `SKILL.md` skill directories, but needs a canonical tool/result envelope, plugin manifest loaders, broader skill discovery, and structured subagent return contracts before it can host market plugins from those ecosystems. Verification passed `cd DESKTOP && npm.cmd test` with 602 assertions. Evidence is stored in `archive/2026-07-01-agent-plugin-interface-compatibility-audit.md`.

Maintenance log, 2026-07-01: the Agent compatibility layer was implemented and hardened for core/CLI paths. `DESKTOP/src/core/compat.ts` now defines canonical tool/result/plugin/agent-preset interfaces, emits OpenAI Chat, OpenAI Responses, and Anthropic tool schemas, normalizes Codex, Claude Code, OpenCode, and Newmark-native plugin metadata, records discovered MCP/LSP/hooks/package-plugin components without auto-starting them, reads plugin marketplace/catalog metadata, and can explicitly execute local OpenCode JavaScript custom tools through `compat-tool` while refusing TypeScript tools without a transpilation step. Skills discovery now covers `.agents/skills`, `.claude/skills`, user-level skill folders, and plugin-packaged skills; normalized agent presets can now drive `task`/subagent creation through `preset` or `agent`, and subagents expose structured records/envelopes while preserving existing transcript output. The new `compat` CLI command debugs tools, plugins, marketplaces, skills, agent presets, and subagent schemas without opening the UI. Verification passed `cd DESKTOP && npm.cmd test` with 639 assertions plus CLI smoke checks for `compat --target all`, `compat --target marketplaces`, and `compat-tool --list`. Evidence is stored in `archive/2026-07-01-agent-compatibility-implementation.md`.

Maintenance log, 2026-07-01: Skills Market sources are now user-manageable. `DESKTOP/src/core/skills.ts` persists user sources in local `skills/.market-sources.json`, keeps the built-in design-taste skill source read-only, supports JSON catalogs, direct remote `SKILL.md` URLs, and local directory sources, and annotates market entries with source metadata. `skills-market` now supports `--sources`, `--add-source`, `--remove-source`, `--enable-source`, and `--disable-source` while preserving existing query output; the desktop Plugins > Skills Market panel exposes the same source add/enable/disable/remove controls through Electron IPC/preload. Verification passed `cd DESKTOP && npm.cmd test` with 651 assertions plus `node dist\launcher.js skills-market --sources --root "C:\Users\12252\Desktop\Files\Code\Newmark Agent"`. Evidence is stored in `archive/2026-07-01-skills-market-source-management.md`.

Maintenance log, 2026-07-01: Memory Lab was added as a local persistent memory surface. `DESKTOP/src/core/memoryLab.ts` manages root-level `Memory Lab/index.json` plus memory components, Agent prompts disclose only the one-line existence signal, and the `memory_lab_read/update/reindex` tools gate index access and model-assisted updates. CLI, Electron IPC, and Agent tool writes now route through the same MemoryLabIndexAgent organizer before deterministic index repair. The desktop left toolbar exposes a switchable Memory Lab viewer: Overview renders the full tag/component graph from the Memory Lab index with drag, zoom, focus modes, and list-style controls; Detail keeps the centered parent/child layout with attached components plus core markdown below, root-tag overview when a root tag is centered, no connector lines, and tag search for direct navigation. `memory-lab` CLI supports read/update/reindex flows, and packaged release CLI/UI smoke now covers Memory Lab. Evidence is stored in `archive/2026-07-01-memory-lab.md`.

Maintenance log, 2026-07-01: a real APInebula release gate was added for Memory Lab and model switching. `release:real-apinebula-memory-switch-smoke` uses an isolated root, requires `NEWMARK_APINEBULA_KEY` or `NEWMARK_REAL_API_KEY`, validates the selected APInebula model, asks the real model to call `memory_lab_read` then `memory_lab_update`, verifies the created component through packaged `memory-lab`, and checks unavailable-model fallback to the available APInebula model without leaking keys. Evidence is recorded in `archive/2026-07-01-release-1.1.0.md`.

Maintenance log, 2026-07-02: refreshed real-provider validation passed on the packaged v1.1.0 build with APInebula `gpt-5.4-mini`. `release:real-provider-smoke` covered packaged CLI send, CLI UTF-8 send, real model validation, packaged UI send, UI UTF-8 send, screenshot evidence, and secret redaction. `release:real-apinebula-memory-switch-smoke` covered real-model Memory Lab read/update tool use and unavailable-model fallback. A separate Anthropic-compatible stress run against the currently configured `ANTHROPIC_*` provider did not pass because that provider returned `402 Insufficient Balance`; UI rounds, queue drain, conversation isolation, long-context send, and process cleanup still passed in that run. Evidence is recorded in `archive/2026-07-01-release-1.1.0.md` and `archive/2026-07-01-real-provider-stress-debug.md`.

Maintenance log, 2026-07-02: the Windows unpacked executable icon path was hardened. `DESKTOP/scripts/patch-win-exe-icon.cjs` writes the Newmark icon directly into `release/win-unpacked/Newmark Agent.exe` resources with Win32 `UpdateResource`, using uncompressed DIB icon images for reliable Windows association. `dist:portable` now patches and verifies the unpacked executable before producing the compiled zip pack, and `release:ui-icon-smoke` fails if the unpacked executable association regresses to the default Electron icon. Verification passed `cd DESKTOP && npm.cmd test`, `cd DESKTOP && npm.cmd run dist:portable`, zip-extracted EXE icon verification, and `cd DESKTOP && npm.cmd run release:ui-icon-smoke`. Current v1.1.0 artifact SHA256 values are `EFCC774B0D38C73CD1C9C948FA092B91F597C26E7D4DBDDC2C74409F27687B2F` for `Newmark-Agent-1.1.0-portable-x64.exe` and `8C1A72C054D16C37BC2FE4CB100A7F74F82255D026A5D762940280570E3901DF` for `Newmark-Agent-1.1.0-win-unpacked-x64.zip`. Evidence is stored in `archive/2026-07-02-win-unpacked-exe-icon.md`.

Maintenance log, 2026-07-02: packaged real-model validation was refreshed with the local APInebula key file and explicit APInebula stress configuration. `release:real-provider-smoke` passed real packaged CLI send, CLI UTF-8 send, validate-models, UI UTF-8 send, UI send, screenshot evidence, and key redaction. `release:real-apinebula-memory-switch-smoke` passed real model validation, Memory Lab read/create tool use, component readback, tag repair, and unavailable-model fallback. `release:real-provider-stress` now drives queue drain through the real renderer input queue instead of assuming concurrent preload calls return the queued turn; with explicit `NEWMARK_REAL_STRESS_*` APInebula settings it passed CLI rounds, UI rounds, Goal continuation, queue drain, conversation isolation, long-context send, and release process cleanup. A visible packaged UI was opened against `_local/real-ui-user-test` with APInebula `gpt-5.4-mini` for user inspection. Evidence is stored in `archive/2026-07-02-real-provider-stress-debug.md` and `archive/2026-07-02-real-api-ui-user-test.md`.

Follow-up, 2026-07-02: the same packaged APInebula gates were re-run from `_ref/APInebula-key.txt`; `release:real-provider-smoke`, `release:real-apinebula-memory-switch-smoke`, `release:real-provider-stress`, and `cd DESKTOP && npm.cmd test` all passed, with 755 assertions in the full test suite. `_local/` is ignored so the real-model user-test root and local provider config cannot be staged. Requirement-level closure evidence is recorded in `archive/2026-07-02-real-model-release-completion-audit.md`.

Maintenance log, 2026-07-02: conversation control was tightened for parallel Agent work. Archiving a running conversation now interrupts that conversation's native kernel run before writing the archive, while normal foreground/background switching never stops background Agents. Guide input during an active turn is delivered as steering instead of entering the visible queue; Next remains the editable queued-work path. Foregrounding a background conversation immediately reloads backend messages and work-event snapshots, resists backend active-conversation snapback briefly, and keeps a five-minute tracking window after switching away. Visible work feedback now uses natural status text such as `Preparing request.` rather than generic Agent-is-working labels, and the collapsed queue pill is vertically centered with aligned rounded controls. Verification passed `cd DESKTOP && npm.cmd test` with 758 assertions. Evidence is stored in `archive/2026-07-02-conversation-steer-archive-tracking.md`.

Follow-up, 2026-07-02: packaged real-model validation was rerun after the conversation-control changes. `release:real-provider-smoke`, `release:real-apinebula-memory-switch-smoke`, and full `release:real-provider-stress` passed against APInebula `gpt-5.4-mini`; stress covered CLI rounds, UI rounds, Goal continuation, real renderer queue drain, conversation isolation, long-context send, secret guards, and process cleanup. The stress harness now normalizes the unstable `https://api.apinebula.com/v1` alias to the release-validated `https://apinebula.com/v1` endpoint for APInebula. Evidence is stored in `archive/2026-07-02-real-provider-stress-debug.md`.

Maintenance log, 2026-07-02: the Agent work timeline now hides internal workflow status rows from the chat surface. A send no longer creates a local `Preparing request...` placeholder, backend `start/status/done` events do not render as visible workflow messages, streaming model text updates the assistant response immediately, and tool work is shown as a single folded batch per turn. The batch title updates from `正在编辑 x 个文件，正在使用 x 个工具` while running to `已编辑 x 个文件，已使用 x 个工具` when complete; expanding it reveals each individual tool call and result in its own nested folded section. Hidden reasoning remains suppressed, normal file/terminal tool outputs stay folded, and terminal tools no longer pollute final assistant text while terminating tools such as Flow, Memory Lab, automation, and subagent management still return visible results. Verification passed `cd DESKTOP && npm.cmd test` with 760 assertions. Evidence is stored in `archive/2026-07-02-agent-work-timeline-folding.md`.

Maintenance log, 2026-07-03: the real-model UI duplicate final reply path was fixed and guarded. The renderer now remembers the just-completed streamed assistant message from `agent:workEvent done`, then reuses that message when `window.sendMessage()` receives the same returned token text instead of appending a second assistant row. The real-provider smoke now asserts CLI/UI marker counts are exactly one and emits assistant/backend DOM debug summaries on marker timeout. Prompt file paste and drag/drop now insert filesystem paths into the input box through the Electron preload bridge. Verification passed `cd DESKTOP && npm.cmd test` with 762 assertions, `cd DESKTOP && npm.cmd run dist:portable`, APInebula `release:real-provider-smoke` with UTF-8/model validation enabled, `release:real-apinebula-memory-switch-smoke`, and explicit APInebula `release:real-provider-stress`. Current v1.1.0 artifact SHA256 values are `EE3131753A09BC6F37BFFD41BA94545AF389C834112BE3ED2E0424A93C41FE07` for `Newmark-Agent-1.1.0-portable-x64.exe` and `767E5B6E733A64400F6F7671A46DB308AC8A226C034657E103CBCFC68BCDBD55` for `Newmark-Agent-1.1.0-win-unpacked-x64.zip`. Evidence is stored in `archive/2026-07-03-ui-cli-duplicate-reply-file-paste-release.md`.

Maintenance log, 2026-07-03: file creation/change audit and GitHub audit integration were added to the native tool layer. `file_audit` now reports local filesystem metadata, SHA256, local Git tracking/status/last-commit/base-diff data, and, for GitHub-backed files, remote repository, branch, contents, and commits-by-path metadata through `gh api`. New explicit tools cover local branch inspection/creation/switching, fork status/create, and PR creation while keeping remote writes out of the audit path. CLI JSON argument files now strip UTF-8 BOMs for Windows PowerShell compatibility. Verification passed `cd DESKTOP && npm.cmd test` with 769 assertions plus live read-only `file_audit`, `gh_repo_view`, `git_branch current`, and `gh_fork status` checks against the public `positer/Newmark-Agent` repository. Evidence is stored in `archive/2026-07-03-file-github-audit.md`.

Maintenance log, 2026-07-03: remote repository security review was added for release 1.1.1 preparation. `repo_security_audit` is a read-only Build/Plan tool that detects GitHub/remote-backed workspaces, public/private repository metadata, dirty files, changed files, likely tracked secrets, ignored local-only release-excluded paths, and privacy exposure risks. The Agent prompt now actively pushes safety review whenever remote-backed content is present, and `git_push` / `gh_pr_create` include a compact security preflight summary before remote writes. Evidence is appended to `archive/2026-07-03-file-github-audit.md`.

Maintenance log, 2026-07-03: bottom-terminal Agent takeover and GitHub Copilot/Models provider support were added. The new `terminal_takeover` Agent tool is independent from the one-shot `bash` tool and keeps a named persistent shell session across `start/write/read/stop/list` calls in both desktop and CLI Agent paths; desktop takeover sessions are mirrored into bottom terminal tabs, accept manual input into the same session, and show the existing Newmark dynamic gradient marquee border while active. Model providers now accept the `github_models` protocol, infer GitHub/Copilot entries to `https://models.github.ai`, list models through GitHub Models catalog, and chat through the official GitHub Models inference endpoint with GitHub token headers. GitHub/Copilot is exact-login only: Settings opens the default browser through GitHub CLI login/refresh with `models:read`, and fuzzy injection deliberately rejects GitHub/Copilot candidates instead of importing them. Verification passed `cd DESKTOP && npm.cmd test` with 784 assertions and `cd DESKTOP && npm.cmd run build` before the exact-login hardening; follow-up regression is recorded in `archive/2026-07-03-terminal-takeover-github-models.md`.

Maintenance log, 2026-07-03: layout memory, workspace/conversation pinning, and scoped archive management were added. The renderer now persists only sidebar collapsed booleans for left, left-secondary, right, and bottom panels, deliberately avoiding concrete restored page/file/tab content. Workspaces can be pinned through the left workspace list and persist in `Work/Local.json` / `Work/External.json`; conversations can be pinned through the conversation list and persist in workspace-local `conversations/state.json`. Right-sidebar archive management now calls the workspace-scoped archive list, while Settings > Archive calls the all-archives list with stable archive IDs so same-named files from different workspaces remain addressable. Verification passed `cd DESKTOP && npm.cmd test` with 815 assertions. Evidence is stored in `archive/2026-07-03-layout-pin-archive-scope.md`.

Maintenance log, 2026-07-01: the model kernel now exposes OpenAI-compatible Chat Completions streaming, non-stream Chat Completions, and direct Responses API modes while keeping Anthropic-compatible provider support. Auto model switching is available only through the `auto` model entry; when Auto is disabled the entry is hidden, Full Auto may choose across providers, and Provider Auto stays within the anchored provider. Model validation/import descriptions now record capability, speed, cost, and multimodal metadata for switching decisions; Auto checks context capacity before switching and can choose a vision-capable model when multimodal input requires it. The desktop input toolbar now shows a compact context-token ring next to model selection, with hover details for token usage and percentage. CLI now distinguishes workspace conversation mode from explicit `--agent-only` pure Agent mode; pure Agent mode runs without workspace conversation state and serves as the base path for one-shot sends, model validation, fuzzy injection, and subagent-style no-workspace execution. Desktop Agent sends now run through per-conversation runner Agents, so different conversations can execute in parallel while same-conversation input is queued; the visible timeline receives live work events for stream text, tool calls, tool arguments, and tool results without exposing hidden reasoning. `install-update` adds a version-checked portable update helper that can check GitHub Releases, download the compiled zip pack, and copy app files while preserving local data; Settings now includes an Updates panel for the same GitHub/local dry-run path. Verification passed `cd DESKTOP && npm.cmd test` with 728 assertions, `cd DESKTOP && npm.cmd run dist:portable`, `release:ui-model-auto-context-smoke`, `release:cli-ui-conversation-sync-smoke`, `release:ui-conversation-queue-plan-smoke`, real APInebula `validate-models`, packaged `chat_stream` send, real packaged Models UI inspection, and the real APInebula Memory Lab/model-switch gate. Evidence is stored in `archive/2026-07-01-openai-responses-auto-model-context.md` and `archive/2026-07-01-release-1.1.0.md`.

Maintenance log, 2026-07-01: the desktop conversation runtime was migrated to a project-native TypeScript Agent kernel inspired by pi-agent-core patterns, without shipping pi as an npm dependency or under `vendor/`. `DESKTOP/src/core/agentKernel/` now owns the in-repo agent loop, queue, event stream, and message types; `agentKernelRunner.ts` bridges Newmark tools/providers to that native loop; `conversationKernel.ts` owns per-conversation runners so foreground and background conversations can run in parallel, preserve their own transcripts/plans, and replay visible work events. The follow-up pi-agent-TUI review moved steering/follow-up queue snapshots fully into backend runtime state: `queue_update` work events now carry queue payloads, IPC exposes snapshots, queued messages are cleared when the native kernel emits user `message_start`, `agent:getState` returns cached work-event snapshots, and mode/model synchronization no longer discards active conversation kernels. Foregrounding a background conversation restores the full visible work stream while preserving realtime IPC events. The migration keeps the existing UI surface while adding deterministic release checks that there are no external pi runtime dependencies and no `vendor` source tree. Verification passed `cd DESKTOP && npm.cmd test` with 747 assertions, packaged `release:ui-conversation-queue-plan-smoke`, packaged `release:ui-goal-continuation-smoke`, and refreshed v1.1.0 portable/zip artifacts. Current artifact SHA256 values are `48B4C50C5FF1B6469B766504590AB661581984387A9E45DD13D243BA548A1DDB` for `Newmark-Agent-1.1.0-portable-x64.exe` and `F85466A8709E033B16B0C7F5CFD2DAB0AD95B47F623A7758CAFAB172C74242C8` for `Newmark-Agent-1.1.0-win-unpacked-x64.zip`. Evidence is stored in `archive/2026-07-01-native-agent-kernel-replacement.md`.

Maintenance log, 2026-06-29: fuzzy provider injection now has a no-guide-model fallback. `DESKTOP/src/core/fuzzy.ts` tokenizes raw endpoint/key text, infers provider names from endpoint core domains, normalizes terminal API paths, probes common OpenAI-compatible and Anthropic-compatible suffixes, and is shared by both desktop Agent fuzzy injection and CLI `fuzzy-inject`. A live local mock injection found and fixed local-address naming so `127.0.0.1` maps to `LocalProvider` instead of a numeric fragment. Verification passed `cd DESKTOP && npm.cmd test` with 598 assertions. Evidence is stored in `archive/2026-06-29-fuzzy-inject-tokenizer-suffix-probing.md`.

Maintenance log, 2026-06-29: the built-in Gemma download entry was removed from the desktop UI and Electron IPC surface. Users can still install Gemma themselves through Ollama or another local runtime and add it as a normal OpenAI-compatible provider/model, including through fuzzy injection. Verification passed `cd DESKTOP && npm.cmd test` with 598 assertions. Evidence is stored in `archive/2026-06-29-remove-built-in-gemma-download.md`.

Maintenance log, 2026-06-29: v1.0.2 was rebuilt as a Windows portable release and visually verified in the real packaged Electron runtime for the Gemma-download removal. The new `release:ui-gemma-removal-smoke` launches `release/win-unpacked/Newmark Agent.exe`, confirms the packaged preload no longer exposes `downloadGemma`, confirms Settings > Models has no Gemma/Ollama download wording, and verifies manual local OpenAI-compatible provider/model configuration still works for endpoints such as Ollama or LM Studio. Verification passed `cd DESKTOP && npm.cmd test` with 602 assertions, `cd DESKTOP && npm.cmd run dist:portable`, and `cd DESKTOP && npm.cmd run release:ui-gemma-removal-smoke`. The portable artifact SHA256 is `C687C8DE21AE66DA3982B0E8EA82F07E8CEFEA61132A64259C3A0EA7A42026F5`; visual evidence is stored in `archive/2026-06-29-release-gemma-removal-visual.png` and `archive/2026-06-29-release-gemma-removal-visual.md`.

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
- `Memory Lab/`
- `OVERVIEW.md`
- `vendor/` release bundles must be empty or absent; reference code is either ignored as `_ref/` material or reimplemented natively before release.
- `Design.md`
- generated `release/` output

If you add a real provider key locally, rotate it immediately if it is ever committed or pushed.

## License

Copyright (c) 2025 Newmark AI. All rights reserved.

Newmark Agent is currently distributed under a proprietary, all-rights-reserved
project license unless separate public release metadata explicitly grants
additional rights. Third-party dependencies and icon assets remain governed by
their own licenses. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
