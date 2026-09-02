## 2026-09-01 dev-0.5.13 移动端设置返回按钮玻璃画布

- [x] 确认设置主页和全部子页复用同一个顶栏返回按钮。
- [x] 返回按钮使用 36dp `GlassButtonCanvas` 与四周 8dp 透明光学外扩。
- [x] 保持原布局、命中区、图标、主题色、逐页返回目标和动画生命周期。
- [x] 新增设置返回按钮防回归契约，并扩展共享外扩画布测试。
- [x] Android 两项聚焦测试与全量 264 项 JVM 测试通过。
- [x] 修复已纳入当前 r5 Android Release APK。
- [ ] 真机设置返回按钮逐帧视觉验收仍待执行。

## 2026-09-01 dev-0.5.13 双端累计改动 APK（历史候选，当前由 r5 替代）

- [x] PC/Android 当前源码、版本和累计功能清单复核完成。
- [x] Desktop typecheck/build、1696/1696 主验证及 Search/browser/mobile API 专项通过。
- [x] Android 263/263 JVM、Vital Lint、R8、资源收缩和隔离 Release assembly 通过。
- [x] APK 包名、版本、SDK、启动 Activity、前台服务、v2 签名和 zipalign 核验通过。
- [x] APK 未命中开发者绝对路径、用户名、明显 Bearer/API Key 或私钥材料。
- [x] 当时交付 `APK/Newmark-Agent-0.5.13-dual-platform-final-release.apk`，52,794,422 bytes，SHA-256 `8BDCF457C7003C8ECF710F006F87109D8A11E722C784CFD63F6A2F087EB7A820`；后由 r2、继而 r3 替代。
- [x] API 35 模拟器安装与启动冒烟通过；应用进入系统权限/电池优化授权流程且进程无崩溃。
- [ ] 真机设置视觉、真实供应商、配对 PC stdio bridge、锁屏/切网/划走与至少 30 分钟后台运行待验收。
- [ ] 商店分发前替换 Android Debug 证书并完成 `specialUse` 申报。

## 2026-08-31 dev-0.5.13 移动输入与队列 Guide

- [x] 输入框保留 selection/composition，移动光标不重建字符串编辑会话。
- [x] 输入区内部手势不触发全局强制清焦点与隐藏键盘。
- [x] 队列拖动仅由左侧把手触发，Guide 短点击不再被整行长按识别器竞争。
- [x] 本地与远程 Guide 回调继续绑定既有 ViewModel 执行链路。
- [x] 增加输入法与队列手势所有权回归契约。
- [x] 运行中且输入非空时，发送键支持 300ms 长按上拉同尺寸上箭头玻璃浮块。
- [x] 上拉释放直接提交 Guide，不进入或消费 Next 队列；普通点按继续进入队列。
- [x] 本地 Build/Plan/Chat 的任何活动 Agent 运行均可接收 Guide，不再被 `run.mode == build` 隐式拦截。
- [x] 本地 Guide 未被当前运行接收时保留输入文本，避免无提示丢失。
- [x] Android 全量 JVM、Vital Lint、Release 组装通过。

# Newmark Agent dev-0.5.8 TODO

## 2026-08-31 dev-0.5.13 运行时稳定性与视觉补充

- [x] Agent 可用当前已验证视觉模型查看活动工作区 PNG/JPEG。
- [x] 工作区图片保持 10 MiB、40MP、格式与 realpath 边界，base64 不持久化。
- [x] `pdf_read` 默认 30 秒并支持 1–120 秒工具级超时，超时不终止 Agent 轮次。
- [x] 局部运行快照缺少 `chatMessages` 时保留现有可读对话。
- [x] TUI 与发行 smoke 移除开发者机器绝对路径。
- [x] Desktop 构建和 1683/1683 最终主断言通过。

## 2026-08-28 dev-0.5.10 全移动玻璃响应与 Windows 安装

- [x] 所有既有 `glassButtonSurface` 组件获得按住拖动的液态阻尼位移。
- [x] 右栏、Memory Lab、左右工具栏、对话胶囊和输入菜单边界接入共享阻尼函数。
- [x] 不扩大逻辑拖动/提交范围，松开归零并完整落下。
- [x] Android 定向与全量 JVM、Vital Lint、R8、Release APK 通过。
- [x] 版本同步为 `0.5.10` / `versionCode=510`。
- [x] Windows MSI/ZIP 生成并通过打包态 smoke。
- [x] MSI 本机安装，安装版 CLI/GUI/app.asar 边界通过。

## 2026-08-27 dev-0.5.9 全平台发布

- [x] 版本同步为 `0.5.9` / `versionCode=509`。
- [x] Desktop full release 与 Android JVM/Vital Lint/R8/Release assembly 通过。
- [x] 生成并哈希校验六个 Windows/Linux/Android 资产。
- [x] Windows MSI/ZIP 和 Linux AppImage/deb/ZIP 独立 smoke 通过。
- [x] APK v2 签名验证通过并记录 Android Debug 证书边界。
- [x] 提交 `e8c35b1` 并推送 `master` 与带注释标签 `dev-0.5.9`。
- [x] 创建 GitHub prerelease、上传六资产并回下载核对文件名、字节数和 SHA-256（6/6 通过）。
- [x] GitHub Windows/Linux/Android release workflow 与 npm publish workflow 全部成功。
- [ ] macOS DMG 需 macOS 主机构建与签名，不在当前发布矩阵。

## 2026-08-27 Chat 联网取证模式

- [x] 移动队列头仅显示 `n 条待处理`。
- [x] PC GUI/CLI 加入 Chat 模式。
- [x] 移动端本地对话加入 Chat 模式。
- [x] Chat 只公开并执行 web_search/web_fetch。
- [x] 隐藏/旧工具调用在执行边界拒绝写入及其他权限。
- [x] Agent 联网取证后尽快总结并提供来源。
- [x] 双端完整验证与 Android Release APK 构建通过。

## 2026-08-27 紧凑玻璃按钮真实画布

- [x] 左栏新建本地对话按钮完整呈现光学外沿。
- [x] 顶栏远程设备与新对话按钮完整呈现光学外沿。
- [x] 输入区 `+`、模型与发送/停止按钮完整呈现光学外沿。
- [x] 点击区域不随透明画布扩大，菜单锚点仍取视觉按钮。
- [x] 完整 Android 发布门禁通过并刷新 APK。
- [x] 外扩画布不再增加父级尺寸，输入框厚度、padding、按钮间距和位置恢复定稿值。

## 2026-08-27 dev-0.5.9 移动端玻璃按钮画布解除截断

- [x] 修复 Kyant 内部按钮等大 shape-clipped 离屏层。
- [x] 边缘型按钮玻璃使用 `clipToShape=false`。
- [x] 完整玻璃面板继续默认按 shape 裁剪。
- [x] 高光画布按描边宽度与模糊半径动态外扩。
- [x] 审计 7 个文件、33 处 `glassButtonSurface` 调用全面覆盖。
- [x] `GlassButtonCanvasOutsetContractTest` 与相关玻璃测试通过。
- [x] Android 全量 JVM、Vital Lint、R8、Release APK 与资产哈希。

## 2026-08-27 dev-0.5.9 移动端归档补位与完整玻璃动画

- [x] 本地与远程归档对话移除后，下方胶囊使用 260ms placement animation 平滑补位。
- [x] 浮起与运动并行，但完整浮起和运动结束前禁止开始落下。
- [x] 普通玻璃按钮每次点击完整播放 105ms 浮起和 165ms 落下。
- [x] 连续点击逐次排队，不截断前一个玻璃周期。
- [x] 解除输入区 + 按钮外扩边缘裁剪，审计远程设备、Memory Lab 和左栏新建按钮。
- [x] 定向归档、飞行、玻璃按钮与 LiquidGlass 契约测试通过。
- [x] Android 全量 JVM、Vital Lint、R8、Release APK 与资产哈希。

## 2026-08-27 dev-0.5.9 移动端玻璃浮块边缘增厚

- [x] 主交互玻璃边带 6dp → 7dp。
- [x] 独立弹窗玻璃边带 4dp → 5dp。
- [x] 开关按压玻璃边带 8dp → 9dp。
- [x] Kyant 高光与降级包边在原宽度上增加 1dp。
- [x] RGB 色散与折射层共用增厚后的边带宽度。
- [x] 新增 `GlassEdgeThicknessContractTest` 并通过定向测试。
- [x] Android 全量 JVM、Vital Lint、R8、Release APK 与资产哈希。

## 2026-08-27 dev-0.5.9 移动端排队对话无边框美化

- [x] 去除暂停/继续、展开/折叠、Guide、编辑和删除按钮的全部描边。
- [x] 队列按钮静止透明，按压使用同色晕染、轻微抬升与放大且无 MD3 ripple。
- [x] 增加“排队对话”标题、状态点、待处理数量与更舒展的队列行布局。
- [x] 保持长按拖动排序、邻项位移动画与可编辑性边界。
- [x] 新增 `QueuePanelVisualContractTest` 并通过定向测试。
- [x] Android 全量 JVM、Vital Lint、R8、Release APK 与资产哈希。

## 2026-08-27 dev-0.5.9 移动端固定主题色

- [x] 审计并确认移动端无自定义调色入口、字段或持久化状态。
- [x] 将内部 Palette 命名替换为固定 ThemeColors，保留内置深色/浅色主题。
- [x] 清理 SettingsScreen 与 MemoryLabScreen 重复主题色 import。
- [x] 新增契约测试，禁止颜色选择器、自定义强调色和 palette JSON 回归。
- [x] Android 全量 JVM、Vital Lint、R8、Release APK 构建及资产哈希。

## 2026-08-27 dev-0.5.9 移动端工具 help 与 settings_update

- [x] 复现 `settings_update` 二次 JSON 字符串声明导致的格式重试。
- [x] 改为原生 `providers`/`active` 参数，并保留旧 `json` 包装兼容。
- [x] 审计普通 Build、Plan、共享文件/应用授权及 Root/Shizuku/ADB 高权限工具 help。
- [x] 统一闭合 schema、字段类型、required、权限条件、副作用与返回语义。
- [x] 新增四套最终工具集完整性回归；Android 全量 JVM 单测通过。
- [x] 同步版本至 `0.5.9` / `versionCode=509`。

## 2026-08-27 dev-0.5.9 移动端写入工具增量化

- [x] settings provider/model/active 局部 patch；删除需 confirm；旧全量 providers 兼容。
- [x] Memory Lab 元数据、标签和正文 append/replace 局部更新。
- [x] 内部与共享文本文件 overwrite/append/replace 和 SHA-256 并发保护。
- [x] 审计 task、calendar、alarm、reindex，无额外全量模型负担。
- [x] Android 全量 JVM、Vital Lint、R8、Release APK 构建通过。

## 2026-08-27 dev-0.5.9 Memory Lab 同义词同步与 PC 写入增量化

- [x] 移动端按钮与 Agent 工具共用 PC 同义词/近义词合并语义。
- [x] 覆盖中英文主标签、aliases、tags/tagPaths 和重复重建稳定性。
- [x] PC Memory Lab component patch / append / unique replace。
- [x] PC Flow 单组件 upsert/delete 与 linked plan 局部替换。
- [x] 审计 Automation、Task、Goal、文件工具并确认已有增量能力。
- [x] Desktop build + verify 1673/1673；Android 196 tests + lintVital + R8 + assembleRelease。
- [x] 打包并核验 dev-0.5.9 Android APK 与 Windows x64 MSI，集中输出到 `release-0.5.9-packages/`。

## 2026-08-27 dev-0.5.9 Memory Lab 按钮与全局涟漪边界

- [x] 点名并移除右边栏和 Memory Lab 破坏美观的 MD3 灰色涟漪。
- [x] 包括设置页在内同时禁用 Foundation indication 与 Material3 ripple。
- [x] 设置页不再恢复默认 MD3 点击响应。
- [x] Memory Lab 五类操作按钮统一为无灰色遮罩的玻璃浮块胶囊。
- [x] 全量 Android tests、lintVital、R8、assembleRelease 通过。

## Android recent-file exposure

- [x] 普通模式新增 `recent_files`，无需先知道目录即可发现最新文档、图片和视频。
- [x] 合并 MediaStore 三类集合并按修改时间倒序，支持类型、关键词和数量限制。
- [x] `files_read_all` 在未授予 all-files 时仍可读取系统允许的 `content://` URI。
- [x] 文本返回 UTF-8，二进制以不超过 20 MiB 的 Base64 JSON 返回。
- [x] Android 13+ 请求图片/视频普通权限，返回设置页后刷新授权状态。
- [x] 任意共享路径管理继续要求 all-files；Root/Shizuku 不影响普通文件可见范围。
- [x] 保持其他应用私有目录、Android/data、Android/obb、符号链接与破坏性操作边界。
- [x] Android unit、Vital lint、R8、Release APK 构建通过。
- [x] 文件开关关闭时禁用全部外部文件工具，只保留内部安全目录工具。
- [x] 文件开关开启时跳系统 all-files 页面，并要求应用内选择与系统授权双重有效。
- [x] 应用列表开关关闭时禁用列表/检查工具；开启时跳 Usage Access 系统设置并双重校验。
- [x] 冷启动直接恢复上次本地对话，不等待或默认进入配对远程面。

## Phase 1: Consecutive empty-response contract

- [x] E1 建立 empty/text/tool-call 可编排序列 fixture。
- [x] E2 明确失效后按 5 次重试节奏继续；第 5 次重试仍失效才终止；无响应等待不计数。
- [x] E3 正常文本清零 empty streak。
- [x] E4 有效 tool call 清零 empty streak。
- [x] E5 abort/content filter/显式错误/transport failure 不计入 empty streak。
- [x] E6 定义唯一阈值 5，移除硬编码 `/2`。
- [x] E7 第 1–4 次只重试同一 deployment，第 5 次只输出一次最终错误。
- [x] E8 不重复 prompt、tool call、token 或持久化历史，计数不跨响应/会话/Agent 泄漏。

## Phase 2: Motionless conversation-history disclosure

- [x] U1 header 与 chevron computed-style 负向测试覆盖 animation/transition/transform/scale/filter。
- [x] U2 禁止 pseudo-glass、liquid float/canvas 和 transient overlay。
- [x] U3 click、Enter、Space 同一任务内直接切换 expanded/body 状态。
- [x] U4 chevron 瞬时改变方向，body 直接 `display` 切换。
- [x] U5 保留静态 focus-visible；真正 selection 控件玻璃行为不变。
- [x] U6 连续切换 8 次：一个 header、一个 badge、零玻璃节点，持久化状态正确。

## Phase 3: Gates and evidence

- [x] G1 `cd DESKTOP; npm run build`。
- [x] G2 focused empty fixture、auto agent integration、model recovery、normal chat regression。
- [x] G3 `npx tsx src/tests/pcGlassMigrationVerify.ts`。
- [x] G4 真实 Electron work-review/disclosure smoke。
- [x] G5 `cd DESKTOP; npm run test:full-release`。
- [x] G6 `cd DESKTOP; npm run release:version-check`。
- [x] G7 实现后同步 README、OVERVIEW、taste、tasks 与 timestamped archive。

---

## Historical checklist: dev-0.5.7

# Newmark Agent dev-0.5.7 TODO

## Phase 1: Failure Baselines

- [ ] T1.1 复现 Android 非当前远程对话长按的静止、拖动、取消和列表刷新路径。
- [x] T1.2 记录 PC pointerdown -> float -> pointerup -> command -> landing 时间线。
- [x] T1.3 建立 fixed/auto、auto switch、fallback、failure type 路由矩阵。

## Phase 2: High-Risk Correctness

- [x] T2.1 修复远程对话长按的 stable-id、bounds 缺失与重组竞态。
- [x] T2.2 确保所有 gesture lock、flight job、drag/menu 状态在结束和取消时释放。
- [x] T3.1 在 route planning 与所有替换入口统一执行 fallback hard gate。
- [x] T3.2 fallback off 允许同 deployment retry，但禁止任何其他 modelId。
- [ ] T3.3 验证 GUI 保存后现有 runtime、切会话和重启均立即遵守关闭状态。

### Checkpoint A

- [ ] Android 非当前远程对话长按无 FATAL/ANR。
- [ ] fallback off 路由审计中其他 modelId 数量为 0。
- [x] Desktop build 与 Android unit tests 通过。

## Phase 3: Glass Input and Animation

- [x] T4.1 PC pointerdown 同步挂载浮块，fresh capture 改为异步刷新。
- [x] T4.2 PC pointerup 在同一事件循环提交业务 click，不等待 350ms settle。
- [ ] T4.3 覆盖 capture/WebGL 失败、快速连点、拖选和关闭清理。
- [ ] T5.1 统一 `idle/lift/flight/drag/land/dispose` 可取消状态机。
- [x] T5.2 将 lift/flight 加速，并增加 100-130ms shrink/fade landing。
- [ ] T5.3 同项、重定向、取消和 reduced-motion 最多保留一个浮块。
- [x] T6.1 PC 所有 interaction float 改为每边固定外扩 6px。
- [x] T6.2 PC dispersion spatial band 与 6px edge 读取同一 token。
- [x] T6.3 Android 对话/菜单/pager/rail 改为每边固定外扩 6dp，移除 scale 模拟包边。

### Checkpoint B

- [x] PC pointerup -> command p95 < 50ms。
- [x] PC 6px、Android 6dp 在不同尺寸/密度下成立。
- [ ] landing 至少有两个可见非终止帧，连续 50 次交互无残留。

## Phase 4: Scoped Visual Corrections

- [x] T7.1 block/tool/review 等 transcript 展开加入 no-interaction-glass 契约。
- [ ] T7.2 键盘、hover、focus、chevron 和内容展开行为保持正常。
- [x] T8.1 仅提高 Android light sidebar 语义 surface，不改 Android popup。
- [x] T8.2 仅提高 PC light settings/modal carrier，不改 PC sidebar。
- [ ] T8.3 暗色模式、玻璃强度和 blur 曲线保持不变。
- [x] T9.1 Android 输入弹窗、设备选择、Memory Lab、SubAgent 壳统一 22dp。
- [ ] T9.2 portrait/landscape/foldable 下检查裁剪、触摸轮廓和动画首尾。

## Phase 5: Release Gate

- [x] T10.1 运行 `cd DESKTOP; npm run test:full-release`（退出码 0）。
- [x] T10.2 运行 `android\gradlew.bat -p android testDebugUnitTest lintVitalRelease assembleRelease --no-daemon`（73 tasks，BUILD SUCCESSFUL）。
- [ ] T10.3 在真实 Electron/packaged app 复测点击延迟、展开无玻璃和亮色设置弹窗。
- [ ] T10.4 在 Android 设备复测非当前远程对话长按、6dp 固定包边、landing、速度变形、亮色边栏和 22dp 弹窗。
- [x] T10.5 更新 README、OVERVIEW、archive、版本与产物哈希。

---

## Historical TODO

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

## 2026-08-26 dev-0.5.8 移动端对话菜单与归档动画

- [x] 更多按钮菜单从按钮右上锚点缩放淡入，关闭时反向收回。
- [x] 长按菜单从对话胶囊中心缩放淡入，关闭时反向收回。
- [x] `AnchorMenu` 在退出动画结束前保留 Popup composition。
- [x] 本地与远程对话归档先关闭菜单，再淡出/轻微收缩胶囊，最后提交删除。
- [x] 新增 `ConversationMenuArchiveAnimationContractTest` 回归契约。

## 2026-08-26 dev-0.5.8 默认时钟闹钟通道

- [x] 复现旧 `AlarmManager + Receiver + Notification` 仅创建 Newmark 内部提醒的问题。
- [x] `create` 改用 `AlarmClock.ACTION_SET_ALARM` 并显示默认时钟确认界面。
- [x] `list` 改用 `AlarmClock.ACTION_SHOW_ALARMS` 打开默认时钟闹钟列表。
- [x] 移除 `SCHEDULE_EXACT_ALARM`、内部 AlarmReceiver 与虚假的跨应用 cancel/id 语义。
- [x] 增加默认时钟系统协议回归契约。

## 2026-08-26 dev-0.5.8 Android 压力门禁与 APK

- [x] 全量 `testDebugUnitTest`：151 项，0 failure/error/skipped。
- [x] 独立 `assembleStress` 压力变体构建成功。
- [x] 正式 `lintVitalRelease`、R8、资源优化、签名与 `assembleRelease` 成功。
- [ ] 实机 `mobile-agent-stress.ps1` 未执行：当前 `adb devices` 无连接设备/模拟器。

## 2026-08-26 dev-0.5.8 移动端工具链与上下文结构

- [x] 删除本地 Agent 写死的 6 轮工具调用上限及“轮次超限”伪错误。
- [x] 工具链持续到最终响应、用户停止或真实 provider/tool 错误。
- [x] 每个 provider 工具子轮重新检查 70% 自动压缩与 90% 强制安全压缩。
- [x] 增加 PC 风格 request-scoped task focus、Guide 顺序和历史不可信数据边界。
- [x] 请求焦点层只参与 transport，不进入显示历史、持久上下文或压缩摘要。
- [x] 新增 `MobileAgentLoopContextParityContractTest`。
- [x] request focus 移除消息数、工具数、模式和 message id 等动态字段，保证工具子轮 system 前缀字节稳定。
- [x] 增加跨消息增长/模式/工具数量的 prompt cache 稳定性测试。

## 2026-08-26 dev-0.5.8 文件占位恢复与富文档读取

- [x] recent_files 合并 MediaStore 与已授权 DocumentProvider 文件集合。
- [x] 返回 document_id、canonical_identity、provider_flags 与 placeholder 状态。
- [x] content URI 读取通过 Asset/FileDescriptor 触发云端/系统优化占位内容恢复。
- [x] 支持 PDF、DOC/DOCX、PPT/PPTX、CSV/TSV、XLS/XLSX 结构化读取。
- [x] PDF 实现文字层→视觉模型→miniOCR→LLM 完整视觉退路并标注命中阶段。
- [x] 新增 `RichDocumentAndPlaceholderContractTest`。

## 2026-08-26 dev-0.5.8 移动端玻璃浮块重叠飞行

- [x] 完整检索并建立既有浮块白名单，未将普通组件转换为玻璃。
- [x] 浮起与移动并发，允许未抵达目标前开始落地收缩。
- [x] 保证起点色块浮起与目标色块最终收缩两个硬边界。
- [x] 对话胶囊、侧栏工具、右栏分页、记忆实验室分页、输入复合菜单统一接入。
- [x] 长按/拖动期间保持浮起，松手后才落地；重定向复用当前浮块。
- [x] 158 项 JVM 单测、Vital lint、R8、资源优化与 Release APK 构建通过。

## 2026-08-26 dev-0.5.8 移动端取消 MD3 点击涟漪

- [x] 完整检索 clickable、combinedClickable、indication 与 Material3 按钮入口。
- [x] 在 NewmarkTheme 根部统一提供无绘制 indication。
- [x] 保留点击/长按/拖动、禁用态、无障碍语义和自有动画。
- [x] 新增 `GlobalNoRippleContractTest`，先红后绿。
- [x] 完整 JVM 单测与 `lintVitalRelease` 通过。
- [ ] Release APK 覆盖打包被现有 `app-release.apk` 的外部 Windows 文件锁阻止。

## 2026-08-26 dev-0.5.8 移动端 Memory Lab PC parity

- [x] 工具链补齐 read/query/update/delete/reindex。
- [x] 支持 description、tagPaths、kind、reason/source 与 expectedUpdatedAt。
- [x] 更新/删除前归档旧版本，追加 policy.jsonl，返回 rebuild receipt。
- [x] 总览保持 PC 关系云视觉和移动端拖动/缩放/48dp 命中优化。
- [x] 详情补齐元数据、标签路径、别名、Markdown、新增/编辑/重构/删除入口。
- [x] 新增 PC parity 回归契约；161 项单测与 Vital lint 通过。
# Mobile unified backend checklist (2026-08-18)

- [x] Prevent historical/live WorkRuns from being appended at the transcript frontier.
- [x] Reject incomplete or stale remote workspace/conversation/run identities.
- [x] Make the PC runtime authoritative for the remote queue.
- [ ] Route all Compose send/queue/Guide/stop operations through one backend interface.
- [ ] Implement the local adapter with full PC kernel-equivalent queue and Guide lifecycle.
- [ ] Add local-vs-remote event-sequence conformance fixtures.

## 2026-08-18 mobile dev-0.4.51 gate

## 2026-08-26 PC terminal backpressure

- [x] PTY 输出按 20ms 窗口合并后跨 IPC 发送，保留历史上限 256 KiB。
- [x] 普通终端与 Agent takeover 使用逐帧 DOM 追加，避免 `innerHTML +=` 全量重建。
- [x] 新增 10,000 碎片压力回归 `test:terminal-output-stress`。

## 2026-08-26 Mobile empty-response continuity

- [x] 移动端 Agent build loop 仅对完全无活动的响应连续计数；正文、思考或工具调用均视为成功活动并清零计数。
- [x] 仅 provider 明确失效空响应进入恢复；等待、静默、EOF、超时、流关闭不计为空响应。
- [x] 明确失效后按 200ms、800ms、2s、10s、60s 执行 5 次重试，第 5 次仍失效才终止；任意正常响应清零计数并继续 build block。
- [x] 新增 `MobileEmptyResponseRetryContractTest`，Debug 单测通过。
- [x] 收敛 MemoryLab 工具暴露说明并声明结构化调用/输出格式，禁止 schema/index 噪声泄漏到对话。

## 2026-08-26 Mobile local Agent response stabilization

- [x] 统一所有移动端本地 Agent provider 调用经过空响应恢复层（主对话、视觉文档、OCR 校正、上下文摘要）。
- [x] 仅 provider 明确失效空响应进入重试；依次等待 200ms、800ms、2s、10s、60s；仅思考结果不计为空并继续保持 Build。
- [x] 出现正文或工具调用立即清零；部分正文后传输失败不重复渲染已展示内容。
- [x] 完整 Debug 单元测试与恢复分类测试通过。
- [x] 全调用点审计：ChatViewModel 仅在恢复层内部直接访问 ApiClient，主 Agent/视觉/OCR/压缩均统一接入。
- [x] 基于响应恢复修复重新构建正式 Release APK，并完成 manifest/hash 校验。
- [ ] 在已连接 Android 模拟器上完成长对话 + 空响应真实 UI 压测（当前 adb 无设备，脚本停在 waiting for device）。
- [ ] Stress fixture pairing/remote Build state still fails on online emulator despite direct Intent launch and 35s wait; needs fixture/app remote-state investigation.

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

## 2026-08-26 Mobile empty-response parser stability follow-up

- [x] 修复 chat SSE 解析将完整 `choices[0].message` 帧误丢弃的问题，兼容增量与缓冲式 provider。
- [x] 完全无活动但明确失效的响应按 200ms、800ms、2s、10s、60s 重试；第 5 次仍失效才结束；思考/正文/工具调用均清零计数。
- [x] 新增完整 `message` 与“思考后正文”SSE 回归测试；Android Debug 单测 169 项通过。
- [x] 重新构建 Release APK，产物哈希记录于归档。
- [x] 对齐 PC 瞬态传输错误边界：思考阶段的 EOF/连接重置/超时进入连续恢复，不直接终止。

## 2026-08-26 模型菜单玻璃拖动调度

- [x] 模型列表结构与命中几何缓存。
- [x] 移除拖动 Job/activeIndex 的 Compose 状态写入。
- [x] 同一目标行重复指针事件去重。
- [x] 位移/速度延迟到 graphicsLayer 更新阶段读取。
- [x] 本地 Agent delta 以 16ms 窗口批量发布并在响应边界 flush。
- [x] 新增模型菜单调度回归并更新既有玻璃/空响应契约。
- [x] 171 项 JVM 测试、Vital lint、R8、Release APK 构建通过。
- [ ] 连接模拟器或真机后采集模型二级菜单在本地 Agent 压力下的 `gfxinfo` 帧数据。

## 2026-08-26 移动端同节点思考接续

- [x] 复现同一 Build 内 thought-only provider 子轮反复生成独立“进行了思考”。
- [x] 在事件源引入 `MobileThoughtContinuation`，不使用 UI 去重掩盖根因。
- [x] 连续 thought-only 子轮接续同一节点；工具、正文、Guide、错误和终态形成真实边界。
- [x] 流式 reasoning delta 与最终 reasoningContent 去重并保留完整内容。
- [x] 1000 子轮压力测试保持 1 个 thought shell；174 项 JVM 测试零失败。
- [x] Vital Lint、R8、Release APK 构建通过并记录 SHA-256。
- [ ] 当前 ADB 无设备；连接模拟器或真机后补长对话真实 UI 压测。

## 2026-08-26 移动端思考响应续接

- [x] thought-only 子轮的下一请求携带前轮进度，不再原样重放相同上下文。
- [x] 续接检查点限制为 12,000 字符并仅存在于当前 provider request。
- [x] Guide、工具调用、正文、错误和 Build 终态清空临时续接状态。
- [x] 较短或不兼容的最终 reasoning 不覆盖已显示流式内容。
- [x] 1000 子轮保持单一 thought、检查点有界、最新进度存在且 durable messages 不变。
- [x] 178 项 JVM 测试、Vital Lint、R8 与 Release assembly 通过。
- [ ] 当前 ADB 无设备；补测真实 provider 长思考的中断/续接视觉表现。

## 2026-08-26 thinking-mode 原生状态修复

- [x] assistant 续思检查点改用 `reasoning_content`，普通 `content` 不再携带伪内部提示。
- [x] transient reasoning 不进入 conversations.json、modelContext 或压缩历史。
- [x] Chat SSE 必须收到 `[DONE]` 或 `finish_reason` 才确认完成；异常断流不自动重传。
- [x] 只有 `length`、`max_tokens`、`max_output_tokens` 触发续思子轮。
- [x] 当前部署的六个智能档位及 `thinking_tier_map` 同步传入 Chat Completions/Responses。
- [x] 183 项 JVM 测试、Vital Lint、R8、Release APK 与 SHA-256 校验通过。
- [ ] ADB 设备缺失，尚未完成真实 Provider 长思考 UI 回放。

## 2026-08-27 工具参数上下文连续性

- [x] PC/Android Chat Completions 支持标准增量、累计快照与完整重复参数帧。
- [x] PC/Android Responses 支持累计参数；PC 兼容缺失 `output_item.done` 的完成流。
- [x] PC Chat/GitHub Models 按工具 index 隔离交错并行参数。
- [x] Android 工具执行器严格拒绝多个拼接 JSON 对象和非对象参数。
- [x] 下一轮请求保留 assistant tool call、匹配 call id 的 tool result 与字节稳定历史前缀。
- [x] PC 45 子轮缓存压力、provider/runtime/档位回归全部通过。
- [x] Android 187 项测试、Vital Lint、R8、Release 构建及 APK v2 签名验证通过。
- [ ] 连接 ADB 设备后用真实兼容供应商复放长对话；未执行前不声明实机闭环。

## 2026-08-27 dev-0.5.8 全平台发布候选

- [x] `npm run release:version-check`：desktop/android `0.5.8`，`versionCode=508`。
- [x] `npm run release`：Desktop full release 与 Android unit/Vital Lint/R8/Release 全部通过。
- [x] Windows `x64.msi` 与 `win-unpacked-x64.zip` 构建及打包态 smoke 通过。
- [x] Linux AppImage、deb、unpacked ZIP 构建及 WSL GUI/Bash/sh smoke 通过。
- [x] Android APK 复制到统一 release 目录，APK v2/Android Debug 证书校验通过。
- [x] 六资产精确名称、大小、SHA-256 与隔离副本一致性验证通过。
- [x] 临时验证副本已清理；未修改 `release-0.5.4/` 或用户现有工作树。
- [ ] macOS DMG 需在 macOS 主机执行 `npm run dist:mac`；本机无法合法生成或验证。
- [ ] Android 真机/模拟器安装与长对话回放待 ADB 设备接入。
- [x] `ee98a43` 推送到 `origin/master`，带注释标签 `dev-0.5.8` 已推送。
- [x] GitHub prerelease 发布六资产；npm `newmark-agent@0.5.8` 发布成功。
- [x] GitHub Windows/Linux/Android release workflow 与 npm workflow 全部通过。
- [x] 从 GitHub 重新下载恰好六资产，大小/SHA-256 一致，Windows MSI/ZIP 与 Linux 三包 smoke 全部通过。
## 2026-08-28 dev-0.5.10 设置页拖动浮块合成层

- [x] 浅色主题、连续往返拖动、缓存过期和大浮块预热运行态复现。
- [x] 确认浮块 DOM 约 66×43px、Canvas backing 约 99×65，设置布局本身未失控。
- [x] 可见 Canvas 改为每个浮块独享，并显式绑定当前浮块 CSS 宽高。
- [x] `npm run build` 与 `pcGlassMigrationVerify` 通过。
- [x] 修复后 Electron 截图无白块，释放后 popover/float 均为 0。
- [x] 打包 MSI、替换同版本安装并核验已安装 app.asar、CLI、用户状态与 GUI。
## 2026-08-28 dev-0.5.10 移动端液态增强与画布

- [x] 回到底部按钮接入 8dp 透明光学外扩画布。
- [x] 保持按钮 40dp 布局/点击区和 22dp 图标不变。
- [x] 小幅增强共享速度形变与受阻轴向延展，保持 4dp 位移上限。
- [x] 更新画布和液态参数契约测试。
- [x] 全量 JVM、Vital Lint、R8、Release APK 构建通过。
- [ ] ADB 设备接入后补回到底部按钮浮起截图与拖动手感实测。
- [x] GitHub Actions trusted publishing 已发布 `newmark-agent@0.5.10`，npm `latest=0.5.10`；本地 `npm whoami` 401 不影响已完成的远端发布。
- [ ] 在真实 Android 设备复测 GPU；修复 stress variant 的 minSdk/D8 与 queue benchmark fixture 后补绿门禁。
- [ ] 在 macOS 主机执行 `npm run dist:mac` 生成 DMG。
- [x] 从 GitHub 重新下载六资产并逐个核对大小/SHA-256；Windows MSI/ZIP、Linux AppImage/deb/ZIP 打包态冒烟全部通过，下载 APK v2/Debug 证书复核通过。
## 2026-08-29 dev-0.5.11 Memory Lab 与发送按钮

- [x] Memory Lab 返回键和文字玻璃操作按钮使用透明外扩光学画布。
- [x] 发送按钮工作态图标在 36dp 控件内居中。
- [x] `running && hasText` 使用独立 PC 同款 running-send 第三态。
- [x] 添加三态映射与 Memory Lab 不截断回归契约。
- [x] Android 全量 205 项 JVM 测试、Vital Lint、R8、Release 编译与版本一致性检查通过。
- [x] 归档最终命令、结果与 APK 指纹。

## 2026-08-29 dev-0.5.11 手动供应商与模型

- [x] 供应商列表提供常规“新建供应商”入口。
- [x] 支持名称、协议、API 接口和可选 API Key。
- [x] 新建供应商后直接进入详情。
- [x] 供应商详情提供独立“新建模型”入口。
- [x] 支持模型标识、显示名、上下文长度、描述、视觉和思考能力。
- [x] 复用 ProviderStore 并覆盖重复模型标识。
- [x] Android 209 项 JVM 测试、Vital Lint、R8 和 Release assembly 通过。

## 2026-08-29 dev-0.5.11 模型供应商胶囊滑轨

- [x] 五个模型与供应商子设置页全部改为 44dp 单行胶囊。
- [x] 页面复用左侧栏三个按钮同款纵向胶囊玻璃浮块，支持起终点色块形变、点击定位及长按上下拖动。
- [x] 新建供应商协议改为横向胶囊玻璃滑轨。
- [x] 模糊注入协议改为横向胶囊玻璃滑轨。
- [x] 保留列表快速滚动、原保存/发现/远程拉取行为和无 ripple 交互。
- [x] Android 212 项 JVM 测试、Vital Lint、R8 和 Release assembly 通过。

## 2026-08-29 dev-0.5.11 PC 启动响应优化

- [x] 读取历史启动日志并记录 Agent 8122ms、主界面 14974ms 基线。
- [x] 将生命周期 marker 扫描移出同步 Agent 构造路径，按 24 个一批异步处理。
- [x] 先显示轻量启动页，再在同一 BrowserWindow 导航并提升主界面。
- [x] 正常退出直接删除当前 marker；异常退出 marker 继续用于恢复。
- [x] 1000 marker 压测达到 shell 721ms、index 2567ms、interactive 2772ms、0 次无响应、剩余 1 marker。
- [x] `npm run test:full-release`、`npm run test:startup-responsiveness`、`npm run release:version-check` 通过。
- [x] Android APK 已构建并记录 52,750,472 bytes 与 SHA-256。
- [ ] 本轮未生成或安装 Windows MSI/ZIP；安装版启动性能需在后续打包任务中复核。

## 2026-08-29 dev-0.5.11 模型供应商浮块交互补正

- [x] 删除独立纵向轨道、4dp 轨道槽和左侧占位。
- [x] 点击供应商、新建供应商、模糊注入、新建模型均在完整落地后导航。
- [x] 横向协议选择补齐完整浮起、并行移动和落下。
- [x] 横纵浮块共享互斥协调器，禁止同时起飞。
- [x] 协议横轨成为纵向硬边界，纵向浮块不能跨越。
- [x] 213 tests / 61 suites、Vital Lint、R8、Release assembly 通过。
- [ ] 当前无设备运行态截图；未声明真机动画验收。
- [x] 用户要求重新打包 APK：完整 Android 发布门禁复核通过，产物 v2 签名与 SHA-256 已确认。

## 2026-08-29 dev-0.5.11 输入胶囊排除与首页飞行动画

- [x] 输入字段从纵向浮块目标、手势起点和初始高亮中排除。
- [x] 输入框文字输入、选择与长按不再触发父级纵向浮块。
- [x] 首页点击使用真实 380ms `Animatable` 位移，不再瞬时赋值后等待。
- [x] 位移和浮起/落下并行执行，均完成后才导航。
- [x] 214 tests / 61 suites、Vital Lint、R8、隔离 Release assembly 通过。
- [x] APK v2/Debug 证书、版本 0.5.11/511、大小与 SHA-256 已复核。
- [ ] 当前无 ADB 设备，仍需真机确认最终触感与逐帧视觉效果。

## 2026-08-29 dev-0.5.11 模型供应商五项交互补正

- [x] 创建/取消双按钮从整行纵向浮块目标和手势起点排除。
- [x] 每个按钮接入自身尺寸玻璃，完整浮起落下后执行并支持 4dp 阻尼拖动形变。
- [x] 首页点击索引按实际行区间计算，修复向下一项偏移。
- [x] 快速长按释放等待旧动画取消并从当前帧连续吸附落地。
- [x] 拉取弹窗居中并展示在线/离线；离线设备禁用，ViewModel 增加连接校验和 8 秒超时。
- [x] 亮色模式命令行发送图标使用主题前景色。
- [x] 218 tests / 61 suites、Vital Lint、R8、隔离 Release assembly、版本和 v2 签名通过。
- [ ] 当前无 ADB 设备，需真机复核按钮拖动手感、弹窗布局和快速松手逐帧效果。

## 2026-08-29 dev-0.5.11 PC 启动优化 MSI

- [x] `test:startup-responsiveness` 通过，0 次无响应采样，最终 1 个 lifecycle marker。
- [x] 隔离构建 `Newmark-Agent-0.5.11-x64.msi`。
- [x] MSI 行政解包及 34 项功能断言通过，打包态 CLI/TUI/上下文压力门禁通过。
- [x] 记录 MSI 大小、SHA-256 与未签名边界。
- [x] 已触发 UAC 安装。
- [x] 识别 `REINSTALL=ALL` 维护模式假成功，并成功卸载旧 0.5.10；关键用户状态哈希不变。
- [x] 再次触发全新安装 UAC；0.5.11 注册表、CLI、ASAR 与用户状态边界通过。
- [x] 安装版启动响应验收：shell 603ms、Agent 1959ms、主界面 4288ms，113 样本 0 次无响应。

## dev-0.5.11 全平台发布后续

- [x] Windows、Linux、Android 六个本地 0.5.11 候选资产已构建并逐件冒烟。
- [ ] 在 macOS 主机执行 `npm run dist:mac` 并验证 DMG；Windows 主机不得替代声明。
- [ ] 使用正式 Windows 代码签名证书和 Android Release keystore 重新签名生产候选。
- [ ] 用户明确授权发布后再上传远端 Release；当前未上传 GitHub/商店。
- [ ] 连接 Android 设备后补做模型供应商玻璃交互与弹窗的真机视觉验收。

## dev-0.5.11 移动端图片与回到底部玻璃

- [x] 本地 Agent 提供 PC 同名 `image_display`，展示记录进入 Build 历史。
- [x] 本地/远程用户图片显示在对应文字上方并支持展开。
- [x] 回到底部的静态边框与动态玻璃使用同一光学层。
- [x] 220 tests / 62 suites、Vital Lint、R8、隔离 Release APK 与 v2 签名通过。
- [ ] 当前无 ADB 设备，仍需真机确认大图展开、长历史滚动和玻璃边框逐帧观感。
## dev-0.5.11 发布收尾

- [x] 移动端图片方向与对话底部动态避让修复。
- [x] Markdown/LaTeX 阅读器安全边界修复。
- [x] GitHub `dev-0.5.11` 六资产上传并回下载校验。
- [ ] 记录 macOS、生产签名和真机视觉验收边界。

## 2026-08-31 dev-0.5.13 PC Build 展开按压暗色修复

- [x] 将 Build 标题从通用 `background-color: revert !important` 按住态规则中拆出。
- [x] Build 标题按住态显式保持透明、无背景图、无滤镜与无伪元素。
- [x] 增加静态 CSS 回归契约。
- [x] 真实 Electron 暗色按住态计算样式与截图通过。
- [x] Desktop 构建、1676 项主断言、聚焦测试与版本一致性检查通过。
- [x] 归档最终命令、结果和视觉证据。

## 2026-08-31 dev-0.5.13 PC MSI 打包与本机安装

- [x] 桌面 clean build、1685 项主验证、运行时诊断/生命周期/OCR fallback/隔离与版本检查通过。
- [x] 生成并验证 `release/Newmark-Agent-0.5.13-x64.msi` 和 Windows 解包 ZIP。
- [x] MSI/ZIP 通过打包态 CLI、上下文压缩、控制台参数边界和真实 SSH/TUI 压力测试。
- [x] 安装前关闭且仅关闭已核实来自 `C:\Program Files\Newmark Agent` 的 4 个进程。
- [x] UAC 安装返回 0，MSI 日志明确记录安装成功。
- [x] 注册表 `0.5.13.0`、三种 CLI `0.5.13`、安装/候选 `app.asar` SHA-256 一致。
- [x] 用户 `.Newmark` 安装前后 20,871 文件、335,791,057 bytes、聚合 SHA-256 完全一致。
- [x] 安装版 GUI 主窗口和全部采样 Electron 子进程 `Responding=true`。
- [ ] MSI 尚未进行 Authenticode 生产签名，也未上传远端 Release。

## 2026-08-31 dev-0.5.13 移动后台 Agent 连接

- [x] 识别通知服务与真实 Agent/连接所有权分离的根因。
- [x] 前台服务接入 `SupervisorJob`、CPU/Wi-Fi lock、默认网络 callback 与 `specialUse` 声明。
- [x] 本地 Agent 主协程从 `viewModelScope` 迁入服务运行域。
- [x] 远程 SSE 与重连从 `viewModelScope` 迁入服务运行域，活跃 Agent 不再受 5 分钟总重连上限。
- [x] 已配对状态建立后台连接租约；无 UI 时服务维持认证 SSE，重新进入后交还正式事件流。
- [x] 网络恢复清理旧 OkHttp 连接池并立即重连。
- [x] 本地请求仅在尚无模型活动的瞬态网络失败时等待恢复并退避重试。
- [x] 手动停止立即刷新服务计数并释放无用本地租约。
- [x] 230 tests / 64 suites、Debug/Release Kotlin、Vital Lint、R8 通过。
- [ ] 当前没有 ADB 设备；需真机执行锁屏、划走任务、Wi-Fi/移动网络切换及 30 分钟以上长运行验收。
- [ ] Google Play 分发前需申报 `specialUse` 长期 AI Agent 网络会话用途。

## 2026-09-01 dev-0.5.13 移动后台强化 APK

- [x] 230 tests / 64 suites、Vital Lint、R8、资源收缩与隔离 Release assembly 通过。
- [x] 最终 APK 二进制 Manifest 包含 `specialUse` 服务、Wi-Fi 权限与长期 AI Agent subtype。
- [x] APK 版本 `0.5.13/513`、v2 Debug 签名、大小与 SHA-256 核验通过。
- [x] 交付 `APK/Newmark-Agent-0.5.13-background-agent-service-release.apk`。
- [ ] 当前无 ADB 设备；待真机保数据安装及后台长运行/网络切换验收。

## 2026-09-01 移动后台 connection abort 复查

- [x] 确认错误来自本地 Agent provider SSE，不是远程 PC SSE。
- [x] 确认已有 thought/text 后 SocketException 被设计为终态，后台服务存活也不会续接。
- [x] 确认网络 usable 判定缺少 `NET_CAPABILITY_VALIDATED`。
- [x] 确认进程死亡后无持久 checkpoint/resume，现有测试未覆盖真机后台切网。
- [ ] 实现分阶段安全续接、validated 网络门槛、持久运行检查点与结构化连接诊断。
- [ ] 在真实故障设备执行锁屏、划走任务、Wi-Fi/蜂窝/VPN 切换及 30 分钟以上长运行验收。

## 2026-09-01 PC/移动首次输入独立对话命名

- [x] 查明 PC 与 Android 本地现有标题来源和触发时机。
- [x] 编写跨端首次输入独立命名规格与可测试验收条件。
- [x] 用户审核并批准 `tasks/spec-first-input-conversation-title.md`。
- [x] 编写双端标题与移动后台断线恢复的依赖图、风险和分阶段实施计划。
- [x] 用户审核并批准 `tasks/plan.md` 的本次实施计划。
- [x] Task 1：冻结标题与网络恢复纯契约及兼容持久化。
- [x] Task 2：实现 PC 首次输入独立标题请求并退役 completed-Build 命名。
- [x] Task 3：实现 Android 本地独立标题请求，远程保持 PC 单点所有权。
- [x] Task 4：实现 VALIDATED 网络门槛与旧连接淘汰。
- [x] Task 5：实现 provider 流中断后的有界安全续接与合并结果。
- [x] Task 6：实现可恢复状态的受控错误投影并保留服务 Stop/清理语义。
- [x] Task 7：通过 PC 1687 项、Android 232 项、Release/R8/Vital Lint，并生成强化 APK。
- [x] 最终契约改为双端标题先行硬门禁：标题成功并落库前正式 provider 调用为 0。
- [x] 持久化首消息身份与正式响应启动状态；失败/超时/重启后的后续发送仍重试同一首消息。
- [x] 标题探测使用与正式响应相同的冻结 provider/model 配置，并兼作首轮可用性检查。
- [ ] 真机执行锁屏、划走任务、Wi-Fi/蜂窝/VPN 切换及至少 30 分钟长运行矩阵。

## 2026-09-01 移动首次标题保持“新对话”实测复查

- [x] 确认标题尝试标记在网络请求前即持久化，失败后不会再次请求。
- [x] 确认标题请求的超时、provider 错误、空响应和输出校验拒绝全部静默折叠为空标题。
- [x] 确认标题请求快照发送瞬间 `apiConfig`，但主 Agent 后台协程稍后重新读取全局 `apiConfig`，两者没有共享首轮实际模型快照。
- [x] 确认当前无 ADB 设备，无法从故障手机读取 `conversations.json` 或 provider 时间线区分本次具体落在哪个静默分支。
- [x] 将首轮主请求与标题请求绑定到同一不可变 provider/model/intelligence 快照。
- [x] 历史过渡方案曾在首轮正确响应后补偿标题；现已由标题先行硬门禁取代，响应后不再补偿。
- [x] 232 项测试、隔离 clean Release、R8、资源收缩、Vital Lint、v2 签名与 SHA-256 核验通过。
- [ ] 真机安装后验证标题失败时正式请求为 0、同一对话重试仍取首消息、标题成功后才启动正式响应。

## 2026-08-31 dev-0.5.13 PC 中断后 Agent 回复恢复

- [x] 用真实对话历史确认中断 Build 已保存公开 `response`，但没有 assistant 消息或 `final_response`。
- [x] 中断/强制中断后恢复最后一条非空公开回复为块外 Agent 行。
- [x] 被提升的同一回复不再留在展开 Build 中重复显示。
- [x] 无公开回复的中断不生成虚假 Agent 消息。
- [x] 实时终结、切换对话和重启历史恢复共享同一规则。
- [x] typecheck、desktop build、聚焦 JSDOM 回归和 1685/1685 主验证通过。
- [x] 重新生成包含本修复的 dev-0.5.13 Windows MSI/ZIP，并通过发行包门禁与包内关键逻辑核验。
- [x] 两次 UAC 取消后确认 MSI 未执行、安装目录仍是旧构建、`.Newmark` 全量基线完全不变，并恢复旧版 GUI 运行。
- [ ] 用户允许下一次 UAC 后覆盖安装修复 MSI，并核验安装 `app.asar`、三种 CLI、GUI 响应及真实中断对话显示。

## 2026-09-01 dev-0.5.13 Search MCP 与移动供应商协议

- [x] 建立可定制 Search MCP 端点清单（enabled/priority/order/transport/tool/timeout），配置位于安装者本地 `user/.Newmark/search-mcp.json`。
- [x] PC `web_search` 每次重新读取清单并完整轮询所有启用 MCP；固定退路为 MCP → Bing HTTP → DuckDuckGo HTTP。
- [x] 修复跨端全局回退顺序：新增 Bearer 认证 PC MCP-only mobile endpoint，Android desktop bridge 不再提前触发 PC Bing/DDG；双端 MCP 全部失败后才进入 Android Bing → DuckDuckGo。
- [x] Wuxing 保留为内置候选；因当前真实 tools/call 缺少 SearXNG 而失败，按准入规则默认禁用，不伪造健康。
- [x] PC 公开清单移除 command/args/cwd 与 secret 值，错误/探测结果脱敏本地路径，MCP 输出限制为 60K。
- [x] 每轮健康文件原子刷新，只做可观测快照，不读取旧状态形成熔断或跳过。
- [x] Android 增加严格 search-only Streamable HTTP/SSE 客户端与认证桌面 stdio bridge；Search MCP 专项 11/11、此前完整 JVM 246/246 通过。
- [x] Android 新增设备级 Search MCP 准入测试：两种传输均覆盖 initialize/list/call、非空公网 URL，并验证仅非搜索工具时不会进入 tools/call；live 模式只连接 `adb reverse` 回环 fixture，清单写入前执行。
- [x] 移动供应商详情支持协议编辑，并新增显式 OpenAI Responses 路由、URL 归一化、旧别名迁移与截断 SSE 失败判定。
- [x] Desktop typecheck/build/Search MCP 专项验证通过，README、OVERVIEW、taste 与 archive 已更新。
- [x] 移动供应商协议最后补丁已复跑：`ApiClientStreamTest` 29/29、完整 `testDebugUnitTest` 263/263 通过。
- [x] 模拟器设备网络栈 instrumentation 4/4 通过 Streamable HTTP、Legacy SSE、非搜索工具拒绝和宿主真实 Ignidor bridge live 准入。
- [ ] 配对 PC 的真实移动端 stdio bridge 与 Responses 供应商真实请求仍需后续真机验收。

## 2026-09-01 dev-0.5.13 双端收口与 r2 APK（历史候选，已被 r3 替代）

- [x] 修复 PC/Android 标题探测硬编码 `low`，共享首轮冻结 provider/model/intelligence。
- [x] PC 在标题门禁前完成 fallback，并向标题请求透传与正式首轮一致的 native reasoning effort。
- [x] Desktop typecheck、build、1696/1696 主验证；`npm audit --omit=dev --audit-level=high` 为 0 vulnerabilities。
- [x] Android 263/263、`lintVitalRelease`、隔离 clean `assembleRelease`、R8 与资源收缩通过。
- [x] r2 包名/版本/SDK/入口、`specialUse` 服务、v2 Debug 签名、4-byte/16 KiB 对齐与 APK 隐私扫描通过。
- [x] 交付 `APK/Newmark-Agent-0.5.13-dual-platform-final-r2-release.apk`，52,794,422 bytes，SHA-256 `6A3B048E987F4BBE94C1F22EFCFD3E2B85DF96B58BEF813FE01C72A581243183`。
- [x] API 35 `emulator-5554` 保数据安装、冷启动、前台 Activity 和无 FATAL/ANR 检查通过。
- [x] r2 因 Responses SSE 缺失内嵌 `response.status` 仍被判成功而由 r3 替代；r2 文件和哈希继续保留为历史/回滚证据。
- [ ] 故障真机完成网络切换/锁屏/划走/至少 30 分钟后台运行，以及真实供应商、配对 bridge 和视觉交互验收。

## 2026-09-01 dev-0.5.13 Responses 严格完成态与 r3 APK

- [x] 新增缺失 `response.status` 拒绝回归，并将成功 SSE fixture 全部改为显式 `status=completed`。
- [x] 流式 `response.completed` 仅在内嵌状态大小写不敏感地等于 `completed` 时成功；缺失、空白、未知或非完成状态均受控失败。
- [x] Responses 聚焦测试 30/30；Android 68 suites / 264/264，0 failures/errors/skips。
- [x] `lintVitalRelease` 3 分 50 秒成功。
- [x] 隔离 clean `assembleRelease` 50 tasks（48 executed、2 up-to-date）5 分 05 秒成功。
- [x] 交付 `APK/Newmark-Agent-0.5.13-dual-platform-final-r3-release.apk`，52,794,422 bytes，SHA-256 `B702EB35EC4E9DB42FD8598865D46EF75F7B707CE6C3C611307CBD573A5B8847`。
- [x] 版本 `0.5.13/513`、v2 Android Debug 签名、4-byte/16 KiB 对齐通过。
- [x] 逐 Zip entry 字节扫描覆盖重复 entry，未命中开发者 profile/workspace、非允许用户目录、凭据或私钥，且未创建扫描临时目录。
- [x] 裸数字 `12252` 仅命中 6 个 vendor 文件；4 ABI ML Kit 库中的 `/home/build` 仅为第三方通用构建标记。
- [x] API 35 `emulator-5554` 安装成功；初次启动进入系统权限页，处理后 `MainActivity` 前台。独立复核一度被电池优化系统页覆盖，返回并显式启动后 2 秒、7 秒及最终查询均恢复 `MainActivity` topResumed；PID 11040 持续存活，FATAL/ANR 为 0。
- [x] 用户本轮只要求 APK，未打包 MSI；r2 已标记 superseded 并保留历史记录。
- [ ] 真机后台切网/长时运行、真实 provider、配对 PC bridge 与逐帧视觉仍待验证。

## 2026-09-01 dev-0.5.13 双端终审修复与 r5 APK

- [x] r4 修复 Responses 根级完成状态绕过并保留缺失状态下的供应商诊断；聚焦 32/32。
- [x] Desktop `pdf_read` 整体累计 timeout 覆盖异步读取、全文解析与扫描页观察，并验证超时后同一 Agent 继续响应。
- [x] Android 标题探测与正式首轮共享冻结的 `thinkingTierMap` / native reasoning effort。
- [x] Android 增加模型视觉 `image_inspect`，覆盖安全工作区、授权 URI/共享路径、PNG/JPEG、10 MiB、4000 万像素和 ephemeral-only 边界。
- [x] Desktop typecheck/build/1702 与完整 `test:full-release`（thinking tier 68/68、压缩压力 34/34、模型恢复、TUI/SSH/WSL/CLI/GUI 三端压力）；无供应商标题门禁保留 `No LLM configured` 诊断。Android 69 suites / 267/267；`lintVitalRelease` 3 分 01 秒；隔离 clean `assembleRelease` 50 tasks（47 executed、3 up-to-date）3 分 49 秒。
- [x] 交付 `APK/Newmark-Agent-0.5.13-dual-platform-final-r5-release.apk`，52,794,422 bytes，SHA-256 `C87DFA53B309D4FE1790FCB5F1EB2084F67BE6E44FC27D76D5E8E4E84A30A14B`。
- [x] 版本/Manifest/v2 Debug 签名/4-byte/16 KiB 对齐、逐 entry 隐私扫描与旧候选哈希保全通过。
- [x] API 35 模拟器 `adb install -r` 成功；2 秒/7 秒 `MainActivity` topResumed，PID 3173，FATAL/ANR 0。
- [x] 后续已打包 Windows MSI，并完成安装验证。
- [ ] 真机后台切网/锁屏/划走/长时运行、真实 provider、配对 PC bridge 与逐帧视觉仍待验证。

## 2026-09-02 PC/移动端标题 5 级自动退避与 Windows MSI

- [x] PC/移动端标题探测统一为 5 次、0s → 1s → 2s → 4s → 8s 退避，空响应或重复输入自动重试。
- [x] PC 1703/1703、Android 69 suites / 267/267；移动错误提示去掉手动再次发送要求。
- [x] 修正 `release-cli-smoke` 与 context-compress 压力夹具，正式请求筛选 `stream=true`；打包后 CLI/上下文压缩/console wrapper 压力通过。
- [x] 交付 MSI 249,629,109 bytes、SHA-256 `AD9427B36178473BAF461C63119D14B5DF1B27EC510205205DD991845ECEE462`。
- [x] UAC 提升安装成功；安装后 app.asar/EXE 与 win-unpacked 哈希一致，注册表版本 `0.5.13.0`。

## 2026-09-02 移动端 Markdown/LaTeX 离线字体与约束内软换行

- [x] 内置 Noto Sans Math 与 Noto Sans Mono CJK SC，并登记 OFL 1.1。
- [x] Markdown 代码/行内码与数学块使用自带字体，不再依赖系统 `FontFamily.Monospace`。
- [x] 代码正文改为父级约束内 `softWrap=true`，移除默认横向滚动。
- [x] Android 70 suites / 269/269、`lintVitalRelease`、隔离 clean Release 通过。
- [x] 候选 `APK/Newmark-Agent-0.5.13-mobile-md-font-r8-release.apk`，66,686,998 bytes，SHA-256 `05A26E0EE66541F656E39412384A689B06AAA2A4ABA363043516C2B862D6A1FE`；r7/r6 保留为回滚候选。高亮色板按亮暗主题切换，亮色绿色改为 `#1B7F3B`。
