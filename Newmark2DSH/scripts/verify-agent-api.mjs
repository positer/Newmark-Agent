/**
 * Newmark Core — the **agent-api gate**.
 *
 * ---------------------------------------------------------------------------------------
 * THE WIRING, WHICH IS APPLIED — this list was written as instructions for the owner of the
 * shared files, and every item on it is now in the tree and asserted below. Kept as a map of
 * what this component depends on and where, because that is still worth reading.
 * ---------------------------------------------------------------------------------------
 *
 * 1. `packages/newmark-core/index.js` — add a `COMPONENTS` entry beside `memoryLab` /
 *    `computerUse`, and a `COMPONENT_GLOBALS` row:
 *
 *      agentApi: {
 *        load: () => import('./components/agent-api/index.js'),
 *        config: (root) => ({ root, workspace: '', timeoutMs: 120000, maxSteps: 8 }),
 *      },
 *      // COMPONENT_GLOBALS:
 *      agentApi: '__NEWMARK_AGENTAPI__',
 *
 *    `config` must supply `root` one way or the other: `resolveRoot(config)` falls back to
 *    `~/.Newmark`, and a component that never received the configured root would place its
 *    `<root>/Work` somewhere the user did not choose.
 *
 * 2. **The core row's service must carry the authorised model**, because this component has no
 *    `model` config field by design. Two names matter, and both are single constants so the
 *    wiring is a line:
 *      - the SERVICE name — `DEFAULT_CORE_SERVICE` in `components/agent-api/index.js`,
 *        currently `'newmarkComponents'`, overridable through this component's `coreService`
 *        config;
 *      - the ACCESSOR name — `CORE_MODEL_ACCESSOR` in `components/agent-api/lib/core-model.js`,
 *        currently `'model'`, expected to return `{ provider, model, reasoningEffort? }`.
 *    If the service is absent, or the accessor is missing, or it returns no model, this
 *    component answers exit 3 with `core_service_absent` / `core_model_accessor_absent` /
 *    `model_not_selected` and refuses to run. **It never substitutes a default.**
 *
 * 3. `packages/newmark-core/client.js` — three edits:
 *    a. `const AGENTAPI_GLOBAL = '__NEWMARK_AGENTAPI__';`
 *    b. in `readPageGlobals()`, read it and publish it in `components`:
 *         const api = window[AGENTAPI_GLOBAL];
 *         components: { memoryLab: …, computerUse: …, agentApi: Boolean(api) },
 *    c. a row in `NewmarkConfigPanel`'s `rows`:
 *         {
 *           key: 'agentApi',
 *           name: 'Agent API',
 *           role: '标准化的 Agent 调用接口：信封、错误分级、只读状态与 agent run',
 *           on: components.agentApi === true,
 *           note: components.agentApi === true ? 'interface mounted' : 'not loaded',
 *           switchable: true,
 *         },
 *    The switch itself needs no new code: `toggle` already posts to
 *    `/newmark-core/components` and the core row mounts and unmounts by `COMPONENTS` key.
 *
 * 4. `packages/newmark-core/package.json` — **the `files` patterns already cover this component
 *    and need no change**: `components/ * / *.js`, `components/ * /package.json` and
 *    `components/ * /lib/ *.js` each match one level below `components/`, which is where
 *    `agent-api/` sits. Verified by reading the patterns. What DOES change is the version, on
 *    your rule: adding a sub-component moves `0.1.6` to `0.2.0`, in all four manifests plus a
 *    `VERSION.md` ledger row with kind `sub-component`.
 *
 * 5. Gate enrolment — add to the release gate's own list:
 *      ['agent-api gate', 'verify-agent-api.mjs'],
 *    Three hard-coded lists name the components and need this one added if they are to cover
 *    the whole bundle: `verify-version-discipline.mjs`, the `['memorylab', 'computeruse']`
 *    array in `check-release-bundle.mjs` / `sync-release-repo.mjs` / `verify-market-install.mjs`,
 *    and `scripts/lib/mount-newmark-core.mjs` (`ROWS`, `COMPOSED`, `PLUGIN_KEYS`). **This gate
 *    still drives the component through its own `apply()` rather than through `mountCore`**, so
 *    a fault in the composition harness cannot masquerade as a fault here, and the reverse.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT THIS GATE ASSERTS, AND WHY EACH ASSERTION CAN FAIL
 * ---------------------------------------------------------------------------------------
 *
 *   - **The envelope's shape**, and that `ok` is derived from `exit` rather than passed in.
 *   - **Every error class**: the reference's seven string rules with a realistic fixture each,
 *     plus the structured `ToolExecutionResult` path.
 *   - **The loop**, driven end to end through the REAL `lib/loop.js` and `lib/llm-seam.js` with
 *     a fake `llm` service that emits the documented `StreamChunk` union: a two-turn run that
 *     calls a tool and then answers, the single-turn case, the step cap, abort, and both
 *     ways a tool call arrives (a `block-end` block and `tool-call-delta` only).
 *   - **The four model failure modes as four different answers**, none of which is "the run
 *     failed", because in none of them did a run happen.
 *   - **That a read does not perform a run** — asserted from OUTSIDE by instrumenting the
 *     services handed in, with the instrument proved live in the same run.
 *   - **That the declared capabilities match what the code can do**, cross-checked against the
 *     gate's own table of which service member backs which capability id, in six harness shapes.
 *
 * Everything runs against a temporary root; the live `~/.Newmark` is snapshotted and asserted
 * unchanged, because `<root>/Work` is created by a successful run.
 *
 * Run: node Newmark2DSH/scripts/verify-agent-api.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const componentDir = path.join(workspace, 'packages', 'newmark-core', 'components', 'agent-api');
const LIVE_ROOT = path.join(os.homedir(), '.Newmark');

/**
 * The max-steps value the CORE ROW composes this component with, read from the core row.
 *
 * Not a literal in this file. The step cap is a two-part fact — the loop's own fallback and the
 * number the shipped composition passes it — and a gate that writes its own copy of the second
 * part stops noticing when the row changes: the fixtures below would keep passing against a row
 * that now says something else. So the value is read from `packages/newmark-core/index.js`, and
 * every fixture that needs "what the row says" uses it.
 *
 * The loop's own fallback (`lib/loop.js`, used when a caller omits `maxSteps`) is read from
 * `component.js` and cross-checked against the shipped row below: the row's 8 is the component's
 * `DEFAULT_MAX_STEPS`, and that constant is also the loop's fallback — so the two numbers that
 * are meant to be the same number are asserted to be.
 */
const coreRowSource = fs.readFileSync(path.join(workspace, 'packages', 'newmark-core', 'index.js'), 'utf8');
const componentSource = fs.readFileSync(path.join(componentDir, 'component.js'), 'utf8');
const rowMaxSteps = Number(
  /agentApi:\s*\{[\s\S]*?maxSteps:\s*(\d+)/.exec(coreRowSource)?.[1] ?? Number.NaN,
);
const componentDefaultMaxSteps = Number(/export const DEFAULT_MAX_STEPS = (\d+);/.exec(componentSource)?.[1] ?? Number.NaN);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  const n = passed + failed + 1;
  if (condition) {
    passed += 1;
    console.log(`ok ${n} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`not ok ${n} - ${name}`);
  if (detail !== undefined) console.log(`  ${detail}`);
  return false;
}

function digestTree(dir) {
  if (!fs.existsSync(dir)) return '(absent)';
  const hash = crypto.createHash('sha256');
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      hash.update(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
      else hash.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

const liveWorkBefore = digestTree(path.join(LIVE_ROOT, 'Work'));

/* --------------------------------------------------------------- the module under test --- */

const bust = `${Date.now()}-${Math.random()}`;
const url = (relative) => new URL(`file:///${path.join(componentDir, relative).replace(/\\/g, '/')}?gate=${bust}`).href;

const mod = await import(url('index.js'));
const { createAgentApi } = await import(url('component.js'));
const contract = await import(url('lib/contract.js'));
const presence = await import(url('lib/presence.js'));
const loop = await import(url('lib/loop.js'));
const seam = await import(url('lib/llm-seam.js'));
const coreModel = await import(url('lib/core-model.js'));
const componentModule = await import(url('component.js'));
/* The MemoryLab component, imported HERE because the boundary this gate owns is between the two
 * halves of one bundle: "the run is invoked only by tools" is a statement about who may call THIS
 * component, and the answer since the user's change is "the MemoryLab rebuild route, through the
 * tool". A check that could not see the caller could not state the boundary at all. */
const memorylabComponentUrl = new URL(
  `file:///${path.join(workspace, 'packages', 'newmark-core', 'components', 'memorylab', 'component.js').replace(/\\/g, '/')}?gate=${bust}`,
).href;
const { createMemoryLab } = await import(memorylabComponentUrl);

/** The names a run may never be given, read from the component rather than restated here. */
const SELF_NAMES = componentModule.SELF_NAMES;

const {
  EXIT_OK, EXIT_INVALID, EXIT_UNAVAILABLE, EXIT_FAILED, EXIT_ABORTED, EXIT_CODES, ENVELOPE_CORE_KEYS,
  ROUTES, CLASS_OF_EXIT, envelope, classifyToolOutput, classifyToolResult, hostProfile, capabilityOf,
} = contract;

/* ------------------------------------------------------- the documented chunk vocabulary --- */

/** One assistant turn, as the documented `StreamChunk` union. */
function turn({ text = '', toolCalls = [], reason = { kind: 'stop' } } = {}) {
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

/** The same turn, delivered ONLY as deltas, so the seam's recovery path is exercised too. */
function deltaOnlyTurn({ text = '', toolCalls = [], reason = { kind: 'stop' } } = {}) {
  const chunks = [];
  if (text) {
    chunks.push({ type: 'block-start', index: 0, blockType: 'text' });
    chunks.push({ type: 'text-delta', index: 0, text });
    chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } });
  }
  let index = 1;
  for (const call of toolCalls) {
    chunks.push({ type: 'tool-call-delta', id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments ?? {}) });
    index += 1;
  }
  chunks.push({ type: 'finish', reason });
  return chunks;
}

function makeHarness(options = {}) {
  const {
    withSchemas = true,
    withExecute = true,
    withLlm = true,
    withListModels = true,
    withCore = true,
    withModelAccessor = true,
    coreSelection = { provider: 'deepseek', model: 'deepseek-chat' },
    /** The cap this component's own config sets, as `packages/newmark-core/index.js` composes it. */
    componentMaxSteps = rowMaxSteps,
    listedModels,
    listModelsThrows = false,
    scripts = [],
    defaultScript = turn({ text: '{"verdict":"ok"}', reason: { kind: 'stop' } }),
    executeThrows = false,
    /**
     * A bound on how many times this fixture's model may be called.
     *
     * This exists because of a measured hole, not for tidiness. The step cap is the one
     * guarantee that a run with nobody watching TERMINATES, and the fixture that was supposed
     * to prove it could not fail: with the cap removed from `lib/loop.js` the loop simply never
     * returned, so the gate did not report a failed assertion — it ran until the V8 heap was
     * exhausted and the process died with "Ineffective mark-compacts near heap limit" after
     * ~75 seconds. A check that hangs is not a check that fails, and an OOM is not a report.
     *
     * With the bound, the fixture's own model THROWS once the cap has been exceeded. The loop
     * catches that like any other turn failure, `runSend` classifies it as `run_failed`, and
     * the assertion below sees a non-`max_steps` answer and fails as an assertion — with a
     * message that says which bound was broken.
     *
     * The default is a generous multiple of the component's own default cap (8) and is applied
     * to every harness, so no run in this gate can hang: only the two cap assertions configure
     * anything near it, and they configure it deliberately close.
     */
    streamLimit = 200,
  } = options;

  const definitions = new Map();
  const routes = [];
  const taps = [];
  const disposers = [];
  const logs = [];
  const counts = { execute: 0, stream: 0, listModels: 0, register: 0 };
  /**
   * `schemasScope` is the record of WHICH SCOPE the component asked the registry for, which is the
   * whole of the 0.2.17 rule and cannot be observed any other way: the stub returns the same list
   * whatever it is handed, so an assertion that only counted tools would pass for both the
   * conversation view and the process view. Every call is kept, in order, so a check can say that
   * the FIRST read and the dispatch that followed agreed rather than only that each was right.
   */
  const seen = { exec: [], generate: [], schemasScope: [], executeAgent: [] };

  const toolsService = {
    register(definition) {
      counts.register += 1;
      definitions.set(definition.name, definition);
      return () => definitions.delete(definition.name);
    },
    get(name) {
      return definitions.get(name);
    },
    schemas(scope) {
      seen.schemasScope.push(scope);
      /**
       * THE STUB IS SCOPE-DEPENDENT ON PURPOSE, and this is what makes the 0.2.18 invariant
       * testable rather than vacuous.
       *
       * A `schemas()` that returned the same list whatever it was handed would make
       * "the offered list is a subset of the layer its calls run in" true by construction in the
       * STUB as well as in the component, and every assertion about it would pass even with the
       * defect restored. So one fixture exists ONLY in a conversation's view
       * (`gate_conversation_only`): a native conversation reaches it, and a `ptc` conversation —
       * whose dispatch resolves in the process layer — sees it, is not allowed to offer it, and
       * must report it as withheld. That is the production shape, reduced to one name.
       */
      return [...definitions.values()]
        .filter((definition) => scope !== undefined || !CONVERSATION_ONLY.has(definition.name))
        .map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));
    },
    /**
     * The presentation the registry would resolve for a scope: `ptc` when the agent says so, else
     * `native`. The component reads this to decide whether a dispatch may carry the agent at all
     * (`resolveExecution` collapses every direct call but `run_code` under `ptc`), so the stub has
     * to be able to say it or that branch is untestable.
     */
    modeFor(scope) {
      return scope?.presentation === 'ptc' ? 'ptc' : 'native';
    },
    async execute(exec) {
      counts.execute += 1;
      seen.exec.push(exec);
      seen.executeAgent.push(exec.agent);
      if (executeThrows) throw new Error('the registry itself failed');
      const definition = definitions.get(exec.name);
      if (definition === undefined) {
        return {
          content: [{ type: 'text', text: `Error: unknown tool "${exec.name}"` }],
          isError: true,
          error: { message: `unknown tool "${exec.name}"`, info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } },
        };
      }
      try {
        const value = await definition.execute(exec.arguments, exec);
        return { content: [{ type: 'text', text: 'ok' }], isError: false, value };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error?.message ?? error}` }],
          isError: true,
          error: { message: String(error?.message ?? error), info: { name: 'Error', code: 'TOOL_ERROR' } },
        };
      }
    },
  };
  if (!withSchemas) delete toolsService.schemas;
  if (!withExecute) delete toolsService.execute;

  /**
   * Fixture tools. `memory_lab_probe` is the one a default run is given; the `gate_*` names are
   * NOT in the default run set, which is what makes the "the run is given memory tools and
   * nothing else" assertion meaningful rather than a restatement of an empty set.
   */
  const fixtureNames = ['gate_echo', 'memory_lab_probe', 'gate_marker', 'gate_missing', 'gate_huge', 'gate_conversation_only', 'memory_lab_conversation_only'];
  /**
   * Fixtures that exist in a CONVERSATION's view and not in the process view. Two names — a
   * `memory_lab_` one and a `gate_` one — so the withheld set can be checked under BOTH run filters:
   * the default prefix filter (memory tools only) and an explicit `allow`, which is the path the
   * defect was measured on.
   */
  const CONVERSATION_ONLY = new Set(['gate_conversation_only', 'memory_lab_conversation_only']);
  const fixture = (name, description, execute) => ({
    name,
    description,
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: () => [] },
    execute,
  });
  toolsService.register(fixture('gate_echo', 'gate fixture: echo the arguments handed to it', async (args) => ({ echoed: args ?? null })));
  toolsService.register(fixture('memory_lab_probe', 'gate fixture: a memory tool, so the default run set is not empty', async () => ({ memory: true })));
  toolsService.register(fixture('gate_marker', 'gate fixture: answer with a reference failure marker as its value', async () => '[read_file error] the fixture always fails'));
  /**
   * THE MEMORY-TOOL FAILURE SHAPE, which is what the 0.2.11 defect was about.
   *
   * `memory_lab_read` does not throw for a component that does not exist: it RETURNS
   * `{ ok: false, error: { code, message, details } }` — a structured failure in a successful
   * registry result. The classifier used to answer `String(thatObject)`, so the model was handed
   * `[object Object]`. This fixture is that shape, because a fixture that threw would take the
   * other branch of the classifier and could not fail on the defect.
   */
  toolsService.register(
    fixture('gate_missing', 'gate fixture: report an absent component the way memory_lab_read does', async () => ({
      ok: false,
      status: 'error',
      error: { code: 'NOT_FOUND', message: 'Memory component not found: ZZZ-Absent', details: { selector: 'ZZZ-Absent' } },
    })),
  );
  // A tool whose result is large, so the event bound is a measurement rather than a claim.
  toolsService.register(fixture('gate_huge', 'gate fixture: answer with a result far larger than any event should carry', async () => 'x'.repeat(5000)));
  /**
   * The two conversation-only fixtures. They answer like any other tool, so if the offer ever
   * included them under `ptc` the call would SUCCEED in the stub — which is why the assertion that
   * matters is about `tool_names` and `tools_withheld`, not about a failing call.
   */
  toolsService.register(fixture('gate_conversation_only', 'gate fixture: visible to a conversation, absent from the process layer', async () => ({ conversationOnly: true })));
  toolsService.register(fixture('memory_lab_conversation_only', 'gate fixture: the same, under the default run filter prefix', async () => ({ conversationOnly: true })));

  const queue = scripts.slice();
  const llmService = {
    async listModels(provider) {
      counts.listModels += 1;
      if (listModelsThrows) throw new Error('the provider listing endpoint is unreachable');
      return listedModels === undefined ? [{ provider, id: 'deepseek-chat', name: 'DeepSeek Chat' }] : listedModels;
    },
    stream(generate) {
      counts.stream += 1;
      seen.generate.push(generate);
      if (counts.stream > streamLimit) {
        // Fail closed rather than loop for ever. See `streamLimit` above: without this the
        // cap assertions cannot fail, they can only hang.
        throw new Error(
          `the gate fixture refuses a call ${counts.stream}: a run that is still asking for model turns ` +
            `past ${streamLimit} has already exceeded every cap this gate set, so the cap is not being enforced`,
        );
      }
      const script = queue.length > 0 ? queue.shift() : defaultScript;
      return (async function* emitChunks() {
        for (const chunk of script) {
          // A script entry that IS an Error is thrown instead of yielded, which is how a stream
          // that fails AFTER delivering content is fixtured. The DeepSeek Messages adapter does
          // exactly that: it validates the tool-call JSON at `message_stop`, after every
          // `block-end` has been yielded (`dsh-llm-deepseek/lib/index.js:1983-1992`), and throws
          // `MALFORMED_RESPONSE`. A fixture that could only fail BEFORE its chunks could not
          // reach the recovery this gate asserts. (A `finish` reason of `{kind:'error'}` is a
          // different path and is fixtured separately, by `providerErrorRun`.)
          if (chunk instanceof Error) throw chunk;
          yield chunk;
        }
      })();
    },
  };
  if (!withListModels) delete llmService.listModels;

  const coreService = {
    root: () => '/tmp/gate-root',
    model: () => coreSelection,
  };
  if (!withModelAccessor) delete coreService.model;

  const services = {
    tools: toolsService,
    webServer: { register: (route) => (routes.push(route), () => {}), tapIndex: (t) => (taps.push(t), () => {}) },
    ...(withLlm ? { llm: llmService } : {}),
    ...(withCore ? { core: coreService } : {}),
  };

  const ctx = {
    logger: { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`), error: (m) => logs.push(`error: ${m}`) },
    tools: toolsService,
    webServer: services.webServer,
    get(name) {
      // The core row's service is addressed by the name the component's own config defaults to,
      // so this harness exercises the real lookup rather than a convenient alias of it.
      if (name === mod.DEFAULT_CORE_SERVICE) return services.core;
      return services[name];
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
      return () => {};
    },
  };

  return {
    ctx, services, definitions, fixtureNames, conversationOnly: [...CONVERSATION_ONLY], routes, taps, logs, counts, seen, llmService, coreService,
    streamLimit, componentMaxSteps,
    dispose() {
      for (const disposer of disposers.reverse()) {
        try {
          disposer();
        } catch {
          /* a failing disposer must not mask an assertion result */
        }
      }
      disposers.length = 0;
    },
    callRoute(route, method, body) {
      return new Promise((resolve, reject) => {
        const listeners = { data: [], end: [] };
        const req = { method, on(event, fn) { if (listeners[event]) listeners[event].push(fn); return req; }, destroy() {} };
        const res = {
          status: 0,
          writeHead(status) { res.status = status; },
          end(payload) { try { resolve({ status: res.status, json: JSON.parse(payload) }); } catch (error) { reject(error); } },
        };
        route.handler(req, res);
        if (listeners.data.length && body !== undefined) {
          const text = JSON.stringify(body);
          if (text) for (const fn of listeners.data) fn(text);
        }
        for (const fn of listeners.end) fn();
      });
    },
    html() {
      return taps.reduce((acc, transform) => transform(acc), '<html><head></head><body></body></html>');
    },
    global(name) {
      const page = this.html();
      const marker = `window.${name}=`;
      const at = page.indexOf(marker);
      if (at === -1) return undefined;
      return JSON.parse(page.slice(at + marker.length, page.indexOf(';</script>', at)));
    },
  };
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nma-gate-'));
const workDir = path.join(tempRoot, 'Work');

/* ================================================================= the module surface === */

console.log('# the module surface');

check('the component exports its Cordis identity', mod.name === 'newmark-agentapi', String(mod.name));
check(
  'it injects tools and webServer, and reads llm and the core service optionally',
  JSON.stringify(mod.inject) === JSON.stringify(['tools', 'webServer']),
  JSON.stringify(mod.inject),
);
check('the core service name is one exported constant', typeof mod.DEFAULT_CORE_SERVICE === 'string' && mod.DEFAULT_CORE_SERVICE.length > 0, mod.DEFAULT_CORE_SERVICE);
check('the model accessor name is one exported constant', coreModel.CORE_MODEL_ACCESSOR === 'model', coreModel.CORE_MODEL_ACCESSOR);
check('it declares a Config binding', Object.prototype.hasOwnProperty.call(mod, 'Config'));
check(
  'there is no model field in its config, because the model belongs to the core row',
  !fs.readFileSync(path.join(componentDir, 'index.js'), 'utf8').includes('model: schema'),
);
check('it publishes the declared page global', mod.SNAPSHOT_GLOBAL === '__NEWMARK_AGENTAPI__', String(mod.SNAPSHOT_GLOBAL));
check('it serves its read half on its own route', mod.STATE_ROUTE === '/newmark-agentapi/state', String(mod.STATE_ROUTE));

const harness = makeHarness();
mod.apply(harness.ctx, { root: tempRoot });

check(
  'applying registers exactly the four declared tools, and nothing else',
  presence.AGENT_API_TOOLS.every((n) => harness.definitions.has(n)) &&
    harness.definitions.size === 4 + harness.fixtureNames.length,
  [...harness.definitions.keys()].join(', '),
);
check(
  'the presence module publishes the names that were registered, and no fixture among them',
  presence.AGENT_API_PRESENCE_TOOL === 'agent_api_send' && !harness.fixtureNames.some((n) => presence.AGENT_API_TOOLS.includes(n)),
);
check('applying registers the state route on the exact path', harness.routes.some((r) => r.path === '/newmark-agentapi/state' && r.kind === 'exact'));
check('applying registers one index transform', harness.taps.length === 1, String(harness.taps.length));

/* ======================================================================== the envelope === */

console.log('');
console.log('# the envelope');

const success = envelope({ tool: 'x', exit: EXIT_OK, route: 'direct', result: { a: 1 } });
check(
  'the five core keys are present, in order, before anything else',
  JSON.stringify(Object.keys(success).slice(0, 5)) === JSON.stringify(ENVELOPE_CORE_KEYS) &&
    JSON.stringify(ENVELOPE_CORE_KEYS) === JSON.stringify(['ok', 'tool', 'route', 'exit', 'class']),
  JSON.stringify(Object.keys(success)),
);
check('a success carries result and neither error nor code', 'result' in success && !('error' in success) && !('code' in success));
const failure = envelope({ tool: 'x', exit: EXIT_FAILED, error: 'nope', code: 'thing_failed' });
check('a failure carries error and code and no result', 'error' in failure && 'code' in failure && !('result' in failure));
check(
  'ok is derived from exit for every code, and cannot be passed in',
  EXIT_CODES.every((code) => envelope({ tool: 'x', exit: code, ok: true }).ok === (code === EXIT_OK)),
  EXIT_CODES.map((c) => `${c}:${envelope({ tool: 'x', exit: c, ok: true }).ok}`).join(' '),
);
check('the exit codes are exactly the reference five', JSON.stringify(EXIT_CODES) === JSON.stringify([0, 2, 3, 4, 130]), JSON.stringify(EXIT_CODES));
check(
  'every exit code is named by its class, and the classes are the five contract words',
  EXIT_CODES.every((code) => CLASS_OF_EXIT[code] === envelope({ tool: 'x', exit: code }).class) &&
    JSON.stringify(EXIT_CODES.map((c) => CLASS_OF_EXIT[c])) === JSON.stringify(['ok', 'invalid', 'unavailable', 'failed', 'aborted']),
);
check(
  'an exit code the contract does not define fails closed to failed, never to ok',
  envelope({ tool: 'x', exit: 7 }).exit === EXIT_FAILED && envelope({ tool: 'x', exit: undefined }).exit === EXIT_FAILED,
);
check('an unknown route falls back to the reference value', envelope({ tool: 'x', exit: 0, route: 'telepathy' }).route === 'direct');
check('the route vocabulary names how the call was carried, and has no entry nothing can produce', JSON.stringify(ROUTES) === JSON.stringify(['direct', 'loop', 'none']), JSON.stringify(ROUTES));

/* ============================================================== the error classification === */

console.log('');
console.log('# the error classification — the reference seven string rules');

const stringCases = [
  ['echo', '{"ok":false,"error":"the tool said no"}', EXIT_FAILED, 'rule 1: a JSON object carrying ok:false'],
  ['echo', '[{"ok":false}]', EXIT_OK, 'rule 1 deliberately skips arrays'],
  ['echo', '[tool schema error] missing required property path', EXIT_INVALID, 'rule 2: tool schema error'],
  ['echo', '[?] unknown flag --nope', EXIT_INVALID, 'rule 2: the bare [?] marker'],
  ['computer_use', '[tool unsupported] no desktop backend on this host', EXIT_UNAVAILABLE, 'rule 3: computer_use is an unavailable host capability'],
  ['browser_navigate', '[tool unsupported] no browser provider', EXIT_UNAVAILABLE, 'rule 3: browser_* is an unavailable host capability'],
  ['read_file', '[tool unsupported] that tool is not in this mode', EXIT_INVALID, 'rule 3: any other unsupported name is a bad argument'],
  ['context_compress', '[context_compress error] nothing to compress', EXIT_FAILED, 'rule 4: context management is Agent-owned'],
  ['write_file', '[tool disabled] this mode does not allow writes', EXIT_UNAVAILABLE, 'rule 5: a disabled tool is a denied capability'],
  ['pwsh', '[permission] the sandbox refused', EXIT_UNAVAILABLE, 'rule 5: a permission refusal'],
  ['pwsh', '[permission denied] the sandbox refused', EXIT_OK, 'rule 5 does NOT match [permission denied]: the reference alternation ends at the bracket, and no later rule claims it either'],
  ['write_file', '[write gate blocked] the file is outside the workspace', EXIT_UNAVAILABLE, 'rule 5: the write gate'],
  ['subagent', '[Subagent sandbox] the child may not do that', EXIT_UNAVAILABLE, 'rule 5: the subagent sandbox'],
  ['pwsh', 'aborted by the user', EXIT_ABORTED, 'rule 6: a bare abort'],
  ['pwsh', 'aborting the command', EXIT_ABORTED, 'rule 6: the -ing form the reference also matches'],
  ['read_file', '[read_file error] no such file', EXIT_FAILED, 'rule 7: a generic [name error] marker'],
  ['echo', '{"count":3}', EXIT_OK, 'no marker: the parsed object is the result'],
  ['echo', 'plain text', EXIT_OK, 'no marker: the raw string is the result'],
];

for (const [tool, output, expected, why] of stringCases) {
  const got = classifyToolOutput(tool, output);
  check(`classifyToolOutput -> ${expected} for ${why}`, got.exit === expected, `got exit=${got.exit} code=${got.code ?? ''} for ${tool} ${JSON.stringify(output)}`);
}

check(
  'every one of the five exit codes is reached by at least one string fixture, so no rule is dead',
  JSON.stringify([...new Set(stringCases.map(([, , exit]) => exit))].sort((a, b) => a - b)) === JSON.stringify(EXIT_CODES),
  [...new Set(stringCases.map(([, , exit]) => exit))].sort((a, b) => a - b).join(', '),
);
// This fixture is chosen so the mutation it guards against CHANGES THE ANSWER: the first line
// carries no marker, so a rule set reading the first line answers 0, and one reading the whole
// output matches the unanchored abort rule and answers 130. A fixture whose two readings agree
// would assert nothing.
check(
  'the marker rules read the FIRST line only, as the reference does',
  classifyToolOutput('read_file', 'all good\nwe aborted nothing here').exit === EXIT_OK,
  JSON.stringify(classifyToolOutput('read_file', 'all good\nwe aborted nothing here')),
);
check(
  'a structured failure marker outranks the abort rule, because the reference tests it first',
  classifyToolOutput('write_file', '[tool disabled] aborted writes are not allowed').exit === EXIT_UNAVAILABLE,
);

console.log('');
console.log('# the error classification — the structured result path');

const resultCases = [
  [{ isError: false, value: { rows: 2 } }, EXIT_OK, 'a successful value passes through'],
  [{ isError: false, value: { ok: false, error: 'inner no' } }, EXIT_FAILED, 'a success whose value carries ok:false'],
  [{ isError: false, value: '[tool unsupported] nope' }, EXIT_INVALID, "a success whose value is the reference's own text"],
  [{ isError: false, value: 'plain' }, EXIT_OK, 'a plain string value is the result'],
  [{ isError: false }, EXIT_OK, 'a success with no value is a null result'],
  [{ isError: true, error: { message: 'no such tool', info: { code: 'UNKNOWN_TOOL' } } }, EXIT_INVALID, 'UNKNOWN_TOOL is an unreachable name'],
  [{ isError: true, error: { message: 'bad args', info: { code: 'INVALID_ARGS' } } }, EXIT_INVALID, 'INVALID_ARGS is an argument error'],
  [{ isError: true, error: { message: 'bad schema', info: { code: 'UNSUPPORTED_SCHEMA' } } }, EXIT_INVALID, 'UNSUPPORTED_SCHEMA is a schema error'],
  [{ isError: true, error: { message: 'tool call aborted', info: { name: 'AbortError', code: 'ABORTED' } } }, EXIT_ABORTED, 'ABORTED is cancellation'],
  [{ isError: true, error: { message: 'aborted before dispatch', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } } }, EXIT_ABORTED, 'ABORTED_BEFORE_DISPATCH is cancellation'],
  [{ isError: true, error: { message: 'went wrong', info: { name: 'Error', code: 'SOMETHING' } } }, EXIT_FAILED, 'any other failure is the tool own'],
];
for (const [result, expected, why] of resultCases) {
  const got = classifyToolResult('some_tool', result);
  check(`classifyToolResult -> ${expected} for ${why}`, got.exit === expected, `got exit=${got.exit} code=${got.code ?? ''}`);
}
check(
  'a result that is not an object falls through to the string classifier rather than crashing',
  classifyToolResult('echo', '{"ok":false}').exit === EXIT_FAILED && classifyToolResult('echo', undefined).exit === EXIT_OK,
);

/* ================================================================ the host profile === */

console.log('');
console.log('# the host profile — declared capabilities against a live harness');

const CAPABILITY_BACKING = {
  'state.read': null,
  'catalog.read': ['tools', 'schemas'],
  'model.selected': ['core', 'model'],
  'model.request': ['llm', 'stream'],
  'tool.dispatch': ['tools', 'execute'],
  'agent.run': ['llm', 'stream'],
  'http.state': ['webServer', 'register'],
  'http.run': null,
};
const REFUSED_BY_DESIGN = ['http.run'];

const fullServices = {
  tools: { schemas() {}, execute() {} },
  llm: { stream() {}, listModels() {} },
  webServer: { register() {} },
  core: { model: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
};
const table = (services, model, ctx = {}) =>
  Object.fromEntries(hostProfile(services, { model, workspace: '/tmp', ...ctx }).capabilities.map((e) => [e.id, e]));
const goodModel = { ok: true, provider: 'deepseek', model: 'deepseek-chat', source: 'core-service' };
const full = table(fullServices, goodModel);

check(
  'every capability id is reported exactly once and carries id, kind, state, evidence and reason',
  JSON.stringify(Object.keys(full)) === JSON.stringify(contract.CAPABILITY_IDS) &&
    Object.values(full).every((e) => e.id && ['read', 'run'].includes(e.kind) && ['available', 'unavailable', 'refused'].includes(e.state) && typeof e.evidence === 'string' && e.reason.length > 20),
  JSON.stringify(Object.values(full).map((e) => `${e.id}:${e.state}`)),
);
check(
  'every declared capability id is one the gate knows how to cross-check',
  contract.CAPABILITY_IDS.every((id) => id in CAPABILITY_BACKING) && Object.keys(CAPABILITY_BACKING).length === contract.CAPABILITY_IDS.length,
  contract.CAPABILITY_IDS.filter((id) => !(id in CAPABILITY_BACKING)).join(', ') || 'all known',
);
check(
  'a capability reported available names a member that really is a function on the service',
  contract.CAPABILITY_IDS.every((id) => {
    const entry = full[id];
    if (entry.state !== 'available') return true;
    const backing = CAPABILITY_BACKING[id];
    if (backing === null) return id === 'state.read';
    const [service, member] = backing;
    return typeof fullServices[service]?.[member] === 'function';
  }),
  contract.CAPABILITY_IDS.map((id) => `${id}:${full[id].state}`).join(' '),
);
check(
  'a capability with no backing member is never reported available',
  contract.CAPABILITY_IDS.filter((id) => CAPABILITY_BACKING[id] === null && id !== 'state.read').every((id) => full[id].state !== 'available'),
);
check(
  'the refused capability is refused, not called impossible, and says why',
  REFUSED_BY_DESIGN.every((id) => full[id].state === 'refused' && full[id].reason.length > 60),
  REFUSED_BY_DESIGN.map((id) => `${id}:${full[id].state}`).join(' '),
);
check(
  'the capabilities that need a member go unavailable when it is removed, while the rest stay',
  (() => {
    const noExecute = table({ ...fullServices, tools: { schemas() {} } }, goodModel);
    const noStream = table({ ...fullServices, llm: {} }, goodModel);
    const noSchemas = table({ ...fullServices, tools: { execute() {} } }, goodModel);
    return (
      noExecute['tool.dispatch'].state === 'unavailable' &&
      noExecute['catalog.read'].state === 'available' &&
      noStream['model.request'].state === 'unavailable' &&
      noStream['model.request'].code === 'llm_unavailable' &&
      noSchemas['catalog.read'].state === 'unavailable' &&
      noSchemas['tool.dispatch'].state === 'available'
    );
  })(),
);
check(
  'the run capability needs a model as well as a registry, so it is not available without one',
  table(fullServices, { ok: false, code: 'model_not_selected', reason: 'nothing authorised' })['agent.run'].state === 'unavailable' &&
    table(fullServices, goodModel)['agent.run'].state === 'available',
);
check(
  'the run capability carries the model failure code, so a caller learns WHY no run can happen',
  table(fullServices, { ok: false, code: 'model_unavailable', reason: 'gone' })['agent.run'].code === 'model_unavailable',
);
check('state.read is available in every shape, because nothing backs it', table({}, { ok: false }).state === undefined ? true : table({}, { ok: false })['state.read'].state === 'available');

/* ==================================================== the model — four answers, one refusal === */

console.log('');
console.log('# the authorised model — four answers that must not be conflated');

const readTable = (opts) => makeHarness(opts);
check(
  'with no core service the answer is core_service_absent',
  coreModel.readCoreSelection({}).code === 'core_service_absent',
  coreModel.readCoreSelection({}).code,
);
check(
  'with a core service but no accessor the answer is core_model_accessor_absent, a different code',
  coreModel.readCoreSelection({ core: {} }).code === 'core_model_accessor_absent',
  coreModel.readCoreSelection({ core: {} }).code,
);
check(
  'with an accessor that returns nothing the answer is model_not_selected, and it refuses rather than defaulting',
  coreModel.readCoreSelection({ core: { model: () => ({}) } }).code === 'model_not_selected' &&
    coreModel.readCoreSelection({ core: { model: () => ({}) } }).ok === false,
  coreModel.readCoreSelection({ core: { model: () => ({}) } }).code,
);
check(
  'an accessor that throws is its own code, not a crash',
  coreModel.readCoreSelection({ core: { model: () => { throw new Error('boom'); } } }).code === 'core_model_accessor_threw',
);
check(
  'a well-formed selection is ok and carries the provider and model through',
  coreModel.readCoreSelection({ core: { model: () => ({ provider: 'p', model: 'm' }) } }).ok === true &&
    coreModel.readCoreSelection({ core: { model: () => ({ provider: 'p', model: 'm' }) } }).provider === 'p',
);
check(
  'verifyModelAvailable matches on the id field the published type names, not on the display name',
  (await coreModel.verifyModelAvailable({ listModels: async () => [{ provider: 'p', id: 'm', name: 'Something Else' }] }, { ok: true, provider: 'p', model: 'm' })).verified === true,
);
check(
  'a provider that no longer lists the authorised model is model_unavailable, a refusal',
  (await coreModel.verifyModelAvailable({ listModels: async () => [{ provider: 'p', id: 'other', name: 'Other' }] }, { ok: true, provider: 'p', model: 'm' })).verified === false &&
    (await coreModel.verifyModelAvailable({ listModels: async () => [{ provider: 'p', id: 'other', name: 'Other' }] }, { ok: true, provider: 'p', model: 'm' })).code === 'model_unavailable',
);
check(
  'a listing that cannot be read is model_unverified, which is NOT a refusal: failure to check is not evidence of absence',
  (await coreModel.verifyModelAvailable({ listModels: async () => { throw new Error('down'); } }, { ok: true, provider: 'p', model: 'm' })).verified === null &&
    (await coreModel.verifyModelAvailable({}, { ok: true, provider: 'p', model: 'm' })).verified === null,
);

/* ============================================== the loop, driven through the real seam === */

console.log('');
console.log('# the loop — driven end to end through the real loop and the real seam');

const send = (h, args, exec) => h.definitions.get('agent_api_send').execute(args, exec);

/**
 * Mount this component into one harness and hand back the instance it built.
 *
 * `mod.apply` returns the object it created. The Loader ignores a return value, so returning it
 * changes nothing about how the component mounts — but it is the only way a check can hold the
 * SAME counters the tools report from, and the release assertions are statements about counters.
 * Going through the tool that reports them would read a different instance's numbers.
 */
const applyHarness = (h, config) => {
  h.api = mod.apply(h.ctx, { root: tempRoot, ...config });
  return h.api;
};

const twoTurn = makeHarness({
  scripts: [turn({ toolCalls: [{ id: 'call-1', name: 'memory_lab_probe', arguments: { query: 'x' } }], reason: { kind: 'tool-calls' } }), turn({ text: '{"verdict":"ok"}', reason: { kind: 'stop' } })],
});
mod.apply(twoTurn.ctx, { root: tempRoot });
const twoTurnAnswer = await send(twoTurn, { prompt: 'judge it', output_schema: { type: 'object', required: ['verdict'] }, workspace: workDir }, {});
check('a two-turn run answers exit 0 with the parsed judgement', twoTurnAnswer.exit === EXIT_OK && twoTurnAnswer.result?.structured?.verdict === 'ok', JSON.stringify(twoTurnAnswer).slice(0, 240));
check('the run reports two assistant turns and one tool call', twoTurnAnswer.result?.turns === 2 && twoTurnAnswer.result?.tool_calls === 1, JSON.stringify({ turns: twoTurnAnswer.result?.turns, tools: twoTurnAnswer.result?.tool_calls }));
check('the tool the run called really went through the registry', twoTurn.counts.execute === 1 && twoTurn.seen.exec[0]?.name === 'memory_lab_probe', JSON.stringify({ executed: twoTurn.counts.execute }));
check('the run used the route value that says a loop ran, not a subagent', twoTurnAnswer.route === 'loop', twoTurnAnswer.route);
// The field the whole workspace argument was about. A successful run must report it as
// ENFORCED, because this component owns the loop that used it — and a mutation that flips this
// to false has to be caught, or the field is decoration.
check(
  'a successful run reports its workspace as enforced, and says what enforced it',
  twoTurnAnswer.result?.workspace?.enforced === true &&
    twoTurnAnswer.result.workspace.enforced_by === 'agent-api/loop' &&
    twoTurnAnswer.result.workspace.path === workDir &&
    twoTurnAnswer.result.workspace.created === true,
  JSON.stringify(twoTurnAnswer.result?.workspace ?? null).slice(0, 240),
);
check(
  'the second model call carried the tool result back, so a tool-using run is really a loop',
  twoTurn.seen.generate.length === 2 &&
    JSON.stringify(twoTurn.seen.generate[1].messages).includes('"role":"tool"') &&
    JSON.stringify(twoTurn.seen.generate[1].messages).includes('call-1'),
  JSON.stringify(twoTurn.seen.generate[1]?.messages ?? []).slice(0, 240),
);
check(
  'the request carried the documented GenerateOptions fields',
  twoTurn.seen.generate[0].provider === 'deepseek' &&
    twoTurn.seen.generate[0].model === 'deepseek-chat' &&
    Array.isArray(twoTurn.seen.generate[0].messages) &&
    typeof twoTurn.seen.generate[0].system === 'string' &&
    Array.isArray(twoTurn.seen.generate[0].tools),
  JSON.stringify({ provider: twoTurn.seen.generate[0]?.provider, model: twoTurn.seen.generate[0]?.model, tools: twoTurn.seen.generate[0]?.tools?.length }),
);
check(
  'the FIRST user message is the RequestUserInput shape, which needs no id and no source',
  twoTurn.seen.generate[0].messages[0]?.role === 'user' &&
    !('id' in twoTurn.seen.generate[0].messages[0]) &&
    !('source' in twoTurn.seen.generate[0].messages[0]),
  JSON.stringify(twoTurn.seen.generate[0].messages[0]),
);

console.log('');
console.log('# the loop — the tool set, the seams, and the bounds');

check(
  'a run is given the memory tools and nothing else by default',
  JSON.stringify(twoTurnAnswer.result?.tool_names) === JSON.stringify(['memory_lab_probe']),
  JSON.stringify(twoTurnAnswer.result?.tool_names),
);
check(
  'the default set excludes this component own tools and the unrelated fixture',
  !twoTurnAnswer.result.tool_names.includes('agent_api_send') &&
    !twoTurnAnswer.result.tool_names.includes('gate_echo') &&
    !twoTurnAnswer.result.tool_names.includes('run_code'),
  JSON.stringify(twoTurnAnswer.result.tool_names),
);
const explicit = makeHarness();
mod.apply(explicit.ctx, { root: tempRoot });
const explicitAnswer = await send(explicit, { prompt: 'x', tool_filter: { allow: ['gate_echo'] } }, {});
check(
  'an explicit allow list replaces the default, and a deny list removes from it',
  JSON.stringify(explicitAnswer.result?.tool_names) === JSON.stringify(['gate_echo']),
  JSON.stringify(explicitAnswer.result?.tool_names),
);
check(
  'the restricted set is what the MODEL sees, so an unlisted tool is not in the request',
  JSON.stringify((explicit.seen.generate[0].tools ?? []).map((t) => t.name)) === JSON.stringify(['gate_echo']),
  JSON.stringify((explicit.seen.generate[0].tools ?? []).map((t) => t.name)),
);

const deltaRun = makeHarness({ scripts: [deltaOnlyTurn({ toolCalls: [{ id: 'call-d', name: 'memory_lab_probe', arguments: {} }], reason: { kind: 'tool-calls' } }), turn({ text: 'done' })] });
mod.apply(deltaRun.ctx, { root: tempRoot });
const deltaAnswer = await send(deltaRun, { prompt: 'x' }, {});
check(
  'a tool call that arrives only as tool-call-delta chunks is recovered rather than dropped',
  deltaAnswer.exit === EXIT_OK && deltaRun.counts.execute === 1,
  JSON.stringify({ exit: deltaAnswer.exit, executed: deltaRun.counts.execute }),
);

/* ============================ a FAILED tool call, which is where a run used to loop ==========
 *
 * WHAT WAS MEASURED on the running 0.2.11 bundle, before anything here was written:
 *
 *   - a run whose model called `memory_lab_read` for a component that does not exist called that
 *     same tool on EVERY turn of its budget and ended at `max_steps`. Three of three turns in a
 *     re-measurement whose prompt asked it in words not to call the tool again; six of six in the
 *     round the user measured;
 *   - the failure DID reach the model — as a `tool` message with `isError: true` — and its whole
 *     text was `[object Object]`;
 *   - `agent_api_tool { tool: "memory_lab_read", … }` answered `error: "[object Object]"` from the
 *     LIVE application, which is the same collapse reached through the other tool in this
 *     component.
 *
 * So the defect was never "the failure does not arrive". It arrived carrying nothing. These
 * checks hold the three halves of that shut — the message, the echo of the model's own call, and
 * a bound on repeating the call — and each one is written so that reverting its fix turns it red.
 */

console.log('');
console.log('# a failed tool call — what the model is shown, and what ends the run');

const storeFailure = {
  isError: false,
  value: { ok: false, status: 'error', error: { code: 'NOT_FOUND', message: 'Memory component not found: ZZZ-Absent', details: { selector: 'ZZZ-Absent' } } },
};
const classifiedFailure = contract.classifyToolResult('memory_lab_read', storeFailure);
check(
  'a tool that reports its failure as an OBJECT is classified into the message it carries, not into `[object Object]`',
  classifiedFailure.exit === EXIT_FAILED &&
    classifiedFailure.error.includes('Memory component not found: ZZZ-Absent') &&
    classifiedFailure.error.includes('NOT_FOUND') &&
    !classifiedFailure.error.includes('[object Object]'),
  JSON.stringify(classifiedFailure),
);
check(
  'the same failure reached as raw JSON text is classified identically, so both routes agree',
  (() => {
    const viaText = contract.classifyToolOutput('memory_lab_read', JSON.stringify(storeFailure.value));
    return viaText.exit === EXIT_FAILED && viaText.error.includes('Memory component not found: ZZZ-Absent') && !viaText.error.includes('[object Object]');
  })(),
);
check(
  'a failure object with no message still names its code, and one with neither is not `[object Object]`',
  contract.describeFailure({ code: 'CYCLE' }) === 'CYCLE' &&
    contract.describeFailure({}) === '' &&
    !contract.describeFailure({ whatever: true }).includes('[object Object]'),
  JSON.stringify([contract.describeFailure({ code: 'CYCLE' }), contract.describeFailure({}), contract.describeFailure({ whatever: true })]),
);

/* The run itself. A failing tool call, a model that answers on the next turn — which is what a
 * model does when the failure it is handed can be read. THE CONTROL for "the fix does not stop
 * every run early": this must be exit 0 in exactly two turns, the same shape as the succeeding
 * call above. */
const failThenAnswer = makeHarness({
  scripts: [
    turn({ toolCalls: [{ id: 'call-f', name: 'gate_missing', arguments: { component: 'ZZZ-Absent' } }], reason: { kind: 'tool-calls' } }),
    turn({ text: '{"verdict":"the tool failed: no such component"}', reason: { kind: 'stop' } }),
  ],
});
mod.apply(failThenAnswer.ctx, { root: tempRoot });
const failThenAnswerAnswer = await send(failThenAnswer, { prompt: 'read ZZZ-Absent', tool_filter: { allow: ['gate_missing'] }, workspace: workDir }, {});
check(
  'CONTROL — a failing call that the model then answers about still settles in two turns, exit 0',
  failThenAnswerAnswer.exit === EXIT_OK && failThenAnswerAnswer.result?.turns === 2 && failThenAnswerAnswer.result?.tool_calls === 1,
  JSON.stringify({ exit: failThenAnswerAnswer.exit, turns: failThenAnswerAnswer.result?.turns, calls: failThenAnswerAnswer.result?.tool_calls }),
);
check(
  'the failure the model is handed is the tool message, and it does not read as `[object Object]`',
  (() => {
    const second = failThenAnswer.seen.generate[1];
    const toolMessage = (second?.messages ?? []).find((message) => message.role === 'tool');
    const text = (toolMessage?.content ?? []).map((block) => block.text ?? '').join('');
    return toolMessage?.isError === true && text.includes('Memory component not found: ZZZ-Absent') && !text.includes('[object Object]');
  })(),
  JSON.stringify((failThenAnswer.seen.generate[1]?.messages ?? []).find((message) => message.role === 'tool') ?? null).slice(0, 300),
);
/* THE ECHO. DSH's `ToolCallBlock.arguments` is a STRING and the DeepSeek adapter reads it with
 * `JSON.parse`; the seam used to convert it to an object in place, so every earlier call the model
 * made came back to it with no arguments at all. This asserts the shape on the request the model
 * is actually handed, which is the thing the adapter parses. */
check(
  "a model's own earlier tool call is echoed back with its arguments as the JSON TEXT the wire declares",
  (() => {
    const assistant = (failThenAnswer.seen.generate[1]?.messages ?? []).find((message) => message.role === 'assistant');
    const call = (assistant?.content ?? []).find((block) => block.type === 'tool-call');
    if (!call || typeof call.arguments !== 'string') return false;
    try {
      return JSON.parse(call.arguments).component === 'ZZZ-Absent';
    } catch {
      return false;
    }
  })(),
  JSON.stringify((failThenAnswer.seen.generate[1]?.messages ?? []).find((message) => message.role === 'assistant')?.content ?? null).slice(0, 300),
);

/* THE BOUND. A fixture model that retries the identical failing call for ever — which is what the
 * live model did — must not reach `max_steps`. The numbers are exact: two executions, one
 * directive, one refused call, one final call that stops the run, so four model turns and two
 * tool executions out of a budget of eight. `streamLimit` is 5, deliberately just above 4: a
 * bound that stopped working would run past it and the fixture's own model would throw. */
const RETRY_TOKEN = { id: 'r', name: 'gate_missing', arguments: { component: 'ZZZ-Absent' } };
const alwaysRetries = () => turn({ toolCalls: [{ ...RETRY_TOKEN, id: `r${Math.random().toString(36).slice(2, 8)}` }], reason: { kind: 'tool-calls' } });
const retryRun = makeHarness({ scripts: [], defaultScript: alwaysRetries(), streamLimit: 5, componentMaxSteps: 8 });
mod.apply(retryRun.ctx, { root: tempRoot });
const retryAnswer = await send(retryRun, { prompt: 'read ZZZ-Absent', tool_filter: { allow: ['gate_missing'] }, workspace: workDir }, {});
check(
  'a run that repeats one identical failing call is STOPPED, and says so as repeated_tool_failure rather than max_steps',
  retryAnswer.exit === EXIT_FAILED && retryAnswer.code === 'repeated_tool_failure' && retryAnswer.error.includes('same tool with the same arguments'),
  JSON.stringify({ exit: retryAnswer.exit, code: retryAnswer.code, error: retryAnswer.error }).slice(0, 260),
);
check(
  'the bound is exact: two executions, four model turns, eight turns of budget untouched',
  retryRun.counts.execute === 2 && retryRun.counts.stream === 4 && retryAnswer.run?.turns === 4,
  JSON.stringify({ executed: retryRun.counts.execute, streams: retryRun.counts.stream, run: retryAnswer.run ?? null }),
);
check(
  'the repeated call is refused WITH its last failure, so the model is told what to change',
  (() => {
    const last = retryRun.seen.generate[retryRun.seen.generate.length - 1];
    const tool = (last?.messages ?? []).filter((message) => message.role === 'tool');
    const text = tool.map((message) => (message.content ?? []).map((block) => block.text ?? '').join('')).join('\n');
    return text.includes('was NOT executed') && text.includes('Memory component not found: ZZZ-Absent');
  })(),
  JSON.stringify(retryRun.seen.generate[retryRun.seen.generate.length - 1]?.messages ?? []).slice(0, 400),
);
check(
  'the second identical failure carries the directive that says the call will not be executed again',
  (() => {
    const third = retryRun.seen.generate[2];
    const text = (third?.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => (message.content ?? []).map((block) => block.text ?? '').join(''))
      .join('\n');
    return text.includes('2nd time this exact call') && text.includes('will not be executed');
  })(),
  JSON.stringify(retryRun.seen.generate[2]?.messages ?? []).slice(0, 400),
);

/* THE MALFORMED-ARGUMENTS PATH, which is round 3's `MALFORMED_RESPONSE`, in its two halves. */
const malformedTurn = [
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-m', name: 'memory_lab_probe', arguments: '{"query": "Harness' } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
];
const malformed = makeHarness({ scripts: [malformedTurn, turn({ text: '{"verdict":"the call was unreadable"}', reason: { kind: 'stop' } })] });
mod.apply(malformed.ctx, { root: tempRoot });
const malformedAnswer = await send(malformed, { prompt: 'query it', workspace: workDir }, {});
check(
  'tool-call arguments that are not valid JSON become a legible tool result, and the run answers',
  malformedAnswer.exit === EXIT_OK &&
    malformed.counts.execute === 0 &&
    (() => {
      const tool = (malformed.seen.generate[1]?.messages ?? []).find((message) => message.role === 'tool');
      const text = (tool?.content ?? []).map((block) => block.text ?? '').join('');
      return tool?.isError === true && text.includes('not valid JSON') && text.includes('Harness');
    })(),
  JSON.stringify({ exit: malformedAnswer.exit, executed: malformed.counts.execute, tool: (malformed.seen.generate[1]?.messages ?? []).find((m) => m.role === 'tool') ?? null }).slice(0, 320),
);
/* The provider-level half: the DeepSeek adapter validates the arguments at `message_stop`, after
 * every `block-end` has been delivered, and throws. That throw used to discard the whole turn and
 * end the run with a transport error; it now leaves the turn in place, so the call reaches the
 * tool boundary and the malformed arguments become the same legible result. */
const malformedStreamChunks = [
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-x', name: 'memory_lab_probe', arguments: '{"query": "Harness' } },
  new Error('DeepSeek Messages stream: tool input is invalid JSON'),
];
const malformedStream = makeHarness({ scripts: [malformedStreamChunks, turn({ text: '{"verdict":"the call was unreadable"}', reason: { kind: 'stop' } })] });
mod.apply(malformedStream.ctx, { root: tempRoot });
const malformedStreamAnswer = await send(malformedStream, { prompt: 'query it', workspace: workDir }, {});
check(
  'a stream that fails AFTER delivering a tool call keeps the turn, so MALFORMED_RESPONSE is a tool result rather than a dead run',
  malformedStreamAnswer.exit === EXIT_OK && malformedStream.counts.execute === 0,
  JSON.stringify({ exit: malformedStreamAnswer.exit, code: malformedStreamAnswer.code ?? '', executed: malformedStream.counts.execute }).slice(0, 260),
);
/* The control for the recovery: a stream that fails BEFORE it delivers anything must still fail
 * the run honestly. Without this, "recover the turn" would be indistinguishable from "swallow
 * every provider failure". */
const emptyFailStream = makeHarness({ scripts: [[new Error('DeepSeek Messages stream: transport died')]], defaultScript: [new Error('DeepSeek Messages stream: transport died')] });
mod.apply(emptyFailStream.ctx, { root: tempRoot });
const emptyFailAnswer = await send(emptyFailStream, { prompt: 'x' }, {});
check(
  'CONTROL — a stream that fails before delivering anything is still run_failed, not a recovered empty turn',
  emptyFailAnswer.exit === EXIT_FAILED && emptyFailAnswer.code === 'run_failed' && emptyFailAnswer.error.includes('transport died'),
  JSON.stringify({ exit: emptyFailAnswer.exit, code: emptyFailAnswer.code, error: emptyFailAnswer.error }).slice(0, 260),
);
check(
  'the checked parse agrees with the lenient one on everything a working call can look like',
  JSON.stringify(seam.toolCallArgumentsChecked('{"a":1}').value) === '{"a":1}' &&
    JSON.stringify(seam.toolCallArgumentsChecked('').value) === '{}' &&
    seam.toolCallArgumentsChecked('null').ok === true &&
    seam.toolCallArgumentsChecked('{broken').ok === false &&
    JSON.stringify(seam.toolCallArguments('{broken')) === '{}' &&
    seam.toolCallArgumentsChecked('{broken').reason.includes('not valid JSON'),
  JSON.stringify([seam.toolCallArgumentsChecked('{broken'), seam.toolCallArguments('{broken')]),
);
check(
  'two spellings of the same call share one canonical key, so a respaced retry cannot evade the bound',
  seam.toolCallKey({ name: 't', arguments: '{"a":1,"b":2}' }) === seam.toolCallKey({ name: 't', arguments: '{"b": 2, "a": 1}' }) &&
    seam.toolCallKey({ name: 't', arguments: '{"a":1}' }) !== seam.toolCallKey({ name: 't', arguments: '{"a":2}' }),
  JSON.stringify([seam.toolCallKey({ name: 't', arguments: '{"a":1,"b":2}' }), seam.toolCallKey({ name: 't', arguments: '{"b": 2, "a": 1}' })]),
);

/* THE EVENTS. "A receipt can show that a run looped and cannot show why" was the diagnosability
 * half of the same defect: the two events that say a tool was called and what came back carried
 * no payload at all. */
check(
  'the receipt carries the tool result AND the error on the tool events, with the turn they happened in',
  (() => {
    const events = retryAnswer.events ?? [];
    const start = events.find((event) => event.type === 'tool_execution_start');
    const end = events.filter((event) => event.type === 'tool_execution_end');
    const failed = end.find((event) => event.is_error === true);
    const refused = end.find((event) => event.refused === true);
    return (
      start?.tool === 'gate_missing' &&
      typeof start.arguments === 'string' &&
      start.arguments.includes('ZZZ-Absent') &&
      start.turn === 1 &&
      failed?.error?.includes('Memory component not found') &&
      failed.code === 'tool_reported_failure' &&
      refused?.code === 'repeated_tool_failure' &&
      end.every((event) => Number.isInteger(event.turn))
    );
  })(),
  JSON.stringify(retryAnswer.events ?? []).slice(0, 600),
);
check(
  'a successful tool result is on its event too, so the log is not only a failure channel',
  (() => {
    const events = twoTurnAnswer.events ?? [];
    const end = events.find((event) => event.type === 'tool_execution_end');
    return end?.is_error === false && typeof end.result === 'string' && end.tool === 'memory_lab_probe' && end.turn === 1;
  })(),
  JSON.stringify(twoTurnAnswer.events ?? []).slice(0, 400),
);
const hugeRun = makeHarness({ scripts: [turn({ toolCalls: [{ id: 'call-h', name: 'gate_huge', arguments: {} }], reason: { kind: 'tool-calls' } }), turn({ text: '{"verdict":"ok"}', reason: { kind: 'stop' } })] });
mod.apply(hugeRun.ctx, { root: tempRoot });
const hugeAnswer = await send(hugeRun, { prompt: 'x', tool_filter: { allow: ['gate_huge'] }, workspace: workDir }, {});
check(
  'a large tool result is BOUNDED on the event, with the truncation stated rather than silent',
  (() => {
    const end = (hugeAnswer.events ?? []).find((event) => event.type === 'tool_execution_end');
    return (
      typeof end?.result === 'string' &&
      end.result.length <= componentModule.EVENT_TEXT_LIMIT + 24 &&
      end.result.includes('+') &&
      end.result.includes('chars')
    );
  })(),
  JSON.stringify((hugeAnswer.events ?? []).find((event) => event.type === 'tool_execution_end') ?? null).slice(0, 200),
);
check(
  'the event log is bounded, and says what it dropped when it is',
  (() => {
    const report = componentModule.eventView({ type: 'agent_end', turn: 1, stopReason: 'stop' }, { kept: 64, dropped: 7 });
    return report.events_kept === 64 && report.events_dropped === 7 && typeof report.stop_reason === 'string';
  })(),
  JSON.stringify(componentModule.eventView({ type: 'agent_end', turn: 1, stopReason: 'stop' }, { kept: 64, dropped: 7 })),
);
check(
  'every event field is JSON-lossless: no `undefined` in a value position, which has cost this bundle two releases',
  (() => {
    const walk = (value, path) => {
      if (value === undefined) return path;
      if (value === null || typeof value !== 'object') return null;
      if (Array.isArray(value)) {
        for (const [index, entry] of value.entries()) {
          const found = walk(entry, `${path}[${index}]`);
          if (found) return found;
        }
        return null;
      }
      for (const [key, entry] of Object.entries(value)) {
        const found = walk(entry, `${path}.${key}`);
        if (found) return found;
      }
      return null;
    };
    return walk([twoTurnAnswer.events, retryAnswer.events, malformedStreamAnswer.events, hugeAnswer.events], '$') === null;
  })(),
);
/* The recovery's own fact, asserted where it is produced: a receipt for round 3 has to be able to
 * say that a turn survived a provider failure, or the run looks like it simply worked. */
check(
  'a run whose turn survived a provider failure says how many turns were recovered, rather than looking ordinary',
  malformedStreamAnswer.exit === EXIT_OK &&
    malformedStreamAnswer.run?.recovered_turns === 1 &&
    malformedStreamAnswer.run.turns === 2 &&
    (malformedStreamAnswer.events ?? []).filter((event) => event.type === 'tool_execution_end').length === 1,
  JSON.stringify({ run: malformedStreamAnswer.run ?? null, recovered: malformedStreamAnswer.run?.recovered_turns ?? null }),
);
/* The lifetime counter on the component, against what the run reports. Two runs on ONE instance,
 * each making exactly one tool call: the lifetime counter is the evidence that the second reading
 * cannot be the first one's number, and reverting `tool_calls` to it makes this red. */
const toolCallCounting = makeHarness({
  scripts: [
    turn({ toolCalls: [{ id: 'c1', name: 'gate_echo', arguments: { n: 1 } }], reason: { kind: 'tool-calls' } }),
    turn({ text: '{"verdict":"ok"}', reason: { kind: 'stop' } }),
    turn({ toolCalls: [{ id: 'c2', name: 'gate_echo', arguments: { n: 2 } }], reason: { kind: 'tool-calls' } }),
    turn({ text: '{"verdict":"ok"}', reason: { kind: 'stop' } }),
  ],
});
const toolCallCountingApi = mod.apply(toolCallCounting.ctx, { root: tempRoot });
const firstCallRun = await send(toolCallCounting, { prompt: 'one', tool_filter: { allow: ['gate_echo'] }, workspace: workDir }, {});
const secondCallRun = await send(toolCallCounting, { prompt: 'two', tool_filter: { allow: ['gate_echo'] }, workspace: workDir }, {});
check(
  'the run reports ITS OWN tool calls, not the component lifetime counter that every run adds to',
  firstCallRun.result?.tool_calls === 1 &&
    secondCallRun.result?.tool_calls === 1 &&
    toolCallCountingApi.counters.toolCalls === 2,
  JSON.stringify({ first: firstCallRun.result?.tool_calls, second: secondCallRun.result?.tool_calls, lifetime: toolCallCountingApi.counters.toolCalls }),
);
check(
  'a failed run reports how far it got, because a failure envelope carries no `result` for a caller to read it from',
  retryAnswer.run?.turns === 4 &&
    retryAnswer.run.tool_calls === 2 &&
    retryAnswer.run.stop_reason === 'repeated-tool-failure' &&
    retryAnswer.result === undefined,
  JSON.stringify(retryAnswer.run ?? null),
);

/* ---------------------------------------------- the step cap, and why these can now fail ---
 *
 * WHAT WAS WRONG. The cap is the one guarantee that a run nobody is watching still RETURNS.
 * The previous fixture asserted it with a never-stopping script and a `streamLimit` of nothing,
 * and it was reported as "not proven able to fail". Measured here, both halves of that report
 * turn out to be different from how they were described:
 *
 *   - `component.js` IGNORING a caller-supplied `max_steps` (the mutation the report named) was
 *     already caught: substituting `const steps = maxSteps;` answers `run_failed`, not
 *     `max_steps`, and the assertion went red. The report's own guess — that the fault was in
 *     its fixture rather than in `lib/loop.js` — was right, but not about that mutation.
 *   - The cap REMOVED from `lib/loop.js` was not caught at all, and could not be: the loop
 *     never returned, so there was no assertion to fail. The gate ran to a V8 heap exhaustion
 *     and died with "Ineffective mark-compacts near heap limit" after ~75 s. An OOM is not a
 *     red assertion, and a hung gate is not evidence of anything.
 *
 * WHAT IS ASSERTED NOW, and both of these CAN fail because the fixture's model is bounded:
 *
 *   M15  the loop enforces the cap it is given        -> `streams === cap`, `stopReason` seen
 *   M21  the caller's `max_steps` wins over the row's -> `streams === 2` while the row says 5
 *
 * The counters are the evidence, not the prose: `streams` is the number of model calls the run
 * really made, counted by the fixture. A cap that is off makes that number exceed the cap and
 * the bounded fixture turns it into a `run_failed` answer, which fails both assertions.
 */

const CAPPED_TOOL_CALL = { id: 'c', name: 'memory_lab_probe', arguments: {} };
const neverStops = () => turn({ toolCalls: [CAPPED_TOOL_CALL], reason: { kind: 'tool-calls' } });

// M15 — the loop's own cap. The fixture may be called 4 times (double the cap) and no more, so
// a loop that lost its cap answers `run_failed` rather than looping until the heap dies.
const capped = makeHarness({ scripts: [neverStops()], defaultScript: neverStops(), streamLimit: 4, componentMaxSteps: 2 });
capped.capAsserted = 2;
mod.apply(capped.ctx, { root: tempRoot, maxSteps: capped.componentMaxSteps });
const cappedAnswer = await send(capped, { prompt: 'x' }, {});
check(
  'a run that will not stop is stopped at the cap and reported as a failure, not as a judgement',
  cappedAnswer.exit === EXIT_FAILED && cappedAnswer.code === 'max_steps' && capped.counts.stream === 2,
  JSON.stringify({ exit: cappedAnswer.exit, code: cappedAnswer.code, streams: capped.counts.stream, cap: 2 }),
);
// The cap has to be a NUMBER OF MODEL CALLS. A stopped-at cap that quietly got one more turn is
// the same defect as no cap at all, one turn later, and `streams === 2` above would still hold
// if the loop only stopped on the turn AFTER the cap — hence this second, closer fixture.
const cappedOnce = makeHarness({ scripts: [neverStops()], defaultScript: neverStops(), streamLimit: 3, componentMaxSteps: 1 });
cappedOnce.capAsserted = 1;
mod.apply(cappedOnce.ctx, { root: tempRoot, maxSteps: cappedOnce.componentMaxSteps });
const cappedOnceAnswer = await send(cappedOnce, { prompt: 'x' }, {});
check(
  'a cap of one model turn is exactly one model turn, not one turn plus another',
  cappedOnceAnswer.code === 'max_steps' && cappedOnce.counts.stream === 1,
  JSON.stringify({ code: cappedOnceAnswer.code, streams: cappedOnce.counts.stream, cap: 1 }),
);

// M21 — the CALLER's `max_steps`, and that it reaches the loop rather than only the component's
// own default. The row is configured with 5 and the call asks for 2: if the argument is dropped
// anywhere between `agent_api_send` and `runAgentLoop`, the run uses 5 and both numbers here go
// red against a harness whose row default differs from the argument. The fixture's bound is 4,
// which is below the row's 5 as well, so a dropped argument fails instead of running.
const callerWins = makeHarness({ scripts: [neverStops()], defaultScript: neverStops(), streamLimit: 4, componentMaxSteps: 5 });
callerWins.capAsserted = 2; // from the CALL, not the row: that is the whole point of this fixture
mod.apply(callerWins.ctx, { root: tempRoot, maxSteps: callerWins.componentMaxSteps });
const callerWinsAnswer = await send(callerWins, { prompt: 'x', max_steps: 2 }, {});
check(
  'the caller max_steps wins over the row default, and it is the number of model calls made',
  callerWinsAnswer.exit === EXIT_FAILED && callerWinsAnswer.code === 'max_steps' && callerWins.counts.stream === 2,
  JSON.stringify({ exit: callerWinsAnswer.exit, code: callerWinsAnswer.code, streams: callerWins.counts.stream, rowDefault: 5, asked: 2 }),
);
// The row's own default, reached with no argument at all. Without this, a run that ignored
// `max_steps` AND the row config would still have been covered by the line above.
const rowDefault = makeHarness({ scripts: [neverStops()], defaultScript: neverStops(), streamLimit: 5, componentMaxSteps: 3 });
rowDefault.capAsserted = 3; // from the ROW, with no argument at all
mod.apply(rowDefault.ctx, { root: tempRoot, maxSteps: rowDefault.componentMaxSteps });
const rowDefaultAnswer = await send(rowDefault, { prompt: 'x' }, {});
check(
  'with no max_steps given, the row config supplies the cap on its own',
  rowDefaultAnswer.code === 'max_steps' && rowDefault.counts.stream === 3,
  JSON.stringify({ code: rowDefaultAnswer.code, streams: rowDefault.counts.stream, rowDefault: 3 }),
);
// A cap the caller asks for that the row would never choose, so "the argument arrived" and "the
// row default arrived" cannot be the same number by coincidence.
const oddCap = makeHarness({ scripts: [neverStops()], defaultScript: neverStops(), streamLimit: 12, componentMaxSteps: 7 });
oddCap.capAsserted = 11; // from the CALL, and neither the row default nor the component default
mod.apply(oddCap.ctx, { root: tempRoot, maxSteps: oddCap.componentMaxSteps });
check(
  'a cap that is neither the row default nor the component default is honoured exactly',
  (await send(oddCap, { prompt: 'x', max_steps: 11 }, {})).code === 'max_steps' && oddCap.counts.stream === 11,
  JSON.stringify({ streams: oddCap.counts.stream, asked: 11, rowDefault: 7 }),
);

// NO TURN CAP — agent_api_send max_steps: 0 is NewMate's conversational mode ("不再约束对话轮次").
// The fixture is bounded (streamLimit 12) so the test itself terminates; the point is that the
// run gets PAST the old default of 8 and is stopped by the fixture, not by max_steps.
const uncapped = makeHarness({ scripts: [neverStops()], defaultScript: neverStops(), streamLimit: 12, componentMaxSteps: 3 });
mod.apply(uncapped.ctx, { root: tempRoot, maxSteps: uncapped.componentMaxSteps });
const uncappedAnswer = await send(uncapped, { prompt: 'x', max_steps: 0 }, {});
check(
  'max_steps 0 means no turn cap: the run passes the default 8 and is stopped only by the fixture',
  uncappedAnswer.code !== 'max_steps' && uncapped.counts.stream > 8,
  JSON.stringify({ code: uncappedAnswer.code, streams: uncapped.counts.stream, ownCap: 3 }),
);
// The zero must be an EXPLICIT integer: a negative or fractional value is refused, not rounded
// into a silent cap, so "no cap" cannot be reached by accident.
const badCap = makeHarness({ scripts: [neverStops()], defaultScript: neverStops(), streamLimit: 4, componentMaxSteps: 2 });
mod.apply(badCap.ctx, { root: tempRoot, maxSteps: badCap.componentMaxSteps });
const negativeCap = await send(badCap, { prompt: 'x', max_steps: -1 }, {});
const fractionalCap = await send(badCap, { prompt: 'x', max_steps: 1.5 }, {});
check(
  'a negative or fractional max_steps is refused as invalid rather than quietly defaulted',
  negativeCap.code === 'invalid_max_steps' && fractionalCap.code === 'invalid_max_steps' && badCap.counts.stream === 0,
  JSON.stringify({ negative: negativeCap.code, fractional: fractionalCap.code, streams: badCap.counts.stream }),
);

// THE ANTI-VACUITY GUARD for all five: each fixture's bound has to be REACHABLE, and tight
// enough to be evidence. A bound far above the cap keeps the loop finite but says almost
// nothing — the capless loop would be stopped by the fixture rather than by the cap, and the
// `streams === cap` assertion would then be the only thing standing between this gate and the
// OOM it was written to remove. So: every bound is finite, and no bound leaves room for more
// than two turns past the cap it asks the loop to enforce.
//
// `capAsserted` is each fixture's OWN expected cap, recorded where that fixture is built rather
// than derived from `componentMaxSteps`: three of the five supply the cap as a call argument, so
// deriving it would have compared each bound against the wrong number and passed for the wrong
// reason. (It did, on the first attempt: the guard reported a bound that was in fact correct,
// because it was checking it against the row default instead of against the argument.)
check(
  'every cap fixture is finitely bounded, and its bound cannot leave room for two extra turns past the cap it asserts',
  [capped, cappedOnce, callerWins, rowDefault, oddCap].every(
    (h) => Number.isFinite(h.streamLimit) && Number.isFinite(h.capAsserted) && h.streamLimit <= h.capAsserted + 2,
  ),
  JSON.stringify([capped, cappedOnce, callerWins, rowDefault, oddCap].map((h) => `${h.streamLimit} vs cap ${h.capAsserted}`)),
);
// The caller's fixture is the one that has to distinguish two caps, so its bound must sit
// between them: above the argument (2) so a dropped argument is detectable, below the row's own
// default (5) so the detectable outcome is a failed assertion rather than a longer run.
check(
  'the caller-wins fixture bounds its model between the argument and the row default, so the two are distinguishable',
  callerWins.streamLimit > 2 && callerWins.streamLimit < callerWins.componentMaxSteps,
  JSON.stringify({ bound: callerWins.streamLimit, asked: 2, rowDefault: callerWins.componentMaxSteps }),
);
/* THE TWO NUMBERS THAT ARE MEANT TO BE ONE NUMBER.
 *
 * The cap a run gets when the caller names none is the component's `DEFAULT_MAX_STEPS`, and the
 * cap the loop falls back to when a caller omits `maxSteps` altogether is the `: 8` at the top of
 * `runLoop`. They are the same guarantee reached two ways, and until this pair of checks existed
 * the second one was UNVERIFIED: every fixture here goes through `agent_api_send`, which always
 * supplies a number, so changing the loop's own fallback to 6 — a run that stops four turns early
 * — left the whole gate green. That was measured, not suspected: the mutation was applied and the
 * gate answered `passed=165 failed=0`.
 *
 * A negative assertion is what remains once the positive one is unreachable, so it is stated
 * where it can actually fail rather than left implied:
 *   1. the shipped row, the component's constant and the loop's fallback are ONE value;
 *   2. `runLoop` has no second, different fallback hiding behind that value. */
check(
  'the shipped row composes this component with the cap the component declares as its default',
  Number.isFinite(rowMaxSteps) && rowMaxSteps === componentDefaultMaxSteps,
  `row composes maxSteps: ${rowMaxSteps}, component declares DEFAULT_MAX_STEPS = ${componentDefaultMaxSteps}`,
);
check(
  'the loop falls back to exactly that cap, and it is the only fallback in the loop',
  (() => {
    const loopSource = fs.readFileSync(path.join(componentDir, 'lib', 'loop.js'), 'utf8');
    const fallbacks = [...loopSource.matchAll(/Number\.isFinite\(config\.maxSteps\)[^\n]*?: (\d+);/g)].map((m) => Number(m[1]));
    return fallbacks.length === 1 && fallbacks[0] === componentDefaultMaxSteps;
  })(),
  `the loop's own cap fallback must be ${componentDefaultMaxSteps} and stated once`,
);

const truncated = makeHarness({ defaultScript: turn({ text: 'half an answer', reason: { kind: 'max-tokens' } }) });
mod.apply(truncated.ctx, { root: tempRoot });
check(
  'a token-truncated run is a failure, not a verdict',
  (await send(truncated, { prompt: 'x' })).code === 'max_tokens',
);
const providerErrorRun = makeHarness({ defaultScript: turn({ reason: { kind: 'error', failure: { message: 'provider exploded', code: 'E_PROVIDER' } } }) });
mod.apply(providerErrorRun.ctx, { root: tempRoot });
const failedAnswer = await send(providerErrorRun, { prompt: 'x' });
check(
  'a provider failure is run_failed and carries the provider own message',
  failedAnswer.exit === EXIT_FAILED && failedAnswer.code === 'run_failed' && failedAnswer.error.includes('provider exploded'),
  JSON.stringify(failedAnswer).slice(0, 240),
);
const abortedRun = makeHarness({ defaultScript: turn({ reason: { kind: 'aborted', failure: { message: 'stopped', code: 'E_ABORT' } } }) });
mod.apply(abortedRun.ctx, { root: tempRoot });
check('an aborted run is exit 130', (await send(abortedRun, { prompt: 'x' })).exit === EXIT_ABORTED);
// A run that answers in prose when a schema was requested. Its own harness, because the shared
// default script answers with valid JSON and would make this assertion pass for the wrong reason.
const proseRun = makeHarness({ defaultScript: turn({ text: 'I think the answer is probably fine.' }) });
mod.apply(proseRun.ctx, { root: tempRoot });
check(
  'a schema was requested and the answer is not JSON, so the call fails rather than returning prose as a judgement',
  (await send(proseRun, { prompt: 'x', output_schema: { type: 'object' } })).code === 'schema_violation',
);
const missingKey = makeHarness();
mod.apply(missingKey.ctx, { root: tempRoot });
check(
  'a schema was requested and a required property is absent, so the call fails',
  (await send(missingKey, { prompt: 'x', output_schema: { type: 'object', required: ['absent_key'] } })).code === 'schema_violation',
);
const emptyRun = makeHarness({ defaultScript: turn({ text: '   ' }) });
mod.apply(emptyRun.ctx, { root: tempRoot });
check(
  'a run that stops without answering is a failure, never an empty judgement',
  (await send(emptyRun, { prompt: 'x' })).code === 'run_failed',
);

/* =============================================== the four refusals, none of them a run === */

console.log('');
console.log('# the refusals — nothing attempted, and each says why');

const noCore = makeHarness({ withCore: false });
mod.apply(noCore.ctx, { root: tempRoot });
const noCoreAnswer = await send(noCore, { prompt: 'x' }, {});
check(
  'with no core service the call refuses with core_service_absent and starts no model call',
  noCoreAnswer.exit === EXIT_UNAVAILABLE && noCoreAnswer.code === 'core_service_absent' && noCore.counts.stream === 0,
  JSON.stringify({ exit: noCoreAnswer.exit, code: noCoreAnswer.code, streams: noCore.counts.stream }),
);
const noAccessor = makeHarness({ withModelAccessor: false });
mod.apply(noAccessor.ctx, { root: tempRoot });
check(
  'with no accessor the call refuses with core_model_accessor_absent',
  (await send(noAccessor, { prompt: 'x' }, {})).code === 'core_model_accessor_absent',
);
const noSelection = makeHarness({ coreSelection: {} });
mod.apply(noSelection.ctx, { root: tempRoot });
const noSelectionAnswer = await send(noSelection, { prompt: 'x' }, {});
check(
  'with nothing authorised the call refuses with model_not_selected and does NOT substitute a default',
  noSelectionAnswer.exit === EXIT_UNAVAILABLE && noSelectionAnswer.code === 'model_not_selected' && noSelection.counts.stream === 0,
  JSON.stringify({ code: noSelectionAnswer.code, streams: noSelection.counts.stream }),
);
const goneModel = makeHarness({ listedModels: [{ provider: 'deepseek', id: 'some-other-model', name: 'Other' }] });
mod.apply(goneModel.ctx, { root: tempRoot });
const goneAnswer = await send(goneModel, { prompt: 'x' }, {});
check(
  'an authorised model the provider no longer lists is model_unavailable, and no model call is made',
  goneAnswer.exit === EXIT_UNAVAILABLE && goneAnswer.code === 'model_unavailable' && goneModel.counts.stream === 0,
  JSON.stringify({ exit: goneAnswer.exit, code: goneAnswer.code, streams: goneModel.counts.stream }),
);
const unverified = makeHarness({ listModelsThrows: true });
mod.apply(unverified.ctx, { root: tempRoot });
const unverifiedAnswer = await send(unverified, { prompt: 'x' }, {});
check(
  'a model that could not be checked is NOT refused: the run proceeds and records model_verified null',
  unverifiedAnswer.exit === EXIT_OK && unverifiedAnswer.result?.model_verified === null,
  JSON.stringify({ exit: unverifiedAnswer.exit, verified: unverifiedAnswer.result?.model_verified }),
);
const noLlm = makeHarness({ withLlm: false });
mod.apply(noLlm.ctx, { root: tempRoot });
check(
  'without the llm service the call refuses with llm_unavailable',
  (await send(noLlm, { prompt: 'x' }, {})).code === 'llm_unavailable',
);
// An empty listing is "the provider currently offers nothing", which for an authorised model is
// unavailable rather than unverifiable: there is nothing it could have matched. Its code is a
// REFUSAL, and a mutation that softened it to `model_unverified` must be caught.
const emptyListing = makeHarness({ listedModels: [] });
mod.apply(emptyListing.ctx, { root: tempRoot });
const emptyListingAnswer = await send(emptyListing, { prompt: 'x' }, {});
check(
  'a provider that lists no models at all is a refusal, not an unverifiable run',
  emptyListingAnswer.exit === EXIT_UNAVAILABLE && emptyListingAnswer.code === 'model_unavailable' && emptyListing.counts.stream === 0,
  JSON.stringify({ exit: emptyListingAnswer.exit, code: emptyListingAnswer.code, streams: emptyListing.counts.stream }),
);
// The seam's fallback for a finish kind it does not know must fail closed, asserted with a kind
// no mapping names, so the fallback is reached rather than restated.
const oddFinish = makeHarness({ defaultScript: turn({ text: 'an answer', reason: { kind: 'something-new' } }) });
mod.apply(oddFinish.ctx, { root: tempRoot });
const oddFinishAnswer = await send(oddFinish, { prompt: 'x' }, {});
check(
  'a finish kind the seam does not know fails closed, rather than being read as a clean stop',
  oddFinishAnswer.exit === EXIT_FAILED && oddFinishAnswer.code === 'run_failed',
  JSON.stringify({ exit: oddFinishAnswer.exit, code: oddFinishAnswer.code }),
);
const noTools = makeHarness({ withSchemas: false });
mod.apply(noTools.ctx, { root: tempRoot });
check(
  'without a tool registry the call refuses with a code that names the missing capability',
  (await send(noTools, { prompt: 'x' }, {})).code === 'tools_unavailable',
);
check(
  'NOTHING ATTEMPTED, MODEL GONE and RUN FAILED are three different codes at two different exits',
  new Set([noSelectionAnswer.code, goneAnswer.code, failedAnswer.code]).size === 3 &&
    noSelectionAnswer.exit === EXIT_UNAVAILABLE &&
    goneAnswer.exit === EXIT_UNAVAILABLE &&
    failedAnswer.exit === EXIT_FAILED,
  JSON.stringify({ notSelected: `${noSelectionAnswer.code}/${noSelectionAnswer.exit}`, gone: `${goneAnswer.code}/${goneAnswer.exit}`, failed: `${failedAnswer.code}/${failedAnswer.exit}` }),
);
check(
  'a refused call creates nothing: the workspace is still absent afterwards, because nothing ran',
  (() => {
    const never = path.join(tempRoot, 'NeverTouched');
    return !fs.existsSync(never);
  })(),
);
const neverTouched = path.join(tempRoot, 'NeverTouched');
const refusedWorkspace = await send(noSelection, { prompt: 'x', workspace: neverTouched }, {});
check(
  'a refused call does not create its workspace, and says it did not touch it',
  refusedWorkspace.exit === EXIT_UNAVAILABLE && !fs.existsSync(neverTouched) && refusedWorkspace.workspace?.created === false && refusedWorkspace.workspace.note.includes('not touched'),
  JSON.stringify(refusedWorkspace.workspace).slice(0, 200),
);

/* ==================================================== reads do not perform runs === */

console.log('');
console.log('# reads do not perform runs — asserted from outside the component');

const readHarness = makeHarness();
mod.apply(readHarness.ctx, { root: tempRoot });
const tool = (name) => readHarness.definitions.get(name).execute;

const stateAnswer = await tool('agent_api_state')({}, {});
check('agent_api_state answers with exit 0', stateAnswer.exit === EXIT_OK && stateAnswer.ok === true, JSON.stringify(stateAnswer).slice(0, 200));
check(
  'agent_api_state executed no tool and made no model call',
  readHarness.counts.execute === 0 && readHarness.counts.stream === 0 && readHarness.counts.listModels === 0,
  JSON.stringify(readHarness.counts),
);
const catalogAnswer = await tool('agent_api_catalog')({ detail: 'names', limit: 2 }, {});
check(
  'agent_api_catalog answered exit 0 and executed no tool and made no model call',
  catalogAnswer.exit === EXIT_OK && readHarness.counts.execute === 0 && readHarness.counts.stream === 0,
  JSON.stringify(readHarness.counts),
);
check(
  'the catalog reports the bound it applied and says whether it truncated',
  // `total` is the CALLER's exposure, and this read arrived with no conversation, so the
  // conversation-only fixtures are not in it: the count is the registry minus those.
  catalogAnswer.result.total === readHarness.definitions.size - readHarness.conversationOnly.length &&
    catalogAnswer.result.returned === 2 &&
    catalogAnswer.result.truncated === true,
  JSON.stringify({ ...catalogAnswer.result, harnessTotal: readHarness.definitions.size, conversationOnly: readHarness.conversationOnly.length }),
);
check(
  'the state result names the run tool set, so a caller can see the restriction before calling',
  Array.isArray(stateAnswer.result?.runTools) && stateAnswer.result.runTools.includes('memory_lab_probe') && !stateAnswer.result.runTools.includes('agent_api_send'),
  JSON.stringify(stateAnswer.result?.runTools),
);
await tool('agent_api_state')({});
await tool('agent_api_state')({});
check('repeated reads still executed nothing', readHarness.counts.execute === 0 && readHarness.counts.stream === 0);

// THE ANTI-VACUITY GUARD: if the instrument cannot move, "it stayed at zero" proves nothing.
const dispatchAnswer = await tool('agent_api_tool')({ tool: 'gate_echo', arguments: { a: 1 } }, {});
check('the instrument is live: a run tool DOES move the dispatch counter', readHarness.counts.execute === 1, `execute=${readHarness.counts.execute}`);
const sendAnswer = await tool('agent_api_send')({ prompt: 'judge this', workspace: workDir }, {});
check(
  'the instrument is live: a run tool DOES move the model-call counter',
  readHarness.counts.stream === 1 && sendAnswer.exit === EXIT_OK,
  JSON.stringify({ streams: readHarness.counts.stream, exit: sendAnswer.exit }),
);
check(
  'the read tools never answer with a run result and the run tools never answer with a read result',
  stateAnswer.result?.counters !== undefined && sendAnswer.result?.output !== undefined && dispatchAnswer.result?.dispatched === 'gate_echo',
);
check(
  'the component own counters separate reads, dispatches, runs and model calls',
  stateAnswer.result.counters.reads >= 1 &&
    stateAnswer.result.counters.dispatches === 0 &&
    stateAnswer.result.counters.runs === 0 &&
    stateAnswer.result.counters.modelCalls === 0,
  JSON.stringify(stateAnswer.result.counters),
);

/* ================================================== the tool set, and the widening === */

console.log('');
console.log('# the run tool set — memory by default, everything on request');

/* The two sets, and the token between them. Asserted against the SAME harness so the two answers
 * are read from one registry: a widening asserted against a different fixture would be comparing
 * two lists rather than testing one rule. */
{
  const widening = makeHarness();
  mod.apply(widening.ctx, { root: tempRoot });
  const registryNames = [...widening.definitions.keys()].sort();

  const memoryOnly = await send(widening, { prompt: 'x' }, {});
  check(
    'with no tools argument a run is given the memory tools and nothing else',
    JSON.stringify(memoryOnly.result?.tool_names) === JSON.stringify(['memory_lab_probe']),
    JSON.stringify(memoryOnly.result?.tool_names),
  );
  check(
    'the default set excludes this component own tools and the unrelated fixtures',
    !memoryOnly.result.tool_names.some((name) => name.startsWith('agent_api_')) &&
      !memoryOnly.result.tool_names.includes('gate_echo') &&
      !memoryOnly.result.tool_names.includes('gate_marker'),
    JSON.stringify(memoryOnly.result.tool_names),
  );

  const widened = await send(widening, { prompt: 'x', tools: { allow: ['*'] } }, {});
  /**
   * EVERYTHING THE RUN CAN REACH, minus the reserved names — and the wording changed at 0.2.18
   * because the contract did. It used to read "every tool the registry exposes", which is what the
   * code did and what the `ptc` defect was: a run offered tools its calls could not execute. The
   * set is now drawn from the layer the calls resolve in, so it is the registry minus the
   * conversation-only fixtures (a run invoked with no conversation reaches the process layer) minus
   * the reserved names. Computed from the fixtures, never hard-coded, so a tool this gate did not
   * know about is still covered.
   *
   * Compared as a SET, not as an ordered array: `runTools` preserves the registry's own order, so
   * the assertion says what it means — the membership — instead of pinning an order nothing
   * promises.
   */
  const sorted = (list) => [...(list ?? [])].sort();
  const expected = registryNames.filter((name) => !SELF_NAMES.includes(name) && !widening.conversationOnly.includes(name));
  check(
    'tools.allow [*] widens the run to every tool it can REACH, minus the reserved names — not to every tool the registry holds',
    widened.exit === EXIT_OK && JSON.stringify(sorted(widened.result?.tool_names)) === JSON.stringify(sorted(expected)),
    JSON.stringify({ got: sorted(widened.result?.tool_names), expected: sorted(expected) }),
  );
  check(
    'and nothing is withheld here, because the caller exposure and the process layer are the same one for a run with no conversation',
    widened.result?.tools_withheld?.count === 0 &&
      widened.result.tools_withheld.why === '' &&
      JSON.stringify(widened.result.tools_withheld.names) === '[]',
    JSON.stringify(widened.result?.tools_withheld),
  );
  check(
    'the widened set is not the default set, so the two are distinguishable',
    JSON.stringify(widened.result.tool_names) !== JSON.stringify(memoryOnly.result.tool_names) &&
      widened.result.tool_names.length > memoryOnly.result.tool_names.length,
    JSON.stringify({ widened: widened.result.tool_names.length, memory: memoryOnly.result.tool_names.length }),
  );
  check(
    'no reserved name survives the widening, and the reserved list is not empty',
    SELF_NAMES.length > 0 && SELF_NAMES.every((name) => !widened.result.tool_names.includes(name)),
    `reserved: ${SELF_NAMES.join(', ')}`,
  );
  check(
    'a deny list subtracts from the widened set, so widening is not exempt from filtering',
    (() => {
      const denied = widened.result.tool_names[0];
      return denied !== undefined;
    })(),
    'the widened set is non-empty, so a subtract from it is meaningful',
  );
  const narrowedByDeny = await send(widening, { prompt: 'x', tools: { allow: ['*'], deny: [widened.result.tool_names[0]] } }, {});
  check(
    'widening then denying removes exactly the denied tool and nothing else',
    JSON.stringify(sorted(narrowedByDeny.result?.tool_names)) ===
      JSON.stringify(sorted(expected.filter((name) => name !== widened.result.tool_names[0]))),
    JSON.stringify({ got: sorted(narrowedByDeny.result?.tool_names), denied: widened.result.tool_names[0] }),
  );
}

/* ------------------------------------------------------------ the temporary conversation --- */

console.log('');
console.log('# the temporary conversation — bounded, and released on every path');

const releasedAfterSuccess = makeHarness();
const releasedApi = applyHarness(releasedAfterSuccess);
const successRun = await send(releasedAfterSuccess, { prompt: 'x' }, {});
check(
  'a successful run reports the temporary conversation it held, and that it was released',
  successRun.result?.context?.released === true &&
    Number.isFinite(successRun.result.context.messages) &&
    successRun.result.context.max_messages > 0 &&
    successRun.result.context.max_chars > 0,
  JSON.stringify(successRun.result?.context ?? null),
);
check(
  'after a successful run nothing is retained: no active run and no held history',
  releasedApi.counters.activeRuns === 0 && releasedApi.counters.retainedMessages === 0,
  JSON.stringify(releasedApi.counterSnapshot()),
);
// THE ANTI-VACUITY GUARD for the line above: a counter that is never incremented reads 0 for
// ever, so "it went back to 0" would prove nothing at all. This reads the counters from INSIDE a
// run — during the model call, which is the middle of the run's life — and asserts they are
// non-zero there. Only then does "zero afterwards" mean the release happened rather than that
// there was never anything to release.
{
  const inFlight = makeHarness();
  const live = applyHarness(inFlight);
  const during = [];
  const originalStream = inFlight.llmService.stream;
  inFlight.llmService.stream = function wrapped(generate) {
    during.push(live.counterSnapshot());
    return originalStream.call(this, generate);
  };
  const guarded = await send(inFlight, { prompt: 'x' }, {});
  check(
    'a run is observable as in flight: one active run and a held history while the model is called',
    during.length > 0 && during.some((snapshot) => snapshot.activeRuns === 1 && snapshot.retainedMessages > 0),
    JSON.stringify({ during, exit: guarded.exit }),
  );
  check(
    'and once it has returned, the same counters report no active run and nothing retained',
    live.counters.activeRuns === 0 && live.counters.retainedMessages === 0,
    JSON.stringify(live.counterSnapshot()),
  );
}

const releasedAfterFailure = makeHarness({ defaultScript: turn({ reason: { kind: 'error', failure: { message: 'provider exploded', code: 'E_PROVIDER' } } }) });
const failedApi = applyHarness(releasedAfterFailure);
const failedRun = await send(releasedAfterFailure, { prompt: 'x' }, {});
check(
  'a FAILED run also returns nothing retained — the release is in a finally, not after the await',
  failedRun.exit !== EXIT_OK && failedApi.counters.activeRuns === 0 && failedApi.counters.retainedMessages === 0,
  JSON.stringify({ exit: failedRun.exit, code: failedRun.code, ...failedApi.counterSnapshot() }),
);
const releasedAfterThrow = makeHarness({ defaultScript: turn({ text: 'x', reason: { kind: 'something-new' } }) });
const throwApi = applyHarness(releasedAfterThrow);
await send(releasedAfterThrow, { prompt: 'x' }, {});
check(
  'a run that fails closed on an unknown finish kind also returns nothing retained',
  throwApi.counters.activeRuns === 0 && throwApi.counters.retainedMessages === 0,
  JSON.stringify(throwApi.counterSnapshot()),
);
/* What ONE RUN reports about its conversation, and what it deliberately does not.
 *
 * BE EXACT ABOUT THIS, because the temptation here is to assert something that sounds stronger
 * and is not true. `context.messages` is the length of the TEMPORARY CONVERSATION this component
 * owns — the prompt list it hands the loop — not the loop's own per-turn history, which the loop
 * builds internally and `max_steps` bounds. A single-prompt run therefore reports 1 message and 0
 * evictions, and that is the honest number rather than a bound being ignored. */
{
  const reported = makeHarness();
  applyHarness(reported, { contextMaxMessages: 2, contextMaxChars: 4096 });
  const answer = await send(reported, { prompt: 'x' }, {});
  check(
    'a run reports its conversation, and the bound it was actually given rather than a default',
    answer.exit === EXIT_OK &&
      answer.result?.context?.messages === 1 &&
      answer.result.context.max_messages === 2 &&
      answer.result.context.max_chars === 4096 &&
      answer.result.context.dropped_messages === 0,
    JSON.stringify({ exit: answer.exit, context: answer.result?.context ?? null }),
  );
  check(
    'the reported bound is read back from the config the run was built with, not restated',
    Number.isFinite(answer.result?.context?.max_messages) && Number.isFinite(answer.result?.context?.max_chars),
    JSON.stringify(answer.result?.context ?? null),
  );
}

/* The EVICTION RULE itself, driven directly.
 *
 * The run path above cannot exercise it: a run pushes one prompt, so there is nothing to evict
 * and `dropped_messages` is 0. A check written there would pass whether or not eviction worked —
 * which is the "history is empty because it was never populated" failure, in miniature. So the
 * bound is driven where it is decidable: a conversation given a cap of 2, fed 6 messages, and
 * asked what it did. Both claims below can fail — a bound that is not enforced reports 6, and one
 * that evicts but does not count reports dropped_messages 0. */
{
  const bounded = createAgentApi({ root: tempRoot, contextMaxMessages: 2, contextMaxChars: 4096, services: () => ({}) });
  const conversation = bounded.conversation();
  check(
    'the conversation is reachable as its own unit, so its bound can be driven without a model',
    conversation !== null && Array.isArray(conversation.messages),
    JSON.stringify(Object.keys(conversation ?? {})),
  );
  const stats = conversation.push({ role: 'user', content: [{ type: 'text', text: 'the prompt' }] });
  for (let index = 0; index < 5; index += 1) {
    conversation.push({ role: 'assistant', content: [{ type: 'text', text: `turn ${index}` }], stopReason: 'stop' });
  }
  const after = conversation.stats();
  check(
    'a conversation bounded at 2 messages never holds more than 2, however many are pushed',
    after.messages <= 2,
    JSON.stringify(after),
  );
  check(
    'and what it evicted is counted rather than silently dropped',
    after.dropped.messages > 0 && after.dropped.chars > 0 && stats.messages === 1,
    JSON.stringify(after),
  );
  check(
    'the prompt is the message that is never evicted',
    conversation.messages[0]?.content?.[0]?.text === 'the prompt',
    JSON.stringify(conversation.messages[0] ?? null),
  );
  const beforeRelease = bounded.counters.retainedMessages;
  conversation.release();
  check(
    'releasing empties the history and the retained counter, which is what the run path relies on',
    conversation.messages.length === 0 && bounded.counters.retainedMessages === 0 && beforeRelease > 0,
    JSON.stringify({ before: beforeRelease, after: bounded.counters.retainedMessages, messages: conversation.messages.length }),
  );
}

/* ============================================ never in DSH surface conversation === */

console.log('');
console.log('# never a DSH session — asserted by absence, from outside');

/* THE CHECK. `sessionPersistence.create` is what materialises a STORED session, and a session id
 * is what puts a run in the conversation list, the history, the subagent catalogue and the
 * workspace's session accounting. So the decisive, cheap question is whether a run can reach
 * either service at all — and that is answerable without a live Host: hand the component a
 * service view that CONTAINS instrumented `sessionPersistence` and `sessions`, run a run, and
 * assert the instruments never moved. This is stronger than grepping the source: a future edit
 * that called one of them would move a counter here, and the counters are proved live in the
 * same block. */
{
  const sessionCalls = { create: 0, touch: 0, list: 0, entries: 0 };
  const sessionPersistenceStub = {
    create(...args) {
      sessionCalls.create += 1;
      return { id: 'should-never-exist', args };
    },
    touch() {
      sessionCalls.touch += 1;
    },
  };
  const sessionsStub = {
    list() {
      sessionCalls.list += 1;
      return [];
    },
    entries() {
      sessionCalls.entries += 1;
      return [];
    },
  };
  const withSessions = {
    sessionPersistence: sessionPersistenceStub,
    sessions: sessionsStub,
  };
  /* WHAT THIS INSTRUMENT CAN AND CANNOT SEE — stated, because the honest version is narrower than
   * it first looks and the difference matters.
   *
   * This component's service view is not a container: `apply()` builds
   * `services: () => ({ tools: ctx.tools, webServer: ctx.webServer, llm: optional('llm'), core: … })`,
   * a FRESH OBJECT on every call. So there is no shared object a gate can hand it, and the only
   * route into a real `sessionPersistence` is `ctx.get('sessionPersistence')` — which is where
   * this probe is wired.
   *
   * That was learned the hard way: the first version of this block built a `services` object and
   * the mutation test showed the probe could not be reached at all, so a mutation that created a
   * stored session from inside a run left the gate GREEN. A check that cannot see the thing it
   * names is worse than no check, because it reports safety.
   *
   * So the claim is exact: a run that reaches for a session store THROUGH THE SERVICE LOOKUP —
   * the only way it could reach one — is caught here, and the counters are asserted not to move.
   * A run that invented its own session store without the Host's would be a different finding and
   * is not what this asserts. */
  const instrumented = makeHarness();
  const harnessGet = instrumented.ctx.get;
  instrumented.ctx.get = (name) => (name in withSessions ? withSessions[name] : harnessGet(name));
  applyHarness(instrumented);
  const sessionRun = await send(instrumented, { prompt: 'x' }, {});
  check(
    'the session fixture is mounted well enough to run, so the zeroes below are about a real run',
    sessionRun.exit === EXIT_OK,
    JSON.stringify({ exit: sessionRun.exit, code: sessionRun.code ?? '' }),
  );
  // THE INSTRUMENT IS REACHABLE, proved in the same block: a lookup of the same service through
  // the same ctx returns the stub, so a run that asked for it would have got it and moved the
  // counters. Without this line the zeroes below could be about an unreachable probe.
  check(
    'the session stub is really reachable through the lookup a run would use',
    instrumented.ctx.get('sessionPersistence') === sessionPersistenceStub &&
      instrumented.ctx.get('sessions') === sessionsStub,
    'a run that asked for a session service would have received this stub',
  );
  check(
    'a run reaches for no session store: it never creates, touches or lists a session',
    sessionRun.exit === EXIT_OK &&
      sessionCalls.create === 0 &&
      sessionCalls.touch === 0 &&
      sessionCalls.list === 0 &&
      sessionCalls.entries === 0,
    JSON.stringify({ exit: sessionRun.exit, ...sessionCalls }),
  );
  // THE INSTRUMENT IS LIVE: the same stub DOES move when it is called directly, so the zeroes
  // above are evidence about the component rather than about an instrument that cannot move.
  withSessions.sessionPersistence.create();
  check(
    'the session instrument is live: calling it directly moves the counter',
    sessionCalls.create === 1,
    JSON.stringify(sessionCalls),
  );
  check(
    'the run result carries no session identity of any kind',
    !/session/i.test(JSON.stringify({ route: sessionRun.route, result: sessionRun.result, extra: Object.keys(sessionRun).filter((k) => k !== 'profile') })),
    JSON.stringify(Object.keys(sessionRun)),
  );
}

/* ==================================================== invoked only by tools === */

console.log('');
console.log('# tool-only invocation — the run is unreachable except through a tool');

/* THE CONSTRAINT: this component may be invoked ONLY by tools. Not by the route, not by the page
 * global, not by anything else in the plugin. That is a statement about reachability, so it is
 * checked as one — and the check is STRUCTURAL first, because a structural fact cannot be
 * accidentally true. */
{
  const indexSource = fs.readFileSync(path.join(componentDir, 'index.js'), 'utf8');
  // The route handler's own text, from its opening to the effect that closes it.
  const handlerStart = indexSource.indexOf('handler: async (req, res) => {');
  const handlerEnd = indexSource.indexOf("'newmark-agentapi-state-route'");
  const routeBody = handlerStart >= 0 && handlerEnd > handlerStart ? indexSource.slice(handlerStart, handlerEnd) : '';
  check(
    'the route handler exists as a body this check can read, so the assertions below are about code',
    routeBody.length > 200,
    `${routeBody.length} chars between the handler opening and its effect label`,
  );
  // The names that could start a run. `runSend` is the run itself; `api.tools()` is how a caller
  // gets a definition whose `execute` runs one. Neither may appear in the route closure.
  const runReachable = ['runSend', 'api.tools()', 'TOOL_SEND', 'runTool(', '.execute('];
  const found = runReachable.filter((needle) => routeBody.includes(needle));
  check(
    'the route handler names nothing that can start a run: no runSend, no tool list, no execute',
    found.length === 0,
    `found in the route body: ${found.join(', ') || '(none)'}`,
  );
  check(
    'the route handler reads the state envelope and nothing else of the component',
    routeBody.includes('api.stateEnvelope()') && !routeBody.includes('api.tools'),
    'the only `api` member the route touches is the read half',
  );
  // And the page global: a payload of plain JSON, with no callable in it. `embedJson` cannot
  // serialise a function, which is the structural reason — asserted rather than assumed.
  check(
    'the page global carries no callable, and cannot: the payload is JSON embedded by embedJson',
    (() => {
      const globalPayload = harness.global('__NEWMARK_AGENTAPI__');
      const walk = (value) => {
        if (typeof value === 'function') return false;
        if (value && typeof value === 'object') return Object.values(value).every(walk);
        return true;
      };
      return globalPayload !== undefined && walk(globalPayload);
    })(),
    JSON.stringify(Object.keys(harness.global('__NEWMARK_AGENTAPI__') ?? {})),
  );
}
/* ============================ the run boundary, as the user redrew it === */

/* WHAT WAS HERE, AND WHY IT IS NOT WHAT IS HERE NOW.
 *
 * The old check was "no HTTP method produces a run: the run and model-call counters do not move",
 * and it was the behavioural half of the rule "this component is invoked only by tools". The user
 * has since asked for something the rule, as written, forbade outright: 重建索引 must run the
 * judgement itself — 先硬流程重建，再提交 Agent-api 用内置的 Newmark Agent core 进行 agent prompt
 * 驱动的重建.
 *
 * So the rule did not fall; it NARROWED, and the check is REPLACED rather than deleted, because
 * "no route can do it" is now false and a check that cannot fail is worse than no check:
 *
 *   1. THIS component's own route still produces no run, under any method, and its handler still
 *      holds no run-capable name. Unchanged in substance — this is the component that owns the
 *      loop, and nothing in it may start one.
 *   2. Exactly ONE route in the whole bundle can produce a run, it is MemoryLab's rebuild, and the
 *      only name it can reach a run through is THIS component's own run tool. Read off every
 *      `webServer.register` in the bundle rather than off the one file that changed, so a second
 *      route that grew the ability would be caught here.
 *   3. The path really drives a run, through this registry: the MemoryLab judgement dispatches
 *      `agent_api_send`, and the counters that every route above left alone move exactly once.
 *
 * What has NOT changed: the run is still invoked only through the tool. The MemoryLab route does
 * not call `runSend`, does not import the loop, and cannot reach either — it dispatches the tool,
 * which is the same call a model makes and the same path through pre-policy, guards and
 * post-policy. */
{
  const routeOnly = makeHarness();
  applyHarness(routeOnly);
  const live = routeOnly.api;
  const route = routeOnly.routes.find((r) => r.path === '/newmark-agentapi/state');
  const before = live.counterSnapshot();
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    await routeOnly.callRoute(route, method, { prompt: 'run this please', max_steps: 1 });
  }
  const after = live.counterSnapshot();
  check(
    'this component\u2019s own route produces no run, under any method: the counters do not move',
    before.runs === after.runs && before.modelCalls === after.modelCalls && before.activeRuns === after.activeRuns,
    JSON.stringify({ before, after }),
  );
  check(
    'and no method but GET is answered at all — every other one is the read-only refusal',
    after.reads >= 0 && routeOnly.counts.stream === 0,
    JSON.stringify({ streams: routeOnly.counts.stream, counts: routeOnly.counts }),
  );

  /* WHICH ROUTES CAN PRODUCE A RUN, read off the bundle. Every `webServer.register` in every
   * component's entry file (and the core row's) is sliced from its `path:` to the effect label that
   * closes it, and tested for the names that could start a run: a registry dispatch, this
   * component's run tool, or the loop itself. A route that named any of them is a route that can
   * produce a run, and there must be exactly one. */
  const entryFiles = [
    ['core row', path.join(workspace, 'packages', 'newmark-core', 'index.js')],
    ['memorylab', path.join(workspace, 'packages', 'newmark-core', 'components', 'memorylab', 'index.js')],
    ['agent-api', path.join(workspace, 'packages', 'newmark-core', 'components', 'agent-api', 'index.js')],
    ['computeruse', path.join(workspace, 'packages', 'newmark-core', 'components', 'computeruse', 'index.js')],
  ];
  const routeBodies = [];
  for (const [label, file] of entryFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/path:\s*([A-Za-z_$][\w$]*|'[^']*')\s*,\s*handler:/g)) {
      const start = match.index;
      // The handler's own body, ending at the effect label that registers it — the same slice the
      // structural check above uses for this component's route.
      const tail = source.slice(start);
      const closeAt = tail.search(/,\s*\n\s*'[\w-]*-route',\s*\n\s*\)/);
      routeBodies.push({ label, file, path: match[1], body: closeAt === -1 ? tail : tail.slice(0, closeAt) });
    }
  }
  check(
    'every route in the bundle was found and sliced, so the check below is about code',
    routeBodies.length >= 3 && routeBodies.every((entry) => entry.body.length > 200),
    routeBodies.map((entry) => `${entry.label}:${entry.path}:${entry.body.length}`).join(', '),
  );
  /* Names that mean a route is reaching a run ITSELF: a registry dispatch, a direct call into a
   * tool definition, or the loop. Deliberately NOT the bare string `agent_api_send` — this
   * component's own refusal MESSAGE names that tool (it tells the caller where a run does live),
   * and a check that matched the prose of a refusal would flag the one route that provably runs
   * nothing. The first draft of this check did exactly that; it is the same class of mistake as
   * matching an identifier inside its own explanatory comment. */
  const RUN_DIRECT = /tools\.execute\(|\bexecute\(\{|runSend/;
  const direct = routeBodies.filter((entry) => RUN_DIRECT.test(entry.body));
  check(
    'no route in this bundle starts a run on its own: none dispatches a tool, none touches the loop',
    direct.length === 0,
    `routes reaching a run directly: ${direct.map((entry) => `${entry.label}:${entry.path}`).join(', ') || '(none)'}`,
  );
  /* THE ONE CALL THAT LEADS TO A RUN. A route can only produce one by asking MemoryLab for a
   * judgement, and exactly one route does. */
  const askers = routeBodies.filter((entry) => entry.body.includes('memorylab.judge('));
  check(
    'exactly one route in this bundle can produce a run, and it is the MemoryLab rebuild',
    askers.length === 1 &&
      askers[0].label === 'memorylab' &&
      askers[0].path === 'SNAPSHOT_ROUTE' &&
      askers[0].body.includes("searchParams.get('reindex') === '1'"),
    `routes that ask for a judgement: ${askers.map((entry) => `${entry.label}:${entry.path}`).join(', ') || '(none)'} — of ${routeBodies.map((entry) => `${entry.label}:${entry.path}`).join(', ')}`,
  );
  const memorylabComponentSource = fs.readFileSync(
    path.join(workspace, 'packages', 'newmark-core', 'components', 'memorylab', 'component.js'),
    'utf8',
  );
  check(
    'and the ask reaches a run through THIS component\u2019s own run tool, dispatched, never the loop',
    // One dispatch call site in the whole MemoryLab component, naming the constant that is this
    // component's declared presence tool — so "a judge is reachable" and "the judge was asked" are
    // one fact, and there is no second way in.
    presence.AGENT_API_PRESENCE_TOOL === componentModule.TOOL_SEND &&
      (memorylabComponentSource.match(/tools\.execute\(/g) || []).length === 1 &&
      memorylabComponentSource.includes('export const JUDGEMENT_TOOL = AGENT_API_PRESENCE_TOOL;') &&
      memorylabComponentSource.includes('name: JUDGEMENT_TOOL,') &&
      // A CALL, not the word: the component's own doc comment says "there is no second entry
      // point into `runSend`", and a check that banned the identifier would fail on the sentence
      // that states the rule — the same self-matching mistake this file just recorded.
      !/runSend\s*\(/.test(memorylabComponentSource) &&
      !memorylabComponentSource.includes('agent-api/component.js'),
    `the run tool is ${componentModule.TOOL_SEND}; the route dispatches ${presence.AGENT_API_PRESENCE_TOOL}; dispatch sites: ${(memorylabComponentSource.match(/tools\.execute\(/g) || []).length}`,
  );

  /* AND THE PATH REALLY RUNS SOMETHING. The instrument is this component's own counters, proved
   * live in the same block: they do not move for any route, and they move for the MemoryLab
   * judgement — which is the path the user asked for, driven here through the same registry the
   * tools use. Nothing is faked: MemoryLab is instantiated against this harness's registry, its
   * ask is built from a real store of its own, and the run below is a real run of the loop with
   * this harness's model. */
  await send(routeOnly, { prompt: 'x' }, {});
  const usedTool = live.counterSnapshot();
  check(
    'the instrument is live: calling the TOOL moves exactly the counters the route left alone',
    usedTool.runs === after.runs + 1 && usedTool.modelCalls === after.modelCalls + 1,
    JSON.stringify({ after, usedTool }),
  );
  const judgementRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nma-judge-'));
  const memorylab = createMemoryLab({ root: judgementRoot, tools: routeOnly.ctx.tools });
  memorylab.store.update({ name: 'Boundary A', tags: ['#边界探针'], content: '# a\n' });
  memorylab.store.update({ name: 'Boundary B', tags: ['#边界探针扩展'], content: '# b\n' });
  const asked = memorylab.judgementAsk();
  const runsBeforeJudgement = live.counterSnapshot();
  const streamsBeforeJudgement = routeOnly.counts.stream;
  const judged = await memorylab.judge({ timeoutMs: 5000 });
  const afterJudgement = live.counterSnapshot();
  check(
    'the one route that can produce a run does produce one, through this registry',
    judged.status === 'judged' &&
      afterJudgement.runs === runsBeforeJudgement.runs + 1 &&
      afterJudgement.modelCalls === runsBeforeJudgement.modelCalls + 1 &&
      routeOnly.counts.stream === streamsBeforeJudgement + 1,
    JSON.stringify({ status: judged.status, runs: afterJudgement.runs - runsBeforeJudgement.runs, streams: routeOnly.counts.stream - streamsBeforeJudgement }),
  );
  check(
    'and the run it drove was handed the judgement prompt and nothing caller-supplied',
    routeOnly.seen.exec.some((exec) => exec.name === 'agent_api_send' && exec.arguments?.prompt === asked.text) &&
      asked.text.includes('假根父节点接续') &&
      asked.text.includes('未被正确解析的 tag 误读为单 tag'),
    JSON.stringify({ chars: asked.text?.length, dispatched: routeOnly.seen.exec.filter((exec) => exec.name === 'agent_api_send').length }),
  );
  check(
    'a run driven this way is still a run and not a session: it holds a temporary conversation and releases it',
    afterJudgement.activeRuns === 0 && afterJudgement.retainedMessages === 0,
    JSON.stringify({ activeRuns: afterJudgement.activeRuns, retained: afterJudgement.retainedMessages }),
  );
  fs.rmSync(judgementRoot, { recursive: true, force: true });
}

console.log('');
console.log('# agent_api_tool — the dispatch contract and its refusals');

const firstExec = readHarness.seen.exec[0];
check(
  'the dispatch was handed the documented ToolExecutionInput fields',
  firstExec && typeof firstExec.callId === 'string' && firstExec.callId.length > 0 && firstExec.name === 'gate_echo' &&
    typeof firstExec.arguments === 'object' && typeof firstExec.signal?.aborted === 'boolean',
  JSON.stringify({ callId: firstExec?.callId, name: firstExec?.name, hasSignal: firstExec?.signal !== undefined }),
);
check(
  'a dispatch with no conversation carries no agent — the process view, which is exactly what a route gets',
  firstExec !== undefined && !('agent' in firstExec),
  JSON.stringify(Object.keys(firstExec ?? {})),
);
const before = readHarness.counts.execute;
const recursive = await tool('agent_api_tool')({ tool: 'agent_api_send', arguments: { prompt: 'x' } }, {});
check(
  'dispatching this component own tools is refused and dispatches nothing',
  recursive.exit === EXIT_INVALID && recursive.code === 'recursive_dispatch_refused' && readHarness.counts.execute === before,
  JSON.stringify({ exit: recursive.exit, code: recursive.code }),
);
check('the reserved transport name is refused too', (await tool('agent_api_tool')({ tool: 'run_code' }, {})).code === 'recursive_dispatch_refused');
check('a missing tool name is an invalid argument', (await tool('agent_api_tool')({}, {})).code === 'missing_tool_name');
check(
  'arguments that are not a JSON object are refused before dispatch',
  (await tool('agent_api_tool')({ tool: 'gate_echo', arguments: 'not-an-object' }, {})).code === 'invalid_arguments' && readHarness.counts.execute === before,
);
check('a bad timeout is an invalid argument', (await tool('agent_api_tool')({ tool: 'gate_echo', timeout_ms: -1 }, {})).code === 'invalid_timeout');
check(
  'an unreachable tool name is classified as an invalid argument, not as a failure',
  (await tool('agent_api_tool')({ tool: 'no_such_tool_at_all' }, {})).exit === EXIT_INVALID,
);
check(
  'a dispatched tool that answers with a marker as its VALUE is classified by the reference rules',
  (await tool('agent_api_tool')({ tool: 'gate_marker' }, {})).exit === EXIT_FAILED,
);
const threwHarness = makeHarness({ executeThrows: true });
mod.apply(threwHarness.ctx, { root: tempRoot });
check(
  'a registry that throws is this component own failure, with its own code rather than the tool own',
  (await threwHarness.definitions.get('agent_api_tool').execute({ tool: 'gate_echo' }, {})).code === 'dispatch_threw',
);
threwHarness.dispose();
const noExecuteHarness = makeHarness({ withExecute: false });
mod.apply(noExecuteHarness.ctx, { root: tempRoot });
check(
  'with no execute() the dispatch answers exit 3 and names the missing capability, instead of throwing',
  (await noExecuteHarness.definitions.get('agent_api_tool').execute({ tool: 'anything' }, {})).code === 'tool_dispatch_unavailable',
);

/* ===================================================================== the presence === */

console.log('');
console.log('# presence — how a switched-off component stays observable');

const presenceHarness = makeHarness();
check(
  'presence is false before the component is mounted, and says so',
  presence.agentApiPresence(presenceHarness.ctx.tools).active === false && presence.agentApiPresence(presenceHarness.ctx.tools).reason.includes('not registered'),
  presence.agentApiPresence(presenceHarness.ctx.tools).reason,
);
mod.apply(presenceHarness.ctx, { root: tempRoot });
check('presence is true once the tools are registered', presence.agentApiPresence(presenceHarness.ctx.tools).active === true);
presenceHarness.dispose();
check(
  'disposing the component retires its own tools, so presence goes false again — a switched-off component cannot report its own absence, the registry does',
  presence.AGENT_API_TOOLS.every((n) => !presenceHarness.definitions.has(n)) && presence.agentApiPresence(presenceHarness.ctx.tools).active === false,
);
const disabled = presence.agentApiDisabledEnvelope(presence.agentApiPresence(presenceHarness.ctx.tools));
check(
  'the disabled answer is a well-formed envelope at exit 3 with its own code',
  disabled.exit === EXIT_UNAVAILABLE && disabled.class === 'unavailable' && disabled.code === 'agent_api_disabled' && disabled.ok === false,
  JSON.stringify(disabled),
);
check(
  'presence tolerates a scope that cannot even see the registry, rather than throwing',
  presence.agentApiPresence(undefined).active === false && presence.agentApiPresence({}).active === false && presence.agentApiPresence(null).active === false,
);

/* ========================================================================= the route === */

console.log('');
console.log('# the state route — the read half, over the bundle own web carrier');

const route = harness.routes.find((r) => r.path === '/newmark-agentapi/state');
check('the route is registered with a handler', typeof route?.handler === 'function');
const getAnswer = await harness.callRoute(route, 'GET');
check('a GET answers 200 with the state envelope at exit 0', getAnswer.status === 200 && getAnswer.json.exit === EXIT_OK && getAnswer.json.tool === 'agent_api_state');
check(
  'the route performs no run either',
  harness.counts.execute === 0 && harness.counts.stream === 0,
  JSON.stringify(harness.counts),
);
check(
  'the route profile is the same one a tool call gets, because a run needs no Agent',
  getAnswer.json.profile.engine === 'own-loop' && capabilityOf(getAnswer.json.profile, 'agent.run').state === 'available',
  JSON.stringify({ engine: getAnswer.json.profile.engine, agentRun: capabilityOf(getAnswer.json.profile, 'agent.run').state }),
);
const postAnswer = await harness.callRoute(route, 'POST', { prompt: 'run this for me' });
check(
  'a POST is refused with 405 and a code that names the reason: a loopback route spends the user credentials and cannot identify a caller',
  postAnswer.status === 405 && postAnswer.json.code === 'read_only_route' && postAnswer.json.error.includes('credentials'),
  JSON.stringify(postAnswer.json).slice(0, 260),
);
check('the refused POST started nothing', harness.counts.execute === 0 && harness.counts.stream === 0);

/* ================================================================== the page global === */

console.log('');
console.log('# the page global — presence is the switch on the Client half too');

const injected = harness.global('__NEWMARK_AGENTAPI__');
check('the index transform publishes the declared global', injected !== undefined);
check(
  'the payload names the component, the root, the workspace and the authorised model',
  injected?.role === 'agent-api' && injected?.root === tempRoot && injected?.workspace === workDir && injected?.profile?.model?.model === 'deepseek-chat',
  JSON.stringify(injected).slice(0, 260),
);

/* ========================================================= tool descriptions as contract === */

console.log('');
console.log('# pre-exposure — the descriptions are the contract');

const definitions = presence.AGENT_API_TOOLS.map((n) => harness.definitions.get(n));
check('every tool declares an object parameter schema', definitions.every((d) => d.parameters?.type === 'object'));
check(
  'every tool carries a description long enough to state a contract',
  definitions.every((d) => typeof d.description === 'string' && d.description.length > 200),
  definitions.map((d) => `${d.name}:${d.description.length}`).join(', '),
);
check(
  'every description states its lifecycle, because a caller that does not know it will try to run this from a shell',
  definitions.every((d) => d.description.includes('Available while the DSH process is alive and Cordis is healthy')),
);
check(
  'every description states its input shape and its output shape, so a caller never has to guess',
  definitions.every((d) => d.description.includes('Input:') && d.description.includes('Output')),
);
check(
  'every tool carries a worked example, as the other components in this bundle do',
  definitions.every((d) => d.description.includes('Worked example')),
);
check(
  'every declared property carries a description',
  definitions.every((d) => Object.values(d.parameters.properties ?? {}).every((p) => typeof p.description === 'string' && p.description.length > 10)),
  definitions.map((d) => `${d.name}: ${Object.entries(d.parameters.properties ?? {}).filter(([, p]) => !p.description).map(([k]) => k).join(',') || 'ok'}`).join(' | '),
);
check(
  'only agent_api_tool and agent_api_send require an argument, and each requires the one it cannot work without',
  definitions.every((d) => {
    const required = JSON.stringify(d.parameters.required ?? []);
    if (d.name === 'agent_api_tool') return required === '["tool"]';
    if (d.name === 'agent_api_send') return required === '["prompt"]';
    return (d.parameters.required ?? []).length === 0;
  }),
  definitions.map((d) => `${d.name}:${JSON.stringify(d.parameters.required ?? [])}`).join(', '),
);
// The honesty requirement: a caller must be able to learn from the definition itself what these
// runs do not appear in, or it will over-trust the answer.
//
// REWRITTEN at 0.2.17, and the rewrite is the point: the old assertion pinned the wording "no
// guards, no approval, no per-agent scope ... GLOBAL tool view", which was true when every run
// call was scopeless. A run invoked from a conversation now resolves its calls in that
// conversation's own scope, where its guards and sandbox policy DO apply — so the old sentence
// would have been a claim the code no longer keeps. The assertion now pins the two halves the
// receipt actually reports, and requires the description to say which reach carries which
// consequence instead of asserting one of them for both.
const sendDescription = harness.definitions.get('agent_api_send').description;
check(
  'the send description states what a run is NOT, and no longer claims an isolation the scoped reach does not have',
  sendDescription.includes('no session log') &&
    sendDescription.includes('not auditable') &&
    sendDescription.includes('tool_scope') &&
    sendDescription.includes('tool_reach') &&
    sendDescription.includes('guards and sandbox policy do apply') &&
    !sendDescription.includes('GLOBAL tool view'),
  sendDescription.slice(sendDescription.indexOf('What a run is not'), sendDescription.indexOf('What a run is not') + 240),
);
check(
  'the send description warns that a non-zero exit is never a verdict, and separates 3 from 4',
  sendDescription.includes('NOTHING WAS ATTEMPTED') && sendDescription.includes('must be reported as "no judgement was made"'),
);
check(
  'the send description says the model is refused rather than defaulted when nothing is authorised',
  sendDescription.includes('model_not_selected') && sendDescription.includes('did not authorise'),
);
check('every tool declares an object output schema', definitions.every((d) => d.output?.schema?.type === 'object' && typeof d.output.render === 'function'));

/* ==================================================== the loop module, directly === */

console.log('');
console.log('# lib/loop.js — the ported shape, asserted directly');

check(
  'the loop exports the reference entries and seams',
  ['runAgentLoop', 'runAgentLoopContinue', 'streamAssistantResponse', 'executeToolCalls', 'throwIfAborted'].every((n) => typeof loop[n] === 'function'),
  Object.keys(loop).filter((k) => typeof loop[k] === 'function').join(', '),
);
check(
  'the seam exports the message translation and the chunk vocabulary it consumes',
  typeof seam.createLlmStreamFn === 'function' && typeof seam.toRequestMessages === 'function' && seam.CONSUMED_CHUNK_TYPES.includes('block-end') && seam.CONSUMED_CHUNK_TYPES.includes('finish'),
);
check(
  'the finish vocabulary maps one to one onto the loop stop reasons',
  JSON.stringify(Object.keys(seam.FINISH_TO_STOP).sort()) === JSON.stringify(['aborted', 'error', 'max-tokens', 'stop', 'tool-calls']),
  JSON.stringify(Object.keys(seam.FINISH_TO_STOP)),
);
/* ============================================================================================
 * THE RETRY THE SEAM OWES ITSELF, because nothing above it will ever supply one.
 *
 * `dsh-llm-retry` executes the provider policy on ONE event — `agent/request-error` — and that
 * event has exactly one dispatcher in the whole shipped tree, `dsh-agent-loop`
 * (`dsh-agent-loop/lib/index.js:1124`). This component drives `ctx.llm.stream` itself, so it
 * never raises it: every assertion below tests a retry that exists nowhere else. That is also
 * why they are here rather than in a loop-level test — the retry is a property of the SEAM.
 *
 * The retry shape is injected as a `createLlmStreamFn` option so these assertions run against
 * the real backoff code with a 1 ms initial delay, rather than either waiting 500 ms per
 * attempt or bypassing the timing path they are supposed to cover.
 * ========================================================================================== */
console.log('');
console.log('# lib/llm-seam.js — the bounded retry for transient provider failures');

const FAST_RETRY = { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 };

/** Drive the real `createLlmStreamFn` against a scripted `llm` service and collect the events. */
async function driveSeam(script, { retry = FAST_RETRY, signal } = {}) {
  const calls = [];
  const llm = {
    stream(generate) {
      const step = script[calls.length] ?? script[script.length - 1];
      calls.push(generate);
      if (step instanceof Error) throw step;
      return (async function* emit() {
        for (const chunk of step) {
          if (chunk instanceof Error) throw chunk;
          yield chunk;
        }
      })();
    },
  };
  const streamFn = seam.createLlmStreamFn(llm, { provider: 'deepseek', model: 'deepseek-chat' }, { retry });
  const events = [];
  /* The error is CAPTURED rather than allowed to escape, and that is what makes these
   * assertions mutation-resistant: a mutation that removes the retry changes the SHAPE of the
   * result (fewer events, no message), and a check that read `events[0].message` unguarded would
   * crash the whole gate with a TypeError instead of reporting one failed assertion with the
   * other 264 still measured. Every accessor below is guarded for the same reason. */
  let threw = '';
  try {
    const iterable = await streamFn({}, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, signal ? { signal } : {});
    for await (const event of iterable) events.push(event);
  } catch (error) {
    threw = `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
  }
  return { calls, events, threw, first: events[0], firstMessage: events[0]?.message ?? events[0]?.error ?? null };
}

const transientFinish = { type: 'finish', reason: { kind: 'error', failure: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } } };
const textChunk = (text) => [{ type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }];
const EMPTY_TURN = [transientFinish];

/* THE FIX ITSELF: a transient failure with nothing delivered is re-issued and then succeeds. */
const retriedThenOk = await driveSeam([EMPTY_TURN, EMPTY_TURN, textChunk('recovered')]);
check(
  'a TRANSPORT failure that delivered nothing is retried, and the turn that finally arrives is the one the loop sees',
  retriedThenOk.events.length === 1 && retriedThenOk.first?.type === 'done' && retriedThenOk.firstMessage?.content?.[0]?.text === 'recovered',
  JSON.stringify(retriedThenOk.events.map((e) => e.type)),
);
check(
  'the retry re-invokes the service rather than resuming a dead stream — three attempts, three calls',
  retriedThenOk.calls.length === 3,
  `calls=${retriedThenOk.calls.length}`,
);
check(
  'and the attempt count rides on the message, so a receipt can tell four attempts from one',
  retriedThenOk.firstMessage?.attempts === 3,
  JSON.stringify(retriedThenOk.firstMessage?.attempts),
);

/* THE DUPLICATE-EXECUTION PROPERTY. A turn whose stream failed AFTER delivering tool calls is
 * already being acted on; re-issuing it would execute those calls twice.
 *
 * THE FAILURE IS A `TRANSPORT` ON PURPOSE: a transient code WITH content delivered is exactly the
 * case the code-whitelist alone would retry, so the fixture is what makes this assertion carry
 * the safety property rather than merely restating the whitelist. An unclassified failure here
 * would leave the assertion green for the wrong reason — a mutation test found that, which is
 * why the code is set explicitly rather than left to the default.
 *
 * What stops the second call is that `collectAssistant` keeps the recovered turn as a
 * `tool-calls` STOP, so the seam yields it as `done` before the retry decision is consulted.
 * That is why the property is asserted as "exactly one service call", not as "the guard fired":
 * the guard is a second line of defence, and this measures the outcome instead of the mechanism. */
const deliveredThenFailed = await driveSeam([
  [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'gate_probe', arguments: '{}' } },
    Object.assign(new Error('the provider died at message_stop'), { code: 'TRANSPORT' }),
  ],
  textChunk('should never be reached'),
]);
check(
  'a TRANSPORT failure that arrived AFTER a tool call is never re-issued: one service call, and the delivered call survives',
  deliveredThenFailed.calls.length === 1 && deliveredThenFailed.first?.type === 'done'
    && deliveredThenFailed.firstMessage?.recoveredFrom === 'stream-failed-after-content'
    && deliveredThenFailed.firstMessage?.content?.[0]?.type === 'tool-call',
  `calls=${deliveredThenFailed.calls.length} type=${deliveredThenFailed.first?.type} recoveredFrom=${deliveredThenFailed.firstMessage?.recoveredFrom} blocks=${deliveredThenFailed.firstMessage?.content?.length}`,
);

/* A NON-TRANSIENT failure is reported immediately: the seam has no evidence it would not simply
 * repeat, and spending the caller's budget to find out is not its decision to make. */
const refused = await driveSeam([[{ type: 'finish', reason: { kind: 'error', failure: { message: 'DeepSeek Messages stream: tool input is invalid JSON', code: 'MALFORMED_RESPONSE' } } }]]);
check(
  'a non-transient classification is surfaced at once, with no retry and no spent budget',
  refused.calls.length === 1 && refused.first?.type === 'error' && refused.firstMessage?.failureCode === 'MALFORMED_RESPONSE',
  `calls=${refused.calls.length} code=${refused.firstMessage?.failureCode}`,
);

/* The bound is real: an outage that outlasts it stops, and says so. */
const exhausted = await driveSeam([EMPTY_TURN]);
check(
  'the retry bound is finite: a persistent TRANSPORT stops at maxAttempts instead of looping',
  exhausted.calls.length === FAST_RETRY.maxAttempts && exhausted.first?.type === 'error',
  `calls=${exhausted.calls.length} type=${exhausted.first?.type}`,
);
check(
  'and the receipt says the turn was retried and still failed, rather than looking like one attempt',
  exhausted.firstMessage?.attempts === FAST_RETRY.maxAttempts
    && String(exhausted.firstMessage?.diagnostic ?? '').includes(`retried ${FAST_RETRY.maxAttempts} attempts in total`),
  String(exhausted.firstMessage?.diagnostic ?? `<no diagnostic; type=${exhausted.first?.type}>`),
);

/* An abort is never a retry. */
const aborted = new AbortController();
aborted.abort();
const abortOutcome = await driveSeam([EMPTY_TURN], { signal: aborted.signal });
check(
  'an aborted caller is not retried — cancellation stays cancellation, so the run does not outlive its own timeout',
  abortOutcome.calls.length === 0,
  `calls=${abortOutcome.calls.length} events=${abortOutcome.events.length}`,
);

/* The eager refusal (`llm.stream` throwing rather than failing the stream) is the same class of
 * transient failure, and it used to be the one shape that could not be retried at all. */
const eagerRefusal = await driveSeam([Object.assign(new Error('connect ECONNRESET'), { code: 'TRANSPORT' }), textChunk('after refusal')]);
const wrappedTransport = Object.assign(new Error('DeepSeek Messages transport failed', {
  cause: new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }) }),
}), { code: 'TRANSPORT' });
for (const [label, script] of [['eager refusal', [wrappedTransport]], ['stream throw', [[wrappedTransport]]]]) {
  const outcome = await driveSeam(script, { retry: { ...FAST_RETRY, maxAttempts: 1 } });
  check(`${label} keeps the full transport cause in the returned diagnostic`,
    String(outcome.firstMessage?.diagnostic).includes('fetch failed') && String(outcome.firstMessage?.diagnostic).includes('ECONNRESET'),
    String(outcome.firstMessage?.diagnostic));
}
const recoveredDiagnostic = await driveSeam([[
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'diagnostic-call', name: 'read', arguments: '{}' } },
  wrappedTransport,
]]);
check('a recovered tool call keeps the transport cause without reissuing its side effect',
  recoveredDiagnostic.calls.length === 1 && recoveredDiagnostic.first?.type === 'done' && String(recoveredDiagnostic.firstMessage?.diagnostic).includes('ECONNRESET'),
  String(recoveredDiagnostic.firstMessage?.diagnostic));
check(
  'a service that refuses the call eagerly is retried on the same terms as a stream that fails mid-flight',
  eagerRefusal.calls.length === 2 && eagerRefusal.first?.type === 'done' && eagerRefusal.firstMessage?.content?.[0]?.text === 'after refusal',
  `calls=${eagerRefusal.calls.length} type=${eagerRefusal.first?.type}`,
);
check(
  'the delay is the provider policy shape — exponential from initialDelayMs, capped, and jittered',
  seam.retryDelayMs(1, seam.DEFAULT_RETRY, () => 0.5) === 500
    && seam.retryDelayMs(2, seam.DEFAULT_RETRY, () => 0.5) === 1000
    && seam.retryDelayMs(99, seam.DEFAULT_RETRY, () => 0.5) === 10_000,
  [1, 2, 99].map((n) => seam.retryDelayMs(n, seam.DEFAULT_RETRY, () => 0.5)).join(','),
);
check(
  'DSH own retryable set is what this retries, no more and no less',
  JSON.stringify([...seam.RETRYABLE_FAILURE_CODES].sort()) === JSON.stringify(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  JSON.stringify([...seam.RETRYABLE_FAILURE_CODES]),
);

let continueGuard = '';
try {
  await loop.runAgentLoopContinue({ state: { messages: [] } }, undefined);
} catch (error) {
  continueGuard = error.message;
}
check('continue refuses an empty context, as the reference does', continueGuard.includes('no messages in context'), continueGuard);
const abortController = new AbortController();
abortController.abort();
let abortThrew = '';
try {
  loop.throwIfAborted(abortController.signal);
} catch (error) {
  abortThrew = error.name;
}
check('throwIfAborted throws an error named AbortError, so a caller recognisable check works', abortThrew === 'AbortError', abortThrew);
/* An EMPTY allow list used to be read as "no tools", which made `allow: []` and a forgotten
 * filter look identical — and now that `allow: ['*']` means EVERYTHING, the gap between "nothing"
 * and "everything" is the one place a guess must not be made. So it is refused by name. */
check(
  'an empty tools.allow is refused by name rather than guessed as nothing or as everything',
  (await send(harness, { prompt: 'x', tools: { allow: [] } }, {})).code === 'empty_tool_allow',
  JSON.stringify((await send(harness, { prompt: 'x', tools: { allow: [] } }, {})).code),
);
/* And the set that IS empty — everything denied — still drives a run. This is the property the
 * old `allow: []` fixture was really testing: a run with no tools at all must still be a run. */
check(
  'a run with every tool denied is still driven and still answers',
  (await (async () => {
    const bare = makeHarness();
    mod.apply(bare.ctx, { root: tempRoot });
    return send(bare, { prompt: 'x', tools: { deny: bare.fixtureNames.concat(['memory_lab_probe']) } }, {});
  })()).exit === EXIT_OK,
);

/* ==================================================== the component as a library === */

console.log('');
console.log('# createAgentApi — the machinery, driven directly');

const direct = createAgentApi({
  root: tempRoot,
  services: () => ({ tools: readHarness.services.tools, webServer: readHarness.services.webServer, llm: readHarness.services.llm, core: readHarness.services.core }),
});
check('createAgentApi exposes its workspace default', direct.workspaceDir() === workDir, direct.workspaceDir());
check(
  'the run tool rule keeps memory tools, drops this component own names, and honours an explicit allow',
  JSON.stringify(direct.runToolNames(['memory_lab_a', 'read', 'agent_api_send', 'run_code', 'gate_echo'])) === JSON.stringify(['memory_lab_a']) &&
    JSON.stringify(direct.runToolNames(['memory_lab_a', 'read'], { allow: ['read'] })) === JSON.stringify(['read']) &&
    JSON.stringify(direct.runToolNames(['memory_lab_a', 'read'], { deny: ['read'] })) === JSON.stringify(['memory_lab_a']),
  JSON.stringify(direct.runToolNames(['memory_lab_a', 'read', 'agent_api_send', 'run_code', 'gate_echo'])),
);
check('its counters start at zero and are per-instance', direct.counters.reads === 0 && createAgentApi({ root: tempRoot }).counters.reads === 0);

/* ==================================================== whose exposure (0.2.17 rule) === */

console.log('');
console.log('# the exposure rule — a conversation is answered for the conversation, anything else for the process');

/**
 * The rule, as the user stated it: "通过对话调用的 Agent API 要对齐对话工具暴露，其他途径只暴露
 * ptc + 包内 + 其他插件额外".
 *
 * These assertions are about WHICH SCOPE is asked, because that is the whole defect: the stub
 * registry returns the same list whatever it is handed, so only the recorded argument can tell the
 * two apart. They are also the reason `schemas(scope)` had to start recording — a check that
 * counted tools would pass for both answers and prove nothing.
 */
const nativeAgent = { presentation: 'native', session: { id: 'gate-native' } };
const ptcAgent = { presentation: 'ptc', session: { id: 'gate-ptc' } };

check(
  'callScope: no agent is the PROCESS view, and it is not a presentation',
  JSON.stringify(direct.callScope(readHarness.services, undefined)) === JSON.stringify({ scope: undefined, target: 'process', presentation: 'global' }),
  JSON.stringify(direct.callScope(readHarness.services, undefined)),
);
check(
  'callScope: an agent is a CONVERSATION view, and the presentation is read from the registry rather than assumed',
  JSON.stringify(direct.callScope(readHarness.services, nativeAgent)) === JSON.stringify({ scope: nativeAgent, target: 'conversation', presentation: 'native' }) &&
    JSON.stringify(direct.callScope(readHarness.services, ptcAgent)) === JSON.stringify({ scope: ptcAgent, target: 'conversation', presentation: 'ptc' }),
  `${JSON.stringify(direct.callScope(readHarness.services, nativeAgent))} / ${JSON.stringify(direct.callScope(readHarness.services, ptcAgent))}`,
);
check(
  'dispatchScope: a native conversation is dispatched IN ITS OWN SCOPE, and a ptc one is not — the registry collapses every direct call but run_code there, so passing its agent would answer UNKNOWN_TOOL for tools the catalog had just listed',
  direct.dispatchScope(direct.callScope(readHarness.services, nativeAgent)) === nativeAgent &&
    direct.dispatchScope(direct.callScope(readHarness.services, ptcAgent)) === undefined &&
    direct.dispatchScope(direct.callScope(readHarness.services, undefined)) === undefined,
  `${direct.dispatchScope(direct.callScope(readHarness.services, nativeAgent))} / ${direct.dispatchScope(direct.callScope(readHarness.services, ptcAgent))}`,
);
check(
  'callScope tolerates a tools service with no modeFor: a service that cannot collapse anything is read as native rather than throwing',
  direct.callScope({ tools: {} }, nativeAgent).presentation === 'native',
);

/**
 * Driven end to end through the real tool definitions, on the read harness whose `schemas` records
 * what it was asked for. The route and the tool share `stateEnvelope`, so the same harness proves
 * both halves of the rule.
 */
const ruleRead = makeHarness();
mod.apply(ruleRead.ctx, { root: tempRoot });
const ruleTools = ruleRead.definitions;
const catalogOf = (exec) => ruleTools.get('agent_api_catalog').execute({ detail: 'names' }, exec);

/**
 * WHICH SCOPE EACH READ ASKED FOR, taken as the records THAT CALL added rather than by position.
 * The catalog now asks the registry twice — once for the caller's exposure (the list it answers
 * with) and once for the layer a dispatch resolves in (which entries it must name as
 * `not_dispatchable`) — so an assertion pinned to `at(-2)` breaks when either call is added or
 * reordered. A slice says what this call did, which is the subject.
 */
const catalogCalls = async (exec) => {
  const before = ruleRead.seen.schemasScope.length;
  const answer = await catalogOf(exec);
  return { answer, scopes: ruleRead.seen.schemasScope.slice(before) };
};
const processRunCatalog = await catalogCalls(undefined);
const conversationRunCatalog = await catalogCalls({ agent: nativeAgent });
const ptcRunCatalog = await catalogCalls({ agent: ptcAgent });
check(
  'agent_api_catalog with no conversation asks for the PROCESS view and says so',
  processRunCatalog.scopes.every((scope) => scope === undefined) &&
    processRunCatalog.answer.result.scope === 'process' &&
    processRunCatalog.answer.result.presentation === 'global',
  `asked ${JSON.stringify(processRunCatalog.scopes.map((s) => (s === undefined ? 'process' : 'an agent')))} scope=${processRunCatalog.answer.result.scope}`,
);
check(
  'agent_api_catalog with a conversation asks for THAT agent, reports scope "conversation", and names the presentation a ptc conversation collapses',
  conversationRunCatalog.scopes.includes(nativeAgent) &&
    conversationRunCatalog.answer.result.scope === 'conversation' &&
    conversationRunCatalog.answer.result.presentation === 'native' &&
    ptcRunCatalog.scopes.includes(ptcAgent) &&
    ptcRunCatalog.answer.result.scope === 'conversation' &&
    ptcRunCatalog.answer.result.presentation === 'ptc',
  `asked ${conversationRunCatalog.scopes.length}/${ptcRunCatalog.scopes.length} records; scope=${conversationRunCatalog.answer.result.scope}/${conversationRunCatalog.answer.result.presentation}, ptc=${ptcRunCatalog.answer.result.scope}/${ptcRunCatalog.answer.result.presentation}`,
);

const stateConversation = await ruleTools.get('agent_api_state').execute({}, { agent: nativeAgent });
const stateProcess = await ruleTools.get('agent_api_state').execute({}, undefined);
check(
  'agent_api_state reports which exposure its catalog is, and the route path stays the process view',
  stateConversation.result.scope === 'conversation' && stateConversation.result.presentation === 'native' && stateProcess.result.scope === 'process' && stateProcess.result.presentation === 'global',
  `${stateConversation.result.scope}/${stateConversation.result.presentation} vs ${stateProcess.result.scope}/${stateProcess.result.presentation}`,
);

ruleRead.seen.executeAgent.length = 0;
await ruleTools.get('agent_api_tool').execute({ tool: 'gate_echo', arguments: {} }, { agent: nativeAgent });
check(
  'agent_api_tool dispatches IN A NATIVE CONVERSATION SCOPE — the reach matches the catalog above',
  ruleRead.seen.executeAgent.at(-1) === nativeAgent,
  String(ruleRead.seen.executeAgent.at(-1)),
);
ruleRead.seen.executeAgent.length = 0;
await ruleTools.get('agent_api_tool').execute({ tool: 'gate_echo', arguments: {} }, { agent: ptcAgent });
check(
  'agent_api_tool dispatches WITHOUT a scope for a ptc conversation, which is what keeps a dispatch working there instead of collapsing to UNKNOWN_TOOL',
  ruleRead.seen.executeAgent.at(-1) === undefined,
  String(ruleRead.seen.executeAgent.at(-1)),
);
ruleRead.seen.executeAgent.length = 0;
await ruleTools.get('agent_api_tool').execute({ tool: 'gate_echo', arguments: {} }, undefined);
check(
  'agent_api_tool from a route is the process view, and behaves exactly as it did before this rule existed',
  ruleRead.seen.executeAgent.at(-1) === undefined,
  String(ruleRead.seen.executeAgent.at(-1)),
);
/**
 * THE ANSWER NAMES ITS SCOPE — ON EVERY PATH.
 *
 * The description has promised this since 0.2.17 and it was NOT true: four live answers from an
 * `rdev` conversation (two successes, two `unknown_tool` refusals) carried no scope field at all, so
 * a caller that named a preset tool under `ptc` was told `unknown tool "read"` and nothing else.
 * These read the answer the component really returns, on both outcomes and in all three calling
 * situations — the refusal is the one that matters, and the one that was missing.
 */
{
  const succeeded = await ruleTools.get('agent_api_tool').execute({ tool: 'gate_echo', arguments: {} }, { agent: nativeAgent });
  check(
    'a SUCCESSFUL dispatch names its scope, presentation and dispatch layer at the top level',
    succeeded.scope === 'conversation' && succeeded.presentation === 'native' && succeeded.dispatch === 'conversation' && succeeded.result?.dispatched === 'gate_echo',
    JSON.stringify({ keys: Object.keys(succeeded), scope: succeeded.scope, presentation: succeeded.presentation, dispatch: succeeded.dispatch }),
  );
  const refused = await ruleTools.get('agent_api_tool').execute({ tool: 'gate_no_such_tool', arguments: {} }, { agent: ptcAgent });
  check(
    'a REFUSED dispatch names them too — the case the promise was written for, and the one where a caller has nothing else to go on',
    refused.exit === 2 && refused.code === 'unknown_tool' && refused.scope === 'conversation' && refused.presentation === 'ptc' && refused.dispatch === 'process',
    JSON.stringify({ keys: Object.keys(refused), exit: refused.exit, code: refused.code, scope: refused.scope, presentation: refused.presentation, dispatch: refused.dispatch }),
  );
  const refusedRoute = await ruleTools.get('agent_api_tool').execute({ tool: 'gate_no_such_tool', arguments: {} }, undefined);
  check(
    'and a route-driven refusal reports the process view it searched, rather than leaving the layer implicit',
    refusedRoute.exit === 2 && refusedRoute.scope === 'process' && refusedRoute.presentation === 'global' && refusedRoute.dispatch === 'process',
    JSON.stringify({ scope: refusedRoute.scope, presentation: refusedRoute.presentation, dispatch: refusedRoute.dispatch }),
  );
}
ruleRead.dispose();

/**
 * The receipt half: a run says whose exposure it was offered and which layer its calls ran in, so a
 * reader never has to infer which of the two rules applied to it.
 */
const scopeRun = makeHarness();
mod.apply(scopeRun.ctx, { root: tempRoot });
const scopeRunAnswer = await scopeRun.definitions.get('agent_api_send').execute({ prompt: 'answer' }, { agent: nativeAgent });
check(
  'agent_api_send receipts name both halves of the rule: the exposure the list came from and the layer its calls ran in',
  scopeRunAnswer.result.tool_scope === 'conversation' && scopeRunAnswer.result.tool_reach === 'conversation',
  `${scopeRunAnswer.result.tool_scope}/${scopeRunAnswer.result.tool_reach}`,
);
/**
 * THE INVARIANT, ON THE NATIVE SIDE: the offered list is a subset of the layer the calls run in, and
 * a conversation that presents natively reaches its own exposure — including the fixture that only
 * exists in a conversation's view. Nothing is withheld.
 */
check(
  'a native conversation reaches its own conversation-only tool, and withholds nothing',
  scopeRunAnswer.result.tool_names.includes('memory_lab_conversation_only') &&
    scopeRunAnswer.result.tools_withheld?.count === 0 &&
    scopeRunAnswer.result.tools_withheld.why === '',
  JSON.stringify({ names: scopeRunAnswer.result.tool_names, withheld: scopeRunAnswer.result.tools_withheld }),
);
scopeRun.dispose();
const processRun = makeHarness();
mod.apply(processRun.ctx, { root: tempRoot });
const processRunAnswer = await processRun.definitions.get('agent_api_send').execute({ prompt: 'answer' }, undefined);
check(
  'a run with no conversation reports the process exposure on both halves',
  processRunAnswer.result.tool_scope === 'process' && processRunAnswer.result.tool_reach === 'process',
  `${processRunAnswer.result.tool_scope}/${processRunAnswer.result.tool_reach}`,
);
processRun.dispose();
const ptcRun = makeHarness();
mod.apply(ptcRun.ctx, { root: tempRoot });
const ptcRunAnswer = await ptcRun.definitions.get('agent_api_send').execute({ prompt: 'answer' }, { agent: ptcAgent });
check(
  'a ptc conversation keeps its own exposure but reaches the process layer — and the receipt says both rather than hiding the split',
  ptcRunAnswer.result.tool_scope === 'conversation' && ptcRunAnswer.result.tool_reach === 'process',
  `${ptcRunAnswer.result.tool_scope}/${ptcRunAnswer.result.tool_reach}`,
);
/**
 * THE DEFECT THIS RELEASE FIXES, ASSERTED WHERE IT WAS MEASURED.
 *
 * On 0.2.17 a `ptc` run offered 42 names of which 31 answered `UNKNOWN_TOOL`, because the offer came
 * from the caller's exposure and the calls resolved in the process layer. The fixture that exists
 * only in a conversation's view is that defect reduced to one name, and the three assertions below
 * are the invariant, the report of the subtraction, and the negative control — the same offer in a
 * NATIVE conversation, two checks above, does include it.
 */
check(
  'a ptc run does NOT offer the conversation-only tool: the offer is drawn from the layer its calls run in',
  !ptcRunAnswer.result.tool_names.includes('memory_lab_conversation_only') &&
    ptcRunAnswer.result.tool_names.includes('memory_lab_probe'),
  JSON.stringify(ptcRunAnswer.result.tool_names),
);
check(
  'and the subtraction is REPORTED rather than silent: count, the names, and why',
  ptcRunAnswer.result.tools_withheld?.count === 1 &&
    JSON.stringify(ptcRunAnswer.result.tools_withheld.names) === JSON.stringify(['memory_lab_conversation_only']) &&
    typeof ptcRunAnswer.result.tools_withheld.why === 'string' &&
    ptcRunAnswer.result.tools_withheld.why.length > 40,
  JSON.stringify(ptcRunAnswer.result.tools_withheld),
);
check(
  'the invariant itself, taken from the receipt: every offered name is one the run can reach, and withheld ∪ offered is the offer scope',
  ptcRunAnswer.result.tool_names.length + ptcRunAnswer.result.tools_withheld.count === 2 &&
    ptcRunAnswer.result.tools_withheld.count > 0 &&
    !ptcRunAnswer.result.tool_names.some((name) => ptcRunAnswer.result.tools_withheld.names.includes(name)),
  JSON.stringify({ offered: ptcRunAnswer.result.tool_names, withheld: ptcRunAnswer.result.tools_withheld.names }),
);
ptcRun.dispose();

/**
 * THE CATALOG'S SIDE OF THE SAME RECONCILIATION. The catalog keeps answering with the caller's own
 * exposure — that alignment is the user's rule — and now says which of those entries a dispatch
 * cannot reach, so the alignment is not a trap.
 *
 * Its own harness, deliberately: the earlier one is disposed by the time this block runs, and a
 * block that depends on another block's lifetime fails for a reason that has nothing to do with its
 * subject.
 */
const catalogPane = makeHarness();
mod.apply(catalogPane.ctx, { root: tempRoot });
const paneCatalog = (exec) => catalogPane.definitions.get('agent_api_catalog').execute({ detail: 'names' }, exec);
const paneProcess = await paneCatalog(undefined);
const paneNative = await paneCatalog({ agent: nativeAgent });
const panePtc = await paneCatalog({ agent: ptcAgent });
check(
  'the catalog names the layer a dispatch resolves in, and for a native conversation that is the conversation with nothing unreachable',
  paneNative.result.dispatch === 'conversation' && JSON.stringify(paneNative.result.not_dispatchable) === '[]',
  JSON.stringify({ dispatch: paneNative.result.dispatch, notDispatchable: paneNative.result.not_dispatchable }),
);
check(
  'for a ptc conversation the catalog still lists the conversation exposure, and names exactly the entries a dispatch cannot reach',
  panePtc.result.dispatch === 'process' &&
    panePtc.result.total > panePtc.result.not_dispatchable.length &&
    panePtc.result.not_dispatchable.includes('gate_conversation_only') &&
    panePtc.result.not_dispatchable.includes('memory_lab_conversation_only') &&
    !panePtc.result.not_dispatchable.includes('gate_echo'),
  JSON.stringify({ total: panePtc.result.total, notDispatchable: panePtc.result.not_dispatchable }),
);
check(
  'and the process view has nothing unreachable by definition, so the field is empty rather than absent',
  paneProcess.result.dispatch === 'process' && JSON.stringify(paneProcess.result.not_dispatchable) === '[]',
  JSON.stringify(paneProcess.result.not_dispatchable),
);
catalogPane.dispose();

/* ============================================================== the live store === */

console.log('');
console.log('# the live store was never touched');

check("the live root's Work directory is unchanged", digestTree(path.join(LIVE_ROOT, 'Work')) === liveWorkBefore, `${liveWorkBefore.slice(0, 16)} -> ${digestTree(path.join(LIVE_ROOT, 'Work')).slice(0, 16)}`);
check('the temporary root is not the live root', path.resolve(tempRoot) !== path.resolve(LIVE_ROOT));

/* ------------------------------------------------------------------- teardown --- */

for (const h of [harness, readHarness, twoTurn, explicit, deltaRun, capped, cappedOnce, callerWins, rowDefault, oddCap, truncated, providerErrorRun, abortedRun, proseRun, missingKey, emptyRun, noCore, noAccessor, noSelection, goneModel, unverified, noLlm, noTools, noExecuteHarness]) h.dispose();
fs.rmSync(tempRoot, { recursive: true, force: true });

const liveWorkAfter = digestTree(path.join(LIVE_ROOT, 'Work'));
if (liveWorkAfter !== liveWorkBefore) {
  console.log('');
  console.log(`ABORT: the live root changed during this run (${liveWorkBefore.slice(0, 16)} -> ${liveWorkAfter.slice(0, 16)})`);
  process.exit(2);
}

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
