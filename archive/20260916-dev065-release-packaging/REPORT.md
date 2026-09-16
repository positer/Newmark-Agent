# Newmark Agent dev-0.6.5 release artifacts

| Platform | Artifact | Bytes | SHA-256 |
|---|---|---:|---|
| Windows x64 | `release/Newmark-Agent-0.6.5-x64.msi` | 246759622 | `BDB85CE278CBF7767F38FE1500D94CC61F15CC6A121608ADEAF940CA1909F532` |
| Windows x64 portable | `release/Newmark-Agent-0.6.5-win-unpacked-x64.zip` | 321913900 | `8A73ECA1C84CC56A58FC59AC403CE07E312A7986A764BCFC43F76B4B16277647` |
| Linux x64 AppImage | `release/Newmark-Agent-0.6.5-x86_64.AppImage` | 217536426 | `3553EFFF50BDD71CB62DBDA67BD0A721C47C7B2342F63BEBBB7E51B994A9C7EB` |
| Linux x64 Debian | `release/Newmark-Agent-0.6.5-amd64.deb` | 167169408 | `E0B282F057B827E35C31C7DBCED53434FCC43DCB62C9B9C5B6C9613805888621` |
| Linux x64 portable | `release/Newmark-Agent-0.6.5-linux-unpacked-x64.zip` | 213279997 | `30E62286FC5BF1E7D1061D03BD823272F145E1487754B6D92B541705D2E4190A` |
| Android | `APK/Newmark-Agent-0.6.5-release.apk` | 76134350 | `E9A3967F8DDC0740023824710EF6FC7DCB5C70AA77849F2F0AC77C488A9243A8` |

Windows packaging verification passed (`dist-windows-release`), including MSI payload and portable ZIP checks. Linux packaging passed through Ubuntu 24.04 WSL using electron-builder; AppImage was verified as an x86-64 ELF and the Debian package reports `newmark-agent 0.6.5 amd64`. Android `assembleRelease` passed. Binary artifacts remain locally stored because repository `.gitignore` excludes `release/` and `/APK/`.
