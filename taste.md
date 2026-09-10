# Newmark Agent Project Taste

## 2026-09-10 Queued turns must appear in the conversation when they enter

- A queued turn that actually enters the conversation is user input and must appear in the transcript. The kernel persists it, so the renderer must refresh from the authoritative snapshot when it observes a queue drain: no optimistic bubble exists for background drains, and no send receipt will arrive.
- Detect the drain from the authoritative `queueItems` id set (never by text), then debounce per target across the moments when the user message and the assistant reply land. Only refresh the foreground conversation and only while no renderer send is in flight, so send receipts and drain refreshes cannot fight.
- Refresh by reading the snapshot and re-rendering (`syncWorkRunsSnapshot` + `hydrateConversationBranchState` + `cacheConversationMessages` + `renderChatMessages`). Never add a second write path just to paint a bubble.
- Terminal run events (`done`/`error`/`interrupted`/`force_interrupted`) also refresh, so the drained turn's reply lands in the same transcript.
- Queue rows that have *not* entered still belong only to the queue panel; do not paint them inline.

## 2026-09-10 Blocked queue repair and timeline display rules

- A failed admitted Build blocks its successors by design (`claimBuild` only accepts a parent that is the committed frontier). Never make failure silently skip a parent. Blockage must instead be *derived* from the parent chain on every read, so rows admitted after the failure are also reported as blocked (`waitingReason: DEPENDENCY_FAILED`) instead of silently sitting in the queue.
- Provide an explicit, auditable escape hatch: `repair_blocked` re-anchors blocked rows to the last committed Build, keeps queue order, and writes one `BuildQueueRepaired` event per re-anchor. Keep it user-triggered (queue-panel button); resume alone must not rebase anything.
- The UI must surface the reason: `setQueueItemsForTarget` keeps `waitingReason`/`blocked`, blocked rows carry `data-queue-blocked`, and the queue header shows the repair button while blocked rows exist.
- Queued input that has not entered the conversation is only shown in the queue panel. Do not paint queued rows into the transcript (no inline "queued" user bubbles).
- A Guide appears in the timeline only after the kernel accepts it, at its acceptance position. Optimistic/awaiting-ack, deferred and rejected Guides stay out of the conversation area.

## 2026-09-10 Branch page identity, queue visibility and read-only Guides

- One branch identity rule for every kind of branch: user pagination edits and the experimental branch-communication `branch_create` go through `Agent.branchConversation`, so both must mint a brand-new node id (`assertFreshBranchIdentity`) and share `branchConversationIdentity(conversationId, branchNodeId)` = `<conversationId>::branch:<branchNodeId>`. Never derive a branch identity from the branch that happens to be active or viewed at request time.
- Provider session sequence ids are per branch tree: bind the request to the Build's owning branch (`activeWorkRunBranchId`), never to the conversation's current runtime branch. A concurrent sibling branch or a page switched mid-Build must not reuse another branch's remote session.
- Local continuation and history lookup follow the branch node tree: folded compression history is scoped by the branch node (`compressionArchiveScopeKey` + `CompressionCacheEntry.branchNodeId`, merged on persist), and renderer caches key messages / Build lists by the branch node. Sibling pages must never read each other's transcript or folded history.
- Queue rows stay visible while their execution stays captured: the queue panel lists every row of the conversation (never filtered by the running branch), newly accepted rows auto-expand it, and rows bound to another page are marked as waiting instead of being hidden or silently rebound. `rebindQueueToRuntimeBranch` may refresh the runtime key but must never rewrite the admitted `branchPath`.
- A queued user turn is user input: it is rendered inline as a user bubble with a queued badge on its own page, deduplicated against the real message by `clientMessageId`. Do not keep queued input only inside a collapsed panel.
- Creating a page must not wipe the local queue projection. The authoritative refresh happens when its owning page becomes active again; the new branch's kernel projection stays empty.
- Guides are read-only records in the timeline: one-click copy only, no inline edit. Editing a historical Guide is removed; Guide delivery semantics (inline intervention of the current Build, newest-first cross-Build, no auto-resume) are unchanged.
- Page pagination must anchor on the edited user input even when that input is rendered as a Build card without `data-message-id`: resolve the anchor by `message_id`, then rendered message index, then anchor text before giving up.
- Do not change the existing preview/runtime separation contract while fixing rendering: a new branch never drains another branch's queue, and viewing a sibling page never reroutes queued input or Guides into it.

## 2026-09-09 Conversation identity, queue ownership and cache isolation

- A queued user turn owns its exact `targetRuntimeKey`, `workspaceKey`, `branchNodeId`, `branchPath` and `modelSelection` from the moment it is accepted. Persist them with the continuation; never resolve the target or branch from the current view at drain time. A mismatch pauses the queue and keeps the row; it never reroutes into the foreground conversation.
- A Next item is a new user Build in the same conversation: after the previous Build fully settles it starts a new runId, restores the captured branch, and appends a normal user turn. A Guide is an intervention in the current Build and stays inline. Do not inline-drain Next into the previous run, and never carry the completed runId into the new turn.
- Provider-side session caches are mutable remote state. When `provider_session_id` is enabled, the identity is branch-scoped (`conversationId::branch:<branchId>`); sibling branches must not share a remote session. Retry/attempt-level session epochs remain a separate Gate until the storage fence exists.
- Every model request records its owning `branchId` and a SHA-256 `contextHash` of the actual submitted model/system/messages/tools payload. The hash is diagnostic evidence, not an ACL or a substitute for the parent-chain context resolver.
- Normal replies carry no client-side output cap. Omit `max_tokens`/`max_output_tokens` unless an auxiliary request explicitly needs a short completion; protocols that require a positive value resolve one internally. A provider-owned budget exhaustion is resumable progress, never a silent success; preserve the partial answer and mark the run incomplete.
- The first-turn title/model-availability gate must publish a visible status immediately and fail fast on deterministic 4xx provider rejections. Include the actual provider/model in the error. Do not turn a wrong-provider binding into five identical retries.
- Conversation model binding is provider-qualified end to end: activation snapshots restore the conversation's remembered deployment, explicit renderer changes carry a monotonic revision, and the send binds the visible model to the exact target after activation. A bare or ambiguous model name must never guess another provider's credentials.
- All continuation admission goes through `GuardedContinuationStore`. The in-memory `pendingNextTurn` list is only a projection of the workspace ledger; a command is accepted only after the CAS/idempotency transaction commits. Never mutate the projection first and repair the ledger later.
- Admitted builds have immutable `parentBuildId`. Reordering admitted queue rows is rejected (`ANCHOR_NOT_COMMITTED`); changing the order requires explicit cancel plus new commands. Do not silently rebase successors to the previous successful node.
- Branch fences are monotonic high-water marks. Lease recovery, completion and cancellation release the active attempt without resetting the fence; the next claim increments it. Old attempts' heartbeat/final writes must be rejected as `STALE_EXECUTION`, not applied.
- PC GUI and the hosted mobile API share the same command/kernel/store path. Android local conversations still use `LocalQueueContract`, which is per-conversation FIFO and starts a new run per Next; it is not yet a ledger participant and must not be described as one.
- A Flow or any external owner run must be represented by a ledger build/attempt before it can act as a parent. Do not let an external run advance only in-memory history while a queued Goal/Next build points at a parent that never commits; that produces a permanently blocked authoritative queue. The remaining Flow/Goal external-build wiring is a release blocker until `test-shared-conversation-commands.cjs` passes.

## 2026-09-09 Explicit provider output exhaustion

- A Responses incomplete status with reason max_output_tokens is resumable partial progress, never a successful completion or generic network retry. Retain text/reasoning, discard incomplete tool calls, and preserve all other terminal error rules.
- Local Agent continuation uses a request-only checkpoint and at most three additional requests, doubling the output budget up to 131072. Do not persist synthetic user prompts or replay tools. A terminal repeated budget exhaustion must not be labeled completed. This supersedes the old thought-only continuation restriction.

## 2026-09-09 Title reasoning budgets

- Short title length is a prompt/output normalization constraint, not a tiny completion budget. PC and Android title requests retain the frozen deployment and native reasoning tier and inherit its normal output budget. This supersedes the prior fixed 64-token primary and 1024-token metadata limits.
- Image metadata fallback remains text-only and uses the ordinary low-tier budget. Do not silently switch models, expose reasoning as the title, bypass cancellation/storage barriers, or interpret a simulated reasoning-budget fixture as live provider verification.

## 2026-09-09 Provider text delta identity

- Do not apply prefix/content deduplication to protocol text deltas: repeated words, whitespace and literal null text are valid content. Complete message/done snapshots reconcile only against their own output item and content part. Replayed snapshots are not another delta.
- Preserve whitespace-only text through both provider callbacks and UI batching. Responses output_text is an alias of the structured output, never an extra message. Do not repair persisted history by deleting repeated text heuristically.

## 2026-09-09 Conversation runtime border

- Local runtime indicators come from the live per-conversation runtime registry, never persisted history or only the selected conversation. Remote running/stopping/force_restarting states match PC.
- Runtime capsules use a 2dp black/white/black/white sweep with a 3-second linear period. Rotate only the shader on a fixed capsule path; read animation state during drawing, not list composition. Disable the animation when idle or covered/lifted by conversation glass. Preserve menu haptics and static Goal/queue controls.

## 2026-09-09 Free search admission

- Prefer the admitted official Exa keyless HTTP search, then You.com free-profile search. Android uses the same direct endpoints before the optional paired-PC pool. Preserve explicit user endpoint overrides and full enabled-pool traversal; do not infer unlimited availability from a free tier.
- Remote MCP must use the same configured proxy transport as ordinary web tools. Allow only verified search schema fields; extra discovery, crawling, agent and command tools remain outside web_search. A successful handshake alone is not search admission.
- Keep live results and network limitations in the archive. The 2026-09-09 samples support Exa's higher priority; they do not establish universal relevance or uptime. The optional Ignidor scraper is disabled by default after repeated tools/call timeouts.

## 2026-09-09 Responsive image navigation and math boundaries

- Never serialize/fsync conversation snapshots or decode full camera bitmaps on the Compose thread. Serialize writes on IO, coalesce pending state, and stream JSON on both read and write rather than allocating full JSON and UTF-8 copies. A title must await durable storage and rebase over intervening edits before publishing. Save jobs share the foreground runtime lifetime so Activity/ViewModel disposal cannot discard final state.
- Preview decoding uses bounds and a bounded sample size on Default; it must not alter the image sent to the model. Cancellation must prevent a departed preview from publishing into another target.
- A released, unmoved long hold on a local or remote conversation capsule emits system LongPress haptics when opening its menu. Drag/cancel and ordinary click do not emit that menu feedback. Goal/queue static action rules remain unchanged.
- Display math delimiters can touch prose or span lines. Protect fenced and inline code from normalization; do not mistake a cases row spacing command for a new formula. Use the pinned native RaTeX engine for inline/display layout with background parsing and offline fonts. Preserve row boundaries in the readable fallback, cap layout dimensions, and retain dependency/font notices in assets.

## 2026-09-09 Image-first title recovery

- An image-first title failure gets a text-only metadata retry using the same frozen provider/model, low reasoning and a separate 1024-token output allowance. Never pass image payloads to this auxiliary retry or change the formal turn's configuration/attachments.
- If both title attempts fail, use a neutral image-analysis title and the existing durable-save/stale-target barrier. User cancellation and storage failure are never converted to success. This is the image-first exception to the original generated-title requirement below; plain-text first turns retain their existing policy.

## 2026-09-08 Markdown code and visual evidence

- Each fenced code block owns its copy action. Copy the block's raw code only, preserving whitespace and special characters; never include the language label, button text or surrounding reply. Keep the toolbar visible while code scrolls horizontally.
- Reserve readable space beside both conversation timeline rails. Code cards and their actions use existing theme tokens and must not collide with the opposite role's rail in narrow layouts.
- Mobile Goal and queue action buttons are static, borderless icons. Keep click behavior and semantic labels, with no glass surface, ripple, pressed color, lift or scaling. State changes from the submitted action still update the icon normally.
- Validate screenshots against actual viewport dimensions and active window ownership. An ignored rotation request, system ANR overlay or unfinished compositor frame is diagnostic evidence, not a visual pass. Keep failures and pressure thresholds visible in the report.

## 2026-09-08 Cross-platform visual consistency

- Shared navigation and action glyphs use the existing PC Lucide family: 24-unit viewport, 2-unit strokes, round caps and joins. Preserve mobile touch targets and semantic labels. Generate additions from installed lucide-static SVGs with sync-mobile-navigation-icons.cjs; never approximate them with filled Material icons.
- Match opaque primary/secondary/tertiary text tokens across PC and Android: dark F2F2F2/CECECE/949494, light 0A0A1A/1A1A2E/6A7090. Do not make mobile helper text depend on a translucent black token over varying glass backgrounds.
- Neutral Material container colors and transparent surfaceTint apply in both themes. Ordinary PC hover surfaces use control-hover-bg; danger and selected states retain their own semantics. Shared visual language does not require identical desktop and mobile control measurements.
- Verify actual dual-theme screenshots and control layout, alongside cross-platform token and upstream icon checks. Keep glass motion, pointer capture, callbacks and composer geometry intact during icon/color consistency work.

## 2026-09-08 Mobile theme ownership

- Resolve persisted app theme before the first Compose frame. A manual override owns both app colors and system-bar icon appearance; only the null preference follows system configuration.
- MaterialTheme alone does not provide LocalContentColor. Supply the selected onSurface color inside the theme root so bare icons and IconButtons inherit it, while semantic per-control tints remain local.
- Reapply system-bar appearance on composition commit and lifecycle resume, resolve wrapped Activity contexts, and dispose lifecycle observers. Verify both theme directions using rendered icon pixels and actual window appearance flags.

- Windows MSI release work uses synchronized semantic versions, completes the full release gate before packaging, records the MSI SHA-256, and verifies both uninstall-registry and installed executable versions. For elevated silent installation, resolve literal absolute paths and pass one explicitly quoted argument line to `Start-Process`/`msiexec.exe`; keep `/quiet /norestart` and a verbose archive log.
- Keep only the current deliverable set in `release/` and `APK/`. Historical release binaries and unpacked package trees may be removed from `archive/`, while textual reports, logs, screenshots, test data, conversations, and other non-release evidence remain cold archival material.

- Development releases use tag/title `dev-X.Y.Z` / `Newmark Agent dev-X.Y.Z`, numeric package version X.Y.Z, synchronized Android versionCode, and the established six Windows/Linux/Android assets. Release notes contain complete English then complete Simplified Chinese, version-local changes, measured validation and asset hashes. Never substitute auto-generated notes for the reviewed bilingual body. Preserve the existing Android signing certificate across release updates.

## 2026-09-07 Observations never disable model communication

- Provider headers and editable endpoints are outside the vertical glass gesture rail. Keep the vertical rail below the horizontal protocol rail. Persist endpoint drafts only after explicit valid HTTP(S) save, preserving provider identity, credentials and model settings.
- Serialize builds within each platform: never rewrite Desktop dist during ASAR packaging or launch concurrent Gradle packaging against one intermediate directory. Keep failed candidates separate from verified delivery artifacts.

- Keep provider-qualified deployment identity through snapshot, request, idle selection and persistence. A legacy bare-name echo may reuse a known binding; an unbound ambiguous name must never guess another provider's credentials.
- User `enabled` is independent of response health. Only explicit user switches hide configured models. Missing/failed/expired capability probes, balance warnings and health circuits never exclude later requests or strip image/tool inputs.
- Record actual response outcomes per deployment and facet. A text-only success cannot heal failed vision; one successful image response heals vision immediately. Cancellation is not model failure. Atomic diagnostic receipts must contain no credentials, payloads or raw server errors and must never break communication.
- Send attached images first. Only actual visual rejection triggers built-in OCR and conservative text correction; preserve the user task, uncertainty and recovered answer in conversation history. Retry images normally in subsequent turns. Current-request fallback avoids revisiting failed deployments without persisting a request-blocking blacklist.
- Click toggles once; confirmed drag uses the released track endpoint; cancellation retains state. Keep the glass material visible through endpoint movement and landing. Visual stretch must not move the center anchor. PC switches share the existing optical renderer and Android tests measure after graphics transforms.
- Reasoning tokens count against title completion budgets. Keep semantic titles short without a 64-token transport cap that repeatedly truncates a valid provider and prevents the first dialogue.
- These rules supersede earlier Standard-only model visibility/capability gates and switch release rules that removed the lens before movement completed. Preserve user scope/privacy/budget policies and already-published release identities.


## 2026-09-07 Conversation reorder continuity and portrait overflow

- A keyed pointer-input node can outlive the list order captured by its callbacks. Refresh gesture callbacks with rememberUpdatedState without restarting an owned pointer. Memoized local function references must also read the current conversation snapshot; remove the dragged ID itself on commit instead of removing a cached index. Test a first-to-last move followed by a second hold that reverses above its new origin, for both local and remote rows.
- Drawer material owns its clipping on a background sibling. Do not wrap conversation floats in a Material Surface that clips all children. Preserve the drawer width, window insets and outer navigation gesture owner.
- Conversation lenses retain the full 28dp horizontal envelope. Their center displacement is half the previous value at every frame: 1dp times lift plus 7dp times horizontal expansion, reaching 8dp at full lift. The left anchor compensates half of the original rightward growth. Both terms return to zero at source and destination color blocks. This supersedes the earlier 2dp right-edge-anchor rule.

## 2026-09-07 dev-0.5.15 release identity

- Bind release assets to the verified source commit and version, retaining separate byte hashes for locally built and CI artifacts. Fresh CI Android runners generate a different default debug keystore unless an existing signing identity is restored; never replace an upgrade-compatible local APK with a CI APK merely because its version matches.
- A dev tag also triggers the existing npm publishing workflow. Candidate workflow dispatches build platform artifacts without a public release; final tag/release publication is a separate verified operation. Preserve already published assets, and compare all six remote downloads with the approved local asset set.
- When a packaged gate enforces an obsolete contract, retain the failed run and prove current behavior against the exact artifact before changing the fixture. Explicit mailbox reactivation must pass `wakeup:true`; public correlation IDs must be paired and scoped rather than blanket-banned. Test-only/notes commits may follow the build commit only with a complete production-input delta and asset-hash binding.
- Keep isolated Windows fixture paths short enough for MSI and Chromium. Preserve previous screenshots; redirect new evidence into the current run's owned archive. Promote the owned renderer before demanding foreground readiness, without weakening the readiness predicate. Preserve unknown failure causes instead of treating a successful rerun as proof of diagnosis.

## 2026-09-07 Peer continuity and communication cache

- New mailbox messages default to `wakeup=false`. A stopped receiver stores them without activation; an active receiver accepts both flags normally. Persist whether peer mail was accepted while active so settlement and cold loading cannot lose its continuation intent. Legacy persisted messages without this field retain their prior wake behavior. Explicit close and the user stop gate remain authoritative.
- The sender owns communication content: default to the last visible text-history entry, or choose summary/text/tool selections with explicit ranges. A summary is supplied by the sender; never launch another model to compose it. Preserve complete tool call/result pairs and actual payload bytes. Do not recursively remove legitimate business fields named metadata, system or analysis from a selected tool result. Reject an oversized selection instead of silently truncating evidence.
- Passive mail changes only the mailbox. Append received content at the execution boundary; never pre-insert messages into another peer's history. Keep system, catalog and cache snapshots independent of wake flags, changing mailbox counts and selected content. List peers through a bounded summary projection.
- Retire only provenance-marked automatic settlement messages for the exact peer/result revision after the complete result and its internal receipt have been durably saved. Remove matching unconsumed native, hosted and persisted queue copies; preserve manual messages, newer results and existing history.
- User stop broadcasts a distinct non-waking control receipt to every non-closed peer in the targeted conversation before cancellation. Stop controls must never become future model prompts. Both cooperative and forced stop are scoped to the exact conversation/runtime and current run; another conversation's providers, tools, scheduler and caches must remain live.
- WSL force termination uses boot/start identity and kernel pidfds, including descendants that created their own process groups. Keep the worker alive until its supervisor captures the tree. Never fall back to bare PID/PGID signals after an identity check, and never report unconfirmed cleanup as success. Missing capabilities or interrupted capture must retain an error and quarantine across client/pool cleanup paths; helper cleanup must release processes it paused when termination is denied.
- A peer has one executor at a time. Mailbox wakeup records intent once, and dispatch assembles the unread batch once. Working, settled and restored peers share the same mailbox path; compatibility APIs must not bypass it.
- A read receipt must persist together with either the exact dispatched input or its committed working history. Once input is committed, cold recovery uses a continuation marker and preserves completed tool results. Keep a committed user message even when the first provider reply has not arrived.
- Persist peer history at actual message/tool boundaries, skipping saves when history and compression are unchanged. Never write every streaming delta. Clone nested tool calls and metadata so returned snapshots cannot mutate live context.
- Peer request metadata and supplied tool order survive mailbox jobs and cold loading through a deployment, policy, catalog, protocol and compression identity. Restore schemas only through the current authorized catalog; stored cache names cannot grant permissions. Keep task-dependent diagnostics stable on the peer assignment.
- Root Build provider caches remain Build-scoped. A separately owned peer provider cache may span that peer's jobs with full configuration invalidation, independent per-peer slots, bounded idle retention and close cleanup. Never serialize provider objects, credentials or HTTP pools.
- Ultra roots assign independent responsibilities, file boundaries, dependencies and acceptance checks while retaining useful local work. Ultra specialists complete their own assignment and only delegate an independent subset when useful; avoid chains that simply forward the same task.
- Prefer reusing a peer and concise addressed communication about new evidence, dependencies, blockers and actionable corrections. Do not fill concurrency slots with redundant assignments or send repeated unchanged status messages.
- Report model-directed delegation separately from harness-directed concurrency, and upstream cache usage separately from client prefix invariants. Private broker turns remain excluded from public durable history; the first persistence boundary after provisioning may change that message segment, while supplied schemas remain available.

## 2026-09-06 Build continuity and protocol compatibility

- Preserve already published partial text across interruption/error and cold loading, as an incomplete response boundary. Buffer by run only until the corresponding completed response; do not write every delta to disk, release a private broker preface, fabricate a final answer or alter model history to preserve display.
- Recovery classifies every outcome in one loop, including outcomes after a route transition. Empty and reasoning-only replies share a bounded no-progress allowance; completed useful tool/text progress resets it. Neither alternating failure classes nor fallback may create an unbounded loop.
- Distinguish the current request's replay boundary from the whole Build's deployment-switch boundary. A transient request failure before its text/tool envelope may retry once with the exact existing history and deployment; never replay completed tools, received partial output, authentication errors or invalid requests to improve apparent availability.
- All retry delays are owned by the originating Build's cancellation signal. Respect Retry-After and automatic retry budgets; never shorten server-directed waits or allow a stopped owner to launch a later request.
- Protocol completion is explicit. EOF, error/incomplete payloads and partial tool parameters cannot be promoted to success. Validate the complete tool batch before dispatch, preserve call IDs and already delivered usage, and retain legitimate JSON and streaming compatibility.
- Request construction preserves configured gateway prefixes, queries, authentication families and supported version headers. Match Accept to stream/JSON; do not guess a different credential or emit fake empty authentication. Response rate-limit header families have different reset units; normalize their actual semantics and keep HTTP cache metadata separate from LLM token cache accounting.
- Coalesced text retains original event boundaries so snapshots and live batches can overlap without guessing by text. Late stop/snapshot/activation responses are scoped to target, load generation and Build progress; fresh authoritative deletion still works. Preserve toolCallId in live and cold projections to distinguish same-name tools.

## 2026-09-06 Context inspector measurement contract

- Provider spend and local context estimates have different provenance. Preserve explicit zero, missing reporting and legacy unknown coverage; never silently turn missing usage into a measured zero percent.
- Aggregate cache read by token-weighted measured input, not by averaging per-request percentages. Show a whole-conversation ratio only when coverage is complete; identify the denominator of any reported subset. Keep request handles so cumulative/partial stream updates do not double count.
- Bind usage callbacks to their original conversation/workspace. A late response must update both the durable entry and any pending same-store snapshot without discarding another conversation's pending changes. Keep measured counts on branch/rewind/archive; these actions do not refund consumed tokens.
- Context composition is estimated from the actual submitted request while running; system and active tool schemas count alongside long and Build history. Capture input ownership after the existing title/start gate has assigned a run ID. Preserve role/content/schema ordering and the cache-stable prefix. Never move the title gate to fix metrics.
- Label local component estimates and image-token limitations. Do not derive a supposedly measured Build/history split by scaling to server input totals. Keep the latest measured main-request input separate from auxiliary title/compaction usage and current idle history.
- Context refreshes must respect target, load generation and snapshot revision. Opening the inspector may request one coalesced refresh; do not add per-token polling. Size only this inspector to the available viewport and allow internal scrolling, preserving existing glass interaction.

## 2026-09-06 Build request reuse and cache acceptance

- The client preserves stable eligible prefixes and reports measured usage. Server-side zero cached tokens are an observation, not a failure condition or a reason to retry completed work.
- Reuse a provider only through a caller-owned Build cache whose identity covers deployment, credentials, protocol/API mode, thinking configuration and effective proxy. Invalidate on change; never keep the slot globally or on Agent across Builds. Preserve unscoped and forced-provider semantics.
- Same-deployment recovery retains initialized system/tool order even after a Guide. Actual capability/deployment changes still refresh disclosure and permissions. Do not freeze live permission checks to improve cacheability.
- Expensive diagnostic serialization/hashing requires a current subscriber or enabled log. Keep direct inspection and usage accounting available, and allow subscription changes mid-Build. Measure this local work separately from model latency and upstream cache hits.

## 2026-09-06 Build cache prefix and list corner consistency

- A Build's request-only task ledger and tool-awareness metadata are initialized once and retained byte-for-byte from its first provider call onward. Never remove that block after the first tool result or regenerate it from changing task counts. New Builds initialize fresh snapshots; Guides and tool results retain their original roles and append to the input.
- On-demand native tool provisioning keeps all prior schemas, including the broker, in order and appends newly granted schemas. Preserve the compact initial surface and all permission checks. Adding a schema, explicitly compressing context, or consuming a transient image changes the provider input; do not claim complete upstream cache reuse across those changes without measurement.
- Cache acceptance is Build-scoped and uses actual per-request provider usage. A stable prefix is a client invariant, not a guarantee of upstream cache availability; never synthesize cached-token counts or retry completed model/tool work to chase cache hits.
- PC model, generic select and conversation-action list shells share a 25px corner token for both border and clipping. The standard 34px option capsule has a 17px radius plus 7px inset and 1px rim. Preserve row capsules, selection travel, tracks, 4px feedback, 80ms hold, padding and material; do not change non-list dialogs to enforce this list-only rule.
- Outward PC pull follows its direction vector, not a centered uniform scale. Only force-facing edges extend; the opposite contour and its unaffected corners stay anchored. Reuse the existing bounded 4px magnitude and 120ms return with per-side direction coefficients. Reversing direction must not retain expansion on the former side. Press contraction, the actual scroll container, text geometry and selection-track logic remain unchanged.

## 2026-09-06 Long history and measured usage ownership

- History, local context estimates and measured provider usage are separate data. Preserve full message content, identity and timestamps through persistence; normalization may add default fields without changing the transcript. Do not equate raw object serialization differences with lost messages.
- Store measured provider totals and the last usage under the conversation, with an optional versioned schema. New or legacy conversations without recorded usage start empty. Switching targets, runtime ownership and archive recovery must not leak or duplicate another conversation's counters; editing or branching text does not refund already spent usage.
- Parse actual Responses input_tokens_details and Chat prompt_tokens_details, including cache reads and writes, and retain compatible aliases without classifying a read as a write. A local estimate, saved history, faster response or simulated usage is not proof of an upstream cache hit.
- Every asynchronous UI writer validates its workspace/conversation and loading generation on both success and failure. A->B->A still invalidates old requests. Pagination also validates its captured cursor; a global in-flight context request must schedule the latest target's pending refresh instead of dropping it.
- Pass history windows to the actual runtime owner and retain its absolute cursors; never window an already-windowed snapshot again. An explicit before:0 means an empty page, while an omitted cursor means latest. Custom older pages must not overwrite the runtime pool's latest-state cache. Check delayed UI writes immediately upon release as well as after settling.
- Report real cache observations with provider/model and workload boundaries. Keep request prefixes and credential-free fingerprints for comparisons; never claim an upstream cache policy or all-turn hit guarantee from fixture tests.

## 2026-09-06 PC popup 4px limit and 80ms hold — current parameters

- The current PC popup edge deformation budget is 4 CSS pixels per edge. This supersedes the earlier 8px budget below; keep historical package and installation evidence unchanged. The existing 0.4 press ratio gives 1.6px vertical contraction and 0.384px horizontal contraction; a fully blocked outward pull can use the full 4px budget.
- The current PC long-press drag activation delay is 80ms, replacing the former 300ms delay in existing timed hold paths. Keep these paths consistent. Do not change animation duration, editor debounce or settling deadlines, and do not introduce a delay into controls that already activate from movement distance alone.
- Preserve pointer phases, track constraints, initial selection anchor, travel and commit logic, CSS material, opacity and layout. Press starts immediately and clears when hold pickup starts. These PC changes do not modify Android thresholds or elasticity.
- Validate the actual packaged surface throughout press, hold, pull and release, in both themes and across popup sizes. A source constant or successful build alone is not evidence of the rendered maximum; package verification is distinct from an MSI installation.

## 2026-09-06 Shared conversation commands and dual-client queue

- Keep authentication and transport adapters distinct from command semantics. IPC, browser and paired mobile commands resolve the same workspace/conversation owner, queue and visible mode; never add a mobile-only execution policy on PC.
- Queue identity is target plus stable item ID, never text or a mutable global display index. Preserve requested mode, Goal objective, images and creation time across edits and reorders. Resolve DOM actions against current identity after background updates.
- Ordinary user message identity is separate from Guide identity. Accept-before-consume is an observed Agent event, not a resolved Promise. Unaccepted failure restores the same manageable item and pauses; accepted failure must not replay the request.
- Flow, queue, history and archive operations must share one retained owner. Keep provisional Flow-start cancellation separate from idle backend snapshots, and prevent old asynchronous completion from clearing a newer command.
- A composer draft belongs to its conversation and revision. Clear only the submitted revision after explicit acceptance; preserve selection/composition, new typing and rejected edits. Reorder against the latest complete authoritative ID set, including an item being edited.
- Workspace directory notifications update membership and metadata without making either client follow the other's selected conversation. Conversation state events and workspace directory events have separate scope guards.
- A package build is not user-flow acceptance. Keep failed candidate evidence, verify source-to-package and installed APK identity, exercise real paired clients, and investigate observed unresponsiveness before claiming stability. A successful restart alone is not a hang fix.

## 2026-09-06 Model request lifetime and measured renderer updates

- A title probe must retain its final failure category without echoing raw provider bodies, credentials or URLs. Keep request identity, retry count, cancellation and the first-turn gate intact. A later empty title replaces an earlier HTTP failure; a user stop is neither provider failure nor local persistence failure.
- In-memory title assignment is not a persistence barrier. Save the complete candidate snapshot successfully before publishing that title or opening the formal first turn. Active conversation saves return an explicit result, use a same-directory staged write and replacement, and retain the prior snapshot when writing fails. Never delete the prior file as a fallback for a failed rename; validate actual replacement on Android, not a Windows assumption. Ordinary save failures also need a fixed local error message.
- A real-provider test must distinguish explicit upstream errors from client timeouts and cross-conversation leakage. Only the current target and a new matching run may terminate the wait; historical failures cannot. Register passive startup diagnostics before waiting for socket readiness, then keep the promoted-main-UI gate immediately ahead of all UI operations.

- SSE is a continuous byte stream, not a sequence of independent network chunks. Preserve UTF-8 and CR/LF state across chunks, accept the optional space after `data:`, combine multiple data fields, and dispatch at event boundaries. Cover every split position and single-byte chunks with real parser behavior, including Chinese and emoji.
- Protocol success or failure ends the model request without waiting for HTTP EOF. Cancellation and early consumer return must cancel owned readers/responses and remove listeners. EOF alone is not a successful Responses terminal and must not manufacture an empty-response retry or replay already published model/tool activity.
- Model POSTs, both SSE and complete JSON, use the request-local dispatcher wrapper to suppress hidden Undici headers/body deadlines. Preserve the chosen proxy delegate, connection-establishment policy, explicit application deadlines, model discovery GETs and unrelated fetch behavior. Do not change the global dispatcher or introduce retries to conceal a transport-lifetime bug.
- JSON request ownership lasts until the body is consumed, not merely until headers arrive. Keep parent cancellation and any explicit total deadline attached through body decoding; release timers/listeners on completion and failure, and close a blocked body when cancelled.
- Android `CancellableHttpExchange` owns one structured IO worker and its active OkHttp call across response headers, body consumption and subsequent call registration. Parent cancellation must close a silent read promptly, including cancellation in the registration gap. Desktop-link SSE uses the same lifetime bridge without changing generation guards, reconnection policy or event batching.
- First-title requests on both platforms use normal provider read policy and the current run's cancellation owner. Do not add a separate 15-second deadline or detach the title as a sibling of the stopped run. Keep the title-first persistence gate, frozen deployment/native reasoning, first-message identity, manual-title priority and existing empty-title retry limit; stopping during retry backoff must release ownership without another model request.
- Renderer caches must represent exact displayed content and all rendering inputs, including language, live/terminal state and partial Markdown context. A stable ID or equal text length is insufficient. Reuse unchanged Guide/image nodes; when a run ends, restore terminal Markdown even if the text did not change. Write row attributes and HTML only when their actual values change.
- Performance claims require a reproducible workload and artifact identity. Record DOM mutations as well as timings, preserve functional content checks, and compare source previews separately from final unpack/installed binaries. The current 500-row/30-refresh source measurement is evidence for that workload only; do not extrapolate it to streaming throughput, all user flows or delivered packages. Use fresh isolated roots and owned process cleanup while preserving the user's running app and data.

## 2026-09-06 Neutral dark surfaces and sidebar materials

- Dark canvases, carriers, editor surfaces and ordinary text use neutral gray RGB channels: canvas #101010, raised layers #181818/#222222/#292929/#303030/#383838, labels #f2f2f2/#cecece/#949494. Keep functional accents, status colors, syntax highlighting and optical edge dispersion. Apply the same palette to startup shells, independent viewer windows, native select menus and Material surface containers; a shared token change must not leave a separate blue-black fallback.
- Palette work preserves geometry, opacity, blur and interaction timing. Light-theme values retain their existing palette. Wide layouts must paint the app canvas beneath transparent reserved sidebar slots; translucent panel material must not expose a platform window background.
- Right sidebar paging uses flat semantic fills while idle. Only its shared moving float owns interaction glass, and fixed icons render above that float. Its backdrop records the carrier plane only; sampling foreground glyphs produces a refracted duplicate underneath translucent text even when z-order is correct. Preserve the original alpha when modulating any button fill; Color.Transparent must remain transparent and accentSoft must remain distinct from its accent-colored icon. Verify idle, held and landed pixels in both themes, plus the complete wide-layout carrier against the actual app canvas.

## 2026-09-06 Mobile physical contact and popup content

- A floating glass surface follows its constrained rail; contact light follows the actual finger. Record the original pointer's window-space position before pickup, and reproject it into the current float at draw time. Never substitute a thumb center, clamp the light origin to the rail, or expect a newly created float to receive the original down event.
- Read position, lift and velocity geometry in the surface draw callback so layer-only movement remaps a stationary contact. Keep the existing shape-clipped surface pass and 66dp radius. Retain the final contact through landing; a completed float must not clear a newer press.
- Mobile float drag uses one short, frame-rate-independent follower (55ms time constant), without overshoot. Raw pointer coordinates still own track constraints, target selection and reorder. Release stops the follower and transfers its displayed value into the original travel-then-contract sequence. High-frequency velocity reads belong in the layer phase, not whole-page composition.
- Conversation lenses grow toward the right of the source capsule, with a 2dp lifted offset that returns to zero on landing. Anchor their oversized layout explicitly at TopStart with unbounded measurement; requiredWidth must not silently center overflow inside the sidebar and add another leftward offset. Preserve both click and reorder color endpoints, the full 28dp horizontal envelope, and actual rendering beyond the panel's right edge. Test local and remote conversations separately.
- A dragged row changes its own local coordinate frame. Compute each held pointer delta from the current event's position and previousPosition, which share that frame; subtracting a cached local position invents an opposite drag when the row moves, including on release. Keep physical movement separate from the carrier's display damping.
- Mobile popups share a real Compose graphics layer between material and all contents. Place their non-consuming pointer observer outside that transform, so feedback does not change its own input coordinate frame. A graph popup may disable pan displacement while keeping press response; its graph gestures remain unconsumed. This supersedes earlier mobile popup-only-optics instructions. Ordinary buttons and independent rail labels retain their prior content behavior.
- Pixel tests must discriminate the previous failure: off-axis finger light, stationary finger during carrier travel, damped drag, and popup content motion. A failed capture is an infrastructure diagnostic, not proof of the rendering bug. Keep source-contract updates tied to confirmed behavior.
- Android instrumentation may disable hardware drawing. Whole-window visual fixtures must explicitly enable HardwareRendererCompat for their lifetime and restore its prior state; use frame-committed PixelCopy and verify a known baseline pixel before comparing the effect. A changing blank/old display can fool a relative pixel comparison. Inspect the resulting PNGs before accepting a passing visual gate.

## MSI reboot-queue and authoring verification

- Exact installed files and a working GUI do not close an upgrade while historical `PendingFileRenameOperations` can delete or replace those files. Verify the target queue before installation and again after payload verification; preserve unrelated pairs, including their ordering and empty destinations, and check writes for concurrent changes and readback errors.
- Normalize supported NT and legacy `*1\??\` prefixes before a directory-boundary comparison. Never match a product name anywhere in an arbitrary path or clean another application's pending operations.
- Keep PowerShell source out of MSI Formatted command text. Use static encoded scripts and native working-directory arguments. Resolve old roots from related registered products and their executable components; ambiguous or missing roots fail explicitly.
- A checked immediate action stops old registered processes before `RemoveExistingProducts`; it is not assumed to hold an administrator token. A checked deferred action handles machine-level queue cleanup after `CreateFolders` and before `InstallFiles`. Preserve legal major-upgrade sequencing and confirm process exit before proceeding.
- Native authoring tests must start from the production template's declarations. A Type 34 reference to a standard directory still requires its Directory-table row; insert `SystemFolder` under `TARGETDIR` only when absent. Test real MSI tables and `MsiFormatRecord`, initially absent custom paths, literal Unicode/punctuation and explicit failure paths.
- During an installer-only repack, compare every payload file with the verified build and record the exact allowed delta. Preserve rejected intermediate packages as rejected evidence; promote only the final verified MSI to the standard release path.
- Capture Windows build/test stdout and stderr as native byte streams and persist the child's actual exit code. Windows PowerShell 5 can promote deliberate negative-test stderr into a terminating `NativeCommandError` under `ErrorActionPreference=Stop`; a wrapper error is neither a recorded npm failure nor a recorded npm success. Preserve the failed wrapper evidence, fix the recorder, and obtain an explicit final gate result.

## APK repeat packaging evidence

- When Android inputs are unchanged, Gradle may correctly report the release artifact up-to-date. Record the current build gate, source hashes, APK identity and clipboard readback; disclose byte identity with the previous artifact. Reuse device results only when their recorded APK SHA-256 matches exactly, and distinguish reused evidence from a fresh device run. Keep each packaging receipt in its own timestamped archive.

## 2026-09-06 PC material and scrollport rules — latest rendering decisions

- PC popup surfaces are uniform translucent frost. Remove baked blue/pink light planes and broad top-to-bottom shading; real backdrop blur and a narrow neutral rim provide depth. Theme and glass-opacity preferences continue to govern the material. The latest popup-only alpha factor is 0.82 (0.5576 at the default preference); preserve the shared alpha/blur mapping for other surfaces.
- The current PC popup selection movement is accepted. Preserve its geometry, thresholds, timing, rail constraint, selection commit and travel/landing logic. Pointer down compresses the shell immediately and remains pressed until the existing 300ms hold transition starts the selected block's pickup; that transition starts elastic recovery, then only a constrained outward pull expands the optics. Drag release returns to rest without another press. A previous click's delayed reset must not clear a new active press. `liquid-block-lifted` is a state marker only; every stage inherits the same color-block fill and outline, without a glass plate, backdrop filter, glow or elevated shadow.
- A scrolling popup is its own scroll container. An absolute pseudo-element or canvas inserted inside it scrolls with the options. Render the list shell rim and touch light in the scrollport background/inset shadow and disable those scrolling decoration layers. Do not compensate with per-scroll JavaScript, transform the content, or alter option offsets.
- Mouse light remains zero. Touch light remains visible inside the carrier boundary; disabling all light is not a scroll fix. Verify stationary shell pixels across trusted wheel events in both themes, plus uniform pixels on a flat backdrop and a visible response to changed real backdrops.
- Source/UI verification does not update an installed MSI. Keep source-preview status separate from packaged/installed artifact identity.

## 2026-09-05 Recovery rules — supersede earlier glass/install notes

- Reproduce a reported crash using the delivered artifact and preserve its exception before changing renderer behavior. Source-string checks and successful builds do not prove geometry, clipping, animation order or installation state.
- Sampling lens shapes must be `CornerBasedShape`; never wrap a lens in an arbitrary inset `Shape`. Expand the visible outline itself. Provider rails share a centered 12dp-per-edge optical envelope; preserve layout, hit targets and label pixels.
- Join actual lift and travel animations before contraction. Cancel superseded jobs; release resumes the current frame, reaches the destination, contracts, then commits exactly once. A delay or `yield()` is not evidence that another animation finished.
- Clip backdrop, surface and front optical draw passes explicitly. Child layout clipping alone does not clip a preceding `onDrawSurface`. New floating nodes drive light from their animation lifecycle because they did not observe the initiating pointer down.
- Mobile touch light uses a 66dp radius and remains inside the glass. Active button elevation survives until its entire optical animation ends. Transform optics independently of real content.
- Desktop mouse glow is disabled in every renderer path, including CSS and residual canvas alpha. Touch glow remains enabled. Retain refraction, material edge highlights and frame-coalesced rendering.
- Desktop feedback is bounded by 8 CSS pixels at an edge, per the latest direction correction. An outward held pull grows the actual frosted surface; a click shrinks inward. Positive clip insets are contraction and must never be accepted as proof of outward growth. Use one optical material layer during outward feedback, below the original content and outside its scroll container; do not scale text or stack two frosted fills. Full pull can use the entire budget. Track movement is axis constrained; only blocked directions receive elastic boundary feedback. Text and carrier layout remain fixed. Verify actual material pixels outside the original box, release direction and focus-loss cleanup.
- Use the shared MSI workflow for GUI, CLI and manual installation. Avoid shell-joined installer paths; call native MSI APIs from one prepared elevated worker. Fresh ProductCodes must not receive reinstall flags. Retry only the documented busy result 1618; invalid arguments 1639 must fail with diagnostics.
- Installation success requires complete logs, exact installed payload hashes, ProductCode/PackageCode/version and shortcut targets, then installed CLI/normal-user GUI verification. Version `0.5.15` alone cannot distinguish cumulative builds. Preserve `.Newmark` user data and never substitute a per-user install for the authorized machine upgrade.

## 2026-09-05 Desktop glass performance

- Pointer-driven optical effects must be frame-coalesced; never draw a popup canvas synchronously for every pointer event.
- Liquid glass retains chromatic edge hints and bounded shadows; mouse interaction glow is disabled by the later recovery rules above.
- Reduced-motion and compact viewport fallbacks are part of the desktop material system.

## 2026-09-04 交互泛光必须属于承载玻璃 surface

- PC 弹窗的交互泛光画布必须是 `.liquid-glass-popup` 内部 z-index 0 的 surface pass，普通混合模式、由弹窗自身 `overflow/clip-path` 裁剪，内容子树位于其上；禁止使用页面/视口级 Canvas 或 `mix-blend-mode: screen` 顶层合成伪装绑定。
- 动态创建的弹窗必须通过统一 MutationObserver 自动挂载光学画布，不能只覆盖初始 DOM。
- PC 活动浮块的可见 Canvas 也必须首子节点化并置于 z-index 0，携带内容显式位于 z-index 1；泛光坐标必须参与 surface 重绘缓存键，不能因几何未变而冻结在旧指针位置。
- 弹窗选中色块属于同一承载 surface 的底层 pass，必须保持 `position:absolute; z-index:0`，不能被通用内容层规则提升或参与布局。
- Android 泛光必须在 `drawBackdrop` 的 `onDrawSurface`/承载 RenderNode 内合成；`drawWithContent` 追加在玻璃节点之后的光效不再符合“压入底层玻璃”语义。弹窗外部状态仍经 `layerBlock` 进入同一 RenderNode。

## dev-0.5.15 双端弹窗、会话恢复与玻璃 token 准则

- 移动端本地会话追踪是持久状态：新建、切换、归档和冷启动加载都调用 `saveActiveId`，禁止让 `currentId` 只存在 Activity/ViewModel 内存中；本地 Agent 运行中的根返回应先 `moveTaskToBack(true)`，不能销毁活动任务。
- 弹窗是统一液态表面：Android 使用 `liquidPopupShell`，PC 使用 `.liquid-glass-popup`；设置等大弹窗内动态生成的 nested 选择弹窗也必须复用同一 class 和同一交互。弹窗内选项内容是静态的，不创建顶层玻璃浮块，也不随指针移动；点击其他选项时专用色块先平滑移动到新选项、到位后立即执行变更，不等待额外落地；长按 300ms 后色块从原选项跟踪长按位置，弹窗承载玻璃同步做微量弹性缩放，只有轨道末端或不可拖动时弹窗壳才轻度响应，普通点按/拖动响应只施加于弹窗壳；关闭动画必须收缩回发起锚点。普通非玻璃底按钮/菜单的玻璃浮块组件保留，禁止全局误删。
- 玻璃边带厚度是系统 token：供应商横向/纵向浮块必须共用 `ProviderRailInteractionGlassEdge = MobileInteractionGlassEdge + 2.dp`，高光、折射、色散同步增厚；左侧栏浮块抬起右移 3dp 时起终点仍落在色块。
- 图标颜色走主题语义色，不写死为暗色图标色。发送/停止/Guide 图标使用 `p.textPrimary`，修复“亮色模式仍显示暗色图标”一类回归。
- 视觉/弹窗验收不能只靠源码断言：本轮只声明构建、JVM 与 PC `test:desktop:built` 证据；真机/设备截图、安装态冒烟和完整 `test:full-release` 未执行时不得声称通过。

## dev-0.5.14 时序与下载工具准则

- 首次标题不是 Build 的尾随装饰：必须先独立生成、持久化并向当前 UI 发布元数据，再启动首次正式 Agent provider 请求；标题事件不进入 WorkRun 或模型历史。
- Guide 和队列是会话内核拥有的有序数据，不允许桌面 renderer 私存一个移动端不可见的平行队列。缺失序号的兼容数据必须按相邻权威事件/时间定位，禁止使用 `0` 或 `MAX_VALUE` 偷懒置顶/置底。
- 拖拽反馈必须在越过目标行中点时实时产生避让；落点使用同一中点判定，视觉目标与提交给内核的 id 顺序必须一致。
- `web_catch` 是会写本地文件的高级能力：基础 prompt 只声明存在，PC 完整 schema 经 `tool_provision`；Android 不使用 `tool_provision`，在本地 Build/Goal 直接暴露完整 schema。Plan/Chat 均不暴露或执行。每个 URL（包括重定向和组件资源）都要重新做公网校验，下载有上限，默认不覆盖，并采用临时文件后原子落盘。
- 模型与网页工具必须共享同一代理语义：`proxy.enabled/url/auth` 生效，或未显式禁用且存在 `HTTPS_PROXY/HTTP_PROXY` 时，Chat/Responses/Anthropic/GitHub Models/模型探测、编辑补全和 `web_*` 都走 `undici.ProxyAgent`；`Agent.providerProxyConfig()` 未配置时必须保留 `enabled=undefined`，不能误传 `false` 屏蔽系统环境代理；显式禁用配置优先，回环地址不代理。
- Android 的网络可用性不能只信 `NET_CAPABILITY_VALIDATED` 回调：`TRANSPORT_VPN` 必须直接可用，且等待恢复时先做实际状态检查，避免代理/VPN 已通但后台仍空等；API 29+ 使用 `WIFI_MODE_FULL_LOW_LATENCY` 维持后台低时延。
- web 工具的活动文案按语义打 tag：`web_search` 是“搜索了网页”，`web_fetch` 与 `web_catch` 是“抓取了网页”；PC 与移动端的分组和行标签保持一致，不把网页调用并成普通命令。
- `image_display` 的证据不是工具页装饰：同一份已校验 `displayImage` 必须在 PC GUI、PC TUI 与移动端 Build 过程之外，再次按 `sequence → timestamp → id` 顺序出现在最终 Agent 回复正文之前；不得改写模型历史，也不得用最终回复文本代替图片。

## Release artifact traceability

- 同版本累计修复的最终产物必须从当前源码重新构建，并以源码时间、构建日志、包内版本、签名和 SHA-256 共同证明；同版本旧包不能因版本号相同而冒充最新候选。
- 被占用的标准输出不得通过结束未知进程或覆盖旧包解决。使用项目定义的隔离输出，并把隔离源与唯一命名交付副本做字节哈希一致性校验。
- APK 交付必须同时核对 `apksigner`、`aapt badging`、二进制 Manifest、zipalign、启动冒烟和开发者路径/凭据扫描。模拟器安装启动、真机交互、后台长运行和生产签名是不同证据层级，报告时不得互相替代。

## Search MCP boundary

- `web_search` 的 MCP 兼容层只执行可证明为公开网络搜索的工具。工具名/描述、字符串查询字段和安全参数集合必须同时通过；任何 command/path/file/script/code/header/body/method 等能力都拒绝。
- 每个调用重新读取安装者本地 `user/.Newmark/search-mcp.json` 并完成本轮所有启用节点检查。健康文件是当轮原子覆盖的可观测快照，不是持久熔断器；旧失败不得令下一轮跳过节点。
- 固定容灾顺序是 MCP 池、Bing HTTP、DuckDuckGo HTTP。前置条件缺失或未完成真实 tools/call 的候选保持禁用，不能仅因握手成功宣称可用。
- 移动端借用已配对 PC 执行 stdio MCP 时，只能调用 Bearer 认证的 MCP-only bridge；PC 自身的 Bing/DuckDuckGo HTTP 退路不得嵌套进移动 MCP 池。所有桌面/移动 MCP 完整轮询后，Android 外层才进入 Bing，最终 DuckDuckGo。
- 发行公开面不得暴露 stdio command/args/cwd、header/env 值、开发者本地路径或无限 MCP 输出；安装者运行时配置路径可按其本机实际位置展示。
- Android Search MCP 准入必须在清单写入前通过设备网络栈完成 initialize、tools/list、tools/call，并取得至少一个公网 HTTP(S) URL。设备验收同时覆盖 Streamable HTTP 与 Legacy SSE；只暴露非搜索工具或开放危险 schema 的服务必须在 tools/call 前拒绝。

## Runtime vision, timeout, and partial snapshots

- Agent 自行查看工作区图片时复用既有视觉工具和一次性模型输入通道；只允许活动工作区内经过真实路径、格式、字节与像素预算校验的文件，禁止把 base64 写入公开工具结果或 durable history。
- 复合读取工具的内部超时属于工具级可恢复结果。子操作可以被有界取消，但不得借用父级 Abort 把后续模型响应一并吞掉；用户显式停止仍保持真正的整轮中断语义。
- 长运行局部快照是 patch，不是完整替换。缺失 `chatMessages` 表示“未提供”，绝不等价于空数组；只有显式完整空历史才能清空可读对话投影。
- 发行应用可在运行时展示安装者本机路径，但发行源码、演示数据、脚本默认值和打包资源不得烘焙开发者机器用户名或绝对地址。

## Queue visibility boundary

队列中的真实用户输入必须在用户消息时间线可见。出队时不得把带稳定 clientMessageId 的用户项标记为 hiddenUserInput；只有无用户身份的内部自动续接才允许隐藏。

## Compression and recent visual input

上下文压缩只折叠长期历史图片；压缩后近期窗口中的每一条用户图片都必须可继续提供给视觉模型，连续图片输入不能因“只保留最后一张”而丢失。

## Product and interaction principles

- Mobile provider transport is provider-owned persisted state, not a global or inferred runtime toggle. Every manual, imported, and edited provider must preserve an explicit canonical protocol (`openai`, `openai_responses`, `anthropic`, or `github_models`); legacy aliases normalize at every persistence/import boundary without dropping credentials or model metadata. A Responses stream is successful only when `response.completed` carries an explicit case-insensitive embedded `response.status=completed`, even if partial text, reasoning, or tool deltas arrived earlier. Event type alone and missing, blank, unknown, or non-completed status are controlled failures; successful fixtures must state the completed status explicitly so permissive test data cannot hide a protocol gap.
- Provider onboarding must always offer three peer paths: explicit manual creation, fuzzy discovery, and import from a connected device. Manual providers and provider-owned models reuse the canonical PC-compatible store; never hide basic creation behind discovery or introduce a parallel mobile-only schema.
- Mobile submit controls are a three-state protocol, not a boolean skin: idle send, running stop with empty input, and running send/Next with non-empty input must each retain the PC action semantics and material. Center icon geometry inside animated borders explicitly; never rely on a container's default top-start alignment.
- Memory Lab glass actions obey the same layout-invariant optical-canvas rule as composer controls. Text pills and circular navigation buttons keep their nominal hit boxes while refraction, blur, shadow and lift render in a transparent outset child.
- Reliability state must be explicit, scoped, resettable, and covered by boundary tests. Do not infer retry semantics from a loop-local variable name.
- A consecutive-failure threshold counts consecutive provider outcomes. Any valid provider activity, including reasoning/thought, assistant text, or a tool call, resets the empty-response streak immediately.
- Content disclosure in the conversation transcript is a plain information operation, not a selection or decorative interaction. Build/history disclosure must change state immediately on click or keyboard activation, without glass, floating layers, scaling, fading, sliding, easing, delayed commit, or animated chevrons.
- Do not add visual motion unless the product requirement explicitly calls for it. Accessibility focus indication may remain static and must not alter activation timing.
- Provider identity and retry state must remain auditable. User-visible retry notices should state the current consecutive-empty count and the termination threshold without exposing secrets.

## Code style

- Prefer small named helpers and constants over duplicated numeric limits.
- Keep provider outcome classification separate from retry policy and route fallback policy.
- Tests must cover threshold-minus-one, threshold, reset-after-success, tool-call success, abort, and unrelated transport failures.
- UI negative contracts are first-class tests: assert that forbidden glass nodes, pseudo-elements, transitions, animations, transforms, and delayed state changes are absent.
- Mobile file capability must degrade by permission tier: ordinary system-readable MediaStore/URI content remains available without privileged mode; broad path traversal and mutation require explicit all-files access; Root/Shizuku never silently widens ordinary Agent file visibility.
- Conversation action menus must preserve their popup composition through exit and scale back toward the actual trigger: the ellipsis button uses its top-right anchor, while a long press uses the capsule center. Archiving is a staged visual commit: close the menu, fade/condense the capsule, then remove persistent state.
- Mobile alarm requests belong to Android's public `AlarmClock` contract and the user's default clock application. Never present an app-owned `AlarmManager` notification as a system clock alarm, and never promise cross-clock list/delete capabilities that Android does not expose.
- Mobile local Agent tool execution has no arbitrary round-count cutoff. It continues until a final provider response, explicit cancellation, or a real error; every provider subround must re-evaluate context pressure and compact before overflow.
- Mobile provider requests use the same context hierarchy as PC: request-scoped latest-user focus and Guide semantics, durable public conversation context, compression summary/continuation anchor, then tool schemas. Request-only bootstrap metadata is never persisted or summarized as conversation history.
- Empty-response recovery is explicit-failure-only. Waiting, silence, EOF, timeout, and stream closure are not empty responses. After an explicit invalid empty result, retry delays are 200ms, 800ms, 2s, 10s, and 60s; the fifth retry failure terminates.
- Request-scoped system/bootstrap text must remain byte-stable across tool subrounds. Never inject message counts, tool counts, IDs, timestamps, plan state, or other changing values into the cached prefix; dynamic state belongs in durable messages or provider tool fields.
- Mobile file discovery treats MediaStore paths and DocumentProvider identities as complementary. Preserve content URI, provider authority/document ID, placeholder flags, and canonical identity so optimized/online-only files can be hydrated through the owning provider instead of being mistaken for empty duplicates.
- Rich document reads return structured text, never opaque base64 when a supported parser exists. PDF fallback order is text layer, page visual model, device miniOCR, then LLM visual synthesis with page/OCR evidence; every result reports the method actually used.
- Existing mobile liquid floats use overlapped flight: source geometry/material is snapped first, lift and travel may overlap, and target contraction may begin before travel completes. The only hard boundaries are a visible lift from the source color block and a completed contraction into the target color block.
- A held or dragged liquid float remains fully lifted until release. Redirect an in-flight float from its current frame; never spawn a second glass layer or snap it back to the stale selected block. Maintain an explicit allow-list so ordinary surfaces are never converted to glass accidentally.
- A fixed glass button has exactly one visible owner during lift. Keep the real source element laid out and hittable, but suspend every source paint layer (content, descendants, background/gradient color block, border, shadow, and pseudo-elements) until the floating glass has completely landed. Restore the source before replaying its command, and make cancellation/blur/pagehide/timeout cleanup idempotent; never hide the source element itself with persistent visibility or opacity state.
- Desktop liquid-glass renderer pooling may reuse offscreen WebGL programs and textures, but never reuse a visible canvas DOM surface across floats. Each float owns a fresh display canvas with explicit current CSS dimensions; releasing the float detaches and forgets that canvas so Chromium cannot carry a prior promoted-layer extent into another modal or control.
- Boundary resistance is a shared liquid-glass primitive, not a screen-local exception. Every existing floating glass control stays logically clamped while held input beyond its track produces the same small square-root visual displacement, capped at 4dp, with restrained axis-aligned stretch/compression. Release clears the visual offset before landing; ordinary non-glass disclosures remain outside this system.
- Mobile clicks never use Android/Material gray ripple feedback. Disable visual indication once at the app theme boundary; preserve interaction sources, accessibility semantics, gestures, disabled-state behavior, and deliberate Newmark-owned animations.
- The mobile no-ripple policy includes Settings. Right sidebar, Memory Lab, conversation, navigation, settings, and overlays must remain free of Material/Foundation gray ripple and use Newmark-owned fill/glass/edge feedback only.
- Mobile theming has no user-editable palette. Keep only built-in light/dark semantic theme colors; do not add color pickers, custom accent fields, palette JSON, or color-setting persistence.
- Mobile queued-conversation actions are borderless. Pause/resume, disclosure, Guide, edit, and delete must not use framed glass buttons or static button fills; communicate action hierarchy through icon color, spacing, and a restrained same-color press wash while preserving 48dp-class combined row targets and ripple-free semantics.
- The mobile queue header has no redundant “排队对话” title; its only text is the live `n 条待处理` count, with pause state conveyed by the existing color/status control rather than a second label.
- Chat mode is a cross-client evidence sandbox. Publish and execute `web_search`, `web_fetch`, plus the existing `terminal_exec` only for exact `date`, `time`, or `now` local-time reads; do not add a parallel time tool. Reject every workspace, host, application, memory, task, browser-control, and write capability even when replayed from stale context. Search first, fetch authoritative sources when useful, then summarize promptly with evidence instead of becoming a long-running workflow.
- Mobile glass edge thickness is a system token, not a per-screen decoration. Visible highlight, fallback border, refraction band, and RGB dispersion band must grow together; never thicken only the painted outline while leaving the optical layers at the old width.
- Every mobile glass click owns a complete lift-and-land lifecycle. Lift and travel may run concurrently, but landing cannot begin until full lift and travel are both complete; quick release or repeated taps must never truncate a cycle. Parents around floating glass controls must not clip the expanded edge.
- Conversation archival is a coordinated list transition: the capsule exits first, then surviving keyed rows animate into their new positions. Never remove a row and let lower capsules snap upward in one frame.
- A floating glass button needs an optical canvas larger than its layout hit box. Edge highlight, blur, shadow, refraction, dispersion, and press scaling must render beyond the button bounds; do not use a shape-clipped, button-sized offscreen layer for edge-only glass. Full glass panels may retain shape clipping.
- Compact mobile glass controls reserve a measured 8dp transparent outset around the nominal visual node. Keep anchors, semantics and pointer input on the nominal node; never expand the hit target merely to make room for optics.
- Optical canvas expansion is render-only and must be layout-invariant. A finalized mobile input bar's height, padding, slot widths, button centers, spacing, shadows, and hit boxes are immutable unless the user explicitly requests a visual redesign; never make the parent measure the optical outset.
- Every compact floating mobile glass action, including transcript overlays such as scroll-to-bottom, must use the shared transparent optical canvas. Never apply `glassButtonSurface` directly to a nominal 40dp overlay button when its lifted scale, edge, blur, or shadow can exceed that RenderNode; preserve the nominal alignment and hit box while only the optical child overflows.
- Mobile Memory Lab follows the PC durable-memory contract: bounded read/query, versioned add/update/refactor/delete, expectedUpdatedAt stale-write rejection, archive-before-mutation, policy.jsonl audit, tag DAG/tagPaths, and verified rebuild receipts. Visual parity must preserve mobile-specific pan/zoom, 48dp touch targets, and uninterrupted drag gesture ownership.
- Memory Lab index normalization has one owner per client and every UI/Agent reindex entrance must call it. Bilingual synonyms select one language-preferred canonical tag, preserve alternative names as aliases, rewrite component tags/tagPaths, remove obsolete synonym nodes, and remain graph-idempotent across repeated rebuilds.
- Desktop model-facing writes are patch-first too: omit unchanged fields, prefer unique-fragment or append edits, require revision/read tokens where available, and keep full replacement only as a compatibility path. Do not create a second incremental tool when an existing `edit`, item update, or field patch already covers the operation.

## Documentation and release evidence

- Every release plan goes in `tasks/plan.md` and its executable checklist in `tasks/todo.md`.
- Preserve historical plans below the current release section.
- Record planning and implementation evidence in timestamped files under `archive/`.
- Update `README.md` for public release intent and `OVERVIEW.md` for code map, file responsibilities, tests, and current project state.
- A release-ready claim must name the exact host-built asset matrix, verify every asset independently, record byte size and SHA-256, disclose signing identity, and separate local packaging from external publication. Never imply a macOS artifact was built from Windows or that an APK signed by the Android Debug certificate is store-ready.
- Treat Windows Installer exit `0` as necessary but not sufficient for same-version repair. When a required packaged file is already absent, verify the installed boundary explicitly; if repair leaves it absent, use one elevated uninstall-plus-fresh-install transaction and require installed/package ASAR equality, CLI version success, preserved user-state hashes, and a responsive GUI process set.

## Desktop startup performance style

- Show a lightweight, responsive startup surface before expensive state construction. Keep the same `BrowserWindow` and navigate/promote it after required state and renderer hydration are ready; do not create a second visible window or load the full renderer merely to cover it.
- Never perform an unbounded synchronous directory scan or JSON parse loop on Electron's main thread during cold start. Historical runtime markers must be processed asynchronously in bounded batches before `Agent` construction.
- Runtime lifecycle metadata must remain self-pruning: clean shutdown deletes its own marker, while only genuinely active prior markers participate in crash recovery. Startup cost must not grow linearly with launch count.
- Startup optimization claims require both phase timings and responsiveness evidence under an inflated historical-state fixture. Record shell, navigation and writable-input time, `Process.Responding` samples, and remaining marker count; measurement fixtures must live under the system temp directory and never clean the user's real runtime root.
# Terminal rendering style

终端高频输出优先采用有界缓冲、时间窗合并和逐帧增量渲染；禁止在热路径使用 `innerHTML +=` 或每个数据包强制布局滚动。
# Mobile local Agent stability style

本地 Agent 将 provider 响应视为不稳定外部边界：思考、可见正文或工具调用都算有效活动并立即清零空响应计数；仅思考不伪造正文完成态，而是保持 build 活跃并继续取得正文或工具调用。只有 provider 明确完成且报告失效空响应时才采用有限连续重试；静默等待没有时间上限，也不计为空响应。禁止用“无回复内容”伪造成功完成态。

流式 provider 兼容必须同时接受增量 `delta` 与完整 `message` 事件；解析层不得因缺少某一种事件形态而丢弃另一种有效响应。空响应只接受 provider 明确失效信号，等待、静默、EOF、超时和流关闭不计为空；重试间隔为 200ms、800ms、2s、10s、60s。

# Mobile animation scheduling style

高频拖动的几何与速度优先在 `graphicsLayer` 阶段读取；动画 Job、当前命中项和缓存几何不得使用
Compose Snapshot 状态。只有会改变组合结构或材质阶段的低频状态进入 composition。性能修复不得
改写玻璃 shader、形变数学、时长、easing、浮起/移动/落地语义。后台 Agent 的流式 UI 快照应按
帧有序合并并在终态前 flush，禁止每个 token 碎片同步抢占主线程。

# Mobile thought lifecycle style

Provider 子轮不是公开思考节点的生命周期边界。连续 thought-only 返回必须复用同一个公开 thought，
把流式 delta 与最终 reasoning 字段对账后接续；不得通过 UI 去重掩盖重复事件源。只有工具调用、公开
正文、Guide、真实错误、显式停止或 Build 完成才关闭当前 thought。压力测试必须同时约束公开节点数
和内容完整性，防止事件快照随 provider 子轮数无界增长。

Reasoning-only provider 子轮若需要继续请求，必须携带有界、request-only 的进度检查点，禁止用完全
相同的上下文重新启动模型。检查点只能追加在稳定请求前缀之后，不得进入聊天正文、durable
`modelContext`、压缩摘要或磁盘历史；Guide、工具调用、正文与终态是清空边界。已经公开显示的流式
reasoning 是单调内容，下游最终字段只能补全，不能用较短或不兼容版本覆盖和回退。

Thinking-mode continuation is a provider protocol, not prompt text. Carry a live assistant checkpoint through
the native `reasoning_content` field and keep it transient; never serialize it into conversation history or wrap
it in an invented internal instruction. A new provider sub-round is permitted only after an explicit model-owned
truncation state (`length`, `max_tokens`, or `max_output_tokens`). Elapsed time, silence, EOF, and connection close
must never schedule a resend. Preserve `finish_reason` through the adapter so stop/continue behavior remains owned
by the model. Resolve native thinking tiers from the active deployment, not a global model-name search.

Tool argument streaming is a provider compatibility boundary. Accept both true JSON deltas and cumulative snapshots,
but normalize them into exactly one strict JSON object before execution. Keep independent accumulators keyed by tool
index/call identity so interleaved parallel calls cannot contaminate each other. Never silently replace malformed
arguments with `{}` or accept trailing JSON; return the concrete parse failure so the model can make a real correction.

Tool help is also a provider compatibility boundary. Every mobile local tool definition must be independently usable
without hidden prompt context: closed object schema, explicit property types, required list, concrete value domains,
permission/privilege preconditions, side effects, and output semantics. Prefer native nested JSON objects over
stringified JSON envelopes. Legacy envelopes may remain execution-compatible, but must not be the advertised schema.

Mobile write tools are patch-first. A local change must not require the model to resend an unrelated provider catalog,
model list, memory body, or whole text file. Omitted fields preserve stored values; destructive deletes require explicit
confirmation; read-before-write tokens such as updatedAt or SHA-256 reject stale mutations. Full replacement may remain
as a compatibility path, but help and system guidance must recommend the smallest sufficient mutation.

Context continuity and cacheability are complementary: preserve the existing byte-stable system/bootstrap, tool schema,
and durable message prefix, then append the assistant tool call and matching tool result at the frontier. Retry or parser
diagnostics must not rewrite the prefix, enter durable summaries, or create a synthetic memory node.

# Mobile provider settings style

模型与供应商设置域使用 44dp 单行胶囊作为唯一内容单元：标签、值、能力、状态与操作应在一行内完成，不回退到混合卡片或多行表单。页面导航必须复用左侧栏三个按钮同款的纵向胶囊玻璃浮块与色块起终点形变；协议枚举使用同一材质语言的横向胶囊玻璃滑块。浮块负责起飞、沿轨拖动、液态形变和落回目标色块，`LazyColumn` 仍负责快速滚动；浮块移动不得扩大内容点击范围或改变保存边界。

设置页不绘制独立纵向轨道、轨道槽或无功能占位；胶囊列表本身就是纵向浮块的运动表面。任何会切换子页或删除父级数据的点击，都必须在浮块完整落地后提交。横向协议浮块与纵向导航浮块属于同一互斥运动域，不能同时显示或响应；协议横轨是纵向轨迹的硬边界，跨区只能通过边界两侧两个完整起落事务完成，禁止视觉穿越。

输入胶囊属于内容控件而不是纵向玻璃落点：必须同时从可选索引、手势起点和初始选择/色块中排除，并保留原生输入、选字与长按。点击飞行必须连续动画坐标，禁止“坐标赋值 + 延时”伪装移动；位移与完整浮起/落下材质生命周期并发，二者都完成后才能提交导航。

同一行中的多个操作按钮也不是整行选择目标。每个按钮拥有与自身命中框一致的独立光学玻璃，点击在完整起落后提交，拖动只产生按钮边界内的阻尼形变。纵向命中必须按实际 slot 区间计算，不能用中心四舍五入将上半区映射到下一项；中断动画必须从当前 `Animatable` 帧续接，禁止 snap 回逻辑索引。远程设备操作同时展示连接状态并在 UI 与 ViewModel 两层拒绝离线目标，所有一次性迁移请求必须有有界超时。图标颜色必须使用主题语义色，不固定为白色。

Windows 同版本安装必须明确区分“MSI 已构建/已验证”“UAC 已触发”和“安装已完成”。UAC 拒绝或取消后不得循环重试、绕过提升或声称安装成功；复核注册表与安装路径，保留现有响应进程，并等待用户明确要求再次触发。

Android Release 的标准输出若被外部文件锁占用，不得结束未知进程或把旧 APK 冒充新产物；应使用项目受控的隔离 build directory 做全新构建，并以包内版本、最终 Manifest、签名、大小、SHA-256 及源/交付副本一致性共同确认交付物。

移动 Agent 的后台稳定性不能以“前台服务存在、WakeLock 已持有、结构测试通过”代替端到端连续性。Provider SSE 必须显式区分响应头前、无增量、有公开增量、工具调用形成、工具副作用完成和进程死亡六个恢复阶段；只有证明幂等或使用持久 checkpoint 的阶段才可重放。网络恢复门槛必须基于 validated transport，所有断流都要留下 request/run/transport/phase/retry/terminal reason 的脱敏诊断。

# Release candidate boundary

“全平台 Release”在 Windows 主机上表示从同一版本源码生成并逐件验证 Windows、Linux 与 Android 的本地候选资产；macOS 制品只允许在 macOS 主机原生生成。构建成功、签名状态、黑盒运行、远端上传和商店可分发性必须分别陈述。标准输出被外部进程占用时，优先采用隔离输出并核对哈希，不关闭不明进程或覆盖用户正在使用的制品。

桌面端发行收口必须运行完整 `test:full-release`，不能只以主验证或单项压力通过代替。首轮标题门禁会使旧的纯流式 mock 在标题探测处失败，因此所有使用 `Agent.process` 的夹具必须区分 `stream=true` 与非流式标题探测，并让无供应商诊断保留 `No LLM configured` 可操作提示。

PC/移动端首次标题探测使用 0s → 1s → 2s → 4s → 8s 的 5 级退避；空响应和“标题原样重复用户输入”都视为未完成并自动进入下一级。正式首轮必须等到标题成功后再启动；全部重试失败才落错误，不能要求用户手动再次发送。Windows MSI 发行还必须通过打包后 `release-cli-smoke`、context-compress CLI stress 与 console wrapper boundary stress，并以安装后 `app.asar`/关键 EXE 与 `win-unpacked` 哈希一致作为安装证据。

# Mobile image evidence style

用户图片属于其对应输入消息，必须在文字正文上方展示，并在本地/远程历史间复用同一附件投影。Agent 展示图片属于公开 Build 证据，工具回执只返回元数据，图片字节不得进入后续模型工具结果。图片路径、格式、来源、尺寸与大小必须先校验；预览可展开，但不得引入与现有时间线竞争的新卡片语言。

移动 Agent 主动检查图片与展示图片是两个边界：`image_inspect` 只读安全工作区或安装者已授权的 URI/共享路径，验证 PNG/JPEG、10 MiB 与 4000 万像素上限后，将字节作为当前冻结视觉部署的一次性输入；公开工具回执、Build 事件、模型上下文持久化和对话历史都不得保存 base64。`image_display` 仍只负责向用户保留可见证据，不能冒充模型已经观察图片。

移动端 Markdown/LaTeX 渲染必须自带离线字体，不能依赖设备系统字库覆盖数学符号、CJK 和代码框线：数学使用 Noto Sans Math，代码/行内码使用 Noto Sans Mono CJK SC。代码正文必须在父级可用宽度内 `softWrap` 换行，禁止用横向滚动占满无限宽度作为默认策略；只有用户显式进入宽行查看时才可增加横向平移，不把“能横滚”当成“自适应”。代码高亮 Token 色必须来自亮暗主题语义色板，亮色模式下所有语法色都要比代码块浅背景更暗并保证可读，不能复用暗色荧光色。

紧凑玻璃按钮的静止边框、浮起折射边缘和落下恢复必须由同一光学层绘制。禁止在内容层额外叠加静态 `border`，否则边框不会随玻璃起落与形变同步；名义布局、语义和命中框继续与透明光学外扩分离。

设置主页与所有设置子页的顶栏返回按钮属于同一个共享紧凑玻璃入口。名义 36dp 节点只负责布局、语义和命中，折射、高光、阴影与浮起必须由共享 8dp 透明光学子层承载；禁止重新在按钮等大的 RenderNode 上直接挂载 `glassButtonSurface`。
# Mobile conversation layout alignment

用户消息附件与用户正文同向右对齐；Agent 展示图与 Agent 正文同向左对齐。对话底部避让必须由输入上方浮层的实时测量高度驱动，而不是固定预留值；Markdown/LaTeX 阅读器复用同一文字安全边界，避免窄屏出格。
## Kernel interruption diagnostics

稳定 API 场景下优先审计本地 Abort、utility child 生命周期与 renderer IPC 竞争。运行中状态刷新只绑定语义边界事件；所有 abort 必须携带可观测 reason，禁止把外部运行时退出静默归类为普通 interrupted。
## PC Build Block boundary

Build Block 是纯信息时间线，不是材质容器。展开/折叠只改变内容披露，不得引入玻璃、白板色、圆角、阴影、滤镜或伪元素；玻璃仅限明确批准的菜单与交互浮块。
Build 标题按钮的 hover、focus、active 与键盘触发态都必须保持透明；禁止使用 `revert`、系统按钮色或通用按压材质恢复其背景。

## Built-in browser popup navigation

`target=_blank` 与 `window.open` 不创建脱离控制的第二浏览器表面：PC WebView 将安全 URL 导回当前 guest，移动 WebView 通过临时捕获窗口转发到同一会话。地址栏、历史和 Reload 始终属于会话状态，禁止弹出页失去刷新能力。
## PC image interaction boundaries

图片点击命中框贴合图片自然尺寸，禁止通用 button 胶囊圆角污染图片组件；用户附件随用户正文右对齐，Agent/Build 展示图随 Agent 正文左对齐。图片查看弹窗继续复用既有玻璃子窗口。

## Automatic continuation guard
自动续接必须可去重、可停止；对完全重复 Assistant 输出设置运行内指纹保护，用户明确 follow-up 不受影响。

## Markdown and LaTeX rendering
移动端优先使用内置解析能力并保持 Newmark 原生 Compose 视觉；LaTeX 在无完整数学排版引擎时提供稳定可读 fallback。PC 代码块复制必须独立于整条消息复制。

## Mobile fenced code parsing
代码围栏解析必须容忍更长围栏、波浪围栏及传输中语言标记/首行代码粘连；优先保持原文代码内容，不因格式瑕疵丢弃代码块。

## Release version discipline
修复版发布必须沿用 VERSION、桌面 package.json 与 Android versionName/versionCode 的一致值；本轮 Markdown 修复发布为 0.5.12 / 512。
## 移动输入与队列手势边界

- Compose 文本输入必须使用能保留 selection/composition 的稳定编辑状态；普通光标、选字与组合文本更新不得重建 IME 会话。
- 页面级点击收键盘只能观察未被子输入控件消费的最终事件，禁止在 Initial pass 抢占文本选择手势。
- 队列排序手势只属于显式拖动把手；Guide、编辑和删除按钮的短点击区域不得承载父级长按拖动识别器。
- 运行中发送键的点按永远保持 Next 语义；直达 Guide 只能由 300ms 长按后明确向上拖动并释放触发，浮块与原按钮等尺寸且不得写入、删除或重排队列。
- Guide 的接收边界由活动 runId 和显式 acceptance 状态决定，不由 UI 模式名决定。拒绝或过期的 Guide 不得清空用户输入，也不得伪装成 applied。

## Windows MSI 安装验收纪律

- Windows 发布不能以 MSI 文件生成或提权窗口出现作为安装成功；必须同时核对安装日志、卸载注册表版本、安装目录 CLI 版本和打包/安装 `app.asar` 哈希。
- 安装前先温和关闭目标安装目录中的应用；若必须强制结束，只能作用于已核实属于该安装目录的进程，不得波及同名或无关程序。
- 安装器不得修改用户 `.Newmark`。在 GUI 启动前用同一相对路径、大小和逐文件哈希清单比较安装前后状态，避免 Electron 启动缓存污染验证结果。
- GUI 验收至少确认主窗口存在且响应；Windows Installer 的 Session 0 服务进程可在事务完成后暂留，是否完成应以交互进程退出码与 MSI 日志最终状态为准。
- 未签名 MSI 必须明确记录 `NotSigned`，不得将本地验证等同于生产签名或远端发布。

## Mobile background Agent ownership

- 前台服务必须拥有真实 Agent/连接协程，而不只是显示通知或持有 WakeLock；活动本地 Agent、远程 SSE 和重连不能由 Activity、Compose 或 ViewModel 生命周期拥有。
- 已配对的远程设备构成后台连接租约。界面存在时由正式事件 reducer 持有 SSE；界面销毁后服务接管只读认证 SSE 保活，重新进入界面时取消保活并从持久状态重建，禁止两个事件消费者同时写 UI。
- 长期 Agent 会话使用用户可见且用途明确的 `specialUse` 前台服务，CPU/Wi-Fi lock 仅随本地运行或远程连接租约存在；解除配对且无本地运行时必须释放。
- 网络恢复由系统默认网络 callback 驱动，恢复后清理 OkHttp 旧连接池并立即重连。远程 Agent 活跃期间重连不设软件端总时限；空闲连接可以保留有界状态提示。
- 本地 provider 请求只允许在尚无任何 thought/text/tool 活动时因瞬态网络错误重试。已有公开模型活动后连接失败必须终止当前请求，禁止可能重复正文或工具副作用的自动重放。

## PC interrupted response boundary

- 正常完成以 `final_response` 作为唯一块外 Agent 结果。
- 中断且没有 `final_response` 时，可将最后一条非空公开 `response` 提升为块外 Agent 回复，但必须同时从 Build 展开正文中移除同一事件。
- 没有公开回复的中断不得伪造 Agent 消息；实时渲染、对话切换和重启历史恢复必须同构，并继续按 runId 保证单实例。

## Conversation title generation boundary

- 自动标题必须来自独立、无工具、短上下文的模型请求，不得把用户原输入直接裁切成标题，也不得等待主 Agent 完成后再命名。
- 标题探测是首次正式响应的硬门禁：成功生成并落库前不得启动正式 Agent/provider 请求；失败或超时后，后续普通发送必须继续读取并重试同一条首个持久化用户消息，不能把新发送文本换成标题来源。
- 标题探测与后续正式响应共享发送时冻结的 provider/model/intelligence，并兼作该部署的首轮可用性检查；探测消息、错误和输出不得进入聊天、Build、Guide/Next 或主请求缓存前缀。
- 标题请求必须绑定发起时的工作区快照；用户切换工作区后，迟到结果只能写回原工作区，不能依赖当前可变选择。
- 标题身份与首次正式响应启动状态必须持久化；异步结果只有在目标对话、首消息和默认标题状态仍匹配时才可落库，手动命名永远优先。

## Mobile provider interruption recovery

- Android 网络“可用”必须同时满足 INTERNET 与 VALIDATED；仅有路由声明但尚未通过系统验证的网络不能唤醒 provider 重试。
- 响应头前的瞬态失败可以重试原请求；已有公开正文/思考后只能携带有界进度发起“继续且禁止复述”的新请求，不能把旧请求当作从未发生。
- 已持久化的工具调用/结果是副作用边界。恢复路径不得重放已经提交的工具；反复失败应保留进度并给出受控错误，而不是向用户透传底层 SocketException 文案。

## First-response deployment identity

- 常规首轮标题探测不是固定低档模型请求，复用正式响应发送时冻结的 provider、model、intelligence 与供应商原生 reasoning effort。图片首轮失败后的纯文字标题退路允许单独降低辅助请求的思考档位，不切换冻结的 provider/model，也不改变正式请求配置。
- 标题成功之后不得再次解析或切换首轮部署。若可用性发生变化，应让该次门禁失败并保留重试身份，不能让“标题验证 A、正式响应运行 B”。
- 这类跨阶段身份契约必须由测试同时观测标题调用和正式调用的实参，不能只以标题文本或请求次数间接推断。

## APK candidate replacement discipline

- 最终 APK 必须从隔离输出执行 clean Release 构建，交付复制拒绝覆盖同名文件，并以源/交付 SHA-256 一致性绑定当前工作树；旧候选保留作回滚证据，但必须显式标记已被替代。
- Android 发行门禁同时覆盖包名/版本/SDK/入口、合并 Manifest、签名方案、4-byte 与 16 KiB native 对齐，以及只报告命中类别和文件位置的开发机路径/凭据扫描。
- 模拟器安装启动只能证明包可安装和进程可运行；真机 OEM 后台、网络切换、真实供应商与逐帧视觉反馈必须作为独立未完成边界保留。

## PDF whole-tool timeout boundary

- `pdf_read.timeout_ms` 是一次调用的累计预算，不是只包围扫描页浏览器观察。异步文件读取、pdf.js 文档加载、逐页文本提取与视觉观察必须共享同一 deadline；任何阶段超时都返回带阶段、预算和 `recoverable=true` 的工具回执，使同一 Agent run 可以继续响应。
- 父级 run 取消与工具预算超时必须区分：用户/运行时 abort 继续向外传播，不能伪装成可恢复 PDF 超时。超时后要销毁 pdf.js loading task、解绑 abort listener、清除 timer，禁止遗留 worker、未处理 rejection 或悬空 tool call。


### 20260905-141515 动画状态约定补充
长按释放必须先停止拖动态并把当前指针帧转移到 Animatable，再执行落点移动，移动完成后才开始玻璃收缩；无实际拖动的长按释放不得使用未初始化的拖动坐标。


### 20260905-143414 PC 液态玻璃绘制约定
WebGL 折射与 2D 泛光必须共享同一圆角裁剪路径；高频指针光源先写 pending 状态，由 requestAnimationFrame 合并后再触发 CSS 与画布更新，避免同步 pointermove 造成抖动。

### 20260905-144650 PC 长按交互约定

- 选项菜单长按状态机必须按 selected source → pointerdown target 飞行 → 目标处持续拖动 → 最终选项飞行 → 提交并收缩落地执行。
- 飞行完成后 lockStartLeft/blockStartTop 必须取 landed target 几何，禁止恢复 source 几何。
- 长按玻璃只由 carrier block 绘制；选项文字/图标节点固定 	ransform:none、scale:1、ilter:none。
- 玻璃泛光必须在 carrier 自身圆角路径内合成，不能污染弹窗或整幅画布。

### 20260905-145603 移动端暗色抽屉边缘约定

全高矩形的移动端抽屉承载层不得直接绘制全局 Kyant 外沿高光；暗色竖屏左栏使用无外沿高光的 carrier glass，按钮、胶囊和拖动浮块各自负责受边界约束的玻璃边缘与泛光。


### 20260908 dev-0.6.2 全界面主题与玻璃协调

- 错误、警告、成功、强调色使用平台主题语义变量；亮色使用深一档状态色，禁止直接沿用暗色的浅黄/浅红文字。记忆图谱节点、边、网格也遵守此规则。
- 两端选中开关的静态圆点为白色，未选中使用次级文字色；玻璃拖动态沿用光学浮层。普通 hover 使用主题 control-hover-bg。
- 弹窗重新打开必须取消上一轮退出计时和退出样式；退出中的窗口不得进入返回栈。
- 本地 about:blank 浏览器画布属于应用主题；不得向实际网页强制注入应用配色。执行前后检查 URL，防止导航竞争。
- 视觉验收必须确认截图与所请求页面一致。Compose 等待语义树空闲不等于 GPU 已提交，完整窗口截图前先同步绘制；接触表也要等待图像解码与绘制。旧错误截图保留为排查历史，不冒充验收证据。


### 20260908 内置浏览器本地文档

- 用户主动输入的绝对文件路径要逐段编码，不能被当成搜索词或错误补上 https。file URL 保留百分号转义，兼容 files:// 输入；本地 URL 不接受远程 authority。
- Android 文件读取与 file-origin 跨源权限分开配置：允许读取 file/content，不开启 allowFileAccessFromFileURLs 或 allowUniversalAccessFromFileURLs。页面发起的本地导航/弹窗只接受本地来源，地址栏主动打开不受该页面来源规则误伤。
- 本地 HTML 回归必须包括中文、空格和 # 文件名、相对 CSS/JS 与页面跳转；URI 构造不能依赖 Windows 构建宿主对 Android /sdcard 路径的解释。

## 2026-09-08 Browser visual collaboration and binary documents

- Prefer DOM or parsed PDF text. Invoke a configured vision-capable collaborator for sparse content or an explicit visual request; only then run OCR. Label approximate results. Never fabricate refs or action success from visual interpretation.
- Keep images transient and model collaborators read-only. Propagate cancellation, bound provider calls, and reject observations that change while capturing.
- Viewport values mean real CSS canvas dimensions, not screenshot metadata. Fit that canvas inside the existing panel, transform native input accordingly, and verify both layout dimensions and rendered pixels.
- Detect PDFs by MIME/download events as well as URLs. Parse bytes with PDFBox/PDF.js; never treat viewer chrome or a raw-byte regex as extracted document text. Preserve browser cookies and local URI access.
- Report PDF page/scope explicitly. Default text extraction is bounded by max_chars; the default visual page is page 1. Use pdf_page to request another page.

- Remote IPC coalescedDeltas retain original event identity. Expand batches before merging SSE with durable snapshots; dedupe by original IDs, never by repeated words. Preserve intentional repeated content and normalize omitted Gson fields.
