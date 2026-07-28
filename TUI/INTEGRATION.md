# Newmark TUI Integration

## 当前真实运行方式

`core-runtime-adapter.js` 延迟加载现有 `DESKTOP/dist/core`：

```text
Agent(root)
MemoryLabManager(root, language)
AutomationManager(agent.config, hostOwnedRunner)
```

默认 `root = ~/.Newmark`，默认 `workspacePath = process.cwd()`。adapter 先按规范化绝对路径查找现有内部/外部 Workspace；命中后调用 `selectWorkspaceFromStorage(id)`，未命中则调用 `addExternalWorkspace(workspacePath)`。由现有 WorkspaceManager 负责稳定 ID、`External.json`、`State.json` 和 Workspace Conversation 状态。

## 已映射的现有实现

| TUI 能力 | Newmark 实现 |
| --- | --- |
| Workspace 查找/登记/切换 | `core/workspace.ts`、`Agent.addExternalWorkspace()`、`selectWorkspaceFromStorage()` |
| Conversation 快照/激活/新建/发送 | `getConversationSnapshot()`、`setConversation*()`、`process()` |
| Conversation Pin / Model / Mode / Flow | `setConversationPinned()`、`setModel(..., true)`、`setMode()`、`setConversationFlow()` |
| Plan / Linked Plan / Goal | `getConversationPlan()`、`updateConversationPlan()`、Goal 方法 |
| Subagent / Work Run / Queue | `ConversationSnapshot` |
| Memory Lab 详细 | `MemoryLabManager.read()`、`visualizationSnapshot()`、`reindex()` |
| Provider / Model | `ConfigManager.providers()`、`updateProviders()`、`validateModels()` |
| Tools | `nativeToolEnabled()` 与 `tools.enabled` |
| Automation | `AutomationManager.list/create/toggle/delete` |
| General / Personalization / Runtime | `ConfigManager.set/save/reload` |
| Archive | `Agent.listArchives()` |
| Update | `core/installUpdate.ts` |

真实模式不会把 API Key 回填到 TUI 状态；Provider 映射只暴露 `has_api_key`。

## `Newmark --TUI` 宿主接入

宿主接入已经完成：

1. `DESKTOP/src/launcher.ts` 和 `DESKTOP/src/main.ts` 在其他 CLI/GUI 分支前检测大小写不敏感的 `--tui`，传递规范化 root、`process.cwd()` 和当前 `dist`。
2. `DESKTOP/scripts/build-tui.cjs` 在正常 build 中把 `TUI/bin`、`TUI/src` 和 package metadata 复制到 `DESKTOP/dist/tui`。
3. `DESKTOP/newmark.bat` 保持 TUI 附着当前终端并转发参数。
4. `DESKTOP/package.json` 的 `newmark` bin 指向带 Node hashbang 的 `dist/launcher.js`。
5. 当前用户已经执行 `npm.cmd link`；PowerShell 中的 `Newmark` 解析到 npm 全局目录。
6. 系统临时项目目录中的字面 `Newmark --TUI` 已通过 ConPTY：cwd 可见、Workspace 已登记、退出码为 0。

## 共享后端的准确边界

当前 TUI 与 GUI、CLI：

- 共用 Newmark Core 代码；
- 共用 `~/.Newmark`、Workspace、Conversation、Memory Lab、Config、Automation 和 Archive 格式；
- 能在进程重启后读取彼此的持久化结果。
- TUI 内部为每个运行中的 Conversation 保留独立 Core runner，切换前台专注不会终止另一个 TUI Conversation。

`test:gui-tui-cli-stress` 已验证 18 个并行隔离 Conversation、GUI 后端/TUI/CLI 对同一 Conversation 的顺序 roundtrip、逐会话模型隔离和 21 次本地 Provider 请求。该门验证共享 Core 与原子持久化，不把 Electron 内部 Utility Runtime 误描述为外部公共 IPC。

当前三端仍各自构造 `Agent`。Electron 的 Conversation Utility Runtime 由 `utilityProcess.fork()` 管理，只服务 Electron 主进程，没有稳定的外部地址、认证/握手和跨客户端锁。因此以下能力尚不能声称为“同一在线后端实例”：

- GUI 与 TUI 同时运行时的单一 processing lock；
- 同一 Work Run 的实时事件广播；
- 跨客户端 stop、steering、follow-up 和 approval；
- 内存中尚未落盘状态的即时一致性。

完整方案应把 Electron Utility Runtime 抽成公共 Newmark Runtime Host，并让 GUI、CLI、TUI 都通过同一 IPC 协议发送带 `{workspaceId, conversationId, runId, generation}` 的请求；宿主独占持久化写入与运行锁，客户端只渲染快照和事件。

## Adapter 边界

`newmark-contract.js` 验证 ConversationTarget、Snapshot、Plan、Subagent 状态和宿主方法。当前三种 adapter：

- `core-runtime-adapter`：终端正式模式，直接调用已有 Core。
- `desktop-preload-adapter`：保留现有 Electron preload 参数形状，为未来公共宿主或嵌入式 TUI 使用。
- `mock-newmark-adapter`：`--demo` 隔离演示。

UI 层不直接读取 `~/.Newmark` 文件，也不重新实现 Workspace/Conversation 存储。

## 仍待接入的实时交互

- Work Event 流式输出。
- Tool approval、停止、steering/follow-up。
- Subagent mailbox 与运行控制。
- Archive read/restore/delete 的完整 UI。
- Automation 创建/删除编辑表单。
- Update apply/install 的确认与进度 UI。
- 公共 Runtime IPC 与多客户端冲突处理。
