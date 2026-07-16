# Focus menu, durable user images, ephemeral Computer Use vision, and visual preferences

- Timestamp: 2026-07-15 00:29 +08:00 (Asia/Shanghai)
- Documentation audit amendment: 2026-07-15 01:46 +08:00 (Asia/Shanghai)
- Final source acceptance amendment: 2026-07-15 04:19 +08:00 (Asia/Shanghai)
- Release line: dev-0.0.9 follow-up maintenance
- Scope: local implementation and regression coverage only; no commit, push, tag, package publication, or installed-app replacement in this slice
- Final verification state: source implementation accepted; complete source suite, real Electron/CDP UI, real Electron Browser-Use/utility host, Windows Computer Use, and source Electron + Ubuntu WSL screenshot-lifecycle gates pass. No Computer Use screenshot was retained as evidence.

## Request and acceptance boundary

1. Clicking the workspace that already contains the focused conversation must reopen the conversation-management secondary pane. It must not issue a redundant backend workspace switch or change Focus.
2. Images intentionally submitted by the user in chat must remain revisitable after conversation switching, refresh, restart, and archive creation.
3. Image-only Guide and structured Next requests must retain their user-image attachment identity. A deferred Guide must survive checkpoint/cold reload, apply exactly once to chat/history/work-run state, and never replay on a later reload.
4. Every renderer-owned Next request and every backend queue snapshot must remain bound to `{ workspaceId, conversationId }`, including two workspaces whose conversation ID is `default`. Backend `steering`/`followUp` rows are read-only observation mirrors, not renderer-owned work, and must never be drained into a second turn.
5. Computer Use may provide the Agent a screenshot sized for the current visual task, but that frame is a one-use tool input. Its path or data must never become an explicit conversation attachment, public work event, snapshot, archive asset, or visible tool detail.
6. General settings must persist a custom main background color and local application font without allowing workspace configuration or CSS-like input to override user-level appearance.

## Root causes

- The repeated-current-workspace branch correctly avoided the expensive backend selection/reset path, but returned before reopening the renderer's left secondary pane. Once that pane was closed, clicking the active Focus-owning workspace appeared inert.
- Submitted image data reached provider history, but ordinary chat rows did not own a durable content-addressed attachment identity. Snapshot redraw, restart, compression, and archive removal could therefore lose the user's ability to revisit the image.
- Guide continuation normalization previously treated empty text as an empty continuation even when the Guide contained an image. Receipt/continuation records also needed to carry durable attachment references so a checkpoint reload could reconcile the same image identity instead of dropping or duplicating the Guide.
- The renderer's historical Next list and backend queue display shared global arrays. A delayed drain could observe a newly busy runtime or a changed foreground target after scheduling, while a stale background backend snapshot could be rebound to the currently visible workspace. Treating backend follow-up rows as editable local Next work also created a duplicate-send path after the backend had already accepted them.
- Computer Use observation was designed around temporary screenshot paths and UI Automation text. Variable-size visual assistance needed a trusted one-use bridge across direct, utility, and WSL execution without letting model-authored arguments grant retention or letting transport fields leak into persisted output.
- Theme mode existed, but the application had no shared validation/persistence contract for a solid shell background or a local UI font. Workspace-layer config also needed to be prevented from changing these personal appearance choices.

## Implementation record

### Focus-owning workspace menu

- `DESKTOP/src/ui/index.html` keeps repeated selection of the current workspace as a backend no-op, but now expands the left sidebar and its secondary conversation pane before returning.
- `DESKTOP/src/tests/workspaceMenuVerify.ts` evaluates the renderer function and verifies that the menu opens, the backend selection API is not called, and the focused conversation ID remains unchanged.
- `DESKTOP/scripts/release-ui-runtime-layout-smoke.cjs` contains the real Electron/CDP acceptance path for closing then reopening the pane from the active workspace.

### Durable user-submitted images

- `DESKTOP/src/core/conversationAttachments.ts` validates actual decoded PNG/JPEG content, enforces at most six images, 10 MiB per image, and 30 MiB total, checks declared MIME, sanitizes display names, and writes SHA-256-addressed assets atomically under `conversation-media/user-images/<prefix>/`.
- `ConversationImageAttachment` metadata travels with chat messages. `agent.ts` prepares and hydrates attachments, migrates recoverable legacy history images, lets `image_inspect` select a stable attachment ID, and copies assets to `archive/assets/user-images/` with relative links in archived Markdown.
- Guide optimistic reconciliation, loaded snapshots, edit/rewind restoration, and the structured Next queue preserve attachment objects instead of reducing them to message text.
- The renderer exposes an explicit accessible image-card gallery; opening a full-size user attachment is an intentional user action.

### Guide and Next image exactly-once lifecycle

- Guide admission prepares the submitted PNG/JPEG immediately and places its stable `ConversationImageAttachment` reference on accepted/deferred receipts, pending continuation records, and the eventual applied work-run receipt. Receipt/continuation metadata do not duplicate the content-addressed image bytes.
- Empty natural-language text no longer discards an image-only continuation. A graceful-stop checkpoint retains it; a cold worker reload hydrates the same attachment, applies one user chat row and one model-history row under the original `clientMessageId`, and consumes the continuation before a second reload can replay it.
- Snapshot redraw replaces the optimistic accepted/deferred card with the applied card by `clientMessageId`, retaining exactly one accessible image gallery instead of losing the image or rendering duplicates.
- Renderer-owned local Next records carry text, images, and the original composite target together. The delayed drain uses one in-flight transaction per target and rechecks both active target and idle state before removal/send. If the runtime becomes busy or the user switches workspaces during the delay, the original record stays queued for a later exactly-once retry.

### Composite-target queue and read-only backend mirrors

- `backendQueuesByTarget` caches backend `steering`/`followUp` snapshots by deterministic composite runtime key. Every snapshot/event call supplies its explicit owner target, so an inactive workspace A response cannot bind to the visible workspace B even when both conversations are named `default`.
- Backend follow-up entries are tagged `backendManaged` with backend provenance and rendered as read-only mirrors. Edit, delete, drag, Guide conversion, and local drain reject them; consumption is represented only by a later owner snapshot that omits them.
- Mirror reconciliation preserves equal-text occurrence multiplicity rather than collapsing records by text. An empty owner snapshot removes only that target's mirrors and leaves renderer-owned local Next entries plus every other target untouched.
- Absolute-index drag logic keeps interleaved hidden-target rows paired with their structured request objects, so reordering visible workspace A rows cannot swap or mutate workspace B text/images.

### Strictly one-use Computer Use frames

- `computer_use observe` and `app_observe` expose `capture_max_width` and `capture_max_height`. Defaults are `1280 x 960`; safe bounds are clamped to a minimum of `320 x 240` and a maximum side of 2048 pixels. Downscaling preserves aspect ratio and never enlarges the source.
- Screenshot admission is derived from trusted execution context for a validated vision model. The model-visible schema cannot enable screenshot retention.
- Direct and utility execution pass at most one temporary image into current-turn structured model input and delete it after preparation or abort. Visible/persisted tool text removes both `vision_image_path` and `vision_image_data_url`.
- The WSL host accepts only a normal PNG/JPEG file inside `%TEMP%\newmark-computer-use`, rejects symlinks and oversized files, converts it to one-use in-memory image data for the WSL worker, and immediately deletes the Windows file.
- Runtime cancellation and target cleanup delete any retained temporary paths. Computer Use images are never written to `conversation-media/` or `archive/`.

### User-level background and font preferences

- `DESKTOP/src/core/uiPreferences.ts` centralizes theme, six-digit hexadecimal background, and bounded single-font-family normalization. Quotes, URL syntax, control characters, and CSS delimiter characters are rejected.
- `ui.background_color` and `ui.font_family` are user-level configuration keys; a workspace `config.json` cannot override them.
- Electron IPC and the HTTP fallback use the same normalizers and expose the same state/save fields.
- General settings include localized labeled controls, previews, persistence, and reset actions. `--app-bg` changes the shell background; the UI font stack changes separately while `--font-mono` continues to own code and terminal text.
- Appearance is hydrated before the startup renderer reports ready, avoiding a post-promotion preference flash.

### Final integration hardening

- Queue **Guide now** no longer removes and silently reinserts a running item. It sends the original text/images/target/run ID through the immediate Guide receipt path exactly once; an unrelated draft and its attachments remain untouched.
- The WSL client validates the worker's `runtimeKey`, then rebinds path-derived workspace/conversation fields to its supervisor-owned target before main-process host-tool dispatch. Main-process target checks remain strict.
- WSL Computer Use no longer JSON-encodes a JSON-string host result a second time. The runner receives one transport object, extracts one image input, and strips the path/data URL from public tool text.
- Tool-result images from Computer Use and `image_inspect` are consumed after their first provider serialization. A later tool round sees no image, while intentionally durable user-role images remain available on every appropriate model request.
- PNG signature/IHDR dimensions are checked before `pngjs` decoding, so a tiny image declaring more than 40 megapixels is rejected before bitmap allocation.
- Persisted work-run `runtimeKey` and target fields are treated as untrusted display records. Renderer aliases accept only outer event/snapshot/send identities; kernel `snapshot`, `runtimeState`, and result boundaries clone and rebind runs, events, and Guide metadata to the normalized target.

## Data-lifecycle decision

| Visual input | Owner and purpose | Persistence | Archive behavior |
|---|---|---|---|
| User-submitted PNG/JPEG | User-authored conversation content | Content-addressed asset plus message attachment metadata; hydrated across restart | Copied to the owning archive and linked from Markdown |
| `image_inspect` derived crop | Current model turn | Structured input only; no temporary file or history entry | Never archived |
| Computer Use observe/app-observe frame | Trusted current tool invocation | One-use temporary file or WSL in-memory transfer; deleted/discarded after preparation, error, or cancellation | Never archived |
| Ordinary CDP UI acceptance screenshot | Maintainer verification evidence | Explicitly saved only by the release smoke | May be stored under `archive/` because it is not a Computer Use frame |

This separation is intentional. Durable user media must not inherit the deletion rules of automation screenshots, and automation screenshots must not inherit the archival rules of user-authored conversation content.

## Files in the implementation slice

- Core/runtime: `conversationAttachments.ts`, `types.ts`, `agent.ts`, `conversationKernel.ts`, `agentKernelRunner.ts`, `utilityHostToolRouter.ts`, `wslAgentProtocol.ts`, `main.ts`, `server.ts`, `config.ts`, `uiPreferences.ts`
- Tool surface: `tools/index.ts`, `tools/computerUse.ts`
- Renderer/config: `ui/index.html`, `config.example.json`
- Regression and acceptance: `workspaceMenuVerify.ts`, `userImagePersistenceVerify.ts`, `guideWorkRunVerify.ts`, `guideUiReconcileVerify.ts`, `queueAttachmentIsolationVerify.ts`, `visualPreferencesVerify.ts`, `computerUsePerformanceVerify.ts`, `runtimeIsolationVerify.ts`, `verify.ts`, `release-ui-runtime-layout-smoke.cjs`, `package.json`
- Documentation: `README.md`, `OVERVIEW.md`, this archive record

## Verification available at record creation

Passed during the earlier focused implementation cycle, before the final composite-queue/read-only-mirror amendment:

- `npm.cmd run build`
- `node dist/tests/workspaceMenuVerify.js`
- `node dist/tests/userImagePersistenceVerify.js`
- `node dist/tests/visualPreferencesVerify.js`
- `node dist/tests/guideWorkRunVerify.js`
- `node dist/tests/runtimeIsolationVerify.js`
- `node dist/tests/computerUsePerformanceVerify.js`

The Computer Use performance gate also observed no final temporary JPEG residue in its exercised paths.

Final integration evidence after all implementation edits:

- [x] Fresh `npm.cmd test`: exit 0 in 220.1 seconds; core `1101/1101`, dev-0.0.9 `27/27`, Browser-Use `79`, asynchronous process `21`, startup prewarm `41`, plus Guide/work-run/UI, queue/attachment, Focus, durable-image, appearance, PDF/editor/terminal/file-router, and real Windows Computer Use gates.
- [x] Fresh build: TypeScript, UI icon embedding, WSL Agent bundle, and Electron utility Agent bundle pass as part of the complete suite and the later Electron Browser-Use run.
- [x] `npm.cmd run release:ui-runtime-layout-smoke`: Focus menu preserves `default`, the secondary pane opens, the application icon resolves, background `#123456` and `Segoe UI` persist, and one durable image card renders.
- [x] Ordinary CDP images were created and visually inspected: `archive/2026-07-14-workspace-focus-menu.png`, `archive/2026-07-14-durable-user-image-ui.png`, and `archive/2026-07-14-visual-preferences.png`. They are ordinary UI evidence, not Computer Use frames.
- [x] `npm.cmd run test:browser-use-electron`: `BROWSER_USE_ELECTRON_HOST_OK assertions=59`, including real Electron utility-process isolation and force-restart behavior.
- [x] Source Electron + Ubuntu-24.04 WSL smoke: `backendPid=597`, `visionRequests=2`, `visionImages=1`, `tempResidue=0`. The WSL identity-rebind and single-string transport fixes are exercised end to end.
- [x] Final `%TEMP%\newmark-computer-use` audit: zero observe/app image files. No Computer Use screenshot content was opened, saved as evidence, or added to the archive.
- [x] Final script syntax and `git diff --check`: pass. The only test warnings are the existing jsdom `xhr-sync-worker.js` external suggestions; they do not fail a gate.

## Remaining risks and follow-up

- User-submitted images are intentionally durable local data and may outlive removal of the live conversation when copied into an archive. Backup, archive deletion, and future storage-management UI must preserve that explicit user-content lifecycle.
- A custom font must already be installed on the host. Invalid or unavailable names fall back to the built-in UI stack; remote fonts and arbitrary CSS are not supported.
- This slice validates current source and real source runtimes only. A future replacement release must rebuild and re-run the packaged Windows/Linux matrix before publishing or installing new artifacts.
- Same-user defense-in-depth remains possible for media directories: a future hardening slice can add realpath confinement, junction/symlink rejection, and pre-read `lstat` size checks for pre-existing content-addressed assets and the Computer Use temporary directory. Current count/MIME/hash/dimension limits and random one-use filenames remain enforced.
