# Newmark Agent

Newmark Agent 是面向本地工作区的多端 AI Agent。它把对话、Build/Plan/Goal/Flow、文件与终端、浏览器、Memory Lab、自动化和多 Agent 协作整合在同一套本地状态模型中，并提供 Windows/Linux 桌面端、终端界面、CLI 与 Android 客户端。

当前开发版本：`dev-0.5.2`。桌面端与 Android 从根目录 `VERSION` 读取并校验同一个版本，默认 Release 同时发布 Windows、Linux 和 Android。

## 主要能力

- Electron GUI、`Newmark --TUI` 与 `Newmark --cli` 共用工作区、对话和运行时契约。
- Build、Plan、Goal 与 Flow 支持长任务、队列、暂停/恢复、上下文压缩和可追溯 WorkRun。
- 文件、终端、编辑器、浏览器、Computer Use、Git/GitHub、SSH、MCP、技能、自动化与 Memory Lab 均受策略边界约束。
- 模型按供应商部署隔离；同名模型不会共享凭据、验证状态或路由证据。
- Android 支持本地对话、Agent 可调用的工作区终端、本地工具、Memory Lab、系统日程读取/创建与系统分享接收，也支持配对桌面端后的远端对话、文件上传和工作区操作。
- 新安装不预置供应商或密钥；用户自行添加供应商，升级不会清除已有配置。

## 下载与安装

从 [GitHub Releases](https://github.com/positer/Newmark-Agent/releases) 下载与系统对应的构建：

| 平台 | 发布资产 |
| --- | --- |
| Windows | `Newmark-Agent-<version>-x64.msi`、`Newmark-Agent-<version>-win-unpacked-x64.zip` |
| Linux | `Newmark-Agent-<version>-x86_64.AppImage`、`Newmark-Agent-<version>-amd64.deb`、`Newmark-Agent-<version>-linux-unpacked-x64.zip` |
| Android | `Newmark-Agent-<version>-android.apk` |

Windows MSI 为整机安装包；便携 ZIP 解压后即可运行。Linux 可选择 AppImage、Debian/Ubuntu 安装包或解压版。Android APK 需要允许当前文件来源安装未知应用。当前发布属于未签名或开发签名的预发布构建，请从项目 Release 页面下载并核对发布资产。

## 远端触及与 Tailscale

远端触及功能需要桌面端和 Android 端协同使用 [Tailscale](https://tailscale.com/) 虚拟组网。两台设备应加入同一个 tailnet，桌面端开启 Remote Touch 后，再使用配对二维码或 Tailscale 地址连接。

建议配置：

1. 在电脑与 Android 设备安装并登录 Tailscale，确认双方处于同一虚拟网络。
2. 在桌面端开启 Remote Touch，或使用 `Newmark.exe remote on`。
3. 使用 `Newmark.exe pair` 显示配对二维码，并由 Android 客户端完成配对。
4. 确保系统防火墙允许 Newmark 使用 TCP `47890`；不要把该端口直接映射到公网。

普通局域网在路由可达时也可连接，但跨网络、移动网络和异地设备应使用 Tailscale。配对令牌与供应商密钥属于私密数据，不应进入截图、日志或仓库。

## 使用

启动桌面 GUI 后，可在设置中添加供应商、模型与工作区。终端入口：

```text
Newmark --TUI
Newmark --cli --help
```

常用 CLI：

```text
Newmark.exe validate-models --selected provider/model
Newmark.exe memory-lab --help
Newmark.exe pair
Newmark.exe remote status
```

用户配置、凭据、对话、缓存和归档默认位于：

```text
~/.Newmark/
```

仓库中的 `DESKTOP/config.example.json` 仅用于展示配置结构。不要提交真实 `config.json`、API Key、配对令牌或生成的用户数据。

## 开发

桌面端需要 Node.js 24 与 npm：

```powershell
cd DESKTOP
npm ci
npm run build
npm run test:full-release
```

Android 需要 JDK 17 与 Android SDK：

```powershell
android\gradlew.bat -p android testDebugUnitTest lintVitalRelease assembleRelease
```

修改版本时使用唯一版本同步命令：

```powershell
cd DESKTOP
npm run release:version-set -- 0.5.2
npm run release:version-check
```

默认完整发布打包：

```powershell
cd DESKTOP
npm run release
```

该命令执行桌面端完整门禁、Android 单测与 Release lint，并在根目录 `release/` 生成 Windows MSI/ZIP、Linux AppImage/deb/ZIP 和 Android APK。推送 `dev-X.Y.Z` 标签时，GitHub Actions 会独立构建三端并把同版本的六个资产发布为 prerelease。

## 架构

```text
Windows / Linux GUI     TUI / CLI          Android
          \                |                /
           \               |               /
            Conversation- and workspace-bound runtime
                           |
       Agent / Provider / Tool / Context orchestration
                           |
       Local state, Memory Lab, archives and workspaces
```

桌面端远程服务只在用户明确开启后监听；移动端远端操作继续使用桌面端的工作区、对话和运行时身份，不把前台选择当作写入目标。完整内部结构、文件树和历史验收记录见 `OVERVIEW.md` 与 `archive/`，README 仅保留产品使用与发布说明。

## 安全与隐私

- 凭据保存在用户本地配置中，并在诊断和验证输出中脱敏。
- 高风险工具受参数校验、能力供应和授权边界保护。
- 浏览器、运行时事件、草稿、队列和归档按工作区与对话目标隔离。
- 不建议将 Remote Touch 端口直接暴露到公网；异地连接使用 Tailscale 虚拟组网。

## 许可

Copyright © 2025 Newmark AI. All rights reserved. 具体许可边界见 [LICENSE](LICENSE)。
