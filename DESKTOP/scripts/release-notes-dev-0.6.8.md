# Newmark Agent dev-0.6.8

## English

### Highlights

- Computer Use now has native Windows-MCP-inspired interaction modes. `observe` and `app_observe` can request a fast screenshot without a UI Automation tree; the default observation still returns semantic controls and `target_id` values. The read-only `wait_for` action waits for text, a semantic target, or a window in the foreground or explicitly selected window, with a 5-second default and a 30-second maximum. Screenshot-only observations clear old semantic targets so later actions cannot reuse stale IDs. This uses Newmark's existing PowerShell and Windows UI Automation channel and adds no external Windows-MCP service or Python runtime.
- Dedicated file mutation tools now require a fresh read receipt for the exact target. Full-file overwrite and deletion require a full read; `edit` requires the old text in the observed lines and rejects non-unique matches. Creating a new file requires observing that its exact path is absent and uses exclusive creation. Receipts are bound to the workspace, session, executor, and Build run, expire after five minutes, and become invalid when the target identity or contents change. Successful mutations consume the receipt, and same-path mutations are serialized.
- The read-before-mutate gate covers `write`, `edit`, `delete_file`, and `web_catch` when saving to a local target. Shell and terminal commands, browser/CDP, Computer Use, Flow, Memory Lab, skill downloads, and other structured state changes retain their own entry-point controls; this gate does not claim to mediate those paths.
- Updated vulnerable transitive dependency resolutions, including the production `fast-uri` pin to 3.1.6. A clean install reports zero npm audit findings.

### Platform packages

- Windows x64: MSI installer and portable ZIP
- Linux x64: AppImage, Debian package, and portable ZIP
- Android: development-signed APK for sideload testing
- CLI/TUI: published separately to npm as `newmark-agent`
- A SHA-256 manifest accompanies the six platform packages.

### Validation

- `npm run test:full-release` passes on a clean dependency install, including the write-observation concurrency stress suite, desktop and CLI contracts, SSH/WSL TUI stress, and build cancellation checks.
- The standalone Computer Use real-model scenario uses an isolated Electron instance, a synthetic high-contrast screen marker, and a read-only observation action with the configured DeepSeek deployment.
- Windows, Linux, and Android release workflows each bind their packages to version 0.6.8; Android tests, release lint, and APK assembly run before the release job publishes the assets.

### Release limits

- This is a prerelease development build. Windows binaries are not Authenticode-signed. The Android APK uses the project's development signing identity and is not a Google Play release.
- macOS packages are not included in the established release matrix; they require a native macOS build host.
- The Computer Use additions use native Windows UI Automation and are Windows-specific. This release does not claim physical Android device acceptance.

## 简体中文

### 主要更新

- Computer Use 原生加入受 Windows-MCP 启发的交互模式。`observe` 和 `app_observe` 可请求不含 UI Automation 树的快速截图；默认观察仍返回语义控件与 `target_id`。新增只读 `wait_for`，可在前台或明确选择的窗口中等待文本、语义目标或窗口出现，默认 5 秒、最长 30 秒。仅截图的观察会清除旧语义目标，避免后续动作复用过期 ID。实现沿用 Newmark 现有的 PowerShell 与 Windows UI Automation 通道，不增加外部 Windows-MCP 服务或 Python 运行依赖。
- 专用文件变更工具现在必须先取得精确目标的新鲜读取回执。整文件覆盖和删除要求完整读取；`edit` 要求旧文本位于已观察行内，并拒绝非唯一匹配。新建文件要求先确认精确路径不存在，落盘使用排他创建。回执绑定工作区、会话、执行者和 Build run，五分钟后过期；目标身份或内容变化时立即失效。成功变更会消费回执，同一路径的变更会串行执行。
- 读前变更门禁覆盖 `write`、`edit`、`delete_file`，以及写入本地目标的 `web_catch`。Shell/终端命令、Browser/CDP、Computer Use、Flow、Memory Lab、技能下载和其他结构化状态变更仍由各自入口控制；本门禁不声称拦截这些路径。
- 更新了存在漏洞的传递依赖解析，其中生产依赖 `fast-uri` 固定升至 3.1.6。干净安装后的 npm 审计为零项。

### 平台包

- Windows x64：MSI 安装包与便携 ZIP
- Linux x64：AppImage、Debian 安装包与便携 ZIP
- Android：用于侧载测试的开发签名 APK
- CLI/TUI：以 `newmark-agent` 名称单独发布到 npm
- 六个二进制平台包同时提供 SHA-256 校验清单。

### 验证

- 干净依赖安装后 `npm run test:full-release` 通过，包含写入观察并发压力、桌面与 CLI 契约、SSH/WSL TUI 压力以及构建取消检查。
- Computer Use 真模型场景使用隔离 Electron、合成高对比度屏幕标记、只读观察动作和已配置的 DeepSeek 部署。
- Windows、Linux、Android 发布工作流均绑定 0.6.8 版本；Android 在发布资产生成前运行单元测试、Release lint 和 APK 构建。

### 发布边界

- 本版为开发预发行版。Windows 二进制未做 Authenticode 签名；Android APK 使用项目开发签名，不是 Google Play 发布包。
- 既有发布矩阵不包含 macOS；该平台构建需要原生 macOS 主机。
- 新增 Computer Use 模式依赖 Windows UI Automation，仅适用于 Windows。本版不宣称通过 Android 实体设备验收。
