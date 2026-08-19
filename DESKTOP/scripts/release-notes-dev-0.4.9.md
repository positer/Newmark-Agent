# Newmark Agent dev-0.4.9

Windows and Linux prerelease candidate for `dev-0.4.9`.

## Highlights

- Editing an unavailable or rate-limited model returns it to the non-terminal `discovered/degraded` untested state instead of retaining a stale unavailable lock.
- No-op provider saves and credential-only rotation preserve verified capability evidence; endpoint, protocol, and model configuration edits invalidate stale evidence deterministically.
- Balance/quota exhaustion is deployment-local, non-retryable, and switchable before stream or side-effect commitment.
- A single request can traverse the bounded three-attempt ladder A(402) → B(402) → C(success) without reusing an exhausted deployment.
- Includes the current independent provision-only screenshot, image-input, crop/magnification, remote serve-state, desktop, and mobile working-tree changes.

## Verification before packaging

- Model recovery stress: 250 edit resets, 2,000 quota routes, 500 negative classification guards, and 30 real chained three-deployment failovers.
- Auto Router: 36/36.
- Auto Agent integration: 27/27.
- Main source verification: 1,653/1,653.

## Release artifacts

- Windows MSI: `226,285,647` bytes, SHA-256 `4995625BA7E7F1876B5D74713F9E64531C44B17FBEDD76CF35F56CA323629C5F`.
- Windows win-unpacked ZIP: `292,434,383` bytes, SHA-256 `6B97CAB4E06E4D83D8D934B02635F33BC19F1E259A88AFC60E4C5090837683BC`.
- Packaged `resources/app.asar`: `159,970,904` bytes, SHA-256 `974B04DDDB77BDB5B243D1DF59BB6646799566A1F9BF9C3CE03EE885146396D0`.
- Linux AppImage: `176,536,487` bytes, SHA-256 `F9C4AAE77B0CE0F1BCAE449A1700FC425F2AC399634B87CCFED7361D9A515945`.
- Linux Debian package: `135,939,992` bytes, SHA-256 `D58D13B47C6D6915FC2DEDC72854E99585E7795B315DDEDE24244A482AFCF025`.
- Linux unpacked ZIP: `172,660,338` bytes, SHA-256 `ADB3DFA72D1BA4F95161C49C343DDA734C903D61773D288B7883F2D0D2CEACC8`.

## Windows acceptance

- Full clean Windows package chain, packaged CLI, context compression, console boundary, SSH TUI interaction/light-theme/restart, MSI, and ZIP verification passed.
- Real packaged Electron dark/light visual checks passed with transparent, left-aligned `120×30` remote status and connection controls and no text overflow.
- Unpacked and installed CLI/TUI/GUI safe-root and shared-root restart stresses passed.
- UAC MSI upgrade from `0.4.8` completed with exit `0`; installed version is `0.4.9`, help exits `0`, unknown arguments exit `2`, and installed `app.asar` matches the candidate exactly.
- Installed GUI/TUI hosted remote service completed three restart cycles with 200 pressure requests per phase and authoritative renderer/HTTP/CLI state parity.
- User `config.json` and `.newmark-mobile-token` hashes were unchanged across installation.

## Linux acceptance

- Ubuntu 24.04 WSL copied the source into an isolated Linux filesystem, installed dependencies with a fresh `npm ci`, and passed the complete platform test suite before packaging.
- Linux latency benchmark passed: hot first-event P95 `27.52 ms`, hot first-token P95 `25 ms`, cold local-before-provider `77.98 ms`.
- AppImage, deb extraction, and unpacked ZIP passed version checks and real GUI/Xvfb smoke with Bash/sh terminal isolation.
- Explicit exit and same-root relaunch left no ghost process and released the single-instance lock.
- Production dependency audit reports zero vulnerabilities.
