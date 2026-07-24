# Nested Start and Guide Branch Pagination - 2026-07-24

## Problem

Editing a Guide after the Build-start input already had pages replaced the visible branch metadata with the Guide branch. The start-input pager and its preceding conversation path then appeared lost even though parts of the tree remained persisted.

## Implementation

- Conversation snapshots now expose every branch group on the active node ancestry, rather than only the most recently active group.
- Each group keeps its own source message index, selected branch, and sibling list.
- The renderer creates an independent inline `<current/total>` pager at every edited node on the active path.
- Page inspection remains read-only and does not stop or activate a runtime branch. Sending or starting a Build from an inspected page activates that branch according to the existing branch-runtime policy.
- The `<` and `>` text controls support pointer, Enter, and Space activation.

## Validation

- `npm.cmd run build` passed.
- Core verification passed with 1288 assertions and 0 failures.
- Final Windows packaging completed for MSI, portable ZIP, and `win-unpacked`.
- Packaged Electron smoke rendered two independent `<2/2>` pagers: `start-group` at message index 0 and `guide-group` at Guide message index 1.
- Packaged ZIP and MSI smoke suites passed.
- The installed `app.asar` exactly matches the final packaged `app.asar`.
- `~/.Newmark` still contains zero history files; configuration, Work, and archive directories remain present.

## Final Artifacts

- MSI: `release/Newmark-Agent-0.1.7-x64.msi`, 128938679 bytes, SHA256 `BCDCB75565C4BE47D956722F1445B161D5831DB7BE1D263F9FABC3D8833356B4`.
- ZIP: `release/Newmark-Agent-0.1.7-win-unpacked-x64.zip`, 167284620 bytes, SHA256 `156E90FE155290AF434F0264B415A22669F78DF4992096F739F6C7114F3619EE`.
- Packaged executable: SHA256 `823D58F41652C23BEB7E5FBF15C6D8258BC288323CA5727CC30454547E032D04`.
- Packaged and installed `app.asar`: SHA256 `8417542238AAAE9CDA6C329D809E8E03286F968F5B66DC8573621FAB2BB84783`.
- Local installation: `C:\Program Files\Newmark Agent`, file/product version `0.1.7.0`. The temporary current-user installation was removed after formal MSI verification.
- Packaged UI evidence: `archive/20260724-dev-0.1.7-branch-guide-ui-smoke.png`.

## Cross-platform Release Assets

- AppImage: `release/Newmark-Agent-0.1.7-x86_64.AppImage`, 148141712 bytes, SHA256 `48864F13648D6E3E0593AAE6D24035D88BAAFA81177BD2FC1875B0EB352BA4ED`.
- Debian package: `release/Newmark-Agent-0.1.7-amd64.deb`, 115184268 bytes, SHA256 `7A22569D4EDB9206BB8E433770E1A8A4B6A512DA04CCF9A2543E3031D4ACED35`.
- Linux unpacked ZIP: `release/Newmark-Agent-0.1.7-linux-unpacked-x64.zip`, 144439658 bytes, SHA256 `C3A51873930EA1DE8FD29E29D00D79F02BFD94EE81A98761532D18BE4907C9EC`.
- AppImage, extracted Debian package, and unpacked ZIP each passed real Linux GUI startup plus isolated Bash/sh terminal round-trip smoke tests under Ubuntu 24.04 WSL.
