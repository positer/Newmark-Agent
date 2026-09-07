# Newmark Agent dev-0.5.15

## English

### Changes

- **SubAgent continuity and Ultra coordination.** Peers retain their identities, completed tool results, committed input, and work history across mailbox continuations and cold recovery. Scheduling preserves one executor per peer, with 4 ordinary or 16 Ultra execution slots. Ultra coordinators assign independent responsibilities and acceptance checks while retaining useful local verification work.
- **Explicit communication and wakeup.** New messages default to `wakeup=false`: stopped receivers store mail without starting a model request; active receivers process accepted mail normally. `wakeup=true` requests continuation within the existing stop and close boundaries. Senders can select a supplied summary, text history, or complete tool call/result pairs with ranges; the default is the last visible text entry. Reading a complete peer result retires only its matching automatic notification after persistence, avoiding redundant confirmation turns while retaining manual and newer messages.
- **Stable requests and measured caching.** Build and peer continuations preserve eligible system/message prefixes and existing tool order. Peer request metadata survives cold recovery, with configuration and permission checks on reuse. Provider instances are reused within their owning scope. Context inspection distinguishes server-reported input/output/cache usage from local estimates, preserves missing reporting, and saves conversation totals without double counting late or cumulative updates.
- **Response recovery and cancellation.** Empty, reasoning-only, and transiently failed Build requests follow bounded recovery without replaying completed tools or already emitted text. Interrupted visible text remains available after reopening the conversation. Streaming handles split UTF-8/SSE frames and explicit completion/error states; incomplete tool arguments cannot execute. Desktop model transport removes the hidden 300-second header/body ceiling, while Android cancellation covers both connection and body reading. First-title generation remains a persisted gate before the first formal response and follows the current run's stop signal.
- **Shared PC/mobile conversation commands.** Messages, attachments, Next, Guide, modes, Flow, and queue edits use the same retained conversation owner. Queue operations preserve item identity and target ownership; unsuccessful mobile edits retain their draft. History pagination, context refreshes, and delayed snapshots are guarded against stale responses after switching conversations. Android local snapshots use atomic replacement and report storage failures; the last active local conversation is retained.
- **Desktop and Android interaction refinements.** Desktop menus use uniform translucent material, 25px list corners, an 80ms hold threshold, and directional outward feedback capped at 4 CSS px. Unchanged conversation rows and message surfaces avoid redundant DOM updates. Both clients use a neutral gray-black dark palette. Android glass follows the actual touch position, keeps complete lift/travel/landing motion, and preserves conversation reorder positions; wide-screen right-sidebar backgrounds and tab icons remain consistent with the selected theme. Android browser startup uses the asynchronous WebView startup path.
- **Conversation-scoped stop and safer Windows updates.** Stop sends a control instruction to all non-closed peers in the selected conversation; force stop also terminates its owned tool descendants. WSL uses verified birth identity and retained Linux pidfds, including descendants with separate process groups, and retains an error/quarantine when cleanup cannot be confirmed. Windows GUI/CLI/manual MSI updates share the monitored native installation path, with scoped process shutdown and pending-operation cleanup before replacement.

### Focused acceptance evidence

- Real APInebula / `gpt-5.6-sol` acceptance completed 16 initial peers, 16 silent mailbox deliveries, 16 explicit continuations, and 4 cold-restored peers: **52 requests, 118/118 checks, peak concurrency 16**. Silent delivery made **zero** model calls and left receiver history/request-cache hashes unchanged. All 36 same-peer continuation comparisons preserved system, tools, and raw/semantic message prefixes.
- A separate real Ultra root created four peers with distinct file responsibilities, independently checked its manifest, read all four results, and returned the correct verified sum: **23 HTTP requests, 9/9 checks, zero redundant automatic follow-up requests**. The request count includes one separate title request. These tests verify model-directed delegation separately from harness-directed concurrency.
- Reported streaming cache reads were **18.17%** and **41.59%** of measured input in those two workloads. They are observations for that provider/model and workload, not guaranteed cache hit rates. The title request is outside the second streaming usage denominator. Neither run retried completed work to obtain cache hits.

### Assets and limitations

| Platform | Release asset |
| --- | --- |
| Windows x64 installer | `Newmark-Agent-0.5.15-x64.msi` |
| Windows x64 portable | `Newmark-Agent-0.5.15-win-unpacked-x64.zip` |
| Linux x86-64 AppImage | `Newmark-Agent-0.5.15-x86_64.AppImage` |
| Debian/Ubuntu amd64 | `Newmark-Agent-0.5.15-amd64.deb` |
| Linux x64 portable | `Newmark-Agent-0.5.15-linux-unpacked-x64.zip` |
| Android | `Newmark-Agent-0.5.15-android.apk` |

- Windows executables are not Authenticode-signed. Android uses the project's existing Android Debug certificate for development/sideloading; it is not a Google Play production-signed APK. Android version is `0.5.15` / `515`, with minimum SDK 24.
- No macOS artifact is included; macOS packaging requires a native macOS host. WSL stop requires Python 3 with Linux pidfd support. Unsupported capability or unconfirmed ownership is reported as a failure, without falling back to unverified numeric process signals.
- The focused results above are pre-packaging functional evidence. Prior same-version APK/MSI installations and screenshots retain their own artifact identities and do not certify these new release assets. Earlier candidate desktop unresponsiveness remains unclassified without its missing contemporaneous process dump; the completed checks do not establish universal long-run stability. Physical Android devices, OEM background behavior, and mobile-network switching remain outside that evidence.

## 简体中文

### 本版本变化

- **SubAgent 连续工作与 Ultra 分工。** 子代理在 mailbox 续作和冷恢复后保留身份、已完成工具结果、已提交输入及工作历史。同一子代理只运行一个执行器，普通档位与 Ultra 分别提供 4／16 个执行槽。Ultra 主代理按独立责任和验收要求分工，同时保留有用的本地校核工作。
- **明确的通信内容与唤醒语义。** 新消息默认 `wakeup=false`：已停止的接收者只保存邮件，不启动模型请求；运行中的接收者照常处理已接受邮件。`wakeup=true` 在既有停止和关闭边界内请求继续工作。发送方可选择自行提供的摘要、文本历史或完整工具调用／结果对及范围，默认发送最后一条可见文本。完整读取子代理结果并持久化后，仅撤回同一结果版本的自动通知，避免重复确认轮次，保留手工邮件与更新的结果。
- **稳定请求与真实缓存计量。** Build 和子代理续作保留可复用的系统／消息前缀及既有工具顺序。子代理请求元数据随冷恢复保存，复用时继续检查配置与权限；供应商实例在各自所属范围内复用。上下文窗口区分服务端上报的输入／输出／缓存用量与本地估算，保留未上报状态，并保存会话累计用量，避免晚回包和累计更新被重复计数。
- **响应恢复与取消。** Build 对空响应、仅思考响应及短暂故障执行有界恢复，不重放已经完成的工具或已经输出的正文。中断前可见的正文在重新打开会话后仍可查看。流式处理覆盖跨包 UTF-8／SSE 和明确完成／失败状态，不完整的工具参数不会执行。Desktop 模型传输解除隐藏的 300 秒响应头／正文上限；Android 取消覆盖连接与正文读取。首次标题仍须持久化后才开始正式响应，并服从当前运行的停止信号。
- **PC／手机共享会话命令。** 消息、附件、Next、Guide、模式、Flow 和队列编辑通过同一个持续保留的会话运行实例执行。队列操作保留条目身份和目标归属，移动端编辑失败保留草稿。历史分页、上下文刷新及延迟快照在切换会话后拒绝旧回包。Android 本地快照改用原子替换并报告存储失败，同时记住最后打开的本地会话。
- **桌面与 Android 交互修复。** PC 菜单使用均匀半透明材质、25px 列表圆角、80ms 长按阈值及最大 4 CSS px 的有向外拉反馈。未变化的会话行和消息表面避免无谓 DOM 更新。双端暗色主题采用中性灰黑层次。Android 玻璃跟随实际触点，完整衔接浮起、移动和落地，并保留对话重排位置；宽屏右侧栏底色和分页图标与应用主题保持一致。Android 浏览器采用异步 WebView 启动路径。
- **按会话停止与更可靠的 Windows 更新。** 停止向当前对话的全部未关闭子代理发送控制指令；强制停止同时终止其所属工具子孙进程。WSL 通过启动身份和持有的 Linux pidfd 验证归属，覆盖另建进程组的子孙进程，无法确认清理完成时保留错误及隔离状态。Windows GUI／CLI／手动 MSI 更新共用受监控的原生安装流程，在替换前按安装范围停止进程并清理待处理操作。

### 专项验收证据

- 真实 APInebula／`gpt-5.6-sol` 完成 16 个初始子代理、16 次静默邮件、16 次显式续作及 4 个冷恢复子代理：**52 次请求、118／118 项通过，峰值并发 16**。静默投递产生 **0** 次模型调用，接收者历史与请求缓存哈希保持不变。36 组同一子代理续作比较的 system、tools 及原始／语义消息前缀全部稳定。
- 独立真实 Ultra 主代理自行创建 4 个负责不同文件的子代理，同时校核自己的清单，读取全部结果并给出正确且通过校核的总和：**23 次 HTTP 请求、9／9 项通过，冗余自动续作请求为 0**。请求总数包含一次独立标题请求。模型自主分工与测试驱动的执行并发分别验收。
- 两组工作负载的流式缓存读取分别占实测输入的 **18.17%** 和 **41.59%**。这些是该供应商／模型及工作负载的实测结果，不是缓存命中率保证；第二组流式统计分母不包含标题请求。两组均未为了缓存命中重试已完成工作。

### 发行资产与边界

| 平台 | 发行资产 |
| --- | --- |
| Windows x64 安装包 | `Newmark-Agent-0.5.15-x64.msi` |
| Windows x64 免安装包 | `Newmark-Agent-0.5.15-win-unpacked-x64.zip` |
| Linux x86-64 AppImage | `Newmark-Agent-0.5.15-x86_64.AppImage` |
| Debian／Ubuntu amd64 | `Newmark-Agent-0.5.15-amd64.deb` |
| Linux x64 免安装包 | `Newmark-Agent-0.5.15-linux-unpacked-x64.zip` |
| Android | `Newmark-Agent-0.5.15-android.apk` |

- Windows 可执行文件未做 Authenticode 签名。Android 沿用项目现有 Android Debug 证书，用于开发预览／侧载，不是 Google Play 生产签名 APK；版本为 `0.5.15`／`515`，最低 SDK 24。
- 本次不含 macOS 制品，macOS 打包须使用原生 macOS 主机。WSL 停止需要支持 Linux pidfd 的 Python 3；缺少能力或无法确认归属时明确失败，不回退到未经验证的数字进程信号。
- 上述专项结果属于打包前功能证据。此前同版本 APK／MSI 的安装和截图保留各自制品身份，不能代替本次新发行资产的验收。早期候选桌面无响应因缺少当时的进程转储仍未归因，已通过检查不代表所有长期使用场景绝不会卡住；实体 Android 手机、OEM 后台行为和移动网络切换也不在上述证据范围内。
