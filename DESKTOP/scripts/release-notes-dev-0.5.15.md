# Newmark Agent dev-0.5.15

## English

### Changes

- **SubAgent continuity and Ultra coordination.** Peers retain their identities, completed tool results, committed input, and work history across mailbox continuations and cold recovery. Scheduling preserves one executor per peer, with 4 ordinary or 16 Ultra execution slots. Ultra coordinators assign independent responsibilities and acceptance checks while retaining useful local verification work.
- **Explicit communication and wakeup.** New messages default to `wakeup=false`: stopped receivers store mail without starting a model request; active receivers process accepted mail normally. `wakeup=true` requests continuation within the existing stop and close boundaries. Senders can select a supplied summary, text history, or complete tool call/result pairs with ranges; the default is the sender's last visible text entry. Reading a complete peer result retires only its matching automatic notification after persistence, avoiding redundant confirmation turns while retaining manual and newer messages.
- **Stable requests and measured caching.** Build and peer continuations preserve eligible system/message prefixes and existing tool order. Peer request metadata survives cold recovery, with configuration and permission checks on reuse. Provider instances are reused within their owning scope. Context inspection distinguishes server-reported input/output/cache usage from local estimates, preserves missing reporting, and saves conversation totals without double counting late or cumulative updates.
- **Response recovery and cancellation.** Empty, reasoning-only, and transiently failed Build requests follow bounded recovery without replaying completed tools or already emitted text. Interrupted visible text remains available after reopening the conversation. Streaming handles split UTF-8/SSE frames and explicit completion/error states; incomplete tool arguments cannot execute. Desktop model transport removes the hidden 300-second header/body ceiling, while Android cancellation covers both connection and body reading. First-title generation remains a persisted gate before the first formal response and follows the current run's stop signal.
- **Shared PC/mobile conversation commands.** Messages, attachments, Next, Guide, modes, Flow, and queue edits use the same retained conversation owner. Queue operations preserve item identity and target ownership; unsuccessful mobile edits retain their draft. History pagination, context refreshes, and delayed snapshots are guarded against stale responses after switching conversations. Android local snapshots use atomic replacement and report storage failures; the last active local conversation is retained.
- **Desktop and Android interaction refinements.** Desktop menus use uniform translucent material, 25px list corners, an 80ms hold threshold, and directional outward feedback capped at 4 CSS px. Unchanged conversation rows and message surfaces avoid redundant DOM updates. Both clients use a neutral gray-black dark palette. Android glass follows the actual touch position, keeps complete lift/travel/landing motion, and preserves conversation reorder positions; wide-screen right-sidebar backgrounds and tab icons remain consistent with the selected theme. Android browser startup uses the asynchronous WebView startup path.
- **Conversation-scoped stop and safer Windows updates.** Stop sends a control instruction to all non-closed peers in the selected conversation; force stop also terminates its owned tool descendants. WSL uses verified birth identity and retained Linux pidfds, including descendants with separate process groups, and retains an error/quarantine when cleanup cannot be confirmed. Windows GUI/CLI/manual MSI updates share the monitored native installation path, with scoped process shutdown and pending-operation cleanup before replacement.

### Focused acceptance evidence

- Real APInebula / `gpt-5.6-sol` acceptance completed 16 initial peers, 16 silent mailbox deliveries, 16 explicit continuations, and 4 cold-restored peers: **52 requests, 118/118 checks, peak concurrency 16**. Silent delivery made **zero** model calls and left receiver history/request-cache hashes unchanged. All 36 same-peer continuation comparisons preserved system, tools, and raw/semantic message prefixes.
- A separate real Ultra root created four peers with distinct file responsibilities, independently checked its manifest, read all four results, and returned the correct verified sum: **23 HTTP requests, 9/9 checks, zero redundant automatic follow-up requests**. The request count includes one separate title request. These tests verify model-directed delegation separately from harness-directed concurrency.
- Reported streaming cache reads were **18.17%** and **41.59%** of measured input in those two workloads. They are observations for that provider/model and workload, not guaranteed cache hit rates. The title request is outside the second streaming usage denominator. Neither run retried completed work to obtain cache hits.

### Release validation

- Windows MSI administrative extraction and the complete portable ZIP smoke both passed actual CLI/UI and packaged feature checks. Coverage includes parallel peers, explicit wakeup and default-silent delivery, Guide failure recovery, target-scoped two-stage stop, browser/editor/PDF rendering and package security checks. All 745 packaged dist files match the frozen local build. MSI extraction is not an installed-product update test.
- The fresh `npm run test:full-release` command exited successfully. Its main verification phase reported **1707 passed, 0 failed**; subsequent phases include real SSH/WSL TUI checks and 18 concurrent isolated conversations across the GUI/TUI/CLI backend. Two conditionally unentered WSL-host checks passed **2/2** in a separate exact-build run, including actual host startup, isolated conversation snapshots and normal shutdown; they are not added to the main phase's count.
- All three native Ubuntu CI Linux assets passed packaged version and GUI checks under WSL/Xvfb with isolated runtime roots. Android passed **365 JVM tests**, release lint, signature and archive checks, and retained the previous local APK's signing certificate. This run did not install the APK on a device.
- The unpacked local npm candidate passed **8/8** CLI/TUI checks, including real ConPTY sessions. Dependencies came from the existing local installation; this is not a clean dependency installation or a registry publication receipt. The six GitHub assets were built from `6210c9c118791aea4a9336f942ec667f2c5a845f`; subsequent release smoke-test and notes corrections do not change their production inputs.

### Assets and limitations

| Platform | Release asset | SHA-256 |
| --- | --- | --- |
| Windows x64 installer | `Newmark-Agent-0.5.15-x64.msi` | `510786a8adde5d7621178e1f1e49a8d287a71ea22aede72fc3bccbfb09b9a570` |
| Windows x64 portable | `Newmark-Agent-0.5.15-win-unpacked-x64.zip` | `3b1a80fd64e98cef12cecfd81cf58fd97a241448e6c3e8de0463136bcd6f20ff` |
| Linux x86-64 AppImage | `Newmark-Agent-0.5.15-x86_64.AppImage` | `c23a3213fe133284be3de47c8ed5820326fbb005304dad85fddb4a813e427f4b` |
| Debian/Ubuntu amd64 | `Newmark-Agent-0.5.15-amd64.deb` | `84227d0f3f46aba36a3bb1e7cf41a770437380782123a5d59046f826d070ae05` |
| Linux x64 portable | `Newmark-Agent-0.5.15-linux-unpacked-x64.zip` | `cfeaaba9ec193f9577c9b8df444d9b8d4f60b47ca3d18e2e40d3fdc05561f43a` |
| Android | `Newmark-Agent-0.5.15-android.apk` | `50c91898a7364062c1e80bb8b1ffb0e56387264abb955ac370ae0f1ce636acac` |

- Windows executables are not Authenticode-signed. Android uses the project's existing Android Debug certificate for development/sideloading; it is not a Google Play production-signed APK. Android version is `0.5.15` / `515`, with minimum SDK 24.
- No macOS artifact is included; macOS packaging requires a native macOS host. WSL stop requires Python 3 with Linux pidfd support. Unsupported capability or unconfirmed ownership is reported as a failure, without falling back to unverified numeric process signals.
- `--TUI` requires an interactive terminal. With default mobile hosting enabled, a piped/non-TTY launch can start the mobile listener before reporting the terminal requirement and remain running. The local npm checks explicitly disabled `remote.touch_enabled`; this does not fix the default-setting behavior. Use an interactive terminal for TUI sessions and disable mobile hosting for non-interactive validation.
- The real-provider results above are pre-packaging functional evidence. Prior same-version APK/MSI installations and screenshots retain their own artifact identities and do not certify these new release assets. Earlier candidate desktop unresponsiveness remains unclassified without its missing contemporaneous process dump; the completed checks do not establish universal long-run stability. Physical Android devices, OEM background behavior, and mobile-network switching remain outside that evidence.

## 简体中文

### 本版本变化

- **SubAgent 连续工作与 Ultra 分工。** 子代理在 mailbox 续作和冷恢复后保留身份、已完成工具结果、已提交输入及工作历史。同一子代理只运行一个执行器，普通档位与 Ultra 分别提供 4／16 个执行槽。Ultra 主代理按独立责任和验收要求分工，同时保留有用的本地校核工作。
- **明确的通信内容与唤醒语义。** 新消息默认 `wakeup=false`：已停止的接收者只保存邮件，不启动模型请求；运行中的接收者照常处理已接受邮件。`wakeup=true` 在既有停止和关闭边界内请求继续工作。发送方可选择自行提供的摘要、文本历史或完整工具调用／结果对及范围，默认发送发送方历史中的最后一条可见文本。完整读取子代理结果并持久化后，仅撤回同一结果版本的自动通知，避免重复确认轮次，保留手工邮件与更新的结果。
- **稳定请求与真实缓存计量。** Build 和子代理续作保留可复用的系统／消息前缀及既有工具顺序。子代理请求元数据随冷恢复保存，复用时继续检查配置与权限；供应商实例在各自所属范围内复用。上下文窗口区分服务端上报的输入／输出／缓存用量与本地估算，保留未上报状态，并保存会话累计用量，避免晚回包和累计更新被重复计数。
- **响应恢复与取消。** Build 对空响应、仅思考响应及短暂故障执行有界恢复，不重放已经完成的工具或已经输出的正文。中断前可见的正文在重新打开会话后仍可查看。流式处理覆盖跨包 UTF-8／SSE 和明确完成／失败状态，不完整的工具参数不会执行。Desktop 模型传输解除隐藏的 300 秒响应头／正文上限；Android 取消覆盖连接与正文读取。首次标题仍须持久化后才开始正式响应，并服从当前运行的停止信号。
- **PC／手机共享会话命令。** 消息、附件、Next、Guide、模式、Flow 和队列编辑通过同一个持续保留的会话运行实例执行。队列操作保留条目身份和目标归属，移动端编辑失败保留草稿。历史分页、上下文刷新及延迟快照在切换会话后拒绝旧回包。Android 本地快照改用原子替换并报告存储失败，同时记住最后打开的本地会话。
- **桌面与 Android 交互修复。** PC 菜单使用均匀半透明材质、25px 列表圆角、80ms 长按阈值及最大 4 CSS px 的有向外拉反馈。未变化的会话行和消息表面避免无谓 DOM 更新。双端暗色主题采用中性灰黑层次。Android 玻璃跟随实际触点，完整衔接浮起、移动和落地，并保留对话重排位置；宽屏右侧栏底色和分页图标与应用主题保持一致。Android 浏览器采用异步 WebView 启动路径。
- **按会话停止与更可靠的 Windows 更新。** 停止向当前对话的全部未关闭子代理发送控制指令；强制停止同时终止其所属工具子孙进程。WSL 通过启动身份和持有的 Linux pidfd 验证归属，覆盖另建进程组的子孙进程，无法确认清理完成时保留错误及隔离状态。Windows GUI／CLI／手动 MSI 更新共用受监控的原生安装流程，在替换前按安装范围停止进程并清理待处理操作。

### 专项验收证据

- 真实 APInebula／`gpt-5.6-sol` 完成 16 个初始子代理、16 次静默邮件、16 次显式续作及 4 个冷恢复子代理：**52 次请求、118／118 项通过，峰值并发 16**。静默投递产生 **0** 次模型调用，接收者历史与请求缓存哈希保持不变。36 组同一子代理续作比较的 system、tools 及原始／语义消息前缀全部稳定。
- 独立真实 Ultra 主代理自行创建 4 个负责不同文件的子代理，同时校核自己的清单，读取全部结果并给出正确且通过校核的总和：**23 次 HTTP 请求、9／9 项通过，冗余自动续作请求为 0**。请求总数包含一次独立标题请求。模型自主分工与测试驱动的执行并发分别验收。
- 两组工作负载的流式缓存读取分别占实测输入的 **18.17%** 和 **41.59%**。这些是该供应商／模型及工作负载的实测结果，不是缓存命中率保证；第二组流式统计分母不包含标题请求。两组均未为了缓存命中重试已完成工作。

### 本次发行验证

- Windows MSI 行政解包与完整便携 ZIP 验证均通过实际 CLI／UI 及包内功能检查，覆盖并行子代理、显式唤醒与默认静默投递、Guide 失败恢复、按目标隔离的双阶段停止、浏览器／编辑器／PDF 渲染及包内安全检查。745 个包内 dist 文件均与冻结的本地构建一致。MSI 解包不代表已安装产品更新验收。
- 本次重新执行 `npm run test:full-release` 成功退出。其中主验证阶段为 **1707 项通过、0 项失败**；后续阶段包含真实 SSH／WSL TUI，以及 GUI／TUI／CLI 共同后端中的 18 个并发隔离对话。主阶段未进入的两项条件 WSL 宿主检查以相同构建单独补测 **2／2 通过**，覆盖真实宿主启动、双会话快照隔离与正常停止，不并入主阶段计数。
- 原生 Ubuntu CI 构建的三种 Linux 制品均在 WSL／Xvfb 和隔离运行根目录中通过包内版本及 GUI 检查。Android 通过 **365 项 JVM 测试**、发行 lint、签名与归档检查，并保留此前本地 APK 的签名证书；本次未将 APK 安装到设备。
- 解包后的本地 npm 候选通过 **8／8 项** CLI／TUI 检查，包含真实 ConPTY 会话。依赖来自已有本地安装，不代表全新依赖安装或 npm 仓库发布验收。六个 GitHub 资产的实际构建提交为 `6210c9c118791aea4a9336f942ec667f2c5a845f`；后续发行测试和说明修订不改变其生产构建输入。

### 发行资产与边界

| 平台 | 发行资产 | SHA-256 |
| --- | --- | --- |
| Windows x64 安装包 | `Newmark-Agent-0.5.15-x64.msi` | `510786a8adde5d7621178e1f1e49a8d287a71ea22aede72fc3bccbfb09b9a570` |
| Windows x64 免安装包 | `Newmark-Agent-0.5.15-win-unpacked-x64.zip` | `3b1a80fd64e98cef12cecfd81cf58fd97a241448e6c3e8de0463136bcd6f20ff` |
| Linux x86-64 AppImage | `Newmark-Agent-0.5.15-x86_64.AppImage` | `c23a3213fe133284be3de47c8ed5820326fbb005304dad85fddb4a813e427f4b` |
| Debian／Ubuntu amd64 | `Newmark-Agent-0.5.15-amd64.deb` | `84227d0f3f46aba36a3bb1e7cf41a770437380782123a5d59046f826d070ae05` |
| Linux x64 免安装包 | `Newmark-Agent-0.5.15-linux-unpacked-x64.zip` | `cfeaaba9ec193f9577c9b8df444d9b8d4f60b47ca3d18e2e40d3fdc05561f43a` |
| Android | `Newmark-Agent-0.5.15-android.apk` | `50c91898a7364062c1e80bb8b1ffb0e56387264abb955ac370ae0f1ce636acac` |

- Windows 可执行文件未做 Authenticode 签名。Android 沿用项目现有 Android Debug 证书，用于开发预览／侧载，不是 Google Play 生产签名 APK；版本为 `0.5.15`／`515`，最低 SDK 24。
- 本次不含 macOS 制品，macOS 打包须使用原生 macOS 主机。WSL 停止需要支持 Linux pidfd 的 Python 3；缺少能力或无法确认归属时明确失败，不回退到未经验证的数字进程信号。
- `--TUI` 需要交互式终端。默认开启手机托管时，通过管道／非 TTY 启动可能先开启手机监听服务，再报告终端要求，并继续驻留。本地 npm 检查显式关闭了 `remote.touch_enabled`，不表示默认配置下的问题已修复。TUI 会话应使用交互式终端；非交互验证应关闭手机托管。
- 上述真实供应商结果属于打包前功能证据。此前同版本 APK／MSI 的安装和截图保留各自制品身份，不能代替本次新发行资产的验收。早期候选桌面无响应因缺少当时的进程转储仍未归因，已通过检查不代表所有长期使用场景绝不会卡住；实体 Android 手机、OEM 后台行为和移动网络切换也不在上述证据范围内。
