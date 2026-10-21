/**
 * Mount Newmark Core the way the Loader does.
 *
 * The bundle declares **one** Loader row —`newmark-core` —`newmark2dsh` —and that
 * row composes the MemoryLab and ComputerUse components itself, with `ctx.plugin()` of
 * the two relative paths inside the package. The components keep their own manifests so
 * the client-module registry still treats each as a package, but they are no longer
 * rows: addressing them as rows is what made the plugin card render a `file:///…` module
 * path where a component name belongs, and it is what the `file:` dependencies that
 * pnpm could not resolve were for.
 *
 * So mounting the **core row** is what yields the components, and this mounter does
 * exactly that rather than assembling rows that no longer exist. It applies the real
 * `index.js` with a context whose `plugin()` really invokes the child module's `apply`,
 * with the parent's services visible up the fiber chain —which is how Cordis resolves
 * them —and it keeps every fiber the row returns, because disposing that fiber is what
 * makes the row's switch real.
 *
 * Switching is therefore exercised the way the config panel exercises it: a POST to the
 * row's own control route. `components: { memoryLab: false }` means "compose both, then
 * switch MemoryLab off", which is the only path that exists now —the Loader cannot mount
 * one component of a composed row, and pretending it could would test a composition the
 * app never builds.
 *
 * Kept in one place so the activation harness and the client harness cannot drift into
 * testing two different compositions.
 */
import path from 'node:path';

/**
 * The page globals the bundle publishes, by component key.
 *
 * `origin` records how each one is reached: `loader` is the row the patch declares,
 * `composed` is a component the core row loads from inside itself. A harness that wants
 * to know how many Loader rows the bundle occupies must count `loader`, not the map size.
 */
export const ROWS = {
  newMate: { package: 'newmark-core', file: 'components/newmate/index.js', global: '__NEWMARK_NEWMATE__', origin: 'composed' },
  heartBeat: { package: 'newmark-core', file: 'components/heartbeat/index.js', global: '__NEWMARK_HEARTBEAT__', origin: 'composed' },
  core: { package: 'newmark-core', file: 'index.js', global: '__NEWMARK_CORE__', origin: 'loader' },
  // The components ship inside the bundle as nested packages. They are loaded by the core
  // row, from paths, so nothing has to resolve them as packages at runtime.
  memoryLab: { package: 'newmark-core', file: 'components/memorylab/index.js', global: '__NEWMARK_MEMORYLAB__', origin: 'composed' },
  computerUse: { package: 'newmark-core', file: 'components/computeruse/index.js', global: '__NEWMARK_COMPUTERUSE__', origin: 'composed' },
  agentApi: { package: 'newmark-core', file: 'components/agent-api/index.js', global: '__NEWMARK_AGENTAPI__', origin: 'composed' },
};

/** The components the core row composes, in the row's own order. */
export const COMPOSED = ['memoryLab', 'computerUse', 'agentApi', 'newMate', 'heartBeat'];

/**
 * The component key each component module belongs to.
 *
 * Keyed by the `name` the module exports, which is the only identity a composed fiber
 * carries: `ctx.plugin()` is handed a module and a config, never a component name.
 */
const PLUGIN_KEYS = {
  'newmark-memorylab': 'memoryLab',
  'newmark-computeruse': 'computerUse',
  'newmark-agentapi': 'agentApi',
  'newmark-newmate': 'newMate',
  'newmark-heartbeat': 'heartBeat',
};

/** The absolute directory of a row's package. */
export function rowDir(packagesDir, key) {
  return path.join(packagesDir, ROWS[key].package);
}

async function loadRow(packagesDir, key, cacheBust) {
  const file = path.join(rowDir(packagesDir, key), ROWS[key].file);
  const url = new URL('file:///' + file.replace(/\\/g, '/'));
  // Each mount gets a fresh module instance, so two mounts in one process cannot
  // share module-level state the way two real Loader entries never would.
  url.searchParams.set('mount', String(cacheBust));
  return import(url.href);
}

const FREE_LEASE = { held: false, ownerId: '', mouseMode: 'real', ttlMs: 0, remainingMs: 0 };

/**
 * Drive a registered route the way the panel's `fetch` does.
 *
 * The handler registers its body listeners synchronously, so they exist by the time the
 * call returns. Resolving on `end` is what makes a caller wait for the real answer
 * instead of racing it.
 *
 * `url` defaults to the route's own path, which is what the server would hand a handler for a
 * bare GET; a caller that needs a query string passes the whole path — the MemoryLab rebuild is
 * asked for with `?reindex=1`, and a harness that could not spell that could not test the button.
 */
export function callRoute(route, method, body, url) {
  return new Promise((resolve, reject) => {
    const listeners = { data: [], end: [] };
    const req = {
      method,
      url: url === undefined ? route.path : url,
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param options.packagesDir —the `packages/` directory holding the bundle.
 * @param options.root —the shared Newmark root, passed to the core row's `config.root`.
 * @param options.compose —the core row's `compose` flag. Defaults to true, which is what
 *   the harnesses need: false mounts the core row alone, with no component at all.
 * @param options.components —which components end up mounted, default both. A component
 *   asked for with `false` is composed and then switched off through the control route.
 * @param options.coreConfig —extra core-row config; `root` and `compose` win over it.
 */
export async function mountCore(options = {}) {
  const { packagesDir, root } = options;
  const wanted = { memoryLab: true, computerUse: true, agentApi: true, ...(options.components || {}) };
  const compose = options.compose !== false;

  const tools = new Map();
  const taps = [];
  const routes = [];
  const effects = [];
  const logs = [];
  /** Every dispatch this registry was asked to carry, in order — the record a gate reads. */
  const dispatches = [];
  /** The live fiber of each composed component, by component key. */
  const fibers = new Map();
  /** The services the core row provided, by name —one service, and this is how it is read. */
  const provided = new Map();
  const loaderRows = [];
  let bust = 0;

  const toolsService = {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`tool ${definition.name} already registered`);
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    /**
     * Read a registered tool by name, as the real registry does.
     *
     * This is not a convenience: `agentApiPresence` decides whether `agent-api` is mounted by
     * asking the registry `get('agent_api_send')`, and MemoryLab's whole judgement half reads
     * that one answer. A harness whose registry had only `register` made the predicate answer
     * `active: false` unconditionally —so a mount with agent-api live and a mount with it
     * switched off were indistinguishable here, and any assertion about the difference would
     * have been measuring the harness rather than the bundle.
     */
    get(name) {
      return tools.get(name);
    },
    /**
     * The catalog projection, which `agent-api` probes before it will drive a run: a registry
     * with `get` and no `schemas()` answers `tools_unavailable` for every run, so a mount that
     * omitted it could not tell "the run was refused for a real reason" from "this harness has no
     * registry". Same shape the real service returns.
     */
    schemas() {
      return [...tools.values()].map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }));
    },
    /**
     * Carry ONE dispatch, exactly as `ctx.tools.execute` does for a caller inside the process.
     *
     * This is the method MemoryLab's rebuild route reaches a run through: `judge()` dispatches
     * `agent_api_send` here, so a harness without it would prove nothing about the feature it
     * exists to test — the route's judgement half would answer "the tools registry is
     * unreachable" on every mount, and `agent-api`'s own run path would be unreachable from a
     * route at all.
     *
     * It is deliberately a REAL dispatch and not a canned answer: the named tool's own `execute`
     * runs, with the arguments the caller passed, and the result is materialised in the documented
     * `ToolExecutionResult` shape (`{ content, isError, value }` on success,
     * `{ content, isError, error }` on failure) that both `agent-api`'s `classifyToolResult` and
     * MemoryLab's `readEnvelope` read. A gate that wants a specific answer registers the tool that
     * gives it; a gate that wants to know WHAT was dispatched reads `dispatches` below.
     */
    async execute(exec) {
      dispatches.push(exec);
      const definition = tools.get(String(exec?.name ?? ''));
      if (definition === undefined) {
        return {
          content: [{ type: 'text', text: `Error: unknown tool "${exec?.name}"` }],
          isError: true,
          error: { message: `unknown tool "${exec?.name}"`, info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } },
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

  const webServerService = {
    tapIndex(transform) {
      taps.push(transform);
      return () => {
        const at = taps.indexOf(transform);
        if (at !== -1) taps.splice(at, 1);
      };
    },
    register(route) {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at !== -1) routes.splice(at, 1);
      };
    },
  };

  /**
   * A context that behaves like a Cordis context: services resolve up the ancestry, and
   * `plugin()` mounts a child whose fiber can be disposed. Without the ancestry walk a
   * composed component would fail to see `tools` and `webServer`, which is the very
   * question the composition rests on.
   */
  function makeCtx(parent = null, label = 'loader') {
    const chain = parent ? [parent, ...parent.chain] : [];
    /**
     * The services the ROOT context carries.
     *
     * `tools` and `webServer` are what every row injects. `options.services` adds the ones a
     * particular gate needs and the bundle only reaches optionally — `configEditor` and
     * `profileContext` are the two the core row's control route reads through `ctx.get(name)`
     * and `ctx.<name>`, and without a way to hand them in, the model write and the preset switch
     * could not be driven at all: the route would answer `config_editor_unavailable` and
     * `profile_context_unavailable` on every mount, and a gate could show nothing but the
     * refusal. They are per-mount and never provided by default, because a real profile may
     * genuinely not have them — that refusal is a state the app reaches.
     */
    const own = parent ? null : { tools: toolsService, webServer: webServerService, ...(options.services || {}) };
    const disposers = [];

    const ctx = {
      label,
      chain,
      provided,
      /**
       * A service handed in through `options.services` is readable BOTH ways the app reads one.
       *
       * Cordis exposes an injected service as a property of the context (`ctx.profileContext`)
       * as well as through `ctx.get(name)`, and the bundle uses both: the core row reads its
       * profile that way, and reads the config editor through the guarded `maybe(name)`. Placed
       * first in the literal on purpose — the harness's own members below win a name collision,
       * because a service must never be able to replace `logger`, `plugin` or `dispose`.
       */
      ...(parent === null ? options.services || {} : {}),
      /**
       * The Loader row's own fiber, when a gate supplies one.
       *
       * `configEditor.edit(entry, change)` takes the row's Loader entry, and the core row reads
       * it as `ctx.fiber.entry` — which is what the real Loader puts there
       * (`cordis-plugin-loader/lib/index.js:52`). Without it the model write answers
       * `config_editor_unavailable` before it attempts anything, so the failure path this task
       * is about (an edit that throws, a read-back that disagrees) would be unreachable from a
       * mount. Absent by default: a row mounted with no Loader above it really has no entry.
       */
      fiber: parent === null ? options.fiber : undefined,
      logger: {
        info: (message) => logs.push(`[${label}] ${message}`),
        warn: (message) => logs.push(`[${label}] warn: ${message}`),
        error: (message) => logs.push(`[${label}] error: ${message}`),
      },
      get tools() {
        return own ? own.tools : chain.map((entry) => entry.tools).find(Boolean);
      },
      get webServer() {
        return own ? own.webServer : chain.map((entry) => entry.webServer).find(Boolean);
      },
      /**
       * The core row provides ONE service to its own composed components. The real Cordis
       * `ctx.provide(name, value)` registers it on the fiber and disposes it with the fiber;
       * here it is a map the ancestry walk reads, which is the part the components depend on.
       *
       * It is implemented rather than skipped because `agent-api` reads the authorised model
       * off exactly this service (`components/agent-api/lib/core-model.js`): without it, every
       * composed agent-api would answer `core_service_absent` and the composition harness would
       * be testing a profile nobody ships.
       */
      provide(name, value) {
        provided.set(name, value);
        return () => provided.delete(name);
      },
      /**
       * Read a provided service without requiring it, exactly as Cordis's `ctx.get(name)` does:
       * walk up the fiber chain and answer `undefined` when nobody provided it.
       *
       * `undefined` and not a throw, because that is what the real method does —Cordis's own
       * comment says "Read a service from the store without the inject requirement —or
       * `undefined` when not (yet) provided" (`@deepseek-ai/cordis/lib/index.js:755-765`) —and
       * every component here treats an absent service as a reportable state rather than a
       * crash. A harness that threw instead would fail where the app answers.
       */
      get(name) {
        // A service this mount was handed is readable the same way a provided one is, because
        // that is what `ctx.get` answers in the app: the service the context carries.
        if (own && own[name] !== undefined) return own[name];
        if (own && provided.has(name)) return provided.get(name);
        for (const entry of chain) {
          if (entry.provided && entry.provided.has(name)) return entry.provided.get(name);
        }
        return undefined;
      },
      effect(callback, name) {
        const disposer = callback();
        effects.push({ name, label });
        if (typeof disposer === 'function') disposers.push(disposer);
        return () => {};
      },
      /** Mount a child plugin and return the fiber that unloads it again. */
      plugin(module, config) {
        // ESM namespace objects carry the plugin under `default` when the module has both
        // named and default exports; both shapes must work.
        const target = module?.apply ? module : module?.default;
        if (typeof target?.apply !== 'function') {
          throw new Error(`composed module has no apply(): ${Object.keys(module || {}).join(', ')}`);
        }
        for (const requirement of target.inject || []) {
          if (!ctx[requirement]) {
            throw new Error(`composed plugin ${target.name} injects "${requirement}" and cannot see it`);
          }
        }
        const child = makeCtx(ctx, target.name || 'component');
        target.apply(child, config);
        const key = PLUGIN_KEYS[target.name] || target.name;
        const fiber = {
          key,
          module: target.name,
          dispose() {
            if (fibers.get(key) === fiber) fibers.delete(key);
            child.dispose();
          },
        };
        fibers.set(key, fiber);
        return fiber;
      },
      dispose() {
        for (const disposer of disposers.reverse()) {
          try {
            disposer();
          } catch (error) {
            logs.push(`[${label}] dispose failed: ${error?.message ?? error}`);
          }
        }
        disposers.length = 0;
      },
    };

    return ctx;
  }

  /**
   * Wait for a state the composition reaches asynchronously.
   *
   * `component.load()` is a dynamic import that resolves after `apply()` has returned, so
   * nothing about the composed components is observable synchronously. Polling for the
   * exact state —never sleeping for a fixed guess —keeps a fast machine fast and reports
   * a composition that never lands instead of hiding it behind a sleep that "passed".
   */
  async function waitFor(predicate, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return true;
      // The row logs a failed composition rather than throwing out of the effect, so the
      // wait ends on it instead of burning the whole timeout.
      if (logs.some((line) => line.includes('failed to compose'))) return false;
      if (Date.now() > deadline) {
        logs.push(`[harness] timed out waiting for ${label}`);
        return false;
      }
      await delay(20);
    }
  }

  /**
   * The row's control route, found by the path it registers.
   *
   * Not `routes[routes.length - 1]`: that was a stand-in for "the only route in
   * play", and it stopped being true once the composed MemoryLab started serving
   * its own snapshot route —the switch then POSTed at the snapshot route and the
   * component was never switched. A route is identified by its path, which is what
   * the app's own router does.
   */
  function controlRoute() {
    return routes.find((route) => route.path === '/newmark-core/components') || null;
  }

  /**
   * Switch one component, through the row's own control route.
   *
   * This is the path the panel takes, and the answer is the Host's, not this harness's:
   * a switch that only echoed the request would be a label.
   */
  async function switchComponent(name, enabled) {
    const route = controlRoute();
    if (!route || typeof route.handler !== 'function') {
      throw new Error('the core row registered no control route to switch through');
    }
    const answer = await callRoute(route, 'POST', { component: name, enabled: enabled === true });
    const landed = await waitFor(
      () => (enabled === true ? fibers.has(name) : !fibers.has(name)),
      `${name} to ${enabled === true ? 'compose' : 'unmount'}`,
    );
    return { ...answer.json, landed };
  }

  /** What the route answers a GET, which is the state the panel renders. */
  async function controlState() {
    const route = controlRoute();
    if (!route || typeof route.handler !== 'function') return null;
    return (await callRoute(route, 'GET')).json;
  }

  const core = await loadRow(packagesDir, 'core', (bust += 1));
  const coreCtx = makeCtx(null, 'newmark-core');
  core.apply(coreCtx, { ...(options.coreConfig || {}), root, compose });
  loaderRows.push({ key: 'core', module: core, global: ROWS.core.global });

  if (compose) {
    await waitFor(() => fibers.size >= COMPOSED.length, 'both components to compose');
    for (const name of COMPOSED) {
      if (wanted[name] === false) await switchComponent(name, false);
    }
  }

  /** The HTML the shell would serve, with every live injection applied. */
  function html() {
    return taps.reduce((acc, transform) => transform(acc), '<html><head></head><body></body></html>');
  }

  /** Read one component's page global out of the served page. */
  function global(name) {
    const page = html();
    const marker = `window.${name}=`;
    const at = page.indexOf(marker);
    if (at === -1) return undefined;
    return JSON.parse(page.slice(at + marker.length, page.indexOf(';</script>', at)));
  }

  /** The globals the bundle publishes, keyed by component. */
  function globals() {
    return Object.fromEntries(Object.keys(ROWS).map((key) => [key, global(ROWS[key].global)]));
  }

  /**
   * The same values keyed by the page-global name, ready to spread into `window`.
   *
   * Distinct from `globals()`, which is keyed by component for readable assertions; a
   * harness that spread the component-keyed object into `window` would publish
   * `window.core` instead of `window.__NEWMARK_CORE__`, and the client would see
   * nothing —which is exactly the mistake this accessor exists to prevent.
   */
  function windowGlobals() {
    return Object.fromEntries(
      Object.entries(globals())
        .map(([key, value]) => [ROWS[key].global, value])
        .filter(([, value]) => value !== undefined),
    );
  }

  /** The composed payload, built exactly as the Client half builds it. */
  function payload() {
    const all = globals();
    const coreRow = all.core;
    const memory = all.memoryLab;
    const automation = all.computerUse;
    const api = all.agentApi;
    if (!coreRow && !memory && !automation && !api) return undefined;
    return {
      ...(memory || {}),
      ok: memory ? memory.ok === true : true,
      root: (memory && memory.root) || (coreRow && coreRow.root) || '',
      platform: (coreRow && coreRow.platform) || '',
      generatedAt: (memory && memory.generatedAt) || (coreRow && coreRow.generatedAt) || '',
      components: { memoryLab: Boolean(memory), computerUse: Boolean(automation), agentApi: Boolean(api), newMate:Boolean(all.newMate), heartBeat:Boolean(all.heartBeat) },
      computerUse: automation || FREE_LEASE,
      agentApi: api || null,
    };
  }

  return {
    tools,
    taps,
    routes,
    effects,
    logs,
    /** Every dispatch carried through the registry, in order: `{ callId, name, arguments, signal }`. */
    dispatches,
    /** The services the core row provided, so a harness can read what a component would read. */
    provided,
    html,
    global,
    globals,
    windowGlobals,
    payload,
    /** The Loader rows and the composed components that are mounted right now. */
    get rows() {
      const list = loaderRows.map((row) => ({ key: row.key, origin: ROWS[row.key].origin, global: row.global }));
      for (const name of COMPOSED) {
        if (fibers.has(name)) list.push({ key: name, origin: ROWS[name].origin, global: ROWS[name].global });
      }
      return list;
    },
    /** The composed components that are mounted right now, by key. */
    get composed() {
      return [...fibers.keys()];
    },
    switch: switchComponent,
    state: controlState,
    async dispose() {
      for (const fiber of [...fibers.values()]) fiber.dispose();
      coreCtx.dispose();
    },
  };
}

/** Read a component module without mounting it, for schema assertions. */
export async function loadRowModule(packagesDir, key) {
  return loadRow(packagesDir, key, `schema-${Math.random()}`);
}
