# Newmark Agent dev-0.0.10

dev-0.0.10 turns Auto into an auditable, local, single-answer model router and strengthens the validation, startup, CLI, and provider-compatibility boundaries around it. This is an unsigned, Windows-only prerelease containing exactly the validated MSI and unpacked ZIP listed below. Linux packages were not rebuilt for dev-0.0.10: Linux users must continue using dev-0.0.9 and must not treat or relabel those assets as dev-0.0.10.

## Highlights

- Auto remains the user's selection intent across turns while each turn records one resolved `{ providerId, modelId }` deployment. Global Auto and provider-scoped Auto use the same deterministic router without crossing the selected scope.
- Routing applies enabled/subset/preview and capability constraints before scoring, then uses explicit Quality, Balanced, Cost, or Speed quality-loss bands. Unknown price is never treated as free.
- Five-minute affinity, bounded preference learning, endpoint health, circuit breaking, retry classification, `Retry-After`, and a maximum three-attempt same-scope fallback chain are recorded in a redacted `RouteDecision` audit trail.
- A provider-neutral Validation Service introduces `discovered -> basic -> standard -> extended`, six operational statuses, seven-day evidence expiry, two-of-three probe decisions, a concurrency ceiling of two, strict JSON/tool/tool-result checks, deterministic vision fixtures, and byte-level image-output validation. Standard or Extended evidence is required for Auto eligibility.
- The single opacity control now maps complementary transparency to glass width: `T=100-A`, `B=20T/100`, and blur levels `.4B/.8B/B`. Existing alpha coefficients remain unchanged and a legitimate zero persists.
- Startup creates one visible `BrowserWindow` and loads the final `index.html` directly. Its in-page startup cover remains visible until the same `webContents` acknowledges `state/rendered`; there is no hidden candidate or separate prewarm popup. First-attempt waiter recovery reuses that same `webContents` and attempt without a second page load. A required failure loads static `startup.html` in that same window, and retry returns through the same window. The critical barrier uses a local/persisted conversation snapshot and does not create a Utility/WSL conversation runtime. File tree/status/Flow/terminal start only on explicit UI demand; warning-only automation, WSL discovery, update discovery, runtime prewarm, and sidecar are delayed by 0.5/12/15/30/60 seconds respectively.
- Browser uses one demand-created `persist:newmark-browser` guest and destroys it after sixty idle seconds off-tab. A URL requested before guest `dom-ready` is retained and replayed exactly once after attachment.
- Runtime worker pools are capped at two active targets with idle LRU retirement. The generated UI icon sprite contains the 72 referenced Lucide symbols. The build also emits and packaging verifies four runtime artifacts: `windows-process-tree-helper.dll`, `typebox-compile.bundle.cjs`, `wsl-agent-host.bundle.cjs`, and `conversation-utility-host.bundle.cjs`; the DLL and TypeBox bundle are carried through `asarUnpack`.
- Direct CLI tools use closed JSON Schema validation and repeat policy checks at Utility/WSL/Electron host boundaries. The common envelope is `{ok, tool, result?, error?, route?}` with exit classes `0` success, `2` argument/schema/unknown tool, `3` policy or unavailable capability, `4` execution/semantic failure, and `130` interruption.
- Windows ComputerUse has a deterministic 1280 x 720 ten-scenario acceptance fixture. Pure CLI does not publish Electron Browser tools; Linux/WSL does not publish Windows ComputerUse.
- OpenAI-Hub's Anthropic-compatible `/v1/messages` transport was validated with exactly three explicitly authorized real POSTs: streamed text, strict `tool_use`, and a `tool_result` continuation. Ordinary tests execute only the offline contract and never spend API credit.

## Migration and compatibility

- Legacy `evaluation.status=available` becomes `validation.level=legacy_basic`; it does not silently grant Auto eligibility.
- Existing Auto preferences migrate as `default -> balanced`, `performance -> quality`, `cheap_save -> cost`, and `speed -> speed`.
- Same model names at different providers remain distinct. Cross-endpoint equivalence requires an explicit `logicalModelGroupId`.
- Mutable configuration, route profiles, validation cache, health metrics, and audit files remain under `~/.Newmark`; test and smoke commands use isolated `--root` directories.
- Preview/experimental models are excluded from Auto unless explicitly allowed. dev-0.0.10 does not add an external cloud router, online random exploration, response fusion, semantic response cache, or WebContentsView migration.

## Validation gates

From `DESKTOP/`:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run test:dev010
npm.cmd run dist:windows-release
npm.cmd run release:windows-zip-smoke
npm.cmd run release:windows-msi-smoke
npm.cmd run benchmark:dev010-startup -- --runs 20 --output ..\archive\2026-07-15-dev-0.0.10-performance.json
```

The Windows ZIP and MSI paths run `release-dev010-features-smoke.cjs` against the executable extracted from that exact artifact. The benchmark uses fresh processes, state roots, and Electron profiles, records twenty samples, and enforces the declared startup, Browser-open, four-times-CPU input-latency, and private-byte budgets. Startup-before-Browser private bytes pass at P95 `<=525 MiB` or at least 25% below the configured 696 MiB baseline. After Browser demand, total P95 must be `<=696 MiB` and the same-run incremental P95 must be `<=300 MiB`; both Browser conditions are required. It does not claim a hardware-independent cold boot because the operating-system filesystem cache is not flushed.

The formal 20-run benchmark passed every gate. Interaction P50/P95/max was `2360/3820/4066 ms`; first Browser open was `256/450/818 ms`; four-times-CPU input latency was `77.5/111.3/115.1 ms`. Startup-before-Browser private bytes were `423.59/498.74/545.31 MiB`; after Browser demand they were `488.21/554.75/587.88 MiB`; the same-run delta was `86.23/150.60/158.79 MiB`. Browser guest count remained zero throughout the first five seconds in all `20/20` runs. The authoritative samples and acceptance object are stored in `archive/2026-07-15-dev-0.0.10-performance.json`.

The real OpenAI-Hub smoke must not be rerun during ordinary release closure. Its completed three-call evidence is recorded in `archive/2026-07-15-dev-0010-cli-tool-anthropic.md`; `openAIHubAnthropicSmokeContractVerify` is the zero-network regression gate.

Current focused offline verification is: Auto Router 35/35, Agent Auto integration 24, explicit route rating 14, provider identity 10/10, Validation Service 63 plus Agent integration 13, runtime-pool capacity 16, startup/prewarm 73, CLI tool contract 32, offline OpenAI-Hub Anthropic contract 30 with `real_api_called:false`, and ComputerUse 10/10 with 100% schema validity, zero false triggers, and 100% observe-before-act. The complete `npm test` and `test:dev010` commands pass, and the real Electron BrowserUse/utility-process gate passes all 61 checks.

## Windows release assets

Judgment: `windows-prerelease-ready-for-publication`.

| Artifact | Size | SHA256 |
| --- | ---: | --- |
| `Newmark-Agent-0.0.10-win-unpacked-x64.zip` | 141729309 bytes / 135.16 MiB | `A7A2A31861AB7D49BDDE70881DB568702689B603C46381576EDB92C4010BEF35` |
| `Newmark-Agent-0.0.10-x64.msi` | 110623345 bytes / 105.50 MiB | `BC16757E1AA9E70E40B2AA21A800426FBFA24735C84532E4062D7F3409A5BD01` |

The clean ZIP extraction passes the dev008, dev009, and dev010 packaged feature smokes. The MSI administrative extraction passes its 19-check dev010 smoke with `real_api_called:false`; the standalone packaged dev010 smoke also passes all 19 offline checks. The same-window startup-recovery smoke records `startupMs=3123` and `browserOpenMs=111`. Packaged icon and runtime-layout smokes pass.

After bounded ControlView DFS, ComputerUse desktop observations are `881/874/874 ms` and application observations are `332/341/329 ms`; the CLI accuracy fixture remains 10/10 exact. The formal 20-run performance result is unchanged and remains the release performance authority: interactive P50/P95/max `2360/3820/4066 ms`, startup-before-Browser private-bytes P95 `498.74 MiB`, Browser-open P95 `450 ms`, four-times-CPU input P95 `111.3 ms`, and zero startup Browser guests.

Both dev-0.0.10 Windows artifacts are unsigned. This prerelease contains no AppImage, deb, or Linux unpacked ZIP; Linux remains on dev-0.0.9. No additional real-provider call was made during release closure. Remote-download verification and local installation are post-publication checks and are not claimed by these notes.
