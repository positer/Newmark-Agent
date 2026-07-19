# Agent Task Focus and History Harness — 2026-07-18 19:05 +08:00

## Reported problem

Long Newmark conversations could make Agent work records drift toward older tasks. Older unfinished work must still be resumable when the current instruction continues or depends on it, so the fix cannot simply discard history.

## Public source comparison

- Codex compaction rebuilds replacement history and has an explicit boundary for reinjecting canonical current context before the last real user message during mid-turn compaction: <https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs>.
- OpenCode compaction emits a structured record with Goal, Instructions, Discoveries, Accomplished, and Relevant files/directories; its automatic continuation is an explicit synthetic user message rather than an implicit assumption that every old request remains active: <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts>.
- Claude Code documents persistent project instructions separately from task-specific, path-scoped rules/skills and warns that large or conflicting always-loaded instruction sets reduce adherence: <https://code.claude.com/docs/en/memory>. Claude Code's complete internal harness is not open source, so no private or minified behavior was inferred.

## Root causes

1. `Agent.maybeCompress()` always retained `msgs[0]`. In ordinary conversations this is the first user task, not foundational context, so it survived every compaction verbatim and received disproportionate attention.
2. The compression prompt asked to preserve objectives and pending work without requiring evidence that an old task was still active, completed, superseded, or relevant to the latest retained instruction.
3. Provider subturns had stable global/workspace rules but no explicit request-scoped contract describing how the latest instruction and genuinely unfinished history should interact.
4. Running Build tool-detail DOM was rebuilt both for live events and the one-second duration timer, discarding the native `<details open>` state.

## Changes

- Summarize the entire historical prefix; foundational rules continue to come from the rebuilt system prompt.
- Keep recent context from a complete user-turn boundary and keep the latest instruction verbatim.
- Tell model compression to classify Active Or Unfinished Work, Completed Or Background Work, Decisions And Constraints, Tool And Verification Evidence, and Relevant Files relative to the latest retained instruction.
- Make the local fallback use the same state distinction and retain a bounded historical-image omission record.
- Insert exactly one generic post-compression continuation anchor before the retained user turn. It explicitly resumes the pre-compression active task without copying user-authored text into system role; older work is resumed only when it is unfinished and relevant or required.
- Add a non-persistent request-focus system contract on every provider/tool subturn. It refers to the latest real user-role message without copying user-authored text into the system role. Active Goal and unfinished plan state are summarized only as runtime tracker counts; completed items are excluded.
- Preserve nested tool-detail expansion with stable activity keys. The duration timer updates only the Build title.
- Gate Memory Lab mutations on an awaited deterministic rebuild and read-back receipt. Missing receipts keep the Agent run unfinished/error; successful receipts render only inside the Build block as `更新了记忆`.
- Make Next completion handoff acknowledgement-based: terminal events cannot consume a queued request while the prior send promise is finalizing, and the item is removed only after the new Build synchronously claims its target runtime.
- Forward explicit proxy variables into WSL runtimes, and reject Windows helper rows whose process exit FILETIME is already nonzero.
- Local MSI audit: a stale same-version product was removed with elevation. The final rebuilt MSI was then installed with exit code 0 and `REBOOT=ReallySuppress`; installed and packaged `app.asar` SHA-256 both equal `ABE8430234536F5A63AF650D877C323D0CC20495E5381125322013C71A393113`, and the installed GUI opened responsive.
- Packaged assertion rule: never call external/reveal file routes merely to inspect classification, because that opens Explorer/default applications and can exhaust desktop memory. These classifications remain covered by the side-effect-free `WorkspaceFileRouter` unit suite.

## Verification

- `npm.cmd run typecheck` — pass.
- `node dist/tests/normalChatRegressionVerify.js` — pass, including new-task focus, continuation focus, role-boundary, and non-persistence checks.
- `node dist/tests/verify.js` — 1,167 assertions passed on both final Windows and Linux source builds, including first-task unpinning, one-time continuation anchoring, latest-task retention, state-classified compression, Memory Lab receipts, host-specific Computer Use provisioning, image compaction, proxy inheritance, and model binding.
- `npm.cmd run release:ui-work-review-bars-smoke` — pass; nested tool detail remains open after tool-result reconciliation and a 1.25-second duration refresh.
- Windows ZIP/MSI extraction smokes passed before the final WSL proxy/helper rebuild. Final Windows packaging and CLI smoke passed, and the final MSI was installed locally with exact package-hash equality and a responsive GUI.
- Final Linux AppImage, DEB, and unpacked ZIP GUI/CLI terminal smokes passed. Bash and sh PTYs round-trip independently and are killed on exit.
- Final 20-run Linux benchmark: hot first event P95 13.34 ms, hot first token P95 12 ms, cold local-before-provider 50.69 ms, two provider requests for the tool round, zero hot persistence writes.
- Real APInebula Memory Lab read/create, rebuild receipt, and unavailable-model fallback passed. WSL real-provider traffic remains externally blocked because this host's proxy listens only on Windows loopback and WSL NAT cannot reach it; temporary relay/firewall experiments were fully removed.
- Final release asset SHA-256 values: MSI `fe26f9ae55e04c09a64c0bf8d36afd5d2d599904e813790c6fcd817873a162ed`; Windows ZIP `497f6bc40c27203250a7b2d2f56ec4a6234efdcb7088d7cc2d285518d09c4fb5`; AppImage `c9a4964db0dfdd425115f876c9408c2b090ffa65f7b50257b7324055771d27f3`; DEB `336a0ab37592f59241bee023f51c597115e4cc4d846056c9c33885a39f5eacf7`; Linux ZIP `4148e88a1575aa5bfebea1dd583d3141da6f637f25732e68f6255e87ef3d8055`.

GitHub publication remains blocked until the complete source, Linux/WSL, package, real-provider, and downloaded-asset release gates pass.
