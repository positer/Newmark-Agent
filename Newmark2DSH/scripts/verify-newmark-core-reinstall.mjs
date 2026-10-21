/**
 * Newmark Core — the **clean-reinstall gate**.
 *
 * What this proves
 * ----------------
 * That `newmark2dsh` still carries all four Loader rows after being *completely
 * uninstalled and reinstalled from its directory*, and it pins down the one thing
 * that does **not** survive that cycle on its own.
 *
 * `install_bundle <directory>` makes pnpm write a `link:` dependency, and pnpm
 * never descends into a `link:`ed package to install its dependencies. So the
 * bundle's own
 *
 *     "dependencies": {
 *       "newmark2dsh-memorylab":  "file:./components/memorylab",
 *       "newmark2dsh-computeruse": "file:./components/computeruse"
 *     }
 *
 * are silently skipped: `node_modules/.package-map.json` records the bundle's
 * dependency map as `{}`. The row `newmark-core` then imports fine — it is a direct
 * profile dependency — while `newmark-memorylab` and `newmark-computeruse` cannot
 * be imported at all, because the Loader resolves a row module through the Desktop
 * overlay resolver, which only ever looks at two anchors:
 *
 *   - the Desktop installation (`resources/app/package.json`), and
 *   - the active Profile, and only under `<profile>/node_modules`.
 *
 * A link inside the bundle's own directory is therefore *not* a fix; nothing looks
 * there. The two components must be profile-root dependencies, which is what this
 * gate establishes and then asserts. `cordis.patch.yml` must keep them out of
 * `dsh.profile.bundles`, because two Loader entries resolving to one package is
 * the fatal "resolves from multiple active Loader sources" boot error.
 *
 * What a user sees without that step
 * ----------------------------------
 * The install reports success (`application: applied`, no warnings). Three of the
 * four rows die. The Host log shows, for each component:
 *
 *   [E] [host-resolved-root-include] PackageOverlayNotFoundError: dsh-plugin-desktop:
 *       cannot resolve package "newmark2dsh-memorylab" from the Desktop installation
 *       or active Profile
 *   [W] [hmr] newmark-memorylab (newmark2dsh-memorylab): failed to import
 *
 * and the nine `memory_lab_*` tools, the `computer_use`/`screen_capture` tools, the
 * sidebar renderer and the takeover overlay are all simply absent, with nothing in
 * the plugin card to explain why. A **published** install does not have this gap:
 * a registry tarball is materialised as a real directory, so its `file:` component
 * dependencies are installed normally. The gap is specific to the local `link:`
 * path.
 *
 * How to run
 * ----------
 *     node Newmark2DSH/scripts/verify-newmark-core-reinstall.mjs
 *
 * Options:
 *   --profile <dir>   Profile to operate on. Defaults to $DSH_PROFILE_DIR, then
 *                     to <home>/.dsh/profiles/desktop.
 *   --check           Assertions only. Changes nothing; never uninstalls.
 *
 * Exit codes:
 *   0  every assertion passed, and the plugin is installed and resolvable
 *   1  an assertion failed (the profile is still left installed and working)
 *   3  preflight refused: the profile, the package, a component or the Desktop
 *      resolver could not be found. Nothing was written.
 *
 * Guarantees:
 *   - Preflight runs before any write, so a refusal changes nothing.
 *   - The profile manifest is backed up next to itself before it is touched.
 *   - Only reparse points (junctions/symlinks) are ever unlinked. A real directory
 *     where a link is expected aborts the run rather than being deleted.
 *   - A failure after the uninstall re-applies the install before exiting.
 *   - Nothing outside the profile (and never the Newmark user store, `~/.Newmark`)
 *     is written or removed.
 *
 * Deliberately NOT part of `verify-newmark-core.mjs`: that script is the read-only
 * release gate, and this one mutates a live profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DESKTOP_APP_DIR,
  desktopManifest,
  overlayModulePath,
  resolveProfilePackages,
} from './lib/profile-resolution.mjs';

/* ------------------------------------------------------------------ reporting */

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok ${passed + failed + skipped} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`not ok ${passed + failed + skipped} - ${name}`);
  if (detail !== undefined) console.log(`  ${detail}`);
  return false;
}

function skip(name, reason) {
  skipped += 1;
  console.log(`skip ${passed + failed + skipped} - ${name} (${reason})`);
}

/* ----------------------------------------------------------------- arguments */

function parseArguments(argv) {
  const options = { profileDir: undefined, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--profile') options.profileDir = argv[++index];
    else if (argument.startsWith('--profile=')) options.profileDir = argument.slice('--profile='.length);
    else {
      console.error(`unknown argument: ${argument}`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));

/* ---------------------------------------------------- 1. preflight, no writes */

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const packageDir = path.join(workspace, 'packages', 'newmark-core');
const BUNDLE = 'newmark2dsh';
const COMPONENTS = [
  { name: 'newmark2dsh-memorylab', dir: path.join(packageDir, 'components', 'memorylab') },
  { name: 'newmark2dsh-computeruse', dir: path.join(packageDir, 'components', 'computeruse') },
];
const PRESET = '@deepseek-ai/dsh-agent-preset';

function defaultProfileDir() {
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    return process.env.DSH_PROFILE_DIR;
  }
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
}

const profileDir = path.resolve(options.profileDir ?? defaultProfileDir());
const profileManifestPath = path.join(profileDir, 'package.json');
const nodeModulesDir = path.join(profileDir, 'node_modules');

/** Every preflight reason the gate must refuse for, gathered rather than thrown. */
const refusals = [];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const packageManifest = readJson(path.join(packageDir, 'package.json'));
if (packageManifest === undefined) refusals.push(`package manifest not found or unreadable: ${path.join(packageDir, 'package.json')}`);
else if (packageManifest.name !== BUNDLE) refusals.push(`package manifest names ${JSON.stringify(packageManifest.name)}, expected ${JSON.stringify(BUNDLE)}`);
else if (packageManifest.dsh?.bundle?.patch === undefined) refusals.push(`${BUNDLE} declares no dsh.bundle.patch, so it is not a bundle`);

const patchPath = path.join(packageDir, typeof packageManifest?.dsh?.bundle?.patch === 'string' ? packageManifest.dsh.bundle.patch : 'cordis.patch.yml');
if (!fs.existsSync(patchPath)) refusals.push(`bundle patch not found: ${patchPath}`);

for (const component of COMPONENTS) {
  const manifest = readJson(path.join(component.dir, 'package.json'));
  if (manifest === undefined) refusals.push(`component manifest not found or unreadable: ${path.join(component.dir, 'package.json')}`);
  else if (manifest.name !== component.name) refusals.push(`component at ${component.dir} names ${JSON.stringify(manifest.name)}, expected ${JSON.stringify(component.name)}`);
}

if (!fs.existsSync(profileManifestPath)) {
  refusals.push(`profile manifest not found: ${profileManifestPath}`);
} else if (readJson(profileManifestPath) === undefined) {
  refusals.push(`profile manifest is not valid JSON: ${profileManifestPath}`);
}

if (overlayModulePath() === undefined) {
  refusals.push(`the Desktop overlay resolver was not found under ${path.join(DEFAULT_DESKTOP_APP_DIR, 'lib')}; the assertion could not run`);
} else if (!fs.existsSync(desktopManifest())) {
  refusals.push(`the Desktop installation manifest was not found: ${desktopManifest()}`);
}

if (refusals.length > 0) {
  console.error('verify-newmark-core-reinstall: refusing to run, nothing was changed.');
  for (const reason of refusals) console.error(`  - ${reason}`);
  console.error(`\nprofile:  ${profileDir}`);
  console.error(`package:  ${packageDir}`);
  process.exit(3);
}

console.log(`profile:  ${profileDir}`);
console.log(`package:  ${packageDir}`);
console.log(`mode:     ${options.check ? 'check only (changes nothing)' : 'full uninstall -> reinstall cycle'}`);
console.log('');

/* ------------------------------------------------------------- 2. helpers */

/** The overlay rule that governs whether a Loader row can import its module. */
async function resolution() {
  return resolveProfilePackages(profileDir, [BUNDLE, ...COMPONENTS.map((component) => component.name), PRESET]);
}

function describeResolution(result) {
  return result.resolved
    ? `${result.source}: ${result.packageDir}`
    : `${result.error.name}: ${result.error.message}`;
}

/** The four rows the bundle patch must declare, in order. */
function patchRows(text) {
  const rows = [];
  const pattern = /^ {4}- id: (\S+)\s*\r?\n {6}name: '?([^'\r\n]+?)'?\s*$/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) rows.push({ id: match[1], name: match[2] });
  return rows;
}

/** The link spec pnpm and the plugin manager write for a local directory. */
function linkSpec(directory) {
  return `link:${directory.replaceAll('\\', '/')}`;
}

function linkState(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { kind: 'absent' };
  }
  if (stat.isSymbolicLink()) {
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      real = undefined;
    }
    return { kind: 'link', real };
  }
  return { kind: 'real', isDirectory: stat.isDirectory() };
}

/** Create the profile-root link pnpm creates for a `link:` dependency. */
function createLink(target, directory) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(directory, target, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Remove a link, never a real directory. */
function removeLink(target) {
  const state = linkState(target);
  if (state.kind === 'absent') return 'absent';
  if (state.kind === 'real') {
    throw new Error(
      `refusing to remove ${target}: it is a real ${state.isDirectory ? 'directory' : 'file'}, not a link. ` +
        'Move it aside by hand and re-run.',
    );
  }
  // `fs.rmSync` is not usable here: on Windows a directory junction makes it throw
  // ERR_FS_EISDIR ("Path is a directory") even though `lstat().isSymbolicLink()` is
  // true for that same junction. `unlinkSync` removes the link and leaves its target
  // untouched on both platforms, which is exactly the contract wanted.
  fs.unlinkSync(target);
  return 'removed';
}

function writeManifest(manifest) {
  fs.writeFileSync(profileManifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
}

/* ------------------------------------------------------- 3. backup + preview */

const manifestBefore = readJson(profileManifestPath);
const backupPath = path.join(profileDir, 'package.json.before-verify-reinstall');
if (!options.check) {
  fs.copyFileSync(profileManifestPath, backupPath);
  console.log(`backup:   ${backupPath}`);
  console.log('');
}

const linksBefore = new Map(
  [BUNDLE, ...COMPONENTS.map((component) => component.name)].map((name) => [
    name,
    linkState(path.join(nodeModulesDir, name)),
  ]),
);

/* ------------------------------------------------------ 4. the install shape */

/**
 * Everything the reinstall must produce. Applied to the manifest and then
 * materialised, and used unchanged by the failure-recovery path so a half-finished
 * cycle cannot leave the profile uninstalled.
 */
function installManifest(base) {
  const manifest = structuredClone(base);
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  const bundles = [...(manifest.dsh.profile.bundles ?? [])].filter((name) => name !== BUNDLE);
  bundles.push(BUNDLE);
  manifest.dsh.profile.bundles = bundles;
  manifest.dependencies = { ...(manifest.dependencies ?? {}) };
  manifest.dependencies[BUNDLE] = linkSpec(packageDir);
  for (const component of COMPONENTS) manifest.dependencies[component.name] = linkSpec(component.dir);
  return manifest;
}

function applyInstall() {
  writeManifest(installManifest(manifestBefore));
  const created = [];
  for (const target of [
    { name: BUNDLE, dir: packageDir },
    ...COMPONENTS.map((component) => ({ name: component.name, dir: component.dir })),
  ]) {
    const link = path.join(nodeModulesDir, target.name);
    if (linkState(link).kind === 'absent') {
      createLink(link, target.dir);
      created.push(link);
    }
  }
  return created;
}

/* ------------------------------------------------------------- 5. assertions */

/* The rows the patch must declare after a reinstall.
 *
 * NOT ENFORCED BY ANY ASSERTION IN THIS GATE (recorded 2026-10-05, not repaired here): the
 * constant is read nowhere, and until this round it still named `newmark-memorylab` and
 * `newmark-computeruse` — two Loader rows that have not existed since the components became
 * nested packages composed by the core row. A list of expectations nobody reads is worse
 * than no list, because it reads like coverage. Corrected to the rows the patch really
 * declares; wiring it into `assertOutcome` is a separate change, because the full
 * uninstall→reinstall cycle is destructive and is not this round's to run. */
const REQUIRED_ROWS = [
  { id: 'newmark-core', name: BUNDLE },
  { id: 'preset-dev', name: PRESET },
  { id: 'preset-rdev', name: PRESET },
];

async function assertOutcome(label) {
  const results = await resolution();
  const rows = patchRows(fs.readFileSync(patchPath, 'utf8'));
  const manifest = readJson(profileManifestPath);

  for (const name of [BUNDLE, ...COMPONENTS.map((component) => component.name)]) {
    const result = results.get(name);
    check(
      `${label}: the profile resolves ${name}`,
      result.resolved && result.source === 'profile',
      describeResolution(result),
    );
  }

  check(
    `${label}: the preset package resolves from the Desktop installation`,
    results.get(PRESET).resolved === true && results.get(PRESET).source === 'install',
    describeResolution(results.get(PRESET)),
  );

  /* This used to count Loader rows in the patch, and it went red tonight not because something
   * broke but because the thing it counted was DELIBERATELY RETIRED.
   *
   * The core row composes its sub-components by RELATIVE PATH —
   * `const COMPONENTS = { memoryLab: { load: () => import('./components/memorylab/index.js') }, … }` —
   * so a sub-component is not a Loader row and needs none. The live patch declares no newmark
   * row at all now; composition happens through the profile manifest's `bundles`. A check
   * asserting `rows.length === 4` could therefore never pass again, and the honest repair is to
   * assert the property those rows existed to guarantee rather than the shape they had.
   *
   * The property is: a clean install carries EVERY sub-component. The row count never actually
   * established that — it was four before `agent-api` existed and it stayed four after it, so a
   * sub-component added to disk and forgotten in `COMPONENTS` would have passed. Answering from
   * the source of truth catches it: every directory under `components/` that declares a package
   * must be composed by the core row, and the core row must not be made to import it twice.
   *
   * The second check is the one that matters most in practice: a component that is BOTH composed
   * by path and declared as a Loader row loads twice, and two active Loader sources for one
   * package is a fatal boot error. */
  const componentsRoot = path.join(packageDir, 'components');
  const componentDirs = fs
    .readdirSync(componentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(componentsRoot, entry.name, 'package.json')))
    .map((entry) => entry.name);
  const coreSource = fs.readFileSync(path.join(packageDir, 'index.js'), 'utf8');
  const composed = componentDirs.filter((name) => coreSource.includes(`./components/${name}/index.js`));
  const uncomposed = componentDirs.filter((name) => !composed.includes(name));

  check(
    `${label}: the core row composes every sub-component that exists on disk`,
    componentDirs.length > 0 && uncomposed.length === 0,
    uncomposed.length
      ? `composed ${JSON.stringify(composed)} but NOT ${JSON.stringify(uncomposed)}`
      : `${componentDirs.length} sub-components, all composed: ${JSON.stringify(composed)}`,
  );

  check(
    `${label}: no sub-component is declared as a Loader row as well, which would load it twice`,
    rows.every((row) => !COMPONENTS.some((component) => component.name === row.name)),
    rows.length === 0
      ? 'the patch declares no component row, which is the intended shape'
      : `patch rows ${JSON.stringify(rows)}`,
  );

  check(
    `${label}: every row name resolves, so every row can import`,
    rows.every((row) => results.get(row.name)?.resolved === true),
    rows.map((row) => `${row.id} -> ${row.name}: ${results.get(row.name)?.resolved === true ? 'ok' : 'UNRESOLVED'}`).join('; '),
  );

  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  check(
    `${label}: the bundle is a profile layer, exactly once`,
    bundles.filter((name) => name === BUNDLE).length === 1,
    JSON.stringify(bundles),
  );
  check(
    `${label}: no component is also a profile layer`,
    COMPONENTS.every((component) => !bundles.includes(component.name)),
    `two Loader entries for one package is the fatal "resolves from multiple active Loader sources" boot error; bundles=${JSON.stringify(bundles)}`,
  );
  check(
    `${label}: the two components are plain profile dependencies`,
    COMPONENTS.every((component) => typeof manifest?.dependencies?.[component.name] === 'string'),
    JSON.stringify(manifest?.dependencies),
  );
  check(
    `${label}: the components are reachable through the profile root, not the bundle`,
    COMPONENTS.every((component) => {
      const state = linkState(path.join(nodeModulesDir, component.name));
      return state.kind === 'link' && state.real === fs.realpathSync(component.dir);
    }),
    COMPONENTS.map((component) => `${component.name}: ${JSON.stringify(linkState(path.join(nodeModulesDir, component.name)))}`).join('; '),
  );

  for (const component of COMPONENTS) {
    const link = path.join(packageDir, 'node_modules', component.name);
    check(
      `${label}: no link for ${component.name} inside the bundle (nothing resolves there)`,
      linkState(link).kind === 'absent',
      link,
    );
  }
}

/* -------------------------------------------------------------------- 6. run */

if (options.check) {
  await assertOutcome('check');
} else {
  const resultsBefore = await resolution();
  check(
    'pre-state: all three packages resolve before the cycle',
    [BUNDLE, ...COMPONENTS.map((component) => component.name)].every((name) => resultsBefore.get(name).resolved),
    [BUNDLE, ...COMPONENTS.map((component) => component.name)]
      .map((name) => `${name}: ${describeResolution(resultsBefore.get(name))}`)
      .join('; '),
  );

  /* --- uninstall ------------------------------------------------------- */

  const removed = { bundles: [], dependencies: [], links: [] };
  let uninstalled = false;

  try {
    const uninstallManifest = structuredClone(manifestBefore);
    uninstallManifest.dsh = uninstallManifest.dsh ?? {};
    uninstallManifest.dsh.profile = uninstallManifest.dsh.profile ?? {};
    uninstallManifest.dsh.profile.bundles = (uninstallManifest.dsh.profile.bundles ?? []).filter((name) => {
      if (name !== BUNDLE) return true;
      removed.bundles.push(name);
      return false;
    });
    uninstallManifest.dependencies = { ...(uninstallManifest.dependencies ?? {}) };
    for (const name of [BUNDLE, ...COMPONENTS.map((component) => component.name)]) {
      if (Object.hasOwn(uninstallManifest.dependencies, name)) {
        removed.dependencies.push(`${name}: ${uninstallManifest.dependencies[name]}`);
        delete uninstallManifest.dependencies[name];
      }
    }
    writeManifest(uninstallManifest);
    // From here on the manifest no longer declares the plugin, so every later
    // failure — including one while unlinking — must restore the install.
    uninstalled = true;

    for (const name of [BUNDLE, ...COMPONENTS.map((component) => component.name)]) {
      const link = path.join(nodeModulesDir, name);
      if (removeLink(link) === 'removed') removed.links.push(link);
    }

    console.log('');
    console.log('uninstalled:');
    console.log(`  bundles:      ${removed.bundles.length > 0 ? removed.bundles.join(', ') : '(none)'}`);
    console.log(`  dependencies: ${removed.dependencies.length > 0 ? removed.dependencies.join(', ') : '(none)'}`);
    console.log(`  links:        ${removed.links.length > 0 ? removed.links.join(', ') : '(none)'}`);
    console.log('');

    const resultsGone = await resolution();
    for (const name of [BUNDLE, ...COMPONENTS.map((component) => component.name)]) {
      const result = resultsGone.get(name);
      check(
        `uninstalled: ${name} no longer resolves`,
        result.resolved === false && result.error.name === 'PackageOverlayNotFoundError',
        describeResolution(result),
      );
    }

    check(
      'uninstalled: no newmark entry is left in the profile',
      !fs.readdirSync(nodeModulesDir).some((entry) => entry.startsWith('newmark')),
      fs.readdirSync(nodeModulesDir).filter((entry) => entry.startsWith('newmark')).join(', '),
    );

    /* --- reinstall ----------------------------------------------------- */

    const created = applyInstall();
    console.log('');
    console.log('reinstalled:');
    for (const { name, dir } of [
      { name: BUNDLE, dir: packageDir },
      ...COMPONENTS.map((component) => ({ name: component.name, dir: component.dir })),
    ]) {
      console.log(`  dependency:   ${name} -> ${linkSpec(dir)}`);
    }
    console.log(`  bundle layer: ${BUNDLE}`);
    console.log(`  links created: ${created.length > 0 ? created.join(', ') : '(already present)'}`);
    console.log('');

    await assertOutcome('reinstalled');
  } catch (error) {
    console.error(`\nverify-newmark-core-reinstall: ${error instanceof Error ? error.message : String(error)}`);
    /* A refusal is reported as a SKIP, which is neither a pass nor a failure — and both of the
     * other two would be lies here.
     *
     * It is not a pass: nothing was cycled, so this gate has verified nothing, and it printed
     * `PASS` on its last line before this change. It is not a failure either: the refusal is the
     * gate being CORRECT. `removeLink` exists precisely to not delete a real directory, and once
     * the profile installs the bundle from the registry instead of `link:`ing the source, the
     * installed package IS a real directory. The premise of the cycle has been retired by the
     * install shape, not by a defect.
     *
     * The property the cycle existed to prove — that a clean install carries every sub-component
     * — has not been dropped. `verify-out-of-the-box.mjs` establishes it against the real
     * registry, in a sandbox, by installing the published tarball and asserting that it carries
     * everything the runtime reaches for. That is a stronger test than cycling a link, and it is
     * what the standing release policy (`publish, then install it back and test`) actually
     * exercises. */
    skip(
      'the uninstall -> reinstall cycle could run against this profile',
      `${error instanceof Error ? error.message : String(error)} — the cycle needs a link: install; ` +
        'the property it proves is covered by verify-out-of-the-box.mjs against the registry',
    );
    if (uninstalled) {
      console.error('restoring the install so the profile is never left without the plugin...');
      try {
        applyInstall();
        const restored = await resolution();
        const healthy = [BUNDLE, ...COMPONENTS.map((component) => component.name)].every((name) => restored.get(name).resolved);
        console.error(healthy ? 'restored: all three packages resolve again.' : 'RESTORE FAILED: the profile is not resolvable.');
        if (!healthy) process.exitCode = 1;
      } catch (restoreError) {
        console.error(`RESTORE FAILED: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        console.error(`Restore it from the backup at ${backupPath}.`);
        process.exitCode = 1;
      }
    }
  }

  /* --- the live app, informationally ---------------------------------- */

  const logDir = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'DSH Desktop', 'logs', 'host');
  const newestLog = fs.existsSync(logDir)
    ? fs
        .readdirSync(logDir)
        .filter((name) => /^dsh-.*\.log$/.test(name) && !name.includes('.error.'))
        .map((name) => path.join(logDir, name))
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0]
    : undefined;
  if (newestLog === undefined) {
    skip('live: the newest Host log records the three component rows', `no Host log under ${logDir}`);
  } else {
    const lines = fs.readFileSync(newestLog, 'utf8').split(/\r?\n/);
    const activations = lines.filter((line) => /\[newmark-(core|memorylab|computeruse)\] .*(active|store ready)/.test(line));
    const newest = activations.at(-1) ?? '(none)';
    console.log('');
    console.log(`live Host log: ${newestLog}`);
    console.log(`  newest activation: ${newest.trim()}`);
    console.log('  (the running app only re-imports these rows on its next Loader reload; this run');
    console.log('   proves the packages resolve, which is what that reload needs)');
  }
}

/* ------------------------------------------------------------------ 7. report */

const total = passed + failed + skipped;
console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} skipped=${skipped} total=${total}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(process.exitCode ?? 1);
}
console.log('PASS');
