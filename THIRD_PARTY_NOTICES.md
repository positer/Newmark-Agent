# Third-Party Notices

Date: 2026-07-13

This file summarizes the current copyright and license audit for Newmark Agent.
It is not legal advice. It is an engineering record of the licenses detected in
the repository and build inputs at the time of review.

## Project Copyright

Newmark Agent first-party source code, documentation, product design, and
project-specific assets are declared as:

```text
Copyright (c) 2025 Newmark AI. All rights reserved.
```

No open-source license has been granted for the first-party project unless a
future release or repository metadata explicitly publishes one.

## Direct Desktop Dependencies

The Electron desktop package directly depends on these npm packages:

| Package | Version | License |
|---|---:|---|
| `@mozilla/readability` | 0.6.0 | Apache-2.0 |
| `cross-fetch` | 4.1.0 | MIT |
| `glob` | 7.2.3 | ISC |
| `https-proxy-agent` | 9.1.0 | MIT |
| `jsdom` | 29.1.1 | MIT |
| `jpeg-js` | 0.4.4 | BSD-3-Clause |
| `lucide-static` | 1.21.0 | ISC |
| `pngjs` | 7.0.0 | MIT |
| `@types/jsdom` | 28.0.3 | MIT |
| `@types/node` | 22.19.21 | MIT |
| `@types/pngjs` | 6.0.5 | MIT |
| `electron` | 33.4.11 | MIT |
| `electron-builder` | 25.1.8 | MIT |
| `oxlint` | 0.9.10 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |

The locked npm dependency graph currently contains 512 packages with these
detected license expressions: MIT, ISC, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, BlueOak-1.0.0, MIT-0, CC0-1.0, Python-2.0, WTFPL,
`(MIT OR CC0-1.0)`, `(WTFPL OR MIT)`, and `WTFPL OR ISC`.

## Icons And Assets

- `lucide-static` SVG icons are third-party open-source assets under ISC.
- `DESKTOP/assets/app-icon-dark.png`, `DESKTOP/assets/app-icon-light.png`,
  `DESKTOP/assets/icon.ico`, and
  `SCRIPTS/assets/newmark-agent-social-preview.png` are treated as
  project-specific Newmark Agent branding assets unless a separate source file
  states otherwise.

## Referenced Open-Source Projects

The project also contains ignored local reference/vendor material and legacy
compatibility hooks for external agent engines. These references are not the
same thing as bundled runtime dependencies.

| Project or Material | Local Evidence | Detected License / Status | Newmark Position |
|---|---|---|---|
| OpenCode (`anomalyco/opencode`) | `_vendor/opencode-dev`, `_vendor/opencode-clean/opencode-dev`, TypeScript external-engine compatibility | MIT; local license text says `Copyright (c) 2025 opencode` | Reference/vendor copy and optional external-engine compatibility. Do not publish vendored copies without preserving MIT license text. |
| OpenCode goal plugin (`willytop8/OpenCode-goal-plugin`) | `_vendor/OpenCode-goal-plugin-main/OpenCode-goal-plugin-main` | MIT; local license text says `Copyright (c) 2026 willytop8` | Reference/sample material. Do not publish vendored copies without preserving MIT license text. |
| Liquid Glass React | `_ref/Liquid Glass/extracted/liquid-glass-react-master/liquid-glass-react-master` | MIT; local license text says `Copyright 2025 MAX ROVENSKY` | Visual/reference material only. No React package copy is part of the Newmark desktop runtime. |
| Liquid Glass Studio | `_ref/Liquid Glass/extracted/liquid-glass-studio-main/liquid-glass-studio-main` | MIT; local license text says `Copyright (c) 2024 Charles Yin` | Visual/reference material only. Preserve MIT license text if published. |
| liquid-dom | `_ref/Liquid Glass/extracted/liquid-dom-master/liquid-dom-master` | Root package is private and has no root license field; one subpackage (`layout`) declares MIT, other inspected subpackages did not declare a license | Treat as uncleared reference material. Do not publish or copy substantial code before a separate upstream license review. |
| Apple Liquid Glass documentation/concept | `skills/design-taste-frontend/SKILL.md` and Flow planning prompts | Documentation/design concept reference, not a local source package | Any web implementation must be described as a glassmorphism-style approximation, not official Apple Liquid Glass or Apple-provided code. |
| Codex CLI and OpenCode CLI external tools | `DESKTOP/src/core/config.ts`, `DESKTOP/src/core/agent.ts` | External optional tools installed or detected from user environment; not bundled by the current desktop package | Users and maintainers must follow the upstream tool license when installing or redistributing those tools. |
| Alibaba page-agent (`alibaba/page-agent`), commit `fa4664dfa5379e6e91deaf85bc1db2ae14d8e1d7` | Architecture links and attribution comments in `DESKTOP/src/core/browserUse.ts`; implementation record in `archive/2026-07-13-dev-0.0.9-native-browser-use.md` | MIT; reviewed license at `https://github.com/alibaba/page-agent/blob/fa4664dfa5379e6e91deaf85bc1db2ae14d8e1d7/LICENSE`, copyright 2026 SimonLuvRamen and Alibaba Group Holding Limited | Architectural reference only for observe/action separation and explicit action results. No page-agent source, runtime, package, or vendored copy is bundled; Newmark's Browser-Use implementation is original TypeScript. Preserve this reference record and re-review upstream obligations before any future code reuse or redistribution. |

## Internal And Reference Material

The repository contains internal or ignored materials such as `archive/`,
`OVERVIEW.md`, `_ref/`, `_vendor/`, `skills/`, `Work/`, and generated
`release/` outputs. These are not automatically part of the public source
distribution. If any ignored reference, skill, or vendored material is
intentionally published later, its own upstream license and notice obligations
must be reviewed before release.

## Release Obligations

Before each public release:

1. Regenerate or refresh dependency license inventory from the lock files.
2. Include this notice file and `LICENSE` in packaged distributions.
3. Preserve third-party license text when a dependency license requires it.
4. Recheck `_vendor/`, `_ref/`, `skills/`, generated release output, and
   branding assets before publishing them.
