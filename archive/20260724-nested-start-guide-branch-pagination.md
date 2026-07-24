# Nested Start and Guide Branch Pagination - 2026-07-24

## Problem

Editing a Guide after the Build-start input already had pages replaced the visible branch metadata with the Guide branch. The start-input pager and its preceding conversation path then appeared lost even though parts of the tree remained persisted.

A release-blocking follow-up found that a persisted branch tree could also render without pagers on the first application load. The startup snapshot rendered messages before hydrating its branch-group metadata; a later edit or conversation refresh made the pagers appear.

## Implementation

- Conversation snapshots now expose every branch group on the active node ancestry, rather than only the most recently active group.
- Each group keeps its own source message index, selected branch, and sibling list.
- The renderer creates an independent inline `<current/total>` pager at every edited node on the active path.
- Page inspection remains read-only and does not stop or activate a runtime branch. Sending or starting a Build from an inspected page activates that branch according to the existing branch-runtime policy.
- The `<` and `>` text controls support pointer, Enter, and Space activation.
- Every snapshot rendering entrypoint now hydrates branch groups, active node, runtime node, and group identity before the first message render, including cold application startup.
- Editing a Guide resumes the copied prefix of its owning Build under the same run identity. The Guide itself is the page node: everything before it is identical across pages, while the original/edited Guide and every later message, tool event, and Build tail are page-local and cannot leak across siblings.
- The edited first message receives its message index and pager immediately when the new Build starts, rather than only after the Build completes.
- `web_fetch` and `web_search` activity rows show the concrete URL or query target beside the tool name.

## Validation

- `npm.cmd run build` passed.
- Core verification passed with 1291 assertions and 0 failures, including cold-start hydration, immediate first-message pagination, Guide-prefix preservation, and Guide-tail isolation locks.
- Final Windows packaging completed for MSI, portable ZIP, and `win-unpacked`.
- Packaged Electron smoke rendered two independent `<2/2>` pagers: `start-group` at message index 0 and `guide-group` at Guide message index 1.
- Packaged ZIP and MSI smoke suites passed.
- The installed `app.asar` exactly matches the final packaged `app.asar`.
- `~/.Newmark` still contains zero history files; configuration, Work, and archive directories remain present.

## Final Artifacts

- MSI: `release/Newmark-Agent-0.1.7-x64.msi`, 128938679 bytes, SHA256 `CE630DFB2AD8BF9A1A3B0FE6FC39B8C5568A45B23A1C2DF3A8E77403EF955459`.
- ZIP: `release/Newmark-Agent-0.1.7-win-unpacked-x64.zip`, 167286357 bytes, SHA256 `455B6E6227CA9832F8677C0827786C242A2E8903422EE0F24DF31AB5CC6CA6E6`.
- Packaged executable: SHA256 `823D58F41652C23BEB7E5FBF15C6D8258BC288323CA5727CC30454547E032D04`.
- Packaged and installed `app.asar`: SHA256 `1CE2861CB723EBD8524955513DCFB38A8BB23A82E70D334545F6030B5D1EC604`.
- Local installation: `C:\Program Files\Newmark Agent`, file/product version `0.1.7.0`. The temporary current-user installation was removed after formal MSI verification.
- Packaged UI evidence: `archive/20260724-dev-0.1.7-branch-guide-ui-smoke.png`.

## Cross-platform Release Assets

- AppImage: `release/Newmark-Agent-0.1.7-x86_64.AppImage`, 148141897 bytes, SHA256 `EF190D01003FCB529DB68FF1575624B2AAF549F2697CA174D77829180815ECC7`.
- Debian package: `release/Newmark-Agent-0.1.7-amd64.deb`, 115185744 bytes, SHA256 `6E63447942B3632415D281691A370845DF8A124DA88AFBF39408A37757C27BED`.
- Linux unpacked ZIP: `release/Newmark-Agent-0.1.7-linux-unpacked-x64.zip`, 144441168 bytes, SHA256 `9E762F2E0083E632C2271F5551A4798BF74A4620AF369FCB4DCE2FF6C310B789`.
- AppImage, extracted Debian package, and unpacked ZIP each passed real Linux GUI startup plus isolated Bash/sh terminal round-trip smoke tests under Ubuntu 24.04 WSL.
