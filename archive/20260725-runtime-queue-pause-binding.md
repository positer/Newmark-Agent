# Runtime Queue Pause and Binding - 2026-07-25

## Requirement

- Queue, Next, and Goal remain bound to the running conversation branch even while another branch is viewed.
- A pause control sits immediately left of the Queue expand control and stops injection without deleting queued work.
- Activating a different running branch rebinds the complete queue as one unit to that branch.

## Implementation

- Added runtime-target keyed queue pause state and localized pause/resume UI.
- Queue draining and scheduled draining both reject injection while paused and preserve all entries.
- Explicit Stop and Force Stop pause the target queue and cancel pending injection scheduling without deleting queued work.
- Branch activation and state hydration atomically rewrite matching queue request paths to the persisted runtime node path.
- Runtime snapshot identity remains distinct from the persisted viewed branch path.
- Memory Lab model updates receive the existing tag DAG and deterministically preserve established parent paths.

## Verification

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `node dist/tests/queueAttachmentIsolationVerify.js`: passed, including pause and atomic rebind cases.
- `node dist/tests/verify.js`: 1308 passed, 0 failed.
