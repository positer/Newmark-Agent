# Newmark Agent dev-0.6.0

## English

### Changes

- **Desktop model recovery.** Preserve provider-qualified model identity across snapshots, switching, subsequent messages and cold loading. An existing deployment binding survives legacy bare-name snapshots, including catalogs with identical model names under different providers.
- **Response health is advisory.** Undetected and abnormal models remain visible and callable; abnormal models show a gray response warning. Text, vision and tool health reflect the latest real response for each facet, with immediate recovery after success. Errors never disable models. Only the user's enable switch hides a model from selection. Health records are isolated by provider deployment and contain no prompts or credentials.
- **Images and OCR recovery.** Historical vision judgments do not remove images or block communication. Actual image rejection invokes built-in miniOCR followed by conservative LLM text correction, preserves the original task and recovered answer, and does not prevent later image retries. OpenCode-specific request headers are unchanged.
- **Provider model controls.** Model rows have matching side margins, left-aligned information and right-aligned enable, edit and delete controls in that order. The liquid-glass switch represents the user's choice independently of response health.
- **Complete switch motion.** Desktop and Android switches lift from the source, move continuously, and land at the destination. Clicking toggles once; held dragging uses the release endpoint, and cancellation retains the previous state. Desktop glass rendering and Android center anchoring are restored.
- **Android sidebar and provider settings.** Repeated long-press reordering can reverse above its origin; portrait glass is not clipped, and rightward lift displacement is halved while keeping source/destination color anchors. Provider name and editable API endpoint sit outside the vertical glass rail. That rail stays below the horizontal protocol selector; endpoint changes require an explicit valid save.
- **DeepSeek first-response recovery.** Title generation retains its short-title requirement with a 2048-token completion budget, avoiding the previous 64-token reasoning truncation that could prevent the first conversation request.

### Focused acceptance evidence

- Pre-release functional verification passed 11 deployment-binding checks, 14 response-health checks, and two HTTP/image/OCR recovery paths. Real configured gpt-5.6-terra and DeepSeek deepseek-v4-pro completed first conversations with their deployment identity preserved.
- Desktop main verification reported 1707 passed and 0 failed; the remaining suite completed in recorded stages. The previous candidate's packaged GUI passed 11 switch/model-row checks, alongside SSH/PTY, CLI, context-compression and launcher checks. These are functional evidence, not hashes of the new 0.6.0 assets.
- Android passed 365 JVM checks and seven targeted device checks for switches and provider editing. Earlier sidebar verification covered 30 device checks. Device results came from an emulator, not physical-device acceptance.

### Release validation

The release binds Desktop 0.6.0 and Android 0.6.0 / 600. Final platform build receipts and asset SHA-256 values are added after upload verification.

### Assets and limitations

- Windows x64 MSI and portable ZIP; Linux x86-64 AppImage, amd64 deb and portable ZIP; Android APK. Asset names follow the existing `Newmark-Agent-0.6.0-*` convention.
- Windows executables are not Authenticode-signed. Android retains the project's existing development signing certificate for sideloading; it is not a Google Play production-signed APK. Minimum Android SDK is 24.
- No macOS asset is included in the established six-asset release matrix. Packaging and release verification do not imply installation over an existing user installation. Physical Android devices, OEM background behavior and mobile-network transitions remain outside the device evidence.

## 简体中文

### 本版本变化

- **PC 模型恢复。** 会话快照、模型切换、后续发送和冷加载保留供应商限定的模型身份。同名模型分属不同供应商时，已有部署绑定也不会因旧式裸模型名快照丢失。
- **响应状态只作提示。** 未检测和响应异常的模型仍可见、可调用，异常模型名后追加灰色提示。文本、视觉、工具分别记录最新真实响应，一次成功立即恢复对应标识。报错不禁用模型，只有用户开关会隐藏模型。状态按供应商部署隔离，不保存提示词或凭据。
- **图片与 OCR 退路。** 历史视觉判断不剥离图片、不拦截通信。实际图片拒绝后调用内置 miniOCR 与保守的 LLM 文本纠错，保留原始任务及恢复回答，后续图片仍正常尝试。未修改 OpenCode 特殊请求头。
- **供应商模型控件。** 模型行左右留白一致，信息左对齐，右侧按开关、编辑、删除排列。液态玻璃开关独立表示用户的启用选择，不受响应标识影响。
- **完整开关动效。** PC 与 Android 从起点浮起、连续移动、在终点落下；点击仅切换一次，长按拖动按松手档位决定，取消不提交。修复 PC 浮块显示与 Android 中心锚点。
- **移动端侧栏和供应商设置。** 连续长按重排可反向跨过起点，竖屏浮块不被裁切，右偏幅度减半且保留起终点色块绑定。供应商名和可编辑 API 接口移出竖向玻璃轨道，竖向轨道只位于横向协议选择下方；接口须有效且显式保存后生效。
- **DeepSeek 首轮恢复。** 标题保持简短要求，完成预算从 64 调整为 2048 token，避免思考耗尽预算后反复截断，阻止正式对话开始。

### 专项验收证据

- 发行前通过 11 项部署绑定、14 项响应状态及两条 HTTP／图片／OCR 恢复路径；真实配置的 gpt-5.6-terra 和 DeepSeek deepseek-v4-pro 均完成首次对话并保留部署身份。
- PC 主验证为 1707 项通过、0 项失败，剩余测试链按归档阶段完成。上一候选的打包版通过 11 项开关／模型行检查，以及 SSH／PTY、CLI、上下文压缩和启动器检查；这些属于功能证据，不是新 0.6.0 资产哈希证明。
- Android 通过 365 项 JVM 检查和七项开关／供应商编辑设备检查，之前的侧栏验证覆盖 30 项设备检查。设备证据来自模拟器，不代表实体手机验收。

### 本次发行验证

统一 Desktop 0.6.0 与 Android 0.6.0／600。最终平台构建结果和资产 SHA-256 在上传校验后补全。

### 发行资产与边界

- Windows x64 MSI／免安装 ZIP、Linux x86-64 AppImage／amd64 deb／免安装 ZIP、Android APK；沿用 `Newmark-Agent-0.6.0-*` 资产命名。
- Windows 未做 Authenticode 签名。Android 沿用项目已有开发签名证书用于侧载，不是 Google Play 生产签名 APK，最低 SDK 24。
- 既有六资产发行矩阵不包含 macOS。打包与发行验收不代表已覆盖安装用户现有程序；实体 Android、OEM 后台行为和移动网络切换不在上述设备证据内。
