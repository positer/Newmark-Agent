# Newmark Agent `dev-0.4.0`

这是 `dev-0.3.14` 之后的下一个开发版本候选。源码包元数据现声明 `0.4.0`；上一个 `dev-0.3.14` 包在通过新的发布门禁前仍是最后验证的已发布产物。

## Included

- **Build 块「进行了思考」活动**：在 Build 块中新增与「编辑了文件」「调用了工具」并行的「思考中 / 进行了思考」活动。对支持 reasoning 的模型（DeepSeek `reasoning_content` / Anthropic `thinking_delta`），推理文本在块内可展开查看，但绝不进入聊天正文与最终回复。空的首个推理 delta 不会误开思考块（对齐 DSH 的 `reasoning.length > 0` 守卫语义）。
- **历史记录卸载延迟生效**：`context_history_manage` 的 `remove` 动作出于缓存优化改为「只卸载长期 log 中的记录」，且调用声明后不立即卸载——记录在当前 Build Block 内保持不动以复用 provider 前缀缓存，Block 结束后才对后续 Block 物理移除；`status` 暴露 `pendingRemovals` 待生效队列。
- **分支交流对话类型**：新增对话类型设置「允许分支交流」，仅可在对话创建时勾选（GUI 复选框 / CLI `--branch-communication` 参数），并在对话列表中显示特殊标记。开启后移除「运行分支唯一性」限制——每个活跃分支单独分配一个运行时并独立维护完整缓存；更换运行分支行为改为「新增运行分支」（`runningNodeIds` 集合），其余交互逻辑不变。
- **分支交流通信工具**：新增仅在该模式下可用的 `branch_list` / `branch_send` / `branch_read` / `branch_create`，可向其他分支发信、读取其他分支行为，并在历史 block 位置主动创建分支（复用 `branchConversation` 机制）。
- **SubAgent 缓存命中优化**：`delegatedPrompt` 移除易变的 `flowPc` 前缀（续跑时缓存前缀稳定）；`sendMessage` 的 mailbox body 截断至 32000（对齐 `sendRootMessage`），避免超大 body 破坏缓存。

## Version boundary

- `DESKTOP/package.json` 与 `DESKTOP/package-lock.json` 声明 `0.4.0`。
- 交叉压力测试编排器更名为 `scripts/dev-0.4.0-cross-stress.cjs`，新增 `branch-communication` 维度；用户端启动器更名为 `scripts/run-dev0.4.0-user-stress.cmd`。
- 本次版本号变更未执行 `dev-0.4.0` 的 MSI、便携包、全局 UAC 安装、Git tag 或远程发布。
- 在将 `dev-0.4.0` 视为可发布前，需重新构建并完整运行发布门禁。

## 备注（后续工作）

- TUI（newmark-tui 0.2.1）源码不在当前工作区，仅有 `dist/tui` 编译产物。TUI 的「允许分支交流」新建对话 UI 开关需在 TUI 源码仓库配合实现；后端已通过 `listConversationStates` 暴露 `branchCommunication` 字段、`setBranchCommunication` 方法，TUI 经 core-runtime-adapter 可自动获得该字段。
- 「每活跃分支独立物理 kernel 并行」的完整运行时池改造（`activeAgentKernelRuntime` 单槽 → 按分支隔离的 Map）为后续工作；当前已实现 `runningNodeIds` 多分支运行语义与分支状态完整保存（history/workRuns/events 切换时精确恢复，保证每分支缓存前缀完整）。
