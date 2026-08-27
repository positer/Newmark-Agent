# Newmark Agent Project Taste

## Product and interaction principles

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
- Mobile clicks never use Android/Material gray ripple feedback. Disable visual indication once at the app theme boundary; preserve interaction sources, accessibility semantics, gestures, disabled-state behavior, and deliberate Newmark-owned animations.
- Mobile Memory Lab follows the PC durable-memory contract: bounded read/query, versioned add/update/refactor/delete, expectedUpdatedAt stale-write rejection, archive-before-mutation, policy.jsonl audit, tag DAG/tagPaths, and verified rebuild receipts. Visual parity must preserve mobile-specific pan/zoom, 48dp touch targets, and uninterrupted drag gesture ownership.

## Documentation and release evidence

- Every release plan goes in `tasks/plan.md` and its executable checklist in `tasks/todo.md`.
- Preserve historical plans below the current release section.
- Record planning and implementation evidence in timestamped files under `archive/`.
- Update `README.md` for public release intent and `OVERVIEW.md` for code map, file responsibilities, tests, and current project state.
- A release-ready claim must name the exact host-built asset matrix, verify every asset independently, record byte size and SHA-256, disclose signing identity, and separate local packaging from external publication. Never imply a macOS artifact was built from Windows or that an APK signed by the Android Debug certificate is store-ready.
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

Context continuity and cacheability are complementary: preserve the existing byte-stable system/bootstrap, tool schema,
and durable message prefix, then append the assistant tool call and matching tool result at the frontier. Retry or parser
diagnostics must not rewrite the prefix, enter durable summaries, or create a synthetic memory node.
