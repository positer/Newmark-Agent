# Newmark Agent dev-0.5.2

`dev-0.5.2` expands the Android local Agent and brings live readable thought streaming to desktop and mobile.

## Highlights

- Streams provider-authored readable thought summaries into the active Build block on desktop and Android instead of waiting for the final response.
- Connects the Android local Agent to the sandboxed terminal and expands its built-in command surface.
- Adds Android calendar creation and permission-authorized reading through the system calendar provider.
- Registers Android as a share target for text and files, routing content to a new or active local conversation or uploading it to an active remote conversation.
- Improves Android browser address completion and safe-navigation boundaries.
- Fixes same-name models from different providers being confused in the Android model picker.
- Improves Memory Lab overview tag contrast in both light and dark themes.
- Preserves clean-install provider state and authenticated provider/API migration introduced by the 0.5.x line.

## Remote Touch

Remote Touch gives a paired Android device control over the desktop Agent, including its high-privilege tools. Use it only when both devices are joined to the same trusted Tailscale virtual network. Do not expose TCP port `47890` directly to the public internet.

Desktop and Android should both run `dev-0.5.2` for the complete streaming, calendar, share-ingress, provider-identity, and terminal behavior.

## Release assets

- Windows x64 MSI and portable ZIP
- Linux x86_64 AppImage, amd64 deb, and unpacked ZIP
- Android APK

## SHA-256

| Asset | SHA-256 |
| --- | --- |
| `Newmark-Agent-0.5.2-x64.msi` | `403DBA2584D44F0496D14C76855EEE3FCA07F74E5F603AF09F98B04317C9F94F` |
| `Newmark-Agent-0.5.2-win-unpacked-x64.zip` | `50BFEAA96155177B01A3071BDCC5134199E1CC6CCBF289F6B32BB5C3F5FBD43A` |
| `Newmark-Agent-0.5.2-x86_64.AppImage` | `1AC5728A0E2A37D21D07645AF238CA306E969C4DB249CBC93FC26D71C5695D37` |
| `Newmark-Agent-0.5.2-amd64.deb` | `E913CC7E6508A76001A8B8AAB832D3D25F3C0E1E3F3F74B5859CC05756392E88` |
| `Newmark-Agent-0.5.2-linux-unpacked-x64.zip` | `0950FB7255558EA274599664F66098E10D88A154E0999869577C2E7B29CDD7C2` |
| `Newmark-Agent-0.5.2-android.apk` | `F336EEF1CF6FE1A8B3F19945C05FCFAD94254AEFEEB9EDF6E0F5BD521A3420F5` |

The Windows MSI was installed machine-wide for local acceptance. Program Files reports `0.5.2`, the registry reports `0.5.2.0`, installed and packaged `app.asar` hashes match exactly, and the existing user configuration remained byte-identical.

These are prerelease builds. Back up important local data before upgrading.
