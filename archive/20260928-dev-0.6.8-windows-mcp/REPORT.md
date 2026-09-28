# dev-0.6.8 Windows-MCP 调研与 ComputerUse 原生化

- 日期：2026-09-28
- 状态：0.6.8 增量已合并到 `master`；Windows GUI 验收与发布构建待完成
- 开发分支：`codex/dev-0.6.8-windows-mcp`
- 目标：将 Windows-MCP 值得借鉴的截图、UIA 观察和等待交互融入 Newmark ComputerUse，不接入独立 MCP 服务。

## 发布隔离与操作留痕

开发开始时，0.6.7 主工作区含有大量未提交发布改动，`VERSION` 与 Desktop package 已标记 0.6.7。本轮先在独立 managed worktree 中以当时的发布快照为开发基线；0.6.7 完成发布后，主分支在提交 `b0e687de66a9d41c2b1eb3c10ae1302de1d39a56` 定版。本次从开发快照中提取 0.6.8 增量，基于 0.6.7 发布提交做合并，未把旧工作树的 0.6.7 文件快照覆盖回主分支。

生成 Git stash 快照时遇到主仓库的 `.git/index.lock`；检查时未发现 Git 进程，锁文件时间为 2026-09-26。本轮保留该锁文件，改为把 `git diff --binary HEAD` 导出到系统临时目录并应用到新 worktree。临时补丁名称为 `newmark-dev-0.6.7-working-tree.patch`，合并收尾时会删除。

0.6.8 worktree 中的版本标记已改为 Desktop/根版本 `0.6.8`、Android `versionName=0.6.8` 与 `versionCode=608`。Android 业务代码没有改动。

## Windows-MCP 一手资料要点

调研以 [CursorTouch/Windows-MCP README](https://github.com/CursorTouch/Windows-MCP)、其 [Snapshot/Screenshot 工具](https://github.com/CursorTouch/Windows-MCP/blob/main/src/windows_mcp/tools/snapshot.py)、[截图与 UIA 组合实现](https://github.com/CursorTouch/Windows-MCP/blob/main/src/windows_mcp/tools/_snapshot_helpers.py) 为主：

1. `Screenshot` 是偏快速的截图入口，会跳过 UIA 树；`Snapshot` 为需要控件和滚动元素的场景采集完整状态。
2. `WaitFor` 在一次工具调用内轮询文本、活动窗口或控件是否出现，减少固定延时后重复取快照。
3. UIA 信息要保留窗口、控件和坐标上下文；图片则按单独的视觉输入路径处理。
4. 其公开 README 标注 MIT License。本次没有复制 Windows-MCP 代码或引入它的 Python、UV、MCP 服务依赖，只移植适合 Newmark 现有架构的行为模式。

安全边界参考 Windows-MCP 的 [Electron UIA 卡死问题 #383](https://github.com/CursorTouch/Windows-MCP/issues/383)。该问题报告了深度访问其他 Electron 窗口可能令宿主 UI 卡住；这是已报告的故障场景，不代表每台机器都会复现。Newmark 因而不对缺失窗口句柄回退桌面根节点深遍历，并跳过窗口进程 PID 等于 Electron 宿主 PID 的 UIA 树采集。

## 当前实现

- `DESKTOP/src/tools/computerUse.ts`
  - `observe` 与 `app_observe` 新增 `includeUiTree` 路径。默认行为保留截图加 UIA 语义对象；设为 `false` 时跳过子控件树采集，仍通过既有一次性视觉输入返回截图，并清空上次 `target_id` 缓存。桌面 `observe` 同时跳过应用枚举；`app_observe` 按 `app_target` 选择窗口时仍需顶层窗口枚举，传入有效 `window_handle` 时直接按句柄查找。
  - UIA 只接受有效窗口句柄；前台句柄无效时不遍历 `AutomationElement.RootElement`。对 Newmark 宿主 PID 的窗口跳过 UIA 树。
  - 新增 `wait_for`：可在最近观察窗口或 `app_target`/`window_handle` 指定窗口内等待 Name/AutomationId 子串、最近观察的 `target_id` 或窗口可见。默认轮询 5 秒、上限 30 秒；命中后刷新同一窗口的语义缓存，后续 `target_id` 动作使用最新坐标。返回命中、超时、取消或 UIA 不可用状态，不附带截图。
  - UIA 树仍受既有 240 个 visited 节点、160 个输出元素和短时 advisory worker 约束。
- `DESKTOP/src/tools/index.ts`：公开两个观察模式及 `wait_for` 参数；工具结果仍经既有 ComputerUse 通道和图片输入生命周期。
- `DESKTOP/src/core/toolPolicy.ts`、`DESKTOP/src/core/computerUseSession.ts`：将 `wait_for` 归类为只读观察，并向 Plan 模式开放。
- `README.md`、`OVERVIEW.md`、`taste.md`：记录当前 0.6.8 功能范围、模块职责和持续设计约束。

## 验证状态与限制

- TypeScript 类型检查：`node node_modules/typescript/bin/tsc --noEmit --incremental false` 退出码 0。隔离 worktree 没有自己的 `node_modules`；检查期间临时链接到 0.6.7 工作区的依赖目录，结束后已移除链接。
- 尚未运行 Windows GUI 场景验证；本轮没有新增 0.6.8 专用测试文件，也未运行测试套件。
- 暂无同负载性能采样，因此不宣称延迟、token 或端到端成功率已有提升。
- `wait_for` 的 `timeout_ms` 限制轮询期限；已在途的 UIA 调用会完成后返回，冷启动 helper 时可能增加一次最多 5 秒的有界尾延迟，热 worker 的 UIA 调用预算为 750 ms。
- `wait_for` 的文本匹配范围是可见 UIA Name/AutomationId；未暴露 UIA 的画布或自绘控件需要截图/视觉路径。
- `wait_for` 只保证条件命中；应用仍应先检查返回观察结果，再授权后续动作。
- 本轮没有增加测试文件。0.6.8 后续验收仍需覆盖截图-only 与语义模式、失效 target、窗口句柄失效、匹配/超时/取消、宿主 PID 排除、Plan 只读权限和真实 Windows GUI 场景。

## 外部引用

- Windows-MCP：<https://github.com/CursorTouch/Windows-MCP>
- Screenshot / Snapshot：<https://github.com/CursorTouch/Windows-MCP/blob/main/src/windows_mcp/tools/snapshot.py>
- Capture helpers：<https://github.com/CursorTouch/Windows-MCP/blob/main/src/windows_mcp/tools/_snapshot_helpers.py>
- Electron UIA deadlock report：<https://github.com/CursorTouch/Windows-MCP/issues/383>
