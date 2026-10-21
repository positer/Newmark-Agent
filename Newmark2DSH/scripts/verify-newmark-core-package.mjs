/**
 * Newmark Core — the packaging gate.
 *
 * "Publishable and works out of the box" is a property a source tree can lose
 * silently: a `files` pattern that stops matching, an import that reaches outside the
 * package, a `private: true` that reappears. Each of those was found by hand while
 * preparing this bundle, so they are asserted here instead.
 *
 * **Nothing here names a component or a count.** The bundle gains components over
 * time, so the rows, the components and the modules a fresh install loads are all
 * discovered from disk (`lib/core-rows.mjs`). Adding a component means adding its
 * directory and composing it from the core row; every assertion below then covers it
 * without being edited.
 *
 * Run: node Newmark2DSH/scripts/verify-newmark-core-package.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRows, readComponents, readComponentRows, readComposedComponents, entryPoints, allSourceFiles } from './lib/core-rows.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const pkgDir = path.join(workspace, 'packages', 'newmark-core');

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

const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const rows = readRows(pkgDir);
const components = readComponents(pkgDir);
const componentRows = readComponentRows(pkgDir);
const composed = readComposedComponents(pkgDir);
const dependencies = Object.keys(manifest.dependencies || {});

/** A `files` entry as a regex over package-relative POSIX paths. */
function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^*]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}
const filePatterns = (manifest.files || []).map(patternToRegex);
const inTarball = (relative) => filePatterns.some((re) => re.test(relative));

/* ------------------------------------------------------------ publishable --- */

console.log('# manifest');
check('the package is not marked private', manifest.private !== true, `private: ${manifest.private}`);
check('the package declares a license', typeof manifest.license === 'string' && manifest.license.length > 0, manifest.license);
check('the package declares a version', typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version), manifest.version);
check('the package declares a description', typeof manifest.description === 'string' && manifest.description.length > 20);
check(
  'the license the manifest points at ships with the package',
  !/SEE LICENSE IN (.+)/.test(manifest.license) || inTarball(manifest.license.match(/SEE LICENSE IN (.+)/)[1]),
  manifest.license,
);
check('the bundle patch ships', inTarball('cordis.patch.yml'));
check('the package carries at least one component', components.length >= 1, `${components.length}`);

/* ------------------------------------------- every import stays in the package */

console.log('');
console.log('# reachable files');

const IMPORT_RX = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function relativeImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  for (const match of text.matchAll(IMPORT_RX)) {
    const spec = match[1] || match[2];
    if (spec && spec.startsWith('.')) found.push(spec);
  }
  return found;
}

// Walk from the entry points a fresh install actually loads.
const entries = entryPoints(pkgDir);
const reachable = new Set();
const queue = [...entries];
const escaped = [];
const missing = [];

while (queue.length > 0) {
  const relative = queue.shift();
  const normalized = relative.replace(/\\/g, '/');
  if (reachable.has(normalized)) continue;
  reachable.add(normalized);

  const absolute = path.join(pkgDir, relative);
  if (!fs.existsSync(absolute)) {
    missing.push(normalized);
    continue;
  }
  if (!normalized.endsWith('.js')) continue;

  for (const spec of relativeImports(absolute)) {
    const relTarget = path.relative(pkgDir, path.resolve(path.dirname(absolute), spec)).replace(/\\/g, '/');
    if (relTarget.startsWith('..')) escaped.push(`${normalized} -> ${spec}`);
    else queue.push(relTarget);
  }
}

check('every entry point of a fresh install exists', missing.length === 0, missing.join(', '));
check('no shipped module imports outside the package', escaped.length === 0, escaped.join(', '));
check(
  'every module reachable from an entry point is matched by a files pattern',
  [...reachable].every(inTarball),
  [...reachable].filter((r) => !inTarball(r)).join(', '),
);

/* Backends and other lazily loaded modules are reached through a *computed*
 * specifier, so no static walk sees them. What matters for packaging is that every
 * library file that exists is shipped. */
const unshipped = allSourceFiles(pkgDir).filter((relative) => !inTarball(relative));
check('every source file in the package is matched by a files pattern', unshipped.length === 0, unshipped.join(', '));

/* ------------------------------------------------- the nested component packages */

console.log('');
console.log('# component packages');

/* The bundle no longer declares its components as `file:` dependencies and no longer
 * gives them rows. Addressing a component as a dependency is what put a `file:///…`
 * module path on the plugin card, and pnpm resolves a `file:` link against the project
 * root, so a registry install failed with ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND. A component
 * is composed by the core row instead, from a path inside this package — while its own
 * manifest stays, because that manifest is what keeps the client-module registry from
 * seeing the bundle's package twice. */
for (const component of components) {
  const name = component.manifest.name;
  check(`component ${component.dir}: ships its own manifest`, inTarball(`components/${component.dir}/package.json`));
  check(
    `component ${component.dir}: declares no client bundle`,
    component.manifest.dsh?.client === undefined,
    JSON.stringify(component.manifest.dsh),
  );
  check(
    `component ${component.dir}: shares the bundle's version`,
    component.manifest.version === manifest.version,
    `${component.manifest.version} vs ${manifest.version}`,
  );
  check(
    `component ${component.dir}: is composed by the core row`,
    composed.includes(`./components/${component.dir}/index.js`),
    composed.length ? composed.join(', ') : 'the core row composes nothing',
  );
  check(
    `component ${component.dir}: is not addressed by a row`,
    !componentRows.some((row) => row.name === name),
    componentRows.map((row) => `${row.id} -> ${row.name}`).join(', ') || 'no component rows',
  );
}

check(
  'every component is composed by the core row and none is depended on',
  components.length >= 1 &&
    components.every((component) => composed.includes(`./components/${component.dir}/index.js`)) &&
    dependencies.length === 0,
  `${components.length} components, ${composed.length} composed paths, ${dependencies.length} dependencies`,
);
check(
  'every composed path is a component of this package, so nothing resolves outside it',
  composed.every((relative) => components.some((component) => relative === `./components/${component.dir}/index.js`)),
  composed.join(', '),
);
check(
  'the core row composes what it imports rather than importing it for effect',
  composed.length === 0 || fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8').includes('ctx.plugin('),
);
check(
  'the manifest declares no dependencies, so no file: link has to resolve',
  dependencies.length === 0,
  dependencies.join(', ') || 'none',
);
check(
  'no file: specifier is left in the manifest',
  !JSON.stringify(manifest).includes('file:'),
  JSON.stringify(manifest.dependencies || {}),
);

/* --------------------------------------------------------------- the patch --- */

console.log('');
console.log('# loader rows');

const patch = fs.readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8');
const rowNames = [...patch.matchAll(/^ {6}name: '([^']+)'$/gm)].map((match) => match[1]);

check('the patch declares at least the bundle row', rows.length >= 1, `${rows.length} rows: ${rows.map((r) => r.id).join(', ')}`);
check('every row id is unique', new Set(rows.map((row) => row.id)).size === rows.length, rows.map((row) => row.id).join(', '));
check(
  'no row leaves the bundle without saying where it comes from',
  rowNames.every((name) => {
    if (name.startsWith('.')) return fs.existsSync(path.resolve(pkgDir, name));
    // A bare name is the bundle itself, a declared component dependency, or a package
    // the harness ships — all of which resolve on a fresh install.
    return name === manifest.name || dependencies.includes(name) || name.startsWith('@deepseek-ai/');
  }),
  rowNames.join(', '),
);
/* Recorded defect (2026-09-30, rounds 10-11), measured against the running profile: a
 * package addressed twice fails the client-module registry at boot, and a package
 * subpath fails with ERR_PACKAGE_PATH_NOT_EXPORTED. Each row therefore names one whole
 * package. This is checked here rather than in the gate above because it is a property
 * of what ships. */
check(
  'every row names a whole package, never a subpath',
  rowNames.every((name) => (name.startsWith('@') ? name.split('/').length === 2 : !name.includes('/'))),
  rowNames.join(', '),
);
check(
  'exactly one row names the bundle itself',
  rows.filter((row) => row.name === manifest.name).length === 1,
  rows.map((row) => `${row.id} -> ${row.name}`).join(', '),
);
/* Replaces "every component has exactly one row", which is genuinely obsolete: the
 * components have no rows any more — they are composed by the core row, which is what
 * keeps module paths off the plugin card. The check now asserts the new contract in the
 * same discovery-driven way: no row may address a component package, so re-adding one
 * fails here rather than at boot. */
check(
  'no row addresses a component package: the components are composed, not declared',
  componentRows.length === 0,
  `${componentRows.length} component rows for ${components.length} components`,
);

/* The preset is a declaration, not a component package, and it must be carried by
 * the bundle rather than left to be configured by hand after install. */
const presets = rows.filter((row) => row.name.startsWith('@deepseek-ai/') && row.name !== manifest.name);
check('the bundle carries at least one harness-declared row', presets.length >= 1, presets.map((row) => row.id).join(', '));
for (const preset of presets) {
  const declared = new RegExp(`^ {4}- id: ${preset.id}$`, 'm').test(patch);
  check(`row ${preset.id} is declared in the shipped patch`, declared);
}

/* --------------------------------------------------- presets are selected --- */

/* Declaring a preset is not shipping it: without a selection it exists and nothing
 * uses it after a fresh install. The bundle must carry both, and the selection must
 * name the preset the bundle declares. */
console.log('');
console.log('# preset selection');

const presetRows = rows.filter((row) => row.name === '@deepseek-ai/dsh-agent-preset');
const declaredPresetIds = [...patch.matchAll(/^ {8}id: ([a-z0-9-]+)$/gm)].map((match) => match[1]);
const selection = /^- id: agent-preset-registry$[\s\S]*?^ {4}selectedDefault: (\S+)$/m.exec(patch)?.[1];

check('the bundle declares at least one preset', presetRows.length >= 1, presetRows.map((row) => row.id).join(', '));
check('the bundle also ships a preset selection', selection !== undefined, selection);
check(
  'the selection names a preset the bundle actually declares',
  selection !== undefined && declaredPresetIds.includes(selection),
  `selected "${selection}", declared ${JSON.stringify(declaredPresetIds)}`,
);
check(
  'the selection override restates the required registry field',
  /^- id: agent-preset-registry$[\s\S]*?^ {4}default: /m.test(patch),
);

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
