# Newmark Agent dev-0.6.2

## English

### Changes

- Mobile Agent now treats explicit output-budget exhaustion as resumable partial progress, with bounded continuation and increasing budgets. Incomplete tool calls are never executed; ordinary errors and cancellation do not trigger this path.

- Unified desktop/mobile light and dark theme icons, native system bars, capsule styling and glass transitions. Mobile local and remote conversation capsules now show the PC-style black/white running border; long-press menus provide haptic feedback. Goal/queue action buttons remain static.
- Added independent Markdown code-block copy controls and timeline-safe layout. Mobile LaTeX uses offline native rendering with multiline display math, inline formulas, cases and readable fallback.
- Fixed duplicate replies in two paths: remote IPC batch/history reconciliation by event identity, and local provider delta/final-snapshot parsing. Preserve whitespace and legitimate repeated tokens; avoid reading aggregate and structured response text twice.
- Reduced mobile image-navigation stalls by decoding bounded previews and serializing conversation storage off the main thread. Preserve cancellation, coalesced saves and durable title commit boundaries.
- Fixed image-first title startup with text-only metadata fallback. Both platforms now give title reasoning the selected tier's normal token budget. A live configured DeepSeek vision deployment reproduced truncation at 64 tokens and succeeded with the normal high-tier budget.
- Fixed built-in browser local HTML/file URL handling on desktop and Android. Browser-use keeps text/DOM first, with configured vision-model and OCR fallbacks, and supports explicit viewport dimensions.
- Added binary PDF text extraction and page rendering for scanned-document visual fallback on both platforms.
- Refreshed the default search MCP group: Exa keyless search first, You.com free-profile search second, optional older services and HTTP fallbacks retained. Desktop MCP uses the configured web proxy; Android can search directly without pairing.
- Bound Desktop and Android versions to 0.6.2 / Android version code 602.

### Validation and limits

- Desktop core verification: 1712 assertions passed. Android unit verification: 381 tests passed. Release builds and platform package checks are run for this tag.
- A real Android ChatViewModel device test passed reasoning-limit -> text-limit -> completed response, checking increasing budgets and one durable answer.
- Mobile running-border verification passed all four local/remote and light/dark combinations, with 16 captured frames. Earlier dev-0.6.2 visual, browser and image-navigation checks are retained in the local audit archive.
- These checks do not establish universal smoothness or physical-device/OEM background reliability. Previously measured whole-app frame-time limitations are not claimed resolved.
- Free search services have network/rate limits. The DeepSeek title check covered the configured DeepSeek deployment, not every gateway with the same model name. Existing duplicated saved messages are not heuristically rewritten.

### Downloads

Windows x64 MSI and portable ZIP; Linux x86-64 AppImage, amd64 deb and portable ZIP; Android APK. This is the project's established six-asset platform matrix; no macOS or native HarmonyOS package is included. Windows binaries are not Authenticode-signed. Android uses development signing for sideloading, not Google Play production distribution. npm distributes the CLI/TUI separately.

## 简体中文

### 更新内容

- 移动端 Agent 明确耗尽输出预算时保留进度，提高预算并有限次续写；截断工具调用不执行，普通错误与取消不触发该路径。

- 统一 PC/移动端亮暗主题图标、系统状态栏、对话胶囊与玻璃交互。本地和远程移动对话胶囊新增 PC 同款黑白运行彩边；长按菜单提供触感反馈，Goal/队列按钮保持静态点击行为。
- Markdown 代码块提供独立复制按钮并避让时间线。移动端公式采用离线原生排版，支持多行块公式、行内公式、分段大括号及可读退路。
- 修复两类重复回复：远程 IPC 批次与历史按事件身份合并；本地协议区分增量和完成快照，保留空白及合法重复字词，避免同时读取聚合正文和结构化正文。
- 图片缩略图限尺寸后台解码，对话存储转入后台串行写入，降低带图发送和返回连续操作的卡顿；保留取消、保存合并与标题落库校验。
- 首轮带图标题失败时使用纯文字元数据退路。双端标题推理预算跟随当前档位；配置中的 DeepSeek vision 部署实测 64 token 截断、正常 high 档预算成功。
- 修复双端内置浏览器本地 HTML/file URL 打开路径。browser_use 优先使用文本/DOM，支持指定画幅，并接入配置的视觉模型和 OCR 退路。
- 双端 PDF 按二进制解析文本，扫描页渲染后进入视觉识别。
- 默认搜索 MCP 更新为 Exa 免密钥优先、You.com 免费配置备用，保留可选旧服务和 HTTP 退路。PC MCP 复用网页代理，Android 可不配对 PC 直接搜索。
- Desktop/Android 版本统一为 0.6.2，Android versionCode 为 602。

### 验证与边界

- PC 主验证 1712 项通过，Android 单元测试 381 项通过；本标签执行发行构建及各平台包检查。
- 真实 Android ChatViewModel 设备测试通过“思考预算耗尽 → 正文预算耗尽 → 完成”，校验预算递增与正文仅落库一次。
- 移动彩边四组本地/远程与亮暗测试全部通过，保存 16 张截图；本版本此前视觉、浏览器及带图导航验证保留在本地归档。
- 不据此宣称全应用性能、真机 OEM 后台行为已全面达标；此前测得的整机帧耗时限制仍需持续改进。
- 免费搜索存在网络和额度限制。DeepSeek 实测不代表所有同名网关部署；旧重复回复记录不进行启发式改写。

### 下载与签名

Windows x64 MSI、便携 ZIP；Linux x86-64 AppImage、amd64 deb、便携 ZIP；Android APK，共六项。沿用现有平台矩阵，不包含 macOS 或原生 HarmonyOS 包。Windows 未做 Authenticode 签名；Android 使用开发签名用于侧载，不是 Google Play 正式签名包。CLI/TUI 另通过 npm 分发。
