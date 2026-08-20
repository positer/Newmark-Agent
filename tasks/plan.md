# Newmark Agent dev-0.3.13 全场景交叉黑盒压力测试计划

## 2026-08-19 模型菜单与输入框 PC 格式收尾

- [x] 模型二级弹窗按供应商分组，模型行移除重复供应商前缀
- [x] 保持紧凑弹窗及变形动画，增加超长模型名横向滚动能力
- [x] 输入框默认一行、最多五行、超出内部滚动，多行保持单行固定 24dp R 半径，三枚按钮贴底
- [x] 玻璃强度 Slider 接入 PC 曲线、实时预览、左右栏/弹窗/竖屏窗口模糊和 SharedPreferences 落盘
- [x] 左侧二级栏新增对话按钮改为圆形
- [x] Android 单测/Release/lint/R8、正式包 10 文件保数据安装、实机与错误日志门禁

## 2026-08-19 系统亮暗启动主题与压力复核

- [x] Activity/Compose 前读取系统 day/night 资源，配置 Android 12+ 系统 Splash 与旧系统启动窗
- [x] 暗色纯黑背景 + 黑底白色图标；亮色保持 `#F2F2F7` + 黑色图标
- [x] 正式 Release 暗/亮逐帧截图与像素取证
- [x] 修复压力脚本右栏状态泄漏、IME 竞态、同机 NAT 依赖与失败路径 ANR 取证
- [x] 清理 gfxstream 故障后完成 800 事件/10 UI 轮次状态与稳定性门禁
- [x] 10 文件保数据安装、隔离包卸载、暗色/联网/正式前台收尾

## 2026-08-19 运行连续性续压

- [x] 300 事件、90 轮 UI、Goal/Flow/Queue/Build/stale-event 综合门禁
- [x] 修复多次 UI dump 耗尽 live Build 的压力脚本竞态并重放
- [x] 本地 Queue/Guide/编辑/删除/17 工具/强停重启连续性
- [x] 远端运行中服务重启 3 轮，恢复后继续接收 PC 新 Build
- [x] 移动/PC 交替发送、Flow 暂停/保持/继续、普通 Build 停止
- [x] 外部 workspace/conversation/runtime 事件注入隔离
- [x] Desktop build、Android unit/Release/R8/lint、保数据安装与正式前台收尾
- [x] 自动化运行中切换可见 workspace/conversation，再返回原目标验证无串线/丢状态（2 轮 A↔B，A 保持 1000-event live Build，PID/SSE 稳定）

## 2026-08-19 远程触及启动与运行稳定性

- [x] 源码 hosted server 10 次启停、可达与端口释放
- [x] 安装包 5 轮 GUI + 5 轮 TUI 冷启动/退出、SSE、网络可达和 3,600 次并发读取
- [x] 定位并修复 SSE 断线后设备状态仍显示“已连接”
- [x] 正式包 5 次运行中 PC 服务重启，验证同一移动 PID 恢复与状态转换
- [x] 正式包 3 次移动先启动、PC 后启动的异步重连
- [x] Android unit/Release/R8/lint、10 文件保数据安装、前台与资源收尾
- [x] 按用户放宽门禁：无卡死/ANR/FATAL/OOM/进程死亡或明显瞬时高压；jank 仅记录不再硬卡

## 2026-08-19 移动端 Guide 用户时间线

- [x] 对照 PC `renderWorkRunGuideMessage`、展开/折叠 WorkRun 行为和右侧节点几何
- [x] 将 Guide 从 Build 左轨事件改为右侧用户输入时间线消息
- [x] 展开态按 sequence 原位插入；折叠态仅保留 Guide 可见
- [x] 保持生命周期升级去重、状态、时间、正文、附件和复制
- [x] 补本地投影与远端 `RemoteWorkGuide` 转换回归
- [x] Android 单测、Release/R8/lint、保数据安装和 60 次折叠/展开压力

## 2026-08-19 二级复合弹窗回归止线

- [x] 对照 PC `model-menu-in` 与已验收录像定位动画消失/纵向拉伸根因
- [x] 恢复一级↔二级同壳变形：220ms SizeTransform + 内容淡入淡出；不得替换为二级独立弹入
- [x] 保持 190dp 紧凑宽度、320dp 最大高度及模型目录内部滚动
- [x] 修复 Release/R8 旧远端事件缺省字段导致的 `LocalWorkEvent` NPE
- [x] Android 单测、Release/R8、保数据安装、前台与 FATAL/ANR 门禁

## 2026-08-19 mobile stale-run and latest animation gates

- [x] Add a pure contract rejecting delayed non-terminal events for completed remote runs.
- [x] Preserve resident-runtime recovery for an exact still-running run identity.
- [x] Inject a delayed event after an 800-event real SSE run and prove the Build does not reopen.
- [x] Verify Build, Goal, Flow prompt/takeover, Queue, duplicate handling, and remote queue mutation together.
- [x] Isolate the latest first-level input-menu entrance/exit performance on the formal Release package.
- [x] Pass five complete-interaction launches under 4,000 ms.
- [x] Run a formal Release queue expand/collapse animation-only window without `uiautomator` inside the sample (120 toggles / 1,941 frames / no skipped-frame warning, ANR, fatal, swap, or process death).
- [ ] Run independent true-cold/first-boot startup trials before making any universal ≤1,000 ms cold-start claim.

## 2026-08-19 mobile input composite menu entrance

- [x] Reproduce the visually instant first-level Mode/File and Model/Intelligence popup.
- [x] Replace the implicit always-visible transition with a button-centred explicit progress animation.
- [x] Retain the expanded surface during dismissal and remove it only after an independent alpha-only fade.
- [x] Restore secondary-page entrance timing and keep every level at the same compact 190 dp width with internal scrolling.
- [x] Preserve the small popup geometry, 6 dp input anchor, scrolling, and secondary-page behavior.
- [x] Run Android unit tests and complete Release assembly.
- [x] Install to `emulator-5554` through the data-preserving update guard and capture device evidence.

## 2026-08-18 Android 0.4.52 运行时压力续测

- [x] 审计所有本地工具 schema 与真实执行实现
- [x] 补齐并执行 web、内置 Browser WebView、持久 task/plan 工具
- [x] 压测远端 SSE、实时 Build、Goal、Flow、Queue
- [x] 执行本地全工具 Agent 循环并验证副作用、历史和重启
- [x] 验证本地 Next 编辑/删除/排空与 Guide accepted/applied 恰好一次
- [x] 构建并保数据安装正式 Release，应用 `speed-profile`
- [x] 五次完整可交互启动与 Release 资源/错误压力
- [x] 在不使用层级抓取的有效动画驱动下重新采集统计充分的帧样本（优化隔离 Benchmark，120 次展开/折叠）

## 2026-08-18 移动端 resident runtime 与浮动状态条（dev-0.4.50）

1. 将 PC GUI-hosted resident snapshot 的 messages、WorkRuns、Goal、Flow、Queue、runtime 作为同一 target 状态原子投影。**已完成**
2. 修复冷读 interrupted 压过 PC 实时 running，以及状态条出现后运行块被挤出 viewport。**已完成**
3. 将 Goal/Flow 渐变限制在圆角裁剪内，并按 PC `input-float-stack` 居中 Flow 接管胶囊。**已完成**
4. 执行 160 事件远端压力、Android/Desktop 门禁和保数据正式安装。**已完成**
5. 后续将本地 Android Agent loop 迁移到 PC ConversationKernel 同构后端；完成前不得宣称本地完整复刻。**待完成**

## 2026-08-18 移动端历史 WorkRun 前沿错位修复

1. 从移动投影源码复现剩余错位路径，并与成熟 PC 重建契约逐行对照。**已完成**
2. 移植 PC ledger-based orphan placement，不新增移动端队列或渲染状态机。**已完成**
3. 用纯契约测试锁定历史 orphan 与显式 anchor 两种情况。**已完成**
4. 执行完整 Android 门禁、保数据安装模拟器并记录运行证据。**已完成**

## 2026-08-18 移动端远程 Goal/Flow/Queue 同构（dev-0.4.47）

1. 以 PC GUI 的输入栈、Guide 回执、Goal 编辑和两段式 Stop 为唯一契约，桥接精确工作区/对话 runtime。
2. 远程运行态必须覆盖 PC 端发起的 Build/Flow；运行结束由状态同步触发移动 Next 队列排空。
3. Goal Guide 使用原生 `enqueueGuide`，Goal Next 持久携带 Goal declaration；空闲 Goal 编辑才直接更新状态。
4. 本地移动端只共享排队消息能力，运行期输入排队，不伪造 PC Goal/Flow/steer。
5. 完成桌面、API、Android 门禁后，以数据指纹守卫覆盖安装并启动模拟器。

## 2026-08-18 移动端接续：顶栏独立操作区与旧会话兼容（dev-0.4.34）

### 目标

保持 PC 顶栏中“连接桌面端”与“新对话”两个圆形操作区的视觉和触摸分离；同时确保历史本地会话在新增 Build/Plan 与 task/plan 持久化字段后可直接覆盖升级、不会崩溃或丢失会话数据。

### 已完成与验证

1. `ChatTopBar` 仅在连接按钮显示时插入 `8dp` 间距；按钮尺寸、右对齐、图标及回调不变。
2. `normalizeConversationMessages` 用无损重建迁移 Gson 旧 JSON 的运行时 null：模式缺失回填 `build`，计划缺失回填空列表，消息、分支、时间戳与归档状态保持。
3. 输入区接收每个本地会话的持久化模式，切换对话时同步 Build/Plan 文案。
4. `:app:testDebugUnitTest :app:assembleDebug` PASS；安全 `adb install -r` 守卫确认 7 个私有文件指纹不变；`0.4.34` 已在 `emulator-5554` 前台显示聊天界面。

## 2026-08-18 移动端接续：PC 对话记录 WorkRun 同构（dev-0.4.33）

### 目标

让本地与远程历史复用 PC `renderWorkRunEvents` 的公开事件契约，完整保留公开文本、思考摘要、工具状态、Guide、图片和终态，同时绝不展示私密 reasoning/thinking。Build 完成标题必须使用 PC 同词“已处理”，不能再显示“构建”。

### 已完成与验证

1. 新增统一 `WorkRunProjection`，按 `sequence → timestamp → id` 排序，处理文本合并/覆盖、thought/tool 回填、工具组、Guide、图片和中断终态。
2. 远程完整反序列化为 `RemoteWorkEvent`，本地生成同构 `LocalWorkEvent`，旧记录通过默认字段兼容。
3. 历史顺序与终态去重对齐 PC；完成态显示“已处理”，运行态显示“处理中”。
4. `:app:testDebugUnitTest`、Kotlin 编译和 clean assembleDebug 均通过；APK `433 / 0.4.33` 已安装且前台运行于 `emulator-5554`。
5. 待网络恢复后，以真实远程历史快照执行一次人工回放验收；不得将当前模拟器端点不可达误报为解析通过或失败。

## 2026-08-17 移动端接续：PC 右侧栏与无占位折叠态（dev-0.4.32）

### 目标

一比一移植 PC 右侧栏（文本编辑器不移植预测随航），折叠后仅保留主页面右缘垂直居中的独立按钮且不占布局列；支持点击和主页面左滑展开。仅竖屏 SubAgent 详情使用加页，平板/折叠屏保持弹窗；Memory Lab 在平板/折叠屏恢复更大的弹窗。本地对话不在一级 rail 中保留缩略项。

### 验收

- 折叠按钮与 PC 同为 18×48、右缘居中、`panel-right` 图标，聊天区宽度不被折叠列侵占。
- Files、Editor、Plan/Linked plan、SubAgent、Browser 五页可见，点击与左滑均可展开。
- 仅竖屏 SubAgent 加页；平板/折叠屏 SubAgent 与 Memory Lab 使用弹窗。
- rail 不显示本地对话缩略项；桌面总回归、移动 API、Android clean build 与实机检查通过。

## 2026-08-17 移动端接续：PC GUI 二级边栏、分支树与连续时间线（dev-0.4.31）

### 目标

将 Android 工作区二级边栏重绘为 Newmark PC GUI `#left-secondary`，竖屏采用一级栏完全退出后二级栏进入的顺序换栏；移动远程与本地对话均支持 PC 同构分支树阅读、创建、数量与分页管理，并保持用户输入/Agent 回复两侧连续时间线。

### 实施切片

1. 复用 PC GUI DOM/CSS/Lucide 视觉事实源重绘二级栏及对话行。
2. 竖屏通过阶段状态机等待一级栏退出完成，再挂载二级栏；横屏继续使用并列双栏。
3. 桌面增加工作区精确绑定的移动分支 inspect/activate/create API；Android 远程状态只投影 PC 原生分支树。
4. 本地新增持久化分支节点/分页组，编辑历史用户消息创建新分支，浏览态与运行态分离。
5. `ChatContent` 在 `LazyColumn.drawBehind` 统一绘制左右连续轨道；修复本地分页祖先选择规则。
6. 运行桌面总回归、Android clean build、安装与实机 UI dump/截图验证，更新 README、OVERVIEW、archive 后提交并标记 `mobile-dev-0.4.31`。

### 验收标准

- 二级栏视觉与 PC `.secondary-top`、`.conv-item`、active/running 状态一致。
- 竖屏 80ms 仍只见一级栏，300ms 仅见二级栏，不发生覆盖。
- 远程分支不重写 PC 核心；本地和远程均显示分页器并支持历史编辑分叉。
- `2/2` 可切回 `1/2`，切页只改变浏览态；发送前激活所阅分支。
- 用户/Agent 连续竖线在普通页和分支页均可见。
- Android clean build、安装与桌面回归全部通过。

### 风险与约束

- PC 二级栏的 blur 在 Compose 中复刻可见层级，不改写全局主题。
- PC 分支树算法保持唯一事实源，移动 API 只做精确目标桥接。
- 模拟器 `uiautomator dump` 有缓存，验证前删除旧 XML；关键构建必须 clean。

## 目标

在不阅读源代码、不依赖 README 的前提下，让全新上下文黑盒测试员仅通过真实安装/打包目录、可执行文件探针、`--help`/版本输出、GUI/TUI/CLI 实际行为和临时根目录状态，验证 `dev-0.3.13` 候选的发布门禁。重点覆盖 GUI、TUI、CLI 的共同后端，以及用户刚刚修改过的上下文压缩、缓存、内联任务管理、Flow 接管、归档打断和 Copilot 预测路径。

本轮不是单入口冒烟，而是对高风险状态与操作做正交组合、三元交叉和连续压力；任何失败必须带有可复现序列、入口、根目录、进程树、日志和文件状态证据。

## 工作边界与安全规则

- 测试员使用全新上下文，不读取 README、源代码、测试代码或本计划以外的实现提示；只探测真实目录、可执行文件、帮助/版本输出和运行时反馈。
- 所有试验使用安全临时目录和显式隔离的 `--root`/等效用户数据根；不得写入仓库配置、现有 `~/.Newmark`、真实会话、Program Files 安装目录或全局 MSI 状态。
- `_ref` 下的凭据只允许通过环境变量/进程注入使用，日志、报告、命令行和快照中必须脱敏；没有安全可用的真实模型时，改用无模型、失败模型、延迟/可控本地探针，并明确标记环境跳过。
- 不申请 UAC，不卸载、不覆盖、不删除现有安装；所有启动的 GUI、TUI、CLI、sidecar、Node/Electron 子进程都要在每个用例后回收并核对进程树。
- 测试按自然时长运行，不设置人工硬截止；TUI 必须使用 PTY/控制台探针而不是仅等待前台 wrapper。只有测试自身自然结束、明确失败，或出现需要安全清理的失控进程时才收口；若外层探针失联，必须区分 wrapper 状态、后台存活和真实启动失败，不能把未完成报告计为通过。
- 发现会触碰外部真实数据、发送不可控外部请求或暴露凭据时立即停止该用例并记录为环境阻断，不以“通过”计。

## 入口与状态轴

### 入口轴 E

| 编号 | 入口 | 观测重点 |
| --- | --- | --- |
| E1 | 真实 GUI | 启动、输入焦点、窗口/托盘、会话切换、Flow、归档、压缩、编辑器、崩溃/重启 |
| E2 | 真实 TUI | PTY、明暗主题、resize、中文/ANSI 长输出、输入与 Esc/双 Esc、重启恢复 |
| E3 | 真实 CLI | help/version 终止、非交互命令、队列/归档/压缩/模型探针、退出码和机器可读输出 |
| E4 | 共享后端 | GUI+TUI、GUI+CLI、TUI+CLI、三者同时运行时的同一 target、锁、事件顺序和持久化 |

### 运行状态轴 S

`S0 空闲`、`S1 首 token 等待`、`S2 流式输出`、`S3 工具调用/Build`、`S4 队列与 Guide/Next`、`S5 Flow 运行`、`S6 Flow 暂停/接管`、`S7 压缩进行中`、`S8 归档进行中`、`S9 后台会话/切换前台`、`S10 Provider 超时/429/No completion`、`S11 应用隐藏/关闭/闪退后恢复`。

### 操作与环境轴 O/P

- 操作：发送、连续发送、停止/Esc/强停、暂停/继续 Flow、Guide/Next、切换会话/工作区、归档、恢复、重复归档、上下文压缩/历史读取/恢复、模型切换、编辑器预测、窗口关闭/托盘、重启。
- 上下文：Build 历史 65/70/75/85%，长期历史 15/20/25%，已有 summary、重复压缩、压缩同时发生新消息、linked-plan 大小变化、缓存命中/失效、工具子回合。
- Provider：无模型、无效模型、慢首 token、空 completion、429、网络超时、工具错误、有效本地 fixture、真实模型（仅当安全凭据和网络都可控）。
- 规模：1/2/8 个会话，1/16/120 次快速归档，1/10/50 次连续发送，短/长 UTF-8 文本，路径无空格/含空格/含中文，窗口最小化/resize。

## 交叉测试选择

不盲跑完整笛卡尔积；先跑每个轴单独的基线，再做 pairwise 覆盖，最后执行下面的高风险三元/四元交叉。每个可重复操作至少做冷启动、热启动、重启后三种轮次；高频操作使用固定随机种子并保存序列。

### 必测高风险交叉

| Case | 组合 | 必须证明 |
| --- | --- | --- |
| X01 | GUI × Flow 运行 × 快速归档/切换后台会话 | 首次点击立即移除行和 takeover；Flow 被打断、目标不回退、不复活、不阻塞其他会话；归档最终落盘 |
| X02 | GUI × Build/工具调用 × 归档 × 重启 | 任何工作状态都可接管归档；无旧 runtime 卡住；重启后归档/会话状态一致 |
| X03 | TUI 明亮主题 × 长中文/ANSI 输出 × resize × Esc/双 Esc | 输入始终可聚焦；无乱码、黑字黑底、死键、重复回显；停止后可再次输入并正常退出 |
| X04 | TUI × Provider 超时/空 completion × 停止/重试/重启 | 错误可见但不挂死；进程/PTY 清理；重试不重复消息、不丢草稿 |
| X05 | CLI 压缩/历史管理 × GUI 同会话发送/归档 | 两入口不覆盖彼此状态；压缩只影响模型上下文，不删展示历史；命令退出码明确 |
| X06 | CLI × GUI × TUI 三者同时运行 × 同一会话与相邻会话 | 事件顺序、草稿、队列、Flow、归档互不串 target；锁竞争可恢复；无重复响应 |
| X07 | Build 70%边界 × 长期历史20%边界 × 重复压缩 × 工具子回合 | 两个阈值不互相误触；Build tail 保留；已有 summary 被复用；稳定 prompt/cache 可复用 |
| X08 | 大 linked-plan × 多轮工具调用 × 模型切换 | 普通每轮不重复注入整段 linked-plan；显式工具仍可按需访问；模型切换不串计划 |
| X09 | Copilot 快速输入/移动光标 × 慢模型/No completion × GUI 关闭/重开编辑器 | 旧请求即时取消；空结果不闪错误；新光标结果不被旧结果覆盖；关闭后无悬挂请求 |
| X10 | 后台会话运行 × 前台切换 × 托盘/关闭/闪退模拟 × 恢复 | 后台不误停/误显；窗口生命周期状态一致；恢复不重复 Build/Flow/消息 |
| X11 | 无模型/无效模型 × 发送/归档/压缩/Flow | 失败闭环，不伪造成功、不产生合成答案、不污染状态；归档仍可直接完成 |
| X12 | 120 次快速创建/发送/归档 × GUI/CLI 并发 | 无 pending/丢失/复活/覆盖；文件命名唯一；内存、句柄、进程、队列可回落 |

## 执行阶段

### 阶段 A：黑盒能力发现

1. 找出真实安装目录、便携目录和可执行入口；记录版本、文件 hash、入口命令，不修改文件。
2. 对 GUI、TUI、CLI、Console Runtime 分别执行 `--help`、`-h`、`--version` 及未知参数探针；等待每个探针自然终止，记录是否错误启动 runtime、退出码和 stderr。
3. 通过帮助/探针推导可用的 `--root`、模型、会话、Flow、归档、压缩、编辑器和诊断入口；未知的功能不靠源码猜测，标为未发现。
4. 建立临时根目录，做单入口冷启动/退出与单会话基线，保存进程、文件树、配置 hash/mtime 和日志摘要。

### 阶段 B：入口独立压力

分别执行 GUI、TUI、CLI 的基线矩阵：快速输入、长文本、停止/重试、空模型、压缩边界、归档洪泛、窗口/PTY 重启、路径隔离。单项失败先缩减为最小复现，不继续放大破坏性操作。

### 阶段 C：共享后端并发压力

在同一隔离根中启动 GUI、TUI、CLI，使用 2 个会话和 2 个工作区做交错序列。至少覆盖发送→压缩→切换→归档→恢复→重启和 Flow→暂停→归档→另一入口发送→恢复两个长序列；每步记录 event timestamp、target、revision、退出码、文件 hash/mtime。

### 阶段 D：持续性与恢复

运行至少固定事件数，并允许自然延长到测试员确认收敛；不设置人工时间上限。执行随机化但可复现的发送、切换、停止、压缩、归档、恢复和重启；按事件阶段采样 CPU、内存、句柄、进程数、队列深度、临时根目录大小。结束时做冷启动回读，确认没有孤儿进程、锁、pending 状态或跨根污染。

### 阶段 E：发布门禁判定

对失败用例自动重放至少 3 次；同一确定性缺陷一次即可阻断。仅在所有 P0/P1 为零、每个高风险交叉至少一轮明确通过、连续性指标回落、临时根和进程清洁后，才建议下一步包重建/UAC；本计划本身不授权 UAC。

## 黑盒报告契约

每个 Case 输出一条结构化记录：

```json
{
  "caseId": "X01",
  "packageOrInstallRoot": "redacted absolute path",
  "version": "observed",
  "entrypoints": ["gui", "cli"],
  "root": "isolated temp root",
  "seed": 123,
  "steps": [{"t": 0, "action": "...", "target": "..."}],
  "expected": ["..."],
  "observed": ["..."],
  "exitCodes": [],
  "latencyMs": {"p50": 0, "p95": 0, "max": 0},
  "processesBeforeAfter": {"before": [], "after": []},
  "filesystemDiff": [],
  "configHashMtime": [],
  "logs": ["redacted paths and secrets"],
  "result": "pass|fail|blocked|skip",
  "severity": "P0|P1|P2|P3|null",
  "reproCommandOrSequence": "..."
}
```

报告必须分开列出：产品缺陷、环境阻断、测试器/探针问题、未覆盖功能；不能把超时直接写成崩溃，也不能把 source-only 结果写成真实安装包通过。

## 发布门禁

- P0：数据丢失/串会话/凭据泄漏/无法停止或无法退出/安装目录被写入/归档复活；立即 HOLD。
- P1：GUI/TUI/CLI 入口任一核心路径不可用、Flow/压缩/归档确定性卡死、共享后端破坏一致性、Copilot 旧结果覆盖新结果；修复并重跑相关交叉。
- P2：可恢复错误、明显性能退化、主题/resize/帮助边界问题；修复或有明确豁免证据。
- P3：纯文案/低影响视觉问题；记录但不阻断，除非发布标准另有要求。

## 完成条件

- 黑盒员提交完整发现记录、阶段计数、所有 X01–X12 结果和未覆盖项。
- 所有测试只在安全临时根完成，测试前后仓库、真实配置、安装目录和全局安装状态无变化。
- 每个失败至少有最小复现；每个声称通过的入口均有真实进程/输出/状态证据。
- 若发现问题，先本地修复再从阶段 A 或受影响阶段重跑；未获得全量清洁报告前，不申请 UAC、不发布、不宣称 release-ready。
# 移动端远程/本地 Agent 与 UI 表现压力测试计划（2026-08-17）

## 目标

建立一套可重复、可量化、可回归的 Android 移动端压力测试体系，覆盖本地 Agent、远程 PC Newmark Agent、远程实时事件流、配对/重连、UI 表现、动画稳定性、多核渲染和启动速度。测试必须区分产品缺陷、环境阻断和测试器问题；任何“通过”都需要原始指标、设备配置、版本和进程清理证据。

## 测试边界与安全规则

- 使用 Android Debug APK 和隔离的 PC Server root；默认使用本地 mock provider，真实 provider 只做显式、低频、可控冒烟。
- 不把 API key、pair token、完整二维码 URL 或用户会话内容写入日志、截图文件名、归档或最终报告。
- 每轮测试前记录 APK 版本、设备分辨率/density/API、CPU 核数、硬件加速状态、Server PID/端口和网络模式。
- 每轮测试后必须回收 Android/PC 测试进程，确认端口、SSE、临时文件和 pending 状态归零。
- 每次移动端适配完成后执行 `clean assembleDebug`、`adb install -r`、启动应用和版本校验；性能测试只使用已安装且版本明确的 APK。

## 环境矩阵

| 维度 | 档位 | 观测 |
|---|---|---|
| 屏幕 | 竖屏 1080×2400/density 420；平板/折叠 1600×2560；窄窗口 720×1280 | 布局、二级栏换栏、右栏、弹窗/加页、IME 避让 |
| Android | 当前模拟器 API/系统；冷启动与热启动 | 启动时间、恢复、权限、Activity 生命周期 |
| CPU | 2、4、8 vCPU（可用 AVD 配置切换） | CPU 占用、帧稳定性、后台事件处理、线程争用 |
| GPU | 硬件渲染；软件渲染诊断档 | Compose/Skia、阴影、blur、动画退化 |
| 网络 | `adb reverse` 本机映射、同 LAN、Tailscale、断网/高延迟/丢包 | 远程可达性、重连、SSE 延迟、重复事件 |
| Server | GUI 托盘托管、TUI 同生命周期、CLI 常驻 Server | 所有权、退出回收、端口释放、后台持续性 |
| 数据 | 空数据、41 模型、100/500 对话消息、长 markdown、分支树 | 列表性能、菜单滚动、内存增长、分页正确性 |

## 指标与判定阈值

### 启动

- `processStart → 首帧`：冷启动 ≤ 1800ms，热启动 ≤ 900ms。
- `processStart → 首次可交互`：冷启动 ≤ 2500ms，热启动 ≤ 1400ms。
- `应用启动 → 本地 Agent ready`：≤ 3000ms；`扫码/配对成功 → 远程 state ready`：≤ 2000ms。
- 超过阈值 2 倍为 P1；超过阈值但可用为 P2；启动失败、黑屏或无法恢复为 P0。

### UI/渲染

- 60Hz 档单帧预算 16.67ms；120Hz 档单帧预算 8.33ms。
- 普通滚动、侧栏展开、菜单切换、分支分页：p95 frame ≤ 16.67ms，严重掉帧比例 < 5%。
- 连续动画（marquee、玻璃层、弹窗进入/退出）：连续 10 秒无明显跳帧、闪烁、错位或状态倒退；单次动画不得重复启动超过 1 次。
- `dumpsys gfxinfo`：Janky frames < 5%，90th percentile ≤ 20ms；若设备仅支持 60Hz，按 16.67ms 预算判定。
- UI 线程 CPU 峰值 < 85%（持续 5 秒以上视为异常）；单次交互后 2 秒内回落至 < 35%。
- 应用 PSS：空闲基线 + 30 分钟压力增长 ≤ 25%；无界面泄漏、Activity 重建泄漏或 SSE 重复连接。

### Agent/远程实时性

- 本地发送：点击发送 → pending 状态 ≤ 100ms；mock 首 token ≤ 500ms；最终响应 ≤ 5s。
- 远程发送：点击发送 → Server receipt ≤ 500ms；首个 SSE work/token 事件 p95 ≤ 1500ms；事件顺序无逆序、无重复、无跨 conversation 串线。
- SSE 心跳/事件空闲 60s 不断链；断网 5s 后恢复，重连 ≤ 10s；恢复后不重复渲染已确认事件。
- 远程切换 conversation/workspace：状态快照 ≤ 2s；旧 target 的事件不得进入新 target。

## 场景矩阵

### A. Agent 功能正确性

1. 本地 Agent：新对话、连续 50 轮、长中文/emoji/markdown、停止/重试、模型切换、智能档位。
2. 本地工具：文件读写、编辑器打开/保存、命令行、Memory Lab、Plan/Goal/Flow、SubAgent、分支创建/分页。
3. 远程 Agent：配对、state、workspace 对话列表、发送、流式 work 事件、停止、归档、分支 inspect/activate/create、右侧栏 Files/Editor/Plan/SubAgent/Browser。
4. 失败闭环：无模型、坏 token、401/403、404、429、500、超时、Server 重启、应用后台/恢复。
5. 一致性：本地/远程对话的用户输入轨道、Agent 回复轨道、分支数量、分页器和运行态均不丢失、不复活。

### B. 远程触及性与实时交流

1. `adb reverse`、LAN、Tailscale 三种连接方式各做冷启动、热启动、重启后恢复。
2. 二维码图片扫描、相机扫描、手动 URL 三种配对入口；过期 pairing、错误 host、错误 token、重复确认。
3. 断网序列：发送前断网、发送中断网、SSE 中断、恢复后切换对话、Server 重启后恢复。
4. 并发序列：两个 Android 客户端/一个 Android + PC GUI/TUI/CLI 同时观察同一 conversation；验证事件去重和 target 隔离。
5. 远程压力：10/50/120 条事件突发、5 个并行对话、单对话 30 分钟 SSE；记录 p50/p95/p99 延迟、重连次数和丢事件数。

### C. 持续性与资源

1. 30 分钟基线：每 10 秒一次轻交互，间隔发送 mock 响应，采样 CPU/PSS/线程/网络/帧。
2. 60 分钟耐久：每分钟切换 conversation、打开/关闭右栏、滚动长消息、切换菜单；每 5 分钟执行一次远程 state refresh。
3. 高频固定事件：创建/发送/停止/归档 120 次；模型菜单打开/滚动/选择 500 次；右栏开合/左滑 300 次；分支分页 300 次。
4. 后台持续：锁屏/切后台 1、5、15 分钟后恢复；验证 SSE 不重复、通知/状态不倒退、输入草稿和编辑器内容保持。
5. 崩溃/强停恢复：在发送、SSE、编辑保存、分支切换、Memory Lab 更新五个窗口强停后重启，检查持久化和 Server 生命周期。

### D. UI 表现与动画

1. 首屏：空会话、长会话、远程运行态三种首屏截图和首帧/可交互时间。
2. 列表：100/500 对话、41 模型菜单、200 条消息、长分支树滚动；检查最大高度、滚动条、触摸命中和尾部加载。
3. 侧栏：一级栏收回→二级栏展开、右栏折叠按钮、左滑展开、Files/Editor/SubAgent/Browser 切页；验证无重叠、无占位列和动画跳帧。
4. 动画：marquee、glass/blur、弹窗/加页、分支分页器、键盘/IME 避让、横竖屏/折叠姿态切换。
5. 主题：亮色/暗色切换，文本编辑器、滚动条、光标、行号、错误态和远程运行态无低对比或闪烁。

### E. 多核渲染适配

1. AVD 2/4/8 vCPU 各执行同一 10 分钟脚本；对比 UI 线程、RenderThread、GC、SSE 解析线程和网络线程占用。
2. 在 4/8 核档并发渲染：长 markdown + marquee + SSE + 侧栏动画 + 编辑器输入；检查是否出现主线程饥饿、事件积压、帧时间尖峰。
3. 对比硬件加速开关诊断档：功能必须一致；软件渲染可降级但不得崩溃、黑屏或无限重绘。
4. 记录 `dumpsys gfxinfo com.newmark.mobile`, `dumpsys meminfo`, `top -H`, `dumpsys SurfaceFlinger --latency`（可用时）和 logcat 错误。

## 执行阶段

### Phase 0：基线与工具

- 固定 APK/Server 版本、mock provider、隔离 root 和设备配置。
- 建立 PowerShell/ADB 采样脚本，输出 JSONL：时间戳、case、阶段、fps/jank、CPU、PSS、线程、网络、连接状态。
- 建立统一截图命名和脱敏日志规则。

### Phase 1：功能与远程触及性

- 先跑 A1–A5、B1–B5 的单场景冷/热/重启三轮。
- 任一 P0/P1 立即停止后续长压，保留最小复现。

### Checkpoint 1

- 本地 Agent 功能全绿；远程配对、state、send、SSE、断线重连和 target 隔离有结构化证据。

### Phase 2：持续性与 UI 表现

- 执行 C1–C5、D1–D5 的 30 分钟短耐久和固定事件压力。
- 每 5 分钟记录资源快照，开始/结束各抓一份 gfxinfo、meminfo、logcat。

### Checkpoint 2

- PSS 增长、线程数、SSE 连接数、jank、动画错误均在阈值内；所有 pending/临时文件回落。

### Phase 3：多核、启动和跨姿态

- 执行 E1–E4，覆盖 2/4/8 核、硬件渲染、竖屏/平板/折叠窗口、冷/热启动。
- 重跑最差的三个场景各 3 次，确认是确定性缺陷还是环境波动。

### Checkpoint 3 / 发布门禁

- P0/P1 = 0；P2 有明确豁免或修复计划；核心指标 p95 达标；模拟器/Server/临时数据清洁；才能进入适配提交和下一轮安装验证。

## 建议的测试产物

## 2026-08-18 dev-0.4.37 修正

- [x] 撤销全屏主体模糊与会遮蔽 Popup 内容的窗口级 blur 实验。
- [x] 弹窗/边栏仅保留自身玻璃衬底、边框和阴影，聊天主体保持清晰。
- [x] 重新构建并安全覆盖安装到 `emulator-5554`，7 个私有文件指纹不变。

## 2026-08-18 本地实时运行状态收口（dev-0.4.46）

1. 发送被接受时同步建立带 `start` 事件的本地临时 WorkRun，页面立即显示“处理中”。
2. provider 与本地工具循环每生成一个公开事件就发布不可变快照，不读取落盘历史作为实时来源。
3. Compose 仅对当前对话追加该临时块，并用事件修订值驱动尾部滚动；切换对话不会串入别的运行。
4. 终态先持久化完整 WorkRun，再清除临时块；用户停止则持久化当前事件与 interrupted 终态。
5. 通过 Android、Desktop API 契约和模拟器保数据安装门禁后交付。

- `android/scripts/mobile-agent-stress.ps1`：场景驱动、ADB 操作、进程清理和 JSONL 汇总。
- `android/scripts/mobile-perf-sampler.ps1`：gfxinfo/meminfo/top/logcat/SurfaceFlinger 采样。
- `android/app/src/androidTest/.../MobileMacroSmokeTest.kt`：启动、旋转/折叠、菜单滚动、侧栏开合、IME 和恢复的 UI 自动化。
- `DESKTOP/scripts/mobile-mock-server.cjs`：隔离 root、确定性延迟、SSE 序列、错误注入和事件计数。
- `archive/YYYY-MM-DD-mobile-stress-<run>.md`：脱敏环境、序列、指标、失败复现和结论。

## 失败等级

| 等级 | 判定 |
|---|---|
| P0 | 崩溃、数据丢失、凭据泄漏、无法停止/退出、跨用户/对话串线、黑屏、永久卡死 |
| P1 | 核心 Agent/远程实时交流不可用、事件丢失/重复、重连失败、启动超过阈值 2 倍、严重 jank/资源泄漏 |
| P2 | 可恢复性能退化、局部动画抖动、偶发超时、主题/布局轻微偏差 |
| P3 | 文案、低影响视觉差异、非阻断环境告警 |

## 未决问题

- 是否纳入真实 provider 长压；默认不纳入，除非用户明确指定模型、额度和最大请求数。
- 是否增加 Android Macrobenchmark/Perfetto 依赖；当前先用 ADB/gfxinfo 低侵入方案，稳定后再引入基准模块。
- 当前模拟器是否能稳定切换 2/4/8 vCPU；若不能，使用多个 AVD 配置并标记设备差异。

## 2026-08-18 dev-0.4.51 完整交互与长期上下文收口

1. 保持完整 Compose 页面树，拆分 transcript projection、共享 conversation surface、compact/expanded layout 编译单元。
2. Release 侧载后自动安装 baseline profile 并执行 `speed-profile`，消除首次交互路径中的根方法现场 JIT。
3. 将归档/会话磁盘 IO、本地工具执行移出主线程；上下文估算/切片放入 Default 核池，适配 2 核及多核调度。
4. 将 `modelContext/contextCompression` 接入真实本地 Agent 请求、工具子轮次、持久化恢复和分支隔离；显示历史保持完整。
5. 完成 10,000+ 消息与巨大工具结果契约压力、五轮 2 核完整交互门禁、结构 smoke 和 160 事件远端状态回归。
6. 保留正式 Release 性能、stress 功能与 emulator 主机故障三套独立证据，不混用指标。
# 2026-08-18 unified mobile conversation backend continuation

1. Completed: remove frontier-appended live WorkRuns and reconcile provisional/durable runs by PC identity.
2. Completed: move remote queue ownership and CRUD/Guide conversion into the PC conversation runtime.
3. In progress: define one mobile conversation snapshot/event/action controller used by Compose for local and remote transports.
4. Pending: replace the local ViewModel Channel loop with a PC ConversationKernel-equivalent local backend, including steering/followUp queues, final drain, Guide receipts, deferred continuation, stop races, and persistence.
5. Pending: execute cross-backend conformance tests proving identical sequences and UI projection.
# 2026-08-19 mobile 0.4.53 runtime continuation

1. Completed: preserve right-sidebar independence while making `browser_use` operate a conversation-bound WebView in the background.
2. Completed: lazy-mount the browser after measuring and eliminating the unconditional startup WebView memory regression.
3. Completed: valid formal Release animation window, 300-event remote state pressure, and three fresh-conversation local all-tool runs.
4. Completed: force-stop/restart continuity and data identity verification.
5. Completed: deterministic desktop server termination/restart and automatic SSE recovery without reopening the conversation.
6. Pending: alternating PC/mobile sends, pause/resume/stop, active-run conversation switching, and multi-workspace stale-event rejection runtime fixture.
# 2026-08-19 mobile transcript bottom reserve

1. Completed: add ten body lines of real scrollable content after the transcript.
2. Completed: retain existing latest-message auto-follow and preserve Queue/Goal/Flow overlay structure.
3. Completed: pass unit/Release/R8/lint gates and install the formal APK with the private-data guard.
4. Completed: verify the 190dp reserve on the portrait emulator.
# 2026-08-19 移动 Queue 拖动排序动画

1. Completed: 对照 PC Queue drag 样式，定位移动端边拖边改列表造成的跳位与回弹。
2. Completed: 改为连续跟手、相邻行占位让位、松手一次提交、取消不提交。
3. Completed: 单元契约、Benchmark 实机 20 次远端权威重排、Release/R8/lint 和保数据安装。
4. In progress: 继续独立优化 Queue 展开/折叠 observer-free jank；无效的固定根高度和额外图层缓存方案已撤销。
5. Completed: 800 事件远端 Goal/Flow/Queue 实时故障注入、重复事件与终态 stale running 防复活门禁。
6. Pending: 继续本地 Queue/Guide/重启/出队长压。
