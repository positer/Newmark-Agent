#!/usr/bin/env node
/**
 * measure-computeruse-param-mutations.mjs — measure every assertion this fix added.
 *
 * The rule this repo keeps learning the hard way: an assertion that cannot fail is not an
 * assertion. Each mutation below removes exactly the mapping (or the guard) that one new
 * assertion exists to protect, and the gate is run against the mutated bytes. A mutation
 * that does NOT turn the gate red is reported as UNPROTECTED, not as a pass.
 *
 * Restoration is by the exact bytes captured at start-up and verified with sha256, never
 * trusted to the mutation's own inverse.
 *
 * Safety: the gate (`verify-computeruse-output-boundary.mjs`) stubs `prepareLane`/`runInLane`
 * at the single choke point, so no pointer is moved, no key typed and no process spawned.
 *
 *     node scripts/measure-computeruse-param-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const GATE = join(REPO, 'scripts', 'verify-computeruse-output-boundary.mjs');
const COMPONENT = join(REPO, 'packages', 'newmark-core', 'components', 'computeruse', 'component.js');
const SCRATCH = process.env.NM_CU_PARAM_MUTATIONS_SCRATCH?.trim()
  ? resolve(process.env.NM_CU_PARAM_MUTATIONS_SCRATCH.trim())
  : join(REPO, 'evidence', 'computeruse-param-mutations', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(SCRATCH, { recursive: true });

const ORIGINAL = readFileSync(COMPONENT);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ORIGINAL_SHA = sha(ORIGINAL);

/**
 * Each mutation names the assertion it is supposed to make able to fail. `apply` must change
 * the text; if it does not, the mutation is reported as a no-op rather than counted.
 */
const MUTATIONS = [
  {
    id: 'M1',
    protects: 'a `dry_run: true` argument never engages the `action` lane / comes back saying it was a dry run',
    apply: (text) => text.replace("  dry_run: 'dryRun',\n", ''),
  },
  {
    id: 'M2',
    protects: 'declared `start_x`/`start_y`/`end_x`/`end_y` arrive at the backend as the points it drags between',
    apply: (text) => text.replace("  start_x: 'startX',\n  start_y: 'startY',\n  end_x: 'endX',\n  end_y: 'endY',\n", ''),
  },
  {
    id: 'M3',
    protects: 'a declared `max_chars` reaches the backend as `maxChars`',
    apply: (text) => text.replace("  max_chars: 'maxChars',\n", ''),
  },
  {
    id: 'M4',
    protects: 'a declared `capture_max_width`/`capture_max_height` reaches the backend as `captureMaxWidth`/`captureMaxHeight`',
    apply: (text) => text.replace("  capture_max_width: 'captureMaxWidth',\n  capture_max_height: 'captureMaxHeight',\n", ''),
  },
  {
    id: 'M5',
    protects: 'a declared `target_id` reaches the backend, so the resolved target overrides the caller coordinates',
    apply: (text) => text.replace("  target_id: 'targetId',\n", ''),
  },
  {
    id: 'M6',
    protects: 'the whole translation: swallowing every argument instead of translating it',
    apply: (text) => text.replace('const translated = { ...source };', 'const translated = {};'),
  },
];

/** One gate run. The gate's own verdict is the summary line, not the exit code alone. */
function runGate() {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [GATE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: REPO });
  } catch (error) {
    out = String(error.stdout || '') + String(error.stderr || '');
    code = typeof error.status === 'number' ? error.status : -1;
  }
  const summary = /(\d+) passed, (\d+) failed/.exec(out);
  const failed = [...out.matchAll(/^  \[FAIL\] (.+)$/gm)].map((match) => match[1].trim());
  return {
    exitCode: code,
    passed: summary ? Number(summary[1]) : null,
    failedCount: summary ? Number(summary[2]) : null,
    failed,
  };
}

const report = {
  gate: GATE,
  file: COMPONENT,
  originalSha256: ORIGINAL_SHA,
  originalBytes: ORIGINAL.length,
  startedAt: new Date().toISOString(),
  baseline: null,
  mutations: [],
  unprotected: [],
};

console.log('ComputerUse parameter-translation mutations');
console.log(`file:     ${COMPONENT}`);
console.log(`sha256:   ${ORIGINAL_SHA} (${ORIGINAL.length} B)`);
console.log(`gate:     ${GATE}`);
console.log(`scratch:  ${SCRATCH}\n`);

console.log('--- baseline (unmutated) ---');
report.baseline = runGate();
console.log(`    ${report.baseline.passed} passed, ${report.baseline.failedCount} failed (exit ${report.baseline.exitCode})`);
if (report.baseline.failedCount !== 0) {
  console.log('    the baseline is not green; the mutation table would be meaningless. Stopping.');
  writeFileSync(join(SCRATCH, 'report.json'), JSON.stringify(report, null, 2));
  process.exit(2);
}

for (const mutation of MUTATIONS) {
  console.log(`\n--- ${mutation.id}: ${mutation.protects}`);
  const mutatedText = mutation.apply(ORIGINAL.toString('utf8'));
  if (mutatedText === ORIGINAL.toString('utf8')) {
    console.log('    NO-OP: the mutation did not change the source; nothing was measured.');
    report.mutations.push({ id: mutation.id, protects: mutation.protects, noop: true, caught: false });
    report.unprotected.push({ id: mutation.id, protects: mutation.protects, reason: 'no-op' });
    continue;
  }
  const mutatedBytes = Buffer.from(mutatedText, 'utf8');
  writeFileSync(COMPONENT, mutatedBytes);
  const mutatedSha = sha(mutatedBytes);
  let run;
  let restoredSha = null;
  try {
    run = runGate();
  } finally {
    writeFileSync(COMPONENT, ORIGINAL);
    restoredSha = sha(readFileSync(COMPONENT));
  }
  const caught = run.failedCount !== null && run.failedCount > 0;
  console.log(`    planted sha256 ${mutatedSha.slice(0, 16)}…  (${mutatedBytes.length} B)`);
  console.log(`    gate: ${run.passed} passed, ${run.failedCount} failed (exit ${run.exitCode})`);
  console.log(`    restored sha256 ${restoredSha.slice(0, 16)}…  byte-for-byte=${restoredSha === ORIGINAL_SHA}`);
  if (caught) {
    for (const name of run.failed) console.log(`      red: ${name}`);
  } else {
    console.log('    UNPROTECTED: the gate stayed green under this mutation, so the assertion cannot fail.');
    report.unprotected.push({ id: mutation.id, protects: mutation.protects, reason: 'gate stayed green' });
  }
  if (restoredSha !== ORIGINAL_SHA) {
    console.log(`    !! RESTORE FAILED — file is NOT the original. sha256 ${restoredSha}`);
    report.mutations.push({ id: mutation.id, protects: mutation.protects, caught, mutatedSha, restoredSha, run, restoreFailed: true });
    report.unprotected.push({ id: mutation.id, protects: mutation.protects, reason: 'restore failed' });
    break;
  }
  report.mutations.push({ id: mutation.id, protects: mutation.protects, caught, mutatedSha, restoredSha, run });
}

console.log('\n--- final confirmation (unmutated) ---');
const finalRun = runGate();
const finalSha = sha(readFileSync(COMPONENT));
console.log(`    ${finalRun.passed} passed, ${finalRun.failedCount} failed (exit ${finalRun.exitCode})`);
console.log(`    file sha256 ${finalSha} byte-for-byte-original=${finalSha === ORIGINAL_SHA}`);
report.final = { ...finalRun, sha256: finalSha, byteForByteOriginal: finalSha === ORIGINAL_SHA };
report.finishedAt = new Date().toISOString();

writeFileSync(join(SCRATCH, 'report.json'), JSON.stringify(report, null, 2));

console.log('\n=== MUTATION TABLE ===');
for (const entry of report.mutations) {
  const verdict = entry.noop ? 'NO-OP' : entry.caught ? 'RED (caught)' : 'GREEN (UNPROTECTED)';
  console.log(`  ${entry.id}  ${verdict.padEnd(18)}  ${entry.caught ? (entry.run.failed[0] ?? '').slice(0, 78) : ''}`);
}
console.log(`\nunprotected: ${report.unprotected.length === 0 ? 'none' : report.unprotected.map((e) => e.id).join(', ')}`);
console.log('receipt:', join(SCRATCH, 'report.json'));
process.exit(report.unprotected.length === 0 && finalRun.failedCount === 0 && finalSha === ORIGINAL_SHA ? 0 : 1);
