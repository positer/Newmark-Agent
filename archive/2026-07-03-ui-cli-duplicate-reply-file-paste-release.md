# UI/CLI Duplicate Reply and File Paste Release Fix

Date: 2026-07-03

## Summary

This release pass fixes the real-model UI double final reply symptom and adds file paste/drop support for conversation input.

## Root Cause

The renderer receives live assistant text through `agent:workEvent` while a turn is running. When the kernel finishes, `window.sendMessage()` also receives the final returned token list. Before this fix, the `done` event cleared the active workflow message reference, so the final returned token text could create a second assistant row containing the same content.

## Changes

- `DESKTOP/src/ui/index.html`
  - Records the just-completed streamed assistant message when a `done` event arrives.
  - Reuses that message when returned tokens match the same conversation instead of appending another assistant row.
  - Keeps internal workflow rows hidden and folded tool batches visible.
  - Inserts pasted or dropped file paths into the prompt.
- `DESKTOP/src/preload.ts`
  - Exposes `filePathForFile(file)` through Electron `webUtils.getPathForFile`.
- `DESKTOP/scripts/release-real-provider-smoke.cjs`
  - Verifies CLI and UI real-provider markers appear exactly once.
  - Uses assistant-scoped DOM checks instead of whole-page text.
  - Emits assistant/backend debug summaries if marker waiting fails.
- `DESKTOP/src/tests/verify.ts`
  - Guards duplicate-final-reply prevention, file paste/drop path insertion, and real-provider duplicate marker checks.

## Verification

```powershell
cd DESKTOP
npm.cmd test
$env:NEWMARK_APINEBULA_KEY = Get-Content -Raw ..\_ref\APInebula-key.txt
$env:NEWMARK_REAL_UTF8 = '1'
$env:NEWMARK_REAL_VALIDATE_MODELS = '1'
npm.cmd run release:real-provider-smoke
npm.cmd run dist:portable
```

Results:

- `npm.cmd test`: 762 passed, 0 failed.
- `npm.cmd run dist:portable`: passed; packaged CLI smoke, exe icon patch/verify, portable executable, and compiled zip pack verified.
- `release:real-provider-smoke`: passed with APInebula, UTF-8 checks, real model validation, packaged CLI send, packaged UI send, exact single marker checks, screenshot evidence, and secret redaction.
- `release:real-apinebula-memory-switch-smoke`: passed real Memory Lab read/create and unavailable-model fallback.
- `release:real-provider-stress`: passed APInebula CLI rounds, UI rounds, Goal continuation, queue drain, conversation isolation, long-context send, secret guards, and process cleanup.

Final v1.1.0 artifact hashes:

- `Newmark-Agent-1.1.0-portable-x64.exe`: `EE3131753A09BC6F37BFFD41BA94545AF389C834112BE3ED2E0424A93C41FE07`
- `Newmark-Agent-1.1.0-win-unpacked-x64.zip`: `767E5B6E733A64400F6F7671A46DB308AC8A226C034657E103CBCFC68BCDBD55`

## Release Notes

- The expected v1.1.0 artifacts are `release/Newmark-Agent-1.1.0-portable-x64.exe` and `release/Newmark-Agent-1.1.0-win-unpacked-x64.zip`.
- `release:real-provider-smoke` is the primary real APInebula gate for the duplicate reply fix because it drives both packaged CLI and packaged UI paths.
- File path paste/drop is covered through source assertions and the preload/UI bridge; native OS clipboard path behavior remains Electron-platform-dependent.
