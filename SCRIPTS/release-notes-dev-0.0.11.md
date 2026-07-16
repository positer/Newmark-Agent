# Newmark Agent dev-0.0.11

dev-0.0.11 is a focused Windows prerelease that makes long-running Agent conversations more reliable and lowers tool-schema context cost. It keeps the audited local Auto router and model-validation foundation from dev-0.0.10 while tightening conversation recovery, queue guidance, settings readability, and packaged verification.

## Highlights

- **On-demand tool provisioning.** The model sees a compact description of every callable tool from the first turn, but receives only a bounded set of relevant JSON schemas. It can request exact additional schemas through the local `tool_provision` broker without bypassing mode, platform, workspace, Native Tools, or host policy.
- **All tool boundaries remain discoverable.** The broker advertises names and short capabilities up front, supports exact-name grants and compact search, limits each grant and total active schema surface, and refreshes safely after provider fallback.
- **Queue-to-Guide delivery.** Editable queued messages expose a visible localized Guide action. Text, images, conversation target, and unrelated drafts are preserved. Explicit rejection retries with a fresh request ID; uncertain transport or missing acknowledgements retain the original ID to avoid duplicate delivery.
- **Safer conversation recovery.** Editing an earlier user message rewinds to that exact persisted user-message identity across direct, Electron Utility, and WSL runtimes.
- **Reliable ordinary chat.** The first prompt resolves a usable deployment before provider invocation, fallback refreshes model context and tools, meaningful errors remain visible, and a failed empty assistant response is not persisted.
- **Theme-consistent controls.** Settings actions, focus and disabled states, hover feedback, and the terminal timeout number stepper use separate semantic dark/light colors and native color-scheme integration.
- **Theme-aware code editing.** The native editor, gutter, syntax tokens, caret, selection, inline prediction, and completion surface switch together between measured dark and light palettes.
- **Fresh workspace and conversation switching.** Switching an older built-in workspace or conversation reloads its current persisted snapshot instead of writing a stale in-memory copy back over it.
- **Consistent review actions.** File-change rows use Newmark's compact semantic button treatment instead of the operating system's default white control.
- **Existing foundations retained.** Auto remains a one-model-per-turn local router with global/provider scopes, auditable decisions, Standard validation eligibility, bounded fallback, preference learning, and no external cloud-router dependency.

## Compatibility and privacy

- Mutable state, credentials, route data, validation evidence, and learned preferences remain under `~/.Newmark`.
- Tool catalog descriptions contain boundaries only. Tool arguments, file contents, prompts, credentials, and broker internals are not added to route audit logs.
- Backend-managed queue snapshots remain read-only mirrors; dev-0.0.11 does not simulate unsafe client-side promotion.
- This release does not rerun the real OpenAI-Hub Anthropic smoke. The completed three-call evidence from dev-0.0.10 remains authoritative; ordinary tests use the offline protocol contract.
- Windows artifacts are unsigned and may show an unknown-publisher warning. Linux remains on dev-0.0.9 and must not be relabeled as dev-0.0.11.

## Validation

The release gate includes TypeScript type checking, lint, the complete 1,114-assertion core suite, the dev-0.0.10 compatibility feature suite, queue/Guide regression tests, all 57 tool-provision reachability checks, Auto and Validation Service suites, CLI contracts, ten Windows ComputerUse scenarios, ZIP/MSI artifact extraction, packaged feature inspection, and real packaged UI smoke for queue, layout, editor themes, settings, and ordinary Agent chat.

## Windows assets

The prerelease contains exactly two Windows x64 artifacts:

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `Newmark-Agent-0.0.11-x64.msi` | 105.54 MiB | `77F3CFE8FC17C7E175EB06CD9A37F6659B34FA7DBE043F4FBE2AB4977AB7E46E` |
| `Newmark-Agent-0.0.11-win-unpacked-x64.zip` | 135.21 MiB | `22ECE27A54C7EA0C8BBD0C7CEB69E96740A5149D4682B626B6DF784195F700BE` |
