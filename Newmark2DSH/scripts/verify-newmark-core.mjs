/**
 * Newmark Core —the plugin-level release gate.
 *
 * This is the adapted form of the gates the two features carry inside Newmark
 * itself. Newmark's originals are runtime gates over an Electron app
 * (`memoryPolicyVerify`, `computerUseSparseOnlyVerify`,
 * `computerUsePerformanceVerify`, `computerUseSessionVerify`,
 * `cliComputerUseAccuracyVerify`, `release-ui-memory-lab-smoke`). A DSH plugin
 * has no Electron main process, no `ipcMain`, no packaged MSI and no CDP harness,
 * so each gate is restated as the property it was protecting, checked against
 * the artefact that actually ships here:
 *
 *   Newmark gate                                   -> property asserted here
 *   ---------------------------------------------------------------------------
 *   memoryPolicyVerify (policy, bounds, archives)  -> asserted by the store gate, run from here
 *   release-ui-memory-lab-smoke (open/Reset/reindex -> one snapshot per page load, one sidebar id,
 *     load counts, DOM identity, no path leakage)      no port, no root path in the panel
 *   computerUseSessionVerify (13 assertions)       -> the lease contract, asserted by the win32 gate
 *   computerUseSparseOnlyVerify (8 checks)         -> the retired-line prohibition, asserted here
 *   cliComputerUseAccuracyVerify (19 scenarios)    -> the action surface and mode inventory, asserted here
 *   computerUsePerformanceVerify                   -> the backend gate's live lane probe (Windows only)
 *
 * Run: node Newmark2DSH/scripts/verify-newmark-core.mjs
 * Exit code 0 only when every assertion passes or is explicitly skipped.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const pkg = path.join(workspace, 'packages', 'newmark-core');

let passed = 0;
let failed = 0;
let skipped = 0;
/* A child gate that never returned its own verdict. It is its OWN outcome and not a failure:
 * "did not finish in time" and "answered red" send a reader to different places. */
let timedOut = 0;
/** Every reporter's running number, so one sequence survives a fourth outcome. */
let checks = 0;
const failures = [];
/** The child gates that ran out of their own budget, named separately in the report. */
const timeouts = [];

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    passed += 1;
    console.log(`ok ${checks} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`not ok ${checks} - ${name}`);
  if (detail) console.log(`  ${detail}`);
  return false;
}

function skip(name, reason) {
  checks += 1;
  skipped += 1;
  console.log(`skip ${checks} - ${name} (${reason})`);
}

/** A pass that has to SAY why it is one, instead of hiding a measured defect behind a label. */
function notePass(name, note) {
  checks += 1;
  passed += 1;
  console.log(`ok ${checks} - ${name}`);
  console.log(`  ${note}`);
}

/**
 * A child gate that neither answered nor printed a verdict inside its budget.
 *
 * Deliberately not `check(..., false, ...)`: a timeout is the ABSENCE of an answer, not the
 * child's red, and folding the two together is what made the activation harness's false
 * negative unreadable for as long as it was.
 */
function timeout(name, detail) {
  checks += 1;
  timedOut += 1;
  timeouts.push(name);
  console.log(`timeout ${checks} - ${name}`);
  if (detail) console.log(`  ${detail}`);
}

const packagesRoot = path.join(workspace, 'packages');

/** Read a file out of one of the sibling packages, by `<package>/<path>`. */
function readPackage(relative) {
  return fs.readFileSync(path.join(packagesRoot, relative), 'utf8');
}

function read(relative) {
  return fs.readFileSync(path.join(pkg, relative), 'utf8');
}

/* ------------------------------------------------------------ manifest */

const presetPatch = read('cordis.patch.yml');
const manifest = JSON.parse(read('package.json'));
/** The package each Loader row addresses, in declaration order. */
const rowNames = [...presetPatch.matchAll(/^ {6}name: '([^']+)'$/gm)].map((match) => match[1]);
check('the bundle is one package with one patch', Boolean(manifest.dsh?.bundle?.patch), JSON.stringify(manifest.dsh));
check('the bundle declares its client half', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform));
check(
  'the client half declares no package injection',
  Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length === 0,
  JSON.stringify(manifest.dsh?.client?.inject),
);
check('the client entry is exported', manifest.exports?.['./client'] === './client.js', String(manifest.exports?.['./client']));
check('the manifest carries display metadata', Boolean(manifest.meta?.title && manifest.meta?.description));
/* Recorded defect (2026-09-30, round 4): `files` listed `lib/*.js` but not
 * `components/*.js`, so a published tarball would have shipped a host half whose
 * component modules were missing. The earlier form of this assertion accepted
 * either path and therefore passed on the broken manifest. */
check(
  'the core manifest ships its row, its client half and its helpers',
  ['index.js', 'client.js', 'lib/', 'components/', 'cordis.patch.yml'].every((needle) => (manifest.files || []).some((entry) => entry.includes(needle))),
  JSON.stringify(manifest.files),
);
for (const name of ['memorylab', 'computeruse', 'agent-api']) {
  const component = JSON.parse(readPackage(`newmark-core/components/${name}/package.json`));
  check(
    `the ${name} package ships its row, its component and its library`,
    ['index.js', 'component.js', 'lib/'].every((needle) => (component.files || []).some((entry) => entry.includes(needle))),
    JSON.stringify(component.files),
  );
  /* A component package must NOT declare a client bundle: the client half belongs
   * to the Newmark-Core bundle, and a second web client source for the same row set
   * is what the registry refuses. */
  check(
    `the ${name} package declares no dsh.client`,
    component.dsh === undefined || component.dsh.client === undefined,
    JSON.stringify(component.dsh),
  );
}

const index = read('index.js');
const client = read('client.js');
const memorylab = readPackage('newmark-core/components/memorylab/component.js');
const computeruse = readPackage('newmark-core/components/computeruse/component.js');

/* ------------------------------------------------- one plugin, two components */

/* Replaces "the core row imports no component, so the components stay separable", which is
 * genuinely obsolete: the components are no longer rows of their own, and the core row
 * imports them deliberately. The contract now is the composition itself —each component is
 * loaded from a path inside this package and mounted with `ctx.plugin()`, so no package
 * manager has to resolve a component and no module path has to reach the UI. */
check(
  'the core row composes both components from paths inside its own package',
  index.includes("import('./components/memorylab/index.js')") &&
    index.includes("import('./components/computeruse/index.js')") &&
    index.includes("import('./components/agent-api/index.js')") &&
    index.includes('ctx.plugin(module, component.config(root, liveConfig()))'),
);
check(
  'each component declares its own tool set',
  memorylab.includes('tools()') && computeruse.includes('tools()'),
);
for (const name of [
  'memory_lab_read',
  'memory_lab_query',
  'memory_lab_update',
  'memory_lab_delete',
  'memory_lab_reindex',
  'memory_lab_tag_review',
  'memory_lab_tag_apply',
  'memory_lab_root_tags',
  'memory_lab_subtag_tree',
]) {
  check(`the MemoryLab component bundles ${name}`, memorylab.includes(`name: '${name}'`));
}
for (const name of ['computer_use', 'screen_capture']) {
  check(`the ComputerUse component bundles ${name}`, computeruse.includes(`name: '${name}'`));
}
/* The heartBeat component registers its tools from its own index.js — its component module has no
 * tools() of its own — so the inventory is read from the module that registers them. The COUNT is
 * asserted as well as the names: a fifth heartbeat tool added without a gate line would otherwise
 * slip past the one file that inventories every shipped tool. */
const heartbeat = readPackage('newmark-core/components/heartbeat/index.js');
const heartbeatTools = [...heartbeat.matchAll(/name: '(heartbeat_[a-z_]+)'/g)].map((match) => match[1]);
check(
  'the heartBeat component bundles exactly its five tools',
  heartbeatTools.length === 5 && new Set(heartbeatTools).size === 5,
  heartbeatTools.join(', ') || 'none found',
);
for (const name of [
  'heartbeat_after_restart',
  'heartbeat_restart',
  'heartbeat_restart_commit',
  /* 0.3.17: the two-phase restart barrier could be opened, acked and committed, but the only
   * ways OUT of `preparing` were a commit that necessarily lacked a receipt, or expiry. The
   * requester's own cancel is this fifth tool, and it is inventoried here with the other four
   * so a sixth cannot arrive without this line going red. */
  'heartbeat_restart_cancel',
  'heartbeat_restart_ack',
]) {
  check(`the heartBeat component bundles ${name}`, heartbeat.includes(`name: '${name}'`));
}

/* ------------------------------------------------- the authorised model, and the service */
/* The model is a property of the CORE ROW, because the config page chooses ONE model for the
 * whole bundle. Two facts have to hold together for that to be true rather than stated:
 * the row provides the service CARRYING it, and the component that consumes it has no model
 * field of its own. Either one alone is a design that reads correctly and behaves otherwise. */
{
  const agentApi = read('components/agent-api/index.js');
  const coreModel = read('components/agent-api/lib/core-model.js');
  const selection = read('lib/model-selection.js');
  const agentApiComponent = read('components/agent-api/component.js');

  check(
    'the core row provides the service the agent-api component reads its model from',
    /export const CORE_SERVICE = '([\w-]+)';/.test(index) &&
      index.includes('ctx.provide(CORE_SERVICE, service)') &&
      // Provided BEFORE the compose loop. A child mounted first would look for a service that
      // does not exist yet and stay at `waiting for service` for ever.
      index.indexOf('ctx.provide(CORE_SERVICE, service)') < index.indexOf('if (config?.compose === true)'),
    'the provider must be registered before any component is mounted',
  );
  check(
    'the two halves agree on the service name, each spelling it once',
    (() => {
      const provided = /export const CORE_SERVICE = '([\w-]+)';/.exec(index)?.[1];
      const consumed = /export const DEFAULT_CORE_SERVICE = '([\w-]+)';/.exec(agentApi)?.[1];
      return provided !== undefined && provided === consumed;
    })(),
    `provider ${/export const CORE_SERVICE = '([\w-]+)';/.exec(index)?.[1]} vs consumer ${/export const DEFAULT_CORE_SERVICE = '([\w-]+)';/.exec(agentApi)?.[1]}`,
  );
  check(
    'the provided accessor answers the name the consumer reads, from one constant on each side',
    /export const CORE_MODEL_ACCESSOR = '(\w+)';/.exec(index)?.[1] ===
      /export const CORE_MODEL_ACCESSOR = '(\w+)';/.exec(coreModel)?.[1] &&
      index.includes('[CORE_MODEL_ACCESSOR]: () =>'),
    'the accessor is a METHOD, so a read after the panel writes answers the new model',
  );
  check(
    'nothing authorised is a real answer —an empty object, not a default and not a throw',
    /const selection = normaliseSelection\(\{/.test(index) && index.includes('if (!selection.ok) return {};'),
    'the consumer is expected to refuse; a default here would be a model the user did not authorise',
  );
  check(
    'the row carries the model as config fields, split so a person can edit the patch by hand',
    /model: schema\s*\n?\s*\.string\(\)/.test(index) &&
      /modelProvider: schema\s*\n?\s*\.string\(\)/.test(index) &&
      index.includes('liveConfig().modelProvider') &&
      index.includes('liveConfig().model'),
  );
  check(
    'the component that consumes the model has no model config field of its own',
    !/model: schema/.test(agentApi) && !/model: schema/.test(agentApiComponent),
    'a second place to choose a model would be a second answer to one question',
  );
  check(
    'the catalogue is enumerated HOST-side, through the llm service this bundle already reaches',
    selection.includes('llm.listProviders()') &&
      selection.includes('llm.listModels(id)') &&
      !/ctx\.remote|remote\.session|\.session\./.test(selection + index),
    'this bundle lost a round to a `remote` namespace that did not resolve; the read stays here',
  );  check(
    'the match is on the id field, never on a display name',
    /export const MODEL_ID_FIELD = 'id';/.test(selection) && selection.includes('model[MODEL_ID_FIELD] === selected.model'),
    'a display name is not an address',
  );
  check(
    'a provider that failed to enumerate is UNVERIFIED, not gone',
    selection.includes('selectedListed: LISTED.unverified') && selection.includes('catalog.failures.some'),
    'reporting "gone" because a listing endpoint was down would be inventing a fact',
  );
  const editorName = 'config' + 'Editor';
  check(
    'the write goes through the config editor, which writes a row config —the mechanism whose purpose this is',
    // Read through the guarded `maybe(name)` helper and not as a bare property read: this row
    // must stay mountable where the editor is absent (the base patch disables that service when
    // there is no profileContext), and Cordis THROWS on reading a service property that was not
    // declared in `inject` —there is no defensive access, the read itself is the throw. The
    // service name is assembled here rather than written out so this assertion does not trip the
    // bundle-wide scan for the bare token that the preset check below performs.
    index.includes(`maybe('${editorName}')`) &&
      index.includes(`${editorName}.edit(entry, (current) => ({`) &&
      index.includes('modelProvider: provider'),
    'the same call was the WRONG one for the preset switch, where the target was the enabled state',
  );
  /* This check used to read `indexOf('await configEditor.edit(entry') < indexOf('const persisted
   * = normaliseSelection({')` under the name "the row is read back after the write". It compared
   * the edit against the LINE THAT USES the value, not against the LINE THAT READS IT —and in
   * the version this was written against those were two different places:
   *
   *     const live = entry.options.config ?? {};          // read  —BEFORE the edit
   *     await configEditor.edit(entry, —;                // write
   *     const persisted = normaliseSelection({ —});      // use   —after, so the check passed
   *
   * So the assertion was green while the receipt was built from a stale reference, and the user
   * met the result: selecting a model in the panel reported
   * `HTTP 400 · the write did not take: the row's config still holds /` —two empty strings
   * around a slash —for a write that HAD taken. The patch file carried
   * `model: deepseek-flash, modelProvider: deepseek-official` throughout.
   *
   * `configEditor.edit` resolves the config through the row's fiber, so `entry.options.config`
   * is REPLACED rather than mutated. A reference captured before the call therefore never sees
   * the new values, and no amount of checking the order of the edit and the use catches that.
   * What has to hold is the order of the edit and the READ. */
  /* Scanned over CODE ONLY. An assertion about the order of two statements must not be satisfied
   * or broken by prose, and the first version of this was: it matched the identifier inside two
   * doc comments (one of them the comment explaining this very fix) and went red on a file that
   * was correct. This repository has already been burned once by a check that matched header
   * prose rather than a declaration; the rule is the same here. */
  const codeOnly = index
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
  const editAt = codeOnly.indexOf('await configEditor.edit(entry');
  const configReads = [...codeOnly.matchAll(/entry\.options\.config/g)].map((match) => match.index);
  const staleReads = configReads.filter((at) => at < editAt);
  check(
    'the row is read back after the write, so the receipt is what was persisted and not the request',
    editAt >= 0 && configReads.length > 0 && staleReads.length === 0,
    staleReads.length
      ? `${staleReads.length} read(s) of entry.options.config BEFORE the edit —the editor replaces ` +
        'that object, so a reference taken before it stays stale and a write that took is reported as one that did not'
      : `edit at ${editAt}, ${configReads.length} read(s) of the config, every one after it`,
  );
}

/* ---------------------------------------- the agent core is invoked only by tools */

/* The user's constraint, held where it can fail. The run half of `agent-api` is reachable from its
 * tool definitions and from nothing else, and this bundle must not say otherwise anywhere —a
 * comment or a tool description that still describes a route-triggered judgement is how the
 * constraint dies, because the next reader implements the story they were told. */
{
  const agentApiIndex = read('components/agent-api/index.js');
  const memorylabComponent = read('components/memorylab/component.js');
  const memorylabIndex = read('components/memorylab/index.js');
  check(
    'the agent core is reachable only from its tool definitions, and the code says so',
    // The route closure holds `stateEnvelope` and no run-capable name.
    agentApiIndex.includes('const readState = () => api.stateEnvelope();') &&
      !/handler:[\s\S]*?runSend/.test(agentApiIndex.slice(agentApiIndex.indexOf('path: STATE_ROUTE'))) &&
      agentApiIndex.includes('This component is invoked only by tools.'),
    'the route handler must hold the read half only, and the refusal must say why',
  );
  check(
    'the panel reports the judgement the Host runs, and composes neither the ask nor the outcome',
    // REWRITTEN, and it had to be. The old assertion read
    //   client.includes('重建索引只做确定性重建') && client.includes('三类判定由 Agent 经工具完成：…')
    // and it was PASSING on a client that no longer contains either sentence — both survived only
    // inside the explanatory comment recording their deletion. A check that matches its own
    // explanatory comment is a check that cannot fail, so it is gone as written.
    //
    // The rule it described is retired too: the user asked for the button to DRIVE the run, so
    // "the panel never claims to judge" is now the wrong property in both directions. What must
    // hold is what the panel is allowed to do — report the Host half's outcome and nothing more:
    // it prints `judgement.label` (a value the Host composed), it calls no tag tool, and it never
    // words a judgement itself.
    /const judgementClause = state\.reindexing/.test(client) &&
      /state\.judgement && typeof state\.judgement\.label === 'string'/.test(client) &&
      !/memory_lab_tag/.test(client) &&
      /* No judgement OUTCOME may be written into this file. The first version of this check looked
       * for a quote immediately followed by one of those words, and it could not fail: a mutation
       * that hard-coded `'· 未运行：agent-api 不可用'` (a stray bullet first) left it green. This
       * one scans inside a string literal, so a composed clause of any shape is caught. */
      !/['"`][^'"`\n]*(已运行：|未运行：|超时未完成：|未发起：|未完成：|已中止：)/.test(client),
    'the panel renders the Host half’s clause; it does not compose one, and it calls no tag tool',
  );
  check(
    'MemoryLab reaches a judge — and a run — through the tools registry, and says so',
    // `AGENT_API_SERVICE` survives in `component.js` ONLY as prose recording what was replaced;
    // what must be gone is a LOOKUP, so the assertion is about the call and not the word.
    // The dispatch is the second half of the same fact: the tool whose registration is the
    // presence signal is the tool `judge()` calls, so "reachable" and "asked" cannot drift.
    memorylabIndex.includes('tools: ctx.tools') &&
      !/ctx\.get\(/.test(memorylabIndex) &&
      memorylabComponent.includes('agentApiPresence(tools)') &&
      memorylabComponent.includes('export const JUDGEMENT_TOOL = AGENT_API_PRESENCE_TOOL;') &&
      memorylabComponent.includes('name: JUDGEMENT_TOOL,') &&
      memorylabComponent.includes('tools.execute({'),
    'no service lookup, no second entry point: the registry is both the switch and the dispatch',
  );
  check(
    'the replaced story is recorded as replaced rather than left standing',
    // Two revisions of this file described a rule that no longer holds, and each is now named as
    // history with the reason it was replaced. The rule (the run is reached through the tool) is
    // unchanged; what changed is who calls the tool, and a reader told the old story would build
    // the wrong thing — either a route that cannot run anything, or a route that runs the loop
    // directly instead of dispatching the tool.
    memorylabComponent.includes('There is ONE path, not two') &&
      memorylabComponent.includes('never runs a judgement itself, and') &&
      memorylabComponent.includes('neither does the panel') &&
      memorylabComponent.includes('Both are now history') &&
      memorylabComponent.includes('the next reader implements the story they were told'),
    'each retired claim must appear as history, with the reason it was retired',
  );
}

/* ---------------------------------------------------- independent switches */

/* The components keep their own manifests, which is what makes each of them its own package
 * to the client-module registry. What they no longer have is a row of their own. */
check(
  'each component stays its own package inside the bundle',
  [
    path.join(packagesRoot, 'newmark-core'),
    path.join(packagesRoot, 'newmark-core', 'components', 'memorylab'),
    path.join(packagesRoot, 'newmark-core', 'components', 'computeruse'),
  ].every((dir) => fs.existsSync(path.join(dir, 'index.js')) && fs.existsSync(path.join(dir, 'package.json'))),
);
/* Recorded defect (2026-09-30, round 11): two Loader entries resolving to the same
 * package is a FATAL boot error —"resolves from multiple active Loader sources — * remove one entry" —which put the app into safe mode.
 *
 * CORRECTED 2026-10-05: that error belongs to the CLIENT-module registry, and the assertion
 * written from it ("no package is the target of more than one row") was broader than the rule
 * it cited. The counterexample is shipped, not hypothetical — `@deepseek-ai/dsh-web-app`
 * declares FOUR rows (`preset-standard`, `preset-ptc`, `preset-minimal`, `preset-cordis`) all
 * naming `@deepseek-ai/dsh-agent-preset`, and the app boots. That package carries no `dsh`
 * field at all (measured: its manifest has none), so it contributes no client bundle and its
 * rows cannot collide. The constraint is therefore stated as what it really binds: the
 * bundle's own client-carrying package is addressed exactly once, and any OTHER package
 * addressed more than once must be one that contributes no client half. */
check(
  'the bundle is addressed by exactly one row, because its client half resolves once',
  rowNames.filter((name) => name === 'newmark2dsh').length === 1,
  rowNames.join(', '),
);
check(
  'only the agent-preset declaration package is addressed by more than one row',
  rowNames
    .filter((name, index) => rowNames.indexOf(name) !== index)
    .every((name) => name === '@deepseek-ai/dsh-agent-preset'),
  `named by more than one row: ${[...new Set(rowNames.filter((name, index) => rowNames.indexOf(name) !== index))].join(', ') || 'none'}`,
);
check(
  'no component injects a service another component provides',
  ['memorylab', 'computeruse', 'agent-api'].every((name) =>
    /^export const inject = \['tools', 'webServer'\];$/m.test(readPackage(`newmark-core/components/${name}/index.js`)),
  ),
  'the composed components depend on the harness services and on nothing the bundle owns',
);
const rowEntries = {
  core: index,
  memoryLab: readPackage('newmark-core/components/memorylab/index.js'),
  computerUse: readPackage('newmark-core/components/computeruse/index.js'),
  agentApi: readPackage('newmark-core/components/agent-api/index.js'),
};
check(
  'each part of the bundle publishes its own page global',
  Object.values(rowEntries).every((source) => /export const SNAPSHOT_GLOBAL = '__NEWMARK_[A-Z]+__'/.test(source)),
  Object.entries(rowEntries)
    .map(([part, source]) => `${part}: ${(source.match(/SNAPSHOT_GLOBAL = '(\w+)'/) || [])[1] || 'none'}`)
    .join(', '),
);
/* The agent-api global is spelled twice on purpose —once in its entry file, where a reader
 * looks for it, and once in `lib/presence.js`, which is importable by another component whether
 * or not this one is mounted. Two spellings of one name is a rename waiting to half-happen, so
 * they are held together here: this is the assertion that makes the duplication safe rather
 * than the reason to tolerate it. */
check(
  'the agent-api global is one name, spelled the same in its entry file and in the presence module',
  /export const SNAPSHOT_GLOBAL = '(__NEWMARK_[A-Z]+__)'/.exec(rowEntries.agentApi ?? '')?.[1] ===
    /export const AGENT_API_GLOBAL = '(__NEWMARK_[A-Z]+__)'/.exec(read('components/agent-api/lib/presence.js'))?.[1],
  `entry ${/SNAPSHOT_GLOBAL = '(\w+)'/.exec(rowEntries.agentApi ?? '')?.[1]} vs presence ${/AGENT_API_GLOBAL = '(\w+)'/.exec(read('components/agent-api/lib/presence.js'))?.[1]}`,
);
check(
  'each part injects the web server it publishes through',
  Object.values(rowEntries).every((source) => source.includes('tapIndex') && /inject = \[[^\]]*'webServer'[^\]]*\]/.test(source)),
);
// The Dev preset USED to be selected by the `agent-preset-registry` entry's `selectedDefault`
// in the profile patch, and the Host half owned that write. The user removed the switch —
// 去除插件配置中的预设dev preset插件开关行，不用插件配置页调控默认预设 — so the property is now
// the absence of the whole path, and it is asserted on the lines that would come back first.
//
// The three dead mechanisms this replaced are recorded in `verify-preset-patch.mjs`: a
// `disabled` written inside a row's config (accepted, persisted, inert), an id-targeted
// `disabled: true` on the declaring row, and a client sending `presetDev` to a route
// comparing `preset-dev` — a silent no-op that wrote nothing and logged nothing.
check(
  'the core row does not inject the config editor it does not use',
  !/export const inject = \[[^\]]*'configEditor'[^\]]*\]/.test(read('index.js')),
  'an unused injection makes the row wait for a service it does not need',
);
check(
  'the core row does not inject the profile context the removed writer needed',
  !/export const inject = \[[^\]]*'profileContext'[^\]]*\]/.test(read('index.js')),
  'that service was injected to name the profile patch; with no writer there is nothing to name',
);
check(
  'the host route has no preset branch, and no writer below it',
  !/PRESET_COMPONENT_KEY/.test(index) && !/setPresetSelected/.test(index) && !/ctx\.profileContext/.test(index),
  'the switch is deleted, not disabled: a branch that survives is a branch that can still be posted to',
);
check(
  'the panel offers no preset row',
  !/presetDev/.test(client) && !/Dev preset/.test(client),
  'a row whose route is gone is the same defect as a route whose row is gone',
);
check(
  'the shipped package carries no profile-patch writer',
  !fs.existsSync(path.join(pkg, 'lib', 'preset-row.js')),
  'the writer moved nowhere: the parser the gates need lives in scripts/lib, outside the package',
);
check(
  'every part of the bundle publishes a distinct global',
  new Set(Object.values(rowEntries).map((source) => (source.match(/SNAPSHOT_GLOBAL = '(\w+)'/) || [])[1])).size === 4,
  Object.entries(rowEntries)
    .map(([part, source]) => `${part}: ${(source.match(/SNAPSHOT_GLOBAL = '(\w+)'/) || [])[1] || 'none'}`)
    .join(', '),
);
check('MemoryLab registers its seats only when it is mounted', client.includes('if (switches.memoryLab)'));
check(
  'ComputerUse registers no client seat at all',
  (client.match(/switches\.computerUse/g) || []).length === 0 && (client.match(/computerUse:/g) || []).length <= 3,
  'the takeover is a native window owned by the Host half, so the page has no part in it',
);
check(
  'the Client half is told which components are mounted by their globals',
  client.includes('memoryLab: Boolean(memory), computerUse: Boolean(automation), agentApi: Boolean(api)') && client.includes('newMate: Boolean(window.__NEWMARK_NEWMATE__)') && client.includes('heartBeat: Boolean(window.__NEWMARK_HEARTBEAT__)'),
);
/* Replaces "the shipped patch switches each component by its own row", which is genuinely
 * obsolete: there are no component rows left to switch. The patch declares the core row and
 * the preset row, the components are composed by the core row, and a `newmark-memorylab` or
 * `newmark-computeruse` row reappearing is the regression —that is what put a module path
 * on the plugin card. */
check(
  'the shipped patch declares the core row and the preset row, and no component row',
  /^ {4}- id: newmark-core$/m.test(presetPatch) &&
    /^ {4}- id: preset-dev$/m.test(presetPatch) &&
    !/^ {4}- id: newmark-(memorylab|computeruse)$/m.test(presetPatch),
  `rows: ${(presetPatch.match(/^ {4}- id: .+$/gm) || []).map((match) => match.trim()).join(', ')}`,
);
/* The honesty property that replaced the boolean pair: a config boolean on one row cannot
 * gate a sibling row, so no row advertised one. The switch that exists now is the core
 * row's own `compose` flag, which it can enforce because the components are children of its
 * own fiber —so the patch declares no `components` map, and the row names the flag it
 * really reads. */
check(
  'the only component switch is the core row\'s compose flag, not a components map',
  !/^ {8}components:$/m.test(presetPatch) &&
    !index.includes('components: enabled') &&
    index.includes('compose: schema') &&
    /\.default\(true\)/.test(index),
);

/* ------------------------------------------------ the sidebar seat is MemoryLab */

check(
  'MemoryLab owns the sidebar entry under the id memory-lab',
  client.includes("const PANEL_ID = 'memory-lab'") &&
    client.includes("name: 'sidebar.panellist', id: PANEL_ID"),
);
check('MemoryLab owns the matching main-panel key', client.includes("ctx.slots.register({ name: 'main', key: PANEL_ID }"));
check(
  'ComputerUse registers no sidebar entry and no main panel',
  !computeruse.includes('sidebar.panellist') && !computeruse.includes("name: 'main'"),
);
/* The seats are the two MemoryLab ones plus the bundle's own config panel, which is the
 * seat that replaced the Loader rows the card used to draw. Three injections, no more: a
 * fourth seat means a surface this half is not supposed to own. */
check(
  'the client registers MemoryLab and NewMate seats and the bundle\'s own config panel',
  (client.match(/slots\.inject\('/g) || []).length === 5 &&
    client.includes("slots.inject('sidebar.panellist'") &&
    client.includes("slots.inject('main'") &&
    client.includes("slots.inject('plugins.bundle.config'") &&
    client.includes("name: 'plugins.bundle.config', key: 'newmark2dsh'"),
  (client.match(/slots\.inject\('[^']+'/g) || []).join(', '),
);

/* --------------------------------------------- the takeover stroke is frozen */

/* The takeover effect must not touch the page. A page-level stroke read the lease
 * from the snapshot the page was loaded with, so it appeared only after a reload and
 * then stayed up after the lease ended.
 *
 * AND THE MATCH IS OVER CODE, NOT PROSE. Both takeover checks below used to read the raw file, so
 * a COMMENT naming the seat a panel deliberately does not use — "the card renders inside the
 * header rather than through the frame-wide floating seat" — failed a check whose subject is what
 * the page RENDERS, and a comment renders nothing. It happened at 0.2.18 and produced a red
 * release gate for a change that was correct. Comments are stripped first, which is this
 * repository's standing rule for every prose-versus-code match; the assertions keep their subject,
 * because a real reference in CODE is still caught. */
const clientCode = client.replace(/\/\*[\s\S]*?\*\//g, '');

check(
  'the page carries no takeover surface',
  !clientCode.includes('shell.overlay') &&
    !clientCode.includes('newmark-core-takeover') &&
    !clientCode.includes('nmc-takeover') &&
    !clientCode.includes('nmc-marquee'),
  'the client must not render any part of the takeover',
);
/* Re-scoped, and the reason is worth recording because the earlier form was not strict —it was
 * WRONG. It read `!/conic-gradient/.test(client)` under the name "the page draws no takeover
 * geometry", and a conic gradient is not takeover geometry: it is how the MemoryLab panel draws
 * its own rebuild progress ring, a 2 px border inside this panel. The real takeover stroke is a
 * native topmost click-through Win32 window owned by the Host half and covering the whole
 * screen; the page draws no part of it, and that is asserted by the check above and by the
 * overlay checks below.
 *
 * The mis-scoped form had a cost beyond being wrong: it forced the panel's progress bar back to
 * four seamed edge strips to satisfy a check about something else, and the client harness
 * asserts the opposite shape. Two gates disagreeing about one CSS function is how a bundle ends
 * up unable to satisfy its own release. What is asserted now is the property the name claims — * the takeover's own geometry words are absent from the page —plus the panel ring's being what
 * it is, so a regression in either direction is still caught. */
const takeoverGeometry = ['conic-gradient(from var(--nmc', 'nmc-takeover-ring', 'nmc-marquee', 'shell.overlay'];
check(
  'the page draws no takeover geometry',
  takeoverGeometry.every((marker) => !clientCode.includes(marker)),
  `looked for: ${takeoverGeometry.join(', ')}`,
);
check(
  'the panel progress ring is the panel\'s own, and is the single-element sweep the harness asserts',
  /@property --ml-lap-angle \{[^}]*syntax: '<angle>'/.test(client) &&
    /\.ml-lap \{[^}]*background: conic-gradient\(from var\(--ml-lap-angle\)/.test(client.replace(/\n\s*/g, ' ')) &&
    /@keyframes ml-lap-sweep \{ to \{ --ml-lap-angle: 360deg; \} \}/.test(client) &&
    client.includes("h('div', { className: 'ml-lap', 'aria-hidden': 'true' })"),
  'one element, one animatable angle, and no per-edge spans',
);

const overlay = read('components/computeruse/lib/overlay-win32.js');
const win32 = read('components/computeruse/lib/win32.js');
check(
  'the Host half owns the takeover as a native window',
  /export async function startOverlay/.test(overlay) &&
    /export async function stopOverlay/.test(overlay) &&
    /export function overlayState/.test(overlay),
);
check(
  'the native overlay covers the virtual screen, not a window',
  overlay.includes('SystemInformation]::VirtualScreen') && /WS_EX_TRANSPARENT/.test(overlay) && /WS_EX_TOOLWINDOW/.test(overlay),
);
check(
  'the native overlay never leaves a console window',
  /CREATE_NO_WINDOW/.test(overlay),
  'a console window would steal the foreground',
);
{
  const backend = read('components/computeruse/lib/win32.js');
  check(
    'the overlay is bound to the lease, so no page load is needed to show or clear it',
    /releaseOverlay\(/.test(backend) && /startTakeoverOverlay\(/.test(backend),
  );
  check('the takeover reports the selected mode overlay state', /overlay: overlayState\(options\)/.test(backend) && /overlayState\(\{mouseMode:requested\}\)/.test(backend));
}

/* ---------------------------------------------------------------- the icons */

/* The bundle icon must be Newmark's own vector app icon, not a stand-in, and the
 * MemoryLab entry must carry Newmark's own Lucide `brain` geometry —the sprite
 * symbol the product itself uses for that entry. Both are checked verbatim. */
{
  const icon = read('icon.svg');
  check(
    'the bundle icon is Newmark\'s vector app icon',
    icon.includes('viewBox="0 0 1024 1024"') &&
      icon.includes('<rect x="125" y="111" width="774" height="797" rx="160" fill="#000000"/>') &&
      icon.includes('M 506.5 255'),
    `${icon.length} bytes`,
  );

  const lucideBrain = [
    'M12 18V5',
    'M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4',
    'M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5',
    'M17.997 5.125a4 4 0 0 1 2.526 5.77',
    'M18 18a4 4 0 0 0 2-7.464',
    'M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517',
    'M6 18a4 4 0 0 1-2-7.464',
    'M6.003 5.125a4 4 0 0 0-2.526 5.77',
  ];
  const missing = lucideBrain.filter((d) => !client.includes(`d: '${d}'`));
  check(
    'the MemoryLab entry carries the Lucide brain geometry verbatim',
    missing.length === 0,
    missing.length ? `missing ${missing.length} of 8 paths: ${missing[0]}` : 'all 8 paths present',
  );
  check('the MemoryLab icon keeps the Lucide 24 / 2 spec', client.includes("viewBox: '0 0 24 24'") && client.includes('strokeWidth: 2,'));
  check(
    'the MemoryLab icon is no longer a hand-drawn approximation',
    !client.includes("d: 'M12 5.5a3 3 0 0 0-3 3"),
  );
}

/* --------------------------- bounded routes, no server and no port of its own */

/* Replaces "the host half registers no HTTP route", which is genuinely obsolete: the bundle
 * serves exactly one route of its own —the component control route the config panel reads
 * and writes —and a second registration is the regression this guards. It stays a same-
 * origin control surface for this bundle's own page and never touches the shared store. */
check(
  'the host half registers only component controls and read-only update discovery',
  (index.match(/webServer\.register\(/g) || []).length === 2 &&
    index.includes("kind: 'exact'") &&
    index.includes("path: '/newmark-core/update'") &&
    index.includes("path: '/newmark-core/components'"),
  `registrations: ${(index.match(/webServer\.register\(/g) || []).length}`,
);
/* Replaces "the client half opens no HTTP channel", which is genuinely obsolete: the panel
 * must read the Host's answer rather than the click, so it opens exactly one channel. The
 * contract is that there is one channel and it is same-origin —a relative path, no second
 * endpoint, and no other transport. */
check(
  'the client limits explicit channels to same-origin controls, update discovery and NewMate theme',
  (() => {
    const channels = [...client.matchAll(/fetch\(\s*'([^']*)'/g)].map((match) => match[1]);
    /* A QUERY IS NOT A SECOND ENDPOINT. '/newmark-core/components?view=newMate' asks the same
     * route a narrower question — one component's size, without enumerating the model catalogue
     * on a poll that runs every second — so paths are compared without their query string. A new
     * PATH still fails here; the tree's only query is named in the comment above and re-measured
     * below, so a second one cannot arrive unnoticed. */
    const distinct = new Set(channels.map((url) => url.split('?')[0]));
    const queries = new Set(channels.filter((url) => url.includes('?')).map((url) => url.slice(url.indexOf('?'))));
    /* MEASURED 2026-10-28: 8 distinct same-origin paths. The literal said 6 while the tree already
     * held 7 before this round (the '/newmark-newmate/loop' poll is not in the list below, so the
     * count and the named set had drifted apart from each other); 0.3.62 adds
     * '/newmark-newmate/upload' for the page's byte route. Both halves are now stated so the next
     * addition cannot pass by making the count agree with itself. */
    return queries.size === 1 && queries.has('?view=newMate') &&
      distinct.size === 8 && distinct.has('/newmark-newmate/upload') && distinct.has('/newmark-newmate/loop') && distinct.has('/newmark-newmate/events') && distinct.has('/newmark-core/components') && distinct.has('/newmark-memorylab/short-memory') && distinct.has('/newmark-newmate') && distinct.has('/newmark-computeruse/menu-theme') && distinct.has('/newmark-core/update') &&
      [...distinct].every((url) => url.startsWith('/') && !url.startsWith('//')) &&
      channels.length >= 1 &&
      !client.includes('EventSource') &&
      !client.includes('XMLHttpRequest') &&
      !client.includes('new WebSocket');
  })(),
  `${[...new Set([...client.matchAll(/fetch\(\s*'([^']*)'/g)].map((match) => match[1]))].join(', ')} across ${(client.match(/fetch\(/g) || []).length} call(s)`,
);
check(
  'the client reads all three page globals',
  ['__NEWMARK_CORE__', '__NEWMARK_MEMORYLAB__', '__NEWMARK_COMPUTERUSE__'].every((name) => client.includes(name)),
);
check('the host half contributes an index injection', index.includes('tapIndex') && index.includes('SNAPSHOT_GLOBAL'));
check('the injected value is escaped against markup break-out', read('lib/embed.js').includes("replace(/</g, '\\\\u003c')"));
/* `@deepseek-ai/dsh-client-ui-primitives` is allowed and nothing else is. The rule this
 * replaces read `!/require\(['"]@deepseek-ai\//` under the name "no harness Client package is
 * imported by the client half" —an absolute ban, written when the client required nothing from
 * the shell at all and when a `remote` namespace had already cost this bundle a round by not
 * resolving.
 *
 * The ban was right about the thing it feared and wrong about the boundary. The primitives are a
 * PUBLISHED dependency with its own `exports` map, and FIFTY of the shell's own client plugins
 * require it —including for the Markdown and KaTeX rendering the component preview now uses.
 * Reading a sibling plugin's internals is still forbidden; using the shell's supported UI surface
 * is what a plugin is supposed to do.
 *
 * So it is an allowlist, named, rather than a blanket. If another package is ever needed here it
 * has to be added deliberately, with the same argument: does it have an `exports` map, and do
 * shipped plugins require it the same way? */
const ALLOWED_CLIENT_REQUIRES = ['@deepseek-ai/dsh-client-ui-primitives'];
const clientRequires = [...client.matchAll(/require\(['"](@deepseek-ai\/[^'"]+)['"]\)/g)].map((m) => m[1]);
const unexpectedClientRequires = clientRequires.filter((name) => !ALLOWED_CLIENT_REQUIRES.includes(name));
check(
  'the client half requires only the shell packages that are allowed, by name',
  unexpectedClientRequires.length === 0,
  unexpectedClientRequires.length
    ? `unexpected: ${unexpectedClientRequires.join(', ')}`
    : `allowed: ${clientRequires.join(', ') || '(none)'}`,
);
check(
  'the one allowed shell package really is the supported UI surface, not an internal',
  clientRequires.every((name) => name === '@deepseek-ai/dsh-client-ui-primitives'),
);
check('no harness package is imported by the host half', !/from ['"]@deepseek-ai\//.test(index + memorylab + computeruse));

/* ------------------------------------ the ComputerUse output funnel

 * The ComputerUse backends are full of `—: undefined` result fields (`lib/win32.js:1357,1882,
 * 3416,3540,3541` and several in `lib/linux.js`), and `undefined` is NOT a JSON value: DSH
 * validates every tool's return as lossless JSON before handing it back
 * (`dsh-tools/lib/index.js:2578`, walker at `dsh-util-values/lib/index.js:109`), and this
 * repository has already lost a release to that boundary once —`memory_lab_reindex` wrote the
 * index correctly and then reported a hard failure for it.
 *
 * Those fields are harmless here for exactly one reason, and it is not obvious from the files:
 * the backends return a JSON **STRING** (`return stringifyResult(result)` on every return path
 * of `runComputerUse`) and the component parses it (`asToolResult`). **`JSON.parse` cannot
 * produce `undefined`.** A measurement found 25 distinct undefined-valued paths being handed to
 * `JSON.stringify` inside these backends —they are reached, and they die there.
 *
 * So this asserts the funnel itself, because the funnel is what holds. Two rejected alternatives
 * are worth recording: cleaning the 25 sites would be cosmetic (it changes nothing at the
 * boundary —measured), and a shared sanitiser would receive only already-lossless values, so no
 * real input could make it fire. That is an assertion that cannot fail, which is the shape this
 * repository keeps having to delete.
 *
 * The failure this DOES catch is the one that breaks the boundary for real: a backend that stops
 * serialising (measured red), or a component that returns the raw string instead of parsing it
 * (also measured red). */
{
  const cuWin32 = read('components/computeruse/lib/win32.js');
  const cuLinux = read('components/computeruse/lib/linux.js');
  const cuComponent = read('components/computeruse/component.js');
  /* Every `return` inside `runComputerUse` must be a `stringifyResult(...)` call. Scoped to that
   * function's body, because `return stringifyResult(` appearing anywhere in the file would pass
   * even if the main path returned the raw object. */
  const unstringified = [];
  for (const [name, source] of [['win32', cuWin32], ['linux', cuLinux]]) {
    const start = source.indexOf('function runComputerUse');
    if (start < 0) {
      unstringified.push(`${name}: runComputerUse not found`);
      continue;
    }
    const body = source.slice(start, source.indexOf('\n}', start) + 1);
    for (const match of body.matchAll(/return\s+([^;]+);/g)) {
      if (!/stringifyResult\(/.test(match[1])) unstringified.push(`${name}: return ${match[1].trim().slice(0, 60)}`);
    }
  }
  check(
    'every ComputerUse backend return path hands the tool a serialised string',
    unstringified.length === 0,
    unstringified.length
      ? `raw object returns, which is how an undefined reaches the boundary: ${unstringified.join(' | ')}`
      : `${(cuWin32.match(/return stringifyResult\(/g) || []).length + (cuLinux.match(/return stringifyResult\(/g) || []).length} serialised return paths`,
  );
  check(
    'the ComputerUse component parses that string rather than passing it through',
    /function asToolResult\([\s\S]{0,400}?JSON\.parse\(/.test(cuComponent),
    'without the parse the tool returns a string where an object is expected',
  );
}

/* ------------------------------------------------- shared Newmark user store */

check('the default root is the Newmark user path', /path\.join\(os\.homedir\(\), '\.Newmark'\)/.test(read('lib/root.js')));
check('the store lives beside the Newmark Memory Lab folder', readPackage('newmark-core/components/memorylab/lib/memory-store.js').includes('Memory Lab'));
check('the row config can override the root', read('lib/root.js').includes('config?.root'));

/* Recorded defect (2026-10-25): the store was constructed on the Newmark root
 * instead of on `<root>/Memory Lab`, which wrote an empty index.json and an
 * empty components/ directory straight into the user's Newmark root. The join is
 * now asserted here instead of being trusted at the call site. */
check(
  'the Memory Lab folder is joined under the shared root',
  /export function memoryLabDir\(root\)/.test(memorylab) && memorylab.includes("path.join(root, 'Memory Lab')"),
);
check(
  'the store is constructed on the Memory Lab folder, never on the shared root',
  memorylab.includes('const labDir = memoryLabDir(root);') && memorylab.includes('new MemoryLabStore(labDir'),
);
check(
  'the panel prints no local store path',
  !client.includes('state.root') && !client.includes('state.indexPath') && !client.includes('state.componentsDir'),
);

/* --------------------------------------------------------- retired CULab line */

{
  const sources = {
    'index.js': index,
    'client.js': client,
    'components/memorylab.js': memorylab,
    'components/computeruse.js': computeruse,
    'newmark-core/components/memorylab/lib/memory-store.js': readPackage('newmark-core/components/memorylab/lib/memory-store.js'),
    'newmark-core/components/computeruse/lib/win32.js': readPackage('newmark-core/components/computeruse/lib/win32.js'),
  };
  if (fs.existsSync(path.join(packagesRoot, 'newmark-core', 'components', 'computeruse', 'lib', 'linux.js'))) {
    sources['newmark-core/components/computeruse/lib/linux.js'] = readPackage('newmark-core/components/computeruse/lib/linux.js');
  }
  const forbidden = ['newmark-cu-lab', 'culab', 'nes-t', 'nmep', 'onnx', 'idlock', 'ryzenai', 'vitisai', 'screenspot', 'screenparse', 'os-atlas'];
  for (const marker of forbidden) {
    const hit = Object.entries(sources).find(([, text]) => text.toLowerCase().includes(marker));
    check(`no source references the retired line: ${marker}`, !hit, hit ? `found in ${hit[0]}` : '');
  }
}

/* ------------------------------------------------------------ action surface */

{
  const required = [
    'observe', 'app_list', 'app_observe', 'wait_for', 'sequence',
    'takeover_start', 'takeover_stop', 'move', 'click', 'drag', 'scroll',
    'type', 'key', 'wait', 'app_activate', 'app_click', 'app_drag',
    'app_scroll', 'app_type', 'app_key', 'mode_report', 'process_push', 'process_pull',
  ];
  const declared = computeruse.slice(computeruse.indexOf('COMPUTER_USE_ACTIONS'), computeruse.indexOf('];', computeruse.indexOf('COMPUTER_USE_ACTIONS')));
  const missing = required.filter((action) => !declared.includes(`'${action}'`));
  check('the action surface carries all 23 verbs', missing.length === 0, missing.join(', '));
  /* Replaces the retired assertion "the lease TTL is the named constant 120000", which is
   * genuinely obsolete: the takeover lease has no time limit any more and is released only
   * by `takeover_stop`. The check now asserts the absence of the old TTL rather than its
   * presence, because a `LEASE_TTL_MS = 120_000` reappearing here means the timer is back. */
  check(
    'the lease carries no TTL: it is released by takeover_stop, not by a clock',
    !/(^|\n)\s*(export\s+)?const\s+LEASE_TTL_MS\s*=/.test(computeruse) && /LEASE_EXPIRY = 'none'/.test(computeruse) && /releasedBy: 'takeover_stop'/.test(computeruse),
  );
  /* And the backend must agree: no TTL declaration, no expiry timer, no 'expired' reason.
   * The source checks match declarations rather than the retired constant's name in prose,
   * so the module can document why the TTL is gone without failing its own gate. */
  check(
    'the win32 backend holds a lease with no expiry timer and no lease_expiry stop path',
    !/(^|\n)\s*(export\s+)?const\s+LEASE_TTL_MS\s*=/.test(win32)
      && !/setTimeout\([^)]*releaseLease/.test(win32)
      && /LEASE_EXPIRY = 'none'/.test(win32)
      && !/'lease_expiry'/.test(overlay)
      && !/expired: 'lease_expired'/.test(overlay),
  );
}

/* ------------------------------------------------------ platform dispatch */

check(
  'the ComputerUse component dispatches on the platform',
  computeruse.includes("process.platform === 'win32'") && computeruse.includes("process.platform === 'linux'"),
);
check('a missing backend is a structured error, not a crash', computeruse.includes('unsupported_platform'));
/* Recorded defect (2026-09-30, round 14), found by running the tool: on win32 it
 * answered `unsupported_platform` —"Computer Use is not available on win32.
 * Windows and Linux are supported." —while the host log held the real cause, an
 * unimportable backend module. The message named a platform gap that did not exist
 * and swallowed the cause. */
check(
  'a platform with no backend and a backend that failed to load are distinct answers',
  computeruse.includes("code: 'unsupported_platform'") && computeruse.includes("code: 'backend_unavailable'"),
);
check(
  'a failed backend load carries its cause into the answer',
  /code: \(backendFailure && backendFailure\.code\)/.test(computeruse) && /error: \(backendFailure && backendFailure\.error\)/.test(computeruse),
);
check(
  'the backend loader names the module it tried to import',
  /const wanted = process\.platform === 'win32'/.test(computeruse) && computeruse.includes('could not load its'),
);
check(
  'the misleading platform sentence is gone',
  !computeruse.includes('is not available on win32. Windows and Linux are supported.'),
);

check(
  'the backends are loaded lazily, and only for this platform',
  /backendPromise \?\?= \(async \(\) => \{/.test(computeruse) &&
    computeruse.includes("process.platform === 'win32' ? './lib/win32.js'") &&
    computeruse.includes("process.platform === 'linux' ? './lib/linux.js'") &&
    /return await import\(wanted\);/.test(computeruse),
);

const hasLinux = fs.existsSync(path.join(packagesRoot, 'newmark-core', 'components', 'computeruse', 'lib', 'linux.js'));
if (hasLinux) {
  const linux = readPackage('newmark-core/components/computeruse/lib/linux.js');
  check('the Linux backend exists and is non-trivial', linux.length > 5000, `${linux.length} bytes`);
  check('the Linux backend reports its probed backend', /backend|missing_tools/.test(linux));
  check('the Linux backend returns no_display rather than throwing', linux.includes('no_display'));
  check('the Linux backend refuses virtual mode rather than falling back to real input', linux.includes('virtual_mode_unsupported'));
} else {
  skip('Linux backend assertions', 'lib/linux.js is not present yet');
}

/* ------------------------------------------------ the overview drill-down */

check(
  'the overview takes a track callback and an activate callback separately',
  client.includes('function OverviewView({ state, selection, onFocus, onActivate })'),
);
check(
  'a first click on an untracked node tracks it without switching the view',
  client.includes('if (focus === node.id) {') &&
    client.includes('focusRef.current?.(picked);') &&
    client.indexOf('if (focus === node.id) {') < client.indexOf('focus = node.id;'),
);
check(
  'clicking the tracked node opens its detail view',
  client.includes('activateRef.current?.(picked);'),
);
check(
  'the panel wires tracking to selection only, and activation to the detail view',
  client.includes('onFocus: (next) => setSelection(next),') &&
    client.includes('setSelection(next);') &&
    client.includes("setView('detail');"),
);
check('the overview no longer collapses both steps into one callback', !client.includes('selectRef'));

/* ------------------------------------ the two agent presets: Dev and rDev ---
 *
 * The presets are the bundle's components that are not plugin code: each is a
 * `@deepseek-ai/dsh-agent-preset` *declaration*, which the Loader reads from a row of its
 * own and the agent-preset-registry selects. Neither can be composed the way MemoryLab and
 * ComputerUse are — there is nothing to `ctx.plugin()` — so each keeps its own row.
 *
 * `preset-dev` is the creator mode and `preset-rdev` is the same agent without it. The
 * assertions below are written against a SLICE of the patch per preset, not against the
 * whole file: a whole-file regex passes just as happily when a row is present in the wrong
 * preset, which is precisely the regression that matters here.
 */

/** The patch text of one `preset-*` entry: its `- id:` line through the next row or column-0 line. */
function presetBlock(rowId) {
  const lines = presetPatch.split('\n');
  const start = lines.findIndex((line) => line === `    - id: ${rowId}`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {4}- id: /.test(line) || (line !== '' && !line.startsWith(' ')));
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const devBlock = presetBlock('preset-dev');
const rdevBlock = presetBlock('preset-rdev');

check(
  'the bundle patch declares the core row and both preset rows',
  /^ {4}- id: newmark-core$/m.test(presetPatch) &&
    /^ {4}- id: preset-dev$/m.test(presetPatch) &&
    /^ {4}- id: preset-rdev$/m.test(presetPatch),
);
check(
  'each preset row is an agent-preset declaration',
  /^ {4}- id: preset-dev\n {6}name: '@deepseek-ai\/dsh-agent-preset'$/m.test(presetPatch) &&
    /^ {4}- id: preset-rdev\n {6}name: '@deepseek-ai\/dsh-agent-preset'$/m.test(presetPatch),
);
check('Dev keeps its identity', /^ {8}id: dev$/m.test(devBlock) && /^ {8}name: Dev$/m.test(devBlock));
check('Dev keeps its roster position', /^ {8}order: 2\.5$/m.test(devBlock));
check('rDev is its own identity, next to Dev in the roster', /^ {8}id: rdev$/m.test(rdevBlock) && /^ {8}name: rDev$/m.test(rdevBlock));
check('rDev sits immediately after Dev', /^ {8}order: 2\.6$/m.test(rdevBlock));
check(
  'Dev carries all twenty-one plugins',
  (devBlock.match(/^ {10}- id: /gm) || []).length === 21,
  `Dev plugin rows: ${(devBlock.match(/^ {10}- id: /gm) || []).length}`,
);
check(
  'rDev carries all twenty',
  (rdevBlock.match(/^ {10}- id: /gm) || []).length === 20,
  `rDev plugin rows: ${(rdevBlock.match(/^ {10}- id: /gm) || []).length}`,
);
for (const id of ['persona', 'agent-instructions', 'tool-pwsh', 'planning', 'compaction', 'delegation', 'tool-presentation']) {
  check(`Dev still mounts ${id}`, new RegExp(`^ {10}- id: ${id}$`, 'm').test(devBlock));
  check(`rDev still mounts ${id}`, new RegExp(`^ {10}- id: ${id}$`, 'm').test(rdevBlock));
}
/* ------------------------------------ Dev is a creator mode (创造模式) ---
 *
 * The Dev preset carries the kernel-modification capability the shipped `cordis`
 * preset ("创造模式" / Creator mode) grants, and that capability is exactly three
 * rows — runtime inspection, the composition skills, and persistent plugin
 * management. Each is asserted by its own name, because a row that silently
 * disappears takes the capability with it while every count above still passes:
 * a count cannot tell which row went.
 *
 * The `!!js` gate is asserted as text on purpose. It is the shipped preset's own
 * expression, and its value is that it is the SHIPPED one: `disabled` is evaluated
 * against the row's own context at mount, so a rewritten equivalent is a different
 * gate, not a paraphrase of one.
 */
check(
  'Dev carries the runtime-inspection tool the creator mode carries',
  /^ {10}- id: tool-cordis\n {12}name: '@deepseek-ai\/dsh-tool-cordis'$/m.test(devBlock),
);
check(
  'Dev carries the composition skills the creator mode carries',
  /^ {10}- id: skill-filesystem\n {12}name: '@deepseek-ai\/dsh-skill-filesystem'\n {12}config:\n {14}customSkillDirs:\n {16}- !!js .*['"]@deepseek-ai\/dsh-agent-preset\/package\.json['"].*$/m.test(
    devBlock,
  ),
  'the Cordis plugin and agent-preset guidance lives in the @deepseek-ai/dsh-agent-preset package, not in this bundle',
);
check(
  'Dev manages plugins through the profile patch, under the shipped gate',
  /^ {10}- id: tool-plugin-manager\n {12}name: '@deepseek-ai\/dsh-plugin-manager\/tools'\n {12}disabled: !!js "!ctx\.get\('profileContext'\)"$/m.test(
    devBlock,
  ),
  'unconditionally disabled is the gap this closes; unconditionally enabled would claim a profile patch that may not exist',
);
check(
  'Dev advertises the capability it has',
  devBlock.includes('创造模式内核修改权限'),
  'the picker shows the description, so a silent capability change is a description that lies',
);
check(
  'both presets keep the platform-gated shells rather than both at once',
  devBlock.includes("disabled: !!js process.platform === 'win32'") &&
    devBlock.includes("disabled: !!js process.platform !== 'win32'") &&
    rdevBlock.includes("disabled: !!js process.platform === 'win32'") &&
    rdevBlock.includes("disabled: !!js process.platform !== 'win32'"),
);
check(
  'both presets keep the project-management persona',
  [devBlock, rdevBlock].every(
    (block) =>
      block.includes('README.md') && block.includes('OVERVIEW.md') && block.includes('taste.md') && block.includes('archive/'),
  ),
);

/* ------------------------------------ rDev is Dev minus exactly three changes ---
 *
 * "Same agent, no creator mode" is a claim about a DIFFERENCE, and a difference is the one
 * thing two hand-maintained copies get wrong in silence: add a tool to Dev and forget rDev,
 * and both files still look right. So the difference is computed here, row by row, and
 * required to be exactly these three changes and nothing else.
 */

/** One preset's plugin rows as `id -> declaration`, for an order-insensitive row diff.
 *
 * Comments and blank lines are stripped before comparing: they are prose about a row, not
 * part of it, and a comment that sits above the NEXT row would otherwise be attributed to
 * the row before it. Comparing raw text made `tool-jobs`, `tool-web` and `present` differ
 * for that reason alone, and an assertion that fires on prose gets relaxed until it means
 * nothing. */
function presetRows(block) {
  const rows = new Map();
  const lines = block.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {10}- id: (.+)$/.exec(lines[index]);
    if (match === null) continue;
    const body = [lines[index]];
    for (let next = index + 1; next < lines.length && !/^ {10}- id: /.test(lines[next]); next += 1) body.push(lines[next]);
    rows.set(
      match[1],
      body.filter((line) => line.trim() !== '' && !/^\s*#/.test(line)).join('\n'),
    );
  }
  return rows;
}

const devRows = presetRows(devBlock);
const rdevRows = presetRows(rdevBlock);
const missingInRdev = [...devRows.keys()].filter((id) => !rdevRows.has(id));
const extraInRdev = [...rdevRows.keys()].filter((id) => !devRows.has(id));
const differing = [...devRows.keys()].filter((id) => rdevRows.has(id) && devRows.get(id) !== rdevRows.get(id));

check(
  'rDev mounts every row Dev mounts except tool-cordis',
  JSON.stringify(missingInRdev) === JSON.stringify(['tool-cordis']),
  `rows only in Dev: ${JSON.stringify(missingInRdev)}; rows only in rDev: ${JSON.stringify(extraInRdev)}`,
);
check('rDev adds no row of its own', extraInRdev.length === 0, JSON.stringify(extraInRdev));
/* Named on purpose: the two checks above catch a dropped row only as a DIFF (missingInRdev would
 * read ['tool-cordis','tool-fs']), which is correct but says nothing about the capability. rDev is
 * "Dev minus the creator mode" — file editing is NOT part of what it gives up, and a report that it
 * had lost file editing must be answerable from this gate rather than from prose. Whole-row
 * equality, like every other rDev comparison here. */
check(
  'rDev keeps file editing: tool-fs and tool-fs-search are whole-row identical to Dev',
  ['tool-fs', 'tool-fs-search'].every((id) => rdevRows.has(id) && devRows.has(id) && devRows.get(id) === rdevRows.get(id)),
  JSON.stringify({ toolFsInRdev: rdevRows.has('tool-fs'), toolFsSearchInRdev: rdevRows.has('tool-fs-search'), rdevToolFs: rdevRows.get('tool-fs') }),
);
check(
  'exactly three rows differ: tool-cordis is gone, skill-filesystem loses customSkillDirs, plugin-manager loses the gate',
  JSON.stringify(differing) === JSON.stringify(['skill-filesystem', 'tool-plugin-manager']),
  `rows that differ beyond the dropped tool-cordis: ${JSON.stringify(differing)}`,
);
/* These two are asserted as WHOLE-ROW EQUALITY, not as presence. A presence regex is
 * satisfied by a row that carries the right two lines and then anything at all — the
 * mutation test proved it: giving rDev a `customSkillDirs` of its own left every presence
 * check green, because `- id: skill-filesystem` followed by its `name:` line is still
 * there. Equality is what "the restricted row" means. */
check(
  'rDev keeps skill-filesystem as a plain two-line row, with nothing appended to it',
  rdevRows.get('skill-filesystem') ===
    "          - id: skill-filesystem\n            name: '@deepseek-ai/dsh-skill-filesystem'",
  JSON.stringify(rdevRows.get('skill-filesystem')),
);
check(
  'rDev disables the plugin manager with a literal true and no other key',
  rdevRows.get('tool-plugin-manager') ===
    "          - id: tool-plugin-manager\n            name: '@deepseek-ai/dsh-plugin-manager/tools'\n            disabled: true",
  JSON.stringify(rdevRows.get('tool-plugin-manager')),
);
check(
  'rDev advertises that it is the restricted one',
  rdevBlock.includes('restricted developer') && rdevBlock.includes('创造模式内核修改权限'),
  'a picker row that reads like Dev while lacking its powers is the failure this prevents',
);

/* Replaces "the bundle keeps four independently addressable rows", which is genuinely
 * obsolete: the two component rows are gone. Three rows is the design — the core row and
 * one row per preset — and the components are addressed by the core row rather than by the
 * Loader. */
check(
  'the bundle keeps three rows: the core row and one row per preset',
  (presetPatch.match(/^ {4}- id: /gm) || []).length === 3 &&
    /^ {4}- id: newmark-core$/m.test(presetPatch) &&
    /^ {4}- id: preset-dev$/m.test(presetPatch) &&
    /^ {4}- id: preset-rdev$/m.test(presetPatch),
  `rows: ${(presetPatch.match(/^ {4}- id: .+$/gm) || []).map((match) => match.trim()).join(', ')}`,
);
/* Replaces "each component row addresses its own package", which is genuinely obsolete:
 * addressing a component as a package needed a `file:` dependency, and pnpm resolves those
 * against the project root, so a registry install failed with
 * ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND. The new contract is the absence of that whole layer:
 * the manifest declares no dependencies, no `file:` specifier survives in it, and neither
 * component package name is addressed anywhere in the patch. */
check(
  'no component is addressed as a package: no dependencies and no file: specifier',
  Object.keys(manifest.dependencies || {}).length === 0 &&
    !JSON.stringify(manifest).includes('file:') &&
    !presetPatch.includes("name: 'newmark2dsh-memorylab'") &&
    !presetPatch.includes("name: 'newmark2dsh-computeruse'"),
  `dependencies: ${JSON.stringify(manifest.dependencies || {})}`,
);
/* The nested packages are what the client-module registry reads, and they stay: each is a
 * package with its own manifest and no client bundle of its own, so the registry sees the
 * bundle's client half once rather than once per component. */
check(
  'the nested component packages stay, and each declares no client bundle',
  ['memorylab', 'computeruse'].every((name) => {
    const component = JSON.parse(readPackage(`newmark-core/components/${name}/package.json`));
    return typeof component.name === 'string' && component.dsh?.client === undefined;
  }),
);
/* Replaces a check whose needle (`@local/newmark-…`) appears in no version of this patch and
 * therefore asserted nothing. Two recorded defects still hold: a package subpath fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED against the running profile, so every row names one whole
 * package —the bundle itself, or a harness package. */
check(
  'every row names a whole package, never a subpath',
  rowNames.every((name) => (name.startsWith('@') ? name.split('/').length === 2 : !name.includes('/'))),
  rowNames.join(', '),
);
check(
  'every row names one of the two packages, and both preset rows name the same one',
  new Set(rowNames).size === 2 &&
    rowNames.filter((name) => name === 'newmark2dsh').length === 1 &&
    rowNames.filter((name) => name === '@deepseek-ai/dsh-agent-preset').length === 2,
  rowNames.join(', '),
);

/* ------------------------------------------------- the overview frame loop */

/* Recorded defect (2026-09-30, round 7): the frame loop gated its work on a
 * one-shot `frameDirty` flag that nothing re-armed, so after the first frame the
 * graph stepped and painted never again —the animation was frozen while idle and
 * only moved during a drag, the exact opposite of the design. These assertions
 * hold the loop open. */
check('the frame loop is time-driven, not gated on a one-shot dirty flag', !client.includes('frameDirty'));
check(
  'the frame loop keeps itself armed every frame',
  /requestAnimationFrame\(frame\);\r?\n\s*\}/.test(client),
);
check('the frame loop does no work while the document is hidden', client.includes('if (!document.hidden)'));
check(
  'physics is suspended while dragging, and only while dragging',
  client.includes('if (!panActive) step(timestamp);'),
);
check(
  'the frame budget is throttled when idle and immediate while panning',
  client.includes('const budget = panActive ? 0 : OVERVIEW.FRAME_INTERVAL_MS;'),
);
check(
  'the initial frame is requested once the engine is built',
  /apiRef\.current = \{[\s\S]{0,600}?\n\s*requestFrame\(\);/.test(client),
);

/* --------------------------------------------- the shared store is not churned */

/* Recorded defect (2026-09-30, round 7): the display path called `reindex()`
 * unconditionally, which is idempotent in the graph but rewrites the index
 * timestamp —so every page load rewrote a store Newmark also owns. */
check('the component defines a staleness check before rebuilding', memorylab.includes('function needsRebuild('));
check('the staleness check compares the recorded body signature', memorylab.includes('meta.contentHash !== bodyDigest(body)') && memorylab.includes('meta.bytes !== Buffer.byteLength(body'));
check('the staleness check requires a relationship version', memorylab.includes('if (!index || !index.relationshipVersion) return true;'));
check(
  'the display path rebuilds only when the staleness check says so',
  memorylab.includes('mayRebuild && reindexOnRender && needsRebuild(visual)') &&
    memorylab.includes('const mayRebuild = options.rebuild !== false;'),
  'the staleness check gates the rebuild, and a read-only snapshot skips it entirely',
);
check(
  'no unconditional rebuild is left in the display path',
  !/if \(reindexOnRender\) \{\s*\n\s*try \{\s*\n\s*store\.reindex\(\);/.test(memorylab),
);
check(
  'the snapshot is re-read after a rebuild so the panel sees the rebuilt index',
  memorylab.includes('visual = store.visualizationSnapshot();') && (memorylab.match(/visualizationSnapshot\(\)/g) || []).length >= 2,
);
/* Replaces "the row can turn the display-path rebuild off" as it was written: the switch used
 * to be a `reindexOnRender` line in the patch's MemoryLab row, and that row is gone. The
 * switch moved with the component —the core row composes MemoryLab with the flag and the
 * component honours it —so the assertion follows it there. Dropping the flag from the
 * composed config, or making the component ignore it, fails here. */
check(
  'the row can turn the display-path rebuild off',
  /memoryLab:\s*\{[\s\S]*?config:\s*\([^)]*\)\s*=>\s*\(\{[^}]*reindexOnRender:\s*(true|false)[^}]*\}\)/.test(index) &&
    readPackage('newmark-core/components/memorylab/index.js').includes('reindexOnRender: config?.reindexOnRender !== false'),
  'the composed config carries the flag and the component reads it',
);

/* ------------------------------------- the panel refreshes itself, not the shell */

/* Recorded defect: the panel's reindex action ended in `window.location.reload()`,
 * so pressing 重建索引 reloaded the entire DSH shell —the conversation, the
 * mounted plugin, the scroll —to refresh one page. What it does now is ask the
 * MemoryLab component for the store: over that component's own snapshot route, on
 * the `webServer` service the row already injects, with `reindex=1` for the
 * rebuild. The client half must never reach for a page reload again.
 *
 * And the action is TWO HALVES. Since the user's instruction —先硬流程重建，再提交
 * Agent-api 用内置的 Newmark Agent core 进行 agent prompt 驱动的重建 —the same request,
 * `reindex=1`, runs the deterministic rebuild and then dispatches the judgement through
 * the `agent_api_send` TOOL. That is the one deliberate change to the bundle's oldest
 * rule, and it is narrow: a plain read still runs nothing, nothing caller-supplied
 * reaches the ask, and the run is still reached only through a tool. The checks below
 * hold the sequence and the narrowness; the behavioural half lives in the MemoryLab gate. */
const memorylabRow = readPackage('newmark-core/components/memorylab/index.js');
check(
  'the client never asks the page to reload itself',
  !/\.reload\s*\(/.test(client),
  'a `.reload(` call reappeared in client.js',
);
check(
  'both halves spell the same snapshot route',
  client.includes("const SNAPSHOT_ROUTE = '/newmark-memorylab/snapshot'") &&
    memorylabRow.includes("export const SNAPSHOT_ROUTE = '/newmark-memorylab/snapshot'"),
);
check(
  'the route is registered on the webServer service this component already injects',
  memorylabRow.includes('ctx.webServer.register({') &&
    memorylabRow.includes('path: SNAPSHOT_ROUTE,') &&
    /export const inject = \['tools', 'webServer'\];/.test(memorylabRow),
);
check(
  'the route answers a read and, only when asked, a rebuild AND the judgement that follows it',
  memorylabRow.includes("searchParams.get('reindex') === '1'") &&
    memorylabRow.includes('memorylab.rebuild()') &&
    memorylabRow.includes('memorylab.judge({ timeoutMs: judgementTimeoutMs, rebuildError: reindexError })') &&
    memorylabRow.includes('memorylab.snapshot({ rebuild: false })'),
  'a read must not be able to rebuild or run; a rebuild must be asked for explicitly',
);
check(
  'the two halves run in the user’s order: the deterministic rebuild first, the judgement second',
  // The ORDER, read off the source, because it is the part of the instruction that is easiest to
  // reverse without noticing: 先硬流程重建，再提交. A judgement built before the rebuild would be
  // asked about a graph the rebuild has not written yet, and `rebuildError` — which is what makes
  // a failed rebuild BLOCK the judgement instead of being silently ignored — only flows that way.
  memorylabRow.indexOf('rebuild = memorylab.rebuild();') !== -1 &&
    memorylabRow.indexOf('rebuild = memorylab.rebuild();') < memorylabRow.indexOf('judgement = await memorylab.judge(') &&
    memorylabRow.indexOf('memorylab.judge(') < memorylabRow.lastIndexOf('memorylab.snapshot({ rebuild: false })') &&
    // The judgement is asked for only inside the `wanted` branch, and the snapshot that reports it
    // is taken after it, so a judgement that applied decisions is visible to the panel.
    /if \(wanted\) \{[\s\S]{0,120}judgement = await memorylab\.judge\(/.test(memorylabRow),
  'the rebuild must precede the judgement, and both must precede the snapshot the panel renders',
);
check(
  'nothing a request carries can reach the judgement: its whole argument list is the row’s own two locals',
  // The route hands `judge()` a bound and the rebuild's error and nothing else — no query parameter,
  // no header, no body. This is the assertion that keeps the one route able to start a run from
  // becoming a route able to run anything: the ask is composed by the component from the graph, and
  // the caller supplies none of it.
  /judgement = await memorylab\.judge\(\{ timeoutMs: judgementTimeoutMs, rebuildError: reindexError \}\);/.test(memorylabRow) &&
    !/judge\(\{[^}]*searchParams/.test(memorylabRow) &&
    !/judge\(\{[^}]*req\./.test(memorylabRow) &&
    !/judge\(\{[^}]*prompt/.test(memorylabRow),
  'the judgement takes the bound and the rebuild error, and no caller-supplied text',
);
check(
  'the panel asks for the rebuild explicitly rather than inheriting one',
  client.includes("await loadVisualization({ reason: 'reindex', source: 'host', rebuild: true })") &&
    client.includes("loadVisualization({ reason: 'reset', source: 'host' })"),
);
check(
  'the two halves agree that a snapshot read can be told not to rebuild',
  memorylab.includes('const mayRebuild = options.rebuild !== false;'),
);
check(
  'exactly one 重置 control remains, and the camera action has its own name',
  (client.match(/['"]重置['"]/g) || []).length === 1 && client.includes("'视图归位'"),
  `${(client.match(/['"]重置['"]/g) || []).length} 重置 label(s)`,
);
/* Recorded defect (2026-09-30): this read `!client.includes('memory_lab_tag')`, which is
 * a string about a TOOL and not about a CALL. The panel once NAMED the sequence in the
 * rebuild button's title, and since a person pressing a deterministic rebuild deserves to
 * be told where judgement lives, that wording was honest —and the check went red on it.
 * A check that fails on the honest version of the thing it asks for is measuring the
 * wording, not the property. The wording has since been changed (it now says the Agent
 * does it through a tool, without naming one), and check 150 asserts that wording. This
 * assertion is the part that must survive any further rewording: no tag tool is INVOKED.
 * The two together are the property —nothing runs a judgement here, and the page says
 * where judgement does happen. */
const tagToolCalls = client.match(/\b(memory_lab_tag_review|memory_lab_tag_apply)\s*\(/g) || [];
check(
  'the panel cannot apply tag decisions: judgement belongs to the Agent',
  tagToolCalls.length === 0 && !/['"]memory_lab_tag_(review|apply)['"]/.test(client),
  tagToolCalls.length ? `the client half called ${tagToolCalls.join(', ')}` : 'the client half referenced a tag tool as a call or a tool-name literal',
);

/* ---------------------------------------------------- the delegated gates */

/**
 * How a child gate is judged — and what that judgement can FAIL on.
 *
 * MEASURED DEFECT (2026-10-17, reproduced in this session's baseline): the old form ran each
 * child under `execFileSync` and judged `output.includes('PASS')` — a substring that a
 * per-check line satisfies just as well — while a child that never exited was reported as a
 * FAILURE, with its own PASS line quoted as the reason. `verify-newmark-core-activation.mjs`
 * is exactly that child: it prints `SUMMARY passed=56 failed=0 total=56` and `PASS`, and then
 * never exits, because the mounts it builds leave component timers armed. All 56 of its
 * assertions had passed, and the release gate called it red.
 *
 * The judgement below has three parts, and each one is separately fail-able:
 *
 *   1. the child EXITS: `status === 0` AND its last non-empty lines carry its own verdict
 *      (`PASS …`, or `N passed, M failed` for the one gate that reports that way). A child
 *      that exits 0 WITHOUT a verdict fails — an early return is not a pass.
 *   2. the child RETURNS A NAMED PRECONDITION: exit 2 with a `PREMISE ABSENT:` line is
 *      SKIPPED in the child's own words, counted as `skipped`, never as `passed`. Measured:
 *      `verify-tool-output-boundary.mjs` exits 2 with that line because DSH's own value walker
 *      is not on disk at `<DSH_APP_ROOT>/node_modules/@deepseek-ai/dsh-util-values/lib/index.js`
 *      (the install is a packed `app.asar`), and it cannot measure what it cannot import.
 *   3. the child NEVER RETURNS: reported as its own `timeout` outcome, distinct from a failure.
 *      But if it printed its verdict before it was killed, that verdict STANDS — the pass names
 *      the measured defect instead of pretending the child exited cleanly.
 */
const CHILD_GATE_TIMEOUT_MS = 15 * 60_000;

/** The last non-empty lines a child printed: where its verdict lives. */
function childTail(output) {
  return String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3);
}

/** The verdict the child printed, read as a line of its own and not as a substring anywhere. */
function childVerdict(output) {
  return childTail(output).some((line) => /^PASS\b/.test(line) || /^\d+ passed, \d+ failed$/.test(line));
}

/** The verdict line itself, for a note that quotes the child's own numbers. */
function childVerdictLine(output) {
  return childTail(output).find((line) => /^PASS\b/.test(line) || /^\d+ passed, \d+ failed$/.test(line)) || '';
}

/** The child's own named precondition, when it declared one instead of answering. */
function childPremise(output) {
  return String(output ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('PREMISE ABSENT:'));
}

function runChildGate(target) {
  try {
    const output = execFileSync(process.execPath, [target], { cwd: workspace, encoding: 'utf8', timeout: CHILD_GATE_TIMEOUT_MS });
    const premise = childPremise(output);
    if (premise) return { kind: 'skip', detail: premise };
    if (childVerdict(output)) return { kind: 'pass', detail: '' };
    return { kind: 'fail', detail: `exited 0 without printing a verdict; last output: ${childTail(output).join(' | ')}` };
  } catch (error) {
    const output = `${error?.stdout ?? ''}`;
    /* MEASURED (node v24.13.0, this session, by killing a child that printed PASS and then
     * armed a timer): the throw carries `code: 'ETIMEDOUT'`, `signal: 'SIGTERM'`, `status:
     * null`, and `error.stdout` still holds every line the child printed before the kill. */
    const killedByBudget = error?.code === 'ETIMEDOUT' || (error?.signal != null && error?.status == null);
    const premise = childPremise(output);
    if (premise && error?.status === 2) return { kind: 'skip', detail: premise };
    if (killedByBudget && childVerdict(output)) {
      return {
        kind: 'unreturned',
        detail:
          `the child printed "${childVerdictLine(output)}" and did not exit; killed after ${CHILD_GATE_TIMEOUT_MS} ms — ` +
          'the verdict stands, the hang is named (measured: the activation harness leaves its mounted components\' timers armed)',
      };
    }
    if (killedByBudget) {
      return {
        kind: 'timeout',
        detail: `no verdict within ${CHILD_GATE_TIMEOUT_MS} ms; last output: ${childTail(output).join(' | ') || '(none)'}`,
      };
    }
    return { kind: 'fail', detail: childTail(output).join(' | ') || String(error?.message ?? error) };
  }
}

for (const [label, script] of [
  ['activation harness', 'verify-newmark-core-activation.mjs'],
  ['client harness', 'verify-newmark-core-client.mjs'],
  ['packaging gate', 'verify-newmark-core-package.mjs'],
  /* The numbering is not semver: `0.<sub-components added>.<everything else>`, and neither
   * field carries at ten, so 0.1.9 is followed by 0.1.10. This gate is what makes that a
   * constraint instead of a convention. */
  ['version discipline', 'verify-version-discipline.mjs'],
  ['memorylab tools', 'verify-memorylab-tools.mjs'],
  /* The agent-api component carries the bundle's own agent-run contract —the envelope, the
   * error classification, the four tools —and its gate drives the REAL loop and the REAL seam
   * with a fake `llm` service, so a cap, a refusal or a classification is asserted against the
   * code that runs rather than against a restatement of it. It also owns the step-cap evidence:
   * see its header for why a capless loop used to be an OOM here rather than a red assertion. */
  ['agent-api gate', 'verify-agent-api.mjs'],
  ['provider/model isolation', 'verify-provider-isolation.mjs'],
  ['NewMate chat + proactive messages', 'verify-newmate-chat.mjs'],
  ['NewMate initiative', 'verify-newmate-initiative.mjs'],
  ['companion + restart + visual gate', 'verify-newmate-heartbeat.mjs'],
  ['short memory + native cache + MCP gate', 'verify-short-memory-mcp.mjs'],
  /* NewMate is the one component that drives its own agent loop, and 0.3.21 gave it the
   * ComputerUse tools and made that loop observable while it runs. This gate owns both halves:
   * the allow-list conditions (a user-initiated turn gets the desktop tools, an autonomous
   * check-in does not), the lease owner and the release it must not skip, and the live event
   * channel from agent-api's receipt view out to the page, the state tool and the MCP status. */
  ['NewMate ComputerUse + live loop gate', 'verify-newmate-agent-loop.mjs'],
  /* The three conversation tools are the bundle's only actions on someone else's conversation:
   * creating one costs the user a real model turn, delivering into one wakes it, and reading one
   * touches data that belongs to another session. The gate drives the bridge with recorded fake
   * services, so the refusals (relative/missing workspace, paused target, self target, unknown
   * conversation, over-cap creation) and the bounds (newest-first, dropped counts, text-only
   * extraction) are asserted against the code that runs. */
  ['NewMate conversation tools gate', 'verify-newmate-conversations.mjs'],
  /* The workspace monitor, as the user specified it: a snapshot at start-up and on an interval, a
   * diff of file COUNT / NAMES / NEWEST MTIME, a weighted score that accumulates and fires ONE
   * proactive response, and the knobs in the settings. The gate exercises the pure functions
   * directly (scan, diff, score, settle) and the companion half against a real temp workspace, so
   * "compares against the previous run" is measured rather than asserted in prose. */
  ['NewMate workspace monitor gate', 'verify-newmate-workspace-diff.mjs'],
  /* The two entrances a FILE can use to reach NewMate: the page's byte route and the WeChat
   * ClawBot channel's inbound media. One store, one chat() argument, one reader - and the reader
   * can only see what the store wrote. The gate drives the real channel against a fake media CDN
   * that serves AES-128-ECB ciphertext (so the decrypt is measured, not mocked), drives the real
   * mounted plugin's upload route with real bytes, and holds the properties that must not rot:
   * containment on the resolved path, an excerpt that never pretends to be the whole file, and a
   * failed download that reaches the user as an honest notice instead of silence. */
  ['NewMate attachment gate', 'verify-newmate-attachment.mjs'],
  /* EVERY TOOL THIS BUNDLE REGISTERS, against the boundary that has silently discarded two of its
   * real runs. `memory_lab_reindex` (0.2.2) and `agent_api_send` (0.2.8) both DID their work and
   * were then reported to their caller as failures, because DSH rejects a tool value that is not
   * lossless JSON (`dsh-util-values/lib/index.js:46-153`, `:109`) and the caller's obvious
   * response to "it failed" is to run it again.
   *
   * Both were found by a user hitting them, for one structural reason: `verify-agent-api-live.mjs`
   * used to call the component's tool `execute` DIRECTLY, so the registry's boundary was never
   * applied to those values. That gate's rounds 2 and 3 now dispatch through `ctx.tools.execute`,
   * and THIS gate holds the line for all fifteen tools: it dispatches every one of them through
   * the real `ToolRuntime` — never through a definition's `execute` — and names the PATH of any
   * value DSH's own walker rejects (`$.result.events[2].turn`, not "value is not lossless JSON").
   * It spends no model tokens and touches no desktop. `screen_capture` is the one tool it does not
   * dispatch, and it FAILS if the gate that does cover it stops doing so. */
  ['tool output boundary', 'verify-tool-output-boundary.mjs'],
  ['compose + switches', 'probe-compose.mjs'],
  /* The panel is the bundle's own page, and half of it rests on facts about the installed
   * shell that no plugin API can express. Its gate reads the shell at its install path on
   * purpose, and fails loudly, naming the premise, when a DSH release changes one. */
  ['config panel', 'verify-config-panel.mjs'],
  /* The panel gate reads the source; this one RUNS it. The client half is loaded into a VM with
   * a minimal React and browser, `apply(ctx)` is driven with a stub context so the panel is
   * registered the way the shell registers it, and both mounts are rendered — the plugin seat
   * and the NewMate settings view. That is what proves the two pages hold one catalogue, which
   * no source grep can: a page that grew its own markup back would still match every string. */
  ['config format', 'verify-config-format.mjs'],
  /* The preset switch that wrote the `agent-preset-registry` entry's `selectedDefault` in the
   * profile patch is GONE — the user removed it rather than repaired it, because the default
   * preset belongs to the patch layers and not to a plugin's config page. Its gate now guards
   * what remains: the two declarations the profile layer and the bundle each state must say
   * the same thing, and the write path must stay absent. The three dead mechanisms are
   * recorded in that gate's header: a `disabled` written inside the row's config, an
   * id-targeted `disabled` on the declaring row, and a client sending `presetDev` while the
   * route compared `preset-dev`. */
  ['preset patch', 'verify-preset-patch.mjs'],
  /* 所有失败行为都要在.Newmark保存报错打印 — every failure written to `<root>/errors.jsonl` AND
   * printed. Its gate drives the FAILING paths, which no other gate here does: an edit that
   * throws, a read-back that disagrees, a refused preset write, a component that cannot be
   * imported, a backend that answers an error. It also asserts the other direction — a model
   * write that took, a backend call that succeeded, and the judgement statuses `judged` and
   * `none` write nothing — because a log that records the steady state is a log nobody reads. */
  ['failure log', 'verify-failure-log.mjs'],
  ['store gate', 'verify-memorylab-store.mjs'],
  ['win32 gate', 'verify-computeruse-win32.mjs'],
  /* The sweep gate is the only one here that measures an OPERATING-SYSTEM property rather than
   * this bundle's own behaviour: a WinForms probe registers for raw mouse input (RIDEV_INPUTSINK)
   * and counts WM_INPUT packets, so "a drag moves the pointer but tells a raw-input consumer
   * nothing, and a sweep tells it exactly dx,dy" is a measurement of the delivery path, not a
   * restatement of the plan. It is also the gate that produced the evidence behind the
   * hidden-desktop refusal (sweep_unsupported_on_hidden_desktop): a live probe on that desktop
   * received 0 raw packets from an injection the agent reported as complete, and check 7 now
   * holds that refusal in place, so a future build that routes pointer motion to a hidden
   * desktop turns it red instead of shipping silence. Windows only: it exits 2 with a named
   * premise on any other platform, which this chain counts as skipped, never as passed. */
  ['cu sweep gate', 'verify-cu-sweep.mjs'],
]) {
  const target = path.join(workspace, 'scripts', script);
  if (!fs.existsSync(target)) {
    skip(label, `${script} is not present`);
    continue;
  }
  const outcome = runChildGate(target);
  if (outcome.kind === 'skip') skip(label, outcome.detail);
  else if (outcome.kind === 'timeout') timeout(`${label} timed out`, outcome.detail);
  /* The child proved its verdict and then never returned. That verdict stands, and the pass
   * says so in the child's own numbers rather than pretending it exited cleanly. */
  else if (outcome.kind === 'unreturned') notePass(`${label} passes`, outcome.detail);
  else check(`${label} passes`, outcome.kind === 'pass', outcome.detail);
}

/* ------------------------------------------------------------------ report */

const total = passed + failed + skipped + timedOut;
console.log('');
/* `skipped` and `timedOut` are in the summary on purpose: a skip is not a pass (nothing was
 * measured) and a timeout is not a failure (nothing answered), and a reader who cannot tell
 * them apart from the one line would have to re-run the gate to find out which happened. */
console.log(`SUMMARY passed=${passed} failed=${failed} timedOut=${timedOut} skipped=${skipped} total=${total}`);
if (failed > 0 || timedOut > 0) {
  if (failed > 0) console.log(`FAILED: ${failures.join('; ')}`);
  if (timedOut > 0) console.log(`TIMED OUT: ${timeouts.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
