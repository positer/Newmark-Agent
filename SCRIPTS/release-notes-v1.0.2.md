# Newmark Agent v1.0.2

Newmark Agent v1.0.2 is a visual packaging update for the local-first desktop Agent terminal.

## Download

- `Newmark-Agent-1.0.2-portable-x64.exe`
- SHA256: `883F840FB9AD9ED238CF1DEB421C038E94E8A1EF56BBECF93EF055BA560C0084`

## Highlights

- Added high-contrast dark and light application icon assets.
- Added a generated Windows `icon.ico` for portable executable packaging.
- Runtime windows and tray rendering now use themed icon assets.
- The frameless desktop UI now renders the application icon in the custom titlebar.
- The custom titlebar icon includes a runtime-verified animated color border.
- Packaging verification confirms icon assets are included in `app.asar`.

## Status

Release judgment: `release-usable-with-operational-risks`.

The v1.0.1 functional release validation baseline remains in force; this patch changes public branding/package icon assets, custom titlebar icon rendering, and related checks. `release:ui-icon-smoke` validates the packaged renderer icon decode path and animated color border through Electron CDP.
