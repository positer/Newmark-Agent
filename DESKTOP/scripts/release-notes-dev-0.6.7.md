# Newmark Agent dev-0.6.7

## English

### Highlights

- Auto model changes are now decided by the current eligible conversation model through a strict JSON decision. The setting offers three qualitative tendencies—Conservative, Balanced, and Aggressive—without turning them into fixed rankings or score thresholds. Auto ratings, feedback persistence, and feedback-history controls have been removed; existing local feedback files are left untouched.
- Conversation state and runtime handling have stronger cross-process persistence, branch and queue identity boundaries, archive recovery, and continuation checks across desktop and Android. Long-history rendering avoids per-message entrance animation and permanent compositing layers; new messages retain lightweight motion.
- The desktop interface has a more consistent visual system, clearer keyboard focus, reduced-motion support, and refined transitions. A/B measurements were mixed: this release does not claim an overall frame-rate improvement or 165 Hz presentation.
- Computer Use can wait on a bounded, low-resolution screen-change signal before collecting a fresh full screenshot and UI Automation tree for the current conversation vision provider. The desktop production app no longer depends on the retired local ONNX/CU-Lab inference path.
- Existing chat and provider communication contracts remain in place. The dedicated Auto feedback transport was retired with its feature.

### Platform packages

- Windows x64: MSI installer and portable ZIP
- Linux x64: AppImage, Debian package, and portable ZIP
- Android: APK for sideload testing
- CLI/TUI: npm package, published separately as `newmark-agent`

### Release notes and limits

- This is a prerelease development build. Windows binaries are not Authenticode-signed. The Android APK uses the project's development signing identity and is not a Google Play release.
- macOS packages are not included because this release matrix requires a native macOS build host.
- Android emulator stress checks still report UI jank under sustained animation; no physical-device acceptance is claimed.
- GUI RAF callback measurements are not compositor presentation FPS. Results do not establish a general frame-rate increase or a 165 Hz target.

## 简体中文

### 主要更新

- Auto 切换现在由当前符合资格的对话模型通过严格 JSON 作出决策。设置提供“保守 / 均衡 / 激进”三种定性倾向，不将其转成固定排序或分数阈值。Auto 评分、反馈持久化与历史管理入口已移除；既有本地反馈文件保持原样。
- 加强桌面与 Android 的跨进程对话状态持久化、分支和队列身份边界、归档恢复及接续检查。长历史渲染不再为每条消息分配入场动画或永久合成层；新消息仍保留轻量动效。
- 桌面界面的视觉令牌、键盘焦点、减少动态效果偏好及过渡动画得到统一和打磨。A/B 测量结果不一致，因此本版不宣称整体帧率提升，也不宣称达到 165 Hz 实际呈现。
- Computer Use 可先等待有界的低分辨率屏幕变化信号，再为当前对话视觉 Provider 采集完整新鲜截图和 UI Automation 树。桌面生产应用不再依赖已退役的本地 ONNX/CU-Lab 推理路径。
- 普通聊天和 Provider 通信契约保持不变；Auto 专用反馈传输随功能一起退役。

### 平台包

- Windows x64：MSI 安装包与便携 ZIP
- Linux x64：AppImage、Debian 安装包与便携 ZIP
- Android：用于侧载测试的 APK
- CLI/TUI：以 `newmark-agent` 名称单独发布到 npm

### 发布边界

- 本版为开发预发行版。Windows 二进制未做 Authenticode 签名；Android APK 使用项目开发签名，不是 Google Play 发布包。
- 发布矩阵未包含 macOS，因为该平台打包要求原生 macOS 构建主机。
- Android 模拟器持续动画压力测试仍观察到 UI 卡顿；不宣称通过实体设备验收。
- GUI RAF 回调测量不等同于合成器实际呈现 FPS；现有结果不能证明整体帧率普遍提升或达到 165 Hz 目标。
