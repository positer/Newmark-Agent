# Foundational tool surface and on-demand advanced provisioning

Date: 2026-08-18

Release target: `dev-0.4.7` (`Newmark Agent dev-0.4.7`)

## Problem

Agents intermittently reported that `read` and `bash` were unavailable. The tools were enabled in configuration, but the adaptive exposure path did not guarantee their complete schemas on the first provider turn. Conversely, orchestration schemas could be preloaded even when the current request did not need them. A conversational or misclassified turn could therefore receive the broker and control capabilities without the basic workspace primitives.

## Implemented contract

The initial provider tool surface is deterministic and contains the complete schemas for exactly these foundational tools, after policy filtering:

```text
bash
pwd
read
write
edit
delete_file
glob
grep
```

All other callable tools are advanced. This includes SubAgent lifecycle tools, task checklist tools, Git/GitHub, Browser, Computer Use, skills, MCP, Automation, Flow, Memory Lab, and future catalog additions. They are initially represented only by name and a compact capability description inside `tool_provision`.

The first-request system prompt now states explicitly:

- only the eight foundational tools have initial complete schemas;
- capability catalog presence does not make an advanced tool callable;
- the Agent must call `tool_provision` with the exact name as the only tool call in that assistant subturn;
- the Agent may call the advanced tool only on the following provider turn, after the original complete schema appears.

Provisioning does not bypass Plan mode, SubAgent sandboxing, native-tool settings, deletion guards, remote-write review, or any executor policy. The catalog is built only from policy-eligible definitions.

## Files changed

- `DESKTOP/src/core/agentKernelRunner.ts`: foundational set, deterministic initial routing, broker catalog/session, explicit Prompt contract.
- `DESKTOP/src/tests/toolSurfaceV2Verify.ts`: exact initial boundary for every intent and null-toolchain case.
- `DESKTOP/src/tests/toolProvisioningVerify.ts`: 78-tool schema fidelity, provider reachability, Prompt wording, dynamic broker-to-original-tool execution.
- `DESKTOP/src/tests/autoAgentIntegrationVerify.ts`: Auto and fixed-model foundational boundary.
- `DESKTOP/src/tests/verify.ts`: Memory Lab, Flow, Automation, and Computer Use integration fixtures provision advanced tools before invocation.
- `README.md` and `OVERVIEW.md`: public contract and architecture ownership.

## Verification evidence

```text
npm.cmd run build                                      PASS
node dist/tests/toolSurfaceV2Verify.js                 PASS
node dist/tests/toolProvisioningVerify.js              PASS
  78/78 schemas preserved
  78/78 tools reachable on a provider subturn
  dynamic provision -> original tool execution PASS
node dist/tests/autoAgentIntegrationVerify.js          25 checks PASS
node dist/tests/verify.js                              1643/1643 PASS
npm.cmd run test:desktop:built                         PASS
```

The complete desktop gate also identified and corrected two stale test assumptions: the compression pressure fixture directly invoked `context_compress`, and the normal-chat history fixture expected intent-based preload of `build_history_query`. Both now exercise the production contract by provisioning first and then calling the original tool on the next provider turn. The packaged CLI compression mock follows the same two-turn contract.

## Packaging and installation

The final cross-platform candidate is `dev-0.4.7`.

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `Newmark-Agent-0.4.7-x64.msi` | 226,261,071 | `FD46F635839626693F69D306A05547158BA5EAB0EA78045AC6356B90BE339417` |
| `Newmark-Agent-0.4.7-win-unpacked-x64.zip` | 292,388,387 | `1814F9E5312E08D70BE6478B7418018482DA12A53C5E1434D5EE4BD9C054D9C8` |
| `Newmark-Agent-0.4.7-x86_64.AppImage` | 176,499,587 | `B5E9E16EDA8DC8D08A594D789C3BE1E21C6310504F834155544B02112EE0BB7B` |
| `Newmark-Agent-0.4.7-amd64.deb` | 135,902,236 | `39388636D30F7A918C449AC0E714F6B9B42835D6867B76B62D82E62C33093817` |
| `Newmark-Agent-0.4.7-linux-unpacked-x64.zip` | 172,616,312 | `32831EEFF57FAEFCB5768F8B9918DDCF2A7ED127D09BCC8992DD034B8E0D3845` |

Windows release gates, MSI extraction smoke (22 + 12 assertions), packaged CLI and context-compression smoke passed. UAC MSI installation returned exit code 0; the installed CLI reports `0.4.7`. Packaged and installed `app.asar` are both 159,762,833 bytes with SHA-256 `CE962FA83BE0CD35526317927C239B55249AB7AA4FF03AC556BC6CD29F96BB5C`.

WSL Ubuntu-24.04 completed the full Linux test suite, the 20-run latency benchmark, and the AppImage/deb/ZIP build. Each Linux asset then passed an independent real Electron GUI/CDP and Bash/sh terminal isolation smoke. A first sequential smoke attempt exposed transient single-instance/CDP overlap between consecutive packages; isolated reruns passed without product changes.

## Pre-push credential audit

The pre-release secret scan found four provider credentials in an Android preset file introduced only in local commits that had not reached `origin/master`. The preset was converted to endpoint/model templates with empty keys. Because deleting credentials only in the latest commit would leave them in the 38 unpushed commits, the release branch must be reconstructed from `origin/master` as a single clean snapshot before push. Credential values are intentionally omitted from this record and must be rotated by their owners.
