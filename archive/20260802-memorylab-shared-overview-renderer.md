# Memory Lab shared Overview renderer

Date: 2026-08-02

## Requirement

The Memory Lab Overview opened from TUI must remain code-level identical to the GUI Overview, including the Anchor root node, root-tag edges, component nodes, physics, camera, focus modes, drag, zoom, reset, styles, and future renderer changes.

## Implementation

The standalone Memory Lab window no longer constructs a second SVG in `main.ts`. It loads the GUI `dist/ui/index.html` with the isolated `newmarkViewer=memory-overview` mode. That mode replaces the normal application shell before the hidden BrowserWindow is shown and invokes the same GUI functions:

1. `buildMemoryLabOverviewGraph`
2. `renderMemoryLabOverview`
3. `initMemoryLabOverview`
4. the existing physics, camera, focus, drag, zoom, and paint pipeline

The viewer still contains only one header and the Overview graph. It does not initialize the normal Agent/workspace renderer or display Detail, Conversations, Editor, Settings, sidebars, or other components.

## Regression boundary

Source verification rejects restoration of `viewerOverviewSvg` and requires the viewer hook to call the shared GUI graph functions. The real Electron viewer stress now requires exactly one Anchor node, all root-tag nodes, all component nodes, the expected total node count, the shared Overview SVG, graph-only DOM isolation, request consumption, and clean process teardown.

The final packaged Windows executable passed five waves of six simultaneous viewers: 30 total windows, 15 images and 15 Memory Lab Overviews, peak concurrency six, zero failures, all request files consumed, startup P50 1727.4 ms, P95 2134.1 ms, and maximum 3782.5 ms. The Memory Lab fixture contained 37 nodes: one Anchor, one root Tag, 18 components, and the remaining relationship tags. Windows MSI/ZIP/UI smokes and Linux AppImage/DEB/ZIP/GUI/exit-lifecycle smokes also passed.
