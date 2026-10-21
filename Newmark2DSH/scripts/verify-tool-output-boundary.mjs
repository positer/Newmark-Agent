#!/usr/bin/env node
/**
 * verify-tool-output-boundary.mjs — **every tool this bundle registers, against the boundary
 * that has silently discarded two of its real runs.**
 *
 * =====================================================================================
 * READ THIS FIRST: what this check is for, in the user's terms
 * =====================================================================================
 *
 * This is NOT a style rule and NOT a lint pass. It is the edge of the plugin, and it has cost
 * this bundle two releases:
 *
 *   - `memory_lab_reindex` (0.2.2) returned `error: undefined` on its SUCCESS path, so a rebuild
 *     that had already written the index came back to its caller as a hard failure.
 *   - `agent_api_send` (0.2.8) returned `{ turn: undefined }` in its event log, so a judgement
 *     the Agent had really run — paid for in real model tokens, and the user watched it take
 *     real time — was thrown away at the boundary and the panel showed
 *     判定未完成：INVALID_TOOL_OUTPUT. The answer existed. It was discarded for a field nobody
 *     read.
 *
 * DSH validates every tool's return value as LOSSLESS JSON before handing it back. The rule is
 * `walkJsonValue` (`@deepseek-ai/dsh-util-values/lib/index.js:46-153`): `null`, booleans,
 * strings, finite non-`-0` numbers, plain arrays, plain objects — and at `:109`
 * `if (typeof current !== "object") return void 0`, which is where `undefined` dies. The check is
 * applied in `createSuccessResult` -> `snapshotToolValue` (`@deepseek-ai/dsh-tools/lib/types/
 * index.js:1189-1190`, `:106-118`) and a rejection becomes `ToolOutputError` /
 * `INVALID_TOOL_OUTPUT` (`:77-85`).
 *
 * **The failure mode is the dangerous kind: the work is done, the answer is complete, and the
 * caller is told the operation failed.** A caller's obvious response is to do it again.
 *
 * =====================================================================================
 * WHY IT IS A GATE OF ITS OWN, AND WHY IT NEVER CALLS A TOOL'S `execute` DIRECTLY
 * =====================================================================================
 *
 * Both defects were found by a user hitting them. The reason is structural, and it is worth
 * stating exactly:
 *
 *   `verify-agent-api-live.mjs` called the component's tool `execute` DIRECTLY in its rounds 2
 *   and 3. It never went through `ctx.tools.execute`, so the registry's output boundary was
 *   never applied to those values. Round 4 DID dispatch through the registry — which is why it
 *   caught the MemoryLab defect and not this one. **The acceptance gate had a hole exactly where
 *   this class of defect lives.** Its rounds 2 and 3 now dispatch through the registry, and the
 *   check near the bottom of this file keeps them there.
 *
 * This gate therefore never reaches into a definition. Every value it judges came out of the
 * real `ToolRuntime` (`@deepseek-ai/dsh-tools`, the class the Host composes), registered by the
 * three real components, dispatched the way a model's tool call is dispatched. The verdict is
 * DSH's own `snapshotJsonValue`, imported from the installation, never reimplemented.
 *
 * =====================================================================================
 * WHAT IT COVERS, AND WHAT IT DOES NOT — read this before trusting a green line
 * =====================================================================================
 *
 * COVERED, for all fifteen tools the bundle registers:
 *   - the DECLARED output of every tool: `name`, `description`, `parameters`, `output.schema` —
 *     walked BEFORE anything asks DSH to project a schema, because DSH's own projection THROWS on
 *     a non-lossless `parameters` (`dsh-tools/lib/index.js:3042`) and a gate that died there would
 *     report the defect as "the gate itself failed" instead of naming the field. Measured: that is
 *     exactly what the first version of this file did (mutation `M10`);
 *   - DSH's OWN projection of those declarations, as its own named check, so a `parameters` object
 *     the registry refuses is reported as a failure with the registry's sentence;
 *   - the VALUE each of them returns for at least one real dispatch, walked by DSH's own walker,
 *     with the PATH of any rejection named (`$.result.events[2].turn`, not
 *     "value is not lossless JSON");
 *   - the four `agent_api_*` tools driven to their success, refusal, service-absence and
 *     failure envelopes, including a COMPLETE RUN through the component's own loop (a scripted
 *     `llm` service, so no provider is called and no token is spent) — the envelope that carried
 *     the 0.2.8 defect, and an exit-4 run, which puts its event log somewhere else again;
 *   - the nine `memory_lab_*` tools against a throwaway store, including `memory_lab_reindex`,
 *     the shape that carried the 0.2.2 defect;
 *   - every `computer_use` action that answers without capturing the screen or delivering input.
 *
 * NOT COVERED, and NAMED rather than implied — the `NOT_DISPATCHED` table below:
 *   - `screen_capture` is never dispatched here. Every one of its paths reaches a lane process
 *     and captures the screen or enumerates the user's windows, and this gate runs inside the
 *     release gate, unattended. Its VALUES are covered by
 *     `verify-computeruse-output-boundary.mjs` — all three of its target shapes, asserted clean
 *     and passing `snapshotJsonValue` — and a check below FAILS if that coverage disappears.
 *   - the remaining `computer_use` actions — move, click, drag, scroll, type, key, the five
 *     `app_` deliveries, `sequence` and both `takeover_` actions — same reason, same covering
 *     gate, which drives all of them with the lane transport stubbed and a spawn canary armed.
 *
 * A green line here means "these values, measured", not "no value anywhere can be bad". The
 * counterfactual phase exists so the difference stays visible: it plants a real `undefined` and
 * requires the registry to reject it.
 *
 * =====================================================================================
 * PHASES, AND HOW TO RUN IT
 * =====================================================================================
 *
 *     node scripts/verify-tool-output-boundary.mjs
 *
 * Phases are selectable with `NM_TOB_PHASES` (default all four):
 *
 *   self           the scanner and the walker, self-tested on nine planted defects
 *   declared       every registered tool's declared output, before any call
 *   dispatch       every dispatchable tool through the real registry
 *   counterfactual a tool whose value carries a planted `undefined`, on the same real registry
 *
 * Exit codes:
 *   0  every check passed
 *   1  a check failed (named, with the path and the registry's own message printed)
 *   2  the check could not be armed — the DSH installation is absent, or the run threw
 *
 * No model call is made. No pointer is moved, no key is typed, no window is activated, no screen
 * is captured, no overlay is drawn, no process is launched. Nothing is written under the user's
 * Newmark root: the store, any capture directory and the run workspace all live under a
 * throwaway root in the system temp directory, and the last check proves the live store is
 * byte-identical afterwards.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createRecordingRegistry,
  declaredOutputFindings,
  describeReport,
  dshModuleUrl,
  firstViolation,
  loadDshWalker,
  losslessReport,
} from './lib/tool-output-boundary.mjs';

/* ------------------------------------------------------------------ configuration --- */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const LIVE_ROOT = process.env.NEWMARK_ROOT?.trim() || join(homedir(), '.Newmark');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
/** `NM_TOB_SCRATCH` pins the receipt, so a mutation harness can read exactly one run's. */
const SCRATCH = process.env.NM_TOB_SCRATCH?.trim()
  ? resolve(process.env.NM_TOB_SCRATCH.trim())
  : join(REPO, 'evidence', 'tool-output-boundary', STAMP);

const PHASES = String(process.env.NM_TOB_PHASES ?? 'self,declared,dispatch,counterfactual')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const wants = (phase) => PHASES.includes(phase);

/** The provider/model the throwaway run is given. Neither names a real provider route. */
const PROVIDER = 'deepseek';
const MODEL = 'deepseek-output-boundary-fixture';

/** The throwaway root: the store, any capture directory and the run workspace all live here. */
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'nm-tob-root-'));

/**
 * The tools this bundle registers that are deliberately NOT dispatched here, and where their
 * values ARE measured. The check near the bottom reads the named gate and FAILS if it stops
 * dispatching the tool, so an exception here cannot quietly become a hole.
 */
const NOT_DISPATCHED = [
  {
    tool: 'screen_capture',
    reason:
      "every path of this tool reaches a lane process and captures the screen or enumerates the user's " +
      'windows; this gate runs inside the release gate, unattended',
    coveredBy: 'verify-computeruse-output-boundary.mjs',
  },
  {
    tool: 'computer_use',
    reason:
      'the move/click/drag/scroll/type/key/app_*/sequence/takeover_* actions deliver input or acquire the ' +
      'desktop; only the actions that answer without either are dispatched here',
    coveredBy: 'verify-computeruse-output-boundary.mjs',
  },
];

/* ------------------------------------------------------------------------ output --- */

const RESULTS = [];
function say(line = '') {
  process.stdout.write(String(line) + '\n');
}
function record(name, ok, detail) {
  RESULTS.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
  say(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (detail) say(`         ${detail}`);
}
function note(line) {
  say(`  note: ${line}`);
}

/* ------------------------------------------------------------------- DSH imports --- */

const dshImport = (relative) => import(dshModuleUrl(relative));
const repoImport = (relative) => import(pathToFileURL(process.env.NEWMARK_TEST_PACKAGE_ROOT && relative.startsWith('packages/newmark-core/') ? join(process.env.NEWMARK_TEST_PACKAGE_ROOT,relative.slice('packages/newmark-core/'.length)) : join(REPO, relative)).href);

/** DSH's own walker. Set once in `main`, before anything is judged. */
let SNAPSHOT = null;
/** Every raw value a tool body returned, across every registry this gate mounts. */
const SINK = [];
/** Dispatch counter, so each `callId` is unique the way a real loop's would be. */
let SEQUENCE = 0;

/* ---------------------------------------------------------------- the fake model --- */

/**
 * One assistant turn, as the documented `StreamChunk` union. The same vocabulary
 * `verify-agent-api.mjs` drives the real seam with, so a run scripted here and a run scripted
 * there are the same shape of fact.
 */
function chunkTurn({ text = '', toolCalls = [], reason = { kind: 'stop' } } = {}) {
  const chunks = [];
  let index = 0;
  if (text) {
    chunks.push({ type: 'block-start', index, blockType: 'text' });
    chunks.push({ type: 'text-delta', index, text });
    chunks.push({ type: 'block-end', index, block: { type: 'text', text } });
    index += 1;
  }
  for (const call of toolCalls) {
    chunks.push({
      type: 'block-end',
      index,
      block: { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    });
    index += 1;
  }
  chunks.push({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } });
  chunks.push({ type: 'finish', reason });
  return chunks;
}

const fixtureModels = async (provider) => [{ provider, id: MODEL, name: 'Output Boundary Fixture' }];

/**
 * A scripted `llm` service: no provider, no network, no token.
 *
 * The shape is `ctx.llm`'s (`listModels(provider)`, `stream(generate)`), and the component reads
 * it through `ctx.get('llm')`, exactly as it does in a live Host.
 */
function scriptedLlm({ turns = [], defaultText = 'boundary', limit = 8 } = {}) {
  const queue = turns.slice();
  const counts = { listModels: 0, stream: 0 };
  return {
    counts,
    limit,
    async listModels(provider) {
      counts.listModels += 1;
      return fixtureModels(provider);
    },
    stream() {
      counts.stream += 1;
      if (counts.stream > limit) {
        // Fail closed rather than loop for ever: a run still asking for turns past the limit has
        // already exceeded every bound this gate set, and a hang is not a red assertion.
        throw new Error(`the gate fixture refuses model call ${counts.stream}: the run is not stopping`);
      }
      const chunks = queue.length > 0 ? queue.shift() : chunkTurn({ text: defaultText });
      return (async function* emit() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

/** A model that always asks for a tool, so a bounded run reaches its step cap deterministically. */
function alwaysToolLlm({ limit = 4 } = {}) {
  const counts = { listModels: 0, stream: 0 };
  return {
    counts,
    async listModels(provider) {
      counts.listModels += 1;
      return fixtureModels(provider);
    },
    stream() {
      counts.stream += 1;
      if (counts.stream > limit) {
        throw new Error(`the gate fixture refuses model call ${counts.stream}: the run is not stopping`);
      }
      const chunks = chunkTurn({
        toolCalls: [{ id: `fixture-call-${counts.stream}`, name: FIXTURE_TOOL, arguments: { n: counts.stream } }],
      });
      return (async function* emit() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

/* ------------------------------------------------------------- mounting for real --- */

/** The fixture tool, so `agent_api_tool` and a scripted run both have something to dispatch. */
const FIXTURE_TOOL = 'boundary_fixture';

async function bootstrap() {
  const cordis = await dshImport('cordis/lib/index.js');
  const { ToolRuntime } = await dshImport('dsh-tools/lib/index.js');
  const { SystemPrompt } = await dshImport('dsh-system-prompt/lib/index.js');
  const { LocalFileSystem } = await dshImport('dsh-fs-local/lib/index.js');
  const ctx = new cordis.Context();
  const systemPrompt = new SystemPrompt(ctx, {});
  const fileSystem = new LocalFileSystem(ctx, { cwd: SCRATCH, diffBasisMaxBytes: 8 * 1024 * 1024 });
  const tools = new ToolRuntime(ctx, {});
  return { ctx, tools, systemPrompt, fileSystem };
}

function registerFixture(tools) {
  tools.register({
    name: FIXTURE_TOOL,
    description: 'output-boundary gate fixture: a registered tool that answers, so a dispatch has a real target',
    parameters: { type: 'object', properties: { n: { type: 'number' } }, required: [] },
    output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      return { echoed: args ?? {}, from: FIXTURE_TOOL };
    },
  });
}

/**
 * The host a composed component is mounted with: the real `ToolRuntime` as `tools`, `effect()`
 * really running each registration, and `get(name)` answering the optional services the way a
 * live profile would.
 */
function makeHost({ tools, get, log }) {
  const effects = [];
  const routes = [];
  const host = {
    logger: {
      info: (...args) => log.push(`inf ${args.map(String).join(' ')}`),
      warn: (...args) => log.push(`warn ${args.map(String).join(' ')}`),
      error: (...args) => log.push(`error ${args.map(String).join(' ')}`),
      debug: () => {},
    },
    tools,
    webServer: {
      tapIndex: () => () => {},
      register: (route) => {
        routes.push(route?.path ?? '(unnamed)');
        return () => {};
      },
    },
    effect: (factory, label) => {
      effects.push({ label, dispose: factory() });
      return () => {};
    },
    get,
  };
  return { host, effects, routes, log };
}

/** Mount the whole bundle on one real registry, the way the core row composes it. */
async function mountBundle({ llm, core }) {
  const { tools: realTools } = await bootstrap();
  const registry = createRecordingRegistry(realTools, SINK);
  const tools = registry.tools;
  /* The gate's own fixture goes through the recording registry too, so `registry.definitions`
   * holds EVERY tool on this registry — which is what lets the declared walk below run without
   * asking DSH to project anything. */
  registerFixture(tools);
  const log = [];
  const { host, effects, routes } = makeHost({
    tools,
    log,
    get: (name) => (name === 'llm' ? llm : name === 'newmarkComponents' ? core : undefined),
  });

  const memorylab = await repoImport('packages/newmark-core/components/memorylab/index.js');
  memorylab.apply(host, { root: TEMP_ROOT, language: 'auto', reindexOnRender: false });

  const computeruse = await repoImport('packages/newmark-core/components/computeruse/index.js');
  computeruse.apply(host, { leaseTtlMs: 120000, root: TEMP_ROOT });

  const agentApi = await repoImport('packages/newmark-core/components/agent-api/index.js');
  const api = agentApi.apply(host, { root: TEMP_ROOT, workspace: TEMP_ROOT, timeoutMs: 60000, maxSteps: 8 });

  return { tools: registry.tools, registry, memorylab, computeruse, agentApi, api, effects, routes, log };
}

/** Mount agent-api alone, for the shapes a second registry has to produce. */
async function mountAgentApiOnly({ llm, core, maxSteps = 8 }) {
  const { tools: realTools } = await bootstrap();
  const registry = createRecordingRegistry(realTools, SINK);
  registerFixture(registry.tools);
  const log = [];
  const { host, effects } = makeHost({
    tools: registry.tools,
    log,
    get: (name) => (name === 'llm' ? llm : name === 'newmarkComponents' ? core : undefined),
  });
  const agentApi = await repoImport('packages/newmark-core/components/agent-api/index.js');
  const api = agentApi.apply(host, { root: TEMP_ROOT, workspace: TEMP_ROOT, timeoutMs: 60000, maxSteps });
  return { tools: registry.tools, registry, api, effects, log };
}

/* ------------------------------------------------------------------- dispatching --- */

const DISPATCHES = [];

/**
 * Dispatch one tool through the real registry, the way a model turn does, and answer the facts
 * this gate judges: what the registry said, and what the body actually returned.
 */
async function dispatch(tools, name, args, note_ = '') {
  SEQUENCE += 1;
  const mark = SINK.length;
  const started = Date.now();
  let outcome = null;
  let threw = null;
  try {
    outcome = await tools.execute({
      callId: `tob:${SEQUENCE}:${name}`,
      name,
      arguments: args ?? {},
      signal: new AbortController().signal,
    });
  } catch (error) {
    threw = `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`;
  }
  /* The OUTERMOST value for this tool, out of everything that ran underneath it: a run's own
   * tool calls land in the same sink, and they are not the value this dispatch returned. */
  const recorded = SINK.slice(mark).filter((entry) => entry.tool === name).pop() ?? null;
  const value = outcome?.value;
  /* What the boundary was asked to accept. The recorded body return is the honest one — when the
   * registry rejects a value it throws and the value is otherwise gone. */
  const judged = recorded !== null ? recorded.value : value;
  const isError = outcome?.isError === true;
  /* THREE OUTCOMES, AND CONFLATING THEM IS THE MISTAKE THIS WHOLE GATE IS ABOUT:
   *
   *   returned  the body answered, the registry accepted the value. The ordinary case.
   *   rejected  the body ANSWERED, and the registry refused the value. The defect class: the work
   *             is done and the caller is told it failed.
   *   threw     the body raised. No value ever reached the boundary, and the registry reports the
   *             body's own error. A deliberate refusal in this bundle looks like this
   *             (`memory_lab_tag_apply` with no decisions), and it must NOT be read as a rejection.
   */
  const kind = isError ? (recorded !== null ? 'rejected' : 'threw') : 'returned';
  const report = kind === 'threw' ? null : losslessReport(judged, SNAPSHOT);
  const fact = {
    name,
    args,
    note: note_,
    ms: Date.now() - started,
    threw,
    kind,
    isError: outcome?.isError ?? null,
    value: value ?? null,
    errorMessage: String(outcome?.error?.message ?? ''),
    errorCode: String(outcome?.error?.info?.code ?? ''),
    errorName: String(outcome?.error?.info?.name ?? ''),
    recorded: recorded !== null,
    report,
    nestedCalls: SINK.slice(mark).filter((entry) => entry.tool !== name).map((entry) => entry.tool),
  };
  DISPATCHES.push(fact);
  return fact;
}

/** One line per dispatch, so the transcript carries the real answer rather than a summary. */
function line(fact) {
  const label = `${fact.name}${fact.args?.action ? `/${fact.args.action}` : ''}`;
  const verdict =
    fact.kind === 'threw'
      ? `body-threw code=${fact.errorCode || '-'}`
      : `isError=${fact.isError} code=${fact.errorCode || '-'}`;
  return `${label.padEnd(32)} ${verdict}  value=${fact.report ? describeReport(fact.report) : '(no value: the body threw)'}`;
}

function show(fact) {
  say(`    ${line(fact)}`);
  if (fact.errorMessage) say(`      registry error: ${fact.errorCode} ${fact.errorName} :: ${fact.errorMessage}`);
}

/* =====================================================================================
 * PHASE 0 — the scanner and the rule, self-tested
 * ===================================================================================== */

const PLANTED = [
  ['a nested undefined', { ok: true, nested: { list: [{ fine: 1 }, { alsoFine: undefined }] } }, '$.nested.list[1].alsoFine'],
  ['an undefined in an event log', { events: [{ type: 'turn_start', turn: 1 }, { type: 'agent_end', turn: undefined }] }, '$.events[1].turn'],
  ['NaN', { a: NaN }, '$.a'],
  ['negative zero', { a: -0 }, '$.a'],
  ['Infinity', { a: [1, Infinity] }, '$.a[1]'],
  ['a function', { a: { b: () => 1 } }, '$.a.b'],
  ['a class instance', { d: new Date() }, '$.d'],
  ['a sparse array', { a: [1, , 3] }, '$.a'],
  ['a cycle', (() => { const o = { a: 1 }; o.self = o; return o; })(), '$.self'],
];

function phaseSelf() {
  say("\n=== PHASE 0 — the scanner and DSH's rule, self-tested on planted defects ===");

  const planted = { ok: true, nested: { list: [{ fine: 1 }, { alsoFine: undefined }] } };
  const found = firstViolation(planted, SNAPSHOT);
  record(
    'the scanner names a planted undefined at its exact path',
    found.path === '$.nested.list[1].alsoFine',
    `path=${found.path} reason=${found.reason}`,
  );
  record(
    "DSH's own walker rejects the planted value",
    losslessReport(planted, SNAPSHOT).ok === false,
    `snapshotJsonValue(planted) ${SNAPSHOT(planted) === undefined ? 'returned undefined (rejected)' : 'ACCEPTED IT'}`,
  );
  const cleaned = JSON.parse(JSON.stringify(planted));
  record(
    'and accepts the same value once the undefined-valued key is gone',
    losslessReport(cleaned, SNAPSHOT).ok === true,
    `keys of the repaired node: ${Object.keys(cleaned.nested.list[1]).join(',') || '(none)'}`,
  );

  const wrong = [];
  for (const [label, value, expected] of PLANTED) {
    const report = losslessReport(value, SNAPSHOT);
    if (report.ok || report.path !== expected) {
      wrong.push(`${label}: walker=${report.ok ? 'ACCEPTED' : 'rejected'} path=${report.ok ? '-' : report.path} expected=${expected}`);
    }
  }
  record(
    `the walker and the scanner agree on all ${PLANTED.length} planted defects, at the planted path`,
    wrong.length === 0,
    wrong.length === 0 ? PLANTED.map(([label]) => label).join(', ') : wrong.join(' | '),
  );
}

/* =====================================================================================
 * main
 * ===================================================================================== */

function digestTree(dir) {
  if (!existsSync(dir)) return '(absent)';
  const hash = createHash('sha256');
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      hash.update(relative(dir, full));
      if (entry.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

/** Taken at load time, before anything this gate does could have written. */
const LIVE_BEFORE = digestTree(LIVE_ROOT);

async function main() {
  say('Newmark Core — the tool-output boundary, for every tool the bundle registers');
  say('==========================================================================');
  say(`repo:      ${REPO}`);
  say(`temp root: ${TEMP_ROOT}   (the store, any capture directory and the run workspace live here)`);
  say(`live root: ${LIVE_ROOT}   (one digest; nothing is written there)`);
  say(`scratch:   ${SCRATCH}`);
  say(`phases:    ${PHASES.join(', ')}`);
  say('');
  say('Not a style rule. DSH rejects a tool value that is not lossless JSON, and the work behind');
  say('it has already happened: memory_lab_reindex (0.2.2) and agent_api_send (0.2.8) were both');
  say('reported to their caller as failures AFTER succeeding. No model is called here and no');
  say('desktop is touched.');
  mkdirSync(SCRATCH, { recursive: true });

  /* ---- the walker, from the installation, before anything else ---- */
  const walker = await loadDshWalker();
  SNAPSHOT = walker.snapshotJsonValue;
  say(`\nDSH walker:  ${walker.path}`);

  if (wants('self')) phaseSelf();

  /* ---- the whole bundle on one real registry ---- */
  const core = { root: () => TEMP_ROOT, model: () => ({ provider: PROVIDER, model: MODEL }) };
  const llm = scriptedLlm({ turns: [chunkTurn({ text: 'The boundary holds.' })] });
  const bundle = await mountBundle({ llm, core });

  /* THE TOOLS THE REGISTRY HOLDS, read from the recording registry's own map — the one `register`
   * fills — and NOT from `ctx.tools.schemas()`.
   *
   * That is not a shortcut, it is the difference between a gate that reports a defect and one that
   * dies of it. DSH's `schemaOf` THROWS when a tool's declared `parameters` are not lossless JSON
   * (`@deepseek-ai/dsh-tools/lib/index.js:3042`, reached from `schemas()` at `:3024`), so a gate
   * that asked the registry to project the catalog before walking what the tools declare would
   * abort with "the gate itself failed" on exactly the class it exists to name — measured, by
   * planting `$comment: undefined` in `agent_api_state`'s parameters and watching the receipt never
   * get written. The projection is checked too, just afterwards and as its own named assertion. */
  const registered = [...bundle.registry.definitions.keys()];

  /* What the bundle DECLARES it registers. Two of the three components' `apply()` return nothing
   * (only agent-api returns its instance), so the declaration is read from their own factories —
   * `tools()` is a literal array on both, so a fresh instance against the same throwaway root
   * declares exactly what the mounted one did. Nothing here is restated by hand: a sixteenth tool
   * has to be considered by this gate rather than slip past it. */
  const memorylabComponent = await repoImport('packages/newmark-core/components/memorylab/component.js');
  const computeruseComponent = await repoImport('packages/newmark-core/components/computeruse/component.js');
  const declaredMemory = memorylabComponent.createMemoryLab({ root: TEMP_ROOT, reindexOnRender: false });
  const declaredCompute = computeruseComponent.createComputerUse({ root: TEMP_ROOT, leaseTtlMs: 120000 });
  const declared = [
    ...bundle.api.tools().map((tool) => tool.name),
    ...declaredMemory.tools().map((tool) => tool.name),
    ...declaredCompute.tools().map((tool) => tool.name),
  ].sort();
  const bundleRegistered = registered.filter((name) => name !== FIXTURE_TOOL).sort();
  const exceptedNames = new Set(NOT_DISPATCHED.map((entry) => entry.tool));

  say('\nregistry:    real ToolRuntime on a real Cordis context');
  say('llm:         scripted service (no provider is called, no token is spent)');
  say(`registered:  ${registered.length} tools: ${registered.join(', ')}`);
  record(
    "the registry holds exactly the tools the bundle's three components declare",
    JSON.stringify(bundleRegistered) === JSON.stringify(declared) && declared.length === 19,
    `${bundleRegistered.length} registered (the gate's own fixture aside): ${bundleRegistered.join(', ')}`,
  );

  /* ---- PHASE 1: what each tool DECLARES — walked FIRST, and without asking DSH for anything ---- */
  if (wants('declared')) {
    say("\n=== PHASE 1 — every registered tool's declared output, before any call ===");
    const findings = [];
    for (const name of registered) {
      const definition = bundle.registry.definitions.get(name);
      if (definition === undefined) {
        findings.push({ tool: name, at: '(definition)', path: '$', reason: 'the registry holds no definition under this name' });
        continue;
      }
      for (const finding of declaredOutputFindings(definition, SNAPSHOT)) findings.push({ tool: name, ...finding });
    }
    for (const finding of findings) say(`    ${finding.tool}.${finding.at} -> ${finding.path}: ${finding.reason}`);
    record(
      `every registered tool declares a lossless name, description, parameters and output schema (${registered.length} x 4 fields)`,
      findings.length === 0,
      findings.length === 0
        ? `${registered.length * 4} declared fields walked, all accepted by DSH's walker`
        : findings.map((finding) => `${finding.tool}.${finding.at} ${finding.path}`).join(', '),
    );
  }

  /* ---- what DSH ITSELF makes of those declarations ----
   *
   * Two of the four declared fields are pre-validated by the registry, and both of those checks
   * live on paths a caller reaches: `output.schema` at `register` (`assertSupportedJsonSchema`),
   * `parameters` at `schemas()` (`schemaOf`). A `parameters` object the walker rejects therefore
   * does not merely fail this gate's own walk — it makes the catalog UNPROJECTABLE, which is a
   * user-visible failure the moment anything asks for a schema. So it gets its own named check,
   * after the walk, so the walk's path report survives. */
  {
    let projected = null;
    let refusal = null;
    try {
      projected = bundle.tools.schemas().map((entry) => entry.name);
    } catch (error) {
      refusal = `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`;
    }
    const sameSet =
      Array.isArray(projected) && JSON.stringify(projected.slice().sort()) === JSON.stringify(registered.slice().sort());
    record(
      "DSH projected every registered tool's schema for a caller (ctx.tools.schemas())",
      refusal === null && sameSet,
      refusal === null
        ? `${projected.length} schemas projected: ${projected.join(', ')}`
        : refusal,
    );
  }

  /* ---- PHASE 2: what each tool RETURNS, through the registry ---- */
  let capRun = null;
  if (wants('dispatch')) {
    say('\n=== PHASE 2 — every dispatchable tool, through the real registry ===');
    say('    (a value shown as rejected carries the PATH of the field that killed it)');
    const t = bundle.tools;
    const REFUSAL = 'a refusal envelope: the tool answers, the registry accepts it';
    await dispatch(t, 'shortMemory_add', { content: 'Boundary fixture short memory' }, 'isolated short-memory write');
    await dispatch(t, 'shortMemory_recall', {}, 'latest ten short memories');
    await dispatch(t, 'shortMemory_where', {}, 'short-memory absolute store path');
    await dispatch(t, 'shortMemory_size', {}, 'short-memory row count');

    /* ---- agent-api: the reads, the dispatch, and the refusals, none of which run a model ---- */
    say('\n  -- agent_api_* --');
    [
      await dispatch(t, 'agent_api_state', {}, 'the read half: profile, capabilities, catalog, counters'),
      await dispatch(t, 'agent_api_catalog', { detail: 'full', limit: 3 }, "the catalog with each tool's parameters"),
      await dispatch(t, 'agent_api_catalog', { detail: 'names' }, 'the cheap projection'),
      await dispatch(t, 'agent_api_tool', { tool: FIXTURE_TOOL, arguments: { n: 1 } }, 'a real nested dispatch through the registry'),
      await dispatch(t, 'agent_api_tool', { tool: 'no_such_tool_anywhere' }, 'exit 2, UNKNOWN_TOOL classified'),
      await dispatch(t, 'agent_api_tool', { tool: 'agent_api_send' }, 'exit 2, the recursion refusal'),
      await dispatch(t, 'agent_api_tool', { arguments: {} }, 'exit 2, missing_tool_name'),
      await dispatch(t, 'agent_api_tool', { tool: FIXTURE_TOOL, arguments: 'not-an-object' }, 'exit 2, invalid_arguments'),
      await dispatch(t, 'agent_api_send', {}, REFUSAL),
      await dispatch(t, 'agent_api_send', { prompt: 'x', tools: { allow: [] } }, REFUSAL),
      await dispatch(t, 'agent_api_send', { prompt: 'x', timeout_ms: -1 }, REFUSAL),
      await dispatch(t, 'agent_api_send', { prompt: 'x', max_steps: 0 }, REFUSAL),
      await dispatch(t, 'agent_api_send', { prompt: 'x', workspace: 5 }, REFUSAL),
      await dispatch(t, 'agent_api_send', { prompt: 'x', output_schema: { type: 'array' } }, REFUSAL),
    ].forEach(show);

    /* THE COMPLETE RUN. The scripted service answers one clean turn, so the component's own loop
     * drives a real run and returns its real envelope — the shape that carried the 0.2.8 defect,
     * and the only way to reach it without a provider. */
    const completed = await dispatch(
      t,
      'agent_api_send',
      { prompt: 'Answer with one short sentence: does the boundary hold?', max_steps: 2, timeout_ms: 30000 },
      "a COMPLETE RUN through the component's own loop",
    );
    show(completed);
    const envelope = completed.value;
    /* The event log rides in the envelope's `extra`, so it is a TOP-LEVEL key — `envelope.events`,
     * not `envelope.result.events`. Reading it from `result` answered `null` and made this check
     * fail on a run that had answered perfectly, which is its own small lesson about reading a
     * field where you expect it rather than where the contract puts it. */
    const events = envelope?.events;
    say(`      envelope: ${JSON.stringify({ ok: envelope?.ok, route: envelope?.route, exit: envelope?.exit, code: envelope?.code ?? undefined })}`);
    say(`      events:   ${JSON.stringify(events ?? null)}`);
    say(`      context:  ${JSON.stringify(envelope?.result?.context ?? null)}`);
    say(`      usage:    ${JSON.stringify(envelope?.result?.usage ?? null)}`);
    record(
      'agent_api_send completed a real run through the registry and answered its loop envelope',
      completed.isError === false && envelope?.ok === true && envelope?.route === 'loop' && envelope?.exit === 0,
      `ok=${envelope?.ok} route=${envelope?.route} exit=${envelope?.exit} turns=${envelope?.result?.turns} ` +
        `output=${JSON.stringify(envelope?.result?.output ?? null)}${completed.errorMessage ? ` :: ${completed.errorMessage}` : ''}`,
    );
    record(
      "the loop envelope's own event log crosses the boundary: every event carries a JSON turn",
      Array.isArray(events) &&
        events.length > 0 &&
        events.every(
          (event) => event !== null && typeof event === 'object' && (event.turn === null || typeof event.turn === 'number'),
        ),
      Array.isArray(events)
        ? `${events.length} event(s), turns=${events.map((event) => (event.turn === null ? 'null' : event.turn)).join(',')}`
        : 'the envelope carries no event list at all, so this shape was not exercised',
    );

    /* ---- memorylab: the nine, against the throwaway store ---- */
    say('\n  -- memory_lab_* --');
    [
      await dispatch(t, 'memory_lab_read', {}, 'the whole index'),
      /* The first of the two navigation reads, on a store that has no tag at all yet: the shape
       * an EMPTY answer takes is its own shape, and it is a new one. */
      await dispatch(t, 'memory_lab_root_tags', {}, 'the root parent tags — none of them, yet'),
      await dispatch(t, 'memory_lab_query', { query: 'output boundary' }, 'a scored query'),
      await dispatch(
        t,
        'memory_lab_update',
        {
          name: 'Output Boundary Probe',
          description: 'created by verify-tool-output-boundary.mjs in a throwaway store',
          tags: ['#boundary'],
          content: '# Output Boundary Probe\n\nCreated by the boundary gate. Deleted before the gate ends.\n',
          reason: 'the boundary gate needs a write receipt to walk',
          source: 'verify-tool-output-boundary.mjs',
        },
        'a write receipt',
      ),
      await dispatch(t, 'memory_lab_read', { component: 'output-boundary-probe' }, 'one component'),
      /* ---- the second navigation read, and the three shapes it answers with ----
       *
       * A subtree table is a NEW payload shape, and a new payload shape is exactly where a new
       * `undefined` appears — that is the whole history of this gate. Three of its paths are
       * dispatched, because they build different values: an ordinary subtree, the BOUNDED one
       * (which carries the dropped report), and the two refusals — NOT_FOUND for a tag that does
       * not exist, and a body that throws for a tag that was not given. */
      await dispatch(t, 'memory_lab_root_tags', {}, 'the roots, now that the store has one'),
      await dispatch(t, 'memory_lab_subtag_tree', { tag: '#boundary' }, "one tag's subtree: structure, components, statistics"),
      await dispatch(t, 'memory_lab_subtag_tree', { tag: 'boundary', max_tags: 1, max_components: 1 }, 'the same subtree, bounded: what it dropped'),
      await dispatch(t, 'memory_lab_subtag_tree', { tag: '#boundary-not-here' }, 'NOT_FOUND, naming the tag, with the roots beside it'),
      await dispatch(t, 'memory_lab_subtag_tree', { tag: '   ' }, 'a blank tag: the body refuses, so no value reaches the boundary'),
      await dispatch(t, 'memory_lab_reindex', {}, 'the 0.2.2 defect shape: a rebuild receipt'),
      await dispatch(t, 'memory_lab_tag_review', {}, 'the review, with the judgement request beside it'),
      await dispatch(
        t,
        'memory_lab_tag_apply',
        { decisions: [{ kind: 'set-tags', slug: 'output-boundary-probe', tags: ['#boundary'] }], dryRun: true },
        'the apply receipt, as a dry run: writes nothing',
      ),
      /* The SAME tool refusing. Its body throws, so no value ever reaches the boundary — and the
       * check below asserts this is reported as a throw and not as a rejection, because
       * conflating the two is the whole mistake this gate exists to prevent. */
      await dispatch(t, 'memory_lab_tag_apply', { decisions: [], dryRun: true }, 'the same tool refusing: its body throws'),
      await dispatch(t, 'memory_lab_delete', { component: 'output-boundary-probe' }, 'the delete receipt'),
    ].forEach(show);

    /* ---- the CYCLE finding, which is a new shape and therefore a new place for `undefined` ----
     *
     * Every release that has met this boundary met it on a value nobody had walked before —
     * `memory_lab_reindex`'s success path (0.2.2), `agent_api_send`'s event log (0.2.8) — so a
     * finding kind added to `memory_lab_tag_review` is exactly the place to look next. The review
     * dispatched above walks a store with no cycle in it, so the shape is planted here: a
     * two-node cycle written straight into this gate's THROWAWAY `index.json`, reviewed through
     * the registry, and walked by DSH's own walker.
     *
     * The store is left as it was found: the component this needs is deleted after the dispatch,
     * and the original index bytes are written back. Nothing below this line sees the fixture. */
    /* The store BOTH fixtures are undone back to.
     *
     * Not "the bytes before the fixture": a file read in this process can come back one write
     * stale, which is how the first version of this block captured an EMPTY index and then
     * "restored" the store to nothing, so the two fixture components were missing when their
     * delete ran. The baseline is therefore MEASURED instead of remembered — the fixtures are
     * created, this exact state is captured, and then the baseline is what is left after the same
     * two components are deleted through the tool. There is no cache to be stale about a state
     * that was just produced by the store itself. */
    const storeIndex = join(TEMP_ROOT, 'Memory Lab', 'index.json');
    await dispatch(
      t,
      'memory_lab_update',
      {
        name: 'Boundary Cycle Fixture',
        tags: ['#boundary-cycle-a'],
        tagPaths: [['#boundary-cycle-a'], ['#boundary-cycle-a', '#boundary-cycle-b']],
        content: '# Boundary Cycle Fixture\n\nPlanted so the cycle finding can be walked. Deleted before the gate ends.\n',
        reason: 'the boundary gate needs the cycle finding to have a component behind it',
        source: 'verify-tool-output-boundary.mjs',
      },
      'a fixture the cycle finding can be about',
    );
    /* A SECOND fixture, carrying BOTH tags: the two-tag cycle above lives in the stored graph,
     * and this one lives in the EVIDENCE — every component carrying `#boundary-mutual-a` also
     * carries something filed under `#boundary-mutual-b` and the other way round, which is what
     * makes two roots each other's candidate parent. */
    await dispatch(
      t,
      'memory_lab_update',
      {
        name: 'Boundary Mutual Fixture',
        tags: ['#boundary-mutual-a', '#boundary-mutual-b'],
        tagPaths: [['#boundary-mutual-a'], ['#boundary-mutual-b']],
        content: '# Boundary Mutual Fixture\n\nPlanted so the candidate-mutual finding can be walked. Deleted before the gate ends.\n',
        reason: 'the boundary gate needs the candidate-mutual finding to have components behind it',
        source: 'verify-tool-output-boundary.mjs',
      },
      'the pair the candidate-mutual finding is about',
    );
    const plantedIndex = JSON.parse(readFileSync(storeIndex).toString('utf8'));
    const cycleSlug = Object.keys(plantedIndex.components || {}).find((slug) => plantedIndex.components[slug].tags?.includes('#boundary-cycle-a'));
    let plantedBytes = readFileSync(storeIndex);
    if (cycleSlug) {
      plantedIndex.tags = plantedIndex.tags || {};
      plantedIndex.tags['#boundary-cycle-a'] = {
        parents: ['#boundary-cycle-b'],
        children: ['#boundary-cycle-b'],
        components: [cycleSlug],
        aliases: [],
      };
      plantedIndex.tags['#boundary-cycle-b'] = {
        parents: ['#boundary-cycle-a'],
        children: ['#boundary-cycle-a'],
        components: [cycleSlug],
        aliases: [],
      };
      writeFileSync(storeIndex, JSON.stringify(plantedIndex, null, 2), 'utf8');
      /* The bytes the review is about to be handed — captured, so "the review wrote nothing" is a
       * comparison against the PLANTED file rather than against itself. */
      plantedBytes = readFileSync(storeIndex);
      const cycleReview = await dispatch(t, 'memory_lab_tag_review', { kinds: ['cycle-candidate'] }, 'the cycle finding, the shape added by 解环判定');
      show(cycleReview);
      const afterReviewBytes = readFileSync(storeIndex);
      const findings = Array.isArray(cycleReview.value?.findings) ? cycleReview.value.findings : [];
      const stored = findings.find((finding) => finding?.evidence?.shape === 'stored-cycle');
      const mutual = findings.find((finding) => finding?.evidence?.shape === 'candidate-mutual');
      record(
        "the stored-cycle finding crosses the output boundary: shape, ring, edges, direction and options all survive DSH's walker",
        cycleReview.kind === 'returned' &&
          cycleReview.report?.ok === true &&
          stored !== undefined &&
          Array.isArray(stored.evidence.cycle) &&
          stored.evidence.cycle.length === 3 &&
          stored.evidence.cycle[0] === stored.evidence.cycle[2] &&
          Array.isArray(stored.evidence.edges) &&
          stored.evidence.edges.length === 2 &&
          Array.isArray(stored.evidence.normalizerDrops) &&
          typeof stored.evidence.suggestedCut?.parent === 'string' &&
          stored.evidence.direction !== null &&
          Array.isArray(stored.evidence.direction.basis) &&
          Array.isArray(stored.options) &&
          stored.options.length === 2 &&
          stored.options.every((option) => option.kind === 'cut'),
        `cycle=${stored ? JSON.stringify(stored.evidence.cycle) : '(absent)'} ` +
          `report=${cycleReview.report ? (cycleReview.report.ok ? 'accepted' : `rejected at ${cycleReview.report.path}`) : '(none)'}`,
      );
      record(
        "the candidate-mutual finding crosses the output boundary too: the other shape of the same kind",
        mutual !== undefined &&
          Array.isArray(mutual.evidence.pair) &&
          mutual.evidence.pair.length === 2 &&
          Array.isArray(mutual.evidence.candidates) &&
          mutual.evidence.candidates.length === 2 &&
          mutual.evidence.direction !== null &&
          typeof mutual.evidence.direction.coOccurrenceOnly === 'boolean' &&
          Array.isArray(mutual.evidence.direction.why) &&
          mutual.evidence.direction.why.length > 0 &&
          Array.isArray(mutual.options) &&
          mutual.options.length > 0,
        `pair=${mutual ? JSON.stringify(mutual.evidence.pair) : '(absent)'} ` +
          `direction=${mutual ? JSON.stringify({ moreGeneral: mutual.evidence.direction.moreGeneral, decided: mutual.evidence.direction.directionDecided }) : '(none)'}`,
      );
      record(
        'the cycle review is read-only: the planted index.json is byte-identical after the dispatch',
        afterReviewBytes.equals(plantedBytes),
        `${plantedBytes.length} byte(s) planted, ${afterReviewBytes.length} byte(s) after the review`,
      );
    }
    writeFileSync(storeIndex, plantedBytes);
    /* Both fixtures go through the tool, so the store the rest of this gate walks is the one it
     * was walking before them. The baseline is the state the two deletes leave behind. */
    const cycleRemoved = await dispatch(t, 'memory_lab_delete', { component: 'boundary-cycle-fixture' }, 'the first fixture removed again');
    const mutualRemoved = await dispatch(t, 'memory_lab_delete', { component: 'boundary-mutual-fixture' }, 'the second fixture removed again');
    const storeAfter = JSON.parse(readFileSync(storeIndex).toString('utf8'));
    const fixturesGone = !storeAfter.components?.['boundary-cycle-fixture'] && !storeAfter.components?.['boundary-mutual-fixture'];
    const noPlantedTags = !Object.keys(storeAfter.tags || {}).some((tag) => tag.startsWith('#boundary-'));
    record(
      'both fixtures are gone again, through the tool, so the store the rest of the gate walks holds no planted cycle',
      fixturesGone && noPlantedTags && cycleRemoved.kind === 'returned' && mutualRemoved.kind === 'returned',
      `deletes: ${cycleRemoved.kind}/${mutualRemoved.kind}; components now: ${JSON.stringify(Object.keys(storeAfter.components || {}))}; ` +
        `tags now: ${Object.keys(storeAfter.tags || {}).join(', ') || '(none)'}`,
    );

    /* ---- computeruse: only the actions that capture nothing and deliver no input ----
     *
     * `observe` and `app_observe` in virtual mode return `virtualRefusal` at the first statement
     * of their action (`lib/win32.js:3314-3317`, `:3340-3343`), before any lane exists — a fact
     * read from the backend rather than inferred from a green line. Everything else here is a
     * lease/state query, a pacing sleep, or a refusal raised before the lane. */
    say('\n  -- computer_use (the read-only actions only; see NOT_DISPATCHED) --');
    [
      await dispatch(t, 'computer_use', { action: 'mode_report' }, 'lease and mode, no lane'),
      await dispatch(t, 'computer_use', { action: 'mode_report', mouse_mode: 'virtual' }, 'the same, with a requested mode'),
      await dispatch(t, 'computer_use', { action: 'wait', duration_ms: 0 }, 'pacing, no lane'),
      await dispatch(t, 'computer_use', { action: 'move' }, 'refused: point_required, before any lane'),
      await dispatch(t, 'computer_use', { action: 'click' }, 'refused: point_required'),
      await dispatch(t, 'computer_use', { action: 'drag' }, 'refused: drag_points_required'),
      await dispatch(t, 'computer_use', { action: 'scroll', x: 1, y: 1 }, 'refused: scroll_delta_required'),
      await dispatch(t, 'computer_use', { action: 'observe', mouse_mode: 'virtual' }, 'virtualRefusal at the first statement: no capture'),
      await dispatch(t, 'computer_use', { action: 'app_observe', mouse_mode: 'virtual' }, 'virtualRefusal at the first statement: no capture'),
    ].forEach(show);

    /* ---- the registries that exist only to produce a service-absence envelope ---- */
    say('\n  -- agent_api_send with a service absent (its own registries) --');
    const noLlm = await mountAgentApiOnly({ llm: undefined, core });
    const noLlmFact = await dispatch(noLlm.tools, 'agent_api_send', { prompt: 'x' }, 'no llm service in this scope');
    show(noLlmFact);
    say(`      code=${noLlmFact.value?.code} exit=${noLlmFact.value?.exit}`);

    const noCore = await mountAgentApiOnly({ llm: scriptedLlm({}), core: undefined });
    const noCoreFact = await dispatch(noCore.tools, 'agent_api_send', { prompt: 'x' }, 'no core service in this scope');
    show(noCoreFact);
    say(`      code=${noCoreFact.value?.code} exit=${noCoreFact.value?.exit}`);

    /* The capped run: a model that always asks for a tool, and `max_steps: 1`, so the component
     * answers its exit-4 `max_steps` envelope — the FAILURE shape, which puts `events` in `extra`
     * rather than beside `result`. A different shape, and the same boundary. */
    const capped = await mountAgentApiOnly({ llm: alwaysToolLlm(), core, maxSteps: 1 });
    capRun = await dispatch(
      capped.tools,
      'agent_api_send',
      { prompt: 'keep going', max_steps: 1, timeout_ms: 30000 },
      'the exit-4 max_steps envelope',
    );
    show(capRun);
    const capEnvelope = capRun.value;
    say(`      envelope: ${JSON.stringify({ ok: capEnvelope?.ok, route: capEnvelope?.route, exit: capEnvelope?.exit, code: capEnvelope?.code ?? undefined })}`);
    say(`      events:   ${JSON.stringify(capEnvelope?.events ?? null)}`);
    record(
      'agent_api_send answered an exit-4 envelope, and its event log crossed the boundary too',
      capRun.isError === false &&
        capEnvelope?.ok === false &&
        capEnvelope?.exit === 4 &&
        Array.isArray(capEnvelope?.events) &&
        capEnvelope.events.length > 0 &&
        capEnvelope.events.every(
          (event) => event !== null && typeof event === 'object' && (event.turn === null || typeof event.turn === 'number'),
        ),
      `ok=${capEnvelope?.ok} exit=${capEnvelope?.exit} code=${capEnvelope?.code} events=${capEnvelope?.events?.length ?? '-'}` +
        `${capRun.errorMessage ? ` :: ${capRun.errorMessage}` : ''}`,
    );
    record(
      'the capped run really reached its step cap rather than failing for another reason',
      capEnvelope?.code === 'max_steps' && capEnvelope?.result === undefined,
      `code=${capEnvelope?.code} has result=${capEnvelope?.result !== undefined} error=${JSON.stringify(capEnvelope?.error ?? null)}`,
    );

    /* Every bundle tool is judged at least once, or is an exception this file names. */
    const judgedTools = new Set(DISPATCHES.map((fact) => fact.name));
    const missing = declared.filter((name) => !judgedTools.has(name));
    const unjudged = missing.filter((name) => !exceptedNames.has(name));
    record(
      `every tool the bundle registers is either dispatched here or named as an exception (${declared.length} tools)`,
      unjudged.length === 0,
      unjudged.length === 0
        ? `dispatched: ${declared.filter((name) => judgedTools.has(name)).join(', ')} | excepted: ${missing.join(', ') || '(none)'}`
        : `never dispatched and not excepted: ${unjudged.join(', ')}`,
    );

    /* THE THREE CLASS ASSERTIONS. Everything above is colour; these are the boundary. */
    const rejects = DISPATCHES.filter((fact) => fact.kind === 'rejected');
    const throwsFromBody = DISPATCHES.filter((fact) => fact.kind === 'threw');
    const invalidOutput = DISPATCHES.filter((fact) => fact.errorCode === 'INVALID_TOOL_OUTPUT');
    const describe = (fact) =>
      `${fact.name}${fact.args?.action ? `/${fact.args.action}` : ''}: ${fact.errorCode} ${fact.errorName} :: ${fact.errorMessage}`;

    record(
      `no dispatched value was REJECTED by the registry (${DISPATCHES.length} dispatches, no INVALID_TOOL_OUTPUT)`,
      rejects.length === 0 && invalidOutput.length === 0,
      rejects.length === 0 && invalidOutput.length === 0
        ? `${DISPATCHES.length} dispatches: ${DISPATCHES.length - throwsFromBody.length} returned a value the registry accepted, ` +
          `${throwsFromBody.length} body/all throws (no value reached the boundary)`
        : [...rejects, ...invalidOutput].map(describe).join(' | '),
    );
    const lossy = DISPATCHES.filter((fact) => fact.kind !== 'threw' && (fact.report === null || fact.report.ok === false));
    record(
      `every value a tool body returned is lossless JSON under DSH's own walker (${DISPATCHES.length - throwsFromBody.length} values)`,
      lossy.length === 0,
      lossy.length === 0
        ? `all ${DISPATCHES.length - throwsFromBody.length} returned values accepted; ${SINK.length} body returns recorded underneath them` +
          (throwsFromBody.length > 0 ? `; bodies that threw and so returned nothing: ${throwsFromBody.map((fact) => fact.name).join(', ')}` : '')
        : lossy.map((fact) => `${fact.name}: ${fact.report ? describeReport(fact.report) : 'no value was recorded'}`).join(' | '),
    );
    /* A body that throws is NOT the defect class, and this check is what keeps the two apart: it
     * fails if a throw is ever reported with the boundary's own code, which would mean a value was
     * rejected and the gate had filed it as a refusal. */
    record(
      'a tool body that throws is reported as a throw, never as a boundary rejection',
      throwsFromBody.every((fact) => fact.errorCode !== 'INVALID_TOOL_OUTPUT') &&
        throwsFromBody.every((fact) => typeof fact.errorMessage === 'string' && fact.errorMessage.length > 0),
      throwsFromBody.length > 0
        ? throwsFromBody.map((fact) => `${fact.name}: ${fact.errorCode || '(no code)'} :: ${fact.errorMessage}`).join(' | ')
        : 'no dispatch exercised the throw path, so this distinction is untested by this run',
    );
  }

  /* ---- PHASE 3: the counterfactual, so the two class checks cannot be vacuous ---- */
  if (wants('counterfactual')) {
    say('\n=== PHASE 3 — a planted undefined, on the same real registry ===');
    const plantedPath = '$.result.receipt.planted';
    /* Registered THROUGH the recording registry, so the raw value is captured even though the
     * registry will throw it away. */
    bundle.tools.register({
      name: 'boundary_counterfactual',
      description: 'output-boundary gate counterfactual: returns a value carrying a planted undefined on purpose',
      parameters: { type: 'object', properties: {}, required: [] },
      output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() {
        return { ok: true, result: { receipt: { rebuilt: true, planted: undefined } } };
      },
    });
    const fact = await dispatch(bundle.tools, 'boundary_counterfactual', {}, 'the planted value');
    show(fact);
    record(
      'a planted undefined IS rejected by this registry, with INVALID_TOOL_OUTPUT',
      fact.isError === true && fact.errorCode === 'INVALID_TOOL_OUTPUT',
      `isError=${fact.isError} code=${fact.errorCode || '-'} name=${fact.errorName || '-'} :: ${fact.errorMessage || '(no message)'}`,
    );
    record(
      'and the gate files it as a REJECTION, not as a body that threw',
      fact.kind === 'rejected',
      `kind=${fact.kind} recorded=${fact.recorded} — a rejection is the body answering and the registry refusing the answer`,
    );
    record(
      'and this gate names the field that killed it, at its full path',
      fact.report !== null && fact.report.ok === false && fact.report.path === plantedPath,
      fact.report ? `${fact.report.path}: ${fact.report.reason}` : 'no value was recorded, so no path could be reported',
    );
    note(
      'if the registry had accepted that value, the two class assertions above would be vacuous — which is why ' +
        'this phase is part of the gate and not only of its mutation harness',
    );
  }

  /* ---- the exceptions, held to the gate they name ---- */
  {
    say('\n=== the tools this gate does not dispatch, and the gate that covers them ===');
    const wrong = [];
    for (const entry of NOT_DISPATCHED) {
      const target = join(HERE, entry.coveredBy);
      if (!existsSync(target)) {
        wrong.push(`${entry.tool}: ${entry.coveredBy} does not exist`);
        continue;
      }
      const source = readFileSync(target, 'utf8');
      const dispatches = source.split(`name: '${entry.tool}'`).length - 1;
      if (dispatches === 0) wrong.push(`${entry.tool}: ${entry.coveredBy} dispatches it nowhere`);
      else say(`    ${entry.tool} -> ${entry.coveredBy} dispatches it in ${dispatches} place(s)`);
    }
    record(
      'every tool this gate does not dispatch is dispatched by the gate its exception names',
      wrong.length === 0,
      wrong.length === 0 ? NOT_DISPATCHED.map((entry) => entry.tool).join(', ') : wrong.join(' | '),
    );
  }

  /* ---- the acceptance gate's own hole, held shut by a check on its source ---- */
  {
    say('\n=== the acceptance gate: rounds 2 and 3 must reach agent_api_send THROUGH the registry ===');
    const livePath = join(HERE, 'verify-agent-api-live.mjs');
    const source = existsSync(livePath) ? readFileSync(livePath, 'utf8') : '';
    const slice = (startMarker, endMarker) => {
      const at = source.indexOf(startMarker);
      if (at === -1) return '';
      const end = source.indexOf(endMarker, at);
      return end === -1 ? source.slice(at) : source.slice(at, end);
    };
    const round2 = slice('async function round2Conversation', '\n/* ===');
    const round3 = slice('async function round3ToolCall', '\n/* ===');
    const throughRegistry = (body) => body.includes("await dispatchTool(tools, 'agent_api_send'");
    /* The forms the deleted helper used, tested as INVOCATIONS: a comment may still name it, and
     * should, because the comment is what says why it must not come back. */
    const directDefinitionDispatch = [...source.matchAll(/definition\.execute\(|api\.tools\(\)\.find\(/g)].length;
    const detail = [
      `round2: ${throughRegistry(round2) ? 'dispatchTool -> ctx.tools.execute' : 'NOT through the registry'}`,
      `round3: ${throughRegistry(round3) ? 'dispatchTool -> ctx.tools.execute' : 'NOT through the registry'}`,
      `direct definition dispatches left in the file: ${directDefinitionDispatch}`,
    ];
    say(`    ${detail.join(' | ')}`);
    record(
      'the acceptance gate dispatches agent_api_send through the registry in both rounds, and holds no direct-execute path',
      throughRegistry(round2) && throughRegistry(round3) && directDefinitionDispatch === 0,
      detail.join(' | '),
    );
  }

  /* ---- the user's one hard constraint on where this gate may write ---- */
  {
    say("\n=== nothing under the Newmark root, except through the plugin's own tools ===");
    const after = digestTree(LIVE_ROOT);
    record(
      'the live Newmark store is byte-identical after the whole gate ran',
      after === LIVE_BEFORE,
      after === LIVE_BEFORE ? `sha256 ${after} (before and after)` : `before ${LIVE_BEFORE} -> after ${after}`,
    );
  }

  /* ================================= summary ================================= */
  say('\n=== SUMMARY ===');
  const failed = RESULTS.filter((entry) => !entry.ok);
  for (const entry of RESULTS) say(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);
  const passed = RESULTS.length - failed.length;

  const receipt = {
    gate: 'verify-tool-output-boundary',
    finishedAt: new Date().toISOString(),
    walker: walker.path,
    phases: PHASES,
    tempRoot: TEMP_ROOT,
    liveRoot: LIVE_ROOT,
    declaredTools: declared,
    registeredTools: registered,
    notDispatched: NOT_DISPATCHED,
    passed,
    failed: failed.map((entry) => entry.name),
    checks: RESULTS,
    dispatches: DISPATCHES.map((fact) => ({
      name: fact.name,
      args: fact.args,
      note: fact.note,
      ms: fact.ms,
      threw: fact.threw,
      kind: fact.kind,
      isError: fact.isError,
      errorCode: fact.errorCode,
      errorName: fact.errorName,
      errorMessage: fact.errorMessage,
      recorded: fact.recorded,
      nestedCalls: fact.nestedCalls,
      value: fact.value,
      valueLossless: fact.report ? fact.report.ok : null,
      valuePath: fact.report && !fact.report.ok ? fact.report.path : null,
      valueReason: fact.report && !fact.report.ok ? fact.report.reason : '',
    })),
    bodyReturnsRecorded: SINK.length,
    liveStoreDigestBefore: LIVE_BEFORE,
    liveStoreDigestAfter: digestTree(LIVE_ROOT),
  };
  const receiptPath = join(SCRATCH, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');

  for (const entry of bundle.effects.slice().reverse()) {
    try {
      entry.dispose?.();
    } catch {
      /* a disposal failure is not a gate failure */
    }
  }

  say(`\n${passed} passed, ${failed.length} failed`);
  say(`receipt: ${receiptPath}`);
  if (failed.length > 0) {
    say(`FAILED: ${failed.map((entry) => entry.name).join(' | ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  say(`\nthe gate itself failed: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`);
  say(String(error?.stack ?? '').split('\n').slice(0, 12).join('\n'));
  if (error?.code === 'DSH_INSTALL_ABSENT' || error?.code === 'WALKER_ABSENT') {
    say("PREMISE ABSENT: this check measures DSH's own output boundary and cannot be run without the installation.");
  }
  process.exit(2);
});
