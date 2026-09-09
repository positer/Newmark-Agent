# Newmark Agent dev-0.6.3

## English

### Changes

- Replaced the unreliable in-memory conversation queue ownership with a workspace-level authoritative continuation ledger (`GuardedContinuationStore`). Build admission is a CAS transaction with idempotent command receipts; workspace, root, branch, parent and input are fixed at acceptance. BranchGuard/attempt/fence, unique final, head/tail separation, dependency blocking, fork lineage validation and append-only events are enforced.

- A queued Next is now a new user Build in the same conversation: after the previous Build fully settles it starts a new run id, restores the captured branch, and appends a normal user turn. Guides still steer the current Build. A queued row whose target identity does not match the executing runtime is paused instead of being rerouted into the foreground conversation.
- Reordering admitted queue rows is rejected because it would silently change fixed parents; changing the order requires explicit cancel plus new commands.
- Flow is now an authoritative external build. It is admitted at command acceptance, claimed with an attempt/fence, requeued on suspend and committed on completion. `beginExternalRun` reconciles persisted queue continuations by `clientMessageId` before takeover, fixing pool-to-flow owner handoff.
- The composer's provider-qualified model selection is now authoritative: entering a conversation restores its remembered deployment, and the send binds the visible model to the exact target after activation. A queued Next freezes the model selected when it was accepted.
- Normal replies no longer send a client-side `max_tokens`/`max_output_tokens` cap. Provider-owned output limits are respected; protocols that require a positive value resolve one internally. Mobile output-budget exhaustion preserves the partial answer and marks the run incomplete instead of discarding progress.
- The first-turn title/model-availability gate publishes an immediate status event and fails fast on deterministic 4xx provider errors, naming the actual provider/model.
- Provider-side session caches are branch-scoped (`conversationId::branch:<branchId>`); each model request records its owning branch and a SHA-256 `contextHash`.
- Bound Desktop and Android versions to 0.6.3 / Android version code 603.

### Validation and limits

- Desktop core verification: 1717 assertions passed. Continuation store: 23/23. Queue identity: 61/61. Shared command/Flow handoff: 51/51. Runtime isolation, model switch (4/4), conversation history-first (24 assertions), provider identity/model validation/Auto routing and the desktop compression/cache suites passed.
- Dynamic multi-level compression and cache: context system stress 1461/1461, cache-hit stress 39/39, thinking-tier cache stress 68/68, compression pressure 34/34, compression fidelity 8/8; context budget, compression API and context system v2 verification passed.
- Android release build passed; the APK is `com.newmark.mobile` 0.6.3/603 with the existing development signing identity.
- The Windows MSI was installed locally and independently verified: registry 0.6.3.0, installed CLI 0.6.3, `resources/app.asar` SHA-256 `799E1753DD05CADD20B633252FB285DF3CF03A7E11237DA188C2C9AA83A0C5D3`, 292 payload files. Post-install GUI runtime verification remains a separate boundary.
- The monolithic `test:full-release` chain is currently blocked by a pre-existing hang in `test-subagent-settlement-receipts.cjs`; the queue/compression-related gates listed above were run separately. The packaged SSH TUI stress is skipped in CI by the workflow's explicit environment boundary. Linux and Android release assets are built by the tag workflow; macOS and native HarmonyOS packages are not included.
- Windows binaries are not Authenticode-signed. Android uses development signing for sideloading, not Google Play production distribution.

### Downloads

Windows x64 MSI and portable ZIP; Linux x86-64 AppImage, amd64 deb and portable ZIP; Android APK. This is the project's established six-asset platform matrix. npm distributes the CLI/TUI separately.

## 简体中文

### 更新内容

- 用工作区级权威接续 ledger（`GuardedContinuationStore`）替换不可靠的进程内对话队列归属。入队是带幂等回执的 CAS 事务，workspace/root/branch/parent/初始输入在受理时固定；BranchGuard/attempt/fence、唯一 final、head/tail 分离、依赖阻断、分叉 lineage 校验和 append-only 事件全部生效。

- 排队 Next 现在是同会话的新用户 Build：上一个 Build 完整结束后分配新 runId、恢复入队时捕获的分支，并追加普通用户轮次。Guide 仍内联干预当前 Build。目标身份与执行 runtime 不匹配的排队行会暂停，不会改投当前前台对话。
- 受理后的队列重排被拒绝，因为静默重排会改变固定 parent；需要改序必须显式取消后以新命令重新提交。
- Flow 现在是权威外部 build：命令受理时入队，启动时 claim attempt/fence，挂起时 requeue，完成时 commit。`beginExternalRun` 接管前按 `clientMessageId` 合并已持久化的队列 continuation，修复 pool→flow owner handoff。
- 输入框下方的 provider-qualified 模型选择现在是权威的：进入对话恢复该对话记忆的部署，发送在激活完成后把可见模型绑定到精确目标；排队 Next 冻结受理时选择的模型。
- 正常回复不再发送客户端 `max_tokens`/`max_output_tokens` 上限，由供应商决定真实输出上限；必须正数的协议内部解析。移动端预算耗尽时保留部分答案并标记未完成，不再丢弃进度。
- 首轮标题/模型可用性门禁立即发布可见状态，对确定性 4xx 供应商错误快速失败，并写出实际 provider/model。
- provider session 缓存按分支隔离（`conversationId::branch:<branchId>`）；每次模型请求记录所属分支与实际 payload 的 SHA-256 `contextHash`。
- Desktop/Android 版本统一为 0.6.3，Android versionCode 为 603。

### 验证与边界

- PC 主验证 1717 项通过；接续存储 23/23；队列身份 61/61；共享命令/Flow handoff 51/51；运行时隔离、模型切换 4/4、历史优先 24 项、provider 身份/模型校验/Auto 路由及 PC 压缩缓存套件全部通过。
- 动态多级压缩与缓存：context system stress 1461/1461、cache-hit stress 39/39、thinking-tier cache stress 68/68、compression pressure 34/34、compression fidelity 8/8；context budget、compression API、context system v2 均通过。
- Android Release 构建通过；APK 为 `com.newmark.mobile` 0.6.3/603，沿用现有开发签名身份。
- Windows MSI 已在本机安装并独立复核：注册表 0.6.3.0、安装目录 CLI 0.6.3、`resources/app.asar` SHA-256 `799E1753DD05CADD20B633252FB285DF3CF03A7E11237DA188C2C9AA83A0C5D3`、292 个 payload 文件。安装后 GUI 运行验收仍是独立边界。
- `test:full-release` 全链当前被既有的 `test-subagent-settlement-receipts.cjs` 挂起阻塞；上述队列/压缩相关门禁已单独执行。打包后 SSH TUI 压力按 workflow 的显式 CI 环境边界跳过。Linux 与 Android 发行资产由 tag workflow 构建；不包含 macOS 或原生 HarmonyOS 包。
- Windows 未做 Authenticode 签名；Android 使用开发签名用于侧载，不是 Google Play 正式签名包。

### 下载与签名

Windows x64 MSI、便携 ZIP；Linux x86-64 AppImage、amd64 deb、便携 ZIP；Android APK，共六项。沿用现有平台矩阵。CLI/TUI 另通过 npm 分发。
