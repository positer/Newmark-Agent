# Newmark Agent dev-0.1.0

Development prerelease focused on Linux and WSL responsiveness without changing provider behavior, session isolation, or the `~/.Newmark` state-root contract.

## Highlights

- Segmented opt-in latency diagnostics and a 20-run local streaming Linux benchmark.
- Coalesced conversation persistence with forced flush at user, tool, completion, error, and exit boundaries.
- Cached stable system prompt, skills summary, and tool definitions with targeted invalidation.
- Request-scoped task focus keeps the latest user instruction authoritative while retaining explicitly unfinished Goal/plan continuity when required; user-authored text remains in the user role.
- Context compression no longer permanently pins the first historical task, separates active/unfinished work from completed or superseded background, and emits a one-time continuation anchor so the pre-compression active task resumes immediately.
- Memory Lab update/reindex now blocks Agent completion until deterministic index rebuild and read-back verification return a completed receipt; its success appears only inside the owning Build block as `更新了记忆` / `Updated memory`.
- Content-hash WSL host caching, single-flight startup, runtime prewarming, and interactive UI promotion independent of WSL readiness.
- Next queue automatically drains after terminal agent work events while preserving target isolation.
- Fenced Markdown code blocks use language-aware syntax highlighting; inline code rendering is unchanged.
- Light-mode modal glass remains transparent but gains a bright readable glow.
- Running Build tool details stay expanded across live work-event and duration refreshes.

## Validation

Typecheck, lint, performance/cache/runtime isolation tests, source WSL backend smoke, queue/plan UI smoke, visual preferences verification, and local latency benchmark pass. Package hashes and downloaded GitHub asset verification are recorded in the release archive after publication.
