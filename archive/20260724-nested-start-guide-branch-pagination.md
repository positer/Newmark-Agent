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

## Validation

- `npm.cmd run build` passed.
- Core verification passed with 1289 assertions and 0 failures, including a cold-start hydration ordering lock.
- Final Windows packaging completed for MSI, portable ZIP, and `win-unpacked`.
- Packaged Electron smoke rendered two independent `<2/2>` pagers: `start-group` at message index 0 and `guide-group` at Guide message index 1.
- Packaged ZIP and MSI smoke suites passed.
- The installed `app.asar` exactly matches the final packaged `app.asar`.
- `~/.Newmark` still contains zero history files; configuration, Work, and archive directories remain present.

## Final Artifacts

- MSI: `release/Newmark-Agent-0.1.7-x64.msi`, 128922295 bytes, SHA256 `A0478CDB61B9DC198D6083C475C72D950D832F8E2D3E5189DDE76F36C05709ED`.
- ZIP: `release/Newmark-Agent-0.1.7-win-unpacked-x64.zip`, 167284836 bytes, SHA256 `120D843BF79CE7DC968B6CFBA5D617AB24174BB26E3CBD5B1BBDD083BC29C49B`.
- Packaged executable: SHA256 `823D58F41652C23BEB7E5FBF15C6D8258BC288323CA5727CC30454547E032D04`.
- Packaged and installed `app.asar`: SHA256 `FD0EF21690FAE839A447A4E4442C616AA2C8BA40891C9D6DE2020FCEFE45444E`.
- Local installation: `C:\Program Files\Newmark Agent`, file/product version `0.1.7.0`. The temporary current-user installation was removed after formal MSI verification.
- Packaged UI evidence: `archive/20260724-dev-0.1.7-branch-guide-ui-smoke.png`.

## Cross-platform Release Assets

- AppImage: `release/Newmark-Agent-0.1.7-x86_64.AppImage`, 148141721 bytes, SHA256 `0E8AD0C1E4DF782A0ED3ED2DECA68488C31B01FD681D9BC5D2BD68716A0C7FD7`.
- Debian package: `release/Newmark-Agent-0.1.7-amd64.deb`, 115184492 bytes, SHA256 `196296B8CEA00B353548C9A1023A2B314E010A7CF48198C9663372A134B6EDEE`.
- Linux unpacked ZIP: `release/Newmark-Agent-0.1.7-linux-unpacked-x64.zip`, 144440015 bytes, SHA256 `0809C7088A7D59E97F1B2A69C1E82BD57881E834A072059F2BD075F5768AEBB9`.
- AppImage, extracted Debian package, and unpacked ZIP each passed real Linux GUI startup plus isolated Bash/sh terminal round-trip smoke tests under Ubuntu 24.04 WSL.
