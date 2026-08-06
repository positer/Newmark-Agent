# macOS 构建

Newmark Agent 的 macOS 分发是 dmg 包。electron-builder 强制要求 **macOS 包只能在 macOS 主机上构建**
（详见 https://electron.build/multi-platform-build）。Windows/Linux 主机上运行 `dist:mac` 会得到：
`Build for macOS is supported only on macOS`。

## 前置条件（macOS 主机）

- macOS 12+，Xcode Command Line Tools（`xcode-select --install`）
- Node.js ≥ 20
- 若需签名/公证：Apple Developer 证书 + `notarize` 配置（默认关闭）

## 构建

```bash
cd DESKTOP
npm ci
npm run build
npm run dist:mac
```

产物写入仓库级 `release/Newmark-Agent-<version>-<arch>.dmg`。

## 交叉编译预检（任意主机）

在任何主机上运行以下命令即可确认平台无关性与构建矩阵，无需 macOS 主机：

```bash
node scripts/check-cross-platform-env.cjs
```

该脚本验证：TypeScript 平台无关编译、UI bundle 为纯 web 资产、`afterPack` 钩子对非
Windows 平台守卫、以及 Windows/Linux/macOS/HarmonyOS 各自的构建入口。

## CI 建议

- Windows/Linux 产物在各自 runner 构建。
- macOS dmg 在 `macos-latest` GitHub Actions runner 上构建（electron-builder 原生支持）。
- HarmonyOS headless 核心在任意 runner 构建 `dist/server.js` + `dist/launcher.js`。
