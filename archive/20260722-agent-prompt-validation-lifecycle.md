# Agent Prompt, Validation Lifecycle, Build Folding, and DeepSeek Availability

Date: 2026-07-22 (Asia/Shanghai)

## Scope

- Apply Newmark-native styling to the global `Agent.md` editor.
- Register the missing model-validation progress note in English and Chinese.
- Ensure repeated Validate clicks attach to one background validation task.
- Preserve manual Build block collapse after force stop.
- Repair false unavailable status when base text use is already proven.

## Implementation

- Added `.newmark-prompt-textarea` using existing semantic theme tokens.
- Added `model.validationBackgroundNote` to both locale dictionaries.
- Added a shared Agent validation promise, IPC status exposure, and renderer promise reuse/progress reopening.
- Terminal work-run updates set the default expanded state only when no explicit user state exists.
- A non-empty nonce mismatch is degraded text compatibility evidence. Persisted `text_input`/`text_output` evidence repairs an `unavailable` aggregate for fixed, default, and Auto selection; authentication and explicit invalid configuration remain blocking.

## Verification

- `npm.cmd run typecheck`: passed.
- Model validation verification: `71` assertions passed.
- Model validation Agent integration: `18` assertions passed, including concurrent callers sharing one provider workflow.
- Guide/Build reconciliation and dev-0.0.9 runtime/folding compatibility gates passed.
- Main verifier: `1231/1231` assertions passed.
- Complete `npm.cmd test`: passed, including runtime isolation, queue/Guide, Browser Use, process lifecycle, Auto routing, provider identity, model validation, CLI contracts, and the deterministic Windows Computer Use fixture.
- Rebuilt Windows MSI and unpacked ZIP passed packaged CLI, model-settings UI CRUD, and MSI asset smokes. UAC installation completed with `install=0`; installed `C:\Program Files\Newmark Agent\resources\app.asar` matches the rebuilt package hash `9F655B363D7476D157BB45458936A8E90F15431CCE547D0D60B7E7048895684F`. Installed registry version is `0.1.4.0`, and the installed executable launched successfully for a runtime check.
- A read-only check against the real `~/.Newmark/config.json` confirmed both DeepSeek and OpenAI-Hub `deepseek-v4-pro` deployments remain stored with the historical raw `unavailable` record but are now usable for fixed selection and exposed to Auto as `degraded`.
- `git diff --check`: passed.
