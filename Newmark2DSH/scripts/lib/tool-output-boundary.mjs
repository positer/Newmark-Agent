/**
 * The tool-output boundary in one place: DSH's own walker, and a walker that names the path.
 *
 * =====================================================================================
 * WHY THIS MODULE EXISTS — in the user's terms, not a style guide's
 * =====================================================================================
 *
 * DSH validates every tool's return value as LOSSLESS JSON before handing it to a caller.
 * `createSuccessResult` -> `snapshotToolValue` -> `snapshotJsonValue`
 * (`@deepseek-ai/dsh-tools/lib/types/index.js:1189-1190`, `:106-118`), and a rejection becomes
 * `ToolOutputError` / `INVALID_TOOL_OUTPUT` (`:77-85`). The rules are `walkJsonValue`
 * (`@deepseek-ai/dsh-util-values/lib/index.js:46-153`): `null`, booleans, strings, finite
 * non-`-0` numbers, plain arrays and plain objects — and at `:109`
 * `if (typeof current !== "object") return void 0`, which is where `undefined` dies.
 *
 * **That boundary has now silently discarded two real operations in this bundle.** A value it
 * rejects is an operation that ALREADY HAPPENED, reported to its caller as a hard failure:
 *
 *   - `memory_lab_reindex` (0.2.2) returned `error: undefined` on the success path, so a
 *     rebuild that wrote the index correctly came back as a failure. A caller's obvious
 *     response is to rebuild again.
 *   - `agent_api_send` returned `{ turn: undefined }` inside its event log, so a judgement the
 *     Agent had really run was thrown away at the boundary and the panel showed
 *     判定未完成：INVALID_TOOL_OUTPUT — an answer paid for in real model tokens, discarded for
 *     a field nobody read.
 *
 * So this is not tidiness and not a lint rule. It is the difference between "the run answered"
 * and "the run answered and the answer was thrown away", and the second one is invisible from
 * inside the component: every gate that calls a tool's `execute` directly never meets it.
 *
 * =====================================================================================
 * TWO THINGS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT
 * =====================================================================================
 *
 *   - `snapshotJsonValue` is the AUTHORITY. It is imported from the DSH installation and never
 *     reimplemented. Every verdict any gate draws from this module is its verdict.
 *   - `firstViolation` is a DIAGNOSIS. `value is not lossless JSON` does not tell anyone which
 *     field to open; `$.result.events[2].turn` does. It descends only through nodes the
 *     authority has ALREADY rejected, and reports the first node whose own rules fail — so the
 *     path it names is a path the walker really rejects, and a value it calls clean is a value
 *     the walker accepted.
 *
 * The three helpers that label WHY a node was rejected (`isPlainArray`, `isPlainRecord`,
 * `enumerableStringKeys`) mirror the shape of DSH's own four realm-safe predicates, and they are
 * labels only: for a cross-realm object they could name the wrong reason, and the PATH would
 * still be right, because the path comes from the authority. Nothing in this file decides
 * acceptance by its own rules.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ the installation --- */

/** The DSH installation this repository's gates read. Overridable, like every other gate. */
export const DEFAULT_DSH_APP_ROOT = 'C:/Users/12252/AppData/Local/Programs/DSH Desktop/resources/app';

export function dshAppRoot(env = process.env) {
  const configured = typeof env?.DSH_APP_ROOT === 'string' ? env.DSH_APP_ROOT.trim() : '';
  return configured || DEFAULT_DSH_APP_ROOT;
}

export function dshModulesDir(env = process.env) {
  return join(dshAppRoot(env), 'node_modules', '@deepseek-ai');
}

/** A `file:` URL for one file under the installation's `@deepseek-ai` scope. */
export function dshModuleUrl(relative, env = process.env) {
  return pathToFileURL(join(dshModulesDir(env), relative)).href;
}

/**
 * Load DSH's own lossless-JSON walker from the installation.
 *
 * A missing installation is reported as a missing PREMISE, not worked around: a gate that
 * substituted its own walker would be measuring its own opinion of the boundary, which is the
 * one thing this module exists to avoid.
 */
export async function loadDshWalker(env = process.env) {
  const path = join(dshModulesDir(env), 'dsh-util-values', 'lib', 'index.js');
  if (!existsSync(path)) {
    const error = new Error(
      `the DSH installation's value walker is not at ${path}: this check measures DSH's own output ` +
        'boundary and cannot be run without it. Set DSH_APP_ROOT if the installation lives elsewhere.',
    );
    error.code = 'DSH_INSTALL_ABSENT';
    throw error;
  }
  const module = await import(pathToFileURL(path).href);
  if (typeof module.snapshotJsonValue !== 'function') {
    const error = new Error(`${path} exports no snapshotJsonValue, so the boundary rule cannot be read from it`);
    error.code = 'WALKER_ABSENT';
    throw error;
  }
  return {
    path,
    snapshotJsonValue: module.snapshotJsonValue,
    isJsonValue: typeof module.isJsonValue === 'function' ? module.isJsonValue : undefined,
  };
}

/* --------------------------------------------------------------- the path diagnosis --- */

/**
 * The label for a node the authority has already rejected. Order follows `walkJsonValue`: the
 * primitive tests at `:96-109`, then the array branch at `:111-128`, then the object branch.
 */
function ownDefect(value, ancestors) {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return null;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN is not a JSON value';
    if (!Number.isFinite(value)) return `${value} is not a finite JSON number`;
    if (Object.is(value, -0)) return '-0 is rejected by the walker (`Object.is(current, -0)` at :105)';
    return null;
  }
  if (typeof value !== 'object') {
    // `undefined`, functions, symbols and bigints all arrive here, at
    // `if (typeof current !== "object") return void 0` (`:109`).
    return `${typeof value} is not a JSON value (rejected at \`typeof current !== "object"\`, :109)`;
  }
  if (ancestors.has(value)) return 'a cycle: this object is its own ancestor in this value';
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return 'an array whose prototype is not the intrinsic Array.prototype';
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      return (
        `an array carrying more own keys than its length implies (length=${value.length}, ` +
        `ownKeys=${Reflect.ownKeys(value).length}) — a hole or an extra property`
      );
    }
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    const name = prototype?.constructor?.name ?? 'null';
    return (
      `not a plain object: its prototype is ${name}.prototype, and the walker accepts only a plain ` +
      'or null-prototype record (`hasPlainObjectPrototype`, :34-38)'
    );
  }
  const keys = Reflect.ownKeys(value);
  const offending = keys.find(
    (key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key),
  );
  if (offending !== undefined) {
    return (
      `own key ${typeof offending === 'symbol' ? String(offending) : JSON.stringify(offending)} is a symbol or ` +
      'non-enumerable, and the walker discards what JSON would discard (`enumerableStringKeys`, :40-44)'
    );
  }
  return null;
}

/** The children of one node, in the order `walkJsonValue` visits them. */
function childrenOf(value) {
  const children = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) children.push([`${index}`, value[index], true]);
    return children;
  }
  for (const key of Reflect.ownKeys(value)) children.push([String(key), value[key], false]);
  return children;
}

/**
 * Name the first node the authority rejects, in the order the authority walks.
 *
 * @param root - a value `snapshotJsonValue` has already rejected.
 * @param snapshotJsonValue - DSH's own walker. The only thing that decides validity here.
 * @param options.budget - a ceiling on nodes visited, so a diagnosis of a huge value cannot
 *   become the slowest thing in a gate. The default is far above any envelope this bundle builds.
 * @returns `{ path, reason }`; `path` uses `$`, `.key` and `[index]`.
 */
export function firstViolation(root, snapshotJsonValue, options = {}) {
  const budget = Number.isFinite(options.budget) ? Number(options.budget) : 50000;
  let visited = 0;
  const ancestors = new Set();

  const accepted = (value) => {
    try {
      return snapshotJsonValue(value) !== undefined;
    } catch {
      // A throwing getter or proxy trap is a rejection too — the registry turns it into
      // `value snapshot failed: …`, which is the same class of failure to a caller.
      return false;
    }
  };

  const visit = (value, path) => {
    visited += 1;
    if (visited > budget) {
      return { path, reason: `the diagnosis budget (${budget} nodes) ran out before the violation was located` };
    }
    // The authority first: this node's whole subtree, or nothing below it can be the answer.
    if (accepted(value)) return null;
    const defect = ownDefect(value, ancestors);
    if (defect !== null) return { path, reason: defect };
    ancestors.add(value);
    for (const [key, child, isIndex] of childrenOf(value)) {
      const found = visit(child, isIndex ? `${path}[${key}]` : `${path}.${key}`);
      if (found !== null) {
        ancestors.delete(value);
        return found;
      }
    }
    ancestors.delete(value);
    // Unreachable while the authority and the labels agree. Reported rather than swallowed:
    // a silent `null` here would read as "clean" for a value the walker rejected.
    return { path, reason: 'the walker rejected this value and no single node in it explains why' };
  };

  return visit(root, '$');
}

/**
 * The full fact for one value: whether DSH's walker accepts it, and where it dies if not.
 *
 * @returns `{ ok, path, reason, detached }` — `detached` is the walker's own snapshot when it
 *   accepted, so a caller can hand on exactly the bytes the registry would have.
 */
export function losslessReport(value, snapshotJsonValue) {
  let detached;
  try {
    detached = snapshotJsonValue(value);
  } catch (error) {
    return {
      ok: false,
      path: '$',
      reason: `the walker threw while reading this value: ${error?.message ?? error}`,
      detached: undefined,
    };
  }
  if (detached !== undefined) return { ok: true, path: null, reason: '', detached };
  const found = firstViolation(value, snapshotJsonValue);
  return { ok: false, path: found.path, reason: found.reason, detached: undefined };
}

/** One line, for a report: `ok` or the path and the reason. */
export function describeReport(report) {
  return report.ok ? 'lossless JSON' : `${report.path}: ${report.reason}`;
}

/* ------------------------------------------------------ every value a tool hands back --- */

/**
 * Wrap a tools registry so every definition registered through it has its RAW return value
 * recorded before DSH validates it.
 *
 * This is what makes a path reportable at all. When the registry rejects a value it throws and
 * the value is gone — the caller sees `INVALID_TOOL_OUTPUT` and nothing else, which is exactly
 * the shape that made the last two incidents take a by-hand trace to locate. The wrapper keeps
 * the value, so a gate can say `$.result.events[2].turn`.
 *
 * The wrapper changes nothing else: every member is read from the real registry and bound to
 * it, so `ctx.tools.execute`, `schemas`, `get` and the run's own nested dispatches all reach the
 * registry they always did. Only `register` is intercepted, and only to substitute a definition
 * whose `execute` returns exactly what the original returned.
 */
export function createRecordingRegistry(tools, sink) {
  const definitions = new Map();
  /* One sink may be shared by several registries, so a gate can take a mark before a dispatch
   * and read every value body that ran underneath it — including a run's own nested tool calls. */
  const calls = Array.isArray(sink) ? sink : [];
  const proxy = new Proxy(tools, {
    get(target, property) {
      if (property === 'register') {
        return (definition) => {
          definitions.set(definition.name, definition);
          return target.register({
            ...definition,
            async execute(args, exec) {
              const value = await definition.execute(args, exec);
              calls.push({ tool: definition.name, args, value });
              return value;
            },
          });
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return {
    tools: proxy,
    definitions,
    calls,
    /** The raw value the Nth dispatch of `tool` returned, or `undefined` if it never returned. */
    lastValueFor(tool) {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        if (calls[index].tool === tool) return calls[index];
      }
      return null;
    },
  };
}

/* ------------------------------------------------------ what a tool DECLARES it returns --- */

/**
 * Walk everything a tool definition declares, before any call is made.
 *
 * A declared `parameters` or `output.schema` is not decoration: DSH compiles the first into the
 * input validator and publishes the second as the output contract, and either reaches a caller
 * through `agent_api_catalog { detail: 'full' }`. A non-lossless schema would be rejected at the
 * same boundary, one layer up.
 *
 * `output.render` is deliberately NOT called here. It crosses its own boundary
 * (`snapshotProjection`, `dsh-tools/lib/types/index.js:91-104`) on every dispatch, and calling it
 * a second time would be measuring this gate's copy of a projection the registry already made —
 * an assertion that could not fail. A render that returns something the walker rejects surfaces
 * through the dispatch assertions instead, with `output.render returned non-lossless JSON` in the
 * registry's own message.
 *
 * @returns an array of `{ at, path, reason }`, one per rejected declared field. Empty means clean.
 */
export function declaredOutputFindings(definition, snapshotJsonValue) {
  const findings = [];
  const consider = (at, value) => {
    const report = losslessReport(value, snapshotJsonValue);
    if (!report.ok) findings.push({ at, path: report.path, reason: report.reason });
  };
  consider('name', definition?.name);
  consider('description', definition?.description);
  consider('parameters', definition?.parameters);
  consider('output.schema', definition?.output?.schema);
  return findings;
}
