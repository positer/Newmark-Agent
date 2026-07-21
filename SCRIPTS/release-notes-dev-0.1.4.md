# Newmark Agent dev-0.1.4

This prerelease improves configuration editing, Agent prompt control, model availability detection, and Linux shutdown reliability.

## Added

- General settings actions to open `~/.Newmark/config.json` with the default system application and refresh the running app from the updated file.
- A live global `~/.Newmark/agent.md` editor at the end of Models & Providers.
- A packaged Linux exit lifecycle smoke that checks clean shutdown and immediate same-root relaunch.

## Changed

- Prompt injection now normalizes and deduplicates layers in the order: intrinsic Newmark policy, global Agent baseline, workspace refinement, custom prompt, current user message.
- Saving global or workspace Agent prompts invalidates cached system prompts immediately.
- Text-usable models remain available when optional streaming, strict JSON, tools, vision, or image-output probes are unsupported; the UI reports these models as available with limited capabilities.
- Legacy cached false-negative validation records self-repair without unnecessary provider traffic.

## Fixed

- Linux tray Exit can no longer wait indefinitely during cleanup and leave a ghost process holding the single-instance lock.
- The Linux release build no longer overwrites benchmark evidence from an older release.
- Updated the vulnerable transitive `brace-expansion` lockfile entry; `npm audit` reports zero known vulnerabilities.

## Packages

- `Newmark-Agent-0.1.4-x64.msi`
- `Newmark-Agent-0.1.4-win-unpacked-x64.zip`
- `Newmark-Agent-0.1.4-x86_64.AppImage`
- `Newmark-Agent-0.1.4-amd64.deb`
- `Newmark-Agent-0.1.4-linux-unpacked-x64.zip`

These development packages are unsigned and may show an unknown-publisher warning.
