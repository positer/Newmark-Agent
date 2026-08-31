# Newmark Agent Project Taste

## Queue visibility boundary

队列中的真实用户输入必须在用户消息时间线可见。出队时不得把带稳定 clientMessageId 的用户项标记为 hiddenUserInput；只有无用户身份的内部自动续接才允许隐藏。

## Compression and recent visual input

上下文压缩只折叠长期历史图片；压缩后近期窗口中的每一条用户图片都必须可继续提供给视觉模型，连续图片输入不能因“只保留最后一张”而丢失。

## Product and interaction principles

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

# Release candidate boundary

“全平台 Release”在 Windows 主机上表示从同一版本源码生成并逐件验证 Windows、Linux 与 Android 的本地候选资产；macOS 制品只允许在 macOS 主机原生生成。构建成功、签名状态、黑盒运行、远端上传和商店可分发性必须分别陈述。标准输出被外部进程占用时，优先采用隔离输出并核对哈希，不关闭不明进程或覆盖用户正在使用的制品。

# Mobile image evidence style

用户图片属于其对应输入消息，必须在文字正文上方展示，并在本地/远程历史间复用同一附件投影。Agent 展示图片属于公开 Build 证据，工具回执只返回元数据，图片字节不得进入后续模型工具结果。图片路径、格式、来源、尺寸与大小必须先校验；预览可展开，但不得引入与现有时间线竞争的新卡片语言。

紧凑玻璃按钮的静止边框、浮起折射边缘和落下恢复必须由同一光学层绘制。禁止在内容层额外叠加静态 `border`，否则边框不会随玻璃起落与形变同步；名义布局、语义和命中框继续与透明光学外扩分离。
# Mobile conversation layout alignment

用户消息附件与用户正文同向右对齐；Agent 展示图与 Agent 正文同向左对齐。对话底部避让必须由输入上方浮层的实时测量高度驱动，而不是固定预留值；Markdown/LaTeX 阅读器复用同一文字安全边界，避免窄屏出格。
## Kernel interruption diagnostics

稳定 API 场景下优先审计本地 Abort、utility child 生命周期与 renderer IPC 竞争。运行中状态刷新只绑定语义边界事件；所有 abort 必须携带可观测 reason，禁止把外部运行时退出静默归类为普通 interrupted。
## PC Build Block boundary

Build Block 是纯信息时间线，不是材质容器。展开/折叠只改变内容披露，不得引入玻璃、白板色、圆角、阴影、滤镜或伪元素；玻璃仅限明确批准的菜单与交互浮块。
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
