# Cross-platform live thought streaming and Android identity/accessibility fixes

Date: 2026-08-21 (Asia/Shanghai)

## Acceptance scope

- Present readable provider thought content during generation on both desktop and Android instead of inserting it only after completion.
- Keep thought lifecycle, persistence, reconnect, and final-response rendering free from duplicated chunks.
- Disambiguate same-name Android model choices by their provider/deployment identity.
- Restore readable Memory Lab overview tag labels in both light and dark themes.

## Implementation boundary

Desktop Chat Completions reasoning fields and Responses API reasoning-summary deltas are normalized into `thought_delta`. The kernel emits these public deltas after creating the thought shell. The cross-process coalescer batches text and thought independently over one 16 ms window, and the renderer appends deltas to the latest incomplete thought without adding a row per token. Delta events are live transport only; the completed `thought_result` remains the durable event, so history and SSE reconnect do not replay both incremental and final content.

Android local chat now requests SSE, accumulates reasoning, text, and fragmented tool calls independently, and publishes visible state on `Dispatchers.Main.immediate`. `WorkRunProjection` consumes remote desktop `thought_delta` events with the same in-place thought semantics. Streamed answer text is temporary Build narrative; `final_response` removes that projection before the separate Agent message renders the terminal answer.

Android model menu matching now includes provider identity for local models and exact deployment identity for remote models. The first-level label uses the same matcher as the selected second-level row. Memory Lab overview labels now derive from `textPrimary`/`textSecondary`, with emphasized and ambient contrast checked against the composed node surfaces for both palettes.

## Verification

- Desktop TypeScript build: PASS.
- Desktop work-event coalescer: PASS, 7 assertions including independent thought-delta batching.
- Desktop provider bridge v2: PASS, including reasoning arriving before answer text.
- Desktop complete `verify.js`: PASS, 1663/1663 assertions.
- Android focused `ApiClientStreamTest` and `WorkRunProjectionTest`: PASS.
- Android focused `InputComposerAndModelMenuContractTest`: PASS.
- Android focused `MemoryLabAndSubagentAnimationContractTest`: PASS.
- Android final `testDebugUnitTest lintVitalRelease assembleRelease --no-daemon`: PASS in 8m 15s; 71 actionable tasks, 15 executed and 56 up-to-date.
- Release APK: `android/app/build/outputs/apk/release/app-release.apk`, 45,838,272 bytes, SHA-256 `F336EEF1CF6FE1A8B3F19945C05FCFAD94254AEFEEB9EDF6E0F5BD521A3420F5`.
- Safe `adb install -r` to `emulator-5554`: PASS. The install guard retained identical fingerprints for all 10 existing private-state files and reported `versionName=0.5.2`, `versionCode=502`.
- Installed runtime: `com.newmark.mobile/.MainActivity` is top-resumed with PID 25611; the bounded package crash/ANR scan is empty.

## Evidence boundary

The stream parsers and projections are exercised with deterministic provider event fixtures. No paid external provider request was initiated automatically, so provider-specific live cadence remains dependent on that provider emitting readable reasoning deltas; encrypted/internal reasoning is neither exposed nor reconstructed. The Memory Lab contrast gate evaluates both palettes programmatically. The attached emulator baseline had no Memory Lab tags, so it is not claimed as visual proof of populated tag labels.
