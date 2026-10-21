#!/usr/bin/env node
/**
 * measure-failure-log-mutations.mjs — measure every assertion the failure log added.
 *
 * The rule this repository keeps learning the hard way: an assertion that cannot fail is not an
 * assertion. Each mutation below removes exactly the thing one new assertion exists to protect —
 * the append, the cause chain, the placeholder mapping, the single writer, the record call
 * itself — and the named gate is then run against the mutated bytes. A mutation that leaves the
 * GATE GREEN is reported as UNPROTECTED, not as a pass; a mutation that turns the gate red for
 * some other reason than the named check is reported as MISATTRIBUTED.
 *
 * Restoration is by the exact bytes captured at start-up and verified with sha256, never trusted
 * to the mutation's own inverse, and the original bytes are written back in a `finally` and again
 * on process exit, so an interrupted run cannot leave a mutated package behind.
 *
 * Every gate here runs against a THROWAWAY root (`mkdtemp`), which is why this can be run at all:
 * the feature under measurement writes failures to `<root>/errors.jsonl`, and a measurement that
 * wrote them into the user's own ~/.Newmark would be worse than no measurement.
 *
 *     node scripts/measure-failure-log-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PKG = join(REPO, 'packages', 'newmark-core');
const SCRATCH = process.env.NM_FAILURE_LOG_MUTATIONS_SCRATCH?.trim()
  ? resolve(process.env.NM_FAILURE_LOG_MUTATIONS_SCRATCH.trim())
  : join(REPO, 'evidence', 'failure-log-mutations', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(SCRATCH, { recursive: true });

const FILES = {
  errors: join(PKG, 'lib', 'errors.js'),
  core: join(PKG, 'index.js'),
  memorylab: join(PKG, 'components', 'memorylab', 'component.js'),
  memorylabRow: join(PKG, 'components', 'memorylab', 'index.js'),
  computeruse: join(PKG, 'components', 'computeruse', 'component.js'),
};
const GATES = {
  failures: join(REPO, 'scripts', 'verify-failure-log.mjs'),
  memorylab: join(REPO, 'scripts', 'verify-memorylab-tools.mjs'),
  preset: join(REPO, 'scripts', 'verify-preset-patch.mjs'),
};

/** The exact bytes of every file this script can mutate, kept for the byte-for-byte restore. */
const ORIGINAL = new Map(Object.entries(FILES).map(([key, file]) => [key, readFileSync(file)]));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

let mutated = null;
function restoreAll() {
  for (const [key, bytes] of ORIGINAL) {
    if (fs_exists_differs(FILES[key], bytes)) writeFileSync(FILES[key], bytes);
  }
  mutated = null;
}
function fs_exists_differs(file, bytes) {
  try {
    return sha(readFileSync(file)) !== sha(bytes);
  } catch {
    return true;
  }
}
process.on('exit', restoreAll);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

/**
 * Each mutation names the assertion it is meant to make able to fail.
 *
 * `find` must occur EXACTLY once in that file (`all: true` for the two deliberate
 * replace-everywhere cases), so a mutation that no longer matches its source is reported as a
 * NO-OP rather than silently measuring something else.
 */
const MUTATIONS = [
  {
    id: 'M1',
    file: 'errors',
    gate: 'failures',
    protects: 'the line carries `detail` — the cause chain — when there is one',
    find: "  if (detail !== '') line.detail = detail;",
    replace: "  if (detail === '\\u0000mutated') line.detail = detail;",
    expect: 'a line carries at, where, code and message',
  },
  {
    id: 'M2',
    file: 'errors',
    gate: 'failures',
    protects: 'the file is APPENDED to, never rewritten',
    find: "{ encoding: 'utf8', flag: 'a' }",
    replace: "{ encoding: 'utf8', flag: 'w' }",
    all: true,
    expect: 'a second failure is APPENDED',
  },
  {
    id: 'M3',
    file: 'errors',
    gate: 'failures',
    protects: 'a directory that does not exist is created, and the write still lands',
    find: "    if (error?.code !== 'ENOENT') return error;",
    replace: '    return error;',
    expect: 'the directory did not exist and was created',
  },
  {
    id: 'M4',
    file: 'errors',
    gate: 'failures',
    protects: 'a logger that throws takes nothing down',
    find: '    } catch {\n      // A logger that throws must not take down the operation it was describing. There is',
    replace: '    } catch (never) {\n      throw never;\n      // A logger that throws must not take down the operation it was describing. There is',
    expect: 'a logger that throws takes nothing down',
  },
  {
    id: 'M5',
    file: 'errors',
    gate: 'failures',
    protects: 'with no usable root the failure is printed only and NOT written anywhere',
    find: "      if (file === '') return { ok: false, path: '', error: 'no_root' };",
    replace: "      if (file === '') return { ok: true, path: '', error: '' };",
    expect: 'with no root at all the failure is PRINTED only',
  },
  {
    id: 'M6',
    file: 'errors',
    gate: 'failures',
    protects: 'the four required keys cannot be overwritten by the caller’s own fields',
    find: "      if (key === 'at' || key === 'where' || key === 'code' || key === 'message' || key === 'detail') continue;",
    replace: "      if (key === '\\u0000never') continue;",
    expect: 'the four required keys cannot be overwritten',
  },
  {
    id: 'M7',
    file: 'computeruse',
    gate: 'failures',
    protects: 'the failure log has exactly ONE writer',
    find: '  const failures = createErrorLog({ root, logger });',
    replace: "  const failures = createErrorLog({ root, logger });\n  const ERROR_LOG_FILENAME = 'errors.jsonl';",
    expect: 'the log has exactly ONE writer',
  },
  {
    id: 'M8',
    file: 'memorylab',
    gate: 'failures',
    protects: 'the MemoryLab component reaches the shared implementation instead of growing its own',
    find: '  const failures = createErrorLog({ root, logger });',
    replace: "  const failures = { record() {}, path: '' };",
    expect: 'memorylab component reaches the shared implementation',
  },
  {
    id: 'M9',
    file: 'core',
    gate: 'failures',
    protects: 'a model write whose edit throws is recorded as core/model-write write_failed',
    find: "                  failures.record({\n                    where: 'core/model-write',\n                    code: 'write_failed',",
    replace: "                  void ({\n                    where: 'core/model-write',\n                    code: 'write_failed',",
    expect: 'a model write whose edit throws is recorded as core/model-write',
  },
  {
    id: 'M10',
    file: 'core',
    gate: 'failures',
    protects: 'a model write that returns without taking is recorded as write_not_verified',
    find: "                  failures.record({\n                    where: 'core/model-write',\n                    code: 'write_not_verified',",
    replace: "                  void ({\n                    where: 'core/model-write',\n                    code: 'write_not_verified',",
    expect: 'a model write that returns without taking is recorded as write_not_verified',
  },
  {
    id: 'M11',
    file: 'core',
    gate: 'failures',
    protects: 'a model write that TOOK writes nothing — a success must not be recorded as a failure',
    find: '                if (!ok) {\n                  // The write returned without complaint and the file does not agree.',
    replace: '                if (true) {\n                  // The write returned without complaint and the file does not agree.',
    expect: 'a model write that TAKES writes nothing',
  },
  {
    id: 'M12',
    file: 'core',
    gate: 'failures',
    protects: 'a refused preset write is recorded under the module’s OWN refusal code',
    find: "                failures.record({\n                  where: 'core/preset-switch',\n                  code: String(result.error || 'write_refused'),",
    replace: "                void ({\n                  where: 'core/preset-switch',\n                  code: String(result.error || 'write_refused'),",
    expect: 'a refused preset write is recorded under the module’s OWN refusal code',
  },
  {
    id: 'M12b',
    file: 'core',
    gate: 'preset',
    protects: 'the same refusal reaches the log when the route, not the module, is what refused',
    find: "                failures.record({\n                  where: 'core/preset-switch',\n                  code: String(result.error || 'write_refused'),",
    replace: "                void ({\n                  where: 'core/preset-switch',\n                  code: String(result.error || 'write_refused'),",
    expect: 'a refused preset write is saved under the shared root',
  },
  {
    id: 'M13',
    file: 'core',
    gate: 'failures',
    protects: 'the preset refusal is recorded under its own code, not summarised as write_refused',
    find: "                  code: String(result.error || 'write_refused'),",
    replace: "                  code: 'write_refused',",
    expect: 'a refused preset write is recorded under the module’s OWN refusal code',
  },
  {
    id: 'M14',
    file: 'core',
    gate: 'failures',
    protects: 'a component that cannot be composed is recorded as core/compose compose_failed',
    find: "              failures.record({\n                where: 'core/compose',\n                code: 'compose_failed',",
    replace: "              void ({\n                where: 'core/compose',\n                code: 'compose_failed',",
    expect: 'a component that cannot be composed is recorded as core/compose',
  },
  {
    id: 'M15',
    file: 'memorylab',
    gate: 'memorylab',
    protects: '`judged` and `none` write NOTHING: the steady state is not a failure',
    find: "    if (envelope.status === 'judged' || envelope.status === 'none') return;",
    replace: "    if (envelope.status === '\\u0000never') return;",
    expect: 'a verdict and a clean store write nothing',
  },
  {
    id: 'M16',
    file: 'memorylab',
    gate: 'memorylab',
    protects: 'a timeout is recorded as a timeout, under the log’s own name for that event',
    find: "    const placeholder = own === '' || own === envelope.status;",
    replace: '    const placeholder = false;',
    expect: 'a timeout is recorded as a timeout',
  },
  {
    id: 'M17',
    file: 'memorylab',
    gate: 'memorylab',
    protects: 'every judgement code is the RUN’S OWN, never one summary for all of them',
    find: '    const code = placeholder ? JUDGEMENT_LOG_CODE[envelope.status] || `judgement_${envelope.status}` : own;',
    replace: "    const code = 'judgement_failed';",
    expect: 'every judgement that is not a verdict is persisted',
  },
  {
    id: 'M18',
    file: 'memorylab',
    gate: 'memorylab',
    protects: 'agent-api switched off is its own code, not a generic unavailability',
    find: "    unavailable: 'agent_api_off',",
    replace: "    unavailable: 'judgement_unavailable',",
    expect: 'agent-api switched off is its own code in the log',
  },
  {
    id: 'M19',
    file: 'memorylab',
    gate: 'memorylab',
    protects: 'a deterministic rebuild that throws is recorded as memorylab/rebuild rebuild_failed',
    find: "      failures.record({\n        where: 'memorylab/rebuild',\n        code: 'rebuild_failed',",
    replace: "      void ({\n        where: 'memorylab/rebuild',\n        code: 'rebuild_failed',",
    expect: 'a deterministic rebuild that throws is recorded as memorylab/rebuild',
  },
  {
    id: 'M20',
    file: 'computeruse',
    gate: 'failures',
    protects: 'a backend that answers an error is examined at all',
    find: "    reportOutcome(String(options?.action || 'observe'), value);",
    replace: '    void value;',
    expect: 'a backend that answers an error is recorded with the backend’s OWN code',
  },
  {
    id: 'M21',
    file: 'computeruse',
    gate: 'failures',
    protects: 'a backend call that SUCCEEDS writes nothing',
    find: "    if (!value || typeof value !== 'object' || value.ok !== false) return;",
    replace: "    if (!value || typeof value !== 'object') return;",
    expect: 'a backend call that succeeds writes nothing',
  },
  {
    id: 'M22',
    file: 'computeruse',
    gate: 'failures',
    protects: 'the backend’s OWN code is recorded, not a summary of it',
    find: "      code: String(value.code || value.error_code || 'backend_error'),",
    replace: "      code: 'backend_error',",
    expect: 'a backend that answers an error is recorded with the backend’s OWN code',
  },
  {
    id: 'M23',
    file: 'memorylab',
    gate: 'memorylab',
    protects: 'a write that does not verify after the rebuild is recorded as memorylab/write',
    find: "      failures.record({\n        where: 'memorylab/write',\n        code: 'write_not_verified',",
    replace: "      void ({\n        where: 'memorylab/write',\n        code: 'write_not_verified',",
    expect: 'a write that does not verify after the rebuild is recorded as memorylab/write',
  },
  {
    id: 'M24',
    file: 'memorylabRow',
    gate: 'memorylab',
    protects: 'a route handler that throws is recorded as memorylab/snapshot, not only answered',
    find: "            memorylab.failures.record({\n              where: 'memorylab/snapshot',\n              code: 'snapshot_failed',",
    replace: "            void ({\n              where: 'memorylab/snapshot',\n              code: 'snapshot_failed',",
    expect: 'a route that throws answers 500 AND is recorded as memorylab/snapshot',
  },
];

/** One gate run. The gate's own verdict is its summary line, not the exit code alone. */
function runGate(gate) {
  let out = '';
  let code = 0;
  try {
    /* `stdio` is spelled out because `execFileSync` INHERITS a child's stderr by default, even
     * while capturing it into `error.stderr`. A mutated gate that dies writes its stack to
     * stderr, that stack reached this script's own stderr, and a shell reading a pipeline whose
     * native command wrote to stderr reports the whole run as failed — so a measurement where
     * every mutation was caught ended as `exit code 1`. A success reported as a failure is the
     * same defect class this repository lost two releases to, so it is fixed here rather than
     * explained away. */
    out = execFileSync('node', [gate], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    out = String(error.stdout || '') + String(error.stderr || '');
    code = typeof error.status === 'number' ? error.status : -1;
  }
  const summary = /passed=(\d+) failed=(\d+)/.exec(out);
  const red = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1].trim());
  return {
    exitCode: code,
    passed: summary ? Number(summary[1]) : null,
    failedCount: summary ? Number(summary[2]) : null,
    red,
    aborted: summary === null,
    tail: out.trim().split(/\r?\n/).slice(-2).join(' | '),
  };
}

const report = {
  startedAt: new Date().toISOString(),
  files: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, { file, sha256: sha(ORIGINAL.get(key)), bytes: ORIGINAL.get(key).length }])),
  gates: GATES,
  baselines: {},
  mutations: [],
  unprotected: [],
  misattributed: [],
};

console.log('Newmark Core — failure-log mutation measurement');
for (const [key, entry] of Object.entries(report.files)) console.log(`  ${key.padEnd(12)} ${entry.sha256.slice(0, 16)}  ${entry.file}`);
console.log(`scratch:  ${SCRATCH}\n`);

console.log('--- baselines (unmutated) ---');
for (const [key, gate] of Object.entries(GATES)) {
  const run = runGate(gate);
  report.baselines[key] = run;
  console.log(`  ${key.padEnd(10)} ${run.passed} passed, ${run.failedCount} failed (exit ${run.exitCode})`);
}
if (Object.values(report.baselines).some((run) => run.failedCount !== 0 || run.aborted)) {
  console.log('  a baseline is not green; the mutation table would be meaningless. Stopping.');
  writeFileSync(join(SCRATCH, 'report.json'), JSON.stringify(report, null, 2));
  process.exit(2);
}

for (const mutation of MUTATIONS) {
  const file = FILES[mutation.file];
  const originalText = ORIGINAL.get(mutation.file).toString('utf8');
  const occurrences = originalText.split(mutation.find).length - 1;
  console.log(`\n--- ${mutation.id} (${mutation.file}, gate ${mutation.gate}): ${mutation.protects}`);
  if (occurrences === 0 || (!mutation.all && occurrences !== 1)) {
    console.log(`    NO-OP/AMBIGUOUS: the anchor occurs ${occurrences} time(s); nothing was measured.`);
    report.mutations.push({ id: mutation.id, protects: mutation.protects, file: mutation.file, gate: mutation.gate, noop: true, caught: false, expect: mutation.expect });
    report.unprotected.push({ id: mutation.id, reason: `anchor occurs ${occurrences} time(s)` });
    continue;
  }
  const mutatedText = mutation.all ? originalText.split(mutation.find).join(mutation.replace) : originalText.replace(mutation.find, mutation.replace);
  const mutatedBytes = Buffer.from(mutatedText, 'utf8');
  mutated = mutation.file;
  writeFileSync(file, mutatedBytes);
  let run;
  let restoredSha = null;
  try {
    run = runGate(GATES[mutation.gate]);
  } finally {
    writeFileSync(file, ORIGINAL.get(mutation.file));
    restoredSha = sha(readFileSync(file));
    mutated = null;
  }
  const expectedRed = run.red.filter((name) => name.includes(mutation.expect));
  const caught = expectedRed.length > 0;
  const misattributed = caught && run.red.length !== expectedRed.length;
  console.log(`    planted sha256 ${sha(mutatedBytes).slice(0, 16)}…  (${mutatedBytes.length} B)`);
  console.log(`    gate: ${run.passed} passed, ${run.failedCount} failed (exit ${run.exitCode})${run.aborted ? ' — ABORTED BEFORE ITS SUMMARY' : ''}`);
  console.log(`    restored sha256 ${restoredSha.slice(0, 16)}…  byte-for-byte=${restoredSha === report.files[mutation.file].sha256}`);
  if (caught) {
    for (const name of run.red) console.log(`      red: ${name}`);
    if (misattributed) console.log('    NOTE: other checks went red as well — reported, not hidden.');
  } else if (run.aborted) {
    console.log(`    UNPROTECTED as measured: the gate aborted before its summary (${run.tail}).`);
    report.unprotected.push({ id: mutation.id, reason: `gate aborted: ${run.tail}` });
  } else {
    console.log('    UNPROTECTED: the named check stayed green, so it cannot fail.');
    report.unprotected.push({ id: mutation.id, reason: 'named check stayed green' });
  }
  if (misattributed) report.misattributed.push({ id: mutation.id, red: run.red });
  if (restoredSha !== report.files[mutation.file].sha256) {
    console.log(`    !! RESTORE FAILED — ${file} is NOT the original. Stopping.`);
    report.mutations.push({ id: mutation.id, restoteFailed: true, caught, run });
    writeFileSync(join(SCRATCH, 'report.json'), JSON.stringify(report, null, 2));
    process.exit(1);
  }
  report.mutations.push({
    id: mutation.id,
    protects: mutation.protects,
    file: mutation.file,
    gate: mutation.gate,
    expect: mutation.expect,
    caught,
    misattributed,
    mutatedSha256: sha(mutatedBytes),
    restoredSha256: restoredSha,
    red: run.red,
    passed: run.passed,
    failedCount: run.failedCount,
  });
}

console.log('\n--- final confirmation (unmutated) ---');
for (const [key, gate] of Object.entries(GATES)) {
  const run = runGate(gate);
  report.baselines[key] = { ...report.baselines[key], final: run };
  console.log(`  ${key.padEnd(10)} ${run.passed} passed, ${run.failedCount} failed (exit ${run.exitCode})`);
}
const restoredAll = Object.entries(FILES).every(([key, file]) => sha(readFileSync(file)) === report.files[key].sha256);
report.restoredByteForByte = restoredAll;
report.finishedAt = new Date().toISOString();
writeFileSync(join(SCRATCH, 'report.json'), JSON.stringify(report, null, 2));

console.log('\n=== MUTATION TABLE ===');
for (const entry of report.mutations) {
  const verdict = entry.noop ? 'NO-OP' : entry.caught ? 'RED (caught)' : 'GREEN (UNPROTECTED)';
  console.log(`  ${entry.id.padEnd(5)} ${verdict.padEnd(20)} ${entry.caught ? entry.red.find((name) => name.includes(entry.expect)) ?? '' : ''}`);
}
console.log(`\nunprotected: ${report.unprotected.length === 0 ? 'none' : report.unprotected.map((entry) => `${entry.id} (${entry.reason})`).join(', ')}`);
console.log(`all original bytes restored: ${restoredAll}`);
console.log('receipt:', join(SCRATCH, 'report.json'));
const exitCode = report.unprotected.length === 0 && restoredAll ? 0 : 1;
console.log(`exit code: ${exitCode}`);
process.exit(exitCode);
