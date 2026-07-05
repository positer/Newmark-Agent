# 2026-07-05 Computer Use Closed Loop And Workspace Uniqueness

## Scope

- Fixed the Computer Use full-desktop takeover border so it renders as a closed-loop, head-tail-connected, continuously flowing clockwise gradient instead of appearing to draw one lap and clear.
- Fixed `takeover_stop` overlay cleanup so it targets only real `-File ...takeover-overlay-*.ps1` overlay processes and does not match or terminate the caller shell.
- Enforced one workspace record per exact local folder path, while still allowing parent and child folders to be separate workspaces.
- Enforced one SSH workspace record per exact `sshConnectionId + remotePath`, while still allowing remote parent and child paths to be separate SSH workspaces.
- Updated the renderer workspace creation path to upsert matching workspace records instead of temporarily appending duplicate rows.

## Files

- `DESKTOP/src/tools/computerUse.ts`
  - Adds a double-buffered `NewmarkOverlayForm`.
  - Draws each frame to an offscreen bitmap and blits the completed frame.
  - Fills the final residual segment of the virtual-screen perimeter before presenting the frame.
  - Narrows stale overlay cleanup to actual overlay script processes.
- `DESKTOP/src/core/workspace.ts`
  - Adds canonical exact-path comparison for local workspaces.
  - Uses path-boundary checks instead of raw `startsWith` for root containment.
  - Adds canonical SSH remote-path comparison.
  - Uses SHA256-derived SSH shadow paths to avoid parent/child prefix collisions.
- `DESKTOP/src/ui/index.html`
  - Adds renderer-side workspace upsert logic keyed by exact local path or SSH connection/remote path.
- `DESKTOP/src/tests/verify.ts`
  - Adds static and behavior coverage for closed-loop overlay implementation and exact-folder workspace uniqueness.
- `README.md`
- `OVERVIEW.md`

## Verification

- `cd DESKTOP; npm.cmd test`
  - Passed with `862 passed`, `0 failed`.
- Source Computer Use lifecycle check without screenshots:
  - `computer_use takeover_start` returned `ok: true`, `mode: single-click-through-virtual-screen-overlay`, `lifecycle: owner-process-bound`, and one overlay process was observed.
  - `computer_use takeover_stop` returned `ok: true`, and the overlay process count became zero.

No Computer Use desktop screenshots were saved.
