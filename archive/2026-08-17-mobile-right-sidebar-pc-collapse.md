# mobile dev-0.4.32：PC 同构右侧栏与无占位折叠态

日期：2026-08-17

## 完成范围

- Android 右侧栏移植 Files、Editor、Conversation plan/Linked plan、SubAgent、Browser 五页；Editor 明确不包含预测随航。
- 折叠态不再保留整列。`RightSidebarOpenButton` 位于聊天主页面右缘中央，尺寸 18×48dp，不参与 Row 宽度分配，并使用 PC `panel-right` Lucide 几何。
- 支持点击折叠按钮和主页面左滑两种展开方式。
- 仅竖屏 SubAgent 详情进入独立加页；平板/折叠屏保持弹窗。Memory Lab 竖屏保持加页，平板/折叠屏使用 94%×92% 大弹窗。
- 一级栏 rail 不再渲染本地对话标题或聊天气泡缩略项，只保留一级导航和底部固定入口。
- 用户/Agent 双侧连续时间线保留 0.4.31 的修复。

## 关键文件

- `android/app/src/main/java/com/newmark/mobile/ui/RightSidebar.kt`：五页右栏、独立折叠按钮、SubAgent 页/弹窗。
- `android/app/src/main/java/com/newmark/mobile/ui/NewmarkApp.kt`：右栏根状态、左滑、竖屏覆盖与宽屏第三栏、响应式页面规则。
- `android/app/src/main/java/com/newmark/mobile/ui/Sidebar.kt`：rail 删除本地对话缩略项。
- `android/app/src/main/java/com/newmark/mobile/ui/MemoryLabScreen.kt`：宽屏大弹窗。
- `android/app/src/main/java/com/newmark/mobile/ui/components/LucideIcons.kt`：PC 同源 `panel-right` 等图标。
- `DESKTOP/src/server.ts` 与 `DESKTOP/src/tests/mobileWorkspaceApiVerify.ts`：右栏工作区精确 API 与 38 条回归。

## 实机证据

- `_mobile_0432_right_collapsed_final.png/xml`：平板折叠态独立按钮；图标 bounds `[1572,1270][1592,1290]`，位于 1600×2560 右缘中央。
- `_mobile_0432_right_open_final.png/xml`：点击后五个 tab 与关闭按钮完整出现。
- `_mobile_0432_right_swipe_final.xml`：关闭后主页面左滑，`SWIPE_OPEN=True`。
- `_mobile_0432_no_local_thumbs.png/xml`：右栏展开、一级栏进入 rail 后没有本地对话缩略列。
- `_mobile_0432_right_portrait_final.png/xml`：竖屏折叠按钮存在。

## 验证结果

- `cd DESKTOP && npm run build`：PASS。
- `node dist/tests/mobileWorkspaceApiVerify.js`：38/38 PASS。
- `node dist/tests/verify.js`：1641/1641 PASS。
- `cd android && gradlew clean assembleDebug`：PASS。
- debug APK：`versionCode=432`、`versionName=0.4.32`。
- `git diff --check`：PASS（仅换行符提示）。
- 模拟器最终状态：physical/active size 1080×2400，density 420。

## 交付边界

- 本轮以本地 commit `mobile dev-0.4.32` 和 annotated tag `mobile-dev-0.4.32` 固化。
- 未 push、未发布。
