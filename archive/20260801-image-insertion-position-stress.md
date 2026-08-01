# 2026-08-01 GUI/TUI Image Insertion Position Stress

## Scope

Verify the insertion position of Agent-returned images inside GUI and TUI Build Blocks. The fixture interleaves 24 image calls with 24 Bash calls and 24 progress boundaries so an image cannot pass merely by being appended somewhere in the Build.

## GUI acceptance

- 24/24 images rendered and 24/24 IDs were unique.
- Exact collapsed order was `position-image-001` through `position-image-024`.
- The collapsed image gallery was the Build surface's immediate next sibling, before other collapsed overview content.
- Expanded DOM contained 24 tool groups. Every image button belonged to its own `Ran image_display` activity row and that row immediately followed the group's `Ran bash` row.
- Twenty consecutive expand/collapse cycles retained exactly 24 images without duplication, loss, or reordering.

## TUI acceptance

- Expanded order for every image was `TOOL image_display → [示意图] → RESULT image_display → POSITION CHECKPOINT`.
- Collapsed order was `Build Block header → 24 ordered [示意图] rows → final summary`; expanded tool/result rows were absent.
- Geometry passed at `80×24`, `100×30`, `120×40`, and `160×50`: exact output row count and exact visible width on every row.
- Unfocused image rows expose no `Enter 打开` text. With the first image selected, the hint appears exactly once on that row and remains visible within the terminal width.

## Result

Verdict: PASS. No product placement defect was found. The first GUI failure was a test-selector issue: the visible command row intentionally labels the preceding activity as `Ran bash` without exposing its arguments. The corrected assertion uses group adjacency plus independent image-ID order verification.

Repeat from `DESKTOP/`:

```powershell
npm.cmd run release:image-insertion-position-stress
```

Evidence:

- `archive/20260801-image-position-stress-report.json`
- `archive/20260801-image-position-gui-expanded.png`
- `archive/20260801-image-position-gui-collapsed.png`
- `archive/20260801-image-position-tui-expanded-collapsed.png`
