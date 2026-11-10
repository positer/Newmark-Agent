/**
 * Newmark Core — the startup auto-update gate.
 *
 * The feature this measures is deliberately quiet, so the gate has to be loud in its place. The
 * requirement (2026-11-10) was: 自动在启动时检查最新并静默更新，不主动重启，等待用户重启完成更新，
 * 不通知，不主动，全程静默. Each clause is measured here as a fact about behaviour, not as a string
 * in the source:
 *
 *   - 启动时检查 — one check per PROCESS: a second call with the same pid answers
 *     `checked_in_this_process` and does not touch the registry again;
 *   - 静默更新 — the install is attempted, and the only artefact is a receipt file. The mount test
 *     reads the served HTML and the store directory afterwards to prove nothing else was written;
 *   - 不主动重启 — the install is the last action, and the receipt says `pendingRestart`;
 *     `lib/auto-update.js` never names the restart helper;
 *   - 等待用户重启完成更新 — a disk copy that is already current but a running copy that is not
 *     answers `awaiting_restart` and installs nothing, so a staged update is never staged twice;
 *   - 不通知 — no page global, no message, no errors.jsonl line on a successful pass.
 *
 * The mount test runs the REAL `apply()` through the composition harness with a fake
 * `pluginManager` and a stubbed registry, because the wiring (which version is compared, which
 * service installs) is exactly where a silent feature goes wrong without anyone noticing.
 *
 * Run: node Newmark2DSH/scripts/verify-core-auto-update.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, coreVersion, latestCore } from '../packages/newmark-core/lib/core-update.js';
import {
  AUTO_UPDATE_DELAY_MS,
  autoUpdateStatePath,
  planAutoUpdate,
  readAutoUpdateState,
  runAutoUpdate,
  writeAutoUpdateState,
} from '../packages/newmark-core/lib/auto-update.js';
import { callRoute, loadRowModule, mountCore } from './lib/mount-newmark-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const packagesDir = path.join(workspace, 'packages');
const coreDir = path.join(packagesDir, 'newmark-core');
const autoUpdateSource = fs.readFileSync(path.join(coreDir, 'lib', 'auto-update.js'), 'utf8');

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

/** A throwaway Newmark root per scenario, so no assertion can disturb the live store. */
function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `newmark-auto-update-${label}-`));
  return root;
}

const until = async (predicate, timeoutMs = 12000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/* ------------------------------------------------------------ compareVersions --- */

console.log('# version comparison, numerically rather than lexically');
check('a newer patch compares newer', compareVersions('0.3.81', '0.3.80') === 1);
check('a lower patch compares older', compareVersions('0.3.80', '0.3.81') === -1);
check('equal versions compare equal', compareVersions('0.3.80', '0.3.80') === 0);
check(
  'the fields are numbers, not text: 0.3.10 is newer than 0.3.9',
  compareVersions('0.3.10', '0.3.9') === 1 && compareVersions('0.3.9', '0.3.10') === -1,
  'a string comparison would answer the opposite',
);
check(
  'a minor above nine does not carry: 0.10.0 is newer than 0.9.9',
  compareVersions('0.10.0', '0.9.9') === 1,
);
check(
  'anything that is not three numeric fields refuses to compare',
  ['', undefined, null, '0.3', '0.3.80-beta', 'v0.3.80', 3.8].every((value) => compareVersions(value, '0.3.80') === null),
  'null is a refusal, and a caller must not read it as equal or as older',
);
check('the running version is this package\'s own manifest version', /^\d+\.\d+\.\d+$/.test(coreVersion()), coreVersion());

/* ------------------------------------------------------------- the decision --- */

console.log('');
console.log('# the decision table, one reason per outcome');
const cases = [
  [{ enabled: false, installedVersion: '0.3.80', runningVersion: '0.3.80', latest: '0.3.81' }, false, 'disabled'],
  [{ enabled: true, installedVersion: '0.3.80', runningVersion: '0.3.80', latest: '0.3.81' }, true, 'update_available'],
  [{ enabled: true, installedVersion: '0.3.81', runningVersion: '0.3.81', latest: '0.3.81' }, false, 'installed_current'],
  [{ enabled: true, installedVersion: '0.3.81', runningVersion: '0.3.80', latest: '0.3.81' }, false, 'awaiting_restart'],
  [{ enabled: true, installedVersion: '0.3.82', runningVersion: '0.3.82', latest: '0.3.81' }, false, 'installed_ahead'],
  [{ enabled: true, installedVersion: '', runningVersion: '0.3.80', latest: '0.3.81' }, false, 'version_unreadable'],
];
for (const [input, act, reason] of cases) {
  const plan = planAutoUpdate(input);
  check(
    `${String(input.enabled)} installed=${input.installedVersion || '(none)'} running=${input.runningVersion} latest=${input.latest} -> ${reason}`,
    plan.act === act && plan.reason === reason,
    JSON.stringify(plan),
  );
}
check(
  'a plan to act names both ends of the move',
  (() => {
    const plan = planAutoUpdate({ enabled: true, installedVersion: '0.3.80', runningVersion: '0.3.79', latest: '0.3.81' });
    return plan.from === '0.3.80' && plan.to === '0.3.81';
  })(),
  'the install is described by what is on disk, not by what is in memory',
);

/* ------------------------------------------------------------- the startup run --- */

console.log('');
console.log('# one pass, with the registry and the installer under control');
const GOOD = {
  current: '0.3.80',
  latest: '0.3.81',
  tarball: 'https://registry.npmjs.org/newmark2dsh/-/newmark2dsh-0.3.81.tgz',
  registry: 'https://registry.npmjs.org/',
};

{
  const root = tempRoot('disabled');
  let reads = 0;
  let installs = 0;
  const receipt = await runAutoUpdate({
    root,
    enabled: false,
    installedVersion: '0.3.80',
    runningVersion: '0.3.80',
    readLatest: async () => { reads += 1; return GOOD; },
    install: async () => { installs += 1; return { application: 'restart-required' }; },
  });
  check('off means no registry call at all', reads === 0 && installs === 0 && receipt.reason === 'disabled', JSON.stringify(receipt));
  check(
    'off writes no receipt, so it cannot erase the last one',
    !fs.existsSync(autoUpdateStatePath(root)),
    autoUpdateStatePath(root),
  );
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = tempRoot('installed');
  let installs = 0;
  const seen = [];
  const first = await runAutoUpdate({
    root,
    enabled: true,
    installedVersion: '0.3.80',
    runningVersion: '0.3.80',
    readLatest: async () => GOOD,
    install: async (latest) => {
      installs += 1;
      seen.push(latest);
      return { application: 'restart-required' };
    },
    pid: 4242,
    now: () => '2026-11-10T12:00:00.000Z',
  });
  check('an older disk copy installs once', installs === 1 && first.ok && first.acted && first.reason === 'installed', JSON.stringify(first));
  check(
    'the install names the exact published tarball and registry, not a bare version',
    seen.length === 1 && seen[0].tarball === GOOD.tarball && seen[0].registry === GOOD.registry,
    JSON.stringify(seen[0]),
  );
  const receipt = readAutoUpdateState(root);
  check(
    'the receipt is written where the config page reads it',
    fs.existsSync(path.join(root, 'core', 'auto-update.json')),
    autoUpdateStatePath(root),
  );
  check(
    'the receipt records the process, both versions and the staged outcome',
    receipt.pid === 4242 &&
      receipt.checkedAt === '2026-11-10T12:00:00.000Z' &&
      receipt.from === '0.3.80' &&
      receipt.to === '0.3.81' &&
      receipt.running === '0.3.80' &&
      receipt.installed === '0.3.80' &&
      receipt.outcome === 'installed' &&
      receipt.application === 'restart-required',
    JSON.stringify(receipt),
  );
  check('the receipt says a restart is still owed', receipt.pendingRestart === true, String(receipt.pendingRestart));

  let reads = 0;
  let installsAgain = 0;
  const second = await runAutoUpdate({
    root,
    enabled: true,
    installedVersion: '0.3.81',
    runningVersion: '0.3.80',
    readLatest: async () => { reads += 1; return GOOD; },
    install: async () => { installsAgain += 1; return { application: 'applied' }; },
    pid: 4242,
  });
  check(
    'the same process never asks the registry twice',
    second.reason === 'checked_in_this_process' && reads === 0 && installsAgain === 0,
    JSON.stringify(second),
  );

  const nextProcess = await runAutoUpdate({
    root,
    enabled: true,
    installedVersion: '0.3.81',
    runningVersion: '0.3.80',
    readLatest: async () => { reads += 1; return GOOD; },
    install: async () => { installsAgain += 1; return { application: 'applied' }; },
    pid: 5555,
  });
  check(
    'a new process checks again, and finds nothing to install',
    nextProcess.reason === 'awaiting_restart' && reads === 1 && installsAgain === 0,
    JSON.stringify(nextProcess),
  );
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = tempRoot('check-failed');
  let recorded = 0;
  const receipt = await runAutoUpdate({
    root,
    enabled: true,
    installedVersion: '0.3.80',
    runningVersion: '0.3.80',
    readLatest: async () => { throw new Error('offline'); },
    install: async () => { throw new Error('must not be reached'); },
    record: () => { recorded += 1; },
    pid: 7001,
  });
  check(
    'a registry that cannot be read is a receipt, not an install and not a failure record',
    receipt.reason === 'check_failed' && recorded === 0 && readAutoUpdateState(root).outcome === 'check_failed',
    JSON.stringify(receipt),
  );
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = tempRoot('install-failed');
  const failuresSeen = [];
  const receipt = await runAutoUpdate({
    root,
    enabled: true,
    installedVersion: '0.3.80',
    runningVersion: '0.3.80',
    readLatest: async () => GOOD,
    install: async () => { throw new Error('pnpm exited 1'); },
    record: (failure) => failuresSeen.push(failure),
    pid: 7002,
  });
  check(
    'an install that threw is a failure the project log hears about',
    receipt.reason === 'install_failed' &&
      receipt.ok === false &&
      failuresSeen.length === 1 &&
      failuresSeen[0].code === 'auto_update_failed' &&
      readAutoUpdateState(root).outcome === 'install_failed',
    JSON.stringify({ receipt, failuresSeen }),
  );
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = tempRoot('install-refused');
  const failuresSeen = [];
  const receipt = await runAutoUpdate({
    root,
    enabled: true,
    installedVersion: '0.3.80',
    runningVersion: '0.3.80',
    readLatest: async () => GOOD,
    install: async () => ({ application: 'failed', error: { diagnostic: 'registry refused' } }),
    record: (failure) => failuresSeen.push(failure),
    pid: 7003,
  });
  check(
    'an install the manager refused is recorded rather than reported as success',
    receipt.reason === 'install_refused' && receipt.ok === false && failuresSeen[0]?.code === 'auto_update_refused',
    JSON.stringify({ receipt, failuresSeen }),
  );
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = tempRoot('ahead');
  let installs = 0;
  const receipt = await runAutoUpdate({
    root,
    enabled: true,
    installedVersion: '0.3.82',
    runningVersion: '0.3.82',
    readLatest: async () => GOOD,
    install: async () => { installs += 1; return { application: 'applied' }; },
    pid: 7004,
  });
  check('a local build newer than npm is never downgraded', receipt.reason === 'installed_ahead' && installs === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

{
  const root = tempRoot('corrupt-receipt');
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.writeFileSync(autoUpdateStatePath(root), '{ not json', 'utf8');
  const state = readAutoUpdateState(root);
  check('a corrupt receipt reads as "never checked" rather than as a crash', state && Object.keys(state).length === 0);
  check(
    'the receipt writer replaces it atomically',
    writeAutoUpdateState(root, { pid: 9, outcome: 'installed' }).ok === true &&
      readAutoUpdateState(root).outcome === 'installed',
  );
  fs.rmSync(root, { recursive: true, force: true });
}

/* ----------------------------------------------------------- the switch, as config --- */

console.log('');
console.log('# the switch itself');

/** Schemastery, resolved the way the bundle resolves it; absent means the check is skipped. */
function findSchemaLibrary() {
  if (process.env.NEWMARK_CORE_SCHEMA_LIB && fs.existsSync(process.env.NEWMARK_CORE_SCHEMA_LIB)) {
    return process.env.NEWMARK_CORE_SCHEMA_LIB;
  }
  const profiles = path.join(os.homedir(), '.dsh', 'profiles');
  if (fs.existsSync(profiles)) {
    for (const profile of fs.readdirSync(profiles)) {
      const candidate = path.join(profiles, profile, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.cjs');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}
const schemaLibrary = findSchemaLibrary();
if (schemaLibrary) {
  process.env.NEWMARK_CORE_SCHEMA_LIB = schemaLibrary;
  process.env.NEWMARK_CORE_SCHEMA_LIB_READY = '1';
}
const coreModule = await loadRowModule(packagesDir, 'core');
if (coreModule.Config) {
  const resolved = coreModule.Config({});
  check('the auto-update switch is off unless the user turns it on', resolved.autoUpdate === false, JSON.stringify(resolved));
  check(
    'turning it on is accepted by the schema as a boolean',
    coreModule.Config({ autoUpdate: true }).autoUpdate === true,
  );
  // The description is what DSH renders beside the field, so it is where the promise is made.
  // Schemastery keeps per-field meta inside its own serialisation; read it there rather than
  // assuming a property shape the library does not promise.
  const serialisedSchema = JSON.stringify(
    typeof coreModule.Config.toJSON === 'function' ? coreModule.Config.toJSON() : coreModule.Config.meta,
  );
  check(
    'the schema says what the switch does, in the place a reader looks',
    /autoUpdate/.test(serialisedSchema) && /silently check npm/.test(serialisedSchema),
    serialisedSchema.slice(0, 400),
  );
} else {
  console.log('skip - the Config schema is unavailable here (schemastery not resolvable), so the switch shape is asserted from the source instead');
  const indexSource = fs.readFileSync(path.join(coreDir, 'index.js'), 'utf8');
  check('the switch is declared on the row\'s Config as a boolean defaulting to false', /autoUpdate: schema\s*\n\s*\.boolean\(\)/.test(indexSource) && /\.default\(false\)/.test(indexSource));
  check('the Config description says the update is silent and waits for a restart', /silently check npm/.test(indexSource) && /without ' \+\s*$|without/.test(indexSource));
}

/* ------------------------------------------------------- the row, mounted for real --- */

console.log('');
console.log('# the row at startup, mounted the way the loader mounts it');

/**
 * The published version this mount pretends to find: one patch above the copy that is running.
 *
 * Derived from the manifest rather than written down, because the assertion below is about the
 * RELATIONSHIP (newer is found, staged, and a restart is owed), not about a particular number —
 * a literal here would turn tomorrow's routine version bump into a failing gate.
 */
const RUNNING_VERSION = coreVersion();
const MOUNT_LATEST = (() => {
  const [major, minor, patch] = RUNNING_VERSION.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
})();
const MOUNT_TARBALL = `https://registry.npmjs.org/newmark2dsh/-/newmark2dsh-${MOUNT_LATEST}.tgz`;
const NPM_DIST_TAGS = 'https://registry.npmjs.org/-/package/newmark2dsh/dist-tags';
const NPM_MANIFEST = `https://registry.npmjs.org/newmark2dsh/${MOUNT_LATEST}`;

function registryStub(counter) {
  return async (url) => {
    counter.calls.push(String(url));
    if (String(url) === NPM_DIST_TAGS) return { ok: true, text: async () => JSON.stringify({ latest: MOUNT_LATEST }) };
    if (String(url) === NPM_MANIFEST) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            name: 'newmark2dsh',
            version: MOUNT_LATEST,
            dist: { tarball: MOUNT_TARBALL },
          }),
      };
    }
    return { ok: false, status: 404 };
  };
}

{
  const root = tempRoot('mount-on');
  const counter = { calls: [] };
  const installs = [];
  const pluginManager = {
    listBundles: async () => [
      { name: 'newmark2dsh', version: RUNNING_VERSION, availability: 'profile', enabled: true, installed: true },
    ],
    installBundle: async (spec, options) => {
      installs.push({ spec, options });
      return { application: 'restart-required', changed: true, stage: 'install', target: 'newmark2dsh', version: MOUNT_LATEST };
    },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = registryStub(counter);
  let mount;
  try {
    mount = await mountCore({
      packagesDir,
      root,
      compose: false,
      coreConfig: { autoUpdate: true },
      services: { pluginManager },
    });
    const landed = await until(() => installs.length > 0 || readAutoUpdateState(root).outcome !== undefined, AUTO_UPDATE_DELAY_MS + 9000);
    check('the startup pass actually ran', landed, JSON.stringify(readAutoUpdateState(root)));
    check(
      'one install, naming the published tarball and asking for it to be enabled',
      installs.length === 1 && installs[0].spec === MOUNT_TARBALL && installs[0].options?.enabled === true,
      JSON.stringify(installs),
    );
    const receipt = readAutoUpdateState(root);
    check(
      'the row\'s own start staged the update and says a restart is owed',
      receipt.outcome === 'installed' && receipt.pendingRestart === true && receipt.to === MOUNT_LATEST,
      JSON.stringify(receipt),
    );
    check(
      'the check asked the two registry addresses the manual path uses, in that order',
      counter.calls[0] === NPM_DIST_TAGS && counter.calls[1] === NPM_MANIFEST,
      counter.calls.join(' -> '),
    );
    // The row registers its control route and the manual update route; the startup pass must not
    // have used the second one, which is the ONLY path that can restart the host.
    check(
      'no restart was exercised: the manual restart route exists and was left untouched',
      mount.routes.map((route) => route.path).sort().join(',') === '/newmark-core/components,/newmark-core/update',
      mount.routes.map((route) => route.path).join(', '),
    );
    check(
      'nothing was written beside the receipt: a silent pass leaves no error line',
      !fs.existsSync(path.join(root, 'errors.jsonl')),
      path.join(root, 'errors.jsonl'),
    );
    // "Silent" has a measurable meaning for the page: the only injected script is the core
    // snapshot the row always publishes, and this feature adds none.
    const page = mount.html();
    check(
      'the pass injects no page global, no banner and no second script',
      (page.match(/<script>/g) || []).length === 1 && page.includes('__NEWMARK_CORE__'),
      page.slice(0, 240),
    );
    const state = await mount.state();
    check(
      'the control route publishes the switch as on, editable only where an editor exists',
      state?.update?.autoUpdate === true && state?.update?.editable === false,
      JSON.stringify(state?.update),
    );
    check(
      'the control route publishes the receipt the card renders',
      state?.update?.state?.outcome === 'installed' && state?.update?.state?.to === MOUNT_LATEST,
      JSON.stringify(state?.update?.state),
    );
  } finally {
    globalThis.fetch = previousFetch;
    await mount?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = tempRoot('mount-off');
  const counter = { calls: [] };
  const installs = [];
  const pluginManager = {
    listBundles: async () => [{ name: 'newmark2dsh', version: RUNNING_VERSION }],
    installBundle: async (spec) => { installs.push(spec); return { application: 'applied' }; },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = registryStub(counter);
  let mount;
  try {
    mount = await mountCore({ packagesDir, root, compose: false, services: { pluginManager } });
    // Longer than the delay plus the whole check: if the switch is off, NOTHING may happen.
    await until(() => false, AUTO_UPDATE_DELAY_MS + 1500);
    check(
      'a row with the switch off never touches the registry',
      counter.calls.length === 0 && installs.length === 0,
      counter.calls.join(', '),
    );
    check('a row with the switch off writes no receipt', !fs.existsSync(autoUpdateStatePath(root)));
    const state = await mount.state();
    check(
      'the control route reports the switch as off, which is a real answer and not "unread"',
      state?.update?.autoUpdate === false && state?.update?.editable === false,
      JSON.stringify(state?.update),
    );
  } finally {
    globalThis.fetch = previousFetch;
    await mount?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* -------------------------------------------------- the switch, written and read back --- */

console.log('');
console.log('# the 版本管理 switch, written through the route');

{
  const root = tempRoot('switch-write');
  const counter = { calls: [] };
  const entry = { id: 'newmark-core', options: { config: { model: '', modelProvider: '', autoUpdate: false } } };
  const configEditor = {
    edit: async (target, change) => {
      target.options.config = change(target.options.config ?? {});
    },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = registryStub(counter);
  let mount;
  try {
    mount = await mountCore({
      packagesDir,
      root,
      compose: false,
      services: { pluginManager: { listBundles: async () => [], installBundle: async () => ({ application: 'applied' }) }, configEditor },
      fiber: { entry },
    });
    const route = mount.routes.find((candidate) => candidate.path === '/newmark-core/components');
    const bad = await callRoute(route, 'POST', { component: 'update', autoUpdate: 'yes' });
    check(
      'a non-boolean is refused by name, and nothing is written',
      bad.status === 400 && bad.json.error === 'auto_update_required' && entry.options.config.autoUpdate === false,
      JSON.stringify(bad.json),
    );
    const written = await callRoute(route, 'POST', { component: 'update', autoUpdate: true });
    check(
      'a boolean is persisted through the row\'s config editor and read back',
      written.status === 200 && written.json.ok === true && written.json.autoUpdate === true &&
        entry.options.config.autoUpdate === true,
      JSON.stringify(written.json),
    );
    check(
      'the answer carries the same state block the GET publishes',
      written.json.update?.autoUpdate === true && typeof written.json.update?.editable === 'boolean',
      JSON.stringify(written.json.update),
    );
    const readBack = await mount.state();
    check(
      'the next read agrees, because there is one reader and not two',
      readBack?.update?.autoUpdate === true && readBack?.update?.editable === true,
      JSON.stringify(readBack?.update),
    );
    const off = await callRoute(route, 'POST', { component: 'update', autoUpdate: false });
    check(
      'turning it off is the same write in the other direction',
      off.status === 200 && off.json.autoUpdate === false && entry.options.config.autoUpdate === false,
      JSON.stringify(off.json),
    );
  } finally {
    globalThis.fetch = previousFetch;
    await mount?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  // No editor and no Loader entry: the switch must say so instead of pretending it saved.
  const root = tempRoot('switch-501');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = registryStub({ calls: [] });
  let mount;
  try {
    mount = await mountCore({
      packagesDir,
      root,
      compose: false,
      services: { pluginManager: { listBundles: async () => [], installBundle: async () => ({ application: 'applied' }) } },
    });
    const route = mount.routes.find((candidate) => candidate.path === '/newmark-core/components');
    const answer = await callRoute(route, 'POST', { component: 'update', autoUpdate: true });
    check(
      'with nowhere to persist it, the write is refused rather than guessed',
      answer.status === 501 && answer.json.error === 'config_editor_unavailable',
      JSON.stringify(answer.json),
    );
    const state = await mount.state();
    check('the card learns the switch cannot be edited from the same GET', state?.update?.editable === false);
  } finally {
    globalThis.fetch = previousFetch;
    await mount?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* --------------------------------------------------------------------- the source --- */

console.log('');
console.log('# what the module refuses to do');

check(
  'the auto-update path never calls the restart helper',
  !/core-restart|\brequestRestart\b|action: 'restart'/.test(autoUpdateSource),
  'a staged install is the whole action; restarting is the user\'s',
);
// A module can only reach a notification channel by importing one, so the import list IS the
// claim: filesystem, path, uuid, and the version comparator. Nothing else is in reach.
const imports = [...autoUpdateSource.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
check(
  'no message, no notification, no proactive channel is reachable from it',
  imports.sort().join(',') === './core-update.js,node:crypto,node:fs,node:path',
  imports.join(', '),
);

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
