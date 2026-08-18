# dev-0.3.13 黑盒交叉压力测试任务

## 2026-08-18 移动端对话记录 WorkRun 同构（dev-0.4.33）

- [x] 以 PC `renderWorkRunEvents` 落地本地/远程统一公开事件投影
- [x] 过滤私密 reasoning/thinking，保留公开 thought、工具、Guide、图片和中断终态
- [x] 修复历史顺序及 final response 重复；本地/远程统一恢复路径
- [x] 完成标题由“构建”改为 PC 一致的“已处理”（运行中为“处理中”）
- [x] 新增投影单元回归，执行 Android 单元测试、Kotlin 编译和 clean assembleDebug
- [x] 安装并启动 APK `0.4.33` / `versionCode=433` 至 `emulator-5554`
- [ ] 网络恢复后对真实远程历史快照进行人工回放验收

## 2026-08-17 移动端 Agent/UI 综合压力测试设计

- [x] 定义本地 Agent 功能压力矩阵：对话、工具、分支、右栏、编辑器、Memory Lab、Flow/SubAgent
- [x] 定义远程触及性矩阵：二维码/相机/图片/手动 URL、LAN/Tailscale/adb reverse、断网/重连
- [x] 定义远程实时交流指标：receipt、首事件、SSE 顺序/去重、状态快照、并发 target 隔离
- [x] 定义持续性压力：30/60 分钟、120 次固定事件、后台/强停恢复、资源回落
- [x] 定义 UI 表现指标：首帧、可交互、jank、帧预算、CPU/PSS/线程、滚动和长列表
- [x] 定义动画稳定性：侧栏、弹窗/加页、marquee、IME、横竖屏/折叠姿态
- [x] 定义多核渲染矩阵：2/4/8 vCPU、硬件/软件渲染诊断、RenderThread/GC/事件积压
- [x] 定义启动速度阈值、P0–P3 判定、采样命令和结构化证据
- [x] 写入 `tasks/plan.md`、本归档与 README/OVERVIEW 维护记录
- [ ] 实现 ADB/PowerShell 采样器和 mock Server
- [ ] 实现 Android UI 自动化与长压脚本
- [ ] 执行 Phase 1–3，生成首份脱敏压力报告

## 移动端适配交付约定

- [x] 本次适配 APK 已安装到 `emulator-5554` 并启动 `com.newmark.mobile`
- [x] 已校验安装版本 `0.4.33` / `versionCode=433`
- [ ] 后续每次移动端适配完成后重复执行构建、安装、启动和版本校验

## 2026-08-17 移动模型菜单与图片二维码配对

- [x] 模型选择二级菜单设置最大高度（`min(320dp, 安全高度 56%)`）
- [x] 模型列表启用上下滚动并绘制可见滚动条
- [x] 相册二维码解码成功后复用 Newmark 配对确认与本机连接流程
- [x] 图片二维码无法识别时显示明确错误，不静默失败

## 2026-08-17 Android 模拟器模型配置同步

- [x] 读取桌面 `~/.Newmark/config.json` 的 `models.providers.value`
- [x] 转换为 Android `ProviderStore` 的 `providers.json` 格式
- [x] 写入模拟器应用私有目录并设置有效激活模型
- [x] 重启应用后校验 4 个 provider、41 个模型且凭据存在
- [x] 清理宿主与设备临时中转文件，输出与归档不包含密钥

## 2026-08-17 移动端接续（dev-0.4.32）

- [x] 移植 PC 右侧栏 Files、Editor、Plan/Linked plan、SubAgent、Browser
- [x] Editor 排除预测随航，其余交互按 PC 同构
- [x] 折叠态改为右缘垂直居中独立按钮，不保留或占用布局列
- [x] 折叠按钮改用 PC 同源 `panel-right` Lucide 图标
- [x] 主页面左滑可展开右侧栏
- [x] 仅竖屏 SubAgent 详情加页，平板/折叠屏保持弹窗
- [x] Memory Lab 平板/折叠屏恢复大弹窗，竖屏保留加页
- [x] 一级 rail 删除本地对话缩略项
- [x] 桌面 build、移动 API 38/38、桌面 verify 1641/1641、Android clean build
- [x] 平板/竖屏实机验证并恢复模拟器 1080×2400
- [x] 更新 README、OVERVIEW、tasks 与 archive
- [x] 提交 `mobile dev-0.4.32` 并打 `mobile-dev-0.4.32` tag

## 2026-08-17 移动端接续（dev-0.4.31）

- [x] 提取 PC GUI `#left-secondary` DOM、CSS、图标和交互契约
- [x] 重绘 Android `WorkspaceConversationsSidebar` 顶栏、容器和对话行状态
- [x] 补齐 PC Lucide 图标与 Newmark 菜单/运行态表现
- [x] 竖屏一级栏完全退出后二级栏进入，实机确认无覆盖
- [x] 接通远程 PC 原生分支树 inspect/activate/create API
- [x] 本地对话持久化分支数量、分页切换与历史编辑分叉
- [x] 恢复用户输入/Agent 回复两侧连续时间线竖线
- [x] 修复本地 `2/2` 上一页祖先节点误判并实机验证 `1/2`
- [x] 桌面总回归、Android clean 编译、安装和版本检查
- [x] 更新 README、OVERVIEW、tasks 与 archive
- [x] 提交 `mobile dev-0.4.31` 并打 `mobile-dev-0.4.31` tag

- [x] A1：黑盒能力发现（真实安装/打包目录、GUI/TUI/CLI/Runtime、help/version/未知参数；观察到安装包为 0.3.12，与 0.3.13 候选不一致）
- [x] A2：建立隔离临时根和单入口冷启动基线（Temp 中文/空格根、GUI/TUI/CLI 原始输出；进程已清理）
- [ ] B1：GUI 独立压力（只完成输入/新会话子路径；Build、Flow、归档、压缩、Copilot、重启未完成）
- [ ] B2：TUI 独立压力（Console/CLI/script PTY 子路径有证据；GUI exe TUI timeout，明亮/UTF-8/恢复闭环未完成）
- [ ] B3：CLI 独立压力（help/state/坏模型/未知 tool 有输出；退出码、归档/压缩/会话未完成）
- [ ] C1：GUI↔TUI、GUI↔CLI、TUI↔CLI 共享后端交叉
- [ ] C2：GUI+TUI+CLI 同时运行的 target/锁/事件一致性
- [ ] C3：Flow/Build/压缩/归档/恢复/切换的高风险三元交叉 X01–X08
- [ ] C4：Provider 失败与 Copilot/生命周期交叉 X09–X11
- [ ] D1：连续 30–60 分钟或固定事件数压力、资源采样、冷启动恢复
- [ ] D2：重复失败用例最小化并重放 3 次
- [x] E1：脱敏结构化报告、进程/文件清洁证据、未覆盖项（INCOMPLETE/HOLD；两个代理未返回，主线程依据 Temp 原始证据整理）
- [ ] E2：无 P0/P1、全部高风险交叉明确通过后才进入下一轮包门禁判断

## 2026-08-13 续测结果

- [x] 候选包：`release/win-unpacked`、MSI、ZIP 均为 `0.3.13`；两个残留 `0.3.12` 版本断言已改为动态读取包版本。
- [x] 候选包安全门禁：28-case safe black-box、CLI、context-compress CLI、共享根重启、启动恢复、原生编辑器、快速会话切换、队列/计划、多窗口共享后端、Flow 暂停/继续/运行中归档、TUI viewer 均通过。
- [x] 进程收尾：本轮 Newmark/Electron 进程归零；续批 Temp 根保留原始证据，不触碰用户配置和 Program Files。
- [ ] 黑盒闭环仍未完成：此前 GUI/Flow、TUI/CLI 交错、压缩/cache/Copilot 三个批次被旧流程的人工硬截止截断，统一只计历史 `INCOMPLETE`，不作为产品结论；已改为自然完成批次重新执行。
- [ ] Copilot latency：真实候选包没有可选择的 GitHub Copilot 模型，仅能记录环境阻断，不能宣称 `No completion` 优化通过。
- [ ] 发布结论：继续保持 `INCOMPLETE/HOLD`，不得申请 MSI 全局 UAC 安装；需补齐黑盒员结构化报告、真实 TUI/CLI 交错、压缩/cache 阈值观测、Copilot 可用模型延迟和固定事件数长压/三次重放。

## 全场景交叉设计与本轮派发（2026-08-13）

- [x] 以入口传输、工作状态、上下文/模型、持久化动作、生命周期/资源五层重建交叉模型。
- [x] 定义 X01–X12 高风险序列，拆分 Batch-G、Batch-T、Batch-C、Batch-E，写入 `archive/20260813-dev-0.3.13-full-cross-scenario-design.md`。
- [x] 四批历史上均使用 `gpt-5.6-luna/max`、真实 `0.3.13` 候选包、隔离 Temp root 和结构化报告契约；其中的人工硬截止已废弃，不再作为当前测试规则。
- [ ] Batch-G：GUI Flow/Build/归档/恢复/无模型结构化报告未返回，计 `INCOMPLETE`。
- [ ] Batch-T：TUI/CLI/共享后端结构化报告未返回，计 `INCOMPLETE`。
- [ ] Batch-C：70%/20% 压缩、cache、prompt、Copilot 结构化报告未返回，计 `INCOMPLETE`。
- [ ] Batch-E：固定事件耐久/资源回落/三次重放结构化报告未返回，计 `INCOMPLETE`。
- [x] 所有命令行指向候选包的 Newmark/Electron 测试进程已精确清理；Batch 临时根保留原始证据。
- [ ] 发布门禁仍为 `INCOMPLETE/HOLD`，不申请 UAC；需解决黑盒批次可靠收口后逐个补齐 X01–X12。

## 2026-08-13 黑盒自然完成修复批次

- [x] 复现并修复 `D-HELP-001`：GUI/Console Wrapper 的命令级 `send --help` 和参数前后顺序均在 Electron/Agent 初始化前直接输出帮助并退出，不再误进入 GUI/runtime。
- [x] 复现并修复 `D-ROOT-001`：显式 `--root` 同时绑定 Electron `userData`、`sessionData`、Chromium `--user-data-dir`；启动失败日志跟随解析后的临时根；GUI 直启与 Console Wrapper 均有回归门禁。
- [x] 真实候选包重建：Builder 自带 SSH/TUI、CLI、上下文压缩、Console Wrapper 边界、MSI/ZIP 生成全部通过；独立安全黑盒 `28` case、帮助顺序 8 variants、GUI/Wrapper 根隔离、进程清理和用户配置不变全部通过。
- [ ] Nash：全新上下文 `gpt-5.6-luna/max`，无 README/源码、无人工硬截止，正在执行 X01–X12 自然完成交叉压力；未收到结构化终态前不计 Clear。

## Checkpoint

- 阶段 A/B 完成后：入口和能力边界可复现，失败不被误归因。
- 阶段 C 完成后：共享后端没有 target 串线、归档复活、Flow 残留或压缩覆盖。
- 阶段 D/E 完成后：资源回落、重启可恢复、报告可审计；否则保持 HOLD。
