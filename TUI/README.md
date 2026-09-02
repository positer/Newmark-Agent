# Newmark Agent TUI

Newmark 的终端界面现已默认加载仓库中已有的 `DESKTOP/dist/core`，并使用与 GUI、CLI 相同的 `~/.Newmark` 运行时根、Workspace 清单、Conversation 存储、Agent、Memory Lab、Provider/Model 配置、Tools、Automation 和 Archive 数据。

启动时以终端的当前目录作为工作区：

- 当前路径已登记：选中已有 Workspace，并恢复它上次使用的 Conversation。
- 当前路径未登记：调用 Newmark 现有 `addExternalWorkspace(path)` 建立稳定 Workspace ID，并写入共享的 `External.json`。
- 不复制或移动当前目录。
- `~/.Newmark` 内部的配置目录不能被登记为外部 Workspace；应在实际项目目录启动。

## 运行

全局命令：

```powershell
Newmark --TUI
```

命令会保留调用位置的当前目录，并将它选为或登记为 Workspace。当前源码工作区通过 `DESKTOP/package.json` 的 npm bin 注册；重新构建后可在 `DESKTOP` 执行 `npm.cmd link` 刷新当前用户命令。

直接入口：

在任意项目目录中，直接指向本目录的入口：

```powershell
node ".\TUI\bin\newmark-tui.js"
```

也可显式指定运行时根和工作区：

```powershell
node ".\TUI\bin\newmark-tui.js" `
  --root "$HOME\.Newmark" `
  --workspace (Get-Location).Path
```

在 TUI 目录中运行：

```powershell
npm.cmd start
```

保留完整 Mock 演示：

```powershell
npm.cmd run demo
```

`DESKTOP/src/launcher.ts`、打包 Electron 入口和便携 `newmark.bat` 均已支持大小写不敏感的 `--TUI`。正常 DESKTOP build 会把 TUI 复制到 `dist/tui`，安装产物通过原有 `dist/**/*` 打包规则携带它。

## 已真实接入

- 当前目录 Workspace 的查找、新建、切换和持久化。
- Conversation 列表、激活、创建、消息发送与快照持久化。
- 每个 Conversation 自身的 Goal、Plan、Linked Plan、Subagents、Messages、Work Runs、Model 和 Flow 选择。
- 每个运行中的 Conversation 使用目标绑定 Core runner；切换专注不打断后台工作，后台完成不抢回前台。
- 动态 Workspace 子菜单，仅在最后进入的 Conversation 存在相应内容时显示 Plan、Goal、Subagents、Flow Bar、Flow List 和 Flow Task。
- Memory Lab 的读取、详细关系视图，以及 `/` 启动、Esc 清除的实时 tag 搜索。
- Build Block 中按工具调用位置显示可选择的 `示意图`；折叠后仍在 Block 开头按调用顺序保留。未选中时只显示 `[示意图]`，光标停在图片行时才延伸显示图片描述与 `Enter 打开`，回车打开独立图片窗口。
- Memory Lab 第一列的 `Overview · 示意图` 是真实入口；Enter 打开仅含总览关系图的小窗口，不加载主 GUI 或其他组件。
- Provider 启停、Model 启停与真实 Provider 验证。
- General、Personalization、Runtime、Tools 设置写回共享 `config.json`。
- General / Input mode 以真正的 Guide/Next 列表选择默认回车行为；确认后绑定当前 Conversation runtime，并写回共享 `general.default_input`。
- 字体、字体颜色、背景颜色与主题的 TUI 应用；实际字体族仍由终端宿主决定。
- Automation 内容区首项可新建绑定当前 Workspace/Conversation 的真实自动化，并支持清单与暂停/恢复。
- Operation 保持单层；同级 `WorkFlow` 内容区列出、展开并新建由现有 FlowEngine 持久化的工作流。
- Archive 清单、版本信息与 GitHub 更新检查。
- `--demo` 隔离模式，保留多个 Workspace 和各不相同的 Conversation/Goal/Plan/Subagent 场景。

## 共享语义

TUI 使用和现有 GUI/CLI 相同的 Newmark Core 与 `~/.Newmark` 持久化格式，所以重启后能互相看到 Workspace、Conversation、设置、Memory Lab 和 Automation 数据。

当前 GUI 的 Electron Utility Runtime 是进程内宿主，并没有公开为任意终端可连接的常驻 IPC 服务。因此 GUI/TUI/CLI 共享 Core、Workspace、Conversation 与原子持久化后端，但不是同一个内存中的 `Agent` 实例。`test:gui-tui-cli-stress` 已验证 18 个并行隔离 Conversation、三端同一 Conversation roundtrip 和逐会话模型隔离；跨客户端同一 Work Run 的实时事件广播仍需要公共 Runtime IPC。

## 键盘模型

| 键位 | 操作 |
| --- | --- |
| `↑` / `↓` | 菜单内连续遍历并自动滚动长菜单；Memory Lab 搜索结果内移动；输入首行 ↑ 进入 Build Block 历史，历史顶部继续 ↑ 跟随光标上滚；仅输入末行继续 ↓ 向较新历史滚动 |
| `/` | 在 Memory Lab 启动 tag 搜索；输入实时过滤，Enter 跟随，Esc 清除 |
| `Enter` | 展开/折叠 Workspace、进入子项；选中 Conversation 时直接进入编辑；General / Input mode 中打开 Guide/Next 列表并确认 |
| `←` / `→` | 移动内容列；仅从内容最左列返回菜单 |
| `Tab` | 编辑态返回 Conversation 选择并保留草稿；普通内容返回菜单 |
| `Shift+Tab` | 编辑态循环 Build → Plan → Goal → Flow；Flow 强制选择工作流 |
| `Shift+Enter` | 编辑输入区插入换行；Enter 仍发送 |
| 历史区 `Enter` | Build 标题上展开/收起公开进度；`示意图` 行上打开独立图片窗口。执行时间、启动输入、Guide、折叠态图片和最终总结始终显示 |
| `Esc` | 当前运行 Conversation 的第一段停止；再次按下强制停止 |
| `N` | 在当前 Workspace 新建 Conversation |
| `T` | Conversation 选择态置顶/取消置顶并跟随 ID；其他位置切换主题 |
| `V` | 验证 Settings / Models 当前模型 |
| `O` / `R` | 打开/刷新全局配置 |
| `L` | 列出 Archive |
| `U` | 检查更新 |
| `Ctrl+K` | 命令面板 |
| `?` | 帮助 |
| `Q` / `Ctrl+C` | 退出 |

## 终端分区与换行

渲染器按终端显示列宽处理 ASCII、中文、全角字符、组合字符和 Emoji。Conversation 消息在内容栏宽度内主动分行，续行保持角色列缩进；终端不会再把超长中文从屏幕第 1 列续写到 Workspace 区域。侧栏使用固定头尾与可滚动菜单视口，光标始终留在可见范围。对话历史使用扣除标题、状态和输入区后的动态高度，并始终为编辑输入框保留两行；多行输入视口跟随光标。输入首行继续向上会进入基于 `snapshot.workRuns` 的 Build Block 光标。每个 `runId` 严格按 GUI 时间线组成“启动输入 → 可折叠 Build Block（常显执行时间）→ 常显最终总结”；展开时 Guide 按事件顺序位于 Block 内，折叠时 Guide 仍留在标题之后、总结之前。折叠只隐藏已持久化的公开进度与工具事件，展开状态通过现有 `setWorkRunExpanded` 后端持久化。

## 验证

```powershell
npm.cmd test
```

55 项测试同时覆盖 Mock 全交互回归、Build `示意图` 折叠/展开位置与 Enter viewer、Memory Lab Overview viewer/tag 搜索、逐 Conversation 模型标题、绘制请求合并/同帧抑制、缺色/低对比度亮色回归与隔离真实 Core 冒烟：后者会在 `TUI/test` 下创建临时 runtime/workspace，验证当前目录登记、真实快照、Flow 选择/创建持久化、Guide/Next 默认回车模式的共享配置重启恢复、Automation 创建、Memory Lab 和 Provider 密钥保留边界，然后安全删除临时目录，不发送模型请求。
