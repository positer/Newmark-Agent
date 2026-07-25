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
- Repeated edits of one node are siblings in the same pagination group, so the third version is `<3/3>` rather than a second nested `<2/2>`.
- Guide edit requests carry stable `clientMessageId + runId` identity through renderer, preload, main, and core. The backend resolves that identity before using the rendered index, preventing index-drift failures.

## Validation

- `npm.cmd run build` passed.
- Core verification passed with 1293 assertions and 0 failures, including cold-start hydration, immediate first-message pagination, same-node `<3/3>`, Guide-prefix preservation, Guide-tail isolation, and drifted Guide-index identity locks.
- Final Windows packaging completed for MSI, portable ZIP, and `win-unpacked`.
- Packaged Electron smoke rendered two independent `<2/2>` pagers: `start-group` at message index 0 and `guide-group` at Guide message index 1.
- Packaged ZIP and MSI smoke suites passed.
- The installed `app.asar` exactly matches the final packaged `app.asar`.
- `~/.Newmark` still contains zero history files; configuration, Work, and archive directories remain present.

## Final Artifacts

- MSI: `release/Newmark-Agent-0.1.7-x64.msi`, 128938679 bytes, SHA256 `14F3D1393B6B3714AAC9F7E3DFB3F78F38B32E50C0AF616832958FDB45320376`.
- ZIP: `release/Newmark-Agent-0.1.7-win-unpacked-x64.zip`, 167289702 bytes, SHA256 `4B84434374CA6536A29A45608769C53F91AE26EBF26A2A516775FBFA070DD5D4`.
- Packaged executable: SHA256 `91A3CC2AA89E8E5E44B5465CF70D74456089902FA54BC98790875D9DD7B840E4`.
- Packaged and installed `app.asar`: SHA256 `2C391F277C4FF89C0B2D6335195B87C9780D06CC6C31006A041A980A8F32C9D0`.
- Local installation: `C:\Program Files\Newmark Agent`, file/product version `0.1.7.0`. The temporary current-user installation was removed after formal MSI verification.
- Packaged UI evidence: `archive/20260724-dev-0.1.7-branch-guide-ui-smoke.png`.

## Cross-platform Release Assets

- AppImage: `release/Newmark-Agent-0.1.7-x86_64.AppImage`, 148146033 bytes, SHA256 `D88BDC5076651650CD744A9FF7CCEC794D1DC1970D3A09A3A61855C61EF6F5AE`.
- Debian package: `release/Newmark-Agent-0.1.7-amd64.deb`, 115191520 bytes, SHA256 `F3CB4535D2C4516EBAAEFA77D16FD0E33FF4ACF62402F1FEF8D6EEA878AE273E`.
- Linux unpacked ZIP: `release/Newmark-Agent-0.1.7-linux-unpacked-x64.zip`, 144444431 bytes, SHA256 `9643254131E76AC0D6F132A601F36C27BBD002494A8B876C9FB4732452643916`.
- AppImage, extracted Debian package, and unpacked ZIP each passed real Linux GUI startup plus isolated Bash/sh terminal round-trip smoke tests under Ubuntu 24.04 WSL.
