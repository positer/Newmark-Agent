# Spec: 首次用户输入标题先行硬门禁

## Objective

PC 与 Android 本地新对话收到首条真实用户输入后，先通过当前冻结 provider/model 发起一次独立、无工具、短上下文的标题探测。标题成功生成并受保护地落库后，才允许首次正式 Agent 响应开始。该探测同时验证本轮部署可用性，禁止直接截取用户原文或等待 Agent 完成后再命名。

Android 远程对话复用 PC 后端并由 PC 单点命名，移动端不得重复发起标题请求。

## Required sequence

1. 持久化第一条真实用户消息及稳定 `messageId`。
2. 冻结后续正式响应将使用的 provider、model、intelligence/thinking 配置。
3. 用首条持久化用户输入发起独立标题探测：无工具、无聊天历史、无 Build/Guide/Next、无主 Agent system/bootstrap 缓存前缀，15 秒有界超时与短输出。
4. 清洗标题并拒绝空值、原文照抄、引用/Markdown 前缀和不匹配的迟到结果。
5. 只有标题成功并仍满足工作区、对话、首消息和默认标题守卫时才落库；随后持久化 `firstAgentResponseStarted=true`，再开始首次正式 provider/Agent 请求。
6. 探测失败或超时必须保持正式 provider 调用计数为 0，并显示受控错误。用户在同一对话后续再次发送时，继续以原首条持久化消息重试门禁；第二条文本不得成为标题来源。

## Persistence and compatibility

- `titleRequestMessageId` 固定门禁使用的首条用户消息身份。
- `firstAgentResponseStarted` 仅在标题门禁成功、正式响应即将启动前置为 true。
- 旧数据缺少字段时，已有 Assistant/正式 WorkRun 证据的历史对话迁移为已启动；仅没有任何正式响应证据的会话保持未启动，不得批量命名历史对话。
- 重启、切换对话或工作区后仍从目标会话自身状态恢复，不依赖当前可变选择。
- 用户手动标题始终优先；标题探测成功时若标题已经不是自动默认值，只验证部署可用并继续，不覆盖手动标题。

## Never

- 不把用户输入直接裁切成标题。
- 不从 Agent/Build 最终回复派生自动标题，不做响应后补偿。
- 不在标题失败时启动正式 Agent 请求或伪造成功响应。
- 不把后续发送文本替换成新的标题来源。
- 不把标题请求、错误或输出写入聊天、Build、Guide/Next、正式模型历史或缓存前缀。
- 不发送图片字节；纯附件首输入只使用安全的附件数量/类型摘要。
- 不暴露开发者电脑路径、凭据或供应商密钥。

## Verification

- PC：`npm.cmd run typecheck`、`npm.cmd run build`、`node dist/tests/verify.js`。
- Android：`.\gradlew.bat --no-daemon testDebugUnitTest`；Release/Lint 只在要求打包时执行。
- 失败两次时正式 provider 调用计数保持 0。
- 重启或第二次发送后，标题 prompt 仍只含首条持久化输入。
- 后续标题成功时只放行一次正式响应，并持久化首消息身份与 `firstAgentResponseStarted=true`。
- 手动标题、已删除对话、错误工作区或首消息身份不匹配时，不应用迟到标题。

## Historical note

早期获批的“标题与主 Agent 并行、失败不阻断、首轮后补偿”方案已被用户后续明确要求取代；完整决策演进保存在 `archive/20260901-first-input-conversation-title-spec.md` 与相关时间戳归档中，不再作为现行实现依据。
