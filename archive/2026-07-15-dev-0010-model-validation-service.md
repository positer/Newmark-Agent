# dev-0.0.10 Unified Model Validation Service

Date: 2026-07-15

## Scope

Added a provider-neutral, independently integrable validation core. The change intentionally does not modify the current `Agent.validateModels()`, provider configuration, package scripts, or UI while those files are under parallel dev-0.0.10 work.

## Added files

- `DESKTOP/src/core/modelValidation.ts`
  - Validation levels: `discovered`, `basic`, `standard`, `extended`.
  - Validation statuses: `verified`, `degraded`, `unavailable`, `auth_error`, `rate_limited`, `invalid_config`.
  - Seven-day evidence TTL and level-aware cache reuse.
  - Two samples for a stable outcome; a third sample only on a split; two-of-three majority.
  - Hard validation concurrency ceiling of two.
  - Permanent authentication/configuration failure short-circuiting, including failures returned by an adapter or thrown as typed errors.
  - Separately schedulable `validateHealth()` and `validateCapabilities()` phases plus a composed `validate()` flow.
  - Standard probes for text nonce, streaming completion/content, strict JSON, correct tool selection, unknown-tool exclusion, schema adherence, tool-result consumption, and vision when declared.
  - Extended image-output probe with encoded-byte, detected/declared MIME, structural, byte-limit, and dimension validation for PNG, JPEG, GIF, and WebP.
  - Tool failure taxonomy: `InvalidJson`, `UnknownName`, `SchemaMismatch`, `PolicyDenied`, `ExecutionFailed`, `PostconditionFailed`.
  - Recursive audit redaction for credentials, bearer tokens, URL user info, configured secrets, binary payloads, errors, and cycles.
- `DESKTOP/src/tests/modelValidationVerify.ts`
  - Standalone behavioral verification of the state machine, sampling, retries, concurrency, TTL/cache, probe orchestration, health/capability isolation, image validation, tool taxonomy, and audit redaction.

## Verification

Test-first evidence:

- Initial contract failed because `../core/modelValidation` did not exist.
- Returned permanent-status regression failed with two attempts instead of one before the short-circuit fix.
- Permanent-health fan-out regression failed with two text calls instead of zero before phase short-circuiting.

Green checks:

```powershell
cd DESKTOP
.\node_modules\.bin\tsc.cmd --target ES2022 --module Node16 --moduleResolution Node16 --lib ES2022,DOM,DOM.Iterable --strict --esModuleInterop --skipLibCheck --outDir .tmp-model-validation --rootDir src src\core\modelValidation.ts src\tests\modelValidationVerify.ts
node .tmp-model-validation\tests\modelValidationVerify.js
```

Result: `model validation verification passed (55 assertions)`.

```powershell
.\node_modules\.bin\oxlint.cmd src\core\modelValidation.ts src\tests\modelValidationVerify.ts
```

Result: zero warnings and zero errors.

The current whole-worktree typecheck is temporarily blocked by parallel `autoAgentIntegrationVerify.ts` references to Agent integration members that are not yet present. The isolated module/test typecheck passes.

## Mainline integration points

1. Adapt `LLMProvider` operations to `ModelValidationProbeAdapter`; adapters must return actual observed protocol results, not name-based capability inference.
2. Replace or wrap `Agent.validateModels()` with `ModelValidationService.validate()` and persist `ModelValidationRecord` separately from the legacy summary fields during migration.
3. Schedule provider health independently from capability validation; retain capability evidence across a permanent health failure and use the seven-day capability TTL.
4. Map the six validation statuses in CLI/API/UI and expose validation level plus force-refresh controls.
5. Add `modelValidationVerify.js` to the central test command only after the parallel package/test-aggregator changes converge.

## 2026-07-16 integration update

The scope and 55-assertion result above are the historical record of the initially independent validation slice. Mainline integration is now present:

- `Agent.validateModels()` uses the shared validation adapter/service path and persists Standard/Extended evidence separately from legacy evaluation metadata.
- OpenAI Chat, OpenAI Responses, and Anthropic protocol-specific streaming, strict-JSON, tool, tool-result, and declared vision evidence are exercised through the Agent integration adapter.
- Fresh seven-day evidence is reused, legacy `available` migrates only to `legacy_basic`, and a model enters Auto only after Standard validation succeeds.
- `modelValidationVerify` is registered in `npm test`, `test:model-validation`, and `test:dev010`; its current result is 63 assertions.
- `modelValidationAgentIntegrationVerify` is also registered and currently passes 13 assertions.

The earlier temporary whole-worktree blocker and five pending integration points are therefore closed at source level. Fresh artifact-specific and release performance gates remain tracked only in the integration acceptance ledger.
