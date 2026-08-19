# Newmark Agent dev-0.4.8

Windows and Linux prerelease approved for publication.

## Highlights

- Provision-only `screen_capture` works without provisioning or starting full `computer_use`.
- Captured frames use the same content-addressed user-image input channel as submitted images.
- Stable screenshot attachment ids support `image_inspect` source inspection and 1–4x crop magnification.
- Current desktop and mobile runtime changes are included in the candidate working tree.

## Publication status

Windows local acceptance completed. Linux was built in an isolated Ubuntu 24.04 filesystem after a fresh `npm ci` and complete Linux test suite. The GitHub release is published as a prerelease with five Windows/Linux assets.

## Windows candidate artifacts

- `Newmark-Agent-0.4.8-x64.msi` — 226,277,455 bytes — SHA-256 `38FDBE8114CD00D52828711B122BB0A64FF8A859FD2500EBCCF38FA020645F4C`
- `Newmark-Agent-0.4.8-win-unpacked-x64.zip` — 292,410,673 bytes — SHA-256 `0B55DE6F80EA156A0DBDFE1B0EE45BF7F4AFE19013B56AAEA746ABC787F8300E`
- `win-unpacked/resources/app.asar` — 159,874,843 bytes — SHA-256 `39EBFDD407E8984970A9DD4F27767F1BCD9BE31745187ACF5A83B486D18D9CEA`

MSI installation completed with exit code `0`. The installed version is `0.4.8`, the installed `app.asar` hash matches the candidate, and installed-shape/shared-root restart stress passed. Local acceptance is complete.

## Linux artifacts

- `Newmark-Agent-0.4.8-x86_64.AppImage` — 176,520,042 bytes — SHA-256 `F0C2221F0EAE00533309F05DCCB28331723699AF8EBC22640554BA01CEE9DB96`
- `Newmark-Agent-0.4.8-amd64.deb` — 135,921,720 bytes — SHA-256 `8EC7A7D9B809BEB23D9144842EFDA6BA91F4D59CC6A206F0E67E91F6C01933AC`
- `Newmark-Agent-0.4.8-linux-unpacked-x64.zip` — 172,637,318 bytes — SHA-256 `C6CA2E95CCDD17D657564D572CA42BEA073D50ABB2A0C4B1D516CA030AFEBBEA`

Linux verification includes the complete platform test suite, latency benchmark, AppImage/deb/unpacked real GUI smoke, Bash/sh terminal isolation, and exit lifecycle/same-root relaunch. The installed Windows candidate remains `0.4.8` and locally accepted.
