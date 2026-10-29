/**
 * Newmark Core — the config-panel gate.
 *
 * This bundle's page is partly ours and partly the shell's. The panel is official: it
 * rides `plugins.bundle.config`, a documented seat. The suppression of the shell's own
 * component rows is **not** official — there is no slot for it — so it rests on two
 * facts about the shell that this gate checks by reading the installed shell:
 *
 *   1. the rows section carries `data-plugin-rows`, which is what our rule targets;
 *   2. that section is rendered on a bundle's page at all.
 *
 * If a future DSH release changes either, the rows come back. That is not a failure of
 * this plugin — nothing in the plugin API can express the suppression — so the gate
 * fails here, loudly, naming the premise that broke and the visible consequence, rather
 * than letting the panel quietly sit above a row list it was meant to replace.
 *
 * Run: node Newmark2DSH/scripts/verify-config-panel.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const pkgDir = path.join(workspace, 'packages', 'newmark-core');
const clientPath = path.join(pkgDir, 'client.js');
const client = fs.readFileSync(clientPath, 'utf8');

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

/* ------------------------------------------------------- our half of the page --- */

console.log('# the panel');
check(
  'the client registers a panel in the bundle config seat',
  client.includes("ctx.slots.inject('plugins.bundle.config'") &&
    client.includes("name: 'plugins.bundle.config', key: 'newmark2dsh'"),
);
check('the panel is a component this file defines', /function NewmarkConfigPanel\(\)/.test(client));
check(
  'the panel names the components rather than showing module paths',
  client.includes("name: 'MemoryLab'") &&
    client.includes("name: 'ComputerUse'") &&
    client.includes("name: 'Agent API'"),
);
check('Newmark Core is not offered as a switch', client.includes('switchable: false'));
check(
  'the panel shows the Host answer rather than the click',
  client.includes('const answer = model.applied[entry.key]') &&
    client.includes('const on = answered ? answer.mounted :'),
  'the row state is the receipt of the last switch, read back from the route',
);
check(
  'the panel reads the real state on mount',
  client.includes("fetch('/newmark-core/components')"),
);

/* The workspace monitor is configured on the NewMate settings page, not in the plugin config
 * fields: the page saves immediately and the config values are only first-mount defaults. Pin the
 * four controls and the form styling so a later refactor cannot silently drop one. */
check('the settings page exposes only the interval; depth and the DSH weight moved to defaults',
  client.includes("id: 'nmc-watch-interval'") && !client.includes("'nm-watch-depth'") && !client.includes("'nm-watch-dsh'") &&
    client.includes('保留默认值') && client.includes('可在插件配置里调整'),
  'the sentence must stay true: depth is a plugin Config row, the DSH weight is a fixed default',
);
check('the threshold is no longer its own control: it follows the initiative level',
  !client.includes("'nm-watch-threshold'") && client.includes('主动性同时决定触发阈值'),
);
check('companion and monitor are one card, not two settings sections',
  client.includes('陪伴与工作区监控') && !client.includes("h('h2',null,'工作区文件监控')"),
);
check('the level options no longer state per-day message counts',
  client.includes('低 · 更少打扰') && !client.includes('每天最多 1 条') && !client.includes('每天最多 2 条') && !client.includes('每天最多 3 条'),
);
check('number inputs are styled like the selects instead of the browser default',
  client.includes('.nmc-number{') && client.includes('font-variant-numeric:tabular-nums'),
  'the format owns one number control, and it carries the tabular figure set the selects use',
);
check('the advanced values are documented as defaults instead of controls',
  client.includes('3 层 / 0.1 倍') && client.includes('可在插件配置里调整'),
);

/* ------------------------------------------------- the suppression, and its premise --- */

console.log('');
console.log('# the suppression');
check(
  'a rule hides the shell component rows',
  client.includes('[data-plugin-rows] { display: none; }'),
);
check(
  'the suppression is gated on the mount, so the rule is in the DOM only where it is needed',
  client.includes("const PLUGIN_ROWS_CSS = '[data-plugin-rows] { display: none; }';") &&
    client.includes("h('style', null, CONFIG_CSS + NEWMATE_SLIDER_CSS + (suppressRows ? PLUGIN_ROWS_CSS : ''))") &&
    /suppressRows: true,/.test(client) && /suppressRows: false,/.test(client),
  'the plugin mount renders the rule; the NewMate mount renders the same sheets without it',
);
check(
  'the code records why an adjacent-sibling rule was abandoned',
  client.includes('adjacent-sibling rule was tried first and did not work'),
);

/* --------------------------------------- the card stylesheet's override contract --- */

/**
 * THE CONFIG CARD'S OVERRIDE CONTRACT, audited over its whole stylesheet.
 *
 * "Compatible with the style overrides other plugins make" means three things here: no
 * `!important` (an override must still win by cascade order), no selector beginning with a bare
 * element type, and every selector namespaced under a prefix this package owns — `nmc-` for this
 * card. Comments are stripped before matching, because the stylesheet's own comment explains the
 * exception below and mentions the words the checks look for.
 *
 * THE ONE DECLARED EXCEPTION is `[data-plugin-rows]`, and the check that follows requires it to be
 * EXACTLY one: a second unscoped selector has to fail here rather than join a growing list. The
 * card has to reach an element the shell renders outside any slot it can address, so this one
 * cannot be namespaced — what can be asserted is that it is the only one, and that the reason the
 * rule is safe is written down next to it (checked by the two assertions above).
 */
/** One stylesheet constant, read as written: quoted or templated. */
const TICK = String.fromCharCode(96);
const sheetOf = (name) => {
  const at = client.indexOf('const ' + name + ' =');
  if (at < 0) return '';
  const quoted = client.indexOf(TICK, at), plain = client.indexOf("'", at);
  const single = plain >= 0 && (quoted < 0 || plain < quoted);
  const from = single ? plain : quoted;
  if (from < 0) return '';
  const to = client.indexOf((single ? "'" : TICK) + ';', from + 1);
  return to < 0 ? '' : client.slice(from + 1, to);
};
const cardCss = sheetOf('CONFIG_CSS') + String.fromCharCode(10) + sheetOf('PLUGIN_ROWS_CSS');
const cardCode = cardCss.replace(/\/\*[\s\S]*?\*\//g, '');
const cardSelectors = [];
for (const match of cardCode.matchAll(/([^{}]+)\{/g)) {
  const head = match[1].trim();
  // A media condition is not a selector; its nested selectors are still audited.
  if (!head || /^@media\b/.test(head)) continue;
  for (const one of head.split(',')) if (one.trim()) cardSelectors.push(one.trim());
}
const DECLARED_UNSCOPED = ['[data-plugin-rows]'];
const cardUnowned = cardSelectors.filter((sel) => !sel.startsWith('.nmc-') && !DECLARED_UNSCOPED.includes(sel));
const cardBare = cardSelectors.filter((sel) => /^[a-zA-Z]+(\s|$|\[|:|\.|#)/.test(sel));

console.log('');
console.log('# the card stylesheet, audited as a whole');
check('the card stylesheet was really read', cardCss.length > 1000 && cardSelectors.length > 15, `${cardCss.length} chars, ${cardSelectors.length} selectors`);
check(
  'every card selector is namespaced nmc- or is the one declared exception',
  cardUnowned.length === 0,
  `unowned: ${cardUnowned.join(', ') || '(none)'}`,
);
check('no card selector begins with a bare element type', cardBare.length === 0, `bare: ${cardBare.join(', ') || '(none)'}`);
check('the card uses no !important, so an override still wins by cascade order', !cardCode.includes('!important'));
check(
  'the exception list is exactly one selector, and it is still the row-suppression rule',
  cardSelectors.filter((sel) => DECLARED_UNSCOPED.includes(sel)).length === 1,
  `declared: ${cardSelectors.filter((sel) => DECLARED_UNSCOPED.includes(sel)).join(', ') || '(none found)'}`,
);

// The shell side. Read the installed shell; skip with a stated reason if it is absent,
// because a skip and a pass must not look alike.
const shellRoot = process.env.DSH_APP_ROOT || 'C:\\Users\\12252\\AppData\\Local\\Programs\\DSH Desktop\\resources\\app';
const pluginManager = path.join(shellRoot, 'node_modules', '@deepseek-ai', 'dsh-client-ui-plugin-manager', 'lib', 'client.js');

if (!fs.existsSync(pluginManager)) {
  console.log('');
  console.log('# the shell premises');
  console.log('  SKIPPED - the shell is not installed where this gate looks, so the');
  console.log('  suppression cannot be checked against it. NOT a pass.');
} else {
  const shell = fs.readFileSync(pluginManager, 'utf8');
  console.log('');
  console.log('# the shell premises');

  check(
    'the rows section still carries the attribute the rule targets',
    /"data-plugin-rows":\s*true/.test(shell),
    'DSH changed the attributes of its rows section: [data-plugin-rows] no longer matches, ' +
      'so the shell rows reappear under the panel.',
  );
  check(
    'the bundle page still renders the config seat and the rows section',
    /renderSlot\("plugins\.bundle\.config"/.test(shell) && /RowsSection,\s*\{/.test(shell),
    'DSH restructured the bundle page: the panel seat or the rows section moved, so the ' +
      'suppression may no longer be scoped to this page.',
  );
  check(
    'the config seat is still rendered before the rows on that page',
    shell.indexOf('plugins.bundle.config') < shell.indexOf('RowsSection, {'),
    'DSH reordered the bundle page. The rule does not depend on order, but this ordering ' +
      'is what the panel was designed against, so a change is worth looking at.',
  );
}

/* ------------------------------------------------------ the two pages, locked --- */

/**
 * THE LOCK.
 *
 * The plugin page and the NewMate settings view are two mounts of ONE catalogue. What can
 * be asserted without a browser is exactly that structure: one ordered list of sections,
 * one renderer per section, both mounts walking the same list, and no second hand-written
 * copy of a control on either side. Each assertion below fails if a page grows its own
 * markup again — which is what the two pages had before this catalogue existed.
 */
console.log('');
console.log('# the two pages, locked to one catalogue');
check(
  'one ordered list of sections, and both mounts walk it',
  /const CONFIG_SECTION_ORDER = \[([^\]]+)\]/.test(client) &&
    (() => {
      const order = /const CONFIG_SECTION_ORDER = \[([^\]]+)\]/.exec(client)[1];
      const ids = [...order.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      return ids.length >= 4 &&
        ids.every((id) => new RegExp('\\s+' + id + ': \\{', 'm').test(client)) &&
        client.includes('sections: CONFIG_SECTION_ORDER.map');
    })(),
  'a section missing from the order is rendered by nobody; one in it, by both mounts',
);
check(
  'the NewMate settings view is a mount of that catalogue, not its own page',
  /function NewMateSettingsView\(\{ state, act, busy, error, onBack \}\)/.test(client) &&
    /mount: 'newmate'/.test(client) &&
    /mount: 'plugin'/.test(client),
  'the view calls ConfigSurface with mount newmate; the plugin seat calls it with mount plugin',
);
check(
  'the companion card has exactly one definition, rendered by the catalogue',
  (client.match(/function ConfigCompanionCard\(/g) || []).length === 1 &&
    (client.match(/ConfigCompanionCard, \{ model: model\.companion \}/g) || []).length === 1,
  'a second definition, or a hand-written copy at a call site, is the drift this prevents',
);
check(
  'the plugin page can open the same settings inside NewMate',
  client.includes('openNewMateSeat = () => {') &&
    client.includes("layout?.selectPanel?.('newmate')") &&
    client.includes("new CustomEvent('newmark-newmate-open-chat', { detail: { settings: true } })"),
  'the one direction a page can act on: from the plugin seat into NewMate own settings view',
);

/* ------------------------------------------------------------- the format --- */

console.log('');
console.log('# the format');
for (const part of ['ConfigPage', 'ConfigSection', 'ConfigCard', 'ConfigRow', 'ConfigField', 'ConfigNote', 'ConfigSwitch', 'ConfigSelect', 'ConfigNumber', 'ConfigButton']) {
  check(
    'the format defines ' + part + ' exactly once',
    (client.match(new RegExp('function ' + part + '\\(', 'g')) || []).length === 1,
  );
}
check(
  'the format stylesheet is one generation: no selector is defined twice',
  (() => {
    // A media-query override is the one sanctioned repetition: same rule, different
    // viewport. Any other second definition is an accretion like the two generations this
    // stylesheet replaced, where the later block silently overrode the earlier one.
    const strip = (css) => {
      let out = '', index = 0;
      while (index < css.length) {
        const at = css.indexOf('@media', index);
        if (at < 0) { out += css.slice(index); break; }
        out += css.slice(index, at);
        let depth = 1, cursor = css.indexOf('{', at) + 1;
        while (cursor < css.length && depth > 0) {
          if (css[cursor] === '{') depth += 1;
          else if (css[cursor] === '}') depth -= 1;
          cursor += 1;
        }
        index = cursor;
      }
      return out;
    };
    const counts = new Map();
    for (const match of strip(cardCode).matchAll(/([^{}]+)\{/g)) {
      const head = match[1].trim();
      if (!head || head.startsWith('@')) continue;
      counts.set(head, (counts.get(head) || 0) + 1);
    }
    return [...counts.values()].every((count) => count === 1);
  })(),
  'the stylesheet this replaced carried two generations of the same rules, the second overriding the first',
);
check(
  'the format writes no literal colour, so both themes follow the shell',
  !/#[0-9a-fA-F]{3,8}\b/.test(cardCode) && !/\brgba?\(/.test(cardCode) && !/\bhsla?\(/.test(cardCode),
  'colours come from --dsw-* tokens only',
);
check(
  'the format sizes type from the theme scale instead of its own numbers',
  (cardCode.match(/font:var\(--dsw-font-/g) || []).length >= 6,
  'the scale runs --dsw-font-xxxs-11 to --dsw-font-l-20; a bare px font-size is a second type system',
);
check(
  'a component whose state has not been read says so instead of 已禁用',
  client.includes('return payload ? false : null') &&
    client.includes("unknown ? '读取中…'") &&
    client.includes('nmc-dot-pending') &&
    client.includes('disabled: model.pending === entry.key || unknown'),
  'the measured defect: the page opened on 已禁用 / not loaded for five mounted components, then',
  // (the sentence continues on the next line so the detail stays one string)
);
check(
  'the list column count is the format decision, not the container width',
  (() => {
    const rule = (/\.nmc-list\{([^}]*)\}/.exec(cardCode) || [])[1] || '';
    // The single-card sections (.nmc-grid) may size themselves to the container: one card
    // always spans the row. It is the six-row component list that must not.
    return /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(rule) && !/auto-fit|auto-fill/.test(rule);
  })(),
  'the plugin seat is ~905 CSS px wide and the NewMate panel ~1040; an auto-fit list rendered two',
  // (the sentence continues here so the detail stays one string)
);
check(
  'the state label and its action share one line in every row',
  /\.nmc-row-state\{[^}]*align-self:start/.test(cardCode) &&
    !/\.nmc-row-state\{[^}]*align-self:center/.test(cardCode),
  'a centred label measured 26 px below its own button, at every row height',
);
check(
  'the dead settings stylesheet is gone with the markup it styled',
  !/nm-settings-view|nm-settings-bar|nm-initiative-settings|nm-preference-row|nm-toggle-row/.test(client),
  'one page, one set of rules: the chat stylesheet no longer carries a second one for settings',
);
/* ------------------------------------------------------------------ the switches --- */

console.log('');
console.log('# the switches');
const index = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8');
check(
  'the host half keeps the fiber each component was composed into',
  index.includes('const composed = new Map()') && index.includes('composed.set(name, ctx.plugin('),
);
check(
  'unmounting disposes that fiber',
  index.includes('fiber?.dispose?.()'),
);
check(
  'the control route exists and is exact',
  index.includes("path: '/newmark-core/components'") && index.includes("kind: 'exact'"),
);
check(
  'the route refuses anything but GET and POST',
  index.includes("method_not_allowed") && index.includes("req.method === 'GET'"),
);
check(
  'the switches the panel does offer go through this bundle own control route',
  client.includes("fetch('/newmark-core/components'") &&
    !/\.(listPlugins|setPluginEnabled)\(/.test(client) &&
    !/pluginManager\.setPluginEnabled/.test(client.replace(/^\s*\/\/.*$/gm, '')),
  'enabling a Loader row is an id-targeted `disabled` on the profile patch, which this bundle no longer writes',
);
// The client declared `['slots', 'remote', 'remote.pluginManager']` while the preset was
// switched through `pluginManager.setPluginEnabled`. That call could not reach the row —
// `listPlugins()` inventories the profile's INSTALLED packages, and
// `@deepseek-ai/dsh-agent-preset` lives in the DSH installation — so the client resolves
// no remote service at all now. Prose may still name the abandoned mechanism; what must
// not come back is a declaration or a call.
{
  const declared = (client.match(/inject: \[([^\]]*)\]/) || [])[1] || '';
  const keys = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check(
    'the client declares no remote service and no remote namespace',
    keys.length > 0 && keys.every((key) => !key.startsWith('remote')),
    'declared: ' + JSON.stringify(keys),
  );
  check(
    'the client calls no plugin-manager method',
    !/ctx\.remote/.test(client) && !/\.(listPlugins|setPluginEnabled)\(/.test(client),
    'the namespace could not reach the row, so nothing should resolve it',
  );
}

// The preset is NOT switched here any more. It was, on the profile patch, through a library
// in the host half; the user removed the switch — 去除插件配置中的预设dev preset插件开关行，不用插件
// 配置页调控默认预设 — so what this panel must now be is a control surface for the components
// the bundle composes, and nothing else. Three checks hold that line: no preset key reaches
// the route, no profile-patch writer exists to be reached, and the page still switches the
// components it always did.
check(
  'the host route has no preset branch',
  !index.includes('PRESET_COMPONENT_KEY') &&
    !index.includes('setPresetSelected') &&
    !/name === 'preset-dev'/.test(index) &&
    !/name === 'presetDev'/.test(index),
  'the write path is deleted, not merely unreachable from the panel',
);
check(
  'the client has no preset row and sends no preset key',
  !client.includes('presetDev') && !client.includes("name: 'Dev preset'"),
  'a row whose route is gone is the same defect as a route whose row is gone',
);
check(
  'the components the panel does switch are all still offered, and still switchable',
  ['core', 'memoryLab', 'computerUse', 'agentApi', 'newMate', 'heartBeat'].every((key) => client.includes("key: '" + key + "'")) &&
    (client.match(/switchable: true/g) || []).length === 5,
  'switchable rows: ' + (client.match(/switchable: true/g) || []).length + ' (Newmark Core is the sixth row, and not a switch)',
);
// The root rule exists once. A component that restates it works until the rule changes and
// then reads a different store than the core row — a failure no test run would show.
{
  const coreRoot = fs.readFileSync(path.join(pkgDir, 'lib', 'root.js'), 'utf8');
  check(
    'the core holds the only implementation of the root rule',
    /export function resolveRoot/.test(coreRoot) &&
      /os\.homedir\(\)/.test(coreRoot) &&
      /NEWMARK_USER_ROOT/.test(coreRoot),
  );
  for (const component of ['memorylab', 'computeruse']) {
    const file = path.join(pkgDir, 'components', component, 'lib', 'root.js');
    if (!fs.existsSync(file)) {
      check(`components/${component} has a root module`, false, file);
      continue;
    }
    const source = fs.readFileSync(file, 'utf8');
    check(
      `components/${component} re-exports the core root rule instead of restating it`,
      /^export \* from/m.test(source) && !/os\.homedir\(\)|NEWMARK_USER_ROOT|function resolveRoot/.test(source),
      'a second implementation is how two components come to read two stores',
    );
  }
}
check(
  'the host half never writes to the shared user store',
  !/(^|[^.\w])writeFileSync|mkdirSync|rmSync|createWriteStream/.test(index),
  'the host half configures a row through configEditor and writes no file of its own',
);
/* The writer below the route is gone with the route. What is asserted instead is that no
 * module in the shipped package reaches the profile patch at all — the shape a half-removed
 * write path would have. The gate that compares the two declarations reads the profile patch
 * through `scripts/lib/preset-patch.mjs`, which is a gate library and ships with no plugin. */
check(
  'no shipped module addresses the profile patch',
  !fs.existsSync(path.join(pkgDir, 'lib', 'preset-row.js')) &&
    !/\bprofileContext\b/.test(index.replace(/^\/\/.*$/gm, '')) &&
    !/cordis\.patch\.yml/.test(index.replace(/^\/\/.*$/gm, '')),
  'the profile patch was read and written for one purpose, and that purpose is gone',
);
/* The removed writer's own properties — atomic rename, the Loader's parser before the write,
 * and the two-space/four-space field indents — are not asserted here any more: there is no
 * writer to hold to them. What survives of that machinery is the parser, which moved to
 * `scripts/lib/preset-patch.mjs`, and the one property of it the declaration comparison
 * depends on: the `!!js` tag is declared exactly as the Loader declares it, or a patch the
 * Loader reads fine is rejected here. */
{
  const presetPatchLib = fs.readFileSync(path.join(workspace, 'scripts', 'lib', 'preset-patch.mjs'), 'utf8');
  check(
    'the gate library declares the Loader`s own `!!js` tag rather than rejecting expressions',
    presetPatchLib.includes('tag:yaml.org,2002:js') &&
      /parseDocument\(text, \{ customTags: \[JS_TAG\]/.test(presetPatchLib),
    'without that declaration every `!!js` scalar is an unresolved-tag error',
  );
  check(
    'the gate library holds no write path',
    !/writeFileSync|renameSync|writeAtomicSync|planPresetWrite|setPresetSelected/.test(
      presetPatchLib.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n'),
    ),
    'the writer was deleted with the switch; a parser that can also write is half a removal',
  );
}

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
