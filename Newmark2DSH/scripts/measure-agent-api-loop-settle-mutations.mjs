#!/usr/bin/env node
/**
 * measure-agent-api-loop-settle-mutations.mjs — the falsification harness for the checks
 * `verify-agent-api.mjs` gained for the "a failed tool call loops until the budget is gone" defect.
 *
 * =====================================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================================
 *
 * This repository has shipped assertions that could not fail — three of them in the
 * tool-output-boundary gate alone, and `docs/02-tool-output-boundary.md` catalogues the rest. The
 * checks added for this defect are exactly the kind that can go vacuous: "the failure text is
 * legible", "the echo keeps its shape", "the run stops instead of looping". So each one is proved
 * here by putting the defect back, running the gate, and reading WHICH named check went red.
 *
 * The defect, measured on the running 0.2.11 bundle before anything was changed:
 *
 *   - a run whose model called `memory_lab_read` for a component that does not exist called that
 *     tool on every turn of its budget and ended at `max_steps`;
 *   - the failure reached the model as a `tool` message with `isError: true` whose whole text was
 *     `[object Object]` (the MemoryLab tools report `{ ok: false, error: { … } }`, and the
 *     classifier stringified the object);
 *   - `agent_api_tool { tool: "memory_lab_read", … }` answered `error: "[object Object]"` from
 *     the LIVE application.
 *
 * Every mutated file is restored from bytes captured at start-up, in a `finally`, on every path,
 * and the restoration is verified by sha256. A final sweep re-hashes every file it touched.
 *
 * Invoke it by hand:
 *
 *     node scripts/measure-agent-api-loop-settle-mutations.mjs
 *
 * Exit codes:
 *   0  every mutation produced its expected verdict and every file was restored by sha256
 *   1  a mutation produced the wrong verdict, or a source file was not restored
 *   2  the harness could not run (a file or an anchor did not match exactly once)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const COMPONENTS = join(REPO, 'packages', 'newmark-core', 'components', 'agent-api');
const GATE = join(HERE, 'verify-agent-api.mjs');
const CONTRACT = join(COMPONENTS, 'lib', 'contract.js');
const SEAM = join(COMPONENTS, 'lib', 'llm-seam.js');
const LOOP = join(COMPONENTS, 'lib', 'loop.js');
const COMPONENT = join(COMPONENTS, 'component.js');

const EVIDENCE = join(REPO, 'evidence', 'agent-api-loop-settle', new Date().toISOString().replace(/[:.]/g, '-'));

/**
 * `expectRed` entries are PREFIXES of the gate's own check names, matched with `startsWith`.
 * A row is only OK if the gate went red AND at least one check with that prefix is among the
 * failures — a red gate for an unrelated reason is not evidence about this defect.
 */
const MUTATIONS = [
  {
    id: 'M1',
    file: CONTRACT,
    name: 'THE INCIDENT, put back: a structured failure is stringified again',
    find: "        error: describeFailure(value.error) || `${name} reported an unsuccessful result.`,",
    replace: "        error: String(value.error || `${name} reported an unsuccessful result.`),",
    expect: 'RED',
    expectRed: [
      'a tool that reports its failure as an OBJECT is classified into the message it carries',
      'the failure the model is handed is the tool message, and it does not read as `[object Object]`',
      'the repeated call is refused WITH its last failure',
    ],
    why:
      'This is the exact expression that produced `[object Object]` — the text the live application answered, and the text ' +
      'the model was handed as its whole tool result. If the gate does not go red on it, the gate cannot catch the defect ' +
      'it was written for.',
  },
  {
    id: 'M2',
    file: SEAM,
    name: "the argument echo, put back: the seam normalises the block it also sends to the provider",
    find: "          if (Number.isInteger(chunk.index)) blocks[chunk.index] = chunk.block;",
    replace:
      "          if (Number.isInteger(chunk.index))\n            blocks[chunk.index] =\n              chunk.block?.type === 'tool-call' ? { ...chunk.block, arguments: toolCallArguments(chunk.block.arguments) } : chunk.block;",
    expect: 'RED',
    expectRed: ["a model's own earlier tool call is echoed back with its arguments as the JSON TEXT the wire declares"],
    why:
      "`ToolCallBlock.arguments` is a STRING in DSH's published types and the DeepSeek adapter reads it with `JSON.parse`. " +
      'Normalising the block in place sent the provider an object, which that parse turns into `{}` — so the model was shown ' +
      'every one of its own earlier calls as having had no arguments.',
  },
  {
    id: 'M3',
    file: LOOP,
    name: 'the retry bound removed: an identical failing call is repeated for ever',
    find: 'export const DEFAULT_REPEAT_LIMIT = 2;',
    replace: 'export const DEFAULT_REPEAT_LIMIT = 99;',
    expect: 'RED',
    expectRed: [
      'a run that repeats one identical failing call is STOPPED, and says so as repeated_tool_failure rather than max_steps',
      'the bound is exact: two executions, four model turns, eight turns of budget untouched',
    ],
    why:
      'The measured defect itself: with nothing bounding the repeat, the fixture model calls the same failing tool until the ' +
      'step cap — which is what the live model did for six turns.',
  },
  {
    id: 'M4',
    file: COMPONENT,
    name: 'the tool boundary loses its argument parse, so raw text reaches the registry',
    find: '          prepareArguments(raw) {',
    replace: '          prepareArgumentsUnused(raw) {',
    expect: 'RED',
    expectRed: ['tool-call arguments that are not valid JSON become a legible tool result, and the run answers'],
    why:
      'Without the boundary parse, a malformed argument string is handed to the registry as a string and the call either runs ' +
      'with garbage or dies — the two outcomes the malformed path exists to replace with a legible tool result.',
  },
  {
    id: 'M5',
    file: SEAM,
    name: 'the recovery removed: a stream that fails after delivering a turn discards it again',
    find: '    if (calls.length === 0) throw streamError;',
    replace: '    throw streamError;',
    expect: 'RED',
    expectRed: [
      'a stream that fails AFTER delivering a tool call keeps the turn, so MALFORMED_RESPONSE is a tool result rather than a dead run',
      'a run whose turn survived a provider failure says how many turns were recovered',
    ],
    why:
      "Round 3 of the user's measurement: the DeepSeek Messages adapter validates the tool-call JSON at `message_stop`, after " +
      'every `block-end` has been delivered, and throws MALFORMED_RESPONSE. Discarding the turn turns a completed completion ' +
      'into `run_failed` with a transport error.',
  },
  {
    id: 'M6',
    file: COMPONENT,
    name: 'the event payload removed: the receipt goes back to `{ type, turn }` and cannot say why',
    find: '      const view_ = eventView(event, eventStats);',
    replace:
      "      const view_ = { type: String(event?.type ?? ''), turn: Number.isFinite(event?.turn) ? event.turn : null };",
    expect: 'RED',
    expectRed: [
      'the receipt carries the tool result AND the error on the tool events, with the turn they happened in',
      'a successful tool result is on its event too, so the log is not only a failure channel',
    ],
    why:
      'The diagnosability half of the defect, restored exactly as it was: the two events that say a tool was called and what ' +
      'came back carried nothing, so a receipt could show that a run looped and not why.',
  },
  {
    id: 'M7',
    file: COMPONENT,
    name: 'the event bound removed: a large tool result is carried whole',
    find: "  if (typeof value === 'string') return excerpt(value, limit);",
    replace: "  if (typeof value === 'string') return value;",
    expect: 'RED',
    expectRed: ['a large tool result is BOUNDED on the event, with the truncation stated rather than silent'],
    why:
      'A payload that blows the envelope is worse than no payload: the event log travels inside the value DSH validates and ' +
      'the caller reads. Without the bound, a 5 KB tool result is carried whole.',
  },
  {
    id: 'M8',
    file: COMPONENT,
    name: 'the run reports the component LIFETIME tool-call counter as its own',
    find: '      turns: assistantTurns.length,\n      tool_calls: counters.toolCalls - toolCallsBefore,',
    replace: '      turns: assistantTurns.length,\n      tool_calls: counters.toolCalls,',
    expect: 'RED',
    expectRed: ['the run reports ITS OWN tool calls, not the component lifetime counter that every run adds to'],
    why:
      'Measured live at 0.2.11: a two-turn run with a single tool call answered `tool_calls: 14`, because the field reported ' +
      'the per-instance counter. A receipt that misstates how many calls a run made cannot be used to judge one.',
  },
  {
    id: 'M9',
    file: COMPONENT,
    name: "a new event field carries `undefined` — the 0.2.8 boundary defect, in the new payload",
    find: "  const base = { type, turn };",
    replace: "  const base = { type, turn: event?.turn };",
    expect: 'RED',
    expectRed: ['every event field is JSON-lossless: no `undefined` in a value position'],
    why:
      "`{ turn: event?.turn }` is the 0.2.8 defect verbatim, and a new event field is exactly where a new `undefined` appears. " +
      'This gate checks the event log itself; the tool-output-boundary gate checks the same value across the real registry.',
  },
  {
    id: 'M10',
    file: LOOP,
    name: 'the CONTROL case broken on purpose: any failed call ends the loop immediately',
    find: '      hasMoreToolCalls = terminatedByTool ? false : results.length > 0;',
    replace: '      hasMoreToolCalls = terminatedByTool || results.some((result) => result?.isError === true) ? false : results.length > 0;',
    expect: 'RED',
    expectRed: ['CONTROL — a failing call that the model then answers about still settles in two turns, exit 0'],
    why:
      'A fix that stopped every run at the first tool failure would "solve" the looping defect and break the component. This ' +
      'proves the control that forbids it can fail, which is the difference between a control and a sentence in a comment.',
  },
  {
    id: 'M11',
    file: LOOP,
    name: 'CONTROL — a behaviour-free comment above the retry bound, and nothing else',
    find: 'export const DEFAULT_REPEAT_LIMIT = 2;',
    replace: '/* control: this comment changes no behaviour and must change no verdict */\nexport const DEFAULT_REPEAT_LIMIT = 2;',
    expect: 'GREEN',
    expectRed: [],
    why:
      'A harness whose every row is red cannot tell "the gate measures the property" from "the gate reacts to any edit at all".',
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

function restore(file) {
  const entry = PRISTINE.get(file);
  writeFileSync(file, entry.bytes);
  const actual = sha256(readFileSync(file));
  return { expected: entry.sha256, actual, restored: actual === entry.sha256 };
}

const say = (line = '') => process.stdout.write(`${line}\n`);

/** The names the gate reported as failed, read from its own transcript. */
function failedNamesFrom(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('not ok'))
    .map((line) => line.replace(/^not ok \d+ - /, '').trim());
}

function summaryFrom(stdout) {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('SUMMARY '));
  return line ?? '';
}

/* ------------------------------------------------------------------- main --- */

function main() {
  say('Newmark Core — agent-api loop-settle MUTATION harness');
  say('=====================================================');
  say(`gate:     ${GATE}`);
  say(`evidence: ${EVIDENCE}`);
  say('\npristine sources:');
  for (const [file, entry] of PRISTINE) say(`  ${entry.sha256}  ${file}`);
  mkdirSync(EVIDENCE, { recursive: true });

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

    let verdict = 'NO-RECEIPT';
    let failedNames = [];
    let summary = '';
    let gateStatus = null;
    let restored = null;
    let mutatedSha = '';

    try {
      writeFileSync(mutation.file, source.replace(mutation.find, mutation.replace));
      mutatedSha = sha256(readFileSync(mutation.file));
      say(`  planted:  ${pristine.sha256} -> ${mutatedSha}`);
      const result = spawnSync(process.execPath, [GATE], { cwd: REPO, encoding: 'utf8' });
      gateStatus = result.status;
      const stdout = String(result.stdout ?? '');
      failedNames = failedNamesFrom(stdout);
      summary = summaryFrom(stdout);
      verdict = failedNames.length > 0 ? 'RED' : 'GREEN';
      for (const line of stdout.split(/\r?\n/)) if (line.startsWith('not ok') || line.startsWith('SUMMARY')) say(`    ${line}`);
      if (result.status !== 0 && failedNames.length === 0) {
        say(`    ! the gate exited ${result.status} without naming a failed check:`);
        say(String(result.stderr ?? '').split(/\r?\n/).slice(0, 12).map((line) => `      ${line}`).join('\n'));
        failedNames = ['(the gate died without a named check)'];
        verdict = 'DIED';
      }
    } finally {
      restored = restore(mutation.file);
    }

    const missing = mutation.expectRed.filter((prefix) => !failedNames.some((name) => name.startsWith(prefix)));
    const namedOk = mutation.expectRed.every((prefix) => failedNames.some((name) => name.startsWith(prefix)));
    const ok = verdict === mutation.expect && restored.restored && (mutation.expect !== 'RED' || namedOk);
    if (!ok) wrong += 1;
    say(`  verdict:  ${verdict} (expected ${mutation.expect})  ${ok ? 'OK' : 'WRONG'}`);
    say(`  gate:     exit=${gateStatus}  ${summary}`);
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
      summary,
      failed: failedNames,
      missingExpectedRed: missing,
      restored,
      ok,
    });
  }

  say('\n=== MUTATION TABLE ===');
  say('  id  expected  verdict  gate  failed  restore       expected-red-named');
  for (const row of table) {
    say(
      `  ${row.id.padEnd(3)} ${row.expect.padEnd(9)} ${row.verdict.padEnd(8)} ${String(row.gateExit).padEnd(5)} ` +
        `${String(row.failed.length).padEnd(7)} ${(row.restored.restored ? 'byte-for-byte' : 'FAILED').padEnd(13)} ${
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
    harness: 'measure-agent-api-loop-settle-mutations',
    finishedAt: new Date().toISOString(),
    gate: GATE,
    pristine: [...PRISTINE].map(([file, entry]) => ({ file, sha256: entry.sha256 })),
    table,
    intact,
  };
  const reportPath = join(EVIDENCE, 'mutations.json');
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
