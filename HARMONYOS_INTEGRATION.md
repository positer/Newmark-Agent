# HarmonyOS 集成（headless）

Newmark Agent 是一个 Electron 桌面应用，无法直接在 HarmonyOS 上运行 Electron 运行时。本项目的
HarmonyOS 集成采用 **headless 模式**：把核心 Agent/Server/CLI 编译为平台无关的 Node bundle，
在 HarmonyOS 的 Node 运行环境（或兼容层）中启动，然后由 ArkUI/ArkWeb 应用通过 HTTP 连接。

## 前置条件

- Node.js ≥ 20（HarmonyOS 侧需提供 Node ABI 兼容的运行时，或通过鸿蒙 NEXT 的 Node 生态容器）
- 本仓库 `DESKTOP/` 依赖

## 构建 headless 核心

```bash
cd DESKTOP
npm ci
npm run build
```

产物（`dist/` 下，平台无关的 CommonJS）：

- `dist/server.js` —— HTTP 服务（默认端口 47890），提供状态/会话/Flow/工具等 JSON API
- `dist/launcher.js` —— CLI/TUI 入口（`node dist/launcher.js --cli` / `--TUI`）
- `dist/core/*` —— Agent/Flow/Provider 核心

`server.ts` 与 `launcher.ts` 均通过 `process.platform` 分支处理平台差异（Windows PowerShell vs
POSIX shell），不依赖任何 Electron API，可跨平台编译。

## 验证

```bash
node scripts/check-cross-platform-env.cjs   # 平台无关性检查
node dist/server.js --help                   # headless 服务自检
```

## ArkUI/ArkWeb 接入

ArkUI 应用通过 WebView 加载 `dist/ui/index.html`（纯 web 资产），并把 `window.api` 桥接为对
`dist/server.js` 的 HTTP 调用；或直接用 ArkTS 请求 `server.js` 的 JSON API。

## 限制

- 不提供 Electron 原生能力（系统托盘、本地终端 PTY、桌面文件系统对话框）。
- 依赖 HarmonyOS 侧可用的 Node 运行时；若需原生鸿蒙能力，建议另建 ArkTS 原生 UI，仅复用
  `dist/core` 的 Agent/Flow 逻辑（通过 headless server 或鸿蒙 Node 容器）。
