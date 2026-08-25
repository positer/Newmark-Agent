# Newmark Agent

Newmark Agent 是面向本地工作区的多端 AI Agent。它把对话、Build/Plan/Goal/Flow、文件与终端、浏览器、Memory Lab、自动化和多 Agent 协作整合在同一套本地状态模型中，并提供 Windows/Linux 桌面端、终端界面、CLI 与 Android 客户端。

当前开发版本：`dev-0.5.7`。桌面端与 Android 从根目录 `VERSION` 读取并校验同一个版本，默认 Release 同时发布 Windows、Linux 和 Android。本版本修复移动端非当前远程对话长按稳定性，完成跨端玻璃落下动画并缩短浮起/移动时长；PC 浮动玻璃固定使用 6px 包边，Android 浮动玻璃固定使用 6dp 外扩。浮块移动时会依据实时速度和方向沿运动轴拉伸、沿垂直轴收缩，玻璃折射与外形同步变形；增强后的响应更早达到可见幅度。PC 会在玻璃控件悬停/聚焦时低频预热色散纹理，点击首帧复用，再以 CSS 像素 JPEG/ImageBitmap 原位刷新；浮块中心保持实时透明且不采样截图，只有固定 6px 边缘执行 RGB 折射。Windows/Electron 下 WebGL 仅负责离屏着色，小尺寸透明 2D surface 负责最终合成，避开复用画布变黑且不使用生产 CPU 回读。PC 点击不再等待截图或落下动画，关闭模型回退后也不会切换到其他模型身份。

当前 Android `dev-0.5.7` 已统一移动端液态选择器：点击播放完整的源选项浮起、移动、落下动画，连续点击会让唯一浮块从当前帧改道到最后目标再落下；拖动必须先静止按住 300ms，之前超过触摸阈值的移动不消费并交还列表/侧栏滚动。会话、左右侧栏工具/分页和 Memory Lab 分页共用这一规则；本地/远程对话的点按飞行与长按排序共用唯一玻璃浮层，胶囊四边固定外扩 6dp，飞行、跟手与落下全程按实时速度产生沿运动方向拉伸、垂直方向收缩的液态形变，折射随外形同步。拖动期间列表实时空出落点，未位移松手才打开操作菜单。PC 与移动端二态开关统一为“点击直接反转、确认水平拖动后才按松手位置吸附”，纵向滚动不触发开关。Release APK 仍以 `android/app/build/outputs/apk/release/app-release.apk` 为本地验证产物。

## 主要能力

- Electron GUI、`Newmark --TUI` 与 `Newmark --cli` 共用工作区、对话和运行时契约。
- Build、Plan、Goal 与 Flow 支持长任务、队列、暂停/恢复、上下文压缩和可追溯 WorkRun。
- 文件、终端、编辑器、浏览器、Computer Use、Git/GitHub、SSH、MCP、技能、自动化与 Memory Lab 均受策略边界约束。
- 模型按供应商部署隔离；同名模型不会共享凭据、验证状态或路由证据。
- Android 支持本地对话、Agent 可调用的工作区终端、本地工具、Memory Lab、系统日程读取/创建与系统分享接收，也支持配对桌面端后的远端对话、文件上传和工作区操作。
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
