#!/usr/bin/env node
/**
 * measure-computeruse-boundary-mutations.mjs — the falsification harness for
 * `verify-computeruse-output-boundary.mjs`.
 *
 * =====================================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================================
 *
 * A green assertion that cannot fail is worse than no assertion. The boundary probe above
 * asserts "no ComputerUse tool value contains an `undefined`-valued key, every value passes
 * DSH's own `snapshotJsonValue`, and every answer arrived as a JSON string that the tool
 * parsed". This harness proves each of those predicates can go red, by planting a mutation
 * in the code under test, running the probe, and restoring the file **byte-for-byte**.
 *
 * A mutation whose expected verdict is GREEN is a control: it shows the probe measures the
 * property rather than reacting to any edit at all. The two green entries are also the two
 * proposed site fixes, so "fixing each site is behaviour-neutral" is measured rather than
 * argued.
 *
 * Invoke it by hand:
 *
 *     node scripts/measure-computeruse-boundary-mutations.mjs
 *
 * Exit codes:
 *   0  every mutation produced its expected verdict and every file was restored by sha256
 *   1  a mutation produced the wrong verdict, or a source file was not restored
 *   2  the harness could not run (a file or an anchor did not match exactly once)
 *
 * **The source is restored from bytes captured at start-up, in a `finally`, on every path —
 * including a failed mutation, a thrown probe and an interrupt.** Every restoration is
 * verified by sha256 and reported; the run ends with a second sha256 sweep of every file it
 * touched.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CU_DIR = join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const WIN32 = join(CU_DIR, 'lib', 'win32.js');
const LINUX = join(CU_DIR, 'lib', 'linux.js');
const COMPONENT = join(CU_DIR, 'component.js');

const PROBE = join(HERE, 'verify-computeruse-output-boundary.mjs');
const SCRATCH_ROOT = join(REPO, 'evidence', 'computeruse-output-boundary', 'mutations');

/**
 * Phases for the mutation runs.
 *
 * Deliberately without `real`: the real phase is the same four predicates applied to live
 * capture data, and planting six mutations must not mean six rounds of desktop capture. The
 * unmutated full run (all five phases) is the gate; this table is about falsifiability.
 */
const PHASES = process.env.NM_CU_BOUNDARY_MUTATION_PHASES?.trim() || 'stub,sites,counterfactual,linux';

const MUTATIONS = [
  {
    id: 'M1',
    file: WIN32,
    name: 'the Win32 backend stops serialising: runComputerUse returns the result object',
    find: '    return stringifyResult(result);',
    replace: '    return result;',
    expect: 'RED',
    why:
      'This is the whole hypothesis in one line. The object really does carry undefined-valued fields, so if the ' +
      'serialisation is removed the registry must reject the value — and it must reject it AFTER the backend has ' +
      'already composed an answer.',
  },
  {
    id: 'M2',
    file: COMPONENT,
    name: 'the tool layer stops parsing: asToolResult returns the raw JSON string',
    find: [
      "  if (typeof value === 'string') {",
      '    try {',
      '      const parsed = JSON.parse(value);',
      "      if (parsed && typeof parsed === 'object') return parsed;",
      '    } catch {',
      '      /* not JSON: fall through and report it as text */',
      '    }',
      '    return { ok: true, text: value };',
      '  }',
    ].join('\n'),
    replace: "  if (typeof value === 'string') return value;",
    expect: 'RED',
    why:
      'Proves the probe covers the tool layer itself, for BOTH tools: the declared output schema is an object, so a ' +
      'bare string value is rejected by the same boundary.',
  },
  {
    id: 'M3',
    file: COMPONENT,
    name: 'the computer_use tool adds one undefined-valued key to its own answer',
    find: ['            observeLeaseArgs(args, result);', '            return asToolResult(result);'].join('\n'),
    replace: [
      '            observeLeaseArgs(args, result);',
      '            return { ...asToolResult(result), boundary_probe_undefined: undefined };',
    ].join('\n'),
    expect: 'RED',
    why:
      'The backend funnel is not the only way an undefined can reach the boundary. This plants one after it, in the ' +
      'tool definition, and shows the probe catches that too.',
  },
  {
    id: 'M4',
    file: WIN32,
    name: 'CONTROL — the candidate site fix at win32.js:3794 (undefined becomes null)',
    find: '    overlay_last_error: lease.lastOverlayError || undefined,',
    replace: '    overlay_last_error: lease.lastOverlayError || null,',
    expect: 'GREEN',
    why:
      'A control, and the reason the recommended change is "nothing": removing one undefined at its site changes ' +
      'nothing a caller can observe, so the probe must stay green. A probe that went red here would be measuring ' +
      'the edit rather than the property.',
  },
  {
    id: 'M5',
    file: WIN32,
    name: 'CONTROL — the serialiser stops pretty-printing',
    find: '  let output = JSON.stringify(result, null, 2);',
    replace: '  let output = JSON.stringify(result);',
    expect: 'GREEN',
    why: 'A control: the probe asserts what the value IS, not how the transport formats it.',
  },
  {
    id: 'M6',
    file: LINUX,
    name: 'the Linux backend stops serialising (the other platform, same funnel)',
    find: '    return stringifyResult(result);',
    replace: '    return result;',
    expect: 'RED',
    why:
      'The Linux backend is not loaded on this host, so the probe drives it directly. This proves that measurement ' +
      'is live: without it, "the Linux backend also answers lossless JSON" would be an untested claim.',
  },
];

/* ------------------------------------------------------------------------ reporting --- */

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const say = (line = '') => process.stdout.write(String(line) + '\n');

/** The bytes every file starts with, and the sha256 they must end with. */
const PRISTINE = new Map();
for (const file of [WIN32, LINUX, COMPONENT]) {
  PRISTINE.set(file, { bytes: readFileSync(file), sha256: null });
}
for (const [, entry] of PRISTINE) entry.sha256 = sha256(entry.bytes);

/** Put a file back exactly as it was found, and prove it. */
function restore(file) {
  const pristine = PRISTINE.get(file);
  writeFileSync(file, pristine.bytes);
  const after = sha256(readFileSync(file));
  return { file, expected: pristine.sha256, actual: after, restored: after === pristine.sha256 };
}

let RESTORE_ALL = true;
process.on('exit', () => {
  if (!RESTORE_ALL) return;
  for (const file of PRISTINE.keys()) {
    try {
      const current = sha256(readFileSync(file));
      if (current !== PRISTINE.get(file).sha256) writeFileSync(file, PRISTINE.get(file).bytes);
    } catch {
      /* a file that cannot be read at exit cannot be repaired here; the sha256 sweep reports it */
    }
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const file of PRISTINE.keys()) {
      try {
        writeFileSync(file, PRISTINE.get(file).bytes);
      } catch {
        /* best effort on a signal path */
      }
    }
    process.exit(1);
  });
}

/* ---------------------------------------------------------------------------- main --- */

function main() {
  say('Newmark Core — ComputerUse output-boundary MUTATION harness');
  say('==========================================================');
  say(`probe:    ${PROBE}`);
  say(`phases:   ${PHASES}   (the unmutated full run is the gate; this table is falsifiability)`);
  say(`scratch:  ${SCRATCH_ROOT}`);
  say('\npristine sources:');
  for (const [file, entry] of PRISTINE) say(`  ${entry.sha256}  ${file}`);
  mkdirSync(SCRATCH_ROOT, { recursive: true });

  const table = [];
  let wrongVerdicts = 0;

  for (const mutation of MUTATIONS) {
    say(`\n=== ${mutation.id} — ${mutation.name} ===`);
    const pristine = PRISTINE.get(mutation.file);
    const onDisk = sha256(readFileSync(mutation.file));
    if (onDisk !== pristine.sha256) {
      say(`  ! ${mutation.file} is not at its pristine sha256 (${onDisk}); refusing to plant a mutation on it.`);
      return 2;
    }
    const source = pristine.bytes.toString('utf8');
    const hits = source.split(mutation.find).length - 1;
    if (hits !== 1) {
      say(`  ! the anchor occurs ${hits} time(s) in ${mutation.file}; refusing to guess.`);
      return 2;
    }

    const scratch = join(SCRATCH_ROOT, `${mutation.id}-${randomUUID().slice(0, 8)}`);
    mkdirSync(scratch, { recursive: true });
    let verdict = 'NO-RECEIPT';
    let failedNames = [];
    let passed = 0;
    let probeStatus = null;
    let restored = null;

    try {
      writeFileSync(mutation.file, source.replace(mutation.find, mutation.replace));
      const mutatedSha = sha256(readFileSync(mutation.file));
      say(`  planted:  ${pristine.sha256} -> ${mutatedSha}`);
      const result = spawnSync(process.execPath, [PROBE], {
        cwd: resolve(REPO, '..'),
        /* stdio is inherited, not piped: the probe's own transcript is wanted in this
         * terminal, and a pipe is a capture this harness does not need. */
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          NM_CU_BOUNDARY_PHASES: PHASES,
          NM_CU_BOUNDARY_SCRATCH: scratch,
        },
      });
      probeStatus = result.status;
      const receiptPath = join(scratch, 'receipt.json');
      if (existsSync(receiptPath)) {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        passed = receipt.passed;
        failedNames = receipt.failed;
        verdict = receipt.failed.length > 0 ? 'RED' : 'GREEN';
      } else {
        verdict = 'NO-RECEIPT';
        failedNames = [`the probe wrote no receipt at ${receiptPath}`];
      }
    } finally {
      restored = restore(mutation.file);
      RESTORE_ALL = false;
    }

    const ok = verdict === mutation.expect && restored.restored;
    if (!ok) wrongVerdicts += 1;
    say(`  verdict:  ${verdict} (expected ${mutation.expect})  ${ok ? 'OK' : 'WRONG'}`);
    say(`  probe:    exit=${probeStatus}  ${passed} passed, ${failedNames.length} failed`);
    if (failedNames.length > 0) for (const name of failedNames) say(`            red: ${name}`);
    say(`  restore:  ${restored.actual}  ${restored.restored ? 'byte-for-byte OK' : `MISMATCH, expected ${restored.expected}`}`);
    say(`  why:      ${mutation.why}`);
    table.push({
      id: mutation.id,
      name: mutation.name,
      file: mutation.file,
      find: mutation.find,
      replace: mutation.replace,
      expect: mutation.expect,
      verdict,
      probeExit: probeStatus,
      passed,
      failed: failedNames,
      restored,
      ok,
    });
  }

  say('\n=== MUTATION TABLE ===');
  say('  id  expected  verdict  probe  passed  failed  restore');
  for (const row of table) {
    say(
      `  ${row.id.padEnd(3)} ${row.expect.padEnd(9)} ${row.verdict.padEnd(8)} ${String(row.probeExit).padEnd(6)} ` +
        `${String(row.passed).padEnd(7)} ${String(row.failed.length).padEnd(7)} ${row.restored.restored ? 'byte-for-byte' : 'FAILED'}`,
    );
  }

  say('\n=== FINAL SHA256 SWEEP ===');
  let intact = true;
  for (const [file, entry] of PRISTINE) {
    const current = sha256(readFileSync(file));
    const same = current === entry.sha256;
    if (!same) intact = false;
    say(`  ${same ? 'OK  ' : 'DIFF'} ${current}  ${file}`);
  }

  const report = {
    harness: 'measure-computeruse-boundary-mutations',
    finishedAt: new Date().toISOString(),
    phases: PHASES,
    pristine: [...PRISTINE].map(([file, entry]) => ({ file, sha256: entry.sha256 })),
    table,
    intact,
  };
  writeFileSync(join(SCRATCH_ROOT, 'mutation-table.json'), JSON.stringify(report, null, 2), 'utf8');
  say(`\ntable: ${join(SCRATCH_ROOT, 'mutation-table.json')}`);

  if (!intact) {
    say('FAILED: a source file is not at its pristine sha256.');
    return 1;
  }
  if (wrongVerdicts > 0) {
    say(`FAILED: ${wrongVerdicts} mutation(s) produced a verdict other than the expected one.`);
    return 1;
  }
  say(`\nall ${table.length} mutations produced their expected verdict; every source restored byte-for-byte.`);
  return 0;
}

let status;
try {
  status = main();
} catch (error) {
  say(`\nthe harness itself failed: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`);
  for (const file of PRISTINE.keys()) {
    try {
      writeFileSync(file, PRISTINE.get(file).bytes);
    } catch {
      /* reported by the sweep above */
    }
  }
  status = 2;
}
process.exit(status);
