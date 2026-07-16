# dev-0.0.10 CLI tool contract, host policy, ComputerUse fixture, and OpenAI-Hub Anthropic smoke

- Timestamp: 2026-07-15 16:20 +08:00 (Asia/Shanghai)
- Release line: dev-0.0.10 source implementation
- Scope: CLI/direct tools, tool-schema validation, runtime host capability filtering, host-side policy revalidation, deterministic Windows ComputerUse acceptance, and an opt-in real OpenAI-Hub Anthropic compatibility smoke
- Out of scope: `agent.ts`, `config.ts`, renderer/UI, release packaging, commit, push, tag, or publication

## Acceptance boundary

1. Direct CLI tool calls must use the same closed JSON Schema contract published to models. Malformed JSON, missing required properties, wrong types, unknown enum values, and undeclared fields fail before any side effect.
2. `--mode` must be applied before both `send` and direct `tool` execution. A Plan-mode direct mutation must be denied before the tool runs.
3. A runtime publishes only tools its current host can execute: pure CLI hides Electron Browser tools; Linux/WSL hides Windows ComputerUse; an Electron-managed WSL runtime may retain target-bound Browser-Use while still hiding ComputerUse.
4. Utility/WSL forwarding is not a trust boundary. The receiving/forwarding host repeats ToolPolicy evaluation before native ComputerUse, Browser-Use, automation, or terminal execution.
5. CLI direct tools return one JSON envelope: `{ ok, tool, result?, error?, route? }`. Exit codes are `0` success, `2` argument/schema/unknown tool, `3` policy denial or unavailable host capability, `4` execution failure or a syntactically valid tool response whose own `ok` is false, and `130` abort.
6. Windows ComputerUse must pass a controlled local 1280 x 720, 10-scenario exact-target fixture with at least 9/10 exact matches, 100% schema/result checks, zero false triggers, and 100% observe-before-act.
7. The real OpenAI-Hub test is opt-in, reads and trims `_ref/OpenAI-hub key.txt`, uses an independent `--root`, performs at most three POSTs per invocation, and never prints/writes the key, request authorization, full response, or tool arguments.

## Implementation record

### Closed tool schemas and compile-on-first-use validation

- `DESKTOP/src/core/toolArgumentValidator.ts` recursively closes object schemas that declare `properties`, while deliberately leaving free-form objects such as raw CDP `params` open.
- `ToolArgumentValidatorRegistry` registers schema signatures cheaply and compiles each distinct tool schema only on its first execution. This keeps startup/prewarm overhead bounded while avoiding repeated compilation.
- `ToolExecutor.execute` no longer converts malformed JSON into `{}`. It parses an object, resolves the host-visible definition, validates the arguments, evaluates ToolPolicy, checks workspace access, and only then dispatches the implementation.
- Nested ComputerUse sequence-step objects are closed as well as the top-level tool object.
- `normalizeToolResult` now recognizes a JSON tool result with `ok:false` as an unsuccessful result rather than treating every JSON string as success.

### CLI contract and host-filtered catalog

- `DESKTOP/src/cli-commands.ts` configures a pure CLI host profile before publishing state/tools.
- `tool --list --mode <mode>` emits the canonical host- and mode-filtered tool catalog in the common envelope.
- Direct `tool` and `send` both apply a validated `--mode` before work begins.
- Direct results are normalized to the common JSON envelope and the five exit classes. JSON semantic failures such as ComputerUse returning `ok:false` map to exit `4`.
- `wsl-agent-host.ts` publishes Electron Browser capability only because it is supervisor-managed, while hiding Windows ComputerUse. `conversation-utility-host.ts` publishes the Electron Browser and only enables ComputerUse on Windows.

### Secondary host policy

- `wslHostToolBridge.ts` re-evaluates policy before writing a host request. Automation is checked under its nested tool name/payload, and legacy browser-control actions are mapped back to their public tool names.
- `utilityHostToolRouter.ts` repeats policy and Native Tools enablement checks before browser, automation, terminal, or ComputerUse side effects. Plan-mode ComputerUse click is denied; Plan-mode observation remains available.
- WSL ComputerUse and terminal requests now carry the active mode in trusted host context.

### 1280 x 720 ComputerUse acceptance fixture

- `DESKTOP/scripts/fixtures/computer-use-1280x720.ps1` creates a fixed 1280 x 720 WinForms client surface containing ten uniquely named accessible targets plus non-action decoy text.
- `cliComputerUseAccuracyVerify.ts` discovers the fixture through `app_list`, performs a fresh `app_observe` before every target action, resolves only exact accessible labels, and uses dry-run clicks so the acceptance does not alter user state.
- Final result: exact match `10/10`, schema accuracy `100%`, false trigger count `0`, observe-before-act `100%`.

### OpenAI-Hub native Anthropic smoke

- Official OpenAI-Hub documentation confirms native Claude-format `POST /v1/messages`, the required `anthropic-version` header, and `tools`/`input_schema`/`tool_choice`: <https://docs.openai-hub.com/api-447800612>.
- `DESKTOP/scripts/real-openai-hub-anthropic-smoke.cjs` is guarded by `NEWMARK_RUN_REAL_OPENAI_HUB=1` or `--run`, caps POST count at three, and uses `claude-sonnet-4-5` by default to match the service's documented native-Claude example. Base URL/model/key-file remain explicit environment/argument overrides.
- POST 1 validates Anthropic SSE text deltas plus `message_stop` using a unique marker.
- POST 2 forces one `echo_marker` tool under `strict:true` with a closed schema and validates an Anthropic `tool_use` id/name/input entirely in memory.
- POST 3 sends the complete assistant content plus matching `tool_result`, re-declares the same tool because each HTTP request is stateless, and validates a second streamed marker.
- Logs contain only step, status, bounded request ID, and a redacted error category. No response body, tool input, API key, or authorization data is persisted.
- During development, the first invocation stopped after two POSTs because the initial Opus route did not return a valid tool block. A second invocation proved strict tool use but correctly surfaced a 400 continuation caused by omitting the stateless request's tool declaration. The final corrected invocation used exactly three POSTs and returned `200 / 200 / 200`, `summary=passed`.
- All three explicit temporary roots were verified under `%TEMP%` and removed; no response/key artifact remains.

## Files in this slice

- Core/tool: `DESKTOP/src/core/toolArgumentValidator.ts`, `DESKTOP/src/core/toolPolicy.ts` (read-only reference), `DESKTOP/src/core/wslHostToolBridge.ts`, `DESKTOP/src/core/utilityHostToolRouter.ts`, `DESKTOP/src/core/compat.ts`, `DESKTOP/src/tools/index.ts`
- Runtime/CLI: `DESKTOP/src/cli-commands.ts`, `DESKTOP/src/wsl-agent-host.ts`, `DESKTOP/src/conversation-utility-host.ts`
- Tests/fixtures: `DESKTOP/src/tests/cliToolContractVerify.ts`, `DESKTOP/src/tests/cliComputerUseAccuracyVerify.ts`, `DESKTOP/src/tests/openAIHubAnthropicSmokeContractVerify.ts`, `DESKTOP/src/tests/verify.ts`, `DESKTOP/scripts/fixtures/computer-use-1280x720.ps1`
- Opt-in real test: `DESKTOP/scripts/real-openai-hub-anthropic-smoke.cjs`
- Registration/docs: `DESKTOP/package.json`, `README.md`, `OVERVIEW.md`, this archive record

## Verification

- [x] `npx.cmd tsc --noEmit` — exit 0.
- [x] `npm.cmd run build` — TypeScript, UI icons, WSL host bundle, and Electron utility host bundle pass; only existing jsdom `xhr-sync-worker.js` bundler warnings remain.
- [x] `node dist/tests/cliToolContractVerify.js` — `{ "ok": true, "assertions": 32 }`.
- [x] `node dist/tests/openAIHubAnthropicSmokeContractVerify.js` — `{ "ok": true, "assertions": 14, "real_api_called": false }`.
- [x] `node dist/tests/cliComputerUseAccuracyVerify.js` — 10/10 exact, 100% schema, 0 false triggers, 100% observe-before-act.
- [x] Opt-in real OpenAI-Hub test with an independent `--root` — stream marker 200, strict tool use 200, tool-result marker 200, summary passed.
- [x] Opt-out invocation — reports `skipped` and performs zero requests.
- [x] Final registered gate `npm.cmd run test:cli-tools` — exit 0 in 127.4 seconds after a fresh build; all three local suites passed in sequence and no real API request was made by the test command.
- [!] A broader `node dist/tests/verify.js` attempt was already red before reaching this CLI section because concurrent dev-0.0.10 routing/prewarm changes left four source-string assertions stale and the WSL cleanup fixture refused an unverified pid/pgid/session identity. The direct CLI/Host contract is covered independently above; full shared-suite closure belongs to the integrating release pass.

## Remaining risk

- A gateway may accept the Anthropic transport while a particular routed model/provider combination does not honor forced tool use. The smoke therefore treats response-shape/tool-input validation as authoritative and never accepts HTTP 200 alone.
- The WinForms/UIA fixture is a Windows integration gate. Non-Windows runs skip it; platform catalog tests still prove that unsupported Windows ComputerUse is not advertised.
- Full package/installed-app acceptance remains a separate release step for dev-0.0.10.

## 2026-07-16 offline integration update

The 14-assertion offline Anthropic contract and broader-suite warning above are historical results from the initial CLI slice. The integrated zero-network contract now passes 30 assertions with `real_api_called:false`; it additionally locks the strict SSE state machine, exact `tool_use`, closed schema, and correlated `tool_result` continuation. `cliToolContractVerify` remains 32 assertions, and the Windows fixture remains 10/10 exact with 100% schema validity, zero false triggers, and 100% observe-before-act.

These gates are registered in the central `npm test` and `test:dev010` commands. The completed real-provider evidence remains exactly the previously authorized three final POSTs at `200 / 200 / 200`; this integration update made no additional real API request and must not be used as authority to rerun that smoke. Fresh ZIP/MSI acceptance remains separate.
