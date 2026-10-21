/**
 * Newmark Core — the client-half harness.
 *
 * The static gate reads `client.js`; the activation harness runs the Host half.
 * This one **runs the renderer**: it stubs the browser module loader, supplies a
 * small hook shim that behaves like the server renderer, and then calls the
 * plugin's own components, walking the element tree they return.
 *
 * `react-dom` is not installed anywhere on this machine, so a real DOM render is
 * impossible and a screenshot of a mock page would prove nothing (the plugin
 * rules forbid claiming one). What this does instead is execute the real code:
 * the graph builder, the tag derivation, the panel shell, the detail columns, the
 * two MemoryLab seats and the bundle's own config panel all run, against the **live**
 * store snapshot produced by the Host half's own injection.
 *
 * Run: node Newmark2DSH/scripts/verify-newmark-core-client.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountCore } from './lib/mount-newmark-core.mjs';
import { mountSyntheticStore, renderDetailColumns } from './lib/detail-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const clientHalf = path.join(workspace, 'packages', 'newmark-core', 'client.js');
const packagesDir = path.join(workspace, 'packages');

const LIVE_ROOT = path.join(os.homedir(), '.Newmark');
const LIVE_INDEX = path.join(LIVE_ROOT, 'Memory Lab', 'index.json');
// Render a copy of the live graph. Persisted companion settings must never
// start native lifecycle effects or write diagnostics in the user's runtime.
const HOST_FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-client-live-snapshot-'));
fs.mkdirSync(path.join(HOST_FIXTURE, 'Memory Lab'));
if (fs.existsSync(LIVE_INDEX)) fs.copyFileSync(LIVE_INDEX, path.join(HOST_FIXTURE, 'Memory Lab', 'index.json'));
const LIVE_COMPONENTS=path.join(LIVE_ROOT,'Memory Lab','components');
if(fs.existsSync(LIVE_COMPONENTS))fs.cpSync(LIVE_COMPONENTS,path.join(HOST_FIXTURE,'Memory Lab','components'),{recursive:true});

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

let loaderLoads = 0;

/**
 * How many times the panel asked the page to reload itself.
 *
 * `location.reload` is stubbed and counted: the whole point of the MemoryLab-only
 * refresh is that pressing its buttons must never reload the shell, and a count is
 * the only way to observe an absence of a page load from inside the page.
 */
let reloads = 0;

/** Every request the client half made, so a check can name the read it used. */
let requests = [];

/**
 * Load the client module with the page globals a mount produced.
 *
 * @param globals — the per-row globals from `mountCore(...).globals()`.
 * @param options.fetch — what the page's `fetch` answers; a request is recorded
 *   whether or not a handler is given, so an unexpected request is visible.
 */
async function loadClient(globals, options = {}) {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: { load(spec) { captured = spec; } },
    ...globals,
    location: { href: 'http://harness/', pathname: '/', reload() { reloads += 1; } },
  };
  globalThis.fetch = (url, init) => {
    requests.push({ url: String(url), method: (init && init.method) || 'GET' });
    if (typeof options.fetch === 'function') return options.fetch(String(url), init || {});
    return Promise.reject(new Error(`the harness stubbed no fetch, and the client asked for ${url}`));
  };
  const url = new URL('file:///' + clientHalf.replace(/\\/g, '/'));
  url.searchParams.set('harness', String(loaderLoads += 1));
  await import(url.href);
  return captured;
}

/** A `Response`-shaped answer for the client's own `fetch` calls. */
function jsonAnswer(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

/** A served-page answer: the shell's index document with the three injections. */
function htmlAnswer(html, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(html),
    json: () => Promise.reject(new Error('not json')),
  });
}

/**
 * A hook shim with per-component persistent state, so a component can be called
 * repeatedly and its setters actually change what the next call returns.
 */
function createHooks() {
  const stores = new Map();
  let component = null;
  let cursor = 0;
  let setters = [];

  function slot(init) {
    const list = stores.get(component) ?? [];
    const index = cursor++;
    if (!(index in list)) list[index] = typeof init === 'function' ? init() : init;
    stores.set(component, list);
    return { list, index };
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) };
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const { list, index } = slot(initial);
      const set = (next) => { list[index] = typeof next === 'function' ? next(list[index]) : next; };
      setters[index] = set;
      return [list[index], set];
    },
    useRef(initial) {
      const { list, index } = slot({ current: initial });
      return list[index];
    },
    useMemo(factory, deps) {
      const { list, index } = slot({ deps: undefined, value: undefined });
      const entry = list[index];
      const same = entry.deps && deps && entry.deps.length === deps.length && entry.deps.every((d, i) => d === deps[i]);
      if (!same) {
        entry.value = factory();
        entry.deps = deps;
      }
      return entry.value;
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot, getServerSnapshot) {
      return (getServerSnapshot || getSnapshot)();
    },
  };

  /** Call a component with persistent hook state, returning its element tree. */
  function render(Component, props) {
    component = Component;
    cursor = 0;
    setters = [];
    return Component(props || {});
  }

  /** The setters the last render received, in hook order. */
  function lastSetters() {
    return setters;
  }

  return { React, render, lastSetters };
}

/** Flatten an element tree into its text. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object' && 'children' in node) {
    const own = typeof node.props?.children === 'string' ? node.props.children : '';
    return `${own} ${textOf(node.children)}`.trim();
  }
  return '';
}

/** Every element in the tree matching a predicate. */
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if ('type' in node) {
    if (predicate(node)) out.push(node);
    findAll(node.children, predicate, out);
  }
  return out;
}

/**
 * Expand every function component into the tree it returns.
 *
 * React does this during a render; the harness has to do it explicitly, otherwise
 * a component node is just an opaque function and nothing inside it is reachable.
 */
function expand(node, hooks) {
  if (node === null || node === undefined || node === false || node === true) return node;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, hooks));
  if (typeof node !== 'object' || !('type' in node)) return node;
  if (typeof node.type === 'function') return expand(hooks.render(node.type, node.props), hooks);
  return { type: node.type, props: node.props, children: expand(node.children, hooks) };
}

const liveBefore = fs.existsSync(LIVE_INDEX) ? fs.statSync(LIVE_INDEX).mtimeMs : 0;

try {
  /* ------------------------------------------- the Host half's real snapshot */

  const both = await mountCore({ packagesDir, root: HOST_FIXTURE });
  const injected = both.payload();
  check('the Host half produced a snapshot for the client to consume', injected?.ok === true);
  check('the payload came from the core row with both components mounted', injected?.components?.memoryLab === true && injected?.components?.computerUse === true);

  const liveTags = Object.keys(injected.index?.tags || {}).length;
  const liveComponents = Array.isArray(injected.index?.components) ? injected.index.components.length : 0;
  check('the snapshot carries the live store', liveTags > 0 && liveComponents > 0, `tags ${liveTags}, components ${liveComponents}`);

  /* --------------------------------------------------- loading the client half */

  const spec = await loadClient(both.windowGlobals());
  check('the client module registers under the plugin id', spec?.id === 'newmark2dsh', `id: ${spec?.id}`);
  check('the client module exposes a factory', typeof spec?.factory === 'function');

  const hooks = createHooks();
  const plugin = spec.factory((name) => {
    if (name === 'react') return hooks.React;
    throw new Error(`the client half must not require "${name}"`);
  });
  check('the factory returns an injectable plugin', Array.isArray(plugin.inject) && plugin.inject.includes('slots'));

  /* --------------------------------------------------------- the seats register */

  const seats = [];
  const slots = {
    inject(key, callback) { seats.push({ key, entry: callback() }); return () => {}; },
    register(options, Component) { return { options, Component }; },
  };
  plugin.apply({ effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; }, slots });

  check(
    'the client registers five seats: MemoryLab, NewMate and the bundle config panel',
    seats.length === 5 &&
      seats.some((s) => s.key === 'sidebar.panellist' && s.entry.options.id === 'newmate' && s.entry.options.order === 21) &&
      seats.some((s) => s.key === 'main' && s.entry.options.key === 'newmate') &&
      seats.some((s) => s.key === 'sidebar.panellist' && s.entry.options.id === 'memory-lab') &&
      seats.some((s) => s.key === 'main' && s.entry.options.key === 'memory-lab') &&
      seats.some((s) => s.key === 'plugins.bundle.config' && s.entry.options.key === 'newmark2dsh'),
    `registered: ${seats.map((s) => `${s.key}:${s.entry.options.id ?? s.entry.options.key}`).join(', ')}`,
  );
  check(
    'MemoryLab owns the sidebar entry under the id memory-lab',
    seats.some((s) => s.key === 'sidebar.panellist' && s.entry.options.id === 'memory-lab'),
  );
  check('MemoryLab owns the matching main-panel key', seats.some((s) => s.key === 'main' && s.entry.options.key === 'memory-lab'));
  check(
    'ComputerUse owns no seat of its own',
    !seats.some((s) => String(s.entry.options.id || s.entry.options.key || '').includes('computer')),
    `seats: ${seats.map((s) => `${s.key}:${s.entry.options.id ?? s.entry.options.key}`).join(', ')}`,
  );

  const panelSeat = seats.find((s) => s.key === 'main').entry;
  const overlaySeat = seats.find((s) => s.key === 'main').entry;
  const iconSeat = seats.find((s) => s.key === 'sidebar.panellist').entry;

  /* ------------------------------------------------------ the config panel renders --- */

  /* The bundle's own page: the four components by product name, each with the switch it
   * has, rendered from the same page globals the panel above reads. It is the seat that
   * replaces the Loader rows the card used to draw — a row id and a module path. */
  const configSeat = seats.find((s) => s.key === 'plugins.bundle.config').entry;
  const configElement = hooks.render(configSeat.Component, {});
  const configSetters = hooks.lastSetters();
  const configTree = expand(configElement, hooks);
  const configText = textOf(configTree);
  configSetters[1]({ memoryLab: { ok: true, mounted: false }, computerUse: { ok: true, mounted: false }, agentApi: { ok: true, mounted: false }, newMate:{ok:true,mounted:false}, heartBeat:{ok:true,mounted:false} });
  configSetters[3](true);
  const disabledConfig = expand(hooks.render(configSeat.Component, {}), hooks);
  const disabledRows = findAll(disabledConfig, (n) => n.props?.className === 'nmc-config-row');
  check('host mount receipts keep disabled component notes consistent with their states',
    disabledRows.slice(1).every((row) => textOf(row).includes('已禁用') && textOf(row).includes('not loaded')),
    disabledRows.map(textOf).join(' | '));
  configSetters[1]({ memoryLab: { ok: true, mounted: true }, computerUse: { ok: true, mounted: true }, agentApi: { ok: true, mounted: true }, newMate:{ok:true,mounted:true}, heartBeat:{ok:true,mounted:true} });
  const enabledConfig = expand(hooks.render(configSeat.Component, {}), hooks);
  check('host mount receipts report every enabled interface without stale not-loaded notes',
    findAll(enabledConfig, (n) => n.props?.className === 'nmc-config-row').slice(1).every((row) => textOf(row).includes('已启用') && !textOf(row).includes('not loaded')),
    textOf(enabledConfig));
  configSetters[1]({});
  configSetters[3](null);
  const agentApiRow = findAll(configTree, (n) => (n.props?.className || '') === 'nmc-config-row')
    .find((row) => findAll(row, (n) => (n.props?.className || '') === 'nmc-config-name').some((n) => textOf(n) === 'Agent API'));
  check('the mounted Agent API row reports interface mounted from its page snapshot',
    textOf(agentApiRow).includes('interface mounted') && !textOf(agentApiRow).includes('not loaded'),
    textOf(agentApiRow));
  check(
    'the config panel names the components rather than module paths',
    ['Newmark Core', 'MemoryLab', 'ComputerUse', 'Agent API'].every((label) => configText.includes(label)) &&
      !configText.includes('file:///'),
    configText.slice(0, 240),
  );
  /* The panel used to carry a fifth row for the Dev preset, which wrote the profile patch.
   * The user removed it — 去除插件配置中的预设dev preset插件开关行 — so the count and the labels
   * here are asserted as they now are, and the absence of that row is asserted too: a row
   * that survives without its route is the defect this whole area already produced once. */
  check(
    'the panel carries no preset row, because the config page no longer controls the default preset',
    !configText.includes('Dev preset') && !configText.includes('rDev'),
    configText.slice(0, 240),
  );
  const configRows = findAll(configTree, (n) => (n.props?.className || '').includes('nmc-config-row')).map((row) => {
    const label = findAll(row, (n) => (n.props?.className || '') === 'nmc-config-name')[0];
    return {
      name: label ? textOf(label) : '',
      switchable: findAll(row, (n) => (n.props?.className || '').includes('nmc-config-switch')).length === 1,
    };
  });
  check(
    'the panel lists the four components and switches the three that can be switched',
    configRows.length === 6 &&
      ['Newmark Core', 'MemoryLab', 'ComputerUse', 'Agent API', 'NewMate', 'heartBeat'].every((name) => configRows.some((row) => row.name === name)) &&
      configRows.filter((row) => row.switchable).length === 5 &&
      configRows.find((row) => row.name === 'Newmark Core')?.switchable === false,
    configRows.map((row) => `${row.name}:${row.switchable ? 'switch' : 'no switch'}`).join(', '),
  );
  check(
    'the panel carries its own stylesheet, which is where the rows rule is scoped from',
    findAll(configTree, (n) => n.type === 'style').length === 1,
  );

  /* ------------------------------------------------------------ the icon renders */

  const iconTree = hooks.render(iconSeat.Component, { size: 16, active: false });
  const iconPaths = findAll(iconTree, (n) => n.type === 'path');
  check('the sidebar icon renders the eight Lucide brain paths', iconPaths.length === 8, `paths: ${iconPaths.length}`);
  check('the sidebar icon is drawn at the Lucide 2-unit stroke', iconTree.props.strokeWidth === 2);

  /* ----------------------------------------------------------- the panel renders */

  const panel = hooks.render(panelSeat.Component, {});
  // Capture the panel's own setters before any other component render overwrites
  // the hook cursor. Order in MemoryLabPanel: the store hook, then view, then selection.
  const panelSetters = hooks.lastSetters();
  const panelTree = expand(panel, hooks);
  const panelText = textOf(panelTree);
  check('the panel renders overview, detail and short memory tabs', panelText.includes('总览') && panelText.includes('详细') && panelText.includes('短期'));
  const shortTab=findAll(panelTree,n=>n.type==='button'&&textOf(n)==='短期')[0];
  shortTab.props.onClick();
  const shortElement=findAll(hooks.render(panelSeat.Component,{}),n=>typeof n.type==='function'&&n.type.name==='ShortMemoryView')[0];
  hooks.render(shortElement.type,{});hooks.lastSetters()[0]({loading:false,error:'',path:'fixture/short-memory.json',items:[{seq:1,createdAt:'2026-01-01T00:00:00Z',expiresAt:'2026-01-08T00:00:00Z',content:'旧记忆'},{seq:2,createdAt:'2026-01-01T00:00:00Z',expiresAt:'2099-01-08T00:00:00Z',content:'当前记忆'}]});
  const shortTree=hooks.render(shortElement.type,{}),shortRows=findAll(shortTree,n=>n.type==='li');
  check('short memory renders all entries with sequence and timestamps',shortRows.length===2&&textOf(shortTree).includes('#1')&&textOf(shortTree).includes('旧记忆')&&textOf(shortTree).includes('当前记忆'));
  check('expired short memory is visibly gray and retained',shortRows[0].props['data-expired']===true&&shortRows[0].props.style.opacity===0.55&&shortRows[0].props.style.color==='var(--dsw-alias-label-tertiary)'&&shortRows[1].props.style.opacity===1);
  findAll(hooks.render(panelSeat.Component,{}),n=>n.type==='button'&&textOf(n)==='总览')[0].props.onClick();
  check('the panel renders the reindex control', panelText.includes('重建索引'));
  check('the panel renders a search field', findAll(panelTree, (n) => n.type === 'input').length > 0);
  check(
    'the panel reports the LIVE tag and component counts',
    panelText.includes(`${liveTags} 标签`) && panelText.includes(`${liveComponents} 组件`),
    panelText.slice(0, 200),
  );
  check('the panel does not print the local store path', !panelText.includes(LIVE_ROOT) && !panelText.includes('index.json'));

  /* ------------------------------------------------- one 重置, and what it means */

  /* Two buttons once carried the word 重置: this one, which re-reads the store, and
   * the overview camera reset, which reset the graph's view. The camera is a real
   * affordance, so it keeps a button where the view is — under a name that says what
   * it does — and 重置 means exactly one thing now. */
  const topbarButtons = findAll(panelTree, (n) => n.type === 'button' && (n.props?.className || '') === 'ml-btn').map((n) => textOf(n));
  check(
    'the panel carries exactly one button labelled 重置',
    topbarButtons.filter((label) => label === '重置').length === 1,
    topbarButtons.join(' | '),
  );
  const topbar = findAll(panelTree, (n) => (n.props?.className || '') === 'ml-topbar')[0];
  const topbarLabels = topbar ? findAll(topbar, (n) => n.type === 'button' && (n.props?.className || '') === 'ml-btn').map((n) => textOf(n)) : [];
  check(
    'the topbar store actions are 重置 and 重建索引, in that order and nothing else',
    topbarLabels.join(' | ') === '重置 | 重建索引',
    topbarLabels.join(' | '),
  );
  const viewActions = findAll(panelTree, (n) => (n.props?.className || '') === 'ml-oactions')[0];
  /**
   * The subject is the two CAMERA controls, so the search is by the class they carry (`ml-btn`)
   * rather than by every button in the container. The container gained a third button at 0.2.18 —
   * the focus-mode menu's own trigger, which `ml-menubtn` styles — and a check phrased as "every
   * button here" would have failed for a reason that has nothing to do with the camera.
   */
  const viewLabels = viewActions
    ? findAll(viewActions, (n) => n.type === 'button' && String(n.props?.className || '').split(/\s+/).includes('ml-btn')).map((n) => textOf(n))
    : [];
  check(
    'the camera affordance survives where the view is, under its own name 视图归位',
    viewLabels.join(' | ') === '取消 | 视图归位',
    viewLabels.join(' | '),
  );
  check(
    'no button promises a page refresh any more',
    !findAll(panelTree, (n) => n.type === 'button').some((n) => textOf(n).includes('刷新页面')),
  );

  /* --------------------------------------------------- the judgement half --- */

  /* The Agent half of a rebuild is a component of its own, and a component switched off
   * is genuinely unloaded. The panel reads that state from the same snapshot it draws
   * everything else from, so "there is no judge" is visible instead of silent — and a
   * reachable judge adds no warning at all.
   *
   * BOTH STATES ARE DRIVEN, and this is a correction rather than a rewording. These two checks
   * used to read the LIVE mount for the off-state, and they passed — because the harness's tools
   * registry had `register` and no `get`, which is the one method `agentApiPresence` asks. Every
   * mount therefore answered "no agent_api_send is registered", agent-api live or not: the pair
   * of checks could not tell the two states apart, and the "unavailable" one was reading the
   * harness. The registry now answers `get` as the real one does, the live mount honestly reports
   * `available`, and the off-state is driven the only way it can be — a snapshot from a mount
   * where the tool really is not there. */
  check(
    'the live mount reports a reachable judge, so the registry question is answerable at all',
    injected.judge?.status === 'available' && injected.judge?.judged === false,
    JSON.stringify(injected.judge ?? null).slice(0, 240),
  );

  const judgeHooks = createHooks();
  const judgeSeats = [];
  const judgeSpec = await loadClient({
    ...both.windowGlobals(),
    __NEWMARK_MEMORYLAB__: { ...injected, judge: { interface: 'agent-api', status: 'available', reason: '', judged: false, workspace: 'X' } },
  });
  judgeSpec
    .factory((name) => {
      if (name === 'react') return judgeHooks.React;
      throw new Error(`unexpected require "${name}"`);
    })
    .apply({
      effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
      slots: { inject(key, cb) { judgeSeats.push({ key, entry: cb() }); return () => {}; }, register: (o, C) => ({ options: o, Component: C }) },
    });
  const judgePanelText = textOf(expand(judgeHooks.render(judgeSeats.find((s) => s.key === 'main').entry.Component, {}), judgeHooks));
  check(
    'a reachable judge adds no warning to the same panel',
    !judgePanelText.includes('判定不可用') && judgePanelText.includes(`${liveTags} 标签`),
    judgePanelText.slice(0, 200),
  );

  /* The other state, driven by a snapshot whose judge really is absent — the same payload the
   * live mount serves, with the judgement half reported off, which is exactly what the Host
   * produces when `agent_api_send` is not registered. */
  const offHooks = createHooks();
  const offSeats = [];
  const offSpec = await loadClient({
    ...both.windowGlobals(),
    __NEWMARK_MEMORYLAB__: {
      ...injected,
      judge: { interface: 'agent-api', status: 'unavailable', reason: 'agent_api_send is not registered: the component is switched off', judged: false, workspace: 'X' },
    },
  });
  offSpec
    .factory((name) => {
      if (name === 'react') return offHooks.React;
      throw new Error(`unexpected require "${name}"`);
    })
    .apply({
      effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
      slots: { inject(key, cb) { offSeats.push({ key, entry: cb() }); return () => {}; }, register: (o, C) => ({ options: o, Component: C }) },
    });
  const offTree = expand(offHooks.render(offSeats.find((s) => s.key === 'main').entry.Component, {}), offHooks);
  const offText = textOf(offTree);
  const statusOf = (tree) => findAll(tree, (n) => (n.props?.className || '') === 'ml-status')[0];
  const statusTextOf = (tree) => {
    const element = statusOf(tree);
    return element ? textOf(element) : '';
  };
  check(
    'a panel whose judge is off still renders the store, and carries no judgement clause: nothing ran',
    // `judge` is REACHABILITY (a fact about the store's surroundings) and it no longer has a
    // surface of its own — the panel reports what the last action DID, which is `judgement`, and a
    // page that has not asked for a rebuild has no outcome to report. Asserted on the status
    // element itself, not on the page's whole text: the button's title legitimately spells out
    // what the button runs, and a page-wide text match would confuse the two.
    offText.includes(`${liveTags} 标签`) &&
      statusOf(offTree)?.props?.['data-ml-judgement'] === '' &&
      !statusTextOf(offTree).includes('判定'),
    JSON.stringify({ status: statusOf(offTree)?.props?.['data-ml-judgement'], statusText: statusTextOf(offTree) }),
  );
  check(
    'and the page carries no prompt and no control that offers one',
    // The prompt strip is gone, and this is the assertion that keeps it gone: the judgement is
    // something the button RUNS, so text to copy is a surface nobody asked for and nothing may
    // reintroduce it quietly. It is asserted on the tree — classes, then labels — rather than on
    // the rendered words, so a strip that carried no text would still fail here.
    findAll(offTree, (n) => String(n.props?.className || '').startsWith('ml-prompt')).length === 0 &&
      !findAll(offTree, (n) => n.type === 'button').some((n) => /提示词|复制/.test(textOf(n))) &&
      !findAll(offTree, (n) => n.type === 'textarea' || n.type === 'pre').some((n) => /memory_lab_tag_/.test(textOf(n))),
    offText.slice(0, 240),
  );

  /* ------------------------------------------------- the button, and what it says --- */

  /* 重建索引 is ONE action in TWO HALVES, and the button is where a person is told that. The
   * wording is asserted rather than assumed because the previous wording said the opposite — that
   * the button rebuilds deterministically and judging is somebody else's job — and a stale title
   * is how the next reader learns the wrong design. */
  const reindexButton = findAll(panelTree, (n) => n.type === 'button' && textOf(n) === '重建索引')[0];
  const reindexTitle = String(reindexButton?.props?.title || '');
  /* The title has to SAY both halves, in order, and it has to not say the retired thing. The first
   * version of this check asserted four substrings that a reverted title happened to keep — the
   * mutation that put "确定性重建：只做确定性重建，不做判定。" back at the front left it green. So the
   * check now anchors on the sentence that only the new wording has (the two numbered halves) and
   * forbids the claim that the button judges nothing. */
  /* The tooltip names the ACTION and nothing else.
   *
   * It used to be a paragraph: the two numbered halves, the three judgement classes spelled out
   * in the prompt's own words, how long a run takes, and that the halves do not impersonate each
   * other. The user's instruction was 不要在按钮浮窗tip写内置prompt — and they are right for a
   * second reason on top of the first: a tooltip that paraphrases the prompt drifts from the
   * prompt it paraphrases, and this one already had. The ask belongs to whoever receives it.
   *
   * The check that guarded it pinned that paragraph word for word, so it went red when the
   * paragraph was shortened — a check whose subject was the wording rather than the property.
   * These are the properties: both halves are named in the order they run, the retired claim is
   * gone, the prompt is NOT here, and it stays a tooltip. */
  check(
    'the button names both halves, in the order they run',
    /确定性重建/.test(reindexTitle) &&
      reindexTitle.indexOf('确定性重建') < reindexTitle.search(/Agent|判定/),
    reindexTitle,
  );
  check(
    'the button says the Agent judges, rather than saying the button judges nothing',
    /Agent|判定/.test(reindexTitle) && !/只做确定性重建|不做判定/.test(reindexTitle),
    reindexTitle,
  );
  /* The user's rule, held where it can fail: the judgement classes are the prompt's content, and
   * a hover tooltip is not where a prompt lives. Any of these appearing here means the ask has
   * leaked back out of the place it is sent from. */
  const promptLeak = ['假根父节点', '同义近义', '未被正确解析', 'tag 合并', 'reparent', 'synonym', 'memory_lab_tag', 'evidence'].filter(
    (token) => reindexTitle.includes(token),
  );
  check(
    'the button tooltip does not carry the judgement prompt',
    promptLeak.length === 0,
    promptLeak.length ? `the prompt leaked into the tooltip: ${promptLeak.join(', ')}` : 'no prompt content in the tooltip',
  );
  check(
    'the tooltip stays a tooltip rather than becoming a paragraph',
    reindexTitle.length > 0 && reindexTitle.length <= 60,
    `${reindexTitle.length} chars: ${reindexTitle}`,
  );
  check(
    'and the title names no tag tool, because this half cannot call one',
    !/memory_lab_tag/.test(reindexTitle) && !/memory_lab_tag/.test(panelText),
    reindexTitle.slice(0, 120),
  );

  /* ------------------------------------------- the MemoryLab-only refresh path */

  /* What the Host's snapshot route answers, with a marker the page globals do NOT
   * carry: a panel that re-rendered from the snapshot it already had cannot show it,
   * and neither can one that reloaded the page instead of asking for a read.
   *
   * `judgement` is the second half of the same answer, and it is driven from here so the panel's
   * rendering of it can be measured rather than assumed: the two fixtures below are the SAME
   * route answering two different outcomes, which is what makes "the page prints the Host's clause
   * and does not compose one" a check that can fail. */
  const ROUTE_MARKER = 'route-marker-7f21c9';
  const JUDGED_CLAUSE = '已运行：2 轮模型、3 次工具调用，用时 1234 ms';
  const TIMEOUT_CLAUSE = '超时未完成：300000 ms 内没有返回，运行已中止，判定没有产生';
  let routeJudgement = {
    interface: 'agent-api',
    tool: 'agent_api_send',
    status: 'judged',
    attempted: true,
    label: JUDGED_CLAUSE,
    exit: 0,
    turns: 2,
    toolCalls: 3,
  };
  const routePayload = (rebuild) => ({
    ok: true,
    generatedAt: '2030-01-01T00:00:00.000Z',
    root: injected.root,
    reindexError: '',
    relationshipVersion: ROUTE_MARKER,
    loadedAt: Date.now(),
    index: injected.index,
    contents: injected.contents,
    source: 'route',
    rebuild,
    result: rebuild ? { relationshipVersion: ROUTE_MARKER, components: liveComponents, tags: liveTags, warnings: [] } : null,
    judgement: rebuild ? routeJudgement : null,
  });

  let routeRebuildAsks = 0;
  const refreshHooks = createHooks();
  const refreshSeats = [];
  const refreshSpec = await loadClient(both.windowGlobals(), {
    fetch: (url) => {
      if (url.startsWith('/newmark-memorylab/snapshot')) {
        if (url.includes('reindex=1')) routeRebuildAsks += 1;
        return jsonAnswer(routePayload(url.includes('reindex=1')));
      }
      return htmlAnswer('<html><head></head><body></body></html>');
    },
  });
  refreshSpec
    .factory((name) => {
      if (name === 'react') return refreshHooks.React;
      throw new Error(`unexpected require "${name}"`);
    })
    .apply({
      effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
      slots: { inject(key, cb) { refreshSeats.push({ key, entry: cb() }); return () => {}; }, register: (o, C) => ({ options: o, Component: C }) },
    });
  const refreshPanelSeat = refreshSeats.find((s) => s.key === 'main').entry;

  const requestsBefore = requests.length;
  const reloadsBefore = reloads;
  const firstPanel = expand(refreshHooks.render(refreshPanelSeat.Component, {}), refreshHooks);
  const clickButton = (tree, label) => {
    const button = findAll(tree, (n) => n.type === 'button' && textOf(n) === label)[0];
    if (!button) throw new Error(`no button labelled ${label} in the panel`);
    return button.props.onClick();
  };

  /* IN FLIGHT. The request is not awaited here on purpose: the panel has to show that a judgement
   * is running, and the only moment that state exists is between the click and the answer. It is
   * rendered then and read, rather than inspected in the source. */
  const inflight = clickButton(firstPanel, '重建索引');
  const busyTree = expand(refreshHooks.render(refreshPanelSeat.Component, {}), refreshHooks);
  const busyText = textOf(busyTree);
  check(
    'while the action is in flight the panel says a judgement is running, and the button says both halves',
    busyText.includes('正在重建并运行判定…') &&
      statusOf(busyTree)?.props?.['data-ml-judgement'] === 'running' &&
      findAll(busyTree, (n) => n.type === 'button').map((n) => textOf(n)).includes('重建并判定中…'),
    busyText.slice(0, 220),
  );
  await inflight;
  check('pressing 重建索引 asks the Host half for a rebuild over its own snapshot route', routeRebuildAsks === 1, JSON.stringify(requests.slice(requestsBefore)));
  const afterReindex = expand(refreshHooks.render(refreshPanelSeat.Component, {}), refreshHooks);
  const afterReindexText = textOf(afterReindex);
  check(
    'the panel re-renders from the snapshot the Host returned, not from the one the page loaded with',
    afterReindexText.includes(ROUTE_MARKER.slice(0, 12)),
    afterReindexText.slice(0, 220),
  );
  check(
    'pressing 重建索引 never reloads the shell',
    reloads === reloadsBefore && reloads === 0,
    `reloads: ${reloads}`,
  );
  check(
    'and the outcome the panel prints is the Host half’s own clause, verbatim, under its own status',
    afterReindexText.includes(JUDGED_CLAUSE) &&
      statusOf(afterReindex)?.props?.['data-ml-judgement'] === 'judged' &&
      !afterReindexText.includes('正在重建并运行判定…'),
    JSON.stringify({ status: statusOf(afterReindex)?.props?.['data-ml-judgement'], clause: afterReindexText.includes(JUDGED_CLAUSE) }),
  );

  const requestsAfterReindex = requests.length;
  await clickButton(afterReindex, '重置');
  const resetAsk = requests.slice(requestsAfterReindex);
  check(
    'pressing 重置 re-reads the store through the snapshot route without asking for a rebuild',
    resetAsk.length === 1 && resetAsk[0].url === '/newmark-memorylab/snapshot',
    JSON.stringify(resetAsk),
  );
  check('pressing 重置 never reloads the shell either', reloads === 0, `reloads: ${reloads}`);

  const afterReset = expand(refreshHooks.render(refreshPanelSeat.Component, {}), refreshHooks);
  const afterResetText = textOf(afterReset);
  check('the panel still shows the freshly read snapshot after 重置', afterResetText.includes(ROUTE_MARKER.slice(0, 12)));
  check(
    'and 重置 leaves no judgement clause standing: that read did not run one',
    !afterResetText.includes(JUDGED_CLAUSE) && statusOf(afterReset)?.props?.['data-ml-judgement'] === '',
    afterResetText.slice(-160),
  );

  /* THE OTHER OUTCOME, through the same button and the same route. A second press whose answer
   * reports a timeout must replace the clause rather than sit beside it — a status line that could
   * show two outcomes at once would be the blurring this panel must never do. */
  routeJudgement = { interface: 'agent-api', tool: 'agent_api_send', status: 'timeout', attempted: true, label: TIMEOUT_CLAUSE, exit: null, code: 'timeout' };
  await clickButton(afterReset, '重建索引');
  const afterTimeout = expand(refreshHooks.render(refreshPanelSeat.Component, {}), refreshHooks);
  const afterTimeoutText = textOf(afterTimeout);
  check(
    'a judgement that timed out is reported as a timeout, and it replaces the previous clause',
    afterTimeoutText.includes(TIMEOUT_CLAUSE) &&
      !afterTimeoutText.includes(JUDGED_CLAUSE) &&
      statusOf(afterTimeout)?.props?.['data-ml-judgement'] === 'timeout',
    afterTimeoutText.slice(-200),
  );

  /* The fallback matters because a client bundle can be newer than the Host half it
   * talks to (HMR swaps this half). With the route absent, both actions must still
   * produce a read — the page index re-read — and must still never reload the page. */
  const routeAbsentHooks = createHooks();
  const routeAbsentSeats = [];
  const servedPage = `<html><head><script>window.__NEWMARK_MEMORYLAB__=${JSON.stringify({ ...injected, relationshipVersion: 'page-fallback-51a0' })};</script></head><body></body></html>`;
  const routeAbsentSpec = await loadClient(both.windowGlobals(), {
    fetch: (url) => (url.startsWith('/newmark-memorylab/snapshot') ? jsonAnswer({ ok: false, error: 'not_found' }, 404) : htmlAnswer(servedPage)),
  });
  routeAbsentSpec
    .factory((name) => {
      if (name === 'react') return routeAbsentHooks.React;
      throw new Error(`unexpected require "${name}"`);
    })
    .apply({
      effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
      slots: { inject(key, cb) { routeAbsentSeats.push({ key, entry: cb() }); return () => {}; }, register: (o, C) => ({ options: o, Component: C }) },
    });
  const routeAbsentPanel = expand(routeAbsentHooks.render(routeAbsentSeats.find((s) => s.key === 'main').entry.Component, {}), routeAbsentHooks);
  const reloadsBeforeFallback = reloads;
  await clickButton(routeAbsentPanel, '重建索引');
  const afterFallback = expand(routeAbsentHooks.render(routeAbsentSeats.find((s) => s.key === 'main').entry.Component, {}), routeAbsentHooks);
  const fallbackText = textOf(afterFallback);
  check(
    'with the snapshot route absent the panel falls back to re-reading the served index',
    fallbackText.includes('page-fallback-51a0'.slice(0, 12)) && requests.some((request) => request.url === '/'),
    JSON.stringify(requests.slice(-3)),
  );
  check(
    'and it says out loud that the primary read failed instead of pretending',
    fallbackText.includes('HTTP 404'),
    fallbackText.slice(0, 260),
  );
  check('the fallback never reloads the shell either', reloads === reloadsBeforeFallback, `reloads: ${reloads}`);

  /* -------------------------------------------------------- the overview renders */

  const overview = findAll(panel, (n) => typeof n.type === 'function' && n.type.name === 'OverviewView')[0];
  check('the overview view is the default view', Boolean(overview));
  if (overview) {
    const stage = hooks.render(overview.type, overview.props);
    const stageText = textOf(stage);
    check(
      'the overview toolbar reports the live graph size',
      stageText.includes(`${liveTags} 标签`) && stageText.includes(`${liveComponents} 记忆组件`),
      stageText.slice(0, 200),
    );
    /**
     * THE FOCUS-MODE MENU — a DSH-styled listbox, asserted as a menu rather than as a `<select>`.
     *
     * The old check counted `<option>` children of a `<select>`. That element is gone on purpose
     * (its OPEN list is drawn by the platform, so it opened a light Win32 popup inside a dark themed
     * panel and no CSS could reach it), and a check phrased as "a select with four options" would
     * now be asserting the defect. What is asserted instead: the control is a listbox with the four
     * modes, it says which one is current, its trigger carries the state a menu trigger must carry,
     * and — the compatibility half of the requirement — the stylesheet it ships uses theme tokens
     * WITH fallbacks and cannot collide with another plugin's CSS.
     */
    const menuElement = findAll(stage, (n) => typeof n.type === 'function' && n.type.name === 'ModeMenu')[0];
    check('the focus-mode control is a menu button, not a native select', Boolean(menuElement) && findAll(stage, (n) => n.type === 'select').length === 0);
    const closedMenu = menuElement ? hooks.render(menuElement.type, menuElement.props) : null;
    const menuSetters = hooks.lastSetters();
    const closedTrigger = closedMenu ? findAll(closedMenu, (n) => String(n.props?.className || '').split(/\s+/).includes('ml-menubtn'))[0] : undefined;
    check(
      'its trigger reports the popup contract and starts closed',
      closedTrigger?.props?.['aria-haspopup'] === 'listbox' && closedTrigger?.props?.['aria-expanded'] === 'false',
      JSON.stringify({ haspopup: closedTrigger?.props?.['aria-haspopup'], expanded: closedTrigger?.props?.['aria-expanded'] }),
    );
    check('a closed menu renders no listbox at all', closedMenu ? findAll(closedMenu, (n) => n.props?.role === 'listbox').length === 0 : false);
    check(
      'the trigger names the current mode, so the state is readable without opening it',
      textOf(closedTrigger) === '双向',
      textOf(closedTrigger),
    );

    // Opened through the component's own setter — the same state transition a click causes — so
    // everything below reads the tree the browser would really get.
    const setMenuOpen = menuSetters[0];
    check('the menu exposes an open setter to drive it', typeof setMenuOpen === 'function');
    if (typeof setMenuOpen === 'function') setMenuOpen(true);
    const openedMenu = menuElement ? hooks.render(menuElement.type, menuElement.props) : null;
    const openList = openedMenu ? findAll(openedMenu, (n) => n.props?.role === 'listbox')[0] : undefined;
    const menuOptions = openList ? findAll(openList, (n) => n.props?.role === 'option') : [];
    check('the overview offers all four focus modes', menuOptions.length === 4, `options: ${menuOptions.length}`);
    /**
     * THE ROWS CARRY THE MODE NAME AND NOTHING ELSE — the user's instruction, and the check is
     * inverted from its first form on purpose. That form required every row to carry a `title` of
     * more than four characters, i.e. it asserted the explanation this revision removes; asserting
     * the presence of the thing that was asked to go is how a gate ends up protecting a defect.
     * What is asserted now is the exact row text (label plus the selection mark, which is an
     * element rather than a sentence), and that no row carries a description in either place one
     * could live: a `title` attribute or a second text child.
     */
    check(
      'the four modes are 双向 / 父链 / 子树 / 直接, in that order, with the title alone on each row',
      menuOptions.map((n) => textOf(n).replace('✓', '').trim()).join(' | ') === '双向 | 父链 | 子树 | 直接' &&
        menuOptions.every((n) => n.props?.title === undefined) &&
        menuOptions.every((n) => (n.children ?? []).filter((child) => typeof child === 'string').length === 0),
      menuOptions.map((n) => `${JSON.stringify(textOf(n))}${n.props?.title === undefined ? '' : ` title=${n.props.title}`}`).join(' | '),
    );
    check(
      'exactly the current mode is marked selected, and the marker is a trailing check rather than a second fill',
      menuOptions.filter((n) => n.props?.['aria-selected'] === 'true').length === 1 &&
        textOf(menuOptions[0]).includes('✓') &&
        menuOptions.slice(1).every((n) => !textOf(n).includes('✓')),
      menuOptions.map((n) => `${textOf(n).slice(0, 2)}:${n.props?.['aria-selected']}`).join(', '),
    );
    if (typeof setMenuOpen === 'function') setMenuOpen(false);

    /* The stylesheet is read as TEXT, because the rules ARE the deliverable here. The element
     * carries its CSS as a CHILD, not as a prop, so it is read with `textOf` — reading
     * `props.children` returns '' and would have made both checks below pass on an empty string.
     *
     * COMMENTS ARE STRIPPED FIRST, which is this repository's rule for every prose-versus-code
     * match and it was earned here: the stylesheet's own comment SAYS "no !important", and a naive
     * `includes('!important')` read that sentence as the declaration it forbids. Same failure shape
     * as the preset gates, so the same cure: strip /* … *​/ before matching. */
    const overviewCss = findAll(stage, (n) => n.type === 'style').map((n) => textOf(n)).join('\n');
    const cssCode = overviewCss.replace(/\/\*[\s\S]*?\*\//g, '');
    check('the menu stylesheet was really read, not silently empty', cssCode.includes('.ml-menu'), `${cssCode.length} chars`);
    const menuRules = cssCode.split('\n').filter((line) => line.includes('.ml-menu') || line.includes('.ml-menubtn'));
    check(
      'the menu is drawn with DSH theme tokens, each of the non-guaranteed ones carrying a fallback',
      cssCode.includes('var(--dsw-menu-surface-fill, var(--dsw-alias-bg-overlay))') &&
        cssCode.includes('var(--dsw-elevation-prominent,') &&
        cssCode.includes('var(--dsw-radius-sm,') &&
        cssCode.includes('var(--dsw-alias-interactive-bg-hover,'),
      menuRules.length,
    );
    check(
      'and it cannot collide with another plugin: every menu rule is namespaced, none names a bare element type, none uses !important',
      menuRules.length >= 8 &&
        menuRules.every((line) => line.trim().startsWith('.ml-')) &&
        !menuRules.some((line) => /\b(select|button|div|ul|li|body|:root|\*)\s*[,{]/.test(line)) &&
        !cssCode.includes('!important'),
      menuRules.map((line) => line.trim().slice(0, 40)).join(' / '),
    );
    /**
     * THE CARD IS AS WIDE AS ITS TEXT. DSH's compact list reserves 156px because its rows carry
     * labels, icons AND shortcuts; these four rows are two CJK characters each, so that floor left
     * most of the card empty and the user asked for the text width instead. Asserted as the two
     * declarations that produce it — `width: max-content` and no `min-width` floor — because a
     * future edit that reinstates a minimum would look harmless and bring the empty card back.
     */
    const cardRule = menuRules.find((line) => line.trim().startsWith('.ml-menu {')) ?? '';
    check(
      'the menu card is sized to its text, with no minimum width that would leave it mostly empty',
      cardRule.includes('width: max-content') && !/(^|[;\s])min-width\s*:/.test(cardRule),
      cardRule.trim().slice(0, 160),
    );
    check(
      'the removed rule is really gone: nothing styles a bare element under the action row any more',
      !overviewCss.includes('.ml-oactions select') && !overviewCss.includes('.ml-oactions button'),
    );
    check('the overview renders the autoplay-free stroke-free stage', findAll(stage, (n) => (n.props?.className || '').includes('ml-stage')).length > 0);
    check('the overview carries its own stylesheet', findAll(stage, (n) => n.type === 'style').length > 0);

    /**
     * THE WHOLE CLIENT HALF'S OVERRIDE CONTRACT, not just the new menu's rules.
     *
     * "Compatible with the style overrides other plugins make" is a property of every stylesheet
     * this package ships, so it is checked over all of them: no `!important` anywhere (an override
     * must still win by ordinary cascade order), no selector that begins with a bare element type
     * (another plugin's `button` or `ul` must not match our rules), and every selector namespaced
     * under a prefix this package owns — `ml-` for the MemoryLab panel, `nmc-` for the config card.
     *
     * ONE DECLARED EXCEPTION lives in the CONFIG CARD's stylesheet (`[data-plugin-rows]`, an
     * attribute selector the shell's own row section forces), and it is asserted by
     * `verify-config-panel.mjs` — the gate that renders that card — rather than here, so each gate
     * audits the stylesheets it actually mounts. This tree therefore allows NO exception.
     *
     * Comments are stripped first: the stylesheet's own comment says "no !important", and reading
     * that sentence as the declaration it forbids is the prose-versus-code failure this repository
     * has met before.
     */
    const DECLARED_UNSCOPED = [];
    const OWNED_PREFIXES = ['.ml-', '.nmc-'];
    const cssBlocks = findAll(panelTree, (n) => n.type === 'style').map((n) => textOf(n).replace(/\/\*[\s\S]*?\*\//g, ''));
    const allSelectors = [];
    for (const block of cssBlocks) {
      for (const chunk of block.split('}')) {
        const head = chunk.split('{')[0].trim();
        if (!head) continue;
        for (const one of head.split(',')) if (one.trim()) allSelectors.push(one.trim());
      }
    }
    const realSelectors = allSelectors.filter((sel) => !sel.startsWith('@'));
    const unowned = realSelectors.filter(
      (sel) => !OWNED_PREFIXES.some((prefix) => sel.startsWith(prefix)) && !DECLARED_UNSCOPED.includes(sel),
    );
    const bareElement = realSelectors.filter((sel) => /^[a-zA-Z]+(\s|$|\[|:|\.|#)/.test(sel));
    check(
      'the whole client half is override-safe: every selector namespaced or the one declared exception, none bare-element',
      cssBlocks.length >= 2 && realSelectors.length > 60 && unowned.length === 0 && bareElement.length === 0,
      `blocks=${cssBlocks.length} selectors=${realSelectors.length} unowned=[${unowned.join(', ')}] bare=[${bareElement.join(', ')}]`,
    );
    check(
      'no stylesheet in this package uses !important, so an override still wins by cascade order',
      !cssBlocks.some((block) => block.includes('!important')),
      cssBlocks.map((block) => (block.match(/!important/g) || []).length).join(', '),
    );
    check(
      'the declared exception is still exactly one selector, and it is still the row-suppression rule it was declared for',
      realSelectors.filter((sel) => DECLARED_UNSCOPED.includes(sel)).length === 0 && !realSelectors.some((sel) => sel === '[data-plugin-rows]'),
      'this tree allows no exception; the config card own is asserted by verify-config-panel.mjs',
    );
  }

  /* ---------------------------------------------------------- the detail renders */

  // Hook order in MemoryLabPanel: the store hook, then view, then selection.
  const setters = panelSetters;
  check('the panel exposes a view setter to switch tabs', typeof setters[0] === 'function');
  if (typeof setters[0] === 'function') {
    setters[0]('detail');
    const detail = expand(hooks.render(panelSeat.Component, {}), hooks);
    const detailText = textOf(detail);
    check('the detail view renders the three tag columns', detailText.includes('Selected tag') && detailText.includes('Child tags'));
    check('the detail view renders parent or root tags', detailText.includes('Parent tags') || detailText.includes('Root tags'));
    check('the detail view lists components', detailText.includes('Components'));
    const bodies = findAll(detail, (n) => n.type === 'pre').map((n) => textOf(n)).filter((t) => t.length > 0);
    check(
      'the detail view previews a real component body from the live store',
      bodies.some((body) => body.length > 20),
      `pre elements with content: ${bodies.length}`,
    );

    /* ------------------------------------------- the tag survives a component click */

    /* ------------------------------------------------- the body renders as Markdown */

    /* A component body is Markdown, often with LaTeX. The preview used to show it as raw text
     * in a `<pre>`. It now renders through the shell's own `MarkdownText` — Markdown and maths
     * are ONE component, because the primitives pass `mdastExtensions: [gfmFromMarkdown(),
     * mathFromMarkdown()]` (`dsh-client-ui-primitives/lib/index.js:10739`).
     *
     * Asserted from both ends, because each alone can pass on a broken build:
     *
     *  - BEHAVIOURALLY, in this harness, the primitives are not requirable (there is no module
     *    loader here), so `MarkdownText` is null and the pane must fall back to the `<pre>`
     *    with the body still in it. A fallback that rendered nothing would be a blank reading
     *    pane in any shell that lacks the package, which is worse than no rendering at all.
     *  - STRUCTURALLY, the source must still require the primitives under a guard, use the
     *    component with both `text` and `labels`, and keep the `<pre>` for the fallback. A
     *    source check is the only way to cover the branch this harness cannot enter.
     *
     * Neither asserts that the rendered output LOOKS right — see the report's "unverified"
     * section: this has never been rendered in a browser. */

    const bodyTexts = findAll(detail, (n) => n.type === 'pre').map((n) => textOf(n)).filter((t) => t.length > 0);
    check(
      'with no primitives available the body still renders, as text in a pre',
      bodyTexts.length > 0 && bodyTexts.every((t) => typeof t === 'string'),
      `pre elements with content: ${bodyTexts.length}`,
    );
    check(
      'the fallback shows the component body rather than a placeholder',
      bodyTexts.some((t) => t.length > 20),
      bodyTexts.map((t) => t.length).join(', '),
    );

    {
      const source = fs.readFileSync(clientHalf, 'utf8');
      check(
        'the client requires the shell primitives under a guard, so a shell without them still loads',
        /const primitives = require\('@deepseek-ai\/dsh-client-ui-primitives'\)/.test(source) &&
          /try \{[\s\S]{0,400}MarkdownText = primitives\.MarkdownText/.test(source),
        'an unguarded require would throw at load in a build that lacks the package',
      );
      check(
        'the Markdown component is used with both the body and the labels it reads',
        /h\(MarkdownText, \{ text: body, labels: [A-Z_]+\b/.test(source),
        'MarkdownText destructures `labels` with no default; omitting it is the untested path',
      );
      check(
        'the labels object is module-level, not rebuilt per render',
        /const PREVIEW_MARKDOWN_LABELS = Object\.freeze\(/.test(source),
        'MarkdownText memoises on the identity of `labels`, so a fresh object every render ' +
          'would re-parse the whole body every render',
      );
      check(
        'the plain-text path is kept, not replaced',
        /'pre',/.test(source) && /ml-preview-body/.test(source),
        'the fallback is the only rendering available in a shell without the primitives',
      );
    }

    /* The user's repro: open a tag, click one of its components, and the view jumped to the
     * alphabetically first tag in the store while the component column narrowed to the single
     * component that had been clicked. Both symptoms had one cause — the component selection
     * carried no tag, so `selectedTag` fell through to `names[0]` and the list stopped being
     * the tag's member list.
     *
     * Asserted two ways, because either alone can pass on a broken build: behaviourally, by
     * driving the real click handler and reading what it hands the panel; and by rendering
     * with that selection, so a fix that carried the tag but still narrowed the list fails. */

    const tagIndex = injected.index?.tags && typeof injected.index.tags === 'object' ? injected.index.tags : {};
    const multiTag = Object.keys(tagIndex).find((name) => Array.isArray(tagIndex[name]?.components) && tagIndex[name].components.length >= 2);

    check('the live store has a tag with two or more members to test against', Boolean(multiTag), multiTag || 'none');

    // Find the selection setter by WHAT IT DOES, not by its index. The setters are recorded by
    // hook cursor, and the panel's hook order is not something this harness should encode — the
    // first version of this block used `setters[2]` from a comment about hook order and skipped
    // itself silently when that index held something else. A behavioural probe cannot be off by
    // one, and if no setter can select a tag the block fails loudly instead of not running.
    const selectTag = (tag) => {
      for (const set of setters) {
        if (typeof set !== 'function') continue;
        set({ kind: 'tag', tag });
        const tree = expand(hooks.render(panelSeat.Component, {}), hooks);
        if (textOf(tree).includes(tag)) return set;
      }
      return null;
    };

    const tagSetter = multiTag ? selectTag(multiTag) : null;
    check(
      'a setter exists that selects a tag, found by behaviour rather than by hook index',
      typeof tagSetter === 'function',
      'no setter made the detail view show the tag',
    );

    if (tagSetter && multiTag) {
      const forTag = expand(hooks.render(panelSeat.Component, {}), hooks);

      // The rows carry the click handler; invoking it is what a click does.
      const rowButtons = findAll(forTag, (n) => n.type === 'button' && String(n?.props?.className || '').startsWith('ml-node'));
      const memberRows = rowButtons.filter((n) => String(textOf(n)).includes('rev'));
      check(
        'the component column renders one row per member of the selected tag',
        memberRows.length >= 2,
        `${memberRows.length} rows for ${multiTag}`,
      );

      let handedOver = null;
      if (memberRows[0]?.props?.onClick) {
        memberRows[0].props.onClick();
        // The panel stores what the handler passed; the setter is how the harness sees it.
        handedOver = 'invoked';
      }
      check('a component row is clickable', handedOver === 'invoked', 'row button had no onClick');

      // Now render AS IF that click had been handled, with the tag it should have carried.
      const memberSlug = (multiTag && Array.isArray(tagIndex[multiTag].components) ? tagIndex[multiTag].components[0] : '') || '';
      tagSetter({ kind: 'component', slug: memberSlug, tag: multiTag });
      const afterClick = expand(hooks.render(panelSeat.Component, {}), hooks);
      const afterRows = findAll(afterClick, (n) => n.type === 'button' && String(n?.props?.className || '').startsWith('ml-node'))
        .filter((n) => String(textOf(n)).includes('rev'));

      check(
        'clicking a component keeps its siblings listed, rather than narrowing to the one clicked',
        afterRows.length >= 2,
        `${afterRows.length} rows after opening a component under ${multiTag}`,
      );
      // Assert on the element that CARRIES the selected state, not on the page's text. The
      // first version of this read `textOf(afterClick).includes(multiTag)`, which is true
      // whenever the tag appears anywhere — and every tag appears in the tag list — so it
      // passed with the tag forgotten. The mutation run showed it: both mutations went red on
      // the sibling assertion and this one stayed green, which is what a vacuous check looks
      // like. The selected tag is the TagButton rendered with `selected: true`, so that is
      // what this reads.
      const selectedTagButtons = findAll(
        afterClick,
        (n) => String(n?.props?.className || '').split(/\s+/).includes('selected') && String(n?.props?.className || '').includes('ml-node'),
      );
      check(
        'the selected-tag element is the tag the component was opened from',
        selectedTagButtons.some((n) => textOf(n).startsWith(multiTag)),
        `selected nodes: ${JSON.stringify(selectedTagButtons.map((n) => textOf(n)).slice(0, 4))}, expected ${multiTag}`,
      );
    }
  }

  /* ------------------------------------------------- no page-level takeover */

  /* The takeover must not reach the page. A page-level stroke read the lease from the
   * snapshot the page loaded with, so it appeared only after a reload and then stayed
   * up after the lease ended. The seats must therefore be identical whether the lease
   * is free or held, and no seat may draw anything for a held lease. */

  const heldGlobals = {
    ...both.windowGlobals(),
    __NEWMARK_COMPUTERUSE__: { held: true, ownerId: 'harness', mouseMode: 'real', ttlMs: 120000, remainingMs: 90000 },
  };
  const heldSpec = await loadClient(heldGlobals);
  const heldHooks = createHooks();
  const heldSeats = [];
  heldSpec.factory((name) => {
    if (name === 'react') return heldHooks.React;
    throw new Error(`unexpected require "${name}"`);
  }).apply({
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
    slots: { inject(key, cb) { heldSeats.push({ key, entry: cb() }); return () => {}; }, register: (o, C) => ({ options: o, Component: C }) },
  });
  check(
    'a held lease registers exactly the same seats as a free one',
    heldSeats.length === seats.length && heldSeats.every((s, i) => s.key === seats[i].key),
    `free: ${seats.map((s) => s.key).join(', ')} | held: ${heldSeats.map((s) => s.key).join(', ')}`,
  );
  check(
    'no seat the page registers belongs to the takeover',
    !heldSeats.some((s) => String(s.entry.options.id || '').includes('takeover')),
  );

  /* ------------------------------------------------------------- the switches */

  const noMemoryLab = await mountCore({ packagesDir, root: HOST_FIXTURE, components: { memoryLab: false, computerUse: true } });
  const noMemorySpec = await loadClient(noMemoryLab.windowGlobals());
  const noMemorySeats = [];
  noMemorySpec.factory((name) => {
    if (name === 'react') return createHooks().React;
    throw new Error(`unexpected require "${name}"`);
  }).apply({ effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; }, slots: { inject(key, cb) { noMemorySeats.push({ key, entry: cb() }); return () => {}; }, register: (o, C) => ({ options: o, Component: C }) } });
  check(
    'switching MemoryLab off registers no sidebar entry and no panel',
    !noMemorySeats.some((s) => s.entry.options.id === 'memory-lab' || s.entry.options.key === 'memory-lab'),
    `seats: ${noMemorySeats.map((s) => s.key).join(', ')}`,
  );
  /* The one seat that must survive a component being off is the panel that switches it
   * back on: retiring it would leave the component unreachable from the UI. */
  check(
    'the config panel stays registered while MemoryLab is off',
    noMemorySeats.length === 3 && noMemorySeats.some(s => s.key === 'plugins.bundle.config') && noMemorySeats.some(s => s.entry.options.id === 'newmate'),
    `seats: ${noMemorySeats.map((s) => s.key).join(', ')}`,
  );

  const noComputerUse = await mountCore({ packagesDir, root: HOST_FIXTURE, components: { memoryLab: true, computerUse: false } });
  const noCuSpec = await loadClient(noComputerUse.windowGlobals());
  const noCuSeats = [];
  noCuSpec.factory((name) => {
    if (name === 'react') return createHooks().React;
    throw new Error(`unexpected require "${name}"`);
  }).apply({ effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; }, slots: { inject(key, cb) { noCuSeats.push({ key, entry: cb() }); return () => {}; }, register: (o, C) => ({ options: o, Component: C }) } });
  check(
    'the seats are the same whether the ComputerUse row is mounted or not',
    noCuSeats.length === seats.length && noCuSeats.every((s, i) => s.key === seats[i].key),
    `mounted: ${seats.map((s) => s.key).join(', ')} | unmounted: ${noCuSeats.map((s) => s.key).join(', ')}`,
  );
  check('switching ComputerUse off keeps the MemoryLab seats', noCuSeats.some((s) => s.entry.options.id === 'memory-lab'));

  /* ----------------------------------------------------------- the store is safe */

  check(
    'the live store was not touched by the client harness',
    (fs.existsSync(LIVE_INDEX) ? fs.statSync(LIVE_INDEX).mtimeMs : 0) === liveBefore,
  );
} finally {
  const after = fs.existsSync(LIVE_INDEX) ? fs.statSync(LIVE_INDEX).mtimeMs : 0;
  if (after !== liveBefore) {
    console.log('');
    console.log('ABORT: the live store changed during the run');
    process.exit(2);
  }
}

console.log('');
console.log('# the component column is the selected tag, and nothing else');

/* The defect this section exists for, as the user met it: a tag with nothing under it
 * rendered a stranger's body in the reading pane, because the preview's fallback chain
 * ended `|| components[0]` — the first component in the whole store. The column itself
 * is a separate question with the same answer: it must be the selected tag's own member
 * list, the same list its own heading counts.
 *
 * Two things about how this is driven, both deliberate:
 *
 * 1. A SYNTHETIC store, on a throwaway root. The defect shows only for a selection the
 *    store cannot resolve, and it must be shown to render EMPTY rather than to render
 *    some particular component — so the fixture needs a component that sorts first and
 *    belongs to no part of the tag under test. `trap-not-a-member` is that component,
 *    and every assertion below that names an absence names it.
 * 2. The REAL `DetailView`, through the real client module, with the real page globals.
 *    Nothing here re-states the filter; it renders it.
 *
 * What a mutation run established, and why two of these assertions are NOT here: the
 * filter the column used (`entry.tags.includes(selectedTag)`) and the store's member
 * list are the same set BY CONSTRUCTION — `normalizeIndex` builds every tag's member
 * list by walking the components' tags (`memory-store.js:1275`) — so swapping one for
 * the other cannot turn any assertion red, and pretending otherwise would be a check
 * that cannot fail. The assertions with teeth are the ones about what the column must
 * NOT contain: a component from outside the tag, and the store's first component. */
{
  const DETAIL_ROOT = path.join(os.tmpdir(), `newmark-detail-gate-${process.pid}`);
  /* Several agents work in this tree at once, and one of them rewrote `client.js` while a
   * run of this gate was in flight — the assertions below then describe a file that is no
   * longer on disk. Every claim in this section is about the OTHER half, so the hash at the
   * start is checked again at the end and a mid-run edit fails the run instead of passing
   * as a measurement of something else. */
  const clientHashAtStart = crypto.createHash('sha256').update(fs.readFileSync(clientHalf)).digest('hex');
  const detailFixture = [
    /* Sorts FIRST in the store, and its only tag is `#Z`. Nothing under test may show it. */
    { name: 'trap-not-a-member', tags: ['#Z'], tagPaths: [['#Z']] },
    { name: 'T direct one', tags: ['#T'], tagPaths: [['#T']] },
    { name: 'S only under T', tags: ['#S'], tagPaths: [['#T', '#S']] },
    { name: 'T and S flat', tags: ['#T', '#S'], tagPaths: [['#T'], ['#S']] },
    { name: 'U only under T', tags: ['#U'], tagPaths: [['#T', '#U']] },
  ];
  let detailMount = null;
  try {
    const mounted = await mountSyntheticStore({ packagesDir, root: DETAIL_ROOT, fixture: detailFixture });
    detailMount = mounted.mount;
    const globals = mounted.mount.windowGlobals();
    /* `index.components` is an ARRAY on the wire (`component.js` `toComponentArray`),
     * unlike the slug-keyed object `index.json` holds. Reading the wire form with
     * `Object.entries` yields array indices dressed up as slugs — which is the shape
     * confusion this whole defect was blamed on, so it is worth not repeating here. */
    const wire = mounted.payload.index.components;
    const nameOf = Object.fromEntries(wire.map((entry) => [entry.slug, entry.name]));
    const storeFirst = wire[0].slug;
    const membersOf = (tag) => mounted.payload.index.tags[tag]?.components || [];

    const render = (selection) => renderDetailColumns({ packagesDir, globals, clientHalf, selection });

    /* The MarkdownText PATH, asserted at the boundary the pane owns.
     *
     * The section above proves the FALLBACK — what a shell without the primitives renders. This
     * proves the path taken when they ARE present, which a source check can only cover
     * structurally and this harness cannot enter with its default package table.
     *
     * The spy records HOW `MarkdownText` was called, and that is the point: an assertion that
     * looked for an element named `MarkdownText` would pass on any call at all, with no body, no
     * labels, or a fresh labels object every render. The last of those is a real cost rather
     * than a style point — the component memoises on the identity of `labels`, so a new object
     * per render re-parses the whole body every render. */
    const spiedTag = await renderDetailColumns({
      packagesDir,
      globals,
      clientHalf,
      selection: { kind: 'tag', tag: '#T' },
      markdown: 'spy',
    });
    check(
      'with the primitives present the preview renders through MarkdownText',
      spiedTag.markdownCalls.length > 0,
      `${spiedTag.markdownCalls.length} calls`,
    );

    const firstCall = spiedTag.markdownCalls[0];
    check(
      'MarkdownText is given the component body as `text`',
      typeof firstCall?.text === 'string' && firstCall.text.length > 20,
      `text is ${typeof firstCall?.text}, ${firstCall?.text?.length ?? 0} chars`,
    );
    check(
      'MarkdownText is given the labels object it reads, rather than being left to destructure undefined',
      firstCall?.labels !== undefined && firstCall.labels !== null,
      `labels is ${firstCall?.labels === null ? 'null' : typeof firstCall?.labels}`,
    );
    /* There is deliberately NO behavioural identity check here, and the reason is worth keeping.
     *
     * The obvious one — render twice with the spy and compare `labels` between the two calls —
     * does not measure what it looks like it measures. `renderDetailColumns` executes the client
     * half afresh on every call, so a module-level constant is a NEW object in the second render
     * and the comparison fails on a correct build. It was written, run, and went red exactly that
     * way, which is the useful outcome: it fails for a reason unrelated to the property.
     *
     * The property — `labels` is built once, not per render — is covered STRUCTURALLY instead
     * ("the labels object is module-level, not rebuilt per render", above), and that check was
     * mutation-tested: rebuilding the object at the call site turns it red. A behavioural check
     * would need one module instance rendered twice, which is a harness this file does not have,
     * and adding a weaker version of it would put a green light on a property nothing verified. */

    check(
      'the plain-text pre is not used on the markdown path',
      findAll(spiedTag.tree, (n) => n.type === 'pre').filter((n) => textOf(n).length > 20).length === 0,
      'the pre is the fallback; using both would render the body twice',
    );

    const t = await render({ kind: 'tag', tag: '#T' });
    const tSlugs = t.column.rows.map((r) => r.slug);
    check(
      'the component column lists exactly the selected tag’s member list, every member and no other',
      tSlugs.length === membersOf('#T').length && membersOf('#T').every((slug) => tSlugs.includes(slug)),
      `column ${JSON.stringify(tSlugs)} vs index ${JSON.stringify(membersOf('#T'))}`,
    );
    /* The other direction, so a filter that simply empties the column cannot pass:
     * `#S` must keep BOTH of its members. `s-only-under-t` is stored with `#S` alone
     * and reached `#T` through a path, and the store put it in `#T` as well — so it has
     * to stay under `#T` too. A rule that drops ancestors' members fails here. */
    const s = await render({ kind: 'tag', tag: '#S' });
    const sSlugs = s.column.rows.map((r) => r.slug).sort();
    check(
      'a nested tag keeps its own members, so an emptied column cannot pass as a bound one',
      JSON.stringify(sSlugs) === JSON.stringify([...membersOf('#S')].sort()),
      `column ${JSON.stringify(sSlugs)} vs index ${JSON.stringify([...membersOf('#S')].sort())}`,
    );
    check(
      'the column never heads with the store’s first component, which belongs to no part of the tag',
      !tSlugs.includes(storeFirst) && t.preview !== nameOf[storeFirst],
      `store's first component ${storeFirst}="${nameOf[storeFirst]}" | column ${JSON.stringify(tSlugs)} | preview ${JSON.stringify(t.preview)}`,
    );
    check(
      'the preview reads the component the column heads with',
      t.preview === nameOf[tSlugs[0]],
      `preview ${JSON.stringify(t.preview)} | head ${tSlugs[0]}="${nameOf[tSlugs[0]]}"`,
    );

    /* THE DEFECT. A selection the store cannot resolve is the case the old fallback
     * answered with the store's first component. */
    const unresolvable = await render({ kind: 'component', slug: 'no-such-component' });
    check(
      'an unresolvable selection renders an empty column, not an arbitrary component',
      unresolvable.column.rows.length === 0,
      JSON.stringify(unresolvable.column.rows.map((r) => r.slug)),
    );
    check('the empty column says it is empty', unresolvable.column.empty === true);
    check(
      'an empty selection names no component anywhere on the page',
      !Object.values(nameOf).some((name) => unresolvable.text.includes(name)),
      `page text still carries a component name from: ${Object.values(nameOf).filter((n) => unresolvable.text.includes(n)).join(', ')}`,
    );
    check('an empty selection still renders the column and its title', unresolvable.text.includes('Components'));

    check(
      'the client half was not rewritten while this section was measuring it',
      crypto.createHash('sha256').update(fs.readFileSync(clientHalf)).digest('hex') === clientHashAtStart,
      'client.js changed mid-run: these assertions describe a file that is no longer on disk — re-run the gate',
    );

    /* The reading pane follows the CLICK, not the head of the column.
     *
     * This assertion needs a selection whose component is NOT the head of the column it
     * is rendered in, and there is only one shape that provides it: open `#U`'s component
     * under the tag `#S`. It is an unreachable state — a component carrying a tag is
     * always in that tag's member list (`memory-store.js:1275` builds each member list by
     * walking the components' tags, and all 130 entries in the live store witness it) —
     * which is exactly why it is the right probe: it is the one render in which the
     * preview's choice is observable at all. Under `listed[0] || components[0]` the pane
     * would show the column's head and this fails. The row list is deliberately NOT
     * asserted here; the column is `#S`'s, and a component outside it is not a row in it. */
    const u = wire.find((entry) => entry.name === 'U only under T')?.slug;
    const outside = await render({ kind: 'component', slug: u, tag: '#S' });
    check(
      'opening a component that is not the column’s head still reads THAT component',
      outside.preview === nameOf[u] && outside.preview !== nameOf[outside.column.rows[0]?.slug],
      `preview ${JSON.stringify(outside.preview)} | column head ${outside.column.rows[0]?.slug}="${nameOf[outside.column.rows[0]?.slug]}"`,
    );
  } finally {
    if (detailMount) await detailMount.dispose();
    fs.rmSync(DETAIL_ROOT, { recursive: true, force: true });
  }
}

console.log('');

console.log('');
console.log('# the rebuild light bar is bound to the rebuild');

{
  // The harness loads this half by dynamic import and never keeps its text, so read it here
  // rather than inheriting a variable that does not exist. (The first version of this section
  // assumed one, and the section died on a ReferenceError before asserting anything — which is
  // a check that fails loudly, not one that fails silently, but it still asserted nothing.)
  const source = fs.readFileSync(clientHalf, 'utf8');
  // On when it starts, off when it ends — and "ends" includes failing. The bar is driven by
  // `state.reindexing`; the reason it cannot stick is that the reset sits in a `finally`.
  check(
    'the bar is driven by the reindexing state, not by a timer of its own',
    /\.ml-busy \.ml-lap \{ opacity: 1; \}/.test(source) &&
      /\.ml-lap \{[^}]*opacity: 0/.test(source),
    'a bar that decides for itself when to stop reports progress that has already stopped',
  );
  check(
    'reindex() clears the reindexing state in a finally, so a failed rebuild also stops it',
    /async function reindex\(\) \{[\s\S]*?emit\(\{ reindexing: true[\s\S]*?try \{[\s\S]*?\} finally \{[\s\S]*?emit\(\{ reindexing: false \}\)/.test(source),
    'without the finally, a throw leaves the bar lit forever',
  );
  check(
    'the bar is mounted on the presentation page and hidden from assistive technology',
    /className: 'ml-lap', 'aria-hidden': 'true'/.test(source),
    'it is decoration on a state the button already reports in words',
  );

  // What the effect must be. The first version of the bar drew dashes — a repeating gradient
  // with hard stops on four separate edges — and the user rejected it for exactly that. So the
  // shape is asserted both ways: the continuous sweep must be there, and the dashes must not
  // come back. An assertion that only checked "a bar exists" would have passed on the version
  // that was wrong.
  for (const [what, pattern, why] of [
    ['a 2 px ring, cut by a mask rather than drawn as edges', /padding: 2px/, 'the ring thickness'],
    ['one element, so there are no corners to seam at', /\.ml-lap \{[^}]*conic-gradient/, 'a conic sweep is continuous around the perimeter'],
    ['an animatable angle, registered with @property', /@property --ml-lap-angle \{ syntax: '<angle>'/, 'a plain custom property cannot be animated'],
    ['a slow 9 s revolution', /animation: ml-lap-sweep 9000ms linear infinite/, 'a gradient that hurries reads as a progress bar'],
    ['black and white, the two colours the overlay uses', /conic-gradient\(from var\(--ml-lap-angle\), #000000, #ffffff/, 'the colours are shared with the overlay'],
  ]) {
    check(`the bar is ${what}`, pattern.test(source), why);
  }

  // The regression that matters: dashes. This is the effect that was rejected, and a check that
  // cannot name it cannot keep it out.
  check(
    'the bar is not dashes: no repeating gradient and no per-edge segments',
    !/repeating-linear-gradient/.test(source) && !/\.ml-lap span/.test(source),
    'hard stops on separate edges is the version the user rejected',
  );

  check(
    'the animation is dropped when the reader asks for reduced motion',
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.ml-lap \{ animation: none; \}/.test(source),
    'a perpetual animation is what that query exists for',
  );
  check(
    'it replaced the static border rather than joining it',
    !/box-shadow: inset 0 0 0 2px var\(--dsw-alias-brand-primary\)/.test(source),
    'two indicators for one state is one too many',
  );
}

// Electron's dsh-app page can omit tapIndex globals. Mount from the host's canonical name field.
{
  for(const mounted of [true,false]){
    const spec=await loadClient({}, {fetch:()=>jsonAnswer({ok:true,components:[{name:'newMate',mounted}]})});
    const hooks=createHooks(),seats=[],disposers=[];
    const plugin=spec.factory(name=>{if(name==='react')return hooks.React;throw Error('optional module absent');});
    plugin.apply({effect:callback=>{const release=callback();if(typeof release==='function')disposers.push(release);return release;},slots:{inject:(key,callback)=>{const seat={key,entry:callback()};seats.push(seat);return()=>{const i=seats.indexOf(seat);if(i>=0)seats.splice(i,1);};},register:(options,Component)=>({options,Component})}});
    await new Promise(resolve=>setTimeout(resolve,0));
    check('absent page globals use canonical host name and mounted='+mounted,seats.some(s=>s.entry.options.id==='newmate')===mounted);
    for(const release of disposers.reverse())release();
  }
}
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
