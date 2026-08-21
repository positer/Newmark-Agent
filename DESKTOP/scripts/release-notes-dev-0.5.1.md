# Newmark Agent dev-0.5.1

`dev-0.5.1` improves Android visual consistency and makes provider migration from a paired desktop usable for local mobile conversations.

## Highlights

- Fixed Android glass presentation at the product default level and removed the glass-strength setting.
- Added explicit provider configuration migration from a paired desktop, including the API credentials required for local Android calls.
- Preserved the existing local API key when merging a provider and repaired providers previously imported without credentials.
- Kept ordinary Remote Touch state and remote model menus credential-redacted; credential transfer occurs only during an authenticated, user-initiated import.
- Added regression coverage for fixed glass settings, credential-preserving catalog merges, authenticated export, and exact remote model selection.

## Remote Touch

Remote Touch treats a paired Android device as a trusted controller for the desktop Agent. Use it with both devices joined to the same Tailscale virtual network. Do not expose TCP port `47890` directly to the public internet.

Both desktop and Android must run `dev-0.5.1` for provider credential migration. Older desktop versions do not expose the migration endpoint.

## Release assets

- Windows x64 MSI and portable ZIP
- Linux x86_64 AppImage, amd64 deb, and unpacked ZIP
- Android APK

## SHA-256

| Asset | SHA-256 |
| --- | --- |
| `Newmark-Agent-0.5.1-x64.msi` | `9DC00D1A66BF25A22DD13079AAE49A9CD813C44DBC6FB27AEE36D8ADEE81874E` |
| `Newmark-Agent-0.5.1-win-unpacked-x64.zip` | `D16CE8A079ABE3BEF216EBF4ACD296DE54D040C973C9BACEE2DBF60905B302D8` |
| `Newmark-Agent-0.5.1-x86_64.AppImage` | `DB23F9DFD43ADF0637C0C231355C5D8CA92F7AA1A492E8867CBB9D9888EB364F` |
| `Newmark-Agent-0.5.1-amd64.deb` | `14B971376E75C363FA4105D0A8AAB15E629CFE19559500FFBE0F76DC446B97F6` |
| `Newmark-Agent-0.5.1-linux-unpacked-x64.zip` | `F7AF0AA5FEDF9989F77AD35BB6CCE1E8F79CEB675BB9AB8086A81F6DADB0004B` |
| `Newmark-Agent-0.5.1-android.apk` | `D135C113D58B7589E08C4F2A75D82D2470069A789885EE063CF6A7ECF27B8C27` |

The Windows MSI was installed machine-wide for local acceptance. Program Files reports `0.5.1`, the registry reports `0.5.1.0`, installed and packaged `app.asar` hashes match exactly, and the existing user configuration remained byte-identical.

These are prerelease builds. Back up important local data before upgrading.
