# Newmark Agent dev-0.4.6

## Windows
- MSI 与 win-unpacked ZIP，per-machine 安装，开始菜单/桌面快捷方式默认开启（升级也重建）。

## Linux
- AppImage、deb、linux-unpacked ZIP，经 WSL Ubuntu-24.04 隔离构建。

## 本版本主要变更
- 移动端 Tailscale 连接准备：配对 token、二维码配对、SSE 实时工作事件、对话/工作区/消息同步 REST API（接口冻结）。
- GUI/TUI/CLI 远程触及开关。
- GUI/TUI 通用设置新增「远程行为」子组：远程开关 + 发起连接。
- 插件-GitHub 面板新增刷新与连接按钮。
- DSH 插件兼容：只读发现 + 安装到本地 .Newmark + 启用/禁用/卸载管理。
- 对话操作菜单整合为单按钮三点菜单，支持右键。

## 哈希
见 release 资产与本地构建记录。
