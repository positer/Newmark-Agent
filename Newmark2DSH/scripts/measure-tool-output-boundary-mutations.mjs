#!/usr/bin/env node
/**
 * measure-tool-output-boundary-mutations.mjs — the falsification harness for
 * `verify-tool-output-boundary.mjs`.
 *
 * =====================================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================================
 *
 * An assertion that cannot fail is worse than no assertion, and this repository has produced
 * several of them — including three that passed against a harness whose fake tools registry had
 * no `get(name)`, which made judge-on and judge-off indistinguishable. The boundary gate asserts
 * three things that are easy to assert vacuously:
 *
 *   1. no dispatched value is REJECTED by the registry (no `INVALID_TOOL_OUTPUT`);
 *   2. every value a tool body returned is lossless JSON under DSH's own walker, with the path;
 *   3. every registered tool's DECLARED output is lossless JSON.
 *
 * This harness proves each can go red, by planting a mutation in the code under test, running
 * the gate, and restoring the file **byte-for-byte**, verified by sha256.
 *
 * Two entries expect GREEN. They are controls, not filler: a harness whose every row is red
 * cannot tell "the gate measures the property" from "the gate reacts to any edit at all". One of
 * the two green controls is a ComputerUse `… : undefined` site — planting it as `null` changes no
 * verdict, which is the measured form of the finding that those sites are already held by the
 * backend's JSON-string funnel.
 *
 * `M5` is a mutation of the GATE rather than of the product: it removes the counterfactual's
 * planted `undefined` so the registry ACCEPTS it. If the gate still passes, its two class
 * assertions were never testing the boundary at all.
 *
 * Invoke it by hand:
 *
 *     node scripts/measure-tool-output-boundary-mutations.mjs
 *
 * Exit codes:
 *   0  every mutation produced its expected verdict and every file was restored by sha256
 *   1  a mutation produced the wrong verdict, or a source file was not restored
 *   2  the harness could not run (a file or an anchor did not match exactly once)
 *
 * **Every mutated file is restored from bytes captured at start-up, in a `finally`, on every
 * path — including a failed mutation, a thrown gate and an interrupt.** Every restoration is
 * verified by sha256 and reported, and the run ends with a second sha256 sweep of every file it
 * touched.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const COMPONENTS = join(REPO, 'packages', 'newmark-core', 'components');

const GATE = join(HERE, 'verify-tool-output-boundary.mjs');
const LIVE_GATE = join(HERE, 'verify-agent-api-live.mjs');
const AGENT_API = join(COMPONENTS, 'agent-api', 'component.js');
const MEMORYLAB = join(COMPONENTS, 'memorylab', 'component.js');
const COMPUTERUSE = join(COMPONENTS, 'computeruse', 'component.js');
const COMPUTERUSE_WIN32 = join(COMPONENTS, 'computeruse', 'lib', 'win32.js');

const SCRATCH_ROOT = join(REPO, 'evidence', 'tool-output-boundary', 'mutations');

/**
 * The phases each run uses. `self` is instant and is kept; it is the check that the scanner
 * itself can name a path, and a mutation that broke the scanner must be visible.
 */
const PHASES = process.env.NM_TOB_MUTATION_PHASES?.trim() || 'self,declared,dispatch,counterfactual';

/**
 * `expectRed` entries are PREFIXES of the gate's check names, matched with `startsWith`, because
 * two of the names carry a dispatch count and a harness should not be brittle about a number
 * that the mutation itself does not move.
 */
const MUTATIONS = [
  {
    id: 'M1',
    file: AGENT_API,
    name: 'the 0.2.8 defect, restored: the run event log carries `turn: event?.turn`',
    find: 'if (events.length < 64) events.push({ type: String(event?.type ?? \'\'), turn: event?.turn ?? null });',
    replace: 'if (events.length < 64) events.push({ type: String(event?.type ?? \'\'), turn: event?.turn });',
    expect: 'RED',
    expectRed: [
      'no dispatched value was REJECTED by the registry',
      'every value a tool body returned is lossless JSON',
      'agent_api_send completed a real run through the registry',
      "the loop envelope's own event log crosses the boundary",
    ],
    why:
      'THE INCIDENT ITSELF. This is the exact line the user hit 重建索引 on: the run completed, the envelope was built, ' +
      'and `undefined` in one event field made DSH reject the whole value. If the gate does not go red on this, it cannot ' +
      'catch the defect it was written for.',
  },
  {
    id: 'M2',
    file: MEMORYLAB,
    name: 'the 0.2.2 defect, restored: memory_lab_reindex returns `error: verified.ok ? undefined : …`',
    find: '              ...(verified.ok ? {} : { error: verified.error }),',
    replace: '              error: verified.ok ? undefined : verified.error,',
    expect: 'RED',
    expectRed: [
      'no dispatched value was REJECTED by the registry',
      'every value a tool body returned is lossless JSON',
    ],
    why:
      'The other real incident, in another component and another tool. A rebuild that had already written the index would ' +
      'come back as `INVALID_TOOL_OUTPUT` — an operation that succeeded, reported as a failure.',
  },
  {
    id: 'M3',
    file: COMPUTERUSE,
    name: "a tool's DECLARED description carries an undefined — the half only this gate checks",
    find:
      "            'Read-only desktop or application capture. Never acquires or mutates the Computer Use lease, so it is safe to call while another owner holds it.',",
    replace: "            ['Read-only desktop or application capture.', undefined],",
    expect: 'RED',
    expectRed: [
      'every registered tool declares a lossless name, description, parameters and output schema',
    ],
    why:
      'Of the four declared fields, DSH pre-validates two: `output.schema` at register and `parameters` at schema projection. ' +
      '`description` is validated by NOBODY but this gate — and `agent_api_catalog { detail: "full" }` hands it to a caller. ' +
      'So this is the mutation that proves the declared-output walk is not a restatement of a check DSH already makes.',
  },
  {
    id: 'M4',
    file: MEMORYLAB,
    name: 'a different tool returns a value carrying a planted undefined',
    find: "            return store.read(String(args?.component || args?.slug || args?.name || ''));",
    replace: "            return { ...store.read(String(args?.component || args?.slug || args?.name || '')), planted: undefined };",
    expect: 'RED',
    expectRed: [
      'no dispatched value was REJECTED by the registry',
      'every value a tool body returned is lossless JSON',
    ],
    why:
      'Fourteen of the fifteen tools are not agent-api, and a check that only ever went red on the incident it was written for ' +
      'would be a memorial rather than a gate. This plants the same shape in `memory_lab_read`.',
  },
  {
    id: 'M5',
    file: GATE,
    name: 'the counterfactual stops planting an undefined, so the registry ACCEPTS it',
    find: 'return { ok: true, result: { receipt: { rebuilt: true, planted: undefined } } };',
    replace: 'return { ok: true, result: { receipt: { rebuilt: true, planted: null } } };',
    expect: 'RED',
    expectRed: [
      'a planted undefined IS rejected by this registry, with INVALID_TOOL_OUTPUT',
      'and this gate names the field that killed it, at its full path',
    ],
    why:
      'A mutation of the GATE, and the one that matters most: it makes the counterfactual clean. If the gate still passed, ' +
      'its own fail-ability check would be vacuous and so would every green line above it.',
  },
  {
    id: 'M6',
    file: LIVE_GATE,
    name: 'the acceptance gate goes back to calling the definition directly in round 2',
    find: "  const call = await dispatchTool(tools, 'agent_api_send', { prompt, max_steps: 2, timeout_ms: 180000 });",
    replace:
      "  const call = await api.tools().find((tool) => tool.name === 'agent_api_send').execute({ prompt, max_steps: 2, timeout_ms: 180000 }, {});",
    expect: 'RED',
    expectRed: ['the acceptance gate dispatches agent_api_send through the registry in both rounds'],
    why:
      'This is the hole itself, put back: reaching into the definition is exactly the call that never meets the output ' +
      'boundary, and it is why two releases shipped with this class of defect. The check that holds it shut must bite.',
  },
  {
    id: 'M7',
    file: AGENT_API,
    name: 'CONTROL — a comment inserted above the fixed line, and nothing else',
    find: 'if (events.length < 64) events.push({ type: String(event?.type ?? \'\'), turn: event?.turn ?? null });',
    replace:
      '/* control: this comment changes no behaviour and must change no verdict */\n            if (events.length < 64) events.push({ type: String(event?.type ?? \'\'), turn: event?.turn ?? null });',
    expect: 'GREEN',
    expectRed: [],
    why:
      'A harness whose every row is red cannot tell "the gate measures the property" from "the gate reacts to any edit at ' +
      'all". This edit is behaviour-free and must stay green.',
  },
  {
    id: 'M8',
    file: COMPUTERUSE_WIN32,
    name: 'CONTROL — a ComputerUse `… : undefined` field in the mode_report answer, as `null`',
    find: '    overlay_last_error: lease.lastOverlayError || undefined,',
    replace: '    overlay_last_error: lease.lastOverlayError || null,',
    expect: 'GREEN',
    expectRed: [],
    why:
      'One of the dozen `… : undefined` result fields in the Win32 backend, and this one is genuinely EXECUTED by the ' +
      'gate: `mode_report` always answers `overlay_last_error`, and with no overlay running the left side is empty. It ' +
      'must change no verdict, because the backend serialises the whole answer to a JSON string and the tool parses it — ' +
      'which is the reason those sites are harmless. Measured here rather than argued.',
  },
  {
    id: 'M9',
    file: COMPUTERUSE,
    name: 'the ComputerUse funnel is broken: asToolResult returns the raw JSON string',
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
    expectRed: ['no dispatched value was REJECTED by the registry'],
    why:
      'A string is perfectly good JSON, so this defect is NOT caught by walking for undefined — it is caught because the ' +
      "tool DECLARES `output.schema: { type: 'object' }` and the registry validates the value against it. It is the " +
      'measured proof that the declared-output half of the class check earns its place.',
  },
  {
    id: 'M10',
    file: AGENT_API,
    name: "a tool's DECLARED parameters carry an undefined — the field DSH also refuses, at schema projection",
    find: "          parameters: { type: 'object', properties: {}, required: [] },\n          output: { schema: { type: 'object' }, render: (args, value) => toolText(value) },\n          async execute() {\n            counters.reads += 1;",
    replace:
      "          parameters: { type: 'object', properties: {}, required: [], $comment: undefined },\n          output: { schema: { type: 'object' }, render: (args, value) => toolText(value) },\n          async execute() {\n            counters.reads += 1;",
    expect: 'RED',
    expectRed: [
      'every registered tool declares a lossless name, description, parameters and output schema',
      "DSH projected every registered tool's schema for a caller",
    ],
    why:
      'THE MUTATION THAT CHANGED THE GATE. DSH validates declared `parameters` too, inside `schemas()` ' +
      '(`dsh-tools/lib/index.js:3042`), so the FIRST version of this gate died here: exit 2, no receipt, and the defect ' +
      'reported as "the gate itself failed" instead of as a failed check with a path. The gate now reads the tool set from ' +
      'the registry map, walks what the tools declare BEFORE anything asks DSH to project, and reports the projection as ' +
      'its own named check. Both checks must be red here.',
  },
];

/* ------------------------------------------------------------- pristine capture --- */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const PRISTINE = new Map();
for (const file of new Set(MUTATIONS.map((mutation) => mutation.file))) {
  if (!existsSync(file)) {
    process.stdout.write(`the harness cannot run: ${file} does not exist\n`);
    process.exit(2);
  }
  const bytes = readFileSync(file);
  PRISTINE.set(file, { bytes, sha256: sha256(bytes) });
}

/** Restore one file from the bytes captured at start-up, and answer what happened. */
function restore(file) {
  const entry = PRISTINE.get(file);
  writeFileSync(file, entry.bytes);
  const current = readFileSync(file);
  return { expected: entry.sha256, actual: sha256(current), restored: sha256(current) === entry.sha256 };
}

function say(line = '') {
  process.stdout.write(String(line) + '\n');
}

/* ------------------------------------------------------------------- main --- */

function main() {
  say('Newmark Core — tool-output boundary MUTATION harness');
  say('===================================================');
  say(`gate:     ${GATE}`);
  say(`phases:   ${PHASES}`);
  say(`scratch:  ${SCRATCH_ROOT}`);
  say('\npristine sources:');
  for (const [file, entry] of PRISTINE) say(`  ${entry.sha256}  ${file}`);
  mkdirSync(SCRATCH_ROOT, { recursive: true });

  const table = [];
  let wrong = 0;

  for (const mutation of MUTATIONS) {
    say(`\n=== ${mutation.id} — ${mutation.name} ===`);
    const pristine = PRISTINE.get(mutation.file);
    const onDisk = sha256(readFileSync(mutation.file));
    if (onDisk !== pristine.sha256) {
      say(`  ! ${mutation.file} is not at its pristine sha256 (${onDisk}); refusing to plant on it.`);
      return 2;
    }
    const source = pristine.bytes.toString('utf8');
    const hits = source.split(mutation.find).length - 1;
    if (hits !== 1) {
      say(`  ! the anchor occurs ${hits} time(s) in ${mutation.file}; refusing to guess.`);
      say(`    anchor: ${JSON.stringify(mutation.find.slice(0, 120))}`);
      return 2;
    }

    const scratch = join(SCRATCH_ROOT, `${mutation.id}-${randomUUID().slice(0, 8)}`);
    mkdirSync(scratch, { recursive: true });
    let verdict = 'NO-RECEIPT';
    let failedNames = [];
    let passed = 0;
    let gateStatus = null;
    let restored = null;

    try {
      writeFileSync(mutation.file, source.replace(mutation.find, mutation.replace));
      const mutatedSha = sha256(readFileSync(mutation.file));
      say(`  planted:  ${pristine.sha256} -> ${mutatedSha}`);
      const result = spawnSync(process.execPath, [GATE], {
        cwd: REPO,
        /* Inherited, not piped: the gate's own transcript is wanted in this terminal, and a
         * pipe is a capture this harness does not need. */
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, NM_TOB_PHASES: PHASES, NM_TOB_SCRATCH: scratch },
      });
      gateStatus = result.status;
      const receiptPath = join(scratch, 'receipt.json');
      if (existsSync(receiptPath)) {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        passed = receipt.passed;
        failedNames = receipt.failed;
        verdict = receipt.failed.length > 0 ? 'RED' : 'GREEN';
      } else {
        failedNames = [`the gate wrote no receipt at ${receiptPath}`];
      }
    } finally {
      restored = restore(mutation.file);
    }

    const namedOk = mutation.expectRed.every((prefix) => failedNames.some((name) => name.startsWith(prefix)));
    const missing = mutation.expectRed.filter((prefix) => !failedNames.some((name) => name.startsWith(prefix)));
    const ok = verdict === mutation.expect && restored.restored && (mutation.expect !== 'RED' || namedOk);
    if (!ok) wrong += 1;
    say(`  verdict:  ${verdict} (expected ${mutation.expect})  ${ok ? 'OK' : 'WRONG'}`);
    say(`  gate:     exit=${gateStatus}  ${passed} passed, ${failedNames.length} failed`);
    for (const name of failedNames) say(`            red: ${name}`);
    if (missing.length > 0) for (const prefix of missing) say(`            MISSING expected red: ${prefix}`);
    say(`  restore:  ${restored.actual}  ${restored.restored ? 'byte-for-byte OK' : `MISMATCH, expected ${restored.expected}`}`);
    say(`  why:      ${mutation.why}`);
    table.push({
      id: mutation.id,
      name: mutation.name,
      file: mutation.file,
      find: mutation.find,
      replace: mutation.replace,
      expect: mutation.expect,
      expectRed: mutation.expectRed,
      verdict,
      gateExit: gateStatus,
      passed,
      failed: failedNames,
      missingExpectedRed: missing,
      restored,
      ok,
    });
  }

  say('\n=== MUTATION TABLE ===');
  say('  id  expected  verdict  gate  passed  failed  restore       expected-red-named');
  for (const row of table) {
    say(
      `  ${row.id.padEnd(3)} ${row.expect.padEnd(9)} ${row.verdict.padEnd(8)} ${String(row.gateExit).padEnd(5)} ` +
        `${String(row.passed).padEnd(7)} ${String(row.failed.length).padEnd(7)} ` +
        `${(row.restored.restored ? 'byte-for-byte' : 'FAILED').padEnd(13)} ${
          row.expect === 'GREEN' ? '(control)' : row.missingExpectedRed.length === 0 ? 'yes' : 'NO'
        }`,
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
    harness: 'measure-tool-output-boundary-mutations',
    finishedAt: new Date().toISOString(),
    gate: GATE,
    phases: PHASES,
    pristine: [...PRISTINE].map(([file, entry]) => ({ file, sha256: entry.sha256 })),
    table,
    intact,
  };
  const reportPath = join(SCRATCH_ROOT, 'mutation-table.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  say(`\ntable: ${reportPath}`);

  if (!intact) {
    say('FAILED: a source file is not at its pristine sha256.');
    return 1;
  }
  if (wrong > 0) {
    say(`FAILED: ${wrong} mutation(s) did not produce their expected verdict.`);
    return 1;
  }
  const red = table.filter((row) => row.expect === 'RED').length;
  say(`\nall ${table.length} mutations produced their expected verdict (${red} red, ${table.length - red} green controls);`);
  say('every source restored byte-for-byte.');
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
