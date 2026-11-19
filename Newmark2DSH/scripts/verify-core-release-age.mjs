/**
 * Newmark Core — the release-age gate.
 *
 * The requirement (2026-11-19): 版本回退锁只能在本插件内限制本插件的版本回退，不允许权限溢出行为，
 * 修复 newmark2dsh 导致的其他插件 pnpm 更新失败问题，以及 newmark2dsh 插件在启用状态下无法更新
 * dsh 的问题.
 *
 * What the gate has to prove, in facts rather than in prose:
 *
 *   1. **the lock stays inside this plugin** — the entry this bundle writes is its own bare package
 *      name; every other package's entry is copied through byte-for-byte. MEASURED 2026-11-19 on
 *      pnpm 11.11.0: with only `newmark2dsh` exempted, a fresh `dsh-pighub@1.0.11` in the same
 *      lockfile still fails `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` and is named in the error —
 *      the exemption really covers one package and no more;
 *   2. **the stale form is replaced** — the live profile carried
 *      `newmark2dsh@0.2.24 || 0.2.26 || 0.2.33 || 0.3.80 || 0.3.81 || 0.3.82` while 0.3.84 was
 *      installed, and that is exactly why every install failed; a bare name cannot go stale;
 *   3. **the repair is idempotent and narrow** — a correct file is not rewritten, an absent
 *      workspace file is not created, and `minimumReleaseAge` itself is never written;
 *   4. **a hold-back is reported, not worked around** — the startup auto-update answers
 *      `held_by_release_age` and writes no failure line, so the policy's own refusal does not read
 *      as a broken machine;
 *   5. **the wiring exists** — the host half runs the repair at mount and before every install,
 *      and the page renders the receipt when a repair happened.
 *
 * Run: node Newmark2DSH/scripts/verify-core-release-age.mjs [--child | --mutations]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_AGE_KEY,
  SELF_PACKAGE,
  applySelfExemption,
  ensureSelfExemption,
  locateProfileDir,
  packageNameOf,
  planSelfExemption,
} from '../packages/newmark-core/lib/release-age.js';
import { runAutoUpdate } from '../packages/newmark-core/lib/auto-update.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const coreDir = path.join(workspace, 'packages', 'newmark-core');
const mode = process.argv[2] ?? '';
const quiet = mode === '--child';

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail) {
  const n = passed + failed + 1;
  if (condition) {
    passed += 1;
    if (!quiet) console.log(`ok ${n} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  if (!quiet) {
    console.log(`not ok ${n} - ${name}`);
    if (detail !== undefined) console.log(`  ${detail}`);
  }
  return false;
}

/** A throwaway profile, so no assertion can touch the live one. */
function tempProfile(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `newmark-release-age-${label}-`));
}

const LIVE_SHAPE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  `${RELEASE_AGE_KEY}:`,
  '  - newmark2dsh@0.2.24 || 0.2.26 || 0.2.33 || 0.3.80 || 0.3.81 || 0.3.82',
  '  - dsh-pighub@1.0.4 || 1.0.5 || 1.0.6',
  '',
].join('\n');

/* --------------------------------------------------------------- the parser --- */

console.log('# the name a spec names');

check('a bare name is its own name', packageNameOf('newmark2dsh') === 'newmark2dsh');
check('a pinned version keeps only the name', packageNameOf('newmark2dsh@0.3.84') === 'newmark2dsh');
check(
  'a version union keeps only the name',
  packageNameOf('newmark2dsh@0.2.24 || 0.2.26 || 0.3.82') === 'newmark2dsh',
);
check(
  'a scoped package is not read as the empty name',
  packageNameOf('@scope/newmark2dsh@1.2.3') === '@scope/newmark2dsh',
  'splitting at the first @ would answer "" and then treat its entry as ours',
);
check('another package is not ours', packageNameOf('dsh-pighub@1.0.11') !== SELF_PACKAGE);

/* ------------------------------------------------------------ the decision --- */

console.log('# the exclusion list after the rule');

const stale = planSelfExemption([
  'newmark2dsh@0.2.24 || 0.2.26 || 0.2.33 || 0.3.80 || 0.3.81 || 0.3.82',
  'dsh-pighub@1.0.4 || 1.0.5 || 1.0.6',
]);
check('a version-pinned entry for this package is removed', stale.removed.length === 1);
check('the bare name is added in its place', stale.added.length === 1 && stale.specs.includes(SELF_PACKAGE));
check(
  'the other package keeps its entry, verbatim and in order',
  stale.specs[0] === 'dsh-pighub@1.0.4 || 1.0.5 || 1.0.6',
  stale.specs.join(' | '),
);
check('the plan is reported as a change', stale.changed === true);

const already = planSelfExemption(['dsh-pighub@1.0.4', SELF_PACKAGE]);
check('a bare entry already present is left alone', already.changed === false);
check('and nothing is added', already.added.length === 0);
check('and nothing is removed', already.removed.length === 0);

const twoSelf = planSelfExemption([SELF_PACKAGE, 'newmark2dsh@0.3.84']);
check(
  'a bare entry and a pinned entry together collapse to the bare one',
  twoSelf.specs.filter((spec) => spec === SELF_PACKAGE).length === 1 && twoSelf.removed.length === 1,
);

/* ---------------------------------------------------------------- the text --- */

console.log('# the workspace manifest, as text');

const repaired = applySelfExemption(LIVE_SHAPE);
check('the live shape is reported as needing repair', repaired.changed === true);
check(
  'the entry becomes the bare package name',
  repaired.text.includes(`${RELEASE_AGE_KEY}:\n  - dsh-pighub@1.0.4 || 1.0.5 || 1.0.6\n  - ${SELF_PACKAGE}\n`),
  JSON.stringify(repaired.text),
);
check(
  'every line that is not the entry is unchanged',
  ['packages:', '  - .', 'nodeLinker: hoisted', 'autoInstallPeers: false'].every(
    (line) => repaired.text.includes(line),
  ),
);
check(
  'the policy itself is never written',
  !/^minimumReleaseAge\s*:/m.test(repaired.text),
  'writing the waiting period would be changing the user policy, not declaring an exemption',
);
check('the repair is idempotent', applySelfExemption(repaired.text).changed === false);
check(
  'a manifest without the key gains it, and keeps its other keys',
  (() => {
    const out = applySelfExemption('packages:\n  - .\n');
    return out.changed && out.text === `packages:\n  - .\n\n${RELEASE_AGE_KEY}:\n  - ${SELF_PACKAGE}\n`;
  })(),
);
check(
  'an inline flow list is rewritten as a block',
  (() => {
    const out = applySelfExemption(`packages:\n  - .\n${RELEASE_AGE_KEY}: [dsh-pighub@1.0.4]\n`);
    return out.text.includes(`${RELEASE_AGE_KEY}:\n  - dsh-pighub@1.0.4\n  - ${SELF_PACKAGE}\n`);
  })(),
);
check(
  'a CRLF manifest keeps its line endings',
  (() => {
    const out = applySelfExemption('packages:\r\n  - .\r\n');
    return out.text.includes('\r\n') && !/[^\r]\n/.test(out.text);
  })(),
);

/* ------------------------------------------------------------------ the file --- */

console.log('# the repair on disk');

const profile = tempProfile('repair');
fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), LIVE_SHAPE);
const first = await ensureSelfExemption({ profileDir: profile });
check('the first pass reports a change', first.ok === true && first.changed === true, JSON.stringify(first));
check(
  'the file on disk carries the bare name and the other package untouched',
  (() => {
    const text = fs.readFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'utf8');
    return text.includes(`  - ${SELF_PACKAGE}`) && text.includes('  - dsh-pighub@1.0.4 || 1.0.5 || 1.0.6');
  })(),
);
const before = fs.readFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'utf8');
const second = await ensureSelfExemption({ profileDir: profile });
check('the second pass reports no change', second.ok === true && second.changed === false);
check(
  'and does not rewrite the file',
  fs.readFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'utf8') === before,
);
check(
  'no temporary file is left behind',
  fs.readdirSync(profile).every((name) => !name.endsWith('.tmp')),
  fs.readdirSync(profile).join(', '),
);

const empty = tempProfile('missing');
const missing = await ensureSelfExemption({ profileDir: empty });
check(
  'a profile without a workspace file is reported, not invented',
  missing.ok === false && missing.reason === 'no_workspace_file' && fs.readdirSync(empty).length === 0,
  JSON.stringify(missing),
);
check(
  'an absent profile directory is reported',
  (await ensureSelfExemption({ profileDir: '' })).reason === 'profile_dir_missing',
);

console.log('# the profile this copy is installed into');

check(
  'a package under <profile>/node_modules resolves to the profile',
  (() => {
    const located = locateProfileDir(path.join('C:', 'p', 'node_modules', SELF_PACKAGE));
    return located.ok === true && located.dir === path.join('C:', 'p');
  })(),
);
check(
  'a source checkout resolves to nothing rather than to a guess',
  (() => {
    const located = locateProfileDir(path.join('C:', 'src', 'packages', 'newmark-core'));
    return located.ok === false && located.reason === 'not_installed_under_node_modules';
  })(),
);

/* ------------------------------------------------------- the auto-update word --- */

console.log('# a hold-back is reported, not worked around');

const holdBackRoot = tempProfile('holdback');
const recorded = [];
const heldReceipt = await runAutoUpdate({
  root: holdBackRoot,
  enabled: true,
  installedVersion: '0.3.84',
  runningVersion: '0.3.84',
  readLatest: async () => ({ latest: '0.3.85', tarball: 'tarball', registry: 'registry' }),
  install: async () => {
    throw new Error(
      '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] newmark2dsh@0.3.85 was published at 2026-11-19T01:00:00.000Z, within the minimumReleaseAge cutoff',
    );
  },
  installedAfter: async () => '0.3.84',
  record: (failure) => recorded.push(failure),
  pid: 4242,
});
check('the outcome is its own word', heldReceipt.reason === 'held_by_release_age', heldReceipt.reason);
check('the receipt says the policy held it back', heldReceipt.state?.outcome === 'held_by_release_age');
check(
  'no failure line is written for the policy doing its job',
  recorded.length === 0,
  JSON.stringify(recorded),
);
check('the version on disk is still the old one', heldReceipt.state?.installedAfter === '0.3.84');

const brokenRoot = tempProfile('broken');
const brokenRecorded = [];
const broken = await runAutoUpdate({
  root: brokenRoot,
  enabled: true,
  installedVersion: '0.3.84',
  runningVersion: '0.3.84',
  readLatest: async () => ({ latest: '0.3.85', tarball: 'tarball', registry: 'registry' }),
  install: async () => {
    throw new Error('spawn pnpm ENOENT');
  },
  installedAfter: async () => '0.3.84',
  record: (failure) => brokenRecorded.push(failure),
  pid: 4343,
});
check('a real failure is still a failure', broken.reason === 'install_failed');
check('and is still recorded', brokenRecorded.length === 1);

/* ------------------------------------------------------------------ the wiring --- */

console.log('# the wiring, read from the source that ships');

const hostSource = fs.readFileSync(path.join(coreDir, 'index.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(coreDir, 'client.js'), 'utf8');
const autoUpdateSource = fs.readFileSync(path.join(coreDir, 'lib', 'auto-update.js'), 'utf8');

check(
  'the host half imports the repair from the module under test',
  /from '.\/lib\/release-age.js'/.test(hostSource),
);
check(
  'the repair runs at mount',
  /ctx\.effect\(\(\) => \{\s*void ensureReleaseAge\(\)/.test(hostSource),
);
check(
  'the repair runs again before this bundle installs itself',
  /await ensureReleaseAge\(\);\s*\n\s*return manager\.installBundle/.test(hostSource),
  'the install is what introduces the young lockfile entry',
);
check(
  'the page renders the receipt only when a repair happened',
  /receipt\.ok === true && receipt\.changed === true/.test(clientSource),
);
check(
  'the tarball is no longer claimed to bypass the age policy',
  !/avoids\s+pnpm's bare-name age fallback/.test(clientSource),
  'measured 2026-11-19: the exact tarball is refused like any other young version',
);
check(
  "the auto-update recognises pnpm's own code",
  autoUpdateSource.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'),
);

/* ---------------------------------------------------------------- mutations --- */

const MUTATIONS = [
  {
    label: 'M1 the name parser splits at the first @',
    file: 'lib/release-age.js',
    find: "const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);",
    replace: "const at = text.indexOf('@');",
  },
  {
    label: 'M2 a pinned entry for this package is kept',
    file: 'lib/release-age.js',
    find: '        removed.push(spec);',
    replace: '        kept.push(spec);',
  },
  {
    label: "M3 the other packages' entries are dropped",
    file: 'lib/release-age.js',
    find: "    if (packageNameOf(spec) === SELF_PACKAGE) {",
    replace: "    if (packageNameOf(spec) === '') {",
  },
  {
    label: 'M4 the repair rewrites a file that is already correct',
    file: 'lib/release-age.js',
    find: '  if (!plan.changed) {',
    replace: '  if (false) {',
  },
  {
    label: 'M5 a release-age hold-back is reported as a failure',
    file: 'lib/auto-update.js',
    find: "const held = !landed && isReleaseAgeHoldBack(",
    replace: "const held = false && isReleaseAgeHoldBack(",
  },
];

if (mode === '--mutations') {
  console.log('# mutations: each one must turn this gate red');
  for (const mutation of MUTATIONS) {
    const file = path.join(coreDir, mutation.file);
    const original = fs.readFileSync(file, 'utf8');
    const digest = createHash('sha256').update(original).digest('hex');
    if (!original.includes(mutation.find)) {
      check(`${mutation.label} — anchor found`, false, 'the anchor moved; the mutation proves nothing');
      continue;
    }
    fs.writeFileSync(file, original.replace(mutation.find, mutation.replace));
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
      encoding: 'utf8',
      timeout: 120000,
    });
    fs.writeFileSync(file, original);
    const restored = createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex') === digest;
    check(`${mutation.label} — detected`, run.status !== 0, `exit ${run.status}`);
    check(`${mutation.label} — source restored byte-for-byte`, restored);
  }
}

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
