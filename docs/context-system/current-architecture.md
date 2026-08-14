# Newmark dev-0.3.0 — Current Architecture Investigation

> Required by the dev-0.3.0 implementation guide, Section 2. This document records
> the current (dev-0.2.6) context, agent, provider, and tool-exposure architecture
> before any dev-0.3.0 change. It is the single source of truth for the coupling map.

## 1. Source Layout

The application is an Electron desktop + CLI + TUI application. All model-facing
code lives under `DESKTOP/src`.

| Area | Location |
| --- | --- |
| Electron main process / IPC | `DESKTOP/src/main.ts` |
| Renderer preload bridge | `DESKTOP/src/preload.ts` |
| CLI entry | `DESKTOP/src/cli.ts`, `cli-commands.ts`, `cli-editor.ts` |
| Server mode | `DESKTOP/src/server.ts` |
| Agent facade + state | `DESKTOP/src/core/agent.ts` (7.1k lines) |
| Agent kernel runner | `DESKTOP/src/core/agentKernelRunner.ts` (1.9k lines) |
| Native agent kernel | `DESKTOP/src/core/agentKernel/` (agent-loop.ts, agent.ts, event-stream.ts, stream-types.ts) |
| Conversation manager | `DESKTOP/src/core/conversationKernel.ts` |
| Provider boundary | `DESKTOP/src/llm/provider.ts` (1.7k lines) |
| Tool executor | `DESKTOP/src/tools/index.ts` (1.9k lines) |
| Tool policy | `DESKTOP/src/core/toolPolicy.ts` |
| Config | `DESKTOP/src/core/config.ts` |
| Tests | `DESKTOP/src/tests/verify.ts` (5.2k lines) + per-feature verify files |

There is **no** existing `src/context/`, `src/providers/`, `src/toolchain/`,
`src/agent-runtime/`, or `src/subagent-runtime/` directory. dev-0.3.0 will add
them as new modules layered onto the existing code.

## 2. Current Context Call Chain

```
UI (index.html) -> preload -> main.ts (agent:send)
   -> ConversationKernel.prompt()
      -> Agent.process() / Agent.prompt()
         -> runAgentKernel(agent)            [agentKernelRunner.ts]
            -> new NativeAgent({ streamFn, transformContext, resolveTools })
               -> kernel.prompt()
                  -> runAgentLoop -> streamFn(model, context)
                     -> streamWithNewmarkProvider()
                        -> provider.chatStreamWithTools(...)   [llm/provider.ts]
```

### 2.1 Prompt assembly (existing "system prompt")

`Agent.buildSystemPrompt()` in `agent.ts:6509` assembles a single string:

1. `CORE_SYSTEM_PROMPT` (a static constant at `agent.ts:306`).
2. `## Current Working Directory`.
3. Subagent sandbox block (only for subagent runtimes).
4. `buildFeatureDisclosurePrompt()` — workspace binding, permissions, mode engine, skills, etc.
5. Plan tool policy (only in plan mode).
6. Linked Plan markdown.
7. Global Agent.md + workspace agent.md + custom prompt.
8. Enabled skills.
9. Ultra orchestrator role.
10. `buildModePrompt()`.

This is cached by an `identity` string (`systemPromptCache`). The identity includes
cwd, mode, conversationId, subagent, linkedPlanRevision, goal, prompt mode, custom
prompt, language, permission, option feedback, model, intelligence, skills, and the
global/workspace prompt bodies — so it is mostly stable across turns but does embed
dynamic data.

`agentKernelRunner.runAgentKernel` appends `initialToolSurface.systemPromptNotice`
and then, per provider subturn, `buildRequestTaskFocus(...)` + `buildBuildContextBootstrap(...)`
which injects the conversation task ledger, tool catalog, and compression bootstrap.

### 2.2 Where the "context window" and token estimation live

- `Agent.estimateContextTokens(messages)` — `agent.ts:3761`: character-count/4 estimate.
- `Agent.contextWindow(modelName)` — `agent.ts:3770`: returns `{estimatedTokens, maxTokens, ratio, warning}`. This is what the renderer reads via `getState`.
- `transformContext` — `agentKernelRunner.ts:658`: only runs when `context.auto_compress` config is true, calls `agent.maybeCompress(...)`.

### 2.3 Message persistence

`StoredConversationState` in `agent.ts:132` persists per conversation:
`chatMessages`, `history` (LLM-facing), `plan`, `linkedPlan`, `subagentState`,
`workRuns`, `continuations`, model selection, flow selection, input mode, mode,
goal, branches/tree, and `draft`.

Persistence is file-based under `~/.Newmark/Work/<workspace>/...`. There is no
database. `workspaceConversations` is an in-memory Map keyed by
`internal|external:<path>::conversation:<id>`.

### 2.4 Build Block / Work Run (current)

`ConversationWorkRun` in `types.ts:122`:
`{ runId, target, runtimeKey, status, startedAt, endedAt, expanded, sequence, events, guides, primaryPrompt, branchNodeId, anchorMessageId, flow }`.

`AgentWorkEvent` in `types.ts:96` is the public event record. `Agent.workRuns` is an
in-memory list, persisted inside `StoredConversationState.workRuns`. There is **no**
separate append-only Build History file, no revision counter, no operationId, no
content hash, and no checkpoint+delta compression — those are dev-0.3.0 additions.

### 2.5 Plan / Task (current)

- `LinkedPlanState { markdown, revision }` (`agent.ts:259`) — has a revision counter and `linked_plan` tool with expectedRevision update. This is the closest existing analog to the guide's structured plan, but it is a Markdown document, not a structured object.
- `ConversationPlanState { items: ConversationPlanItem[] }` (`agent.ts:248`) — `{id, text, status: pending|in_progress|done}`. No versioning / optimistic concurrency.
- There is **no** structured Task List with `expectedVersion`.

### 2.6 Tool result storage

Tool results flow through the kernel as `toolResult` messages, persisted into
`agent.history` and `StoredConversationState.history`. Large outputs are not
lifecycle-managed; they are kept inline. There is no `ToolResultRecord` with
lifecycle (`ephemeral`/`build_scoped`/`conversation_scoped`/`persistent_reference`).

## 3. Current Tool Exposure Call Chain

```
routeToolSurface(agent, catalog)   [agentKernelRunner.ts:1205]
   -> selectTaskToolDefinitions(task, catalog)  (intent-slice up to 8)
   -> append subagent orchestration core
   -> ToolProvisionSession.reconcile(catalog, surface)
      -> currentDefinitions() = initial(<=8) + provisioned(<=16) + broker(tool_provision)
   -> refreshToolSurface() caches per toolSurfaceIdentityForAgent
```

Key current mechanisms (all in `agentKernelRunner.ts`):

- `tool_provision` broker tool — the Agent can search (`query`) and provision exact names in batches of up to 8, up to 3 broker calls, up to 16 provisioned.
- `INITIAL_TOOL_SCHEMA_LIMIT = 8`.
- `SUBAGENT_CORE_TOOL_NAMES` — always retained.
- `cachedToolDefinitions()` in `agent.ts:6593` — policy-filtered catalog with identity cache.
- `ToolProvisionSession.metrics()` — estimated tokens for catalog/active/broker.

### 3.1 Missing vs the guide's four-layer model

| Guide layer | Current state |
| --- | --- |
| 1. Capability Boundary Summary | Missing — the broker embeds the full compact catalog in one tool description. |
| 2. Active Toolset Manifest | Missing — there is no per-turn manifest; tools are listed implicitly. |
| 3. Capability Catalog Slice | Partial — `selectTaskToolDefinitions` does intent slicing, but the model cannot discover *unloaded* capabilities by ID. |
| 4. On-demand Tool Schema | Partial — `tool_provision` implements this but is a raw name/query broker, not capability-oriented. |

## 4. Provider Boundary (current)

`LLMProvider` in `llm/provider.ts` is a single monolith class implementing:

- Protocol detection: `openai` | `anthropic` | `github_models`.
- Chat Completions path: `chatStreamWithTools` -> `openAIChatWithTools` (SSE) / `openAIChatWithToolsNodeFallback`.
- Responses path: `openAIResponsesWithTools` (SSE) / `openAIResponsesChat`.
- Anthropic path: `anthropicChatWithTools`.
- Headers, retry-after extraction, 402/balance handling, `probeStreamCompletion`, `chatStrictJson`, image generation, model catalog.

There is **no** unified `ModelProviderAdapter` interface. Chat Completions and
Responses logic is interleaved in one class with many `if` branches
(`shouldUseResponsesFallback`, `openAITransportMode`), contrary to the guide's
requirement of separate adapters. Usage is normalized by
`extractProviderUsage` in `core/agentKernelDiagnostics.ts`.

## 5. Agent Run / SubAgent (current)

- The `Agent` facade has a `status: AgentStatus = 'idle' | 'working' | 'error' | 'goal_paused'`.
- `ConversationKernel` tracks `running`, `stopRequested`, runId, generation, and supports graceful/force stop with checkpointing.
- SubAgents: `SubagentManager` (`core/subagent.ts`), `task`/`subagent_*` tools, peer work events (`emitPeerWorkEvent`), and `AgentRuntimeOptions.subagent` for isolated runtimes.
- There is **no** persisted `AgentRun` state machine with statuses like `preparing_context` / `waiting_tools` / `checkpointing` / `paused` / `recovering`. Stop is cooperative + force, not a resume-able persisted run. No lease acquisition.

## 6. Frontend / backend token binding (current)

- The renderer reads `contextWindow` from `getState`/`conversation snapshot` (`main.ts:1595`, `main.ts:2863`).
- Token estimation is a backend-computed character/4 approximation, but there is **no** `ContextUsageSnapshot` object, no snapshot id, no `contentHash` binding, and no per-section usage. The renderer trusts `contextWindow` without a hash check. Frontend does not itself estimate, so the "single source of truth" is already backend, but the dev-0.3.0 snapshot contract (snapshotId + hash + revision + frontend revision guard) does not exist.

## 7. Existing recovery / retry mechanisms

- `runWithCompressionResume` — retries a kernel subturn after compression.
- `runAgentKernel` route retry loop — `switchToFallbackModel`, `routeRetries < 2`.
- 402 balance cooldown — `providerBalanceBlockedUntilByDeployment`.
- Conversation stop: graceful (`stopCheckpointed`) / force.
- Flow suspension persistence — `FlowSuspensionRecord` + paused takeover.
- `probeStreamCompletion` — rejects truncated SSE.
- No tool exposure session recovery, no lease expiry, no `unknown` outcome marking.

## 8. Testing / build tooling

- Build: `npm run build` (tsc + several `scripts/build-*.cjs`).
- Typecheck: `npm run typecheck`.
- Lint: `npm run lint` (`oxlint src`).
- Tests: `npm test` -> `test:full-release` -> `test:desktop:built` runs
  `dist/tests/verify.js` plus 30+ per-feature verify files, then TUI/SSH/WSL/CLI/shared-backend gates.
- New tests must be added to `scripts.test:desktop:built` in `package.json`.

## 9. Planned dev-0.3.0 Change Scope

New modules (feature-flagged, default off, rolled out per P0→P3):

1. `src/context/` — domain types, deterministic serializer, Build History repository (append-only JSONL + operationId idempotency + checkpoint/delta), Plan/Task repository (expectedVersion), Context Orchestrator (fixed order + stable prefix hash), Context Budget Service (ContextUsageSnapshot), Tool Result lifecycle.
2. `src/providers/` — `ModelProviderAdapter` base + `ChatCompletionsAdapter` + `ResponsesAdapter` + headers/events/retry normalization.
3. `src/toolchain/` — Tool Registry, Capability Catalog, Capability Boundary Summary, base toolset, Active Toolset Manifest, exposure planner, on-demand schema loader, permission service.
4. `src/agent-runtime/` — persisted AgentRun state machine + lease.
5. `src/subagent-runtime/` — SubAgent context package + capability ceiling.
6. Feature flags in `config.ts` (`contextFeatureFlags`), wired with `structuredContextV2` etc.
7. Minimal integration points: `Agent.buildSystemPrompt`/`runAgentKernel` optionally assemble through the Orchestrator; `getState` optionally returns a `ContextUsageSnapshot`; `LLMProvider` logic optionally routed through adapters.

## 10. High-Risk Coupling Points

- `agent.ts` `buildSystemPrompt()` — any reordering changes model behavior and many `verify.js` source assertions reference the prompt contract.
- `agentKernelRunner.ts` `routeToolSurface`/`ToolProvisionSession` — `toolProvisioningVerify.ts` asserts exact catalog/broker surface; changes must remain backwards compatible.
- `llm/provider.ts` — `intelligenceTierVerify`, `normalChatRegressionVerify`, `openAIHubAnthropicSmokeContractVerify`, `providerIdentityVerify` assert request shapes.
- `StoredConversationState` — persistence shape is asserted by `verify.ts`, `normalChatRegressionVerify`, `runtimeIsolationVerify`, `conversationBranchStressVerify`.
- `ConversationWorkRun` / `AgentWorkEvent` — `guideWorkRunVerify`, `queueAttachmentIsolationVerify`, TUI renderers depend on the shape.

## 11. Compatibility & Migration Risk

- All new paths are behind feature flags that default off, so old behavior remains the default in migration phase 1.
- The `contextSystemV2Verify`/`providerAdapterV2Verify`/`agentRuntimeV2Verify`/`subagentRuntimeV2Verify`/`toolchainExposureV2Verify` tests are standalone and do not touch old paths.
- Version bump: `package.json` 0.2.6 → 0.3.0, README badge, `VERSION_INFO` protocol constants.
