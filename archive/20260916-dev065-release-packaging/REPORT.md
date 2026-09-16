# Newmark Agent dev-0.6.5 release artifacts

| Platform | Artifact | Bytes | SHA-256 |
|---|---|---:|---|
| Windows x64 | `release/Newmark-Agent-0.6.5-x64.msi` | 246759622 | `BDB85CE278CBF7767F38FE1500D94CC61F15CC6A121608ADEAF940CA1909F532` |
| Windows x64 portable | `release/Newmark-Agent-0.6.5-win-unpacked-x64.zip` | 321913900 | `8A73ECA1C84CC56A58FC59AC403CE07E312A7986A764BCFC43F76B4B16277647` |
| Android | `APK/Newmark-Agent-0.6.5-release.apk` | 76134350 | `E9A3967F8DDC0740023824710EF6FC7DCB5C70AA77849F2F0AC77C488A9243A8` |

Windows packaging verification passed (`dist-windows-release`), including MSI payload and portable ZIP checks. Android `assembleRelease` passed. Binary artifacts remain locally stored because repository `.gitignore` excludes `release/` and `/APK/`.
