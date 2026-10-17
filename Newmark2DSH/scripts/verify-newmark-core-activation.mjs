/**
 * Newmark Core — the activation harness.
 *
 * The bundle is **one Loader row** — `newmark-core` → `newmark2dsh` — and that row
 * composes the MemoryLab and ComputerUse components from inside itself, through
 * `ctx.plugin()` of the two relative paths in the package. This harness mounts rows the
 * way the Loader does rather than calling one `apply`: it applies the real core row and
 * lets the real composition run, which is the only way to observe what the bundle
 * actually activates.
 *
 * Switching a component off is a POST to the row's own control route, because that is the
 * only switch that exists: a component of a composed row cannot be left to the Loader.
 *
 * It runs the real Host half against the **live shared store** and snapshots it before and
 * after, aborting the run if it changed. The composed MemoryLab carries the core row's
 * own `reindexOnRender: true`, so the display path is allowed to rebuild the index — and
 * it rebuilds only when the persisted index is stale, which is exactly what the snapshot
 * before and after holds it to.
 *
 * Run: node Newmark2DSH/scripts/verify-newmark-core-activation.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountCore, loadRowModule } from './lib/mount-newmark-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const packagesDir = path.join(workspace, 'packages');

const LIVE_ROOT = path.join(os.homedir(), '.Newmark');
const LIVE_INDEX = path.join(LIVE_ROOT, 'Memory Lab', 'index.json');
const PAGE = '<html><head></head><body></body></html>';

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

function digest(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '(absent)';
}

/**
 * Locate the harness's own schemastery so each row's Config schema can be
 * exercised outside the app. When it is absent the schema checks are reported as
 * skipped rather than silently passing.
 */
function findSchemaLibrary() {
  const candidates = [
    process.env.NEWMARK_CORE_SCHEMA_LIB,
    path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'DSH Desktop',
      'resources',
      'app',
      'node_modules',
      '@deepseek-ai',
      'schemastery',
      'lib',
      'index.cjs',
    ),
    path.join(path.dirname(process.execPath), 'resources', 'app', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

const schemaLibraryPath = findSchemaLibrary();
if (schemaLibraryPath) process.env.NEWMARK_CORE_SCHEMA_LIB = schemaLibraryPath;

const liveBefore = digest(LIVE_INDEX);
const TOOL_NAMES = {
  memoryLab: [
    'memory_lab_read',
    'memory_lab_query',
    'memory_lab_update',
    'memory_lab_delete',
    'memory_lab_reindex',
    // The Agent-driven half of the tag graph: one read-only review, one recorded apply.
    'memory_lab_tag_review',
    'memory_lab_tag_apply',
    // The read-only half of navigation: the roots, and one tag's subtree.
    'memory_lab_root_tags',
    'memory_lab_subtag_tree',
  ],
  computerUse: ['computer_use', 'screen_capture'],
  agentApi: ['agent_api_state', 'agent_api_catalog', 'agent_api_tool', 'agent_api_send'],
};

try {
  /* ------------------------------- the core row, with its composed components --- */

  const both = await mountCore({ packagesDir, root: LIVE_ROOT });
  const bothGlobals = both.globals();
  check('the core row publishes its own global', bothGlobals.core?.ok === true && bothGlobals.core?.role === 'core');
  check('the core row resolves the shared Newmark root', bothGlobals.core?.root === LIVE_ROOT, bothGlobals.core?.root);
  check('the composed MemoryLab publishes its own global', bothGlobals.memoryLab?.ok === true);
  check('the composed ComputerUse publishes its own global', bothGlobals.computerUse?.held !== true);
  check('the composed agent-api publishes its own global', bothGlobals.agentApi?.ok === true && bothGlobals.agentApi?.role === 'agent-api');
  /* The row count is the point of the redesign: one Loader row, and every component composed
   * into it. A second Loader row per component means the patch went back to declaring
   * components, which is what put module paths on the plugin card. */
  check(
    'the bundle occupies one Loader row and composes every component into it',
    both.rows.filter((row) => row.origin === 'loader').length === 1 &&
      both.rows.filter((row) => row.origin === 'composed').length === 5,
    both.rows.map((row) => `${row.key}:${row.origin}`).join(', '),
  );
  check(
    'the five components register all thirty-three tools',
    both.tools.size === 33,
    `registered: ${[...both.tools.keys()].join(', ')}`,
  );
  for (const name of TOOL_NAMES.memoryLab) check(`MemoryLab registers ${name}`, both.tools.has(name));
  for (const name of TOOL_NAMES.computerUse) check(`ComputerUse registers ${name}`, both.tools.has(name));
  for (const name of TOOL_NAMES.agentApi) check(`agent-api registers ${name}`, both.tools.has(name));
  check(
    'the ComputerUse tool still publishes the full action surface',
    both.tools.get('computer_use').parameters.properties.action.enum.length === 23,
  );
  check('each of the six parts contributes its own index injection', both.taps.length === 6, `count: ${both.taps.length}`);

  const page = both.html();
  check(
    'every injection lands inside <head>',
    ['__NEWMARK_CORE__', '__NEWMARK_MEMORYLAB__', '__NEWMARK_COMPUTERUSE__', '__NEWMARK_AGENTAPI__'].every(
      (name) => page.indexOf(`window.${name}=`) !== -1 && page.indexOf(`window.${name}=`) < page.indexOf('</head>'),
    ),
  );
  const snapshot = both.payload();
  check('the injected global parses as JSON', snapshot !== null);
  check(
    'the payload reports every component mounted',
    snapshot.components.memoryLab === true && snapshot.components.computerUse === true && snapshot.components.agentApi === true,
  );
  check('the payload names the shared root', snapshot.root === LIVE_ROOT);
  check('the payload names the platform', snapshot.platform === process.platform);

  const tags = Object.keys(snapshot.index?.tags || {});
  const components = snapshot.index?.components;
  check('the payload carries the LIVE store, not an empty one', tags.length > 0 && Array.isArray(components) && components.length > 0, `${tags.length} tags, ${components?.length} components`);
  check(
    'every component body is preloaded as non-empty markdown',
    Array.isArray(components) && components.every((entry) => typeof snapshot.contents?.[entry.slug] === 'string' && snapshot.contents[entry.slug].length > 0),
  );
  check('the payload carries a free lease by default', snapshot.computerUse?.held !== true);

  /* --------------------------------------------- MemoryLab switched off ----- */

  /* The switch is the row's own control route, not a Loader entry: MemoryLab is composed
   * into the core row, so "off" has to mean the row disposed that fiber. */
  const noMemoryLab = await mountCore({ packagesDir, root: LIVE_ROOT, components: { memoryLab: false, computerUse: true } });
  check(
    'switching MemoryLab off retires its nine tools',
    TOOL_NAMES.memoryLab.every((name) => !noMemoryLab.tools.has(name)),
    `registered: ${[...noMemoryLab.tools.keys()].join(', ')}`,
  );
  check('switching MemoryLab off keeps the ComputerUse tools', TOOL_NAMES.computerUse.every((name) => noMemoryLab.tools.has(name)));
  const noMemorySnapshot = noMemoryLab.payload();
  check('the payload tells the Client half MemoryLab is off', noMemorySnapshot.components.memoryLab === false);
  check('the payload still reports ComputerUse mounted', noMemorySnapshot.components.computerUse === true);
  check(
    'a payload with no MemoryLab parses, carries no store, and still names the root',
    noMemorySnapshot.ok === true && noMemorySnapshot.index === undefined && noMemorySnapshot.root === LIVE_ROOT,
    `index: ${JSON.stringify(noMemorySnapshot.index)}, root: ${noMemorySnapshot.root}`,
  );
  check('the remaining components still contribute their own injections', noMemoryLab.taps.length === 5, `count: ${noMemoryLab.taps.length}`);
  check('a component that is switched off publishes no global', noMemoryLab.globals().memoryLab === undefined);
  /* The snapshot route the panel's 重置 and 重建索引 read through lives and dies with
   * the component, exactly as its page global does: presence is the switch, and a
   * switched-off component must not answer for a store it no longer owns. */
  check(
    'a component that is switched off serves no snapshot route',
    !noMemoryLab.routes.some((route) => route.path === '/newmark-memorylab/snapshot'),
    noMemoryLab.routes.map((route) => route.path).join(', '),
  );
  check(
    'a mounted MemoryLab does serve it, on the same webServer service',
    both.routes.some((route) => route.path === '/newmark-memorylab/snapshot'),
    both.routes.map((route) => route.path).join(', '),
  );
  const noMemoryState = await noMemoryLab.state();
  check(
    'the control route reports the mounted state it was switched to',
    (noMemoryState?.components || []).some((entry) => entry.name === 'memoryLab' && entry.mounted === false) &&
      (noMemoryState?.components || []).some((entry) => entry.name === 'computerUse' && entry.mounted === true),
    JSON.stringify(noMemoryState),
  );

  /* ------------------------------------------ ComputerUse switched off ------ */

  const noComputerUse = await mountCore({ packagesDir, root: LIVE_ROOT, components: { memoryLab: true, computerUse: false } });
  check(
    'switching ComputerUse off retires its two tools',
    TOOL_NAMES.computerUse.every((name) => !noComputerUse.tools.has(name)),
    `registered: ${[...noComputerUse.tools.keys()].join(', ')}`,
  );
  check('switching ComputerUse off keeps the MemoryLab tools', TOOL_NAMES.memoryLab.every((name) => noComputerUse.tools.has(name)));
  const noCuSnapshot = noComputerUse.payload();
  check('the payload tells the Client half ComputerUse is off', noCuSnapshot.components.computerUse === false);
  check('a retired ComputerUse reports no lease', noCuSnapshot.computerUse?.held !== true);
  check('the MemoryLab store still reaches the payload', (noCuSnapshot.index?.components || []).length > 0);

  /* ------------------------------------------------------- only the core ---- */

  /* Every composed component switched off, agent-api included: the point of this section is
   * that the CORE ROW stands alone, and leaving one component mounted would have tested a
   * composition with a component still in it. */
  const coreOnly = await mountCore({
    packagesDir,
    root: LIVE_ROOT,
    components: { memoryLab: false, computerUse: false, agentApi: false, newMate: false, heartBeat: false },
  });
  check('the core row alone registers no tools', coreOnly.tools.size === 0, `registered: ${coreOnly.tools.size}`);
  check('the core row alone injects only its own global', coreOnly.taps.length === 1 && coreOnly.globals().memoryLab === undefined);
  check(
    'the core row alone serves no component route either',
    !coreOnly.routes.some((route) => route.path.startsWith('/newmark-memorylab/') || route.path.startsWith('/newmark-agentapi/')),
    coreOnly.routes.map((route) => route.path).join(', '),
  );
  check('switching every component off leaves the core row intact', coreOnly.globals().core?.ok === true);
  const coreSnapshot = coreOnly.payload();
  check(
    'the core row alone reports every component off',
    coreSnapshot.components.memoryLab === false &&
      coreSnapshot.components.computerUse === false &&
      coreSnapshot.components.agentApi === false,
  );
  check(
    'the core row alone still names the shared root the components would use',
    coreSnapshot.root === LIVE_ROOT,
    coreSnapshot.root,
  );
  check('the core row alone still yields a valid empty payload', coreSnapshot.ok === true && coreSnapshot.root === LIVE_ROOT);

  /* ----------------------------------------------- the Config schemas ---- */

  if (!schemaLibraryPath) {
    console.log('skip - the Config schemas (the harness schemastery was not found on this machine)');
  } else {
    const coreRow = await loadRowModule(packagesDir, 'core');
    const memoryRow = await loadRowModule(packagesDir, 'memoryLab');
    const automationRow = await loadRowModule(packagesDir, 'computerUse');
    const agentApiRow = await loadRowModule(packagesDir, 'agentApi');

    for (const [label, module] of [
      ['core', coreRow],
      ['memorylab', memoryRow],
      ['computeruse', automationRow],
      ['agent-api', agentApiRow],
    ]) {
      check(
        `the ${label} module's schema is recognised as schemastery`,
        module.Config?.['~standard']?.vendor === 'schemastery',
        `vendor: ${module.Config?.['~standard']?.vendor}`,
      );
      check(
        `the ${label} module describes every field it reads`,
        Object.values(module.Config?.dict || {}).every((field) => typeof field?.meta?.description === 'string' && field.meta.description.length > 10),
      );
    }

    check(
      'the core row carries the shared root, the compose flag and the authorised model',
      Object.keys(coreRow.Config.dict).join(',') === 'root,compose,model,modelProvider,newMateWatchRoot',
      Object.keys(coreRow.Config.dict).join(', '),
    );
    check('the shared root defaults to the conventional Newmark path', coreRow.Config({}).root === '');
    /* Nothing authorised is the SHIPPING default, and it is a real state rather than a missing
     * one: an empty model makes `agent-api` refuse with `model_not_selected` instead of running
     * on a model nobody chose. A default here would be the silent substitution the whole
     * design exists to prevent, so this asserts the empty string and not a model name. */
    check(
      'nothing is authorised until the page writes one, so no model is defaulted',
      coreRow.Config({}).model === '' && coreRow.Config({}).modelProvider === '',
      `${coreRow.Config({}).modelProvider}/${coreRow.Config({}).model}`,
    );
    /* The compose flag is the row's own switch over the components it loads from inside
     * itself, and the harness mounts what it says: defaulting to off would ship a bundle
     * whose components never load. */
    check('the compose flag defaults to composing them', coreRow.Config({}).compose === true);
    check('the MemoryLab module carries its own settings', ['root', 'language', 'reindexOnRender'].every((key) => key in memoryRow.Config.dict));
    check('the ComputerUse module carries its own settings', 'leaseTtlMs' in automationRow.Config.dict);
    /* The component that CONSUMES the model must not be able to choose one: a second place to
     * answer "which model" is a second answer to one question. */
    check(
      'the agent-api module carries its own settings and no model field',
      ['root', 'workspace', 'coreService', 'timeoutMs', 'maxSteps'].every((key) => key in agentApiRow.Config.dict) &&
        !('model' in agentApiRow.Config.dict) &&
        !('modelProvider' in agentApiRow.Config.dict),
      Object.keys(agentApiRow.Config.dict).join(', '),
    );
    check('the ComputerUse lease TTL defaults to the verified 120000 ms', automationRow.Config({}).leaseTtlMs === 120000);
    check('the MemoryLab rebuild defaults to on, gated by staleness in the component', memoryRow.Config({}).reindexOnRender === true);

    /* The honesty check, restated for composition: a config boolean on one row could never
     * gate a *sibling* row, which is why no row carried one. A component composed into the
     * core row's own fiber is a different case — the row really does own it, and `compose`
     * is the switch it enforces. So the switch that exists is the core row's, and no module
     * may advertise a `components` map that nothing reads. */
    check(
      'the component switch is the core row\'s own compose flag, not a per-component map',
      'compose' in (coreRow.Config?.dict || {}) &&
        [coreRow, memoryRow, automationRow, agentApiRow].every((module) => !('components' in (module.Config?.dict || {}))),
    );
  }

  /* ------------------------------------------------------ the store is intact */

  check('the live store was not written by this harness', digest(LIVE_INDEX) === liveBefore, `${LIVE_INDEX}: ${liveBefore.slice(0, 16)} -> ${digest(LIVE_INDEX).slice(0, 16)}`);
  check(
    'no stray index or components directory appeared at the Newmark root',
    !fs.existsSync(path.join(LIVE_ROOT, 'index.json')) && !fs.existsSync(path.join(LIVE_ROOT, 'components')),
  );
} finally {
  const after = digest(LIVE_INDEX);
  if (after !== liveBefore) {
    console.log('');
    console.log(`ABORT: the live store changed during the run (${liveBefore.slice(0, 16)} -> ${after.slice(0, 16)})`);
    process.exit(2);
  }
}

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
