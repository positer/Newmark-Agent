# Newmark Agent dev-0.4.4

Prerelease build. Source `dev-0.4.4` — Windows MSI/ZIP and Linux AppImage/deb/unpacked ZIP.

## Changes

### Agent prompt: proactive historical Build reuse
- Non-first Build blocks are now instructed to call `build_history_query` **before re-investigating** when the current task continues, fixes, verifies, or depends on earlier work, reusing the returned tool activity/results instead of re-running commands or re-reading files.
- Read-only boundary is preserved: querying history never authorizes resuming a task, and completion status already exposed by the prompt does not need a query.

### TUI model long-menu cursor follow
- **Root cause**: the TUI painted on the primary screen, keeping scrollback — the mouse wheel could scroll back to old frames and terminal scroll displaced the `2J` repaint, making the highlight appear to leave the screen.
- Entered the **alternate screen buffer** (`?1049h`) on startup and restore the primary screen on quit (`?1049l`, synchronous `fs.writeSync` so the exit message is never dropped).
- Enabled Windows `ENABLE_VIRTUAL_TERMINAL_PROCESSING` on the output handle for the real `Newmark --TUI` entrypoint (Electron `Console Runtime` → `ELECTRON_RUN_AS_NODE` sidecar), which previously did not enable VT like pure Node does.
- Content views scroll with a centered follow so the focused model option keeps both its label and description on screen; frames are strictly bounded to the live window size and read the live terminal size on every render.
- Added a featureless `--demo` PTY gate (`cursor-follow-pty-gate.js`) wired into `test:tui:built`: three window combos + live resize adaptation + alternate-screen/quit assertions.

### Model-switch behavior (GUI)
- `agent:setModel` now compares the resolved qualified deployment (or `auto`) instead of the bare name, so switching between two same-named models on different providers is recognized as a real change.
- A running Build keeps its model until the next Guide/Next re-enters it; the newly selected model is recorded as pending and applied on the next dequeue. Electron and WSL runtime pools/clients/hosts all carry the `set_model` method.
- The context ring/inspector refreshes immediately after a model switch.

## Artifacts (SHA-256)

- `Newmark-Agent-0.4.4-x64.msi` — `BC9B0E2F27767310EC76B781834E42A61482DB6BEE4E336C86D9D2D3A0E4A41B`
- `Newmark-Agent-0.4.4-win-unpacked-x64.zip` — `458C980FA5347038ACB4B49CDBBE62A8E42BAC6AABA709FAA7AF5B9BA468C3B6`
- `Newmark-Agent-0.4.4-x86_64.AppImage` — `BE5533B390CFBBACBB3653E6EB9844A6B4D0D40EE6E3C202763C559983D2CD7D`
- `Newmark-Agent-0.4.4-amd64.deb` — `DCE3F0F5C13407DC9F93E603888DEF852492403D4B40B08617E1B434CF5A33F0`
- `Newmark-Agent-0.4.4-linux-unpacked-x64.zip` — `92028B738C0D835795E0E3391086ED2C86D5F657AC887A2C83CEEF813F92017A`

## Note

If `Newmark --TUI` appears unchanged after install, verify the command resolves to the installed build:

```
where Newmark
```

It must point to `C:\Program Files\Newmark Agent\Newmark.exe`. A global npm `newmark-agent` (0.2.1) previously shadowed this path and was the actual cause of "no change" reports.
