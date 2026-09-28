'use strict';

/**
 * Gate: diagnostics and probes stay in source, never in a shipped artifact.
 *
 * Checks, without packaging:
 *   1. `package.json` build.files excludes compiled tests and the probe modules;
 *   2. the current `dist/` build contains no probe files when built with
 *      `--strip-diagnostics` (and does contain them in a dev build — proving the
 *      source copy is retained and the strip is what removes it);
 *   3. an existing packaged app.asar (if present) ships no `dist/tests` entry,
 *      no probe module and no probe marker in the utility host bundle.
 *
 *   node scripts/verify-package-no-diagnostics.cjs [--expect-dev-probe]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const expectDevProbe = process.argv.includes('--expect-dev-probe');
const failures = [];
const checks = [];
const check = (ok, message) => {
  checks.push({ ok: !!ok, message });
  if (!ok) failures.push(message);
};

const MARKERS = ['NEWMARK_MEMORY_PROBE', 'writeHeapSnapshot', 'host-memory.jsonl', 'memoryProbe', 'MemoryProbe'];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = pkg.build?.files || [];
const hasNegation = pattern => files.some(entry => String(entry) === pattern);

check(hasNegation('!dist/tests/**/*'), 'package.json build.files excludes compiled tests (dist/tests)');
check(hasNegation('!dist/core/memoryProbe.js'), 'package.json build.files excludes the probe module');

const hostBundlePath = path.join(root, 'dist', 'conversation-utility-host.bundle.cjs');
check(fs.existsSync(hostBundlePath), 'utility host bundle exists (run npm run build first)');
const bundleText = fs.existsSync(hostBundlePath) ? fs.readFileSync(hostBundlePath, 'utf8') : '';
const presentMarkers = MARKERS.filter(marker => bundleText.includes(marker));

if (expectDevProbe) {
  check(presentMarkers.length > 0,
    `dev build keeps the probe in source and in the dev bundle (${presentMarkers.join(', ') || 'none found'})`);
}

// Build the packaged variant into a temp file so this gate never mutates the
// working `dist/` (a developer may be running the diagnostics bundle).
const tempBundle = path.join(os.tmpdir(), `newmark-stripped-host-${process.pid}.cjs`);
const stripBuild = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-conversation-utility-host.cjs'), '--strip-diagnostics'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, NEWMARK_UTILITY_HOST_OUTFILE: tempBundle },
});
check(stripBuild.status === 0, `strip build succeeds (status ${stripBuild.status})`);
if (stripBuild.status === 0 && fs.existsSync(tempBundle)) {
  const stripped = fs.readFileSync(tempBundle, 'utf8');
  const strippedMarkers = MARKERS.filter(marker => stripped.includes(marker));
  check(strippedMarkers.length === 0,
    `--strip-diagnostics produces a probe-free bundle (found: ${strippedMarkers.join(', ') || 'none'})`);
}
try { fs.rmSync(tempBundle, { force: true }); } catch { /* temp file cleanup is best effort */ }

const asarPath = path.join(root, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
if (fs.existsSync(asarPath)) {
  const asar = require('@electron/asar');
  const entries = asar.listPackage(asarPath);
  const testEntries = entries.filter(entry => entry.replace(/\\/g, '/').includes('/dist/tests/'));
  check(testEntries.length === 0,
    `packaged app.asar ships no compiled tests (found ${testEntries.length}${testEntries.length ? '; artifact predates this policy — re-run packaging' : ''})`);
  const probeEntries = entries.filter(entry => /memoryProbe/i.test(entry));
  check(probeEntries.length === 0, `packaged app.asar ships no probe modules (found ${probeEntries.length})`);
  const unpackedHost = path.join(root, '..', 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'dist', 'conversation-utility-host.bundle.cjs');
  if (fs.existsSync(unpackedHost)) {
    const packagedText = fs.readFileSync(unpackedHost, 'utf8');
    const packagedMarkers = MARKERS.filter(marker => packagedText.includes(marker));
    check(packagedMarkers.length === 0,
      `packaged utility host contains no probe markers (found: ${packagedMarkers.join(', ') || 'none'})`);
  } else {
    checks.push({ ok: true, message: 'packaged utility host bundle not present; asar checks only' });
  }
} else {
  checks.push({ ok: true, message: 'no packaged app.asar present; static + dist checks only' });
}

check(fs.existsSync(path.join(root, 'src', 'core', 'memoryProbe.ts')),
  'probe source is retained in the repository (src/core/memoryProbe.ts)');

console.log(JSON.stringify({ checks: checks.map(entry => `${entry.ok ? 'PASS' : 'FAIL'} ${entry.message}`), failures }, null, 2));
process.exit(failures.length ? 1 : 0);
