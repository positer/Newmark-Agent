# mobile dev-0.4.31 二级边栏、对话分支与连续时间线

日期：2026-08-17

## 目标

- Android 二级边栏与 Newmark PC GUI `#left-secondary` 一致。
- 竖屏先收回一级栏，再展开二级栏，禁止相互覆盖。
- 移动端远程对话支持 PC 原生分支树阅读和历史编辑分叉。
- 本地对话支持持久化分支数量、分页切换和管理。
- 恢复用户输入与 Agent 回复各自的连续时间线竖线。

## 实现记录

### 二级边栏与竖屏换栏

`Sidebar.kt` 复刻 PC 二级栏的顶栏、设置/新对话/收起按钮、对话行、消息数、更多菜单、active/running 状态和玻璃层级；图标来自 PC 同源 Lucide 几何。竖屏换栏采用分阶段状态：一级栏退出动画完成后才挂载二级栏，避免二级栏覆盖一级栏。

证据：

- `_mobile_0431_swap_t080.png`：80ms 时仍只有一级栏。
- `_mobile_0431_swap_t300.png`：300ms 时一级栏已完全退出，仅二级栏显示。
- `_mobile_0431_secondary.png` / `_mobile_0431_secondary.xml`：二级栏实机结构。

### 远程 PC 分支树

桌面新增移动接口：

- `/api/mobile/conversation-branch-inspect`
- `/api/mobile/conversation-branch-activate`
- `/api/mobile/conversation-branch-create`

接口必须同时携带 `workspaceId` 与 `conversationId`，并按原始工作区成员关系精确查找；跨工作区访问拒绝。运行中激活或创建返回 `423`。实现只调用 PC 既有 `inspectConversationBranch`、`switchConversationBranch`、`branchConversation`，没有复制或重写稳定分支算法。

Android 保存远程浏览分支与运行分支的独立状态；左右分页只读浏览，普通发送前显式激活所阅页。编辑历史用户消息通过桌面接口创建新页。

### 本地分支管理

本地 `LocalConversation` 新增可持久化的节点、分页组、active/viewed 节点和消息锚点。编辑历史用户消息保留原页，创建新分支并发送编辑后的输入；分页切换只改变 viewed 节点，下一次发送前才将 active 节点对齐。

实测中发现 `2/2` 左箭头无响应：分支祖先链同时包含根节点和当前节点，`inspectBranch` 用 `firstOrNull` 按 `nodeIds` 顺序命中根页，将当前位置误判为第 1 页。修复为与分页器渲染相同的祖先 rank 规则，选取距离当前浏览节点最近的分支节点。

证据：

- `_mobile_0431_branch.png` / `_mobile_0431_branch.xml`：编辑后的 `hi2` 与 `2/2`。
- `_mobile_0431_branch_page1_fixed.png` / `.xml`：修复后切回原始 `hi` 与 `1/2`。
- 重新安装并重新进入对话后仍显示 `2/2`，证明分支树持久化生效。

### 连续时间线

消息卡片内部各自画线会在消息、Build 块和分页器之间断裂。现由 `ChatContent` 的 `LazyColumn.drawBehind` 统一绘制用户输入右轨和 Agent 回复左轨，消息节点圆点继续由行组件绘制，轨道与圆点中心对齐。分支创建、分页切换和重新安装后均保持可见。

证据：`_mobile_0431_timeline_fixed.png`、`_mobile_0431_branch_page1_fixed.png`。

## 其他修复

- 后台工作区 SSE 不再覆盖当前远程对话。
- 长对话 `windowStart` 不再导致分页器锚点错位。
- 重命名输入阶段限制 80 字符。
- `RemoteMessage` 不再把 `clientMessageId` 当作 `messageId`。
- 兼容旧 JSON 的 `messageId: null`，升级启动不崩溃。

## 验证

```text
node dist/tests/verify.js
1630 passed / 0 failed

android/gradlew.bat clean assembleDebug
BUILD SUCCESSFUL

adb install -r app-debug.apk
Success

versionCode=431
versionName=0.4.31
```

桌面总门禁包含移动工作区/分支 API 回归，覆盖创建两页、只读 inspect、显式 activate、工作区隔离和运行中 `423`。`git diff --check` 无空白错误，仅有 Git 的 LF→CRLF 工作区提示。

## 文件范围

- `DESKTOP/src/core/agent.ts`：暴露 PC 分支操作所需的受控入口。
- `DESKTOP/src/server.ts`：移动分支 API 和精确目标校验。
- `DESKTOP/src/tests/mobileWorkspaceApiVerify.ts`、`verify.ts`：移动 API 回归。
- `android/app/build.gradle.kts`：`431 / 0.4.31`。
- `android/.../data/`：远程/本地分支模型与 API。
- `android/.../vm/`：本地与远程分支浏览/激活/创建状态机。
- `android/.../ui/`：二级边栏、顺序换栏、分页器和连续时间线。

## 发布边界

本轮只构建并实机安装 debug APK；未发布远程 APK、未改动 PC 分支解析核心、未执行桌面安装包重建或 UAC 安装。
