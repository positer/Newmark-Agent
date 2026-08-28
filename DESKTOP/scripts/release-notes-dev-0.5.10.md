# dev-0.5.10

## Highlights

- PC Electron liquid-glass renderer now invalidates geometry on a fresh backdrop texture and preserves a completed visible surface across duplicate attaches. This removes stale-frame/blank-ready states without changing the shader, colors, layout, or display logic.
- PC interaction timing preserves the complete 360 ms lift/motion phase and 180 ms landing phase before dispatching the selected command.
- Mobile liquid motion and bottom-return glass canvas updates from the 0.5.10 candidate are included.

## Validation

- PC real Electron GPU smoke: pass. One pooled WebGL2 context/program, first-frame 110 ms, 20 interaction p95 pointer-up-to-command 505 ms, no renderer errors, deformation observed.
- PC renderer call contract: pass (`textureUploads=10`, `draws=200`, one WebGL context/program, 11 isolated visible canvases).
- PC packaged UI performance smoke: pass (`renders=10`, `inputEvents=99`, max input delay 36.1 ms).
- PC settings corruption repro: pass; after five light-theme tab round trips, no white compositor plane and zero residual float/popover.
- Full desktop source/release suite: core 1673 assertions plus registered stress suites pass; SSH TUI and WSL TUI release stress pass on rerun.
- Android Release/Benchmark build: JVM tests, Vital Lint, R8 and APK assembly pass. APK v2 signature verifies with Android Debug certificate (not a store signing identity).
- Android runtime sample: Android 15 Pixel 6 AVD, Skia OpenGL ES 3.1 through NVIDIA RTX 4060. Cold launch 2313 ms; steady/limit gesture windows were captured with `dumpsys gfxinfo` and are retained in `archive/`. These are emulator GPU results, not physical-device results.

## Release assets

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `Newmark-Agent-0.5.10-x64.msi` | 226392144 | `B64DF24BEAAF3CA17135E3FC4EF1E20B09FB6CADDE7F4D14DDF679859A868525` |
| `Newmark-Agent-0.5.10-win-unpacked-x64.zip` | 292554814 | `9C7854D00045EC3F0B7D7067919D40C2FE7B749305F752FA26082772FC4E0A60` |
| `Newmark-Agent-0.5.10-x86_64.AppImage` | 176659560 | `26BCC91D27DC55DACB26EE1AF995E655F719B0E8AA6993E0817164AA984AD9F7` |
| `Newmark-Agent-0.5.10-amd64.deb` | 136039296 | `788EFE8515D97D77B1093D8A2EF189A7BE14CA230296F0D71E483BA3CFD85E70` |
| `Newmark-Agent-0.5.10-linux-unpacked-x64.zip` | 172780410 | `89D6E3B07462AC2956EFCF5E369ABFFAFE54DED4BCB5FC7FA8F6D2D644180450` |
| `Newmark-Agent-0.5.10-android.apk` | 52717704 | `3043FF20938EC752BA7B193204A1754ADD06CDC1CFD140994B2C594A1E1A6AE5` |

Windows MSI/ZIP and Linux assets are unsigned development artifacts. The APK is signed with the Android Debug certificate shown by `apksigner`; replace it with the production keystore before store distribution. macOS DMG was not built because this release was produced on a Windows host; run `npm run dist:mac` on macOS.

## Known gates and rollback

- The isolated Android `stress` variant remains blocked by its existing `minSdk 24` + Apache POI/Log4j MethodHandle D8 incompatibility; this does not affect the optimized Release/Benchmark APK build.
- The queue animation benchmark fixture did not expose its expand control in this emulator run; its report is marked failed and is not presented as a green gate.
- npm publication is pending an authenticated npm session (`npm whoami` returned 401). GitHub prerelease publication is independent and can proceed.
- Roll back by removing the prerelease/tag and serving the prior `dev-0.5.9` assets; no user data migration is included in this candidate.
