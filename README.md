<p align="center">
  <img src="SCRIPTS/assets/newmark-agent-social-preview.png" alt="Newmark Agent" width="760">
</p>

<h1 align="center">Newmark Agent</h1>

<p align="center">
  A local-first desktop workspace for multi-model coding, automation, research, and controlled computer operation.
</p>

<p align="center">
  <a href="https://github.com/positer/Newmark-Agent/releases/tag/dev-0.1.2"><img alt="Development" src="https://img.shields.io/badge/development-dev--0.1.2-blue"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Electron%20%2B%20TypeScript-2ea44f">
  <img alt="Status" src="https://img.shields.io/badge/status-development%20preview-orange">
</p>

Newmark Agent brings model routing, persistent workspaces, tools, subagents, workflows, and local state into one desktop application. It is designed for technical users who want to work with their own model providers without sending workspace prompts to an external routing service.

> Newmark Agent is under active development. The current Windows packages are unsigned prerelease builds.

### dev-0.1.2 kernel optimization

The `dev-0.1.2` line turns the source-driven [`bojieli/ai-agent-book`](https://github.com/bojieli/ai-agent-book) audit into measurement-first kernel improvements. The fixed ignored reference remains under `_ref/ai-agent-book` at `fb2afa9f9473ecadf59522adb38def72c0124fe3`; Newmark now adds privacy-safe request-prefix fingerprints and provider cache-token metrics, quantitative tool-provision surface costs, deterministic compression-fidelity scoring, and a unified response trajectory contract for parallel tools, failures, Guide receipts, interruption, terminal events, and final-result uniqueness.

Diagnostics are disabled by default. When explicitly enabled with `NEWMARK_KERNEL_DIAGNOSTICS=1`, they emit only SHA-256-derived fingerprints, counts, estimated tokens, cache-read/write token totals, and ratios; prompt bodies, user messages, tool names/schemas/arguments, credentials, and file contents remain excluded. All 59 callable schemas retain exact on-demand reachability, and deterministic evaluation gates are part of the normal test suite. Design evidence remains in `archive/20260719-222856-dev-0.1.2-ai-agent-book-kernel-study.md`; implementation evidence is in `archive/20260720-dev-0.1.2-kernel-observability-and-evaluation.md`.

The same verification pass stabilizes Windows Computer Use tail latency: advisory screenshot enrichment, explicit UI Automation, and application-window discovery use isolated PowerShell workers; timed-out scripts are not replayed; replacement workers cannot be invalidated by stale process callbacks; and the performance gate now measures 20 desktop plus 20 application samples with P95, hard-maximum, and event-loop-gap limits.

Task continuation is now grounded in an authoritative per-request ledger rather than inferred from chat recency. The provider receives historical Build Blocks newest-to-oldest with only `{ user input, final summary, completion status }`, plus a separate newest-to-oldest unfinished queue. Concrete public work events, Guides, timestamps, and run identity remain behind the read-only `build_history_query` tool and are loaded only when the user asks what specifically happened. Asking whether the previous task completed is explicitly read-only and resolves the newest historical Build even when an older unrelated task remains interrupted; only an explicit continuation instruction authorizes resuming unfinished work.

Context recovery uses a mixed Build bootstrap. The first provider request of each new Build, and the first request after context compression, receive the compacted/current context boundary, the latest 10 Build summaries, explicit continuation state, the complete brief tool catalog, and the names of task-relevant schemas already supplied through the provider-native tools field. Full JSON Schemas are not duplicated into the system prompt, ordinary broker/tool subturns do not repeat the bootstrap, and compression never restores the removed original transcript.

The final local Windows candidate is packaged and installed as `0.1.2.0`. A 2026-07-20 renderer follow-up replaces positional Build/message reconstruction with explicit `runId` ownership, preserves `primaryPrompt` for recovery, and prevents stale new-conversation or background-completion callbacks from taking the foreground conversation back. Reloaded history now reconstructs exactly as user input -> owning Build -> one final answer; a persisted Build can recover missing legacy user/final rows from `primaryPrompt` and `final_response`. The refreshed per-machine MSI and unpacked ZIP are available under the ignored `release/` directory with SHA-256 `28FA8EF4FD7C2DC58946C976CA8E3132A02997DA9493123FB85465CCDE76B3A0` and `CB922DE39E7FC560E0682587A3EC9BB5D7473BED520C4B5104A73D88FBD0162E`. Packaged validation covers the 59-tool broker contract, Build/final-answer ownership, Guide rendering, rapid and out-of-order conversation switching, restart persistence, MSI structure, startup recovery, and Computer Use vision/text separation. One-use Computer Use and image-inspection frames are projected as a protocol-valid tool text result followed by a synchronized user-role visual observation, then removed before persistence or replay. The currently installed Program Files executable still reports `0.1.2.0`; this refreshed package was validated from `release/win-unpacked` without replacing the running installed instance. This is a local release candidate only: no tag, push, or GitHub release has been created.

The plugin surface now opens on MCP Management before Skills Management. User MCP servers support persistent stdio/HTTP registration, editing, enable/disable, removal, JSON validation, and secret-safe listing through `~/.Newmark/MCP.json`; plugin-discovered MCP metadata is shown read-only. GitHub CLI overview refresh no longer runs synchronous child processes on Electron's main thread: bounded async requests fetch account/repository data and parallel selected-repository details, Issues and PRs. The repository card displays viewer Star state, star/fork counts, fork ancestry, permission and subscription. Final packaged UI acceptance kept 324 renderer heartbeats alive during an 8.143-second real GitHub refresh. Current final MSI and ZIP SHA-256 values are `28FA8EF4FD7C2DC58946C976CA8E3132A02997DA9493123FB85465CCDE76B3A0` and `CB922DE39E7FC560E0682587A3EC9BB5D7473BED520C4B5104A73D88FBD0162E`.

The final GitHub/MCP build is installed locally under `C:\Program Files\Newmark Agent`. The installed `app.asar` SHA-256 is `554EDEF834F6B0F169EB0454F8D983B74F5D3A4A0AA59ED7CF1301A14BA4058F`, exactly matching the validated package. The MSI preserved the complete `~/.Newmark` baseline of 17,593 files and 261,930,502 bytes, and the restarted `0.1.2.0` desktop window is responsive.

The latest `dev-0.1.2` durability hotfix prevents a completed conversation from losing its user input and final answer when another conversation starts or a delayed writer persists stale state. Immediate terminal writes cancel their pending snapshots, duplicate Build records merge by event sequence and terminal status, cold runners bind through storage without saving transitional sibling state, and a later empty transcript cannot erase an existing non-empty transcript. The packaged fast-switch test now reads `conversations/state.json` after A completes, after B completes, and after restart, requiring matching user/assistant/Build `runId` values plus `completed`. Final local artifacts are MSI SHA-256 `38E30C6EBD6232578E53051D1D5392300B2BD676A0316426C76DE6E37B0A73BA` and ZIP SHA-256 `DDCB80097C1C588751E8984B1C5DDAC45016A4A7F2728503096F405AE28052F3`. Because UAC elevation was cancelled in the current session, the verified `0.1.2.0` build is active from the user-local installation at `%LOCALAPPDATA%\Programs\Newmark Agent`; its `app.asar` SHA-256 is `DF68D82337C8D1A9B97C5382CF61AA106FABDCD95AC6319BED1248178309AF39` and the window is responsive. No tag, push, or GitHub release was created.

A final new-conversation activation fix separates read-only conversation snapshots from explicit foreground selection. Creating or switching a conversation now calls the dedicated `activateConversation` IPC, atomically persists the workspace `activeConversationId`, waits for that write before rendering the new chat, and leaves background/prewarm snapshots unable to steal foreground state. Verification covers an empty new conversation across a forced application restart in both isolated packaged UI and the real external `Code` workspace. The current Program Files `0.1.2.0` installation matches `app.asar` SHA-256 `6F76A5AD47C16731A0F0AAFC23762A104689FD976E1CAFDF3291B4C254CE6286`; final MSI and ZIP SHA-256 values are `38E1600ACB30D10076BCDFDF723ABAAA2BE760FBF9E777EC5574318E3DEC43B6` and `4C62020F6909452546C6AACB9F9B350D365F8AADB3D59DFFD665D37AC881B4CC`. Linux publication remains stopped and no Git commit, push, tag, or GitHub Release was performed.

The immediate-send follow-up closes the remaining activation race shown by a new chat that accepted input before its activation promise settled. A stale backend conversation list can no longer remove the locally created foreground row, and the new ID becomes the renderer's backend target synchronously while its explicit persistence is still in flight. Packaged acceptance delays activation by 900 ms, sends immediately, forces a deterministic 401, and requires the user input, error Build, active conversation ID, switch-away/switch-back display, and restart state to remain bound to the new conversation. Source verification passed 1212 assertions; the unpacked package `app.asar` SHA-256 is `C9B45F981DF762430FB0AC5E1D5EABEA6F12592A71406EB0D33640A67A66BE81`, and the MSI SHA-256 is `74F8A7D6EA04B880F1E920F56060FE98747FD7FC12CE02F29BB532C8676967C6`. The Program Files reinstall did not complete because the UAC prompt was cancelled, so the installed copy remains on the prior `6F76A5AD...` package. Publication remains stopped.

The context-compression display follow-up corrects historical timestamp reconstruction. Persisted message rows now render their stored timestamps, while rows recovered from a Build snapshot use the Build `startedAt` or final-event timestamp and are explicitly identified as historical records. Old failed runs can no longer appear to have been submitted at the current reload/compression time. Program Files acceptance verified the two real `向我回复1` failures at `2026/7/20 23:58:27` and `23:58:50`, followed by successful `gpt-5.5` replies after midnight. Source verification passed 1213 assertions; installed `app.asar` SHA-256 is `63BC458AF7CE9986795B342323E70D49DB2F1F6A57D9B014536BCD063D1FB1E4`. No publication action resumed.

The completed-reply visibility follow-up fixes transcript ordering when older Build runs have no legacy chat rows. Previously every orphaned historical Build was appended after all persisted messages during terminal redraw, so old failures moved to the bottom and made the latest final response appear to disappear. Orphan runs are now inserted in persisted `workRuns` order before the next message-owned run. The newest completed user -> Build -> final sequence therefore remains at the bottom after completion and restart. Source verification passed 1214 assertions, and the rebuilt unpacked application was checked against the real conversation DOM. MSI installation remains pending because the latest UAC prompt was cancelled; no publication action resumed.

The final `dev-0.1.2` candidate is installed under `C:\Program Files\Newmark Agent`, with installed/package `app.asar` SHA-256 `081882BBB302195C49CAC4BD5CA7ED86E7E7623D365863EBF7BECC59B93E63C4`. Windows MSI/ZIP and Linux AppImage/deb/unpacked-ZIP GUI smokes pass. Release asset hashes are recorded in `archive/20260721-dev-0.1.2-release.md`.

### dev-0.1.1 maintenance release

The `dev-0.1.1` maintenance release adds run-bound Build/final-response adjacency, guaranteed final results for normally completed Build runs, bounded on-demand skill discovery and loading, restart-safe conversation archiving, Memory Lab tag graph v2 with multi-parent paths and legacy migration, temporary provider disable/restore, per-conversation model selection, and per-conversation Guide/Next input-mode memory. Guide is always rendered as a right-aligned user message: collapsed Builds list Guides beneath the primary Build submission, while expanded Builds interleave each Guide at its exact work-event sequence. Tool calls emitted together execute concurrently behind an all-receipts barrier. Persistent terminal takeover, Computer Use takeover, and Browser-Use steps continue after a successful launch/action receipt without waiting for session closure. Memory Lab rebuilds inspect final tag keys, component tags, and every `tagPaths` element so legacy `#A/B/C` results become independent nodes and edges, while hyphens remain inside names. Context compression remains a completed Build activity and resumes the same run before producing its final result. Windows MSI/ZIP packages are validated and installed locally before remote prerelease publication.

The final release also freezes crashed Build timers as interrupted, orders unfinished historical work newest-to-oldest, triggers context compression only at 80% of the active model context window and targets 20%, and lets model validation persist explicit context-window limits returned by provider catalogs.

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

Conversation model choices are persisted per conversation as either Auto intent or a provider/model deployment. A temporarily disabled provider remains visible in Settings, but its models are excluded from routing and selection; re-enabling it restores a preserved conversation preference when available.

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

Skills use progressive disclosure: the initial prompt contains only a bounded relevant metadata shortlist, while the read-only `skill` tool searches the catalog or loads one named `SKILL.md` on demand. Build final replies carry their owning run identity and are merged immediately after that Build block, including after conversation switching and snapshot replay.

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

The 0.1.0 performance line includes merged persistence writes, cached prompt/tool context, Linux-local WSL host bundles, runtime prewarming, and language-aware fenced Markdown code highlighting. Request-scoped task focus keeps the latest real user message authoritative without elevating user text into the system role; explicit unfinished Goal/plan state remains available for genuine continuations, while completed, superseded, and unrelated work stays background context. Context compression now summarizes the whole historical prefix instead of permanently pinning the first user task, classifies unfinished versus completed/background work, and inserts one immediate continuation anchor so compression cannot silently terminate the active task. The Next queue now advances automatically after terminal work events. In light mode, modal surfaces remain transparent while gaining a bright glass glow for readable foreground content.

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
- OpenAI Responses turns request `text/event-stream`, consume text/tool deltas incrementally, and require an explicit `response.completed` terminal event.
- Context compression binds one provider/model deployment snapshot for the full compression request and records the concrete model ID used.
- A successful compression atomically replaces both the active Kernel run context and persisted Kernel state. The detailed resume prompt is request-only, so later tool subturns continue from the compacted history instead of repeatedly compressing the same stale prefix.
- Reload recovery converts persisted `running` Build records from a prior crashed or force-closed runtime to `interrupted` with a frozen end time before rendering, so a new task cannot inherit their live duration. Recompression requires meaningful growth beyond the compacted baseline, and unfinished historical tasks are resumed newest-to-oldest.
- Context compression now uses only the active model context window: it triggers at approximately `80%` of `max_tokens` and compacts toward `20%`; the legacy character threshold no longer causes early compression.
- Model validation reads explicit context-window limits from provider model-list/catalog responses, persists the verified response value into the deployment model configuration, and ignores output-token-only fields.
- The Agent harness rebuilds a non-persistent request-focus contract for every provider/tool subturn. It treats the latest real user-role message as the current instruction, resumes earlier work only when the instruction or explicit unfinished tracker requires continuity, and never copies user-authored prompt text into the higher-priority system block.
- Compression summaries use explicit active/unfinished, completed/background, decisions, verification, and file sections. The first historical user task is no longer retained verbatim forever; a single post-compression system anchor immediately resumes the latest retained real user instruction without copying its text into system role, and recent context still starts at a complete user turn so tool and conversation continuity remain intact.
- Build work appears as a collapsible narrative timeline: public reply text stays readable while repeated commands, file edits, searches, and image inspections are summarized by activity.
- Work review uses theme-aware cards in light and dark modes; opening a changed file shows red read-only deletions and green editable additions in the native editor.
- Context accounting includes structured multimodal payloads; historical base64 images are replaced by bounded records during compression so old attachments cannot keep later requests over provider limits.
- Memory Lab mutations are receipt-gated: update/reindex waits for deterministic index rebuild and read-back verification, returns `rebuildReceipt.completed=true` to the same provider run, and blocks the run from completing when that receipt is absent. The UI reports success only as the in-Build activity `更新了记忆` / `Updated memory`.
- Next handoff is completion-race safe: a queued request is removed only after the next Build synchronously claims the conversation, so terminal/runtime snapshot races cannot drop it; idle Next starts immediately and completed work drains the next item without a timer delay.
- WSL runtimes inherit only explicitly configured `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables (including lowercase forms), so provider traffic follows the host's declared proxy policy without modifying Linux network configuration. Windows runtime cleanup also treats a nonzero process exit time as absent, avoiding stale PID rows during force-stop rescans.
- The GitHub CLI panel uses Newmark list rows for populated and empty states, a rounded themed repository selector, shows `Communicating` only on first entry, keeps the existing page when refreshed data is unchanged, and queues repository selections made while a read is already in flight so the details card cannot drift from the dropdown.
- Build transcripts persist every complete sanitized non-tool provider reply as a distinct public response event. Hidden reasoning remains excluded; live deltas, tool summaries, and Guide receipts stay inside a borderless indented Build ownership line. Completed/error/interrupted runs remain expanded by default but can still be folded manually. User-input headings, content, timeline nodes, and connector lines align on the right.
- Build blocks now contain process only: provider-authored public progress/reasoning summaries, Guide lifecycle, and inline-expandable tool activities. The final Agent answer renders once below the Build block. Tool expansions list sanitized commands/paths/arguments directly under the activity row without creating another card, while raw results, secrets, private call IDs, encrypted reasoning, and hidden chain-of-thought remain excluded.
- OpenAI Chat and Responses tool continuation validates every tool result against a preceding call. Migrated, compressed, or fallback history that retained a Memory Lab result but lost its assistant call envelope is repaired with a minimal same-ID call before submission. Memory Lab read/update/reindex results continue within the same Build turn, allowing the model to inspect, update, verify, and then produce one final response.
- Conversation timeline rails are painted by the complete scrolling conversation surface, so left Agent and right user tracks remain continuous across Build blocks, reviews, Guide insertions, and tall inter-message regions.
- Windows packaging runs a mandatory `afterPack` resource step that writes and verifies the Newmark executable identity and icon before MSI creation, preventing the taskbar from falling back to Electron's default icon.
- Linux release acceptance runs real Bash/sh command round trips, buffer and isolation checks, explicit stops, Linux-native persistent PTY takeover tests, and Windows-to-WSL backend activation/tool/vision regression before asset hashes are accepted.

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
