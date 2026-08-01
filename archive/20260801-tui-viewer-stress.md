# 2026-08-01 TUI viewer stress

## Scope

Stress the independent viewer process launched by TUI image rows and Memory Lab `Overview · 示意图`. The gate writes one-use requests inside an isolated runtime root and launches the actual Electron `--newmark-viewer` mode through the same request contract used by the TUI adapter.

## Load

- Five waves.
- Three image and three Memory Lab viewers per wave.
- 30 total windows: 15 image, 15 Memory Lab Overview.
- Peak concurrency: six independent Electron viewers.

## Assertions

- Every title matched its own request; no cross-window content appeared.
- Image viewers contained one image and no Memory Lab SVG.
- Memory Lab viewers contained one `aria-label="Memory Lab Overview"` SVG with the expected 36 nodes and no image.
- Every window contained exactly one `main` and one `section`.
- No main GUI, navigation, conversation, editor, Detail, or Settings component was present.
- Every one-use JSON request was deleted after reading.
- Every exact viewer process was terminated after its wave; no stress process or request remained.

## Result

PASS with zero failures. Startup P50 was 1,943.5 ms, P95 2,118.7 ms, and maximum 2,138.7 ms.

Evidence:

- `archive/20260801-tui-viewer-stress-report.json`
- `archive/20260801-tui-image-viewer-stress.png`
- `archive/20260801-tui-memory-overview-viewer-stress.png`

Repeat from `DESKTOP/` with `npm.cmd run release:tui-viewer-stress`.
