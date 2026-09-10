# Newmark Agent dev-0.6.4

## English

### Changes

- Branch conversation identity is now one rule shared by every kind of branch: user pagination edits and the experimental branch-communication `branch_create` both go through `Agent.branchConversation`, mint a brand-new node id (`assertFreshBranchIdentity`), and use `branchConversationIdentity(conversationId, branchNodeId)` = `<conversationId>::branch:<branchNodeId>`. Provider session sequence ids bind to the Build's owning branch (`activeWorkRunBranchId`), never to the branch that happens to be active; folded compression history is scoped per branch node and merged on persist.
- PC branch pagination: the pager anchor resolves by message id, then rendered message index, then anchor text, so editing the user input that starts a Build renders the pager correctly. Transcript and Build caches are keyed by branch node, so a sibling page can no longer overwrite the messages of the page you are viewing.
- Queue rows stay visible but never leak into the wait state: the queue panel lists every row of the conversation, new rows auto-expand the panel, and rows bound to another page are marked as waiting instead of being hidden or silently rebound. `rebindQueueToRuntimeBranch` no longer rewrites the admitted `branchPath`.
- A failed admitted Build no longer wedges the queue. Blockage is derived from the parent chain on every read (rows admitted after the failure are reported with `DEPENDENCY_FAILED`), blocked rows are marked in the panel, and an explicit "Repair blocked queue" action re-anchors them to the last committed Build with one `BuildQueueRepaired` audit event per re-anchor. Resume alone keeps the 0.6.3 contract: a failed predecessor still blocks its successors, nothing is silently skipped.
- Queued turns that enter the conversation are user input: a drained queued row is shown in the conversation area as a normal user message (with the assistant reply), while queued rows that have not entered are shown only in the queue panel. Continuous queue entries are preserved (multiple Next rows run one after another).
- Guides in the timeline are read-only records: one-click copy only, no inline edit. A Guide is displayed only after the kernel accepts it, at its acceptance position; optimistic/awaiting-ack, deferred and rejected Guides stay out of the conversation area.
- Option questions are owned by the conversation that asked them: a background conversation's question no longer renders into the active conversation, and answering a question that belongs to another conversation is refused instead of being sent into the foreground target.
- The goal display is cleared when the goal completes or stops: the renderer re-applies the authoritative goal state on terminal events and on any snapshot carrying a `goal` field, clearing text, visibility and the paused state.

### Validation and limits

- Desktop verification: main `verify.js` suite green; `branchPageQueueIdentityVerify` (real `Agent.branchConversation`: fresh node id, split provider session identity, Build owner branch), `queueBlockedRepairVerify` (blocked-chain reproduction, repair, ordered commit, audit events, idempotence), `guideUiReconcileVerify`, `conversationHistoryFirstVerify`, `continuationStoreVerify`, `queueDrainUserMessageVerify`, `queueAttachmentIsolationVerify` (renderer commands 57/57), `runtimeIsolationVerify`, `test-shared-conversation-commands.cjs` (51/51), `test-queue-start-failure.cjs`, `test-queue-acceptance-boundary.cjs`, `test-queue-continuation-identity.cjs`, `test-long-conversation-ui-ordering.cjs` (18/18), `test-build-continuity-ui.cjs`.
- Real-machine UI gates on the installed build (isolated root): queued rows appear in the panel and not in the transcript, pause/resume round-trips, drained turns show the user input plus the model reply (`seq1:SUCCEEDED seq2:SUCCEEDED`), blocked rows show `DEPENDENCY_FAILED` with the repair button, and a background conversation's option question is neither rendered into the active chat nor answerable from it.
- The Windows MSI was installed locally and independently verified: registry `0.6.4.0`, installed CLI `0.6.4`, installed `resources/app.asar` byte-identical to the packaged archive, 292 payload entries verified.
- The bundled renderer no longer paints un-entered queued input inline and no longer exposes Guide editing; both are intentional product rules of this release.
- `dev-0.6.4` tag-driven CI builds Windows, Linux and Android assets on the release matrix; macOS and native HarmonyOS packages are not part of this matrix. Windows binaries are not Authenticode-signed and Android uses the project's development signing identity for sideloading, not Google Play distribution.

### Downloads

Windows x64 MSI and portable ZIP; Linux x86-64 AppImage, amd64 deb and portable ZIP; Android APK. This is the project's established six-asset platform matrix. npm distributes the CLI/TUI separately as `newmark-agent`.

## 简体中文

### 更新内容

- 分支身份统一为一条规则：用户分页编辑与实验性分支交流 `branch_create` 都走 `Agent.branchConversation`，都必须拿到全新节点 id（`assertFreshBranchIdentity`），并使用 `branchConversationIdentity(conversationId, branchNodeId)` = `<conversationId>::branch:<branchNodeId>`。供应商会话序列 id 绑定 Build 所属分支（`activeWorkRunBranchId`），不再读取“当前恰好激活的分支”；折叠压缩历史按分支节点隔离并在持久化时合并。
- PC 分页：分页锚点按 message id → 渲染索引 → 锚点文本三级回退，因此“从 Build 开头编辑输入”也能正确显示分页条；转录与 Build 缓存按分支节点键隔离，兄弟分页不再覆盖你正在浏览的那一页。
- 排队行保持可见但不越界：队列面板列出会话内全部排队行，新行自动展开面板，绑定到其它分页的行标记为“等待所属分页”而不是被隐藏或静默改绑；`rebindQueueToRuntimeBranch` 不再改写受理时捕获的 `branchPath`。
- 失败的已受理 Build 不再把队列钉死：受阻状态按父链在每次读取时推导（失败之后才入队的行也会显示 `DEPENDENCY_FAILED`），面板标记受阻行，并提供显式的“修复受阻队列”动作把受阻行重新挂到最后一个已提交 Build，每次改挂写入一条 `BuildQueueRepaired` 审计事件。单独“恢复”仍保持 0.6.3 合约：失败前置继续阻断后继，不静默跳过。
- 进入对话的排队回合就是用户输入：出队的排队行以普通用户消息出现在对话区（并带助手回复）；尚未进入的排队内容只显示在队列面板。连续出队保持正确（多条 Next 依次执行）。
- 时间线中的 Guide 为只读记录：仅一键复制，无内联编辑。Guide 只有被内核接受后才显示，并显示在接收位置；乐观/待确认、deferred、rejected 的 Guide 不进入对话区。
- 选项提问归属提问的会话：后台会话的提问不再渲染到当前对话，对不属于当前会话的提问作答会被拒绝，而不是发进前台目标。
- goal 完成或停止时清除前端显示：渲染端在终端事件以及任何携带 `goal` 字段的权威快照上重新应用 goal 状态，同时清除文本、可见性与暂停态。

### 验证与边界

- PC 验证：主 `verify.js` 套件通过；`branchPageQueueIdentityVerify`（真实 `Agent.branchConversation`：新节点 id、分支间供应商会话身份完全分割、Build 绑定自身分支）、`queueBlockedRepairVerify`（复现受阻链 → 修复 → 顺序提交 + 审计事件 + 幂等）、`guideUiReconcileVerify`、`conversationHistoryFirstVerify`、`continuationStoreVerify`、`queueDrainUserMessageVerify`、`queueAttachmentIsolationVerify`（渲染器命令 57/57）、`runtimeIsolationVerify`、`test-shared-conversation-commands.cjs`（51/51）、`test-queue-start-failure.cjs`、`test-queue-acceptance-boundary.cjs`、`test-queue-continuation-identity.cjs`、`test-long-conversation-ui-ordering.cjs`（18/18）、`test-build-continuity-ui.cjs`。
- 已安装构建的实机 UI 门禁（隔离 root）：排队行只出现在面板、暂停/恢复往返正常、出队后用户输入与模型回复都出现在对话区（`seq1:SUCCEEDED seq2:SUCCEEDED`）、受阻行显示 `DEPENDENCY_FAILED` 与修复按钮、后台会话的选项提问既不渲染进前台也无法从前台作答。
- Windows MSI 已在本机安装并独立复核：注册表 `0.6.4.0`、安装目录 CLI `0.6.4`、安装目录 `resources/app.asar` 与打包产物字节一致、292 个 payload 校验通过。
- 渲染端不再内联绘制未进入对话的排队内容、也不再提供 Guide 编辑入口，两者都是本版本的既定产品规则。
- `dev-0.6.4` tag 驱动的 CI 在发布矩阵上构建 Windows、Linux、Android 资产；macOS 与原生 HarmonyOS 包不在该矩阵内。Windows 未做 Authenticode 签名，Android 使用项目开发签名用于侧载，不是 Google Play 正式签名包。

### 下载与签名

Windows x64 MSI 与便携 ZIP；Linux x86-64 AppImage、amd64 deb 与便携 ZIP；Android APK，共六项，沿用既有平台矩阵。CLI/TUI 另通过 npm 以 `newmark-agent` 分发。
