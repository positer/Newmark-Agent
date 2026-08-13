# Newmark Agent `dev-0.3.13`

This is the next development-version candidate after `dev-0.3.12`. The source package metadata now reports `0.3.13`; the previous `dev-0.3.12` package remains the last verified published artifact until the new package gate is run.

## Included

- Built-in editor Copilot prediction optimization from commit `345e7ef`: bounded cursor context, dedicated completion streaming, usable-model filtering, immediate cancellation, short-lived anchor caching, quiet empty results, and caret-only rendering.
- The existing `dev-0.3.12` Flow lifecycle, archive interruption, installation-root recovery, GUI/TUI/CLI shared-backend, and release-gate repairs remain in the source baseline.

## Version boundary

- `DESKTOP/package.json` and `DESKTOP/package-lock.json` declare `0.3.13`.
- The console-wrapper release gate reports `version=0.3.13`.
- No `dev-0.3.13` MSI, portable archive, global UAC installation, Git tag, or remote publication was performed by this version-bump change.
- Rebuild and rerun the full release gates before treating `dev-0.3.13` as publishable.
