/**
 * Drive the MemoryLab detail view outside a browser.
 *
 * `react-dom` is not installed on this machine, so a real DOM render is impossible.
 * What this does instead is execute the REAL client module and the REAL `DetailView`
 * against a store the caller controls, and hand back the element tree — the same
 * technique `verify-newmark-core-client.mjs` already uses for the panel as a whole,
 * lifted into one place so the harness and any probe cannot drift into driving two
 * different things.
 *
 * The hook shim is deliberately the same one: per-component persistent state, so a
 * component can be called again after a setter changed and return what React would.
 */
import path from 'node:path';
import { mountCore } from './mount-newmark-core.mjs';

/**
 * What the renderer stand-in claims to recognise, and nothing more.
 *
 * The spec reads this to build its assertions, so the two cannot drift: a syntax added
 * here without an assertion, or an assertion about a syntax the stand-in does not handle,
 * both show up as a failure rather than as a quiet gap.
 */
export const SHIM_RECOGNISES = Object.freeze({
  heading: 'ATX heading (`# …`) → an `h1`–`h6` element',
  fence: 'triple-backtick fence → a `pre` element',
  inlineMath: '`$…$` → a `span` element',
  displayMath: '`$$` block → a `div` element',
  listItem: '`- ` item → an `li` element',
});

/**
 * Turn Markdown source into harness-shaped elements, for the renderer stand-in.
 *
 * Deliberately minimal: it is not a Markdown parser and does not try to be one. It exists
 * so that "the body was parsed" and "the body was printed" produce DIFFERENT trees, which
 * is the only way to assert the difference without the real renderer. Anything outside
 * {@link SHIM_RECOGNISES} falls through as literal text — which is the honest outcome, and
 * the reason an assertion here cannot pass by accident.
 */
export function shimRenderBlocks(h, text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  let fence = null;
  let math = null;
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (fence === null) fence = [];
      else { out.push(h('pre', { className: 'md-code-block' }, fence.join('\n'))); fence = null; }
      continue;
    }
    if (fence !== null) { fence.push(line); continue; }
    if (line.trim() === '$$') {
      if (math === null) math = [];
      else { out.push(h('div', { className: 'katex-display' }, math.join('\n'))); math = null; }
      continue;
    }
    if (math !== null) { math.push(line); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { out.push(h(`h${heading[1].length}`, null, heading[2])); continue; }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) { out.push(h('li', null, item[1])); continue; }
    if (/\$[^$\n]+\$/.test(line)) {
      const parts = line.split(/(\$[^$\n]+\$)/).filter((part) => part !== '');
      out.push(h('p', null, ...parts.map((part) => (part.startsWith('$') && part.endsWith('$') ? h('span', { className: 'katex' }, part.slice(1, -1)) : part))));
      continue;
    }
    if (line.trim() !== '') out.push(h('p', null, line));
  }
  if (fence !== null) out.push(h('pre', { className: 'md-code-block' }, fence.join('\n')));
  if (math !== null) out.push(h('div', { className: 'katex-display' }, math.join('\n')));
  return out;
}

/** A hook shim with per-component persistent state. */
export function createHooks() {
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
      if (!same) { entry.value = factory(); entry.deps = deps; }
      return entry.value;
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot, getServerSnapshot) {
      return (getServerSnapshot || getSnapshot)();
    },
  };

  function render(Component, props) {
    component = Component;
    cursor = 0;
    setters = [];
    return Component(props || {});
  }

  return { React, render, lastSetters: () => setters };
}

export function textOf(node) {
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

export function findAll(node, predicate, out = []) {
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

/** Expand every function component into the tree it returns. */
export function expand(node, hooks) {
  if (node === null || node === undefined || node === false || node === true) return node;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, hooks));
  if (typeof node !== 'object' || !('type' in node)) return node;
  if (typeof node.type === 'function') return expand(hooks.render(node.type, node.props), hooks);
  return { type: node.type, props: node.props, children: expand(node.children, hooks) };
}

/**
 * A `.ml-col` column, found by the title it carries.
 *
 * Not `cols[2]`: the detail view has three columns today and a positional rule
 * would silently read the wrong one the moment that changed.
 */
export function columnTitled(tree, title) {
  const cols = findAll(tree, (n) => (n.props?.className || '').split(/\s+/).includes('ml-col'));
  return cols.find((col) => findAll(col, (n) => (n.props?.className || '') === 'ml-col-title' && textOf(n) === title).length > 0) || null;
}

/**
 * What the COMPONENTS column actually draws, in document order.
 *
 * The column holds the child-tag buttons ABOVE its `Components` title, so the walk
 * starts at the title and keeps only what follows it. Returns `{ rows, empty }`:
 * the component buttons, and whether the "No components in this tag" note is drawn.
 */
export function componentColumn(tree) {
  const title = findAll(tree, (n) => (n.props?.className || '') === 'ml-col-title' && textOf(n) === 'Components')[0];
  if (!title) return null;
  // The note and the rows are siblings after the title inside the same column.
  const col = findAll(tree, (n) => (n.props?.className || '').split(/\s+/).includes('ml-col'))
    .find((c) => c.children.some((child) => child === title));
  if (!col) return null;
  const after = col.children.slice(col.children.indexOf(title) + 1);
  const rows = [];
  let empty = false;
  for (const child of after) {
    if ((child.props?.className || '') === 'ml-empty') { empty = true; continue; }
    for (const button of findAll(child, (n) => n.type === 'button' && (n.props?.className || '').startsWith('ml-node'))) {
      rows.push({
        slug: button.props.key,
        name: textOf(button).replace(/\s*rev\s*\d+\s*$/, '').trim(),
        selected: (button.props.className || '').split(/\s+/).includes('selected'),
      });
    }
  }
  return { rows, empty };
}

/** The preview pane's title — which component's body is being read. */
export function previewTitle(tree) {
  const title = findAll(tree, (n) => (n.props?.className || '') === 'ml-preview-title')[0];
  return title ? textOf(title) : '';
}

/**
 * The COMPONENTS column of the detail view for ONE selection.
 *
 * Renders the whole panel, switches it to 详情, sets the selection and expands
 * what comes back — so the columns, the rows and the preview all come from one
 * render of the real component, exactly as a click in the app produces them.
 *
 * @param selection — what to select, as the panel's own selection object.
 * @param markdown — how the module table answers the primitives package.
 *   `'absent'` (the default) is the real answer on a shell that does not carry
 *   it: the require throws, and the pane must fall back to plain text. `'spy'`
 *   answers with a stand-in `MarkdownText` that records HOW IT WAS CALLED, so
 *   the render path can be asserted at the boundary the pane owns. It is a spy
 *   and not the real renderer: the real one is a browser bundle whose parsers
 *   are not installed on this machine, and pretending a stand-in renders
 *   Markdown would be the exact vacuous assertion this file exists to avoid.
 */
export async function renderDetailColumns({ packagesDir, globals, clientHalf, selection, markdown = 'absent' }) {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: { load(spec) { captured = spec; } },
    ...globals,
    location: { href: 'http://harness/', pathname: '/', reload() {} },
  };
  globalThis.fetch = () => Promise.reject(new Error('detail harness: no fetch'));
  const url = new URL('file:///' + clientHalf.replace(/\\/g, '/'));
  url.searchParams.set('detail', `${selection?.kind || 'none'}:${selection?.slug || selection?.tag || 'none'}:${markdown}:${Math.random()}`);
  await import(url.href);

  /** Every call the pane made to the renderer, so an assertion reads the real arguments. */
  const markdownCalls = [];
  /**
   * The renderer stand-in.
   *
   * It is a SPY first: it records how it was called, which is the boundary the pane owns
   * and the only thing that can be asserted without the real renderer (a browser bundle
   * whose parsers are not installed on this machine).
   *
   * It is also a deliberately THIN renderer, so "was the body parsed or printed?" is
   * answerable from the tree rather than from a call log. What it recognises — ATX
   * headings, fenced code, unordered items and `$`/`$$` maths — is listed in
   * `SHIM_RECOGNISES` below. What it does NOT do is parse Markdown: anything it does not
   * recognise stays literal text, so a body it mangles cannot make an assertion about
   * parsing pass. Its elements are built with the harness's own `createElement`, because
   * `expand` recurses only into the shape that produces.
   */
  function PrimitivesSpyMarkdownText(props) {
    markdownCalls.push(props);
    return {
      type: 'MarkdownText',
      props: { ...props, className: `markdown${props.variant === 'compact' ? ' compact' : ''}` },
      children: shimRenderBlocks(hooks.React.createElement, props.text),
    };
  }
  const hooks = createHooks();
  const moduleTable = {
    react: () => hooks.React,
    '@deepseek-ai/dsh-client-ui-primitives': () => {
      if (markdown !== 'spy') throw new Error('detail harness: no module registered for "@deepseek-ai/dsh-client-ui-primitives"');
      return { MarkdownText: PrimitivesSpyMarkdownText };
    },
  };
  const seats = [];
  captured.factory((name) => {
    if (name in moduleTable) return moduleTable[name]();
    throw new Error(`unexpected require "${name}"`);
  }).apply({
    effect(cb) { const d = cb(); return typeof d === 'function' ? d : () => {}; },
    slots: { inject(key, cb) { seats.push({ key, entry: cb() }); return () => {}; }, register: (o, C) => ({ options: o, Component: C }) },
  });

  const seat = (seats.find((s) => s.key === 'main') || seats[0]).entry;
  hooks.render(seat.Component, {});
  // Hook order in MemoryLabPanel: the store hook, then view, then selection.
  const setters = hooks.lastSetters();
  setters[0]('detail');
  setters[1](selection);
  const tree = expand(hooks.render(seat.Component, {}), hooks);
  return { tree, column: componentColumn(tree), preview: previewTitle(tree), text: textOf(tree), markdownCalls };
}

/**
 * Mount the real core row against a throwaway root, for a controlled store.
 *
 * Each fixture item may carry its own `body`; without one it gets the generated
 * heading-plus-sentence the earlier fixtures used, so existing callers are unaffected.
 * A caller that needs to assert on particular Markdown — a fence, some LaTeX — has to be
 * able to say so, because a body that does not contain the syntax cannot witness whether
 * that syntax is rendered or printed.
 */
export async function mountSyntheticStore({ packagesDir, root, fixture }) {
  const mount = await mountCore({ packagesDir, root });
  const update = mount.tools.get('memory_lab_update');
  if (!update) throw new Error('memory_lab_update is not registered');
  for (const item of fixture) {
    const body = typeof item.body === 'string' ? item.body : `# ${item.name}\n\nbody for ${item.name}.`;
    const answer = await update.execute({ name: item.name, content: body, tags: item.tags, tagPaths: item.tagPaths });
    if (answer && answer.ok === false) throw new Error(`memory_lab_update refused ${item.name}: ${JSON.stringify(answer).slice(0, 200)}`);
  }
  const payload = mount.payload();
  if (payload?.ok !== true) throw new Error('the synthetic mount produced no snapshot');
  return { mount, payload };
}

/** The `packages/` directory of the workspace this file lives in. */
export function packagesDirOf(here) {
  return path.resolve(here, '..', '..', 'packages');
}
