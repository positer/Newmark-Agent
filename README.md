# Newmark Agent

Newmark Agent 是面向本地工作区的多端 AI Agent。它把对话、Build/Plan/Goal/Flow、文件与终端、浏览器、Memory Lab、自动化和多 Agent 协作整合在同一套本地状态模型中，并提供 Windows/Linux 桌面端、终端界面、CLI 与 Android 客户端。

当前开发版本：`dev-0.5.8`。provider 空响应恢复仅在明确失效时执行：首次失效后等待 200ms、800ms、2s、10s、60s 进行 5 次重试，第 5 次仍明确失效才终止；持续等待、静默连接、EOF、超时或流关闭不视为空响应。在 Android 上，思考、正文、工具调用或其他有效流式活动都会立即清零计数。对话区 Build/历史展开已恢复为纯内容披露，点击或键盘操作直接切换，不使用玻璃、浮块、过渡或任何装饰动画。桌面端与 Android 从根目录 `VERSION` 读取并校验同一个版本，默认 Release 同时发布 Windows、Linux 和 Android。

当前 Android `dev-0.5.7` 已统一移动端液态选择器：点击播放完整的源选项浮起、移动、落下动画，连续点击会让唯一浮块从当前帧改道到最后目标再落下；拖动必须先静止按住 300ms，之前超过触摸阈值的移动不消费并交还列表/侧栏滚动。会话、左右侧栏工具/分页和 Memory Lab 分页共用这一规则；本地/远程对话的点按飞行与长按排序共用唯一玻璃浮层，胶囊四边固定外扩 6dp，飞行、跟手与落下全程按实时速度产生沿运动方向拉伸、垂直方向收缩的液态形变，折射随外形同步。拖动期间列表实时空出落点，未位移松手才打开操作菜单。PC 与移动端二态开关统一为“点击直接反转、确认水平拖动后才按松手位置吸附”，纵向滚动不触发开关。Release APK 仍以 `android/app/build/outputs/apk/release/app-release.apk` 为本地验证产物。

## 主要能力

- Electron GUI、`Newmark --TUI` 与 `Newmark --cli` 共用工作区、对话和运行时契约。
- Build、Plan、Goal 与 Flow 支持长任务、队列、暂停/恢复、上下文压缩和可追溯 WorkRun。
- 文件、终端、编辑器、浏览器、Computer Use、Git/GitHub、SSH、MCP、技能、自动化与 Memory Lab 均受策略边界约束。
- 模型按供应商部署隔离；同名模型不会共享凭据、验证状态或路由证据。
- Android 支持本地对话、Agent 可调用的工作区终端、本地工具、Memory Lab、系统日程读取/创建与系统分享接收，也支持配对桌面端后的远端对话、文件上传和工作区操作。
- Android 设置中的“读取所有文件”和“读取应用列表”是 Agent 工具面的硬开关。关闭文件开关时只暴露内部 `files/newmark/workspace` 安全目录；开启后跳转 Android 系统授权页，应用内开关与系统授权同时有效才开放最新文件/共享存储工具。应用列表同样要求应用内开关与系统“使用情况访问”授权同时有效。两项都不依赖 Root/Shizuku。移动端冷启动默认恢复上次本地对话，远程对话仅在用户主动选择设备后进入。
- Android 本地 Agent 在兼容服务拒绝 Chat Completions 的“工具 + 推理强度”组合时，会自动切换到 Responses API；若模型明确不支持 `temperature`，会移除该参数重试并继续流式呈现思考、正文与工具调用。
- 新安装不预置供应商或密钥；用户自行添加供应商，升级不会清除已有配置。

## 下载与安装

从 [GitHub Releases](https://github.com/positer/Newmark-Agent/releases) 下载与系统对应的构建：

| 平台 | 发布资产 |
| --- | --- |
| Windows | `Newmark-Agent-<version>-x64.msi`、`Newmark-Agent-<version>-win-unpacked-x64.zip` |
| Linux | `Newmark-Agent-<version>-x86_64.AppImage`、`Newmark-Agent-<version>-amd64.deb`、`Newmark-Agent-<version>-linux-unpacked-x64.zip` |
| Android | `Newmark-Agent-<version>-android.apk` |

Windows MSI 为整机安装包；便携 ZIP 解压后即可运行。Linux 可选择 AppImage、Debian/Ubuntu 安装包或解压版。Android APK 需要允许当前文件来源安装未知应用。当前发布属于未签名或开发签名的预发布构建，请从项目 Release 页面下载并核对发布资产。

## 远端触及与 Tailscale

远端触及功能需要桌面端和 Android 端协同使用 [Tailscale](https://tailscale.com/) 虚拟组网。两台设备应加入同一个 tailnet，桌面端开启 Remote Touch 后，再使用配对二维码或 Tailscale 地址连接。

建议配置：

1. 在电脑与 Android 设备安装并登录 Tailscale，确认双方处于同一虚拟网络。
2. 在桌面端开启 Remote Touch，或使用 `Newmark.exe remote on`。
3. 使用 `Newmark.exe pair` 显示配对二维码，并由 Android 客户端完成配对。
4. 确保系统防火墙允许 Newmark 使用 TCP `47890`；不要把该端口直接映射到公网。

普通局域网在路由可达时也可连接，但跨网络、移动网络和异地设备应使用 Tailscale。配对令牌与供应商密钥属于私密数据，不应进入截图、日志或仓库。

## 使用

启动桌面 GUI 后，可在设置中添加供应商、模型与工作区。终端入口：

```text
Newmark --TUI
Newmark --cli --help
```

常用 CLI：

```text
Newmark.exe validate-models --selected provider/model
Newmark.exe memory-lab --help
Newmark.exe pair
Newmark.exe remote status
```

用户配置、凭据、对话、缓存和归档默认位于：

```text
~/.Newmark/
```

仓库中的 `DESKTOP/config.example.json` 仅用于展示配置结构。不要提交真实 `config.json`、API Key、配对令牌或生成的用户数据。

## 开发

桌面端需要 Node.js 24 与 npm：

```powershell
cd DESKTOP
npm ci
npm run build
npm run test:full-release
```

Android 需要 JDK 17 与 Android SDK：

```powershell
android\gradlew.bat -p android testDebugUnitTest lintVitalRelease assembleRelease
```

修改版本时使用唯一版本同步命令：

```powershell
cd DESKTOP
npm run release:version-set -- 0.5.2
npm run release:version-check
```

默认完整发布打包：

```powershell
cd DESKTOP
npm run release
```

该命令执行桌面端完整门禁、Android 单测与 Release lint，并在根目录 `release/` 生成 Windows MSI/ZIP、Linux AppImage/deb/ZIP 和 Android APK。推送 `dev-X.Y.Z` 标签时，GitHub Actions 会独立构建三端并把同版本的六个资产发布为 prerelease。

### dev-0.5.8 全平台预发布

2026-08-27 已发布 [`dev-0.5.8`](https://github.com/positer/Newmark-Agent/releases/tag/dev-0.5.8) prerelease。完整发布流水线、本地独立资产 smoke、GitHub 三平台构建和远端回下载验证全部通过；远端六资产的名称、字节数与 SHA-256 均和本地验收候选一致。Windows MSI/ZIP、Linux AppImage/deb/ZIP 完成打包态启动验证，Android APK 通过 v2 签名校验。当前 Windows 包未做 Authenticode 签名，Android APK 使用工程现有 Android Debug 证书，均属于预发布测试构建。本机没有 macOS 原生签名/打包环境，`dist:mac` 需要在 macOS 主机另行生成 DMG。

| 资产 | SHA-256 |
| --- | --- |
| `Newmark-Agent-0.5.8-x64.msi` | `669E808882DADF7790FA4D929E3A42C5717566073A6ECB1EDE7002005BF031E0` |
| `Newmark-Agent-0.5.8-win-unpacked-x64.zip` | `6D037DAB8664D4A75FA2FEE73322A1D9835F9F4DB340ED0BB4858836EFDED555` |
| `Newmark-Agent-0.5.8-x86_64.AppImage` | `FCF25AB45D8C4F6F5FD876C14654E48C4C9653AE7FB864F1EAB52AA24BE18F5F` |
| `Newmark-Agent-0.5.8-amd64.deb` | `C75FE9834F7CD2EF69B024C93BF14B366EB98AFDA2F958BC870A4C9029020EEA` |
| `Newmark-Agent-0.5.8-linux-unpacked-x64.zip` | `27236779B69E299C43652A5F5448A33C9B1AF8F05920E09EAFB2CD15DCE2CF8B` |
| `Newmark-Agent-0.5.8-android.apk` | `F514C919411DD2D84214B54024D7CF6D9EB25692E35F7D5465FF8FC08188325F` |

## 架构

### dev-0.5.7 corrective release

PC interaction glass uses one 6px geometry token for both the outer edge and dispersion band. Its command runs synchronously on pointer release while backdrop capture and the 120ms shrink/fade landing remain non-blocking; transcript block, tool, and review disclosures do not create floating glass. Light-theme settings/modal carriers are brighter without changing the already-correct PC sidebar.

PC light-theme sub-windows opened from the left tool rail (Plugins, Memory Lab, Automation, Flow, workspace dialogs, and Settings) now share the same bright carrier surface. While a mouse press remains active, selector glass listens at window capture scope and continuously projects the pointer onto its horizontal or vertical track even outside the source control; native conversation drag glass is likewise updated from document-level drag events outside the conversation list.

PC click-driven selection glass now reserves the complete visual lifecycle: 360ms for lift/track movement and 180ms for the shrink landing. The logical command still commits immediately on release, while an actual pointer drag removes the click pacing class and retains the faster direct-follow response.

PC conversation and selector glass now applies RGB dispersion across the complete fixed 6px refractive edge instead of cancelling the effect on the capsule center axes. Scrollable selector popups restrict tracking to their visible option track and clamp the float inside the visible popup bounds. On release, the float freezes its final geometry before dispatching the command, so a command that closes the popup cannot erase the landing target or leave a stuck float flying toward the viewport origin.

PC conversation capsules now make the floating glass the sole edge owner: static borders and marquee borders are hidden while covered. Conversation and selector clicks share one serialized visual transaction; repeated clicks redirect the existing float, and page changes, selector commands, and popup teardown wait until the final 360ms movement plus 180ms landing completes. Popup tracking excludes only items fully outside the viewport, so partially visible rows remain reachable.

Android interaction glass now uses fixed `6dp` outer bounds on every side and no longer simulates edge thickness with proportional scaling. Moving glass on desktop and Android deforms from live velocity: it stretches slightly along travel, contracts across travel, and carries the refractive rendering through the same transform. Remote-conversation hold cleanup is stable across non-active rows, refresh and cancellation, popup/dialog shells share a 22dp radius, and light-theme sidebar surfaces are brighter without changing popup brightness.

Android local and remote conversation capsules now suppress both their static outline and running-state marquee outline whenever the shared floating glass covers that capsule. The collapsed and expanded left-sidebar utility selectors and the right-sidebar tab selector apply the same edge-ownership rule: only the item currently covered by the moving glass hides its static border. Conversation reordering stores one stable group destination slot throughout drag preview and release; the release commit no longer recalculates from animation-sensitive bounds, so the persisted order lands in the exact slot opened by avoidance.

Android live activity notifications now use the native Android 16 `ProgressStyle` promoted-ongoing path for Fluid Cloud/Live Update presentation, with separate remote/local running-Agent lines and exactly three alternating progress segments. Older Android versions retain the existing custom two-line ongoing notification and its existing marquee resources.

With model fallback disabled, fixed and Auto routing may retry only the exact same deployment; exhaustion fails instead of selecting an equivalent, fallback, or alternate model identity. Automated release gates pass for desktop and Android. Physical Android-device interaction checks and packaged-desktop visual acceptance remain manual release checks.

Release APK: `android/app/build/outputs/apk/release/app-release.apk` (SHA-256 `C209F32F46D03EC2A1E52164AE580D17F9434263B0FFBB93ED33A72B07F1A2EE`).

### dev-0.5.6 glass interaction

PC and Android controls retain their original static color/surface. Pressing or dragging lifts one Kyant-style glass interaction layer; releasing commits the landing option and restores its color capsule. PC selection glass uses the original per-interaction pipeline: capture the current window, create one independent WebGL2 renderer, upload the captured data URL, and render Kyant's complete rounded-rectangle SDF/lens surface without a center-hole mask or cached stale texture. The original refraction geometry is unchanged; only chromatic sampling is reduced from seven wavelengths to three live backdrop reads at red, green, and blue offsets. Android uses the same RGB-only reduction in the vendored Kyant dispersion shader while retaining its existing Compose backdrop topology and graphics-layer drag translation. The Glass intensity setting continues to drive carrier frost separately from moving-float refraction/dispersion.

Mobile model-list gestures now arbitrate intent before drawing: a tap plays the complete old-selection lift/move/land sequence, a fast vertical move remains list scrolling, and only a stationary 300 ms hold owns glass dragging. Repeated taps redirect the one rendered float from its current position and only the final target commits; tapping the selected item performs the same-position lift and landing. PC/mobile conversation reorder suppresses static selected/drop capsules during the gesture and uses surrounding-row avoidance for the release preview. Android's ongoing live notification shows separate remote/local running-Agent counts on two lines with a moving black-white-black-white gradient bar.

Conversation reordering now keeps one visible carried capsule on both clients. Android preview and commit share the same stable group-slot calculation, and immediately rebases the active conversation's glass origin after a reorder. PC uses a clone of the actual held row as the native drag image, commits the current avoided DOM order even when released in a list gap, and invalidates any pre-reorder glass flight before the next click.

Release APK: `android/app/build/outputs/apk/release/app-release.apk` (SHA-256 `B3198A17B8E9DA8CAE142FC69856C236F88C5FF92B80CA44C1419746BB09B12D`). Current Windows MSI: `release/Newmark-Agent-0.5.6-x64.msi` (SHA-256 `F7ACE76FC3A78BD1B856BB0BE17D2C315DF6E1B0E94451B6A6D2495C3F2888A3`); UAC fresh installation and packaged/installed ASAR equality are verified.

```text
Windows / Linux GUI     TUI / CLI          Android
          \                |                /
           \               |               /
            Conversation- and workspace-bound runtime
                           |
       Agent / Provider / Tool / Context orchestration
                           |
       Local state, Memory Lab, archives and workspaces
```

桌面端远程服务只在用户明确开启后监听；移动端远端操作继续使用桌面端的工作区、对话和运行时身份，不把前台选择当作写入目标。完整内部结构、文件树和历史验收记录见 `OVERVIEW.md` 与 `archive/`，README 仅保留产品使用与发布说明。

## 安全与隐私

- 凭据保存在用户本地配置中，并在诊断和验证输出中脱敏。
- 高风险工具受参数校验、能力供应和授权边界保护。
- 浏览器、运行时事件、草稿、队列和归档按工作区与对话目标隔离。
- 不建议将 Remote Touch 端口直接暴露到公网；异地连接使用 Tailscale 虚拟组网。

## 许可

Copyright © 2025 Newmark AI. All rights reserved. 具体许可边界见 [LICENSE](LICENSE)。

## 2026-08-25 dev-0.5.7 流体云协议与对话玻璃落地校正

Android 16 实时活动恢复为历史实机可工作的
`NotificationCompat.Builder + setRequestPromotedOngoing(true)` 协议。API 36 主路径不再挂载
自定义 `RemoteViews` 或平台 `ProgressStyle`；远程/本地 Agent 计数分别放在标题和正文，旧系统
的两行通知及自定义跑马灯保持不变。

移动端本地与远程对话胶囊的点按、长按拖动统一增加 180ms 落地回缩，动画完成后才移除
玻璃层。光学包边仍固定为 6dp；胶囊半圆端帽使用固定 12dp 横向捕获外扩，补偿左右可见
折射区，不随组件宽度等比放大。记录见
`archive/20260825-fluid-cloud-conversation-glass-final.md`。

后续实测校正将对话落地改为“先锁定唯一目标色块，再让玻璃在其上收缩”，落地使用更明显的
240ms、1.00→0.68 回缩，消除父状态延迟造成的新旧色块闪动。移动端本地/远程对话胶囊、
左栏底部三按钮和右栏分页选中态均取消静态边框；运行中对话也不再额外绘制胶囊跑马边框，
选中状态只由色块底表达。

最终互斥时序进一步统一为：选中色块从交互首帧立即让位，玻璃在原位置用 100ms 从
0.68/透明浮起为完整浮块，随后移动或长按跟手，再用 240ms 收缩落下；玻璃彻底移除后才在
目标位置恢复色块。对话胶囊只保留长按排序的轨迹差异，浮起、互斥与落地效果与输入菜单、
左栏三按钮、右栏分页和 Memory Lab 分页一致，色块与玻璃不会同时存在。

移动选择动画现已补成真正的 `色块 -> 浮块 -> 色块` 可逆材质闭环。唯一动画层在进度 0
就是选中色块，浮起时连续淡出填色并增强折射；落地前先吸附目标中心，再同步收回外扩边界、
退去折射并显回同一层色块。最后一帧与目标静态色块同形同色后才交接，因此不再是玻璃缩没
后色块突然出现。对话胶囊按实际目标宽高计算横纵回缩比例。记录见
`archive/20260825-mobile-fill-glass-fill-closed-loop.md`。

PC List 类弹窗（模型列表、Newmark Select、对话操作列表）不再叠加旧版固定外泛光/阴影底，
只保留当前承载玻璃的实时磨砂与折射边缘。PC 对话长按拖动也从自由二维跟手改为单一纵向
轨道：横坐标固定在对话胶囊列，纵坐标限制在同一置顶分组的首尾槽位之间。Android 本地与
远程对话同步夹取可见浮块位移，排序目标与浮块位置使用相同的首尾边界。记录见
`archive/20260825-pc-list-shadow-and-conversation-drag-track.md`。

实机截图复核发现 List 虽已取消容器 `box-shadow`，仍继承通用玻璃伪元素绘制的整面固定明暗
渐变与内阴影，形成底部灰黑带。模型列表、Newmark Select 与对话操作菜单现同步关闭这两层
固有绘制，仅保留 carrier 本底模糊和轮廓边线。

跨端对话拖动的落地分层已校正：收缩只属于玻璃光学外壳，携带的标题、图标和状态内容保持
原尺寸。PC 对话拖动浮块为内容层增加反向缩放补偿，并在进入落地前停止速度拉伸；Android
本地/远程对话内容行仅在实际跟手阶段应用速度形变，归轨和玻璃回落阶段恢复 1:1。浮起阶段
的现有液态形变保持不变。记录见 `archive/20260825-conversation-shell-content-landing-separation.md`。

实机复核后，Android 对话玻璃进一步取消对整个 backdrop 采样层的 `scaleX/scaleY` 落地缩放。
本地与远程浮层改为围绕目标色块中心，动态收回左右 12dp、上下 6dp 的固定外扩尺寸与坐标；
折射外壳连续落成色块，但下层标题、图标和状态始终保持 1:1，也消除了胶囊落地时的左偏。
对话拖动轨道同时扩展到同置顶分组的首项前与末项后完整插入槽，移动端速度按夹取后的实际
位移计算且仅唯一玻璃外壳形变。记录见 `archive/20260825-conversation-drag-end-slots-and-mobile-shell-landing.md`。

同一落地分层现已同步到移动端左栏三按钮和右栏子分页：折叠左栏的 40dp 外壳收回到居中的
36dp 色块，展开左栏从整行外壳收回四周 4dp，右栏分页从 44×40dp 外壳收回到 32×28dp
按钮色块。三者均通过动态尺寸与中心偏移收边，不再缩放 backdrop 采样层，因此图标、文字
保持原尺寸。记录见 `archive/20260825-mobile-sidebar-selector-shell-only-landing.md`。

当前 Windows MSI：`release/Newmark-Agent-0.5.7-x64.msi`，SHA-256
`F90E44A6BA82A30FD56EC5A97403E4FF6337F341164C4F52BA090F96FC3FD777`。本机已通过 UAC
升级安装至 `C:\Program Files\Newmark Agent`，已安装版本 `0.5.7.0`，安装后的 `app.asar`
与打包产物哈希完全一致。

PC 对话区的审查摘要现按逻辑 Build 运行执行 upsert：增量 diff 快照更新既有卡片，后端正式
runId 到达时接管本地 provisional runId，状态缓存与 DOM 均不会追加第二张审查卡。对话区
同时在全部滚动内容和透明玻璃之下增加随明暗主题变化的实色主题本底，稳定正文对比度而不
覆盖轨道、玻璃折射或用户自定义背景色。回归记录见
`archive/20260825-work-review-incremental-upsert-chat-canvas.md`。

包含该修复的 Windows MSI 已重新构建并完成本机 UAC 升级安装：
`release/Newmark-Agent-0.5.7-x64.msi`，SHA-256
`F8DF62267671B263349F1EEB21017704501F07FE7A7CABDC4D0DC0166A07A3BF`。安装目录为
`C:\Program Files\Newmark Agent`，安装后 `app.asar` 与候选产物哈希一致。性能与安装记录见
`archive/20260825-review-upsert-performance-msi-install.md`。

后续实测定位到 Build 行内审查徽标仍存在独立的展开重复问题：徽标生成类为
`.conversation-work-change-badge`，增量更新误查成 `.conversation-work-run-change-badge`，导致
每次展开/收起都追加一份。选择器已统一，连续 8 次展开/收起仍恒为一个徽标；Build 标题也
加入无玻璃、无按压缩放的展开控件排除规则。记录见
`archive/20260825-build-toggle-review-badge-dedup.md`。

包含该最终展开修复的 MSI 已再次构建并 UAC 安装：
`release/Newmark-Agent-0.5.7-x64.msi`，SHA-256
`36A1893143FB4DC46C25073FDC431F1CF6409948CD9DD698F666FEAEAA8DB357`。安装版
`app.asar` SHA-256 为 `4BA2C12C6C2EDB83A5CF3B3F4F11A8546C738233333B38DEF9441CB544CC9B3E`，
与 release 候选一致。记录见 `archive/20260825-build-toggle-msi-uac-install.md`。

移动端浮动选择器的实测几何再次校正：本地/远程对话胶囊的测量矩形统一转换到玻璃宿主
坐标系，修复远程列表 8dp 内边距造成的左偏；右栏子分页直接记录每个 32×28dp 色块的实际
边界，玻璃落地终点不再依赖槽宽硬编码。Memory Lab 总览/详细切换删除整体 scale 落地，
改为只收回玻璃外壳的固定 6dp 外扩，采样内容始终保持 1:1。记录见
`archive/20260825-mobile-selector-coordinate-and-shell-landing.md`。

包含上述修复的 Android Release APK 已完成 R8、Vital lint、资源优化与签名构建：
`android/app/build/outputs/apk/release/app-release.apk`，大小 45,954,544 bytes，SHA-256
`7761F5F841D75C3A32013FE248F26BFBA49C2541ECF87DE4BC8A57211D5022F5`。

移动端预测性返回随后修正顶层页面的 commit 交接：竖/横屏命令行及竖屏 Memory Lab 总览在
松手后保留当前手势变换，由外层退出动画直接接管，不再闪回原位；Memory Lab 详细页返回
总览仍在同一 surface 内从松手进度平滑复原。左侧栏本地/远程对话玻璃的移动态增加随材质
浮起进度生效的 2dp 右向视觉中心校正，色块态进度为零，因此不改变准确的浮起起点和落地
终点。记录见 `archive/20260825-mobile-predictive-back-and-conversation-travel-alignment.md`。

包含该修复的最新 Android Release APK 已完成 R8、Vital lint、资源优化与签名构建：
`android/app/build/outputs/apk/release/app-release.apk`，大小 45,954,544 bytes，SHA-256
`F4A379867B05B667D4106F4F5986D46751A6D7639E73F71A970CFEB208F3E3E4`。

移动端右边栏随后与 PC `#right` 的 carrier 语义同步：聊天底层继续按展开进度做 backdrop blur，
右栏自身不再作为全高折射透镜采样聊天画面，消除拖到一半时左边缘出现的宽条镜像。亮色
右栏改用 98% 的明亮 `bgTertiary` 本底，不再被 0.74 透明度稀释；外形为仅左上/左下 18dp
圆角、右侧贴屏直角，并只绘制左侧分隔线。记录见
`archive/20260825-mobile-right-sidebar-pc-carrier-parity.md`。

包含该右栏修复的 Android Release APK 已重新构建：
`android/app/build/outputs/apk/release/app-release.apk`，大小 45,954,544 bytes，SHA-256
`E1051DE9D6C02DB624626891874206D9A1E386F84EA9C7F2B4F7728738D224D5`。

按后续实测要求，移动端右栏已取消左侧圆角，恢复四角直角贴边；明亮本底、仅左侧分隔线和
禁止全高折射倒影的修复保持不变。最新 APK SHA-256 为
`A00D40A01E8EFB9DD218B4466A75744552756EA4C22DDC4FF63FD6908FE58795`。

移动端“移动端权限”页新增“后台联网”系统状态开关。开关读取
`ConnectivityManager.restrictBackgroundStatus`，点击时打开本应用专属的后台数据/不受限流量
设置页，系统不提供该入口时回退应用详情页；从系统页返回后重新读取真实状态。应用不会伪造
或静默修改该系统特殊权限。记录见 `archive/20260825-mobile-background-network-setting.md`。

包含后台联网入口的 Android Release APK 已完成 R8、Vital lint、资源优化与签名构建，大小
45,970,928 bytes，SHA-256 `79A5577EEF1B0A92F2489B0BDCAA2933422DFA6474EBED03900CDED91ECDEB1D`。

后台联网入口的开关语义随后调整为单向请求：开启时才调起系统后台联网页面；关闭仅关闭
Newmark 权限页中的开关，不撤销也不修改任何系统联网策略。系统真实限制状态继续由下方说明
独立展示。最新 APK SHA-256 为 `A9DDA1C834B5A46393AF8AD580AD444D3BAC061C30CAE6F0CBDD502E0DC6BB1F`。

PC 与移动端所有选择型玻璃浮块现统一采用并行状态机：玻璃从当前色块起点浮起的同时立即向
目标运动，抵达目标色块后马上收缩落地，不再串行等待完整浮起，也不再为原地点击补齐虚假的
220/360ms 行程。长按与对话排序拖动在按住期间维持完整浮起，松手归轨到最终色块后才落地；
页面切换、弹窗命令和对话切换仍等落地完成后提交。覆盖菜单、左右栏、设置/插件/MemoryLab
分页、工作区/模式选择、移动端侧栏三按钮、输入复合菜单及 PC/移动端对话点击与拖动。记录见
`archive/20260826-liquid-motion-concurrent-flight.md`。

包含上述并行运动状态机的 Android Release APK 已完成 Vital lint、R8、资源优化与签名构建：
`android/app/build/outputs/apk/release/app-release.apk`，大小 45,970,928 bytes，SHA-256
`298E11F7A27000A7770956AB99AAEF1C3046E2BC5E3F1BA0DEDD44A0CABB8532`。当前工作区最新 Electron
dev 也已使用独立临时用户数据目录启动，避免与已安装版配置和单实例锁冲突。记录见
`archive/20260826-liquid-motion-apk-electron-dev.md`。

包含全平台玻璃并行运动改造的 Windows MSI 已重新构建并完成本机 UAC 升级安装：
`release/Newmark-Agent-0.5.7-x64.msi`，大小 226,383,951 bytes，SHA-256
`3D6683B81E4FF3C90E51E26D2995808C3FBAFDA3A4D6E6EB06F122F145C2CF4A`。MSI 管理映像的
22 项结构断言与 12 项安全断言全部通过；安装返回 3010（成功、建议重启），安装目录
`C:\Program Files\Newmark Agent` 的 `app.asar` 与 release 候选 SHA-256 同为
`E6F3F777E803DF9804054E7D86712B9B8605A768C78E7B74EDD744AAAEF0C233`，安装版 GUI 已成功启动。
记录见 `archive/20260826-liquid-motion-msi-uac-install.md`。

dev-0.5.8 补齐移动端对话操作反馈：更多按钮与长按打开的菜单分别从真实触发锚点弹出，并在
关闭时反向收回；归档操作会在菜单退出后让对话胶囊淡出并轻微收缩，动画结束才从本地或远端
列表提交删除，避免菜单和对话突然消失。对应 Release APK 大小 45,970,952 bytes，SHA-256
`2FDF58EB6366FD49007DEABCDBB3269F8319415EC7B0FED3EAA8DD281E292A0C`。

移动端 `alarm_manage` 已接入 Android 默认时钟应用：创建闹钟会打开系统时钟确认界面，查看
闹钟会进入默认时钟的闹钟列表。Newmark 不再用自身通知模拟系统闹钟，也不再声明 Android
公共协议无法保证的跨时钟应用 ID 查询与删除能力。
包含该修复的 Release APK 大小 45,970,920 bytes，SHA-256
`FBD59BD5A93F3B9DE11097C36B75A0D406F5A79E16096E57088ADB73EBBC88CA`。

本地 Agent 的恢复层还对齐 PC 的瞬态传输错误边界：思考已开始但正文尚未到达时，EOF、连接重置、
流关闭、超时和 broken pipe 会继续进入连续恢复，不会因一次短暂连接抖动直接终止 Build。

该状态已完成 Android 本机压力门禁：151 项 JVM 测试全部通过，独立 stress variant 构建成功，
正式 Release 的 Vital lint、R8、资源优化和签名打包通过。当前未连接 ADB 设备，因此实机
SSE/UI 循环未执行，也未计为通过。

移动端本地 Agent 已取消写死的 6 轮工具调用限制：连续工具工作会运行到模型完成、用户停止或
真实错误。上下文结构同步 PC 的请求级最新用户焦点、Guide 顺序、历史证据边界与压缩续接；
每个工具子轮都重新检查 70% 自动压缩和 90% 安全压缩，避免长工具链因上下文只在首轮检查而
溢出。请求级 bootstrap 不写入对话历史。
该 bootstrap 同时移除了消息数量、工具数量、模式、ID 等动态字段，使连续工具子轮的 system
前缀保持字节稳定；新工具结果只追加在上下文尾部，从而提高支持 prompt caching 的 provider
缓存命中率，只有真正发生上下文压缩时才改变 durable 前缀。
该状态 Release APK 已通过 154 项单测、Vital lint、R8、资源优化与签名构建，SHA-256
`768AA0C216FB004FE17CD2C32BDB035C12D6443FE29BEBB5E3B6DB165B046887`。

移动端文件发现现合并 MediaStore 与用户已授权的系统 DocumentProvider，能识别云端仅在线、
系统优化释放及重复文件占位记录，保留稳定 document ID/canonical identity，并在读取 content URI
时由原 provider 恢复真实内容。文件读取新增 PDF、Word、PowerPoint、CSV/TSV 与 Excel；PDF
按文字层、页面视觉模型、设备 miniOCR、LLM 完整视觉综合顺序降级，并返回实际命中的解析阶段。
该状态 Release APK 已通过 156 项测试、Vital lint、R8、资源优化与签名，大小 52,684,932
bytes，SHA-256 `C845EC677B3A878D512D740E7A93213490E8137757241040D65FA0ECD04EB3C8`。

dev-0.5.8 统一升级了移动端既有玻璃浮块的飞行状态机。对话胶囊、侧栏工具选择器、右栏分页、
记忆实验室分页和输入复合菜单均可在浮起过程中向目标运动，并在尚未完全抵达时开始收缩落地；
首帧仍严格从起点色块浮起，结束时严格收缩为目标色块。长按和拖动期间保持完全浮起，只有松手
才进入落地；重定向复用当前浮块，不生成第二个浮层。普通表面未被转换为玻璃。

移动端现从应用主题根部关闭 Compose/Material3 的所有点击 indication，不再显示 Android 默认的
灰色涟漪。点击、长按、拖动、无障碍语义以及 Newmark 自有的玻璃/状态动画保持原有行为。

移动端 Memory Lab 已补齐 PC 同构工具链：读取、查询、新增/更新、重构、删除与重建索引均支持
完整 metadata、tagPaths、版本号、expectedUpdatedAt 并发保护、旧版本归档、policy.jsonl 审计和
rebuild receipt。总览继续采用 PC 标签/组件关系云，并保留移动端单指拖动、双指缩放与 48dp 命中优化；
详情页新增组件元数据、标签路径、别名、核心 Markdown 及新增/编辑/删除入口。
# dev-0.5.8 terminal responsiveness

PC 内置终端现对高频 PTY 输出实施主进程背压合并与渲染端逐帧追加，避免 Windows 将 Electron 判定为未响应；终端历史仍保持 256 KiB 有界缓存，普通终端和 Agent takeover 路径一致。
# Mobile local Agent response stability (2026-08-26)

移动端本地 Agent 的所有 provider 调用统一经过空响应恢复层：只有 provider 明确返回失效空响应才进入重试；持续等待、静默连接、EOF、超时或流关闭本身不视为空响应。明确失效后的等待序列为 200ms、800ms、2s、10s、60s，对应 5 次重试，第 5 次仍失效才终止；任意思考、正文、工具调用或其他有效流式活动都作为正常结果并立即清零计数。

本轮稳定性修复同时兼容 chat SSE 的完整 `choices[0].message` 帧与增量 `delta` 帧，避免健康连接被解析层误判为空响应；显式失效重试间隔固定为 200ms、800ms、2s、10s、60s。

## dev-0.5.8 模型菜单玻璃拖动调度

移动端模型选择二级菜单现将拖动位移与速度直接留在 Compose `graphicsLayer`/RenderNode 更新路径，
动画 Job、当前目标行和菜单几何不再作为高频可观察状态反复触发整表重组；同一目标行内的指针事件
不会重复取消和重建 spring。玻璃材质、形变公式、240ms 飞行、长按浮起和落地状态机保持不变。
本地 Agent 的流式增量仍完整按序接收，但主线程公开快照改为 16ms 窗口批量提交，避免高速 token
流与 UI 帧回调争抢主线程。171 项 JVM 测试、Vital lint、R8 与 Release 构建通过；当前无 ADB
设备，未把模拟器/实机帧率计为已验证。

## dev-0.5.8 移动端连续思考节点

移动端本地 Agent 现在将同一连续思考阶段内的多个 provider 子轮接续到一个 Build 思考节点。仅思考
响应会继续当前节点，不再反复生成“进行了思考”；开始工具调用、生成正文、收到 Guide、发生错误或
Build 结束时才关闭该节点。流式 reasoning delta 与最终 reasoningContent 会按子轮对账，既不丢失也
不重复。1000 个连续 thought-only 子轮压力回归保持 1 个 thought shell，完整 174 项 JVM 测试、
Vital Lint、R8 与 Release APK 构建通过；真实移动端 UI 长压仍需连接设备后补测。

## dev-0.5.8 移动端思考响应续接稳定性

移动端本地 Agent 不再把 reasoning-only 子轮结束后的下一次请求原样重放。当前 Build 会维护一份
最多 12,000 字符的临时思考进度检查点，并仅在下一次 Chat Completions 请求尾部以 assistant
`reasoning_content` 原生字段携带；普通 `content` 保持为空，不再伪造成内部提示词。它不写入聊天正文、
`messages`、`modelContext`、压缩摘要或磁盘历史。任一 Guide、工具调用、
正文、错误或终态都会清空检查点，因此最新真实用户指令仍保持权威。

流式 reasoning 已经显示后，较短或不兼容的最终 reasoning 字段不再覆盖它；内容在同一思考节点内
只会保持或增长，不会出现长思考突然截断后从头重来的可见回退。1000 个连续子轮回归同时约束单节点、
请求变化、检查点有界和非持久化。完整 178 项 JVM 测试、Vital Lint、R8 与 Release 构建通过。

后续协议校正进一步保留 provider 的 `finish_reason`：只有模型明确返回 `length`、`max_tokens` 或
`max_output_tokens` 才允许携带上述检查点进入下一子轮。普通 `stop`、工具状态、异常 EOF 或连接关闭
都不会由客户端解释为“继续思考”，软件端也没有思考空闲计时器。当前供应商的当前模型配置直接提供
`thinking_tier_map`，避免不同供应商的同名模型串用原生档位。183 项 JVM 测试、Vital Lint、R8 与
Release APK 构建通过；分发 APK SHA-256 为
`ED15D28A643B9C200E239C4D5D6B07C159C54BCBEE7D218C480BAB1DFBA9381E`。

## dev-0.5.8 PC/移动端工具上下文接续修复

长对话中“明知参数错误却重复执行同一调用”并非最新记忆无法写入，而是部分 OpenAI 兼容网关把
`function.arguments` 作为累计快照重复发送，客户端却按普通增量无条件拼接。合法参数因此变成两个
相邻 JSON 对象，工具只看到旧值或空对象，模型收到误导性的参数缺失结果后继续重复调用。

PC 与 Android 现统一兼容标准增量、累计快照和完整重复快照；Chat Completions、Responses 及
GitHub Models 兼容流均按 tool index 隔离并行调用。Android 工具执行器执行前使用严格单对象解析，
不会再接受带尾随对象的参数。每轮 assistant tool call 与同 call id 的工具结果仍只追加到上下文尾部，
稳定 system/bootstrap、工具 schema 和既有消息前缀保持不变，prompt cache 命中结构未被破坏。

回归覆盖累计/重复/标准增量、交错并行调用、无 `output_item.done` 的 Responses 兼容流、严格参数拒绝、
下一轮工具结果接续及 45 个 PC 工具子轮缓存压力。Android 187 项 JVM 测试、Vital Lint、R8 与
Release 构建通过。APK：`APK/Newmark-Agent-0.5.8-context-continuity.apk`，SHA-256
`F514C919411DD2D84214B54024D7CF6D9EB25692E35F7D5465FF8FC08188325F`。
