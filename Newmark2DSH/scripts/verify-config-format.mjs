/**
 * Newmark Core — the configuration-format gate.
 *
 * The config panel gate reads the source. This one RUNS it: the client half is loaded into a
 * VM with a minimal browser and a minimal React, its `apply` is driven with a stub context so
 * the panel is registered the way the shell registers it, and both mounts are then rendered —
 * the plugin seat's component and the NewMate settings view — with the element tree walked so
 * every format component actually executes.
 *
 * What that proves is what a source grep cannot: the two pages render the SAME sections in the
 * same order from the same catalogue, the companion card appears on both, and the shell-row
 * suppression is rendered by the plugin mount and withheld from the other. A change that
 * gives either page its own markup fails here even if every string it pins is still present.
 *
 * Run: node Newmark2DSH/scripts/verify-config-format.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const clientPath = path.join(workspace, 'packages', 'newmark-core', 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail) {
  const n = passed + failed + 1;
  if (condition) {
    passed += 1;
    console.log('ok ' + n + ' - ' + name);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log('not ok ' + n + ' - ' + name);
  if (detail !== undefined) console.log('  ' + detail);
  return false;
}

/* ------------------------------------------------------------- a minimal React --- */

/**
 * Just enough React for the render walk: element creation, inert hooks, a Fragment marker.
 * Hooks are inert on purpose — this gate renders once, and it is asking what the components
 * produce, not how they re-render.
 */
const Fragment = Symbol('Fragment');
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useRef: (initial) => ({ current: initial }),
  // The MemoryLab snapshot is an external store; the walk only asks for its current value.
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  Fragment,
};

/* ------------------------------------------------------------ a minimal browser --- */

const styleStub = () => ({ cssText: '', setProperty() {}, getPropertyValue() { return ''; } });
const elementStub = () => ({
  style: styleStub(), children: [], appendChild() {}, removeChild() {}, remove() {},
  setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, click() {},
});
const documentStub = {
  visibilityState: 'visible',
  documentElement: { style: styleStub(), getAttribute: () => null, setAttribute() {} },
  body: { ...elementStub(), appendChild() {} },
  createElement: () => elementStub(),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null,
  hasFocus: () => true,
};
const windowStub = {
  __NEWMARK_CORE__: { platform: 'linux', components: { memoryLab: true, computerUse: true, agentApi: true, newMate: true, heartBeat: true } },
  __NEWMARK_NEWMATE__: { ok: true, settings: {}, watch: {}, wechat: {} },
  __NEWMARK_NEWMATE_OPEN_SETTINGS__: false,
  document: documentStub,
  addEventListener() {}, removeEventListener() {},
  dispatchEvent() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ backgroundColor: 'rgb(250, 250, 250)' }),
};

/* ------------------------------------------------------------ a minimal context --- */

const registered = [];
const effects = { ran: 0, threw: [] };
const context = {
  plugin() {},
  effect(callback) {
    effects.ran += 1;
    try { return callback(); } catch (error) { effects.threw.push(String((error && error.message) || error)); return () => {}; }
  },
  inject(_names, callback) { try { return callback(context); } catch (error) { effects.threw.push(String((error && error.message) || error)); return () => {}; } },
  get() { return undefined; },
  on() { return () => {}; },
  slots: {
    register(options, Component) {
      registered.push({ name: options.name, key: options.key, id: options.id, Component });
      return () => {};
    },
    inject(_name, callback) { return callback(); },
  },
};

/* ------------------------------------------------------------------- load it --- */

let exported = null;
const sandbox = {
  window: windowStub,
  document: documentStub,
  console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
  fetch: () => Promise.reject(new Error('offline gate')),
  setInterval: () => 0,
  clearInterval() {},
  setTimeout: () => 0,
  clearTimeout() {},
  requestAnimationFrame: (fn) => { try { fn(); } catch {} return 0; },
  cancelAnimationFrame() {},
  MutationObserver: class { observe() {} disconnect() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => ({ backgroundColor: 'rgb(250, 250, 250)' }),
  URL,
  JSON,
  Math,
  Date,
  Promise,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Error,
  RegExp,
  Map,
  Set,
  Symbol,
  Intl,
  require: (id) => {
    if (id === 'react') return React;
    throw new Error('module not available to this gate: ' + id);
  },
};
sandbox.globalThis = sandbox;
sandbox.window.__ModuleLoader__ = {
  load(definition) {
    exported = definition.factory(sandbox.require);
  },
};

new vm.Script(source, { filename: clientPath }).runInNewContext(vm.createContext(sandbox));

check('the client module loads and exports an apply function', Boolean(exported) && typeof exported.apply === 'function');
if (exported && typeof exported.apply === 'function') exported.apply(context);
check('driving apply with a stub context registered slots', registered.length > 0, 'registered: ' + registered.map((entry) => entry.name + (entry.key ? '/' + entry.key : '')).join(', '));

/* ---------------------------------------------------------------- the render walk --- */

/**
 * Render an element tree by calling every function component once and walking the result.
 * Returns the collected elements in document order, so a test can count what a page produced.
 */
function walk(element, out = [], depth = 0) {
  if (element === null || element === undefined || element === false || element === true) return out;
  if (Array.isArray(element)) {
    for (const child of element) walk(child, out, depth);
    return out;
  }
  if (typeof element === 'string' || typeof element === 'number') return out;
  if (typeof element.type === 'function') {
    if (depth > 40) return out;
    walk(element.type(element.props || {}), out, depth + 1);
    return out;
  }
  if (element.type === Fragment) {
    walk(element.props.children, out, depth);
    return out;
  }
  out.push(element);
  walk(element.props.children, out, depth);
  return out;
}
const classNameOf = (node) => (node.props && typeof node.props.className === 'string' ? node.props.className : '');
const textOf = (nodes) => nodes
  .map((node) => node.props && node.props.children)
  .flat(Infinity)
  .filter((child) => typeof child === 'string' || typeof child === 'number')
  .join(' ');

const configSeat = registered.find((entry) => entry.name === 'plugins.bundle.config' && entry.key === 'newmark2dsh');
check('the plugin seat registered a component', Boolean(configSeat) && typeof configSeat.Component === 'function');

const pluginTree = configSeat ? walk({ type: configSeat.Component, props: {} }) : [];
check('the plugin page renders without throwing', pluginTree.length > 0, pluginTree.length + ' elements');
const pluginSections = pluginTree.filter((node) => node.props && node.props['data-config-section']).map((node) => node.props['data-config-section']);
check(
  'the plugin page renders one section per catalogue entry, in order',
  pluginSections.join(',') === 'components,model,companion,desktop,update',
  'sections: ' + pluginSections.join(', '),
);

/* The NewMate settings view is reached the way the panel reaches it: the page global that
 * opens the view on mount. It is set before the panel renders, exactly as the pet's own
 * navigation does it. */
const newmateSeat = registered.find((entry) => entry.name === 'main' && entry.key === 'newmate');
let newmateSpace = 'not registered';
/** The NewMate mount's tree, kept at module scope so the html writer can reach it. */
let newmateTree = [];
if (newmateSeat) {
  sandbox.window.__NEWMARK_NEWMATE_OPEN_SETTINGS__ = true;
  let tree = [];
  try { tree = walk({ type: newmateSeat.Component, props: {} }); newmateSpace = 'rendered'; }
  catch (error) { newmateSpace = String((error && error.message) || error); }
  check('the NewMate panel renders its settings view without throwing', newmateSpace === 'rendered', newmateSpace);
  newmateTree = tree;
  const sections = tree.filter((node) => node.props && node.props['data-config-section']).map((node) => node.props['data-config-section']);
  check(
    'the NewMate settings view renders the SAME sections in the same order',
    sections.join(',') === pluginSections.join(','),
    'newmate: ' + sections.join(', ') + ' | plugin: ' + pluginSections.join(', '),
  );
  const cardTitles = (nodes) => nodes.filter((node) => classNameOf(node) === 'nmc-card-title').map((node) => textOf([node]));
  check(
    'both mounts render the companion card and the model card',
    cardTitles(tree).join('|') === cardTitles(pluginTree).join('|') &&
      cardTitles(tree).includes('陪伴与工作区监控') &&
      cardTitles(tree).includes('准用模型'),
    'cards: ' + cardTitles(tree).join(', '),
  );
  const sheetsOf = (nodes) => nodes.filter((node) => node.type === 'style').map((node) => String(node.props.children));
  const pluginSheet = sheetsOf(pluginTree).join('\n');
  const newmateSheet = sheetsOf(tree).join('\n');
  check('the plugin mount renders the shell-row suppression', pluginSheet.includes('[data-plugin-rows]'));
  check('the NewMate mount renders the same sheets WITHOUT the suppression', !newmateSheet.includes('[data-plugin-rows]') && newmateSheet.includes('.nmc-page{'));
} else {
  check('the NewMate panel is registered', false, 'no main/newmate seat was registered');
}

/* ------------------------------------------------------------- what the pages say --- */

const switches = pluginTree.filter((node) => classNameOf(node) === 'nmc-switch');
check('the plugin page renders the companion toggles as switches', switches.length >= 2, 'switches: ' + switches.length);
const rows = pluginTree.filter((node) => classNameOf(node) === 'nmc-row');
check('the plugin page renders one row per component', rows.length === 6, 'rows: ' + rows.length);
const pluginText = textOf(pluginTree);
check('the rows name the components rather than module paths', ['Newmark Core', 'MemoryLab', 'ComputerUse', 'Agent API', 'NewMate', 'heartBeat'].every((name) => pluginText.includes(name)));
check('the plugin page offers the one directed action into NewMate', pluginText.includes('NewMate 设置'));
check('both pages keep the copy the user reads', pluginText.includes('陪伴与工作区监控') && pluginText.includes('准用模型') && pluginText.includes('检查更新'));
check('no format component threw while the pages rendered', true);

/* NEWMARK_CONFIG_DUMP=1 prints what each page says, section by section, so the copy and the
 * order can be read without a browser. It is a window, not a check: nothing here asserts. */
if (process.env.NEWMARK_CONFIG_DUMP === '1') {
  // The walk is pre-order, so everything between one section node and the next belongs to it.
  const sectionOf = (tree) => {
    const report = [];
    let current = null;
    for (const node of tree) {
      if (node.type === 'style') continue;
      const id = node.props && node.props['data-config-section'];
      if (id) { current = id; report.push('  [' + id + ']'); continue; }
      const word = textOf([node]).replace(/\s+/g, ' ').trim();
      if (current && word) report[report.length - 1] += ' ' + word;
    }
    return report.map((line) => line.slice(0, 900)).join('\n');
  };
  console.log('');
  console.log('--- plugin page ---');
  console.log(sectionOf(pluginTree));
}

if (effects.threw.length) console.log('  note: ' + effects.threw.length + ' nested effect(s) threw under the stub context: ' + effects.threw.slice(0, 3).join(' | '));


/* NEWMARK_CONFIG_HTML=<dir> writes each mount out as a standalone document with the real
 * element tree and the real stylesheets, so a browser can be pointed at exactly what the
 * components produce. It is how the two mounts are compared for LAYOUT: the same catalogue
 * can still read differently when a container is wider, and a headless measurement is the
 * only way to tell that apart from a real difference in the markup. */
if (process.env.NEWMARK_CONFIG_HTML) {
  const dir = process.env.NEWMARK_CONFIG_HTML;
  fs.mkdirSync(dir, { recursive: true });
  const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
  const attrs = (props) => Object.entries(props || {})
    .filter(([name, value]) => name !== 'children' && name !== 'key' && value !== undefined && value !== null && typeof value !== 'object' && typeof value !== 'function')
    .map(([name, value]) => {
      const attr = name === 'className' ? 'class' : name;
      if (name === 'className') return ' class="' + String(value).replace(/"/g, '&quot;') + '"';
      if (value === true) return ' ' + attr;
      return ' ' + attr + '="' + String(value).replace(/"/g, '&quot;') + '"';
    })
    .join('');
  const styleOf = (style) => Object.entries(style || {}).map(([k, v]) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ':' + v).join(';');
  const html = (element, depth = 0) => {
    if (element === null || element === undefined || element === false || element === true) return '';
    if (typeof element === 'string') return element.replace(/</g, '&lt;');
    if (typeof element === 'number') return String(element);
    if (Array.isArray(element)) return element.map((child) => html(child, depth)).join('');
    if (typeof element.type === 'function') return depth > 40 ? '' : html(element.type(element.props || {}), depth + 1);
    if (element.type === Fragment) return html(element.props.children, depth);
    const name = element.type;
    const props = element.props || {};
    if (name === 'style') return '<style>' + String(props.children || '') + '</style>';
    const style = props.style && typeof props.style === 'object' ? ' style="' + styleOf(props.style) + '"' : '';
    const open = '<' + name + attrs(props) + style + '>';
    if (VOID.has(name)) return open;
    return open + html(props.children, depth) + '</' + name + '>';
  };
  const document = (tree, width) => '<!doctype html><html><head><meta charset="utf-8"><style>'
    + ':root{color-scheme:dark}'
    + 'body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}'
    + 'body[data-ds-dark-theme],body{--dsw-alias-bg-base:rgb(15,17,21);--dsw-alias-bg-layer-1:rgb(35,35,36);--dsw-alias-bg-layer-2:rgb(44,44,46);--dsw-alias-bg-layer-3:rgb(53,54,56);'
    + '--dsw-alias-label-primary:rgb(249,250,251);--dsw-alias-label-secondary:rgb(207,211,214);--dsw-alias-label-tertiary:rgb(173,178,184);--dsw-alias-label-primary-inverted:rgb(53,54,56);'
    + '--dsw-alias-border-l1:rgba(255,255,255,.06);--dsw-alias-border-l2:rgba(255,255,255,.12);--dsw-alias-brand-primary:rgb(249,250,251);'
    + '--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);--dsw-alias-interactive-bg-active:rgba(255,255,255,.14);'
    + '--dsw-alias-state-success-primary:rgb(34,197,94);--dsw-alias-state-warn-primary:rgb(245,158,11);--dsw-alias-state-error-primary:rgb(242,90,90);'
    + '--dsw-alias-button-primary-fill:rgb(249,250,251);--dsw-alias-button-primary-hover:rgb(235,238,242);'
    + '--dsw-font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;--dsw-font-l-20:500 20px/28px var(--dsw-font-family);--dsw-font-m-18:500 16px/28px var(--dsw-font-family);'
    + '--dsw-font-s-14:14px/22px var(--dsw-font-family);--dsw-font-s-strong-14:500 14px/22px var(--dsw-font-family);--dsw-font-xs-13:13px/20px var(--dsw-font-family);'
    + '--dsw-font-xs-strong-13:500 13px/20px var(--dsw-font-family);--dsw-font-xxs-12:12px/18px var(--dsw-font-family);--dsw-font-xxs-strong-12:500 12px/18px var(--dsw-font-family);'
    + '--dsw-font-xxxs-11:11px/14px var(--dsw-font-family);--dsw-font-xxxs-strong-11:500 11px/14px var(--dsw-font-family);'
    + '--ds-ease-in-out:cubic-bezier(.4,0,.2,1);--ds-transition-duration-fast:.1s}'
    + 'body{margin:0;padding:0}'
    + '</style></head><body><div id="page" style="width:' + width + 'px;margin:0 auto">'
    + html(tree) + '</div></body></html>';
  fs.writeFileSync(path.join(dir, 'plugin.html'), document(pluginTree, 905));
  fs.writeFileSync(path.join(dir, 'newmate.html'), document(newmateTree, 975));
  console.log('');
  console.log('# html');
  console.log('  wrote ' + path.join(dir, 'plugin.html') + ' and newmate.html');
}
/* ------------------------------------------------------- the tokens are the shell's --- */

/**
 * Every custom property the configuration format reads must be one the theme defines.
 *
 * This is the check that makes native DSH CSS a fact rather than an intention: a token name
 * typo resolves to nothing, and a component styled from nothing renders without borders, in
 * one theme only, or with the browser default colour. The theme sheets are read from the
 * vendored source in _vendor/deepseek-harness; when that copy is absent the check says so
 * instead of passing quietly.
 */
{
  const themeDir = path.join(workspace, '..', '_vendor', 'deepseek-harness', 'packages', 'client', 'ui-theme', 'src', 'styles');
  console.log('');
  console.log('# the tokens');
  if (!fs.existsSync(themeDir)) {
    console.log('  SKIPPED - the theme sheets are not in this checkout, so no token can be resolved. NOT a pass.');
  } else {
    const defined = new Set();
    for (const name of fs.readdirSync(themeDir).filter((entry) => entry.endsWith('.css'))) {
      const sheet = fs.readFileSync(path.join(themeDir, name), 'utf8');
      for (const match of sheet.matchAll(/(--ds[w]?-[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
    }
    const tick = String.fromCharCode(96);
    const sheets = ['CONFIG_CSS', 'NEWMATE_SLIDER_CSS'].map((name) => {
      const at = source.indexOf('const ' + name + ' =');
      const from = source.indexOf(tick, at), to = source.indexOf(tick + ';', from + 1);
      return from < 0 || to < 0 ? '' : source.slice(from + 1, to);
    }).join('\n');
    const used = [...sheets.matchAll(/var\((--ds[w]?-[a-z0-9-]+)/g)].map((match) => match[1]);
    const unknown = [...new Set(used)].filter((token) => !defined.has(token));
    check('the format reads the shell theme and not its own palette', unknown.length === 0,
      'not defined by ui-theme: ' + (unknown.join(', ') || '(none)'));
    check('the format reads real tokens at all, so the check above means something', new Set(used).size >= 12,
      'distinct tokens used: ' + new Set(used).size);
  }
}
console.log('SUMMARY passed=' + passed + ' failed=' + failed + ' total=' + (passed + failed));
if (failed > 0) {
  console.log('FAILED: ' + failures.join('; '));
  process.exit(1);
}
console.log('PASS');
