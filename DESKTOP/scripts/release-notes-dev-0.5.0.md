# Newmark Agent dev-0.5.0

`dev-0.5.0` binds Windows, Linux, and Android to one release version and one default release flow.

## Highlights

- Added Android as a first-class release target alongside Windows MSI/portable and Linux AppImage/deb/portable packages.
- Unified desktop and Android versioning through the repository `VERSION` source and strict build-time checks.
- Improved Android sidebars, predictive-back transitions, anchored input popovers, responsive conversation layout, browser readiness, uploads, local Agent tools, and Memory Lab.
- Restored the correct local provider/model catalog after returning from a remote conversation; top-level model menus show model names without redundant provider labels.
- Clean installations now begin with an empty provider list while upgrades preserve existing user providers.
- Rebuilt Memory Lab tag relationships from component metadata during reindexing.
- Improved desktop conversation switching, provider recovery, remote-touch status, and high-frequency work-event rendering.

## Remote Touch

Remote Touch is intended to run with the desktop and Android devices joined to the same Tailscale virtual network. Enable the desktop service, pair the Android client, allow TCP port 47890 in the host firewall, and do not expose the port directly to the public internet.

## Release assets

- Windows x64 MSI and portable ZIP
- Linux x86_64 AppImage, amd64 deb, and unpacked ZIP
- Android APK

These are prerelease builds. Back up important local data before upgrading.

## SHA-256

```text
065373BD2FEEB10B01E1B6BC1EF895A25DDEE9C5395D6D940A49478C63A9F385  Newmark-Agent-0.5.0-amd64.deb
E7CCC280375944DB22C389317496BBACA71F42E1CCF732CF9B307EAE9B88BBED  Newmark-Agent-0.5.0-android.apk
76235EEC398DFA16E262906515B06348AA79AB7FDC4F84A804DE08569FBCBD65  Newmark-Agent-0.5.0-linux-unpacked-x64.zip
601AEBFAA3C596A5DDC43481B78A4C12166AE97F647C58BD51A5C5A40EA055E2  Newmark-Agent-0.5.0-win-unpacked-x64.zip
33BB1C114F52DEF59E2D2C804C3ABA8FB329B562F9BE151CFF564124EFF7FC5A  Newmark-Agent-0.5.0-x64.msi
EEE37A123F82A95DB4EE69C4D3F8484BEB52547CD364539561BD2A0542AAA2CC  Newmark-Agent-0.5.0-x86_64.AppImage
```
