# 2026-08-01 Image Display Batch Stress

## Scope

Stress the GUI path for a large continuous sequence of Agent `image_display` results. The acceptance target was 120 distinct PNG images, 240 public Work updates, exact return order, no duplicate/lost image, correct expanded Build rendering, and correct collapsed-overview rendering with screenshot evidence.

## Finding and repair

The initial 120-image run exceeded the 180-second renderer evaluation limit. Each incoming event rebuilt the whole accumulated Build Block and embedded every prior base64 payload into `innerHTML`, producing near-quadratic serialization/parsing work.

`DESKTOP/src/ui/index.html` now renders stable image elements without base64 HTML attributes and hydrates `img.src` through DOM properties. Once a Build contains at least 12 public events, consecutive tool-call/result refreshes are coalesced to the next animation frame. Small runs keep immediate rendering behavior.

## Final result

- Verdict: PASS
- Images: 120 rendered / 120 unique / 120 expected
- Order: exact `stress-image-001` through `stress-image-120`
- Public Work updates: 240
- End-to-end renderer workload: 11,425.9 ms
- Mean update: 2.16 ms
- P95 update: 3.10 ms
- Maximum update: 46.30 ms
- Generated PNG payload: 14,608,923 bytes (13.93 MiB)
- Long tasks: 17; maximum 1,022 ms, including PNG generation/decoding and aggregate layout
- Expanded DOM: 120 images, first `001`, last `120`, activity disclosure open
- Focused regressions: `displayImageVerify` PASS; main verification 1365/1365 PASS

The test is repeatable from `DESKTOP/` with:

```powershell
npm.cmd run release:ui-image-display-stress
```

Set `NEWMARK_IMAGE_STRESS_COUNT` to change the batch size.

## Evidence

- `archive/20260801-image-display-stress-report.json`: machine-readable metrics and screenshot metadata.
- `archive/20260801-image-display-stress-expanded.png`: expanded Build activity with inline image rows.
- `archive/20260801-image-display-stress-collapsed.png`: collapsed Build overview showing returned images at its beginning.
- `archive/20260801-image-display-stress-overview.png`: 0.34-scale overview evidence.
