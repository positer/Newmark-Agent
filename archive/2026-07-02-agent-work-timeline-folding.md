# Agent Work Timeline Folding

Date: 2026-07-02

## Summary

This update fixes the UI issue where one send could show duplicate preparing rows and expose low-value workflow status messages.

- Removed the renderer-created `Preparing request...` chat placeholder.
- Backend `start`, `status`, and `done` work events no longer render as visible workflow rows.
- Streaming model text updates the assistant response immediately.
- Tool activity is grouped into one folded batch per turn.
- The batch title shows `正在编辑 x 个文件，正在使用 x 个工具` while running and `已编辑 x 个文件，已使用 x 个工具` after completion in Chinese UI.
- Expanding the batch reveals nested folded entries for each tool call and result.
- Hidden reasoning remains suppressed.
- Ordinary tool results no longer become final assistant text; terminating tools such as Flow, Memory Lab, automation, subagent management, and questions still return visible results.

## Files

- `DESKTOP/src/core/agent.ts`
- `DESKTOP/src/core/agentKernelRunner.ts`
- `DESKTOP/src/core/types.ts`
- `DESKTOP/src/ui/index.html`
- `DESKTOP/src/tests/verify.ts`
- `README.md`
- `OVERVIEW.md`

## Verification

```powershell
cd DESKTOP
npm.cmd test
```

Result: 760 passed, 0 failed.

## Remaining Risk

The UI behavior has source-level regression coverage. Packaged visual validation still depends on rebuilding `release/win-unpacked` and reopening the real configured UI.
