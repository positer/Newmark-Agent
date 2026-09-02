# Newmark Agent dev-0.5.13

全平台预发布：Windows x64 MSI + win-unpacked ZIP、Linux AppImage + deb + linux-unpacked ZIP、Android APK。

## 本版本主要变化

- 双端首轮对话标题总结：正式响应前独立标题探测，失败自动执行 0s → 1s → 2s → 4s → 8s 的 5 级退避，不再要求手动再次发送。
- Desktop `pdf_read`：整次工具调用使用 1–120 秒累计 deadline，覆盖异步文件读取、pdf.js 全文解析和扫描页视觉观察；超时返回可恢复回执。
- 移动端内建 Markdown/LaTeX 离线字体：Noto Sans Math 覆盖数学符号，Noto Sans Mono CJK SC 覆盖代码 CJK/框线/箭头；代码块按父级约束软换行。
- 移动端代码高亮：修复高亮占位符被数字正则破坏导致的方框；Token 色按亮暗主题切换，亮色模式绿色/关键字/注释/数字/类型/tag 均使用更深可读色。
- 移动端 `image_inspect`：安全工作区或已授权 URI/共享路径 PNG/JPEG 可通过当前视觉模型查看，限制 10 MiB、4000 万像素，图片字节不进入持久历史。
- Search MCP 搜索池、Browser Use `visible`、OpenAI Responses 严格完成态、后台前台服务与网络恢复均已包含。

## 发布边界

- Windows MSI 使用项目既有 Debug/未签名边界，不是 Authenticode 商店签名。
- Android APK 使用工程既有 Debug 证书，不是 Google Play 生产签名。
- macOS DMG 需在 macOS 主机构建，本次不包含在 Windows 主机产物中。
- 产物名称使用统一 `Newmark-Agent-<version>-<platform>` 格式；Release tag 使用 `dev-0.5.13`。
