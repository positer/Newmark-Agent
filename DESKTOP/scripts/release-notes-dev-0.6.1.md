# Newmark Agent dev-0.6.1

## English

### Changes

- **Provider-qualified Desktop identity.** Context model selection, the default provider and the fallback pool now preserve provider-qualified deployment identity. Same-name models from different providers cannot leak into one another during recovery or selection.
- **Provider-qualified Android fallback.** Mobile fallback synchronization decodes the provider and model from qualified deployment IDs and projects the exact provider/model pair into the fallback configuration.
- **Release version binding.** Desktop and Android release metadata are synchronized to 0.6.1; Android uses version code 601.

### Validation

- Desktop release verification passed twice, including the core suite, TUI, SSH TUI, WSL TUI, CLI, mode and conversation stress, plus shared GUI/TUI/CLI backend stress with 18 parallel conversations and 40 provider requests.
- Windows MSI was built, silently installed and verified as version 0.6.1.0. Android release unit tests and the release APK build passed.
- Release version synchronization check passed for all Desktop and Android metadata.

### Assets and limitations

- Windows x64 MSI and portable ZIP; Linux x86-64 AppImage, amd64 deb and portable ZIP; Android APK. Asset names follow the `Newmark-Agent-0.6.1-*` convention.
- Windows executables are not Authenticode-signed. Android uses the project's existing development signing certificate for sideloading and is not a Google Play production APK. Minimum Android SDK is 24.
- No macOS asset is included in the established six-asset release matrix. Final asset hashes are verified after GitHub Actions upload.

## 简体中文

### 本版本变化

- **PC 供应商限定身份。** 上下文模型选择、默认供应商和回退池现在都会保留供应商限定的部署身份，不同供应商的同名模型不会在恢复或选择过程中相互串用。
- **Android 供应商限定回退。** 移动端回退同步会解析限定部署 ID 中的供应商和模型，并将准确的供应商／模型组合写入回退配置。
- **发行版本绑定。** PC 与 Android 发行元数据统一为 0.6.1，Android 版本号为 601。

### 验证结果

- PC 发行验证完成两轮，覆盖核心套件、TUI、SSH TUI、WSL TUI、CLI、模式与会话压力测试，以及 18 个并行会话、40 个供应商请求的 GUI／TUI／CLI 共享后端压力测试。
- Windows MSI 已构建、UAC 静默安装并验证为 0.6.1.0；Android Release 单元测试和发行 APK 构建通过。
- PC 与 Android 发行版本同步检查通过。

### 发行资产与边界

- Windows x64 MSI／免安装 ZIP、Linux x86-64 AppImage／amd64 deb／免安装 ZIP、Android APK；资产沿用 `Newmark-Agent-0.6.1-*` 命名。
- Windows 可执行文件未做 Authenticode 签名。Android 使用项目已有开发签名证书用于侧载，不是 Google Play 生产签名 APK，最低 SDK 为 24。
- 既有六资产发行矩阵不包含 macOS；GitHub Actions 上传后会对最终资产进行哈希校验。
