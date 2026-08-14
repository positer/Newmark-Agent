# DeepSeek Harness Integration

Newmark keeps a shallow local checkout of `deepseek-ai/deepseek-harness` at `_vendor/deepseek-harness` for design and compatibility review. The checkout is intentionally ignored by Git; the source reference is the upstream commit recorded by `git -C _vendor/deepseek-harness log -1`.

## Design Mapping

DSH contributes three reference ideas without becoming a second Newmark runtime:

- The conversation page keeps a resident composer and conversation scrollport. Newmark extends the existing composer with a context inspector instead of mounting a parallel chat tree.
- DSH separates context measurement from compaction. Newmark exposes the active Build budget and long-history budget through `Agent.contextWindow()`, while `maybeCompress()` remains the existing owner of compression and cold-archive persistence.
- DSH composes profiles from ordered bundles and user patch layers. Newmark's DSH discovery returns the ordered `DshConfigLayer` metadata and never evaluates plugin code or dynamic `!!js` values.

## Context Management

The context inspector reads the target-scoped `contextWindow` snapshot. It shows total usage, active-Build usage and trigger, long-history usage and trigger, retention budgets, hot-cache entries, cold-archive entries, and the latest compression result.

The `Compress now` action crosses the same target-specific Electron utility or WSL runtime used by chat. It refuses an active conversation run, forwards the request to `ConversationKernel.compressContext()`, and returns a fresh context snapshot. Displayed `chatMessages` remain unchanged; only model-facing `history` is compacted.

Automatic compression remains conservative and dynamic:

- Active Build pressure uses the 70% trigger and retention budget.
- Long-term history uses the 20% trigger and retention budget.
- Hot cache remains bounded by `context.compression_cache_max`.
- Evicted folds remain in the conversation-isolated append-only cold archive when enabled.

## Plugin Updateability

Newmark treats DSH as a developer-preview integration. The DSH panel is a read-only compatibility and review surface:

- The update channel is `latest` and explicitly not locked, so DSH updates are not hidden behind a stale version pin.
- Profile bundle order, profile patch files, home-level patch files, unknown manifest keys, and unresolved bundle entries remain visible.
- Dynamic endpoint expressions and credential-bearing MCP values are never evaluated or exposed.
- Imported MCP candidates prefill the normal Newmark MCP form disabled; saving is an explicit user action.
- Newmark never installs, executes, updates, or rewrites DSH or plugin files. Official DSH commands remain the write path.

This keeps the integration forward-compatible with developer-preview manifest changes and avoids a Newmark release becoming the update bottleneck for DSH plugins.

## Tool-Layer Concurrency, Inline Tool Calls, and Plugin Semantics

Newmark borrows three tool-layer ideas from DSH without adopting DSH tool runtime code.

### Concurrency-safe tiered scheduling (DSH `isConcurrencySafe`)

DSH classifies each tool call with `isConcurrencySafe(args)` at runtime: only a call whose tool returns `true` may overlap with siblings; every other call is `exclusive` and forms an ordering barrier. Newmark lands the same idea as a static per-tool `concurrencySafe` flag:

- `CONCURRENCY_SAFE_TOOLS` in `DESKTOP/src/core/toolPolicy.ts` lists the deterministic read-only tools (`pwd`, `read`, `glob`, `grep`, `web_search`, `web_fetch`, `git_status`, `file_audit`, `repo_security_audit`), exposed through `isConcurrencySafeTool(name)`.
- `toKernelTools` in `DESKTOP/src/core/agentKernelRunner.ts` stamps `concurrencySafe: isConcurrencySafeTool(name)` on each tool.
- `executeToolCalls` in `DESKTOP/src/core/agentKernel/agent-loop.ts` groups consecutive concurrency-safe calls into one `Promise.all` batch and runs exclusive calls serially as barriers.

Side-effecting tools (`write`, `edit`, `bash`, all `browser_*`, `computer_use`, subagent/orchestration tools, `memory_lab_read`, `git_push`, etc.) stay exclusive, so the previous unconditional `Promise.all` can no longer race mutating tools. The classification is deliberately conservative: anything not on the safe list defaults to exclusive.

### Inline tool-call output bounding (DSH `tool-result-pruner`)

DSH prunes oversized tool results before they re-enter model context. Newmark bounds the inline `toolResult` content returned to the model with `boundInlineToolResult(name, text)` in `agentKernelRunner.ts`:

- `INLINE_TOOL_RESULT_MAX_CHARS = 24000` (~6000 tokens). Oversized plain-text results are truncated to "head conclusion + tail evidence" with a middle-elision marker.
- Structured results (`computer_use`, `browser_use`, `pdf_read`, `image_*`, subagent/`task`/`linked_plan`/`question`) are never truncated — clipping would break their JSON shape — so bounding only applies to the large read/grep/bash-text class.
- Compression-time pruning (`pruneToolResultContent` + `TOOL_RESULT_PRUNE_CHARS = 8000`) runs the same idea on the omitted prefix fed to the summarizer.

### DSH tool-layer plugin semantics

The DSH tool runtime (`@deepseek-ai/dsh-tools`) exposes `defineTool`/`ToolRuntime.register`, runtime `isConcurrencySafe`, and `ToolPresentationMode` (`native`/`code`/`both`). Newmark maps these as read-only metadata on the compatibility snapshot (`DshCompatibilitySnapshot.toolLayer`, produced by `dshToolLayerRuntimeSemantics()` in `dshCompatibility.ts`):

- `register` → `ToolExecutor.execute()` + `compat.legacyToolToNewmark()` + `compat.inferSideEffects()`.
- `concurrency` → `isConcurrencySafeTool()` + `AgentTool.concurrencySafe` + the tiered scheduler.
- `presentation` → Newmark's native tool loop; DSH's `code`-mode batching is absorbed by inline result bounding rather than a separate `run_code` transport.
- `pluginDiscovery` → `compat.discoverPluginManifests()` finds `components.tools`; only OpenCode JS tools execute via `runOpenCodeTool()`/explicit `compat-tool`.

### Breaking-change compatibility layer

DSH is a developer preview whose manifest and tool schema may change incompatibly. Newmark keeps every seam fail-soft:

- `unknownKeys` are retained and surfaced, never rejected or rewritten (`preservesUnknownFields: true`).
- Future or unresolved bundle entries degrade to a count + warning instead of failing discovery.
- Dynamic `!!js` values and credential-bearing MCP endpoints are marked non-importable with a reason, never evaluated or exposed.
- The tool-layer mapping is metadata-only, so a DSH schema change only updates descriptions and never breaks Newmark startup or a running conversation.
- Newmark never imports/executes/updates/rewrites DSH plugin code; official `dsh` commands remain the sole write path.

## Verification

From `DESKTOP/`:

```text
npm.cmd run build
npm.cmd run typecheck
node dist/tests/dshCompatibilityVerify.js
node dist/tests/toolConcurrencyVerify.js
node dist/tests/contextBudgetVerify.js
node dist/tests/contextCompressionApiVerify.js
node dist/tests/verify.js
npm.cmd run release:ui-skills-smoke
```

The full source and package gates remain separate from this integration note. A package rebuild is required before claiming packaged UI evidence for a new renderer change.
