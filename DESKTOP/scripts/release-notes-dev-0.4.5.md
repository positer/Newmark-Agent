# Newmark Agent `dev-0.4.5`

这是 `dev-0.4.4` 之后的下一个开发版本候选。源码包元数据声明 `0.4.5`。

## Included

- **WSL 下 Windows 工作区跨环境优化**：新增纯函数 `windowsDrivePathToPosix`（盘符 → `/mnt/<drive>`），文件工具 `resolve`、bash 命令越界检查、bash cwd/命令统一归一 Windows 盘符路径；仅 `NEWMARK_WSL_DISTRO` 下启用，非 WSL 行为完全等价。
- **conversation_rename 独立为并行响应 API**：首个完成 Build 的最终响应到达时 fire-and-forget 发起独立 provider 请求生成标题并按格式 rename，不阻塞主流程、不共享主前缀缓存；失败/无 provider 回退本地启发式；保留工具与 `shouldPromptConversationRename` 判定。
- **git 上传安全策略（硬性阻挡 + 二轮审查）**：`git_push`/`gh_pr_create` 前自动 `repo_security_audit`，检测个人密钥（API key/token/私钥）或隐私地址（带凭据 URL、私网 IP、本地用户路径）时硬性阻挡；Agent 二轮审查后传 `security_review_confirmed=true` 放行。
- **高危信息只报类型**：git 审查 findings 收紧为 `{path,line,type}`，密钥值/隐私地址值/脱敏样本绝不进入工具返回或阻挡文本，避免经 API 中转被拦截窃取。
- **删除/git 精准拦截 + 跨平台全工具**：删除审查补齐 `git clean`（非 dry-run）、CMD `for…do del`、PowerShell `ri -Recurse`、CMD `erase /s`；修复 `||` 被误判为管道；并行（`&`）/串行（`;`、`&&`、`||`）多语句删除精准拦截；覆盖 bash 与 `terminal_takeover(write)`。
- **打包后安全 smoke 与 WSL 压力测试**：新增 `release-dev045-security-smoke`（12 断言）、`release-win-wsl-backend-stress`（win 打包版 WSL 后端 10 轮跨环境写文件）、`release-wsl-cross-stress`（正交交叉 ×100 确定性，62 断言）。

## Version boundary

- `DESKTOP/package.json` 与 `DESKTOP/package-lock.json` 声明 `0.4.5`。
- 全压力测试集合 `test:full-release` 全绿；`deletion-safety-stress` 194/194；`verify` 1598/1598；`lint` 0 errors。
- Windows MSI + win-unpacked ZIP 已打包并 UAC 安装；Linux AppImage/deb/unpacked ZIP 经 WSL 隔离构建。

## 校验哈希

- 见 release notes 正文的 SHA-256（win/linux 5 资产）。
