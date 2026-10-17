/**
 * Newmark Core — the version-discipline gate.
 *
 * This bundle does not use standard semver. Its three fields are
 * `0.<sub-components added>.<everything else>`, and neither position carries at ten, so
 * `0.1.9` is followed by `0.1.10` and `0.9.0` by `0.10.0`. The rule is in `taste.md`; this
 * gate is what makes it a constraint rather than a convention, because a convention that is
 * only written down is one that gets skipped on the release that is in a hurry.
 *
 * It checks three things that can be checked mechanically, and deliberately does not try to
 * guess the fourth:
 *   1. the three manifests agree — they ship as one package;
 *   2. the version is `0.<minor>.<patch>` with the shape the rule describes;
 *   3. the step from the previous release is legal: `(minor+1, 0)` or `(minor, patch+1)`.
 *
 * Whether a release actually ADDED a sub-component is a fact about the work, not about the
 * tree, so it is recorded by hand in `VERSION.md` and this gate checks that a row exists —
 * not that the row is true. That judgement stays with the person making it; what the gate
 * removes is the arithmetic slip and the unrecorded number.
 *
 * Run: node Newmark2DSH/scripts/verify-version-discipline.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* ------------------------------------------------------ the three manifests --- */

/**
 * Every manifest that ships as this one package: the bundle's own, plus one per nested component.
 *
 * DISCOVERED from `components/`, not listed here. It was a hard-coded three, and the third
 * component proved what a hard-coded list does: `agent-api/package.json` was somebody else's to
 * add, so until they did, this gate would have reported "one version" while having read three of
 * the four manifests — a pass that means less than it appears to. The component directory is the
 * fact; a list is a copy of it that goes stale in silence.
 */
const manifests = [
  'package.json',
  ...fs
    .readdirSync(path.join(pkgDir, 'components'))
    .filter((name) => fs.existsSync(path.join(pkgDir, 'components', name, 'package.json')))
    .sort()
    .map((name) => `components/${name}/package.json`),
].map((relative) => ({
  relative,
  manifest: JSON.parse(fs.readFileSync(path.join(pkgDir, relative), 'utf8')),
}));

const versions = [...new Set(manifests.map((m) => m.manifest.version))];
check(
  'every manifest carries one version, because they ship as one package',
  versions.length === 1,
  manifests.map((m) => `${m.relative} = ${m.manifest.version}`).join(', '),
);
// The discovery above is only worth anything if it found the components. A directory renamed or
// emptied would otherwise leave this gate checking one manifest and reporting agreement.
check(
  'every nested component package is among the manifests this gate compares',
  manifests.length >= 2 && manifests.length === 1 + fs.readdirSync(path.join(pkgDir, 'components')).length,
  `${manifests.length} manifests for ${fs.readdirSync(path.join(pkgDir, 'components')).length} component directories`,
);

const version = versions[0] ?? '';
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
check('the version has three numeric fields and nothing else', match !== null, version);

const [, major, minorText, patchText] = match ?? [];
const minor = Number(minorText);
const patch = Number(patchText);

// No leading zeros: `0.01.4` is not the same counter as `0.1.4`, and two spellings of one
// release would make the ledger ambiguous.
check(
  'no field is written with a leading zero',
  match !== null && String(minor) === minorText && String(patch) === patchText,
  version,
);
check(
  'the major field stays 0, because "a sub-component was added" has no meaning for it',
  major === '0',
  `major = ${major}`,
);

/* ----------------------------------------------------------- the ledger --- */

const ledgerPath = path.join(workspace, 'VERSION.md');
const ledger = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';

check('the ledger exists', ledger.length > 0, ledgerPath);

/** Rows of the ledger table: `| 0.1.4 | date | kind | what |` */
const rows = [...ledger.matchAll(/^\|\s*(\d+\.\d+\.\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)].map((m) => ({
  version: m[1],
  date: m[2],
  kind: m[3].trim(),
}));

check(
  'the ledger records the version being released',
  rows.some((row) => row.version === version),
  `released ${version}; ledger has ${rows.map((r) => r.version).join(', ') || 'nothing'}`,
);

const known = new Set(['sub-component', 'sub-component change', 'core']);
const unknown = rows.filter((row) => !known.has(row.kind));
check(
  'every ledger row names one of the three kinds the rule defines',
  unknown.length === 0,
  unknown.map((r) => `${r.version}: ${r.kind}`).join(', '),
);

/* ------------------------------------------------------------ the step --- */

/** Compare two versions as (minor, patch) pairs, without carrying. */
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? { minor: Number(m[2]), patch: Number(m[3]) } : null;
};

const ordered = rows.map((r) => parse(r.version)).filter(Boolean);
const current = parse(version);
const previous = ordered.filter((p) => p.minor !== current?.minor || p.patch !== current?.patch)
  .filter((p) => p.minor < (current?.minor ?? 0) || (p.minor === current?.minor && p.patch < (current?.patch ?? 0)))
  .sort((a, b) => (a.minor - b.minor) || (a.patch - b.patch))
  .pop();

check('there is a previous release to step from', previous !== undefined, 'the ledger has no earlier row');

if (previous && current) {
  const kind = rows.find((r) => r.version === version)?.kind;
  const isAddition = previous.minor + 1 === current.minor && current.patch === 0;
  const isOther = previous.minor === current.minor && previous.patch + 1 === current.patch;
  check(
    'the step from the previous release is legal: (minor+1, 0) or (minor, patch+1)',
    isAddition || isOther,
    `previous ${previous.minor}.${previous.patch} -> current ${current.minor}.${current.patch}`,
  );
  check(
    'the recorded kind agrees with the step that was taken',
    kind === 'sub-component' ? isAddition : isOther,
    `kind "${kind}" with step ${isAddition ? 'minor+1' : isOther ? 'patch+1' : 'neither'}`,
  );
}

// The two positions are counters and must not carry. Stated as an assertion because the
// whole point of the rule is that these numbers are not read as semver.
check(
  'a patch field above 9 does not roll into minor',
  !(patch === 0 && minor > 0 && previous && previous.patch + 1 === 10),
  'the ledger should show 0.1.10, never 0.2.0, for an eleventh ordinary change',
);

console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
