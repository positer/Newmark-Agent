# Newmark TUI CJK Partition and Global Launcher

Date: 2026-07-29
Scope: TUI rendering, DESKTOP launcher/build/package entry, current-user global command

## Result

The terminal UI is available through:

```powershell
Newmark --TUI
```

The invoking directory is preserved and selected through Newmark's existing WorkspaceManager. If no matching Workspace exists, it is registered as an external local Workspace. Runtime state remains under `~/.Newmark`.

## Rendering correction

The reported screenshot showed a long Chinese assistant line crossing the Workspace boundary after terminal-owned wrapping. The renderer counted every Unicode code point as one column, although CJK/full-width characters occupy two terminal columns.

The corrected renderer:

- calculates ANSI-safe terminal display width;
- treats combining marks/ZWJ/variation selectors as zero-width;
- treats CJK/full-width/emoji code points as two columns;
- wraps Conversation message content before writing the frame;
- keeps continuation rows inside the detail pane with a fixed role indent;
- pads absent sidebar rows before drawing the separator.

The regression fixture uses a long Chinese Newmark response and asserts every rendered row is within 100 columns and every Workspace separator remains at display column 22.

## Launcher and distribution

- `DESKTOP/src/launcher.ts`: case-insensitive `--TUI`, Node hashbang, cwd/root handoff.
- `DESKTOP/src/main.ts`: packaged Electron CLI path for `--TUI`.
- `DESKTOP/newmark.bat`: terminal-attached portable `--TUI` forwarding.
- `DESKTOP/scripts/build-tui.cjs`: copies TUI runtime into `DESKTOP/dist/tui`.
- `DESKTOP/package.json`: build step, npm `newmark` bin, focused `test:tui`.
- `DESKTOP/src/tests/tuiLauncherVerify.ts`: nine source/artifact contract checks.
- Development-stage `npm.cmd link`: created `%APPDATA%\npm\newmark.ps1`/`.cmd` routing to this checkout. Final release validation removed this link; the installed MSI now provides `Newmark.exe` through the user PATH.

## Verification

- `TUI/npm.cmd test`: 25 passed, 0 failed.
- `DESKTOP/npm.cmd run test:tui`: 9/9 checks passed.
- Compiled `dist/launcher.js --TUI` ConPTY from an isolated project: Core visible, cwd visible, Workspace persisted, exit 0.
- Literal PowerShell `Newmark --TUI` ConPTY from an isolated project: command resolved, Core visible, cwd visible, Workspace persisted, TUI and shell exit 0.
- `DESKTOP/npm.cmd test`: passed, exit 0, 242.4 seconds.
- Build warnings were the pre-existing esbuild `xhr-sync-worker.js` externalization warnings; no new build or test failure occurred.
- All test temporary roots were deleted.

## Remaining architecture boundary

GUI, CLI, and TUI share Core code and durable `~/.Newmark` state. They still construct separate in-process Agent instances. A future public Runtime Host/IPC layer is required for simultaneous clients to share one live processing lock, streaming event bus, stop/steering/follow-up commands, and unflushed memory state.
