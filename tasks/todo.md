# dev-0.3.13 黑盒交叉压力测试任务

- [x] 模型二级弹窗按供应商分组，模型行不再重复供应商名称
- [x] 超长模型名保留单行完整内容并可横向滚动查看
- [x] 输入框扩展到五行，六行起内部滚动；固定 24dp R 半径且三枚按钮始终贴底
- [x] 玻璃强度 Slider 实时改变实机边栏/弹窗表现，松手落盘并在进程重启后恢复
- [x] 左栏新增对话 `+` 按钮圆形化
- [x] 单测、Release、lint vital、R8、10 文件保数据安装及 FATAL/ANR/OOM 检查

- [x] 系统暗色启动使用纯黑窗口和黑底白色 Newmark 图标
- [x] 系统亮色启动保持浅灰窗口和黑色 Newmark 图标
- [x] 正式 0.4.54 暗/亮 Splash 实机证据与精确像素验证
- [x] 800 事件 SSE/Queue/Goal/Flow/接管/旧事件防复活续压，无 FATAL/ANR/OOM
- [x] 正式 Release 保数据安装，模拟器恢复暗色、联网与正式应用前台

- [x] 300 远端事件 + 90 UI 循环 + 7,364 帧运行连续性压力
- [x] 本地 Queue/Guide 与 17 工具执行、强停重启哈希连续性
- [x] 3 次远端运行中服务重启后的业务状态恢复
- [x] 移动/PC 交替发送、Flow pause/resume、普通 stop、foreign target rejection
- [x] 运行中主动切换 workspace/conversation 的端到端 UI 故障注入（两轮精确目标读取与 UI 隔离）

- [x] PC 远程触及服务重复启动、异步启动、GUI/TUI 生命周期与端口释放
- [x] 移动端运行中 SSE 断线状态降级、自动重连和目标快照补拉
- [x] 移动先启动/PC 后启动 3 轮冷启动异步连接
- [x] 正式 0.4.54 全量构建、10 文件保数据安装、无 ANR/FATAL/OOM 门禁
- [x] Queue 动画性能门禁按最新要求调整为无卡死/瞬时高压；不再以固定 jank 百分比阻塞

- [x] 修复消息排队顺序拖动中的跳位、回弹与相邻项硬切
- [x] 拖动态复刻 PC 缩放/透明度，取消手势不提交排序
- [x] 20 次远端权威队列重排、完整 Release 门禁和 10 文件保数据安装
- [x] 800 事件远端 Build/Goal/Flow/Queue、重复事件与终态防复活门禁
- [x] Queue 展开/折叠 observer-free 动画不再叠加独立 fade；无崩溃/卡死，jank 数值仅保留诊断

- [x] 移动端 Guide 以 PC 一致方式插入 Build 内用户输入时间线
- [x] Build 折叠后 Guide 保持可见，展开后按事件顺序显示且不重复
- [x] 本地/远端 Guide 生命周期、状态与附件共用统一投影
- [x] 完整构建、保数据安装、实机折叠/展开和崩溃门禁

- [x] 对话区末端增加 10 行（190dp）可滚动余量，供 Queue/Goal/Flow bar/list 避让
- [x] 保持浮层结构与最新消息自动跟随不变，新增几何契约测试
- [x] 完整 Android 单测/Release/R8/lint 与正式包保数据安装、实机验证

- [x] 一级↔二级复合弹窗恢复同一外壳的连续宽高变形动画
- [x] 撤销视觉纵向拉伸，保持紧凑内容高度与内部滚动
- [x] 正式包保数据覆盖安装并前台实机确认
- [x] 旧远端 WorkEvent 缺省字段 Release/R8 兼容

- [x] Prevent a delayed `running/text` SSE event from resurrecting an already completed remote Build.
- [x] Prove the fix with an 800-event stream plus real post-terminal stale-event injection.
- [x] Recheck the button-origin entrance and alpha-only dismissal on formal Release graphics metrics.
- [x] Capture the latest queue expand/collapse animation in a formal Release observer-free graphics window (1,941 frames; no skipped-frame warning or hard stability failure).

- [x] Make both input composite first-level menus visibly grow upward from the exact tapped button instead of appearing instantly.
- [x] Make input composite menus exit with a direct fade instead of hard removal or reverse scaling.
- [x] Repair the missing secondary transition and remove the accidental wider model page.

## 2026-08-19 Android 0.4.53 后台浏览器与运行时压力

- [x] `browser_use` 在右栏折叠时后台执行，不强制展开或切换页签
- [x] 当前对话右栏浏览器复用同一 WebView/URL/正文，切换对话 session 隔离
- [x] 惰性创建 WebView，修复无浏览器活动时启动 PSS 72 MB 回归
- [x] 正式 Release 40 组边栏动画、3208 帧有效窗口，0 FATAL/ANR
- [x] 300 事件远端 Build/Goal/Flow/Queue 实时压力
- [x] 三个全新本地对话逐轮执行 17 个真实工具结果与 WebView extract
- [x] 强停重启后对话文件 SHA-256 不变，三个完成 run 全部恢复
- [x] 远端 server 进程终止/重启后自动重建 SSE，原对话继续收到 Goal/Flow/Queue 状态
- [ ] 补双向交替发送、pause/resume/stop、运行中切会话与多 workspace 故障注入

## 2026-08-18 Android 0.4.52 运行时压力

- [x] 远端沟通与运行状态追踪门禁
- [x] 本地全工具真实执行与 Build 历史持久化
- [x] `browser_use` 驱动同一内置 WebView 并提取正文
- [x] 本地队列 / Guide / 重启连续性
- [x] Release 启动、数据、内存、线程、fatal/ANR 门禁
- [x] 重新采集有效动画 jank；有效窗口为 1,941 帧，jank 45.85% / p90 69ms，仅按当前宽松门禁保留诊断

## 2026-08-18 移动端 resident runtime / Goal / Flow / Queue（dev-0.4.50）

- [x] 完整解析并原子提交 PC resident messages、WorkRuns、Goal、Flow、Queue、runtime
- [x] resident running 同 runId 覆盖冷读 interrupted，终态 durable 保持权威
- [x] 状态条改变 viewport 高度时重新跟随运行中 Build
- [x] Goal/Flow 渐变裁剪进圆角卡片，Goal 绿灯条不再出格
- [x] Flow 接管按 PC 浮动栈水平居中，不再左对齐
- [x] 160 事件远程实时压力全部功能门禁通过，无 FATAL/ANR
- [x] Android unit/Debug、Desktop build/runtime isolation、移动 API 43/43 通过
- [x] `0.4.50` / `450` 经数据守卫覆盖安装，8 个受保护文件保留
- [x] 本地队列 1000 项状态转换压力通过
- [ ] 将本地 `ChatViewModel` 自制执行 loop/channel 替换为 PC ConversationKernel 同构后端
- [ ] 修复独立的模型菜单 UI 压力定位/交互缺陷，并将功能 dump 与 gfx 性能采样窗口分离

## 2026-08-18 移动端历史 WorkRun 前沿错位事故

- [x] 对照 PC `renderOrphanRunsBefore` 定位移动端缺失的历史重建契约
- [x] 按后端 WorkRun ledger 顺序恢复旧无锚历史块，不再统一追加到前沿
- [x] 增加 orphan-before-owned 与显式锚点排除回归测试
- [x] 完整 Android 测试/构建并通过数据指纹守卫覆盖安装 `0.4.49`

## 2026-08-18 移动端远程 Goal/Flow/Queue 同构（dev-0.4.47）

- [x] 远程 Goal bar 编辑、暂停/继续、删除绑定精确 PC target
- [x] 普通 Guide / Goal Guide 改走 PC 原生 Guide envelope 与 receipt
- [x] Goal Next 队列保存 Goal declaration 与 requested mode
- [x] PC 端发起运行同步移动发送/停止状态
- [x] 普通 Build Stop 接入 PC target-local 两段式停止
- [x] PC 运行结束时自动排空移动 Next 队列
- [x] 本地运行期输入进入持久化队列，Goal/Flow 仍仅远程显示
- [x] Desktop build、移动 API 43/43、Android unit/assemble 通过
- [x] 数据守卫覆盖安装、启动和版本/崩溃日志核验（8 个私有文件保持，0.4.47 前台运行，无崩溃记录）

## 2026-08-18 移动端顶栏操作区与旧会话迁移（dev-0.4.34）

- [x] 连接桌面端 / 新对话两个圆形顶栏按钮在同时可见时加入固定 8dp 间隔
- [x] 修复旧 `conversations.json` 缺失 `mode` / `planItems` 时的冷启动崩溃
- [x] 保持本地 Build / Plan 选择随当前会话同步，不串会话
- [x] Android 单测、Debug APK 构建、保留数据的模拟器覆盖更新及正式聊天界面启动验证

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

## 2026-08-18 本地对话实时运行状态（dev-0.4.46）

- [x] 点击发送的同步状态转换立即创建展开的 `running` Build/Plan 块，不等待 provider 首包或落盘
- [x] start/thought/tool_call/tool_result/final_response/error/done 逐事件更新同一临时运行块
- [x] Build 块内部事件数量或状态变化时触发对话尾部跟随，不再只监听外层消息数量
- [x] 完成后以持久化 WorkRun 原位接替临时块；停止时持久化 interrupted 部分历史
- [x] Android 单测/构建、Desktop build、移动工作区 API 41/41 通过
- [x] `0.4.46` 使用数据指纹守卫安全覆盖安装到 `emulator-5554`

## 2026-08-18 移动边栏窗口级背景模糊（dev-0.4.40）

- [x] 左/右边栏展开时仅模糊后方主窗口，边栏自身保持清晰
- [x] 右边栏展开动画进度连续驱动背景模糊，不额外绘制假进度层
- [x] Popup/Dialog 保持局部玻璃衬底，不启用全窗口模糊
- [x] 修复 `UpStart` 定位钳制，一级/二级输入弹窗贴近输入框上方约 6dp
- [x] 旧桌面通过脱敏 `/api/state.providers` 补齐远程完整模型目录
- [x] 模拟器验收左右边栏与远程模型二级菜单；`0.4.40` 已保数据安装并在前台运行

## 2026-08-18 边栏模糊进度连续化（dev-0.4.41）

- [x] 竖屏左栏使用 Drawer 实际 offset 计算连续展开进度
- [x] 右栏拖动/动画进度连续映射到 `0dp..32dp` 模糊
- [x] 平板/折叠屏二级左栏模糊与 400ms 展开动画使用同一缓动
- [x] 双栏状态取最大展开进度，避免一侧关闭导致背景模糊跳变
- [x] Android 单测、构建通过，安全覆盖安装保持 7 个私有文件不变

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
# Mobile unified backend checklist (2026-08-18)

- [x] Prevent historical/live WorkRuns from being appended at the transcript frontier.
- [x] Reject incomplete or stale remote workspace/conversation/run identities.
- [x] Make the PC runtime authoritative for the remote queue.
- [ ] Route all Compose send/queue/Guide/stop operations through one backend interface.
- [ ] Implement the local adapter with full PC kernel-equivalent queue and Guide lifecycle.
- [ ] Add local-vs-remote event-sequence conformance fixtures.

## 2026-08-18 mobile dev-0.4.51 gate

- [x] 完整可发送页面五轮 `INTERACTIVE_READY_MS` 均 ≤4000ms：1963–2552ms。
- [x] 五轮正式 Release 窗口内 FATAL/ANR/未响应/Launch timeout/进程死亡为 0。
- [x] 2 vCPU 调度下通过，归档/工具/上下文工作分别进入 IO/Default，主线程只提交 UI 状态。
- [x] 保数据安装自动激活 APK baseline profile，Dexopt 状态为 `speed-profile`。
- [x] 竖屏保留随边栏进度窗口模糊；折叠屏/平板打开左右边栏时不做窗口模糊。
- [x] 首屏、左栏、设备展开、右栏 Files/Editor/Plan/SubAgent/Browser、计划新建/关联计划、浏览器控件结构 smoke 通过。
- [x] 本地模型上下文按 70%/20%/12% PC 阈值压缩并持久化，完整显示历史不变。
- [x] 压缩上下文贯穿工具子轮次和重启；摘要失败有界 fallback；新分支不继承旧路径摘要。
- [x] 10,000+ 消息及巨大工具结果纯契约压力通过。
- [x] 160 事件远端 SSE/Build/Goal/Flow/Queue/realtime gates 全通过，报告 `archive/mobile-stress-20260819-005444.json`。
- [ ] 本地执行后端仍是移动端 Agent loop/Channel，尚未替换为 PC ConversationKernel 同一实现；不得宣称内核完全同构。
- [x] Emulator 37.1.11 压力后的可见 gfxstream/QEMU hang 已定位；userdata 无损，`-no-cache` 已恢复可见竖屏和正式 App 前台。
- [ ] 仍需在稳定的 emulator 版本补 4/8 vCPU 长时可见窗口矩阵；当前正式门禁覆盖 2 vCPU 最差档。
