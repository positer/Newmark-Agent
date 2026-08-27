# Newmark Agent dev-0.5.8

`dev-0.5.8` focuses on long-running Agent continuity, mobile context parity, bounded Android file access, Memory Lab parity, and interaction stability.

## Highlights

- Desktop and Android retry only explicitly invalid empty provider results. The five retry delays are 200 ms, 800 ms, 2 s, 10 s, and 60 s; any reasoning, visible text, or tool call immediately resets the consecutive-failure state. Silence, waiting, EOF, timeouts, and ordinary stream closure are not treated as empty responses.
- Android preserves provider-owned reasoning lifecycle and thinking tiers across tool subrounds, carries transient native reasoning checkpoints only after explicit model truncation, and keeps the cacheable request prefix byte-stable.
- Android local Agent context, Memory Lab tools and presentation now follow the desktop contracts more closely, including bounded/versioned memory mutations, stale-write rejection, archive-before-mutation, audit records, and mobile-optimized drag behavior.
- Android file discovery can expose recent documents, images, and videos through system-approved MediaStore and document-provider identities. Full shared-storage traversal and application listing remain separately gated by both in-app switches and Android system authorization.
- Rich document reads support PDF, DOC/DOCX, PPT/PPTX, CSV, and spreadsheet formats. PDF handling uses a text-layer-first fallback chain with page vision, device OCR, and LLM visual synthesis where available.
- Conversation history disclosure is immediate and motionless. Mobile menus, archive removal, liquid-float scheduling, no-ripple input, alarm routing, and cold-start conversation recovery receive focused fixes.
- Desktop terminal rendering now uses bounded buffering and frame-coalesced updates to avoid sustained Windows "not responding" behavior under heavy command output.

## Assets

- Windows x64 MSI and portable ZIP
- Linux x86_64 AppImage, amd64 Debian package, and unpacked ZIP
- Android APK

## Release Notes

- This is a prerelease development build.
- Windows binaries are not Authenticode-signed.
- The Android APK is signed with the project's Android Debug certificate and is intended for sideload testing, not store submission.
- Android unit, lint, R8, and release-build gates passed, but no physical ADB device was available for this release run.
- Linux packaged smokes ran under WSL/headless display infrastructure.
- A macOS DMG is not included because macOS packaging and signing require a native macOS host.

Rollback is performed by removing `dev-0.5.8` from distribution and returning users to the previously approved prerelease assets. User workspaces and conversation data are not migrated by this release.
