#!/usr/bin/env node
/**
 * verify-computeruse-output-boundary.mjs — can the ComputerUse tools fail DSH's
 * tool-output boundary (`INVALID_TOOL_OUTPUT — value is not lossless JSON`)?
 *
 * =====================================================================================
 * READ THIS FIRST: what this file is, and why it is NOT in the release gate
 * =====================================================================================
 *
 * `memory_lab_reindex` was measured returning a value DSH's registry rejects *after* the
 * tool has done its work — an operation that succeeded, reported as a hard failure. The
 * rule is `snapshotJsonValue` (`@deepseek-ai/dsh-util-values/lib/index.js:60-153`): the
 * walker accepts `null`, booleans, strings, finite non-`-0` numbers, plain arrays and plain
 * objects, and at `:109` rejects anything that is not an object — which is where
 * `undefined` dies. The registry applies it to every tool's returned value in
 * `createSuccessResult` (`@deepseek-ai/dsh-tools/lib/types/index.js:1189-1190` →
 * `snapshotToolValue` at `:106-118`), and a rejection becomes
 * `ToolOutputError` / `INVALID_TOOL_OUTPUT` (`:77-85`).
 *
 * The ComputerUse backends carry a dozen `… : undefined` result fields
 * (`lib/win32.js:1357,1882,3416,3540,3541`, `lib/linux.js` likewise). **Finding the shape
 * in the source is not finding the defect.** This file answers the only question that
 * settles it: does a ComputerUse tool, dispatched through the *real* registry, ever return
 * a value that walker rejects? It runs out of process, spends no model tokens, and takes
 * no part in `verify-newmark-core.mjs`.
 *
 * Invoke it by hand:
 *
 *     node scripts/verify-computeruse-output-boundary.mjs
 *
 * Phases (selectable with `NM_CU_BOUNDARY_PHASES`, default all five):
 *
 *   real          mounts the real `components/computeruse/index.js` on a real Cordis
 *                 context + real `ToolRuntime`, and dispatches ONLY the actions that are
 *                 read-only on this desktop — `mode_report`, `app_list`, `observe`,
 *                 `app_observe`, `wait`, `screen_capture`, plus refusals that return
 *                 before any lane is touched. Capture and observation are read-only and
 *                 touch no pointer, no keyboard and no window state.
 *   stub          mounts the same real component a second time with the **lane transport**
 *                 replaced, so every remaining action — move, click, drag, scroll, type,
 *                 key, app_activate and all five app_* deliveries, sequence, takeover_start,
 *                 takeover_stop — runs its real composition, through the real registry and
 *                 the real tool definition, without touching the desktop. See "the stubbed
 *                 action layer" below for why one seam is enough.
 *   sites         drives the flagged `… : undefined` result fields one at a time — through the
 *                 tool where the tool can reach them, and directly against the exported
 *                 composer where it cannot — so "that line is dead" is a measurement rather
 *                 than a reading.
 *   counterfactual registers one extra tool on the same real `ToolRuntime` whose value is a
 *                 ComputerUse result with one `undefined`-valued key added, and dispatches
 *                 it. If the registry accepts that, every other assertion in this file is
 *                 vacuous.
 *   linux         drives the other platform backend's `runComputerUse` through the same
 *                 registry, for the actions that are inert on this host.
 *
 * Exit codes:
 *   0  every measurement passed
 *   1  a measurement failed (named, with the real value printed)
 *   2  the probe could not be armed (a source seam did not match, or the run threw)
 *
 * =====================================================================================
 * THE STUBBED ACTION LAYER, AND WHY IT IS ONE SEAM AND NOT SIX
 * =====================================================================================
 *
 * Every act that reaches this desktop leaves the backend through exactly one pair of
 * functions: `prepareLane(lane, …)` and `runInLane(lane, script, …)`
 * (`lib/win32.js:1618,1625`). `spawn` appears exactly once in the whole module — inside
 * `PowerShellWorker.ensureChild` (`:1477-1482`) — and every caller of it is downstream of
 * those two functions: `captureWindow`, `sparseObservation`, `enumerateApplications`,
 * `observeControls`, `applicationByHandle`, `runActionScript`, and the overlay, which
 * imports the same two functions from this module (`lib/overlay-win32.js:50`) and reaches
 * the screen only through them (`:1005`, `:1163`).
 *
 * So the probe rewrites the two function bodies with a stub seam and nothing else. Three
 * independent guards keep a real action from being possible in `stub` mode:
 *
 *   1. `prepareLane` and `runInLane` answer a fixture without consulting a lane.
 *   2. `startOverlay` and `releaseOverlay` answer a fixture, so the native overlay is never
 *      even enqueued.
 *   3. `spawn` itself is replaced by a canary that records the attempt and, while the stubs
 *      are on, throws. The stubbed phase asserts that no spawn was even attempted. The canary
 *      deliberately does NOT refuse during the `real` phase — see `PROBE.refuseSpawn`.
 *
 * Every seam is applied to the module source at load time by an exact single-occurrence
 * anchor; if an anchor does not match exactly once the probe refuses to run at all (exit 2)
 * rather than dispatching anything. What is deleted is the transport; what is measured —
 * `dispatchComputerUse`, every action composer, `stringifyResult`, `asToolResult` and the
 * real registry — is the shipped code.
 *
 * =====================================================================================
 * WHAT IS DELIBERATELY NOT DONE
 * =====================================================================================
 *
 *   - No pointer is moved, no key is typed, no window is activated, no overlay is drawn,
 *     no process is launched. Not once, in any phase.
 *   - `takeover_start` is never dispatched with a live overlay; the one action that has a
 *     visible effect on the screen is measured only through its composition.
 *   - Nothing is written under the Newmark root. The probe's only writes are its receipt
 *     and the lane fixtures under `evidence/`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/* ------------------------------------------------------------------ configuration --- */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const COMPUTERUSE_DIR = join(process.env.NEWMARK_TEST_PACKAGE_ROOT || join(REPO,'packages','newmark-core'), 'components', 'computeruse');

/** The exact absolute paths this probe instruments. Compared case-insensitively below. */
const WIN32_PATH = join(COMPUTERUSE_DIR, 'lib', 'win32.js');
const LINUX_PATH = join(COMPUTERUSE_DIR, 'lib', 'linux.js');
const OVERLAY_PATH = join(COMPUTERUSE_DIR, 'lib', 'overlay-win32.js');
const COMPONENT_PATH = join(COMPUTERUSE_DIR, 'index.js');

const DSH_APP_ROOT =
  process.env.DSH_APP_ROOT?.trim() || 'C:/Users/12252/AppData/Local/Programs/DSH Desktop/resources/app';
const DSH_MODULES = join(DSH_APP_ROOT, 'node_modules', '@deepseek-ai');

const NEWMARK_ROOT = process.env.NEWMARK_ROOT?.trim() || join(homedir(), '.Newmark');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
/**
 * `NM_CU_BOUNDARY_SCRATCH` pins the receipt to a known directory. The mutation harness
 * (`measure-computeruse-boundary-mutations.mjs`) sets it so it can read exactly one run's
 * receipt without guessing at a timestamp.
 */
const SCRATCH = process.env.NM_CU_BOUNDARY_SCRATCH?.trim()
  ? resolve(process.env.NM_CU_BOUNDARY_SCRATCH.trim())
  : join(REPO, 'evidence', 'computeruse-output-boundary', STAMP);

const PHASES = String(process.env.NM_CU_BOUNDARY_PHASES ?? 'real,stub,sites,counterfactual,linux')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const wants = (phase) => PHASES.includes(phase);

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

/* =====================================================================================
 * 1. the seams — applied to module source at load time, each by a unique anchor
 * =====================================================================================
 *
 * A seam is `{ file, name, anchor, replacement }`. `applySeams` asserts the anchor occurs
 * exactly once before replacing it, so a refusenik anchor stops the probe instead of
 * silently measuring an uninstrumented module.
 */

const SPAWN_GUARD = [
  "import { spawn as __nmRealSpawn } from 'node:child_process';",
  'const spawn = (executable, args, options) => {',
  '  const __nmProbe = globalThis.__NM_CU_BOUNDARY__;',
  '  if (!__nmProbe) return __nmRealSpawn(executable, args, options);',
  '  __nmProbe.onSpawnAttempt(executable, args);',
  "  if (!__nmProbe.refuseSpawn) return __nmRealSpawn(executable, args, options);",
  "  throw new Error('computeruse-output-boundary: the probe refused to spawn a lane process');",
  '};',
].join('\n');

const SEAMS = [
  {
    file: WIN32_PATH,
    name: 'win32 spawn canary',
    anchor: "import { spawn } from 'node:child_process';",
    replacement: SPAWN_GUARD,
  },
  {
    file: WIN32_PATH,
    name: 'win32 runComputerUse recorder',
    anchor: 'export async function runComputerUse(options = {}) {',
    replacement: [
      'export async function runComputerUse(options = {}) {',
      '  const __nmValue = await __nmRunComputerUseOriginal(options);',
      '  globalThis.__NM_CU_BOUNDARY__?.recordRun(options, __nmValue);',
      '  return __nmValue;',
      '}',
      'async function __nmRunComputerUseOriginal(options = {}) {',
    ].join('\n'),
  },
  {
    file: WIN32_PATH,
    name: 'win32 stringifyResult input recorder',
    anchor: 'function stringifyResult(result) {',
    replacement: [
      'function stringifyResult(result) {',
      '  globalThis.__NM_CU_BOUNDARY__?.recordStringifyInput(result);',
    ].join('\n'),
  },
  {
    file: WIN32_PATH,
    name: 'win32 prepareLane stub seam',
    anchor: 'export async function prepareLane(lane, timeoutMs = DEFAULT_INIT_TIMEOUT_MS) {',
    replacement: [
      'export async function prepareLane(lane, timeoutMs = DEFAULT_INIT_TIMEOUT_MS) {',
      '  const __nmStub = globalThis.__NM_CU_BOUNDARY__?.prepareStubFor(lane);',
      '  if (__nmStub !== undefined) return __nmStub;',
    ].join('\n'),
  },
  {
    file: WIN32_PATH,
    name: 'win32 runInLane stub seam',
    anchor: 'export async function runInLane(lane, script, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {',
    replacement: [
      'export async function runInLane(lane, script, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {',
      '  const __nmStub = globalThis.__NM_CU_BOUNDARY__?.laneStubFor(lane, script);',
      '  if (__nmStub !== undefined) return __nmStub;',
    ].join('\n'),
  },
  {
    file: OVERLAY_PATH,
    name: 'overlay startOverlay stub seam',
    anchor: 'export async function startOverlay(options = {}) {',
    replacement: [
      'export async function startOverlay(options = {}) {',
      '  const __nmStub = globalThis.__NM_CU_BOUNDARY__?.overlayStartStubFor(options);',
      '  if (__nmStub !== undefined) return __nmStub;',
    ].join('\n'),
  },
  {
    file: OVERLAY_PATH,
    name: 'overlay releaseOverlay stub seam',
    anchor: "export function releaseOverlay(reason = 'lease_released') {",
    replacement: [
      "export function releaseOverlay(reason = 'lease_released') {",
      '  const __nmStub = globalThis.__NM_CU_BOUNDARY__?.overlayReleaseStubFor(reason);',
      '  if (__nmStub !== undefined) return __nmStub;',
    ].join('\n'),
  },
];

/** Lower-cased absolute path key, so a Windows drive-letter case difference is not a seam miss. */
const seamKey = (file) => realpathSync(file).toLowerCase();

const SEAMS_BY_FILE = new Map();
for (const seam of SEAMS) {
  const key = seamKey(seam.file);
  if (!SEAMS_BY_FILE.has(key)) SEAMS_BY_FILE.set(key, []);
  SEAMS_BY_FILE.get(key).push(seam);
}

/** Every seam this run applied, with the byte count it moved — printed as evidence. */
const SEAMS_APPLIED = [];

function applySeams(file, source) {
  let text = String(source);
  for (const seam of SEAMS_BY_FILE.get(seamKey(file)) ?? []) {
    const hits = text.split(seam.anchor).length - 1;
    if (hits !== 1) {
      throw new Error(
        `the seam "${seam.name}" anchors on ${JSON.stringify(seam.anchor)} in ${file}, which occurs ${hits} time(s). ` +
          'The probe refuses to run against a module it cannot instrument exactly once.',
      );
    }
    const before = text.length;
    text = text.replace(seam.anchor, seam.replacement);
    SEAMS_APPLIED.push({ file, name: seam.name, anchor: seam.anchor, bytes: text.length - before });
  }
  return text;
}

/* =====================================================================================
 * 2. the probe state the seams talk to
 * =====================================================================================
 *
 * `laneStub` and `overlayStub` are the two switches. Both are OFF for the `real` phase —
 * the module is instrumented there too (the recorder runs, the spawn canary is armed), but
 * every call reaches its real implementation, so the `real` phase measures the shipped
 * behaviour rather than the fixture.
 */

const FIXTURE_HANDLE = '0xA1B2C';
const FIXTURE_PID = 4242;
const FIXTURE_TITLE = 'Newmark Boundary Fixture';
const LUMA = Array.from({ length: 32 * 18 }, (_, index) => (index * 37) % 256);

const PROBE = {
  laneStub: false,
  overlayStub: false,
  /**
   * Whether the spawn canary REFUSES a spawn. It is off in the `real` phase on purpose: a
   * canary that always refused would leave the shipped transport unable to start a lane, and
   * the `real` phase would then measure a backend whose every lane is broken by the probe
   * itself. It is switched on with the stubs, where nothing may reach the desktop.
   */
  refuseSpawn: false,
  /** Every `spawn` the backends attempted. Empty during a stubbed phase, by contract. */
  spawns: [],
  /** One entry per `runComputerUse` call: the options, and the value it returned. */
  runs: [],
  /** The object handed to `JSON.stringify` — before serialisation drops anything. */
  stringifyInputs: [],
  /** Lane calls served by the fixture, for the report. */
  laneCalls: [],
  /** Every script handed to a lane, so a verdict can name what was about to be delivered. */
  laneScripts: [],
  overlayStarts: 0,
  overlayReleases: 0,
};
globalThis.__NM_CU_BOUNDARY__ = PROBE;

const fixtureWindow = () => ({
  handle: FIXTURE_HANDLE,
  title: FIXTURE_TITLE,
  process_id: FIXTURE_PID,
  class_name: 'NewmarkFixtureWindow',
  rect: { x: 0, y: 0, width: 1280, height: 800 },
  client_rect: { x: 10, y: 40, width: 1260, height: 740 },
  visible: true,
  minimized: false,
  foreground: true,
  occluded: false,
});

const fixtureControl = () => ({
  name: 'Fixture Button',
  automation_id: 'fixtureButton',
  control_type: 'Button',
  class_name: 'Button',
  bbox: { x: 100, y: 100, width: 80, height: 30 },
  center: { x: 140, y: 115 },
  enabled: true,
  process_id: FIXTURE_PID,
});

const fixtureCapture = () => ({
  ok: true,
  image_path: join(SCRATCH, 'fixture-capture.png'),
  width: 1280,
  height: 800,
  image_width: 1280,
  image_height: 800,
  image_bytes: 4096,
  capture_method: 'PrintWindow(hwnd,hdc,2)',
  distinct_luma: 128,
  luma_min: 0,
  luma_max: 255,
  luma: LUMA,
});

/** What a successful move/click/type/key/activation writes, as the shipped scripts write it. */
const fixtureAction = () => ({
  ok: true,
  mouse_mode: 'real',
  delivery: 'physical-desktop',
  foreground_verified: true,
  foreground_is_target: true,
  foreground_handle: FIXTURE_HANDLE,
  foreground_title: FIXTURE_TITLE,
  foreground_class_name: 'NewmarkFixtureWindow',
  foreground_process_id: FIXTURE_PID,
  activation_granted: true,
  activation_technique: 'SetForegroundWindow',
  activation_attempts: 1,
  focus_verified: true,
  focus_changed: true,
  focus_target: FIXTURE_HANDLE,
  focus_before: FIXTURE_HANDLE,
  focus_after: FIXTURE_HANDLE,
  focus_target_is_top_level: true,
  focus_target_class: 'NewmarkFixtureWindow',
  x: 140,
  y: 115,
  button: 'left',
  chars: 5,
  utf16_units: 5,
  events: 10,
  text_delivery: 'unicode-key-events',
  composed_by_ime: false,
  clipboard_used: false,
  key: 'ENTER',
  send_keys: '{ENTER}',
});

/** One lane answer, chosen by lane and by which script the composer built. */
function laneFixture(lane, script) {
  const text = String(script);
  if (lane === 'windows' || lane === 'windows_advisory') {
    // `windowByHandleScript` reports one record; `windowListScript` reports an array.
    return text.includes('WindowRectValues') ? JSON.stringify({ ok: true, ...fixtureWindow() }) : JSON.stringify([fixtureWindow()]);
  }
  if (lane === 'uia' || lane === 'uia_advisory') {
    return JSON.stringify({ ok: true, items: [fixtureControl()], visited: 1 });
  }
  if (lane === 'window_capture') return JSON.stringify(fixtureCapture());
  if (lane === 'sparse') return JSON.stringify({ ok: true, luma: LUMA });
  return JSON.stringify(fixtureAction());
}

PROBE.onSpawnAttempt = (executable, args) => {
  PROBE.spawns.push({ executable: String(executable), args: (args ?? []).map(String) });
};
PROBE.recordRun = (options, value) => {
  PROBE.runs.push({ action: String(options?.action ?? ''), valueType: typeof value, value });
};
PROBE.recordStringifyInput = (value) => {
  PROBE.stringifyInputs.push(value);
};
PROBE.prepareStubFor = (lane) => {
  if (!PROBE.laneStub) return undefined;
  PROBE.laneCalls.push({ lane, kind: 'prepareLane' });
  return { ready: true, elapsedMs: 0 };
};
PROBE.laneStubFor = (lane, script) => {
  if (!PROBE.laneStub) return undefined;
  PROBE.laneCalls.push({ lane, kind: 'runInLane', script: String(script).slice(0, 120) });
  PROBE.laneScripts.push({ lane, script: String(script) });
  return { ok: true, output: laneFixture(lane, script), elapsedMs: 0 };
};
PROBE.overlayStartStubFor = (options) => {
  if (!PROBE.overlayStub) return undefined;
  PROBE.overlayStarts += 1;
  return { ok: true, action: String(options?.action ?? 'takeover_overlay_start'), started: false, stub: true, pid: null, hwnd: null, reason: 'probe_stub' };
};
PROBE.overlayReleaseStubFor = (reason) => {
  if (!PROBE.overlayStub) return undefined;
  PROBE.overlayReleases += 1;
  return { ok: true, stopped: false, already_stopped: true, reason: String(reason), pid: null, stub: true };
};

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (typeof url !== 'string' || !url.startsWith('file:')) return loaded;
    let file;
    try {
      file = fileURLToPath(url);
    } catch {
      return loaded;
    }
    if (!SEAMS_BY_FILE.has(seamKey(file))) return loaded;
    const raw = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source ?? '').toString('utf8');
    return { ...loaded, source: applySeams(file, raw), format: loaded.format ?? 'module' };
  },
});

/* =====================================================================================
 * 3. lossless-JSON facts — the walker's own answer, plus a browser-independent scan
 * =====================================================================================
 *
 * `snapshotJsonValue` is DSH's own rule and the registry's own check, so it is the
 * authority. The local scan exists to *name* what is wrong: "not lossless JSON" is not a
 * diagnosis, and `nested.telemetry.capture_ms` is.
 */

/** Every path in `value` whose value is `undefined`. A lossless JSON value has none. */
function undefinedPaths(value, at = '$', seen = new Set(), out = []) {
  if (value === undefined) {
    out.push(at);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  if (seen.has(value)) {
    out.push(`${at} (cycle)`);
    return out;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) undefinedPaths(value[index], `${at}[${index}]`, seen, out);
  } else {
    for (const key of Object.keys(value)) undefinedPaths(value[key], `${at}.${key}`, seen, out);
  }
  seen.delete(value);
  return out;
}

/** The same round trip the registry relies on, as a boolean. */
function isLossless(value) {
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- DSH imports --- */

const dshUrl = (rel) => pathToFileURL(join(DSH_MODULES, rel)).href;
const dshImport = (rel) => import(dshUrl(rel));
const repoImport = (rel) => import(pathToFileURL(join(REPO, rel)).href);

/** The registry's own walker, once, for every value this probe observes. */
let SNAPSHOT_JSON_VALUE = null;

/* ------------------------------------------------------------- calling the tools --- */

/**
 * Dispatch one tool through the real registry, the way a model turn does, and answer a
 * fact sheet rather than a formatted view.
 *
 * `exec` carries a signal and no agent — exactly what a run's tools receive
 * (`components/agent-api/component.js:576-581`).
 */
let CALL_SEQUENCE = 0;
async function dispatchTool(tools, name, args) {
  CALL_SEQUENCE += 1;
  const runMark = PROBE.runs.length;
  const stringifyMark = PROBE.stringifyInputs.length;
  const laneMark = PROBE.laneCalls.length;
  const scriptMark = PROBE.laneScripts.length;
  const started = Date.now();
  let outcome;
  let threw = null;
  try {
    outcome = await tools.execute({
      callId: `cu-boundary:${CALL_SEQUENCE}:${name}`,
      name,
      arguments: args ?? {},
      signal: new AbortController().signal,
    });
  } catch (error) {
    threw = `${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`;
  }
  const isError = outcome?.isError ?? null;
  const value = outcome?.value ?? null;
  const runs = PROBE.runs.slice(runMark);
  const raw = runs.length === 1 ? runs[0] : null;
  const stringifyInputs = PROBE.stringifyInputs.slice(stringifyMark);
  return {
    name,
    args,
    ms: Date.now() - started,
    laneCallsDuring: PROBE.laneCalls.length - laneMark,
    /* Which lanes answered during this dispatch, and what they were asked to run. A lane
     * call that only resolves a window is not a lane call that delivers input, so a verdict
     * about "did this act" needs the lane names and not just the count. */
    lanesDuring: [...new Set(PROBE.laneCalls.slice(laneMark).map((entry) => entry.lane))].sort(),
    laneScriptsDuring: PROBE.laneScripts.slice(scriptMark).map((entry) => ({ lane: entry.lane, script: entry.script })),
    threw,
    isError,
    value,
    errorMessage: String(outcome?.error?.message ?? ''),
    errorCode: String(outcome?.error?.info?.code ?? ''),
    errorName: String(outcome?.error?.info?.name ?? ''),
    contentText: Array.isArray(outcome?.content)
      ? outcome.content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
      : null,
    /* The mechanism: what the backend really handed back, and whether the tool's returned
     * value is that raw answer round-tripped through JSON. */
    rawType: raw ? raw.valueType : null,
    rawValue: raw ? raw.value : null,
    rawCalls: runs.length,
    parsedEqualsValue: raw && raw.valueType === 'string' && !isError ? safeParseEquals(raw.value, value) : null,
    /* The counterfactual evidence: the object graph JSON.stringify received, which is
     * where a `… : undefined` field would still be present. */
    stringifyInputs: stringifyInputs.length,
    stringifyUndefinedPaths: stringifyInputs.flatMap((input) => undefinedPaths(input)),
    valueUndefinedPaths: isError ? [] : undefinedPaths(value),
    valueLosslessByWalker: isError ? null : snapshotOk(value),
    valueLosslessByRoundTrip: isError ? null : isLossless(value),
  };
}

function safeParseEquals(raw, value) {
  try {
    return isDeepStrictEqual(JSON.parse(raw), value);
  } catch {
    return false;
  }
}

function snapshotOk(value) {
  if (typeof SNAPSHOT_JSON_VALUE !== 'function') return null;
  return SNAPSHOT_JSON_VALUE(value) !== undefined;
}

/** The one-line fact for a per-action table. */
function line(result) {
  const verdict = result.threw
    ? `threw=${result.threw}`
    : `isError=${result.isError} code=${result.errorCode || '-'} name=${result.errorName || '-'}`;
  return (
    `${String(result.args?.action ?? '-').padEnd(14)} ${verdict}` +
    ` raw=${result.rawType ?? '-'} lossless=${result.valueLosslessByWalker ?? '-'}/${result.valueLosslessByRoundTrip ?? '-'}` +
    ` undefined=${result.valueUndefinedPaths.length}`
  );
}

/* =====================================================================================
 * 4. mounting the real component on a real registry
 * ===================================================================================== */

async function bootstrap() {
  const cordis = await dshImport('cordis/lib/index.js');
  const { ToolRuntime } = await dshImport('dsh-tools/lib/index.js');
  const { SystemPrompt } = await dshImport('dsh-system-prompt/lib/index.js');
  const { LocalFileSystem } = await dshImport('dsh-fs-local/lib/index.js');
  const values = await dshImport('dsh-util-values/lib/index.js');
  SNAPSHOT_JSON_VALUE = values.snapshotJsonValue;

  const ctx = new cordis.Context();
  const systemPrompt = new SystemPrompt(ctx, {});
  const fileSystem = new LocalFileSystem(ctx, { cwd: SCRATCH, diffBasisMaxBytes: 8 * 1024 * 1024 });
  const tools = new ToolRuntime(ctx, {});
  return { ctx, tools, systemPrompt, fileSystem };
}

/**
 * Mount the real `components/computeruse/index.js` the way the Loader does: a host with the
 * services the row injects, and `effect()` really running the registration.
 *
 * The row injects `['tools', 'webServer']` only, so the host is the two-accessor shape the
 * composition harness uses — the real `ToolRuntime` is the one that receives the tools.
 */
async function mountComputerUse(tools) {
  const effects = [];
  const taps = [];
  const logs = [];
  const host = {
    logger: {
      info: (...args) => logs.push(`inf ${args.map(String).join(' ')}`),
      warn: (...args) => logs.push(`warn ${args.map(String).join(' ')}`),
      error: (...args) => logs.push(`error ${args.map(String).join(' ')}`),
      debug: () => {},
    },
    tools,
    webServer: {
      tapIndex: (transform) => {
        taps.push(transform);
        return () => {};
      },
      register: (route) => {
        logs.push(`route ${route?.path ?? '(unnamed)'} (not served by this probe)`);
        return () => {};
      },
    },
    effect: (factory, label) => {
      effects.push({ label, dispose: factory() });
      return () => {};
    },
    get: () => undefined,
  };
  const module = await import(pathToFileURL(COMPONENT_PATH).href);
  /* `root` is explicit and throwaway because the component now writes its FAILURES to
   * `<root>/errors.jsonl` — and this probe drives refusals on purpose (a bogus window handle, a
   * stub that refuses to spawn the lane). With no root the component would resolve the user's
   * real `~/.Newmark` from the convention and this probe's deliberate failures would land in the
   * user's home, contradicting the promise in this file's header that nothing is written under
   * the Newmark root. */
  module.apply(host, { leaseTtlMs: 120000, root: mkdtempSync(join(tmpdir(), 'ncu-boundary-root-')) });
  const registered = tools.schemas().map((tool) => tool.name);
  return { module, registered, effects, taps, logs, host };
}

/* =====================================================================================
 * 5. the phases
 * ===================================================================================== */

/**
 * Actions that are read-only on a live desktop, plus refusals that return before any lane
 * is touched. Nothing here moves the pointer, types, activates a window or draws anything.
 */
const REAL_DISPATCHES = [
  { name: 'computer_use', args: { action: 'mode_report' }, note: 'lease/state query; no lane' },
  {
    name: 'computer_use',
    args: { action: 'mode_report', mouse_mode: 'virtual' },
    note: 'lease/state query with a requested mode; no lane',
  },
  { name: 'computer_use', args: { action: 'app_list' }, note: 'window enumeration (windows lane, read-only)' },
  { name: 'computer_use', args: { action: 'wait', duration_ms: 0 }, note: 'pacing action; no lane' },
  {
    name: 'computer_use',
    args: { action: 'observe', mouse_mode: 'virtual' },
    note: 'virtual mode refuses the foreground capture before any lane',
  },
  {
    name: 'computer_use',
    args: { action: 'app_observe', mouse_mode: 'virtual' },
    note: 'virtual mode refuses an untargeted app_observe before any lane',
  },
  { name: 'computer_use', args: { action: 'move' }, note: 'no coordinates: point_required, no lane' },
  { name: 'computer_use', args: { action: 'click' }, note: 'no coordinates: point_required, no lane' },
  { name: 'computer_use', args: { action: 'drag' }, note: 'no points: drag_points_required, no lane' },
  { name: 'computer_use', args: { action: 'scroll', x: 1, y: 1 }, note: 'no delta: scroll_delta_required, no lane' },
  { name: 'computer_use', args: { action: 'observe' }, note: 'read-only capture of the foreground window' },
  { name: 'screen_capture', args: { target: 'desktop' }, note: 'read-only desktop capture' },
];

/** Every `computer_use` action the tool declares, exercised with the transport stubbed. */
const STUB_DISPATCHES = [
  { name: 'computer_use', args: { action: 'mode_report' } },
  { name: 'computer_use', args: { action: 'wait', duration_ms: 0 } },
  { name: 'computer_use', args: { action: 'app_list' } },
  { name: 'computer_use', args: { action: 'observe' } },
  { name: 'computer_use', args: { action: 'observe', observation: 'sparse', sparse_wait_ms: 0 } },
  { name: 'computer_use', args: { action: 'app_observe', app_target: FIXTURE_TITLE } },
  { name: 'computer_use', args: { action: 'app_observe', window_handle: FIXTURE_HANDLE } },
  { name: 'computer_use', args: { action: 'app_activate', app_target: FIXTURE_TITLE } },
  { name: 'computer_use', args: { action: 'move', x: 140, y: 115 } },
  { name: 'computer_use', args: { action: 'click', x: 140, y: 115 } },
  { name: 'computer_use', args: { action: 'click', x: 140, y: 115, button: 'right' } },
  { name: 'computer_use', args: { action: 'drag', start_x: 100, start_y: 100, end_x: 300, end_y: 300 } },
  { name: 'computer_use', args: { action: 'scroll', x: 140, y: 115, scroll_y: 3 } },
  { name: 'computer_use', args: { action: 'type', text: 'boundary' } },
  { name: 'computer_use', args: { action: 'key', key: 'ENTER' } },
  { name: 'computer_use', args: { action: 'key', key: 'ctrl+l' } },
  /* `dry_run` is a declared parameter of this tool. Two dispatches ask for one; the
   * assertions after the phase check whether the transport was engaged anyway. */
  { name: 'computer_use', args: { action: 'move', x: 140, y: 115, dry_run: true }, note: 'declared dry run, real mode' },
  {
    name: 'computer_use',
    args: { action: 'move', x: 140, y: 115, dry_run: true, mouse_mode: 'virtual', app_target: FIXTURE_TITLE },
    note: 'declared dry run, virtual mode',
  },
  { name: 'computer_use', args: { action: 'app_click', app_target: FIXTURE_TITLE, x: 100, y: 100 } },
  { name: 'computer_use', args: { action: 'app_drag', app_target: FIXTURE_TITLE, start_x: 50, start_y: 50, end_x: 200, end_y: 200 } },
  { name: 'computer_use', args: { action: 'app_scroll', app_target: FIXTURE_TITLE, x: 100, y: 100, scroll_y: 2 } },
  { name: 'computer_use', args: { action: 'app_type', app_target: FIXTURE_TITLE, text: 'boundary' } },
  { name: 'computer_use', args: { action: 'app_key', app_target: FIXTURE_TITLE, key: 'ENTER' } },
  { name: 'computer_use', args: { action: 'takeover_start', owner_id: 'boundary-probe', mouse_mode: 'virtual' } },
  { name: 'computer_use', args: { action: 'takeover_stop', owner_id: 'boundary-probe' } },
  {
    name: 'computer_use',
    args: { action: 'sequence', steps: [{ action: 'move', x: 140, y: 115 }, { action: 'click', x: 140, y: 115 }] },
  },
  {
    name: 'computer_use',
    args: { action: 'sequence', steps: [{ action: 'type', text: 'boundary' }] },
  },
  { name: 'screen_capture', args: { target: 'desktop' } },
  { name: 'screen_capture', args: { target: 'application', app_target: FIXTURE_TITLE } },
  { name: 'screen_capture', args: { target: 'application', window_handle: FIXTURE_HANDLE } },
];

async function runDispatches(tools, list, phaseLabel) {
  const results = [];
  for (const entry of list) {
    const result = await dispatchTool(tools, entry.name, entry.args);
    result.note = entry.note ?? '';
    result.phase = phaseLabel;
    results.push(result);
    say(`    ${result.name} :: ${line(result)}${entry.note ? `  (${entry.note})` : ''}`);
    if (result.threw) say(`      threw: ${result.threw}`);
    if (result.isError) {
      say(`      registry error: ${result.errorCode} ${result.errorName} :: ${result.errorMessage}`);
      if (result.contentText) say(`      content: ${String(result.contentText).slice(0, 300)}`);
    }
  }
  return results;
}

/* =====================================================================================
 * main
 * ===================================================================================== */

async function main() {
  say('Newmark Core — ComputerUse tool-output boundary probe');
  say('====================================================');
  say(`repo:       ${REPO}`);
  say(`dsh app:    ${DSH_APP_ROOT}`);
  say(`newmark:    ${NEWMARK_ROOT} (read for facts only; nothing is written there)`);
  say(`scratch:    ${SCRATCH}`);
  say(`platform:   ${process.platform}   node: ${process.version}`);
  say(`phases:     ${PHASES.join(', ')}`);
  say('No model call is made. No pointer, key, window or process is touched.');
  mkdirSync(SCRATCH, { recursive: true });

  /* --- the scanner's own falsification: a scan that cannot find `undefined` is a label --- */
  say('\n=== PHASE 0 — the scanner and the registry rule, self-tested ===');
  const planted = { ok: true, nested: { list: [{ fine: 1 }, { alsoFine: undefined }] } };
  const plantedPaths = undefinedPaths(planted);
  record(
    'the undefined scanner finds a planted undefined at its full path',
    plantedPaths.length === 1 && plantedPaths[0] === '$.nested.list[1].alsoFine',
    `paths=${JSON.stringify(plantedPaths)}`,
  );
  record(
    'the lossless-JSON round-trip test rejects the planted value',
    isLossless(planted) === false,
    `isLossless(planted)=${isLossless(planted)}`,
  );
  const cleanValue = JSON.parse(JSON.stringify(planted));
  record(
    'and accepts the same value once the undefined-valued key is gone',
    isLossless(cleanValue) === true && undefinedPaths(cleanValue).length === 0,
    `keys=${Object.keys(cleanValue).join(',')} nested=${JSON.stringify(cleanValue.nested)}`,
  );

  /* ---------------------------------------------------------------- the real phase --- */
  const { ctx, tools, systemPrompt, fileSystem } = await bootstrap();
  say(
    `\nreal runtime: Cordis Context + real ToolRuntime + SystemPrompt(${systemPrompt.constructor.name}) + ` +
      `LocalFileSystem(${fileSystem.constructor.name})`,
  );
  const mounted = await mountComputerUse(tools);
  say(`component:    real components/computeruse/index.js apply() ran against the real registry`);
  say(`registered:   ${mounted.registered.join(', ')}`);
  record(
    'the component registers exactly the two documented tools',
    mounted.registered.length === 2 &&
      mounted.registered.includes('computer_use') &&
      mounted.registered.includes('screen_capture'),
    `[${mounted.registered.join(', ')}]`,
  );

  const realResults = wants('real')
    ? await (async () => {
        say('\n=== PHASE 1 — real dispatch: read-only actions only, untouched module behaviour ===');
        PROBE.laneStub = false;
        PROBE.overlayStub = false;
        PROBE.refuseSpawn = false;
        const before = PROBE.spawns.length;
        const results = await runDispatches(tools, REAL_DISPATCHES, 'real');
        const spawned = PROBE.spawns.length - before;
        say(`    lane processes really started by the shipped transport: ${spawned}`);
        for (const spawn of PROBE.spawns.slice(before)) say(`      spawned: ${spawn.executable} ${spawn.args.slice(0, 3).join(' ')} …`);
        const observed = results.filter((entry) => entry.value?.ok === true && entry.value?.observation === 'full');
        say(`    full observations returned: ${observed.length}${observed.length > 0 ? ` (image_path ${observed.map((entry) => entry.value.image_path).join(', ')})` : ''}`);
        return results;
      })()
    : [];
  if (wants('real')) {
    record(
      'every read-only dispatch was accepted by the registry',
      realResults.every((entry) => entry.threw === null && entry.isError === false),
      realResults
        .filter((entry) => entry.threw !== null || entry.isError === true)
        .map((entry) => `${entry.args?.action}: ${entry.threw ?? `${entry.errorCode} ${entry.errorMessage}`}`)
        .join(' | ') || `${realResults.length} dispatches, all isError=false`,
    );
    record(
      'every read-only value contains no undefined-valued key',
      realResults.every((entry) => entry.valueUndefinedPaths.length === 0),
      realResults.flatMap((entry) => entry.valueUndefinedPaths).join(', ') || 'no undefined anywhere in any returned value',
    );
    record(
      "every read-only value passes DSH's own snapshotJsonValue",
      realResults.every((entry) => entry.valueLosslessByWalker !== false),
      realResults.map((entry) => `${entry.args?.action}=${entry.valueLosslessByWalker}`).join(' '),
    );
    record(
      'every read-only value survives its own JSON round trip unchanged',
      realResults.every((entry) => entry.valueLosslessByRoundTrip === true),
      realResults.map((entry) => `${entry.args?.action}=${entry.valueLosslessByRoundTrip}`).join(' '),
    );
    record(
      'every read-only answer came out of the backend as a JSON STRING and was parsed by the tool',
      realResults.every((entry) => entry.rawType === 'string' && entry.parsedEqualsValue === true),
      realResults
        .map((entry) => `${entry.args?.action}: raw=${entry.rawType} parse==value=${entry.parsedEqualsValue}`)
        .join(' | '),
    );
  }

  /* ---------------------------------------------------------------- the stub phase --- */
  let stubResults = [];
  if (wants('stub')) {
    say('\n=== PHASE 2 — stubbed action layer: every remaining action, real composition ===');
    say('    the lane transport and the native overlay are replaced; the composition, the tool');
    say('    definition, asToolResult and the real registry are the shipped code.');
    PROBE.laneStub = true;
    PROBE.overlayStub = true;
    PROBE.refuseSpawn = true;
    const spawnsBefore = PROBE.spawns.length;
    const lanesBefore = PROBE.laneCalls.length;
    stubResults = await runDispatches(tools, STUB_DISPATCHES, 'stub');
    const spawnedDuringStub = PROBE.spawns.length - spawnsBefore;
    say(`    lane calls served by the fixture: ${PROBE.laneCalls.length - lanesBefore}`);
    say(`    process spawn attempts during the stubbed phase: ${spawnedDuringStub}`);

    record(
      'the stubbed phase attempted no process spawn (the desktop was never reachable)',
      spawnedDuringStub === 0,
      spawnedDuringStub === 0
        ? 'no lane process was even attempted; the lane transport is the only route from this backend to the desktop'
        : `SPAWN ATTEMPTED: ${JSON.stringify(PROBE.spawns.slice(spawnsBefore))}`,
    );
    const failed = stubResults.filter((entry) => entry.threw !== null || entry.isError === true);
    record(
      'every action of computer_use, and both screen_capture targets, was accepted by the registry',
      failed.length === 0,
      failed.length === 0
        ? `${stubResults.length} dispatches, all isError=false`
        : failed.map((entry) => `${entry.args?.action}: ${entry.threw ?? `${entry.errorCode} ${entry.errorMessage}`}`).join(' | '),
    );
    record(
      'every stubbed value contains no undefined-valued key',
      stubResults.every((entry) => entry.valueUndefinedPaths.length === 0),
      stubResults.flatMap((entry) => entry.valueUndefinedPaths).join(', ') || 'no undefined anywhere in any returned value',
    );
    record(
      "every stubbed value passes DSH's own snapshotJsonValue",
      stubResults.every((entry) => entry.valueLosslessByWalker !== false),
      stubResults.map((entry) => `${entry.args?.action}=${entry.valueLosslessByWalker}`).join(' '),
    );
    record(
      'every stubbed value survives its own JSON round trip unchanged',
      stubResults.every((entry) => entry.valueLosslessByRoundTrip === true),
      stubResults.map((entry) => `${entry.args?.action}=${entry.valueLosslessByRoundTrip}`).join(' '),
    );
    record(
      'every stubbed answer came out of the backend as a JSON STRING and was parsed by the tool',
      stubResults.every((entry) => entry.rawType === 'string' && entry.parsedEqualsValue === true),
      stubResults
        .map((entry) => `${entry.args?.action}: raw=${entry.rawType} parse==value=${entry.parsedEqualsValue}`)
        .join(' | '),
    );
    /* THE ASSERTION THAT MAKES THE ABOVE MEAN SOMETHING: the object the backend built really
     * does carry undefined-valued fields. If it did not, "no undefined reached the registry"
     * would be true for a reason that has nothing to do with the serialisation step. */
    const carrierPaths = [...new Set(PROBE.stringifyInputs.flatMap((input) => undefinedPaths(input)))];
    record(
      'the backend DID build result objects carrying undefined-valued fields (so the clean value is not vacuous)',
      carrierPaths.length > 0,
      carrierPaths.length > 0
        ? `${carrierPaths.length} distinct path(s) reached JSON.stringify as undefined, e.g. ${carrierPaths.slice(0, 6).join(', ')}`
        : 'no undefined-valued field was ever built; every "clean value" claim above is untested by construction',
    );
    say(`    all undefined-valued paths JSON.stringify received (${carrierPaths.length}): ${carrierPaths.join(', ')}`);
    say(`    overlay starts served by the fixture: ${PROBE.overlayStarts}; releases: ${PROBE.overlayReleases}`);
  }

  /* ------------------------------------------------------- the undefined-site phase --- */
  if (wants('sites')) {
    say('\n=== PHASE 3 — each flagged `… : undefined` result field, driven on its own ===');
    PROBE.laneStub = true;
    PROBE.overlayStub = true;
    PROBE.refuseSpawn = true;
    const win32 = await import(pathToFileURL(WIN32_PATH).href);

    /* `lib/win32.js:1882` — `window_handle: handle ? unwrapHandle(handle) : undefined` in
     * `sparseObservation`'s base record. Reachable here directly, with no handle to unwrap. */
    const sparse = await win32.sparseObservation({ windowHandle: '' });
    record(
      'win32.js:1882 really does put `window_handle: undefined` in `sparseObservation`\'s record',
      Object.prototype.hasOwnProperty.call(sparse, 'window_handle') && sparse.window_handle === undefined,
      `hasOwn=${Object.prototype.hasOwnProperty.call(sparse, 'window_handle')} value=${String(sparse.window_handle)} reason=${sparse.error_code}`,
    );

    /* `lib/win32.js:3416` — `capture_ms: capture.telemetry ? capture.telemetry.capture_ms : undefined`
     * in `fullObservation`, which runs only when `capture.ok === true` (`:3375-3377`). Measure
     * what a successful capture actually carries, rather than assuming. */
    const capture = await win32.captureWindow({ handle: FIXTURE_HANDLE, processId: FIXTURE_PID, ownerId: 'boundary-probe' });
    record(
      'win32.js:3416 cannot report an undefined capture_ms: every successful capture carries telemetry',
      capture.ok === true && capture.telemetry !== null && typeof capture.telemetry === 'object' &&
        Number.isFinite(capture.telemetry.capture_ms),
      `capture.ok=${capture.ok} telemetry=${JSON.stringify(capture.telemetry ?? null)} — ` +
        'fullObservation returns early unless capture.ok === true, so the false branch of that ternary is dead',
    );

    /* `lib/win32.js:3540-3541` — the dry-run result fields. Driven directly, because the tool
     * cannot currently ask for a dry run (measured below). */
    const dryMark = PROBE.stringifyInputs.length;
    const dryRaw = await win32.runComputerUse({ action: 'move', mouseMode: 'real', dryRun: true, x: 140, y: 115, ownerId: 'boundary-probe' });
    const dryInputs = PROBE.stringifyInputs.slice(dryMark);
    const dryPaths = [...new Set(dryInputs.flatMap((input) => undefinedPaths(input)))];
    /* Parsed defensively: this phase must report a fact when the backend is mutated into
     * answering something that is not a JSON string, not throw the receipt away. */
    let dryValue = null;
    try {
      dryValue = JSON.parse(String(dryRaw));
    } catch {
      dryValue = null;
    }
    record(
      'win32.js:3540-3541 do build an undefined `target_id` when a dry run names no target',
      dryPaths.includes('$.target_id') && dryValue !== null && dryValue.dry_run === true,
      `paths into JSON.stringify=${JSON.stringify(dryPaths)}; typeof raw=${typeof dryRaw}; dry_run=${dryValue?.dry_run} x=${dryValue?.x} y=${dryValue?.y}`,
    );
    record(
      'and that undefined is gone from the serialised answer the tool would return',
      typeof dryRaw === 'string' && dryValue !== null && !Object.prototype.hasOwnProperty.call(dryValue, 'target_id'),
      `typeof raw=${typeof dryRaw} has target_id=${dryValue ? Object.prototype.hasOwnProperty.call(dryValue, 'target_id') : '-'} keys=${dryValue ? Object.keys(dryValue).join(',') : '-'}`,
    );

    /* The declared `dry_run` parameter, measured through the tool. The component translates
     * the tool's snake_case arguments into the backends' camelCase option names, and the
     * Win32 backend reads `options.dryRun`, so this measures the translation itself. */
    const dryRuns = stubResults.filter((entry) => entry.args?.dry_run === true);
    if (dryRuns.length === 0) {
      record('the dry-run measurement has dispatches to measure', false, 'the stub phase made no `dry_run: true` dispatch, so every assertion below would be vacuous');
    } else {
      say(`    dry-run dispatches: ${dryRuns.map((entry) => `${entry.args.action}/${entry.args.mouse_mode ?? 'real'} laneCalls=${entry.laneCallsDuring} lanes=[${entry.lanesDuring.join(',')}] dry_run=${entry.value?.dry_run}`).join(' | ')}`);

      /**
       * The load-bearing half: a dry run must not reach the lane that delivers input.
       *
       * `action` is that lane - `ACTION_LANES` routes every move/click/drag/type/key to it
       * and to nothing else (`lib/win32.js:117-122`). Counting *calls* alone would be too
       * blunt: virtual mode resolves its target application through `windows_advisory`
       * before it can answer at all (`:3517-3525`), and a resolution that reads a window
       * list is not an act. What must never happen is the input lane being engaged, so the
       * assertion is about lane identity.
       */
      record(
        'a `dry_run: true` argument never engages the `action` lane (the lane that delivers input)',
        dryRuns.every((entry) => !entry.lanesDuring.includes('action')),
        dryRuns
          .map((entry) => `${entry.args.action} (mouse_mode=${entry.args.mouse_mode ?? 'real'}): lanes touched=[${entry.lanesDuring.join(',') || 'none'}] of ${entry.laneCallsDuring} lane call(s)`)
          .join(' | '),
      );
      record(
        'a `dry_run: true` argument comes back saying it was a dry run',
        dryRuns.every((entry) => entry.value?.dry_run === true),
        dryRuns.map((entry) => `${entry.args.action}: result.dry_run=${String(entry.value?.dry_run)} ok=${String(entry.value?.ok)}`).join(' | '),
      );
      /* In real mode there is nothing to resolve, so the whole backend call is lane-free.
       * This is the strongest form of the claim and it is the one the defect failed: it was
       * measured at 2 lane calls before the fix. */
      const realDry = dryRuns.filter((entry) => (entry.args.mouse_mode ?? 'real') === 'real');
      record(
        'in real mode a dry run touches no lane at all',
        realDry.length > 0 && realDry.every((entry) => entry.laneCallsDuring === 0),
        `${realDry.length} real-mode dry run(s): ${realDry.map((entry) => `${entry.args.action} laneCalls=${entry.laneCallsDuring}`).join(', ') || 'none dispatched'}`,
      );

      /* The control that stops the assertion above from passing for the wrong reason: if the
       * fixture never served the `action` lane at all, "no action lane during a dry run"
       * would be a fact about the fixture rather than about the dry run. */
      const actionLaneServed = stubResults.filter((entry) => entry.lanesDuring.includes('action'));
      record(
        'the `action` lane really is served by this fixture, so the dry-run verdict is not vacuous',
        actionLaneServed.length > 0,
        `${actionLaneServed.length} other dispatch(es) reached the action lane: ${actionLaneServed.slice(0, 6).map((entry) => entry.args.action).join(', ')}`,
      );

      /**
       * The rest of the parameter surface, measured the same way - by what reached the lane.
       *
       * These are the same defect as `dry_run`: a declared snake_case name that the backend
       * only reads in camelCase. They are asserted here so a future spread cannot
       * silently reintroduce them.
       */
      const laneScript = (entry, lane) => entry.laneScriptsDuring.find((item) => item.lane === lane)?.script ?? '';
      const paramValue = (script, name) => {
        const found = new RegExp(`\\$${name}\\s*=\\s*(\\d+)`).exec(script);
        return found ? Number(found[1]) : null;
      };

      /* `start_x`/`start_y`/`end_x`/`end_y` must reach the backend, which reads
       * `startX`/`startY`/`endX`/`endY` (`:3595`, `:3639`). The signature of the names not
       * meeting is `drag_points_required`: the backend receives no points and says so. */
      const dragProbe = await dispatchTool(tools, 'computer_use', {
        action: 'drag', x: 111, y: 222, start_x: 111, start_y: 222, end_x: 333, end_y: 444,
      });
      const dragScript = laneScript(dragProbe, 'action');
      record(
        'declared `start_x`/`start_y`/`end_x`/`end_y` arrive at the backend as the points it drags between',
        dragProbe.value?.ok === true &&
          dragProbe.value?.error_code === undefined &&
          ['111', '222', '333', '444'].every((value) => dragScript.includes(value)),
        `code=${String(dragProbe.value?.error_code ?? '-')} lanes=[${dragProbe.lanesDuring.join(',')}] ` +
          `action-lane script carries 111/222/333/444=${['111', '222', '333', '444'].map((v) => `${v}:${dragScript.includes(v)}`).join(' ')}`,
      );

      /* The same declaration on `app_drag`, which is the crew's other reported failure. Run
       * in virtual mode so the fixture's window resolves by handle and the drag is composed
       * as posted messages: real mode would go on to demand a foreground activation this
       * probe deliberately cannot stage.
       *
       * An app-scoped point is client-relative, so the backend shifts it by the fixture
       * window's `client_rect` origin (10,40) before it reaches the script: the declared
       * 111/222/333/444 must appear as 121/262/343/484. That shift is the evidence the
       * declaration arrived - without it the script would carry `undefined`-derived NaNs. */
      const appDragProbe = await dispatchTool(tools, 'computer_use', {
        action: 'app_drag', mouse_mode: 'virtual', window_handle: FIXTURE_HANDLE,
        start_x: 111, start_y: 222, end_x: 333, end_y: 444,
      });
      const appDragScript = laneScript(appDragProbe, 'action');
      const appDragClientPoints = appDragScript.includes('IsClientPoint($root, 121, 262)') &&
        appDragScript.includes('PostMouseDrag($root, ');
      record(
        'declared `app_drag` points arrive at the backend as the points it drags between',
        appDragProbe.value?.error_code === undefined &&
          appDragProbe.lanesDuring.includes('action') &&
          appDragClientPoints &&
          ['121', '262', '343', '484'].every((value) => appDragScript.includes(value)),
        `code=${String(appDragProbe.value?.error_code ?? '-')} lanes=[${appDragProbe.lanesDuring.join(',')}] ` +
          `declared 111/222/333/444 shifted by client_rect(10,40) -> carries 121/262/343/484=` +
          `${['121', '262', '343', '484'].map((v) => `${v}:${appDragScript.includes(v)}`).join(' ')} ` +
          `IsClientPoint-with-those-points=${appDragScript.includes('IsClientPoint($root, 121, 262)')}`,
      );

      /* `max_chars` reaches `options.maxChars` (`:2173`) and is embedded in the UIA script.
       * Measured against the same dispatch with the parameter omitted, so the number is
       * shown to be the caller's and not a coincidence of a default. */
      const withChars = await dispatchTool(tools, 'computer_use', { action: 'app_observe', app_target: FIXTURE_TITLE, max_chars: 12345 });
      const withoutChars = await dispatchTool(tools, 'computer_use', { action: 'app_observe', app_target: FIXTURE_TITLE });
      record(
        'a declared `max_chars` reaches the backend as `maxChars`',
        paramValue(laneScript(withChars, 'uia'), 'maxChars') === 12345 &&
          paramValue(laneScript(withoutChars, 'uia'), 'maxChars') === 60000,
        `with max_chars=12345 -> $maxChars=${paramValue(laneScript(withChars, 'uia'), 'maxChars')}; omitted -> $maxChars=${paramValue(laneScript(withoutChars, 'uia'), 'maxChars')} (the backend default)`,
      );

      /* `capture_max_width`/`capture_max_height` reach `options.captureMaxWidth`/`captureMaxHeight`
       * (`:3371-3372` -> `:1806-1807`) and are embedded in the capture script. */
      const sized = await dispatchTool(tools, 'computer_use', { action: 'observe', capture_max_width: 640, capture_max_height: 480 });
      record(
        'a declared `capture_max_width`/`capture_max_height` reaches the backend as `captureMaxWidth`/`captureMaxHeight`',
        ['640', '480'].every((value) => laneScript(sized, 'window_capture').includes(value)),
        `script-carries 640=${laneScript(sized, 'window_capture').includes('640')} 480=${laneScript(sized, 'window_capture').includes('480')}`,
      );

      /* `target_id` reaches `options.targetId` (`:3514`) and a resolved target overrides the
       * caller's coordinates, so the movement script must land on the observed control's
       * centre (140,115 from the fixture) and not on the far coordinates passed alongside.
       * Comparing the two scripts is the measurement: if `target_id` is dropped, the target
       * is unresolvable and the far coordinates are what gets delivered. */
      const seeded = await dispatchTool(tools, 'computer_use', { action: 'app_observe', app_target: FIXTURE_TITLE });
      const observedTargetId = seeded.value?.controls?.[0]?.target_id ?? null;
      if (!observedTargetId) {
        record('the fixture yields a target_id to act on', false, `app_observe returned no controls[0].target_id (keys=${seeded.value ? Object.keys(seeded.value).join(',') : '-'})`);
      } else {
        const viaTarget = await dispatchTool(tools, 'computer_use', { action: 'move', target_id: observedTargetId, x: 900, y: 900 });
        const viaPoint = await dispatchTool(tools, 'computer_use', { action: 'move', target_id: observedTargetId, x: 111, y: 222 });
        const targetScript = laneScript(viaTarget, 'action');
        const pointScript = laneScript(viaPoint, 'action');
        record(
          'a declared `target_id` reaches the backend, so the resolved target overrides the caller coordinates',
          targetScript !== '' && pointScript !== '' && targetScript === pointScript && targetScript.includes('140') && targetScript.includes('115'),
          `code=${String(viaTarget.value?.code ?? '-')}; a target resolved to the fixture control's centre (140,115) makes the two dispatches build the SAME movement script=${targetScript === pointScript}; it carries 140=${targetScript.includes('140')} 115=${targetScript.includes('115')}`,
        );
      }
    }
  }

  /* -------------------------------------------------------- the counterfactual phase --- */
  if (wants('counterfactual')) {
    say('\n=== PHASE 4 — the counterfactual: is the registry really strict about undefined? ===');
    const donor = [...stubResults, ...realResults].find((entry) => entry.isError === false);
    if (!donor) {
      record('a real ComputerUse value exists to build the counterfactual from', false, 'no accepted dispatch to draw on');
    } else {
      tools.register({
        name: 'boundary_probe_counterfactual',
        description: 'Probe-only: the measured ComputerUse value with one undefined-valued key added.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute() {
          return { ...donor.value, boundary_probe_undefined: undefined };
        },
      });
      const counterfactual = await dispatchTool(tools, 'boundary_probe_counterfactual', {});
      say(`    ${line(counterfactual)}`);
      if (counterfactual.errorMessage) say(`      registry error: ${counterfactual.errorCode} ${counterfactual.errorName} :: ${counterfactual.errorMessage}`);
      record(
        'a ComputerUse-shaped value with one undefined-valued key IS rejected, with INVALID_TOOL_OUTPUT',
        counterfactual.isError === true && counterfactual.errorCode === 'INVALID_TOOL_OUTPUT',
        `isError=${counterfactual.isError} code=${counterfactual.errorCode} name=${counterfactual.errorName} :: ${counterfactual.errorMessage}`,
      );
      record(
        'the counterfactual proves the tool had already done its work when the boundary rejected it',
        counterfactual.errorMessage.includes('not lossless JSON'),
        `message=${JSON.stringify(counterfactual.errorMessage)}`,
      );
      /* The same value WITHOUT the planted key, through the same registry, is accepted — so
       * the rejection above is caused by the undefined and by nothing else. */
      tools.register({
        name: 'boundary_probe_counterfactual_control',
        description: 'Probe-only: the same value with no undefined-valued key.',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute() {
          return { ...donor.value };
        },
      });
      const control = await dispatchTool(tools, 'boundary_probe_counterfactual_control', {});
      record(
        'the same value WITHOUT that key is accepted — the rejection is caused by the undefined alone',
        control.isError === false,
        `isError=${control.isError} code=${control.errorCode || '-'} acceptor=${donor.args?.action}`,
      );
    }
  }

  /* ----------------------------------------------------------------- the linux phase --- */
  if (wants('linux')) {
    say('\n=== PHASE 5 — the other platform backend, through the same registry ===');
    if (!existsSync(LINUX_PATH)) {
      record('the Linux backend is present to measure', false, `${LINUX_PATH} does not exist`);
    } else {
      const linux = await import(pathToFileURL(LINUX_PATH).href);
      /**
       * The raw answers this backend gives, and the value the shipped tool would build from
       * them. `asToolResult` (`components/computeruse/component.js:46-58`) is what stands
       * between the two, so the probe tool applies the same rule rather than a shortcut:
       * a string answer is JSON.parsed, and a string that is not JSON becomes
       * `{ ok: true, text }`. Handing the registry the bare string instead would measure the
       * probe's own mistake — the tool's `output.schema` is an object, so a string value is a
       * violation of a different rule entirely.
       */
      const linuxRaw = [];
      const asToolResult = (value) => {
        if (value && typeof value === 'object') return value;
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object') return parsed;
          } catch {
            /* not JSON: report it as text, exactly as the component does */
          }
          return { ok: true, text: value };
        }
        return { ok: false, code: 'backend_no_result', error: 'the ComputerUse backend returned no result' };
      };
      tools.register({
        name: 'boundary_probe_linux_backend',
        description: 'Probe-only: routes a ComputerUse action to the Linux backend through asToolResult.',
        parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
        output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args) {
          const raw = await linux.runComputerUse({ action: String(args.action), ownerId: 'boundary-probe' });
          linuxRaw.push({ action: String(args.action), type: typeof raw, raw });
          return asToolResult(raw);
        },
      });
      /* Only actions whose Linux implementation is inert on this host: `mode_report` is pure
       * state, and every desktop action is refused with `unsupported_platform` off Linux. */
      const linuxResults = [];
      for (const action of ['mode_report', 'observe', 'move']) {
        const before = linuxRaw.length;
        const result = await dispatchTool(tools, 'boundary_probe_linux_backend', { action });
        const raw = linuxRaw.slice(before);
        result.linuxRawType = raw.length === 1 ? raw[0].type : null;
        result.rawType = result.linuxRawType;
        result.parsedEqualsValue = raw.length === 1 && raw[0].type === 'string' ? safeParseEquals(raw[0].raw, result.value) : null;
        linuxResults.push({ action, ...result });
        say(`    ${line({ args: { action }, ...result })}`);
        if (result.errorMessage) say(`      registry error: ${result.errorCode} ${result.errorName} :: ${result.errorMessage}`);
      }
      record(
        'the Linux backend also returns lossless JSON through the same registry',
        linuxResults.every((entry) => entry.isError === false && entry.valueLosslessByWalker !== false && entry.valueUndefinedPaths.length === 0),
        linuxResults.map((entry) => `${entry.action}: isError=${entry.isError} undefined=${entry.valueUndefinedPaths.length} lossless=${entry.valueLosslessByWalker}`).join(' | '),
      );
      record(
        'the Linux backend ALSO answers a JSON string (the same funnel as win32)',
        linuxResults.every((entry) => entry.rawType === 'string' && entry.parsedEqualsValue === true),
        linuxResults.map((entry) => `${entry.action}: raw=${entry.rawType} parse==value=${entry.parsedEqualsValue}`).join(' | '),
      );
    }
  }

  /* ------------------------------------------------------------------------- cleanup --- */
  /* The overlay stub stays ON for teardown, so no released lease can reach a native window. */
  PROBE.laneStub = false;
  PROBE.overlayStub = true;
  PROBE.refuseSpawn = true;
  try {
    const win32 = await import(pathToFileURL(WIN32_PATH).href);
    win32.stopAll();
    say('\nteardown: win32.stopAll() ran; every lane process this probe started is stopped.');
  } catch (error) {
    say(`\nteardown: stopAll() could not run (${error?.message ?? error}); lanes are killed by the module's own exit hook.`);
  }
  for (const entry of mounted.effects.slice().reverse()) {
    try {
      entry.dispose?.();
    } catch {
      /* a disposal failure is not a measurement failure */
    }
  }
  try {
    ctx.stop?.();
  } catch {
    /* the context owns no resource this probe needs after the run */
  }

  /* ------------------------------------------------------------------------- receipt --- */
  const failed = RESULTS.filter((entry) => !entry.ok);
  say('\n=== SUMMARY ===');
  for (const entry of RESULTS) say(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);
  say(`\n${RESULTS.length - failed.length} passed, ${failed.length} failed`);

  const receipt = {
    probe: 'verify-computeruse-output-boundary',
    startedAt: STAMP,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    phases: PHASES,
    seams: SEAMS_APPLIED,
    sourceFacts: [WIN32_PATH, LINUX_PATH, OVERLAY_PATH, COMPONENT_PATH].map((file) => ({
      file,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    })),
    registered: mounted.registered,
    passed: RESULTS.length - failed.length,
    failed: failed.map((entry) => entry.name),
    results: RESULTS,
    spawns: PROBE.spawns,
    undefinedPathsSeenByStringify: [...new Set(PROBE.stringifyInputs.flatMap((input) => undefinedPaths(input)))],
    laneCalls: PROBE.laneCalls.length,
    overlayStarts: PROBE.overlayStarts,
    dispatches: [...realResults, ...stubResults].map((entry) => ({
      phase: entry.phase,
      tool: entry.name,
      action: entry.args?.action ?? null,
      note: entry.note,
      isError: entry.isError,
      errorCode: entry.errorCode,
      errorName: entry.errorName,
      errorMessage: entry.errorMessage,
      rawType: entry.rawType,
      parsedEqualsValue: entry.parsedEqualsValue,
      undefinedPaths: entry.valueUndefinedPaths,
      losslessByWalker: entry.valueLosslessByWalker,
      losslessByRoundTrip: entry.valueLosslessByRoundTrip,
      valueKeys: entry.isError ? null : Object.keys(entry.value ?? {}),
      /* A tool's own structured refusal is a SUCCESSFUL tool return — `isError` is the
       * registry's verdict on the value, not the backend's verdict on the action. Both are
       * recorded so a refusal can never be read as a boundary failure or the reverse. */
      toolOk: entry.isError ? null : (entry.value?.ok ?? null),
      toolErrorCode: entry.isError ? null : (entry.value?.error_code ?? null),
      toolError: entry.isError ? null : (entry.value?.error ?? null),
    })),
  };
  const receiptPath = join(SCRATCH, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
  say(`receipt: ${receiptPath}`);
  if (failed.length > 0) {
    say(`FAILED: ${failed.map((entry) => entry.name).join(' | ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  say(`\nthe probe itself failed: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`);
  say(String(error?.stack ?? '').split('\n').slice(0, 12).join('\n'));
  process.exit(2);
});
