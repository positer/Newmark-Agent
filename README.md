# Newmark Agent

**本地优先的个人 Agent 工作站。** 桌面（Windows / Linux）、Android 与终端 TUI / CLI 共用同一套对话、工作区与运行时契约；会话、文件、终端、浏览器、Computer Use、Git/GitHub、SSH、MCP 与技能都在策略边界内由 Agent 调用，长期记忆与工程约定留在本机。数据默认保存在 `~/.Newmark`。

[下载与安装](#下载与安装) · [主要能力](#主要能力) · [Newmark2DSH 插件](#newmark2dsh-插件) · [使用](#使用) · [开发](#开发) · [架构](#架构) · [安全与隐私](#安全与隐私) · [许可](#许可)

## 主要能力

- Electron GUI、`Newmark --TUI` 与 `Newmark --cli` 共用工作区、对话和运行时契约。
- Build、Plan、Goal 与 Flow 支持长任务、队列、暂停/恢复、上下文压缩和可追溯 WorkRun。
- 文件、终端、编辑器、浏览器、Computer Use、Git/GitHub、SSH、MCP、技能、自动化与 Memory Lab 均受策略边界约束。
- 模型按供应商部署隔离；同名模型不会共享凭据、验证状态或路由证据。
- Android 支持本地对话、Agent 可调用的工作区终端、本地工具、Memory Lab、系统日程读取/创建与系统分享接收，也支持配对桌面端后的远端对话、文件上传和工作区操作。
- Android 设置中的「读取所有文件」和「读取应用列表」是 Agent 工具面的硬开关。关闭文件开关时只暴露内部 `files/newmark/workspace` 安全目录；开启后跳转 Android 系统授权页，应用内开关与系统授权同时有效才开放最新文件/共享存储工具。应用列表同样要求应用内开关与系统「使用情况访问」授权同时有效。两项都不依赖 Root/Shizuku。移动端冷启动默认恢复上次本地对话，远程对话仅在用户主动选择设备后进入。
- Android 本地 Agent 在兼容服务拒绝 Chat Completions 的「工具 + 推理强度」组合时，会自动切换到 Responses API；若模型明确不支持 `temperature`，会移除该参数重试并继续流式呈现思考、正文与工具调用。
- 新安装不预置供应商或密钥；用户自行添加供应商，升级不会清除已有配置。

## Newmark2DSH 插件

桌面端可以把 **Newmark2DSH** 装进 DeepSeek Harness，让持久记忆、桌面自动化与私人秘书式陪伴进入 DSH 会话：

| 组件 | 帮你完成什么 |
| --- | --- |
| **MemoryLab** | 长期树状记忆（用户画像、知识图谱）与短期到期列表（跨对话任务交接） |
| **ComputerUse** | 观察屏幕与应用，执行鼠标、键盘及窗口操作 |
| **Agent API** | 用统一接口发现工具、派发工具、调用授权模型完成一次 Agent 运行 |
| **NewMate** | 带记忆的对话、低打扰主动联系、定时待办、自己刷新与管理会话 |
| **heartBeat** | 登记重启后任务，在宿主恢复后可靠交接并留下消费回执 |

写法、配置页、版本管理与更新说明在 [Newmark2DSH 产品页](Newmark2DSH/README.md)；完整文件树与实现记录见 [OVERVIEW.md](Newmark2DSH/OVERVIEW.md) 与 [维护约定](Newmark2DSH/taste.md)。

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

用户配置、凭据、对话、缓存和归档默认位于 `~/.Newmark/`。仓库中的 `DESKTOP/config.example.json` 仅用于展示配置结构。不要提交真实 `config.json`、API Key、配对令牌或生成的用户数据。

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

修改版本号时使用唯一版本同步命令（版本号本身只写在清单与 `VERSION` 里，不写进 README）：

```powershell
cd DESKTOP
npm run release:version-set -- <version>
npm run release:version-check
```

默认完整发布打包：

```powershell
cd DESKTOP
npm run release
```

该命令执行桌面端完整门禁、Android 单测与 Release lint，并在根目录 `release/` 生成 Windows MSI/ZIP、Linux AppImage/deb/ZIP 和 Android APK。推送 `dev-X.Y.Z` 标签时，GitHub Actions 会独立构建三端并把六个同名资产发布为 prerelease。

## 架构

桌面端远程服务只在用户明确开启后监听；移动端远端操作继续使用桌面端的工作区、对话和运行时身份，不把前台选择当作写入目标。

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

完整内部结构、文件树与历史验收记录见 `OVERVIEW.md` 与本地归档（未纳入公开仓库）；README 只描述当前能力与使用方式。

## 安全与隐私

- 凭据保存在用户本地配置中，并在诊断和验证输出中脱敏。
- 高风险工具受参数校验、能力供应和授权边界保护。
- 浏览器、运行时事件、草稿、队列和归档按工作区与对话目标隔离。
- 不建议将 Remote Touch 端口直接暴露到公网；异地连接使用 Tailscale 虚拟组网。

## 许可

Copyright © 2025 Newmark AI. All rights reserved. 具体许可边界见 [LICENSE](LICENSE)。

## 版本与历史

**README 不写具体版本号。** 发布版本、发布说明与历史记录在 [VERSION.md](Newmark2DSH/VERSION.md)、[GitHub Releases](https://github.com/positer/Newmark-Agent/releases) 与本地 `archive/` 中；本文件只描述当前能力，改了功能就改描述，不追写版本。
