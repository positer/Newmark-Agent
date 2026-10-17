/**
 * Can the core row compose the two components itself, instead of the patch declaring
 * them as separate Loader rows?
 *
 * If it can, the bundle declares ONE row, so the plugin card shows one row and there
 * is no path to display. The components still exist and still contribute their tools;
 * they are simply loaded by the core row rather than by the Loader.
 *
 * This probe mounts ONLY the core row and counts what reaches the tools service. It
 * exercises the real `index.js` and the real component modules — no stubs of either.
 *
 * Run: node Newmark2DSH/scripts/probe-compose.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(path.resolve(here, '..'), 'packages', 'newmark-core');

const tools = new Map();
const taps = [];
const routes = [];

/** The services every Newmark row injects, provided once at the root. */
function services() {
  return {
    tools: {
      register(definition) {
        if (!definition?.name) throw new Error('tool without a name');
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    webServer: {
      tapIndex(transform) {
        taps.push(transform);
        return () => {};
      },
      // The core row also registers its component control route now.
      //
      // The disposer really removes the route, because that is what the real webServer does
      // and what `ctx.effect` is for: a disposed component stops serving. This stub used to
      // return a no-op, which made `routes` an append-only log — and an append-only log cannot
      // answer "is this route live?", only "was it ever pushed". The `check` below counts live
      // routes, which is the property that matters: switching a component off must retire its
      // route, and turning it back on must restore exactly one.
      register(route) {
        routes.push(route);
        return () => {
          const at = routes.indexOf(route);
          if (at !== -1) routes.splice(at, 1);
        };
      },
    },
  };
}

/**
 * A context whose `plugin()` really invokes the child module's `apply`, the way Cordis
 * does, so a child that cannot see the parent's services fails here the same way it
 * would in the app.
 */
function makeCtx(parent = null) {
  const chain = parent ? [...parent.chain, parent] : [];
  const own = parent ? {} : services();
  const disposers = [];
  const children = [];
  let disposal;

  const ctx = {
    chain,
    logger: { info() {}, warn() {}, error(message) { console.error(message); } },
    get tools() {
      if (own.tools) return own.tools;
      // Service lookup walks up the ancestry, which is the property under test.
      return chain.map((c) => c.tools).find(Boolean);
    },
    get webServer() {
      if (own.webServer) return own.webServer;
      return chain.map((c) => c.webServer).find(Boolean);
    },
    effect(callback) {
      const dispose = callback();
      disposers.push(dispose);
      return dispose;
    },
    plugin(module, config) {
      // ESM namespace objects carry the plugin under `default` when the module has
      // both named and default exports; both shapes must work.
      const target = module?.apply ? module : module?.default;
      if (typeof target?.apply !== 'function') {
        throw new Error(`composed module has no apply(): ${Object.keys(module || {}).join(', ')}`);
      }
      for (const requirement of target.inject || []) {
        if (!ctx[requirement]) {
          throw new Error(`composed plugin ${target.name} injects "${requirement}" and cannot see it`);
        }
      }
      const child = makeCtx(ctx);
      target.apply(child, config);
      // Real Cordis returns a fiber whose disposal unloads the child plugin; without
      // this the probe would report a leak that the app does not have.
      children.push(child);
      return child;
    },
    dispose() {
      if(disposal)return disposal;
      disposal=(async()=>{
        for (const child of children.reverse()) await child.dispose();
        for (const dispose of disposers.reverse()) {
          if (typeof dispose === 'function') await dispose();
        }
      })();
      return disposal;
    },
  };
  return ctx;
}

const results = [];
const check = (name, condition, detail) => {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'} - ${name}${condition ? '' : `  ${detail ?? ''}`}`);
};

const core = await import(`file:///${path.join(pkgDir, 'index.js').replace(/\\/g, '/')}`);
// There is no longer a preset module to import: the host half addresses no preset row, and the
// key the removed branch answered (`presetDev`, written inline below) is now just an unknown
// component to this route. That is the property this probe checks.

// --- the core row alone, without composing, is the baseline --------------------
{
  const root = makeCtx();
  core.apply(root, { root: process.env.TEMP, compose: false });
  check('the core row alone registers no tools', tools.size === 0, `${tools.size}`);
  check('the core row alone taps the index once', taps.length === 1, `${taps.length}`);
  await root.dispose();
}

// --- the core row composing both components -----------------------------------
tools.clear();
taps.length = 0;
{
  const root = makeCtx();
  let threw = null;
  try {
    core.apply(root, { root: process.env.TEMP, compose: true });
  } catch (error) {
    threw = error;
  }
  check('composing both components does not throw', threw === null, threw?.message);

  // Composition loads the components with a dynamic import, so the registration lands
  // after apply() returns. Waiting is the honest way to observe it.
  for(let attempt=0;tools.size!==29&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,50));

  const names = [...tools.keys()].sort();
  check(
    'the nine memory_lab_* tools arrive through composition',
    names.filter((n) => n.startsWith('memory_lab_')).length === 9,
    names.join(', '),
  );
  check(
    'the two computer_use tools arrive through composition',
    names.filter((n) => n === 'computer_use' || n === 'screen_capture').length === 2,
    names.join(', '),
  );
  check(
    'the four agent_api_* tools arrive through composition',
    names.filter((n) => n.startsWith('agent_api_')).length === 4,
    names.join(', '),
  );
  check(
    'all thirty-four component tools are registered',
    names.length === 34,
    `${names.length}: ${names.join(', ')}`,
  );
  check(
    'all six rows tap the index so component page globals survive',
    taps.length === 6,
    `${taps.length}`,
  );

  if (threw) console.log(`\n  throw: ${threw.stack?.split('\n').slice(0, 6).join('\n  ')}`);

  await root.dispose();
  check('disposing the core row releases every tool', tools.size === 0, `${tools.size}`);
}

/**
 * Drive the control route the way the config panel does.
 *
 * The handler registers its body listeners synchronously, so they exist by the time the
 * call returns and the request can be finished immediately. Resolving on `end` is what
 * makes the assertions below wait for the real answer instead of racing it.
 */
function callRoute(route, method, body) {
  return new Promise((resolve, reject) => {
    const listeners = { data: [], end: [] };
    const req = {
      method,
      on(event, fn) {
        if (listeners[event]) listeners[event].push(fn);
        return req;
      },
      destroy() {},
    };
    const res = {
      status: 0,
      writeHead(status) {
        res.status = status;
      },
      end(payload) {
        try {
          resolve({ status: res.status, json: JSON.parse(payload) });
        } catch (error) {
          reject(error);
        }
      },
    };
    route.handler(req, res);
    if (listeners.data.length && body !== undefined) {
      const text = JSON.stringify(body);
      if (text) for (const fn of listeners.data) fn(text);
    }
    for (const fn of listeners.end) fn();
  });
}

// --- the switches are real ------------------------------------------------------
tools.clear();
taps.length = 0;
/**
 * What one composition of the core row serves, and what is left after it is disposed.
 *
 * Both directions are the property under test: a component that keeps serving after it is
 * switched off leaks a live route, and a component that never serves one is not mounted at all.
 * This probe could not tell either apart before, because its `register` returned a no-op
 * disposer — `routes` was an append-only log, so a count over it included every route ever
 * retired and "is it live?" had no answer. The disposer is real now, and these two arrays are
 * read where the table still means what it says.
 */
let composedRoutes = [];
let disposedRoutes = [];
/** The shape of the control route as that composition registered it, not as the table reads later. */
let controlRouteShape = null;
{
  const root = makeCtx();
  core.apply(root, { root: process.env.TEMP, compose: true });
  for(let attempt=0;tools.size!==29&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,50));

  // The live routes this ONE composition registered, read before the toggle sequence below
  // adds and retires a MemoryLab route of its own. Read here rather than at the end of the
  // section because that is the only moment the table means "what one composition of the core
  // row serves": the mounts before this one were disposed, and the switches below remove and
  // restore a route, so a count taken after them cannot distinguish a live route from a
  // retired one.
  composedRoutes = routes.map((entry) => entry.path);
  controlRouteShape = routes.find((entry) => entry.path === '/newmark-core/components') ?? null;

  /* The LAST control route, not the first and not simply the last route: this probe
   * applies the core row three times in one process, so three control routes exist by
   * now and each closure belongs to its own mount (`compose: false` for the first).
   * The composed MemoryLab also serves a route of its own, which is why the control
   * route is addressed by path at all. */
  const route = routes.filter((entry) => entry.path === '/newmark-core/components').pop();
  check('the composing mount exposes its control route', Boolean(route?.handler), String(typeof route?.handler));

  const before = [...tools.keys()].filter((n) => n.startsWith('memory_lab_')).length;
  check('the switch starts from nine memory_lab_* tools', before === 9, `${before}: ${[...tools.keys()].join(', ')}`);

  const off = await callRoute(route, 'POST', { component: 'memoryLab', enabled: false });
  check('turning MemoryLab off answers ok', off.json?.ok === true, JSON.stringify(off.json));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterOff = [...tools.keys()].filter((n) => n.startsWith('memory_lab_')).length;
  check('turning MemoryLab off really unregisters its nine tools', afterOff === 0, `${afterOff} left`);

  const others = [...tools.keys()].filter((n) => n === 'computer_use' || n === 'screen_capture').length;
  check('turning MemoryLab off leaves ComputerUse alone', others === 2, `${others}`);

  const on = await callRoute(route, 'POST', { component: 'memoryLab', enabled: true });
  check('turning MemoryLab back on answers ok', on.json?.ok === true, JSON.stringify(on.json));
  for(let attempt=0;tools.size!==29&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
  const afterOn = [...tools.keys()].filter((n) => n.startsWith('memory_lab_')).length;
  check('turning MemoryLab back on restores its nine tools', afterOn === 9, `${afterOn}`);

  const unknown = await callRoute(route, 'POST', { component: 'nope', enabled: true });
  check('an unknown component is refused with 400', unknown.status === 400, `${unknown.status}`);

  // The preset is NOT this route's to handle any more. It was: the branch wrote the
  // `agent-preset-registry` entry's `selectedDefault` in the profile patch, and this probe
  // checked that posting the panel's key reached it (and, before that, that the shipped
  // switch's key mix-up did not). The user removed the switch — 去除插件配置中的预设dev preset
  // 插件开关行，不用插件配置页调控默认预设 — so what this probe asserts now is the other
  // direction: the key that used to be handled is refused like any other unknown component,
  // which is what "the branch is gone" means at the route's own boundary.
  const presetKey = 'presetDev';
  const preset = await callRoute(route, 'POST', { component: presetKey, enabled: false });
  check(
    'the route no longer handles the preset key, so no POST can rewrite the default preset',
    preset.status === 400 && preset.json?.ok === false,
    `${preset.status} ${JSON.stringify(preset.json)}`,
  );

  const wrong = await callRoute(route, 'DELETE');
  check('a method other than GET or POST is refused with 405', wrong.status === 405, `${wrong.status}`);

  const state = await callRoute(route, 'GET');
  check(
    'GET reports the components and their mounted state',
    state.json?.ok === true && Array.isArray(state.json.components) && state.json.components.length === 5,
    JSON.stringify(state.json),
  );
  check(
    'GET returns no stray numeric keys alongside the array',
    Object.keys(state.json || {}).every((key) => !/^\d+$/.test(key)),
    'an earlier version spread an array into the response object, which produced "0" and ' +
      'dropped the preset entry: ' + JSON.stringify(Object.keys(state.json || {})),
  );

  // Read the live route table BEFORE this mount is disposed: the disposers are real, so
  // disposing removes every one of them and the count afterwards is zero by construction.
  const stillServing = routes.map((entry) => entry.path);

  await root.dispose();
  disposedRoutes = routes.map((entry) => entry.path);
  // The control route belongs to the mount that registered it, so it goes with the rest.
  check(
    'disposing the mount retires every route it registered, the control route included',
    disposedRoutes.length === 0,
    `${disposedRoutes.length} left: ${disposedRoutes.join(', ')}`,
  );
  // The switches retired MemoryLab's route and then restored exactly one, so the table the
  // disposal above emptied is the same one this reads: two live component routes plus the core.
  check(
    'switching a component off retires its route, and switching it back on restores exactly one',
    stillServing.filter((path) => path === '/newmark-memorylab/snapshot').length === 1 &&
      stillServing.filter((path) => path === '/newmark-agentapi/state').length === 1,
    `still serving before teardown: ${stillServing.join(', ')}`,
  );
}

/* One composition of the core row, and what it serves.
 *
 * `composedRoutes` was read at the moment that composition was the newest thing in the table, so
 * it is that composition's own routes and not a running total: core control, MemoryLab's snapshot
 * and agent-api's state — one each, and agent-api's is the newest thing here, so a component that
 * registered nothing would be visible as a missing path rather than as a smaller number. */
const countOf = (list, path) => list.filter((entry) => entry === path).length;
check(
  'one composition serves update discovery, component routes and the Windows NewMate CSS bridge exactly once',
  composedRoutes.length === (process.platform === 'win32' ? 11 : 9) && countOf(composedRoutes, '/newmark-newmate') === 1 && countOf(composedRoutes,'/newmark-newmate/mcp')===1 && countOf(composedRoutes,'/newmark-memorylab/short-memory')===1 &&
    countOf(composedRoutes, '/newmark-core/update') === 1 &&
    countOf(composedRoutes, '/newmark-computeruse/menu-theme') === (process.platform === 'win32' ? 1 : 0) &&
    countOf(composedRoutes, '/newmark-computeruse/menu-client.js') === (process.platform === 'win32' ? 1 : 0) &&
    countOf(composedRoutes, '/newmark-core/components') === 1 &&
    countOf(composedRoutes, '/newmark-memorylab/snapshot') === 1 &&
    countOf(composedRoutes, '/newmark-agentapi/state') === 1,
  `${composedRoutes.length} routes: ${composedRoutes.join(', ')}`,
);
check(
  'the control route is the component toggle endpoint',
  // Read from the composition snapshot rather than from `routes[0]`: the table is empty by now,
  // because the disposers are real and the mounts above were disposed. An assertion that reads a
  // list it already emptied would be checking `undefined` against two values and passing for the
  // wrong reason the moment the emptiness itself became the subject of a check.
  countOf(composedRoutes, '/newmark-core/components') === 1 && controlRouteShape?.kind === 'exact',
  JSON.stringify(controlRouteShape ?? null),
);

const failed = results.filter((r) => !r.ok).length;
console.log('');
console.log(`SUMMARY passed=${results.length - failed} failed=${failed} total=${results.length}`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
