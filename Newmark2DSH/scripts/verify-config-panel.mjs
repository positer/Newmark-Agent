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
  client.includes('const answer = applied[row.key]') && client.includes('failed ? '),
);
check(
  'the panel reads the real state on mount',
  client.includes("fetch('/newmark-core/components')"),
);

/* The workspace monitor is configured on the NewMate settings page, not in the plugin config
 * fields: the page saves immediately and the config values are only first-mount defaults. Pin the
 * four controls and the form styling so a later refactor cannot silently drop one. */
check('the settings page exposes only the interval; depth and the DSH weight moved to defaults',
  client.includes("'nm-watch-interval'") && !client.includes("'nm-watch-depth'") && !client.includes("'nm-watch-dsh'") && client.includes('高级项保留默认值'),
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
  client.includes('.nm-settings-view .nm-initiative-settings input[type=number]') && client.includes('font-variant-numeric:tabular-nums'),
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
  'the scope comes from the style tag living inside the panel',
  client.includes('h(\'style\', null, CONFIG_CSS+NEWMATE_SLIDER_CSS)') && /function NewmarkConfigPanel\(\)[\s\S]*CONFIG_CSS/.test(client),
  'the rule is unscoped on purpose: it is only in the DOM while this panel renders',
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
const cardCss = (() => {
  const match = /const CONFIG_CSS = `([\s\S]*?)`;/.exec(client);
  return match ? match[1] : '';
})();
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
  ["key: 'memoryLab'", "key: 'computerUse'", "key: 'agentApi'"].every((needle) => client.includes(needle)) &&
    (client.match(/switchable: true/g) || []).length === 3,
  `switchable rows: ${(client.match(/switchable: true/g) || []).length}`,
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
