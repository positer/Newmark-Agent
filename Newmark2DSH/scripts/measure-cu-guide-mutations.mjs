#!/usr/bin/env node
/**
 * The falsification harness for the ComputerUse operating guide.
 *
 * The guide is written in two places: the `computer_use` tool description
 * (`packages/newmark-core/components/computeruse/component.js`) and
 * `docs/03-computer-use-playbook.md`. `verify-computeruse-win32.mjs` checks 23-25 assert
 * both against behaviour measured in the same run. This harness plants one defect at a
 * time in the code, the description or the document, runs the gate, and requires the
 * NAMED check to go red - then restores the file from the bytes captured at start-up and
 * verifies the restoration by sha256.
 *
 * Two entries are CONTROLS whose verdict must stay GREEN: a reworded bullet that changes
 * no fact, and a comment-only edit. A harness that went red there would be measuring the
 * edit rather than the property.
 *
 * Invoke by hand:
 *     node Newmark2DSH/scripts/measure-cu-guide-mutations.mjs
 *
 * Exit codes: 0 every mutation produced its expected verdict and every file was restored;
 *             1 a mutation produced the wrong verdict or a file was not restored;
 *             2 the harness could not run (a file or an anchor did not match exactly once).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CU = join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const COMPONENT = join(CU, 'component.js');
const WIN32 = join(CU, 'lib', 'win32.js');
const GATE = join(HERE, 'verify-computeruse-win32.mjs');
const DOC = join(REPO, 'docs', '03-computer-use-playbook.md');
const EVIDENCE = join(REPO, 'evidence', 'computeruse-guide');

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const originals = new Map();
for (const file of [COMPONENT, WIN32, GATE, DOC]) originals.set(file, fs.readFileSync(file));

/**
 * Mutations, each against a unique anchor. `expect` is the check index that must FAIL; a
 * mutation whose `expectVerdict` is `GREEN` must leave the gate green. `expectRed` names
 * the checks the mutation is expected to be caught by, and the run reports the ones that
 * really went red, so a co-red check is recorded rather than hidden.
 */
const MUTATIONS = [
  {
    id: 'G1',
    file: COMPONENT,
    name: 'the description stops naming ctrl+esc as the way to open an application',
    find: '`key: "ctrl+esc"` opens the Start menu',
    replace: '`key: "win"` opens the Start menu',
    expect: 23,
    expectRed: [23],
    why: 'The recipe the whole section exists for. A caller told to press the Windows key is being told to press the key this machine ignores, and check 23 is where that claim is held.',
    expectVerdict: 'RED',
  },
  {
    id: 'G2',
    file: WIN32,
    name: 'the receipt field the description names is renamed in the code that writes it',
    find: 'windows_key_effect=${held ?',
    replace: 'windows_key_result=${held ?',
    expect: 23,
    expectRed: [22, 23, 24],
    why: 'The guide tells a caller to read `windows_key_effect`. If the receipt writes another name, the guide sends its reader looking for a field that does not exist. Check 22 also asserts the old name, and check 24 asserts that every field the guide names is really carried by a receipt, so all three go red - recorded rather than hidden.',
    expectVerdict: 'RED',
  },
  {
    id: 'G3',
    file: COMPONENT,
    name: 'the description claims app_activate starts an application',
    find: '`app_activate` NEVER launches a process',
    replace: '`app_activate` starts the application you name',
    expect: 24,
    expectRed: [24],
    why: 'The counter-intuitive fact, inverted. A model that reads "starts" will try to launch an application with app_activate and meet a refusal it cannot explain.',
    expectVerdict: 'RED',
  },
  {
    id: 'G4',
    file: WIN32,
    name: 'an app_target that matches nothing stops being app_target_not_found',
    find: "      error_code: 'app_target_not_found',\n      error: `No open window matched app_target ${target}.`,",
    replace: "      error_code: 'app_target_missing',\n      error: `No open window matched app_target ${target}.`,",
    expect: 24,
    expectRed: [24],
    why: 'The code the guide quotes, changed under it. The live half of check 24 refuses with the renamed code and nothing is activated, so the mutation is safe on a live desktop while still being caught.',
    expectVerdict: 'RED',
  },
  {
    id: 'G5',
    file: WIN32,
    name: 'a process-launch primitive appears in the module that never launches',
    find: 'async function appActivateAction(action, options, mode, header) {',
    replace: "async function appActivateAction(action, options, mode, header) {\n  /* MUTANT: the shape the guide denies. Never reached: nothing passes launchIfMissing. */\n  if (options.launchIfMissing === true) await runInLane('action', 'Start-Process -FilePath notepad.exe', 5000);",
    expect: 24,
    expectRed: [24],
    why: 'Check 24 asserts that the module implementing app_activate carries no process-creation call at all. This plants one behind a switch the gate never sets, so the assertion is proved to be measuring the source rather than the behaviour of one dispatch.',
    expectVerdict: 'RED',
  },
  {
    id: 'G6',
    file: WIN32,
    name: 'the lease refusal stops carrying the code the guide names',
    find: "return failure(action, 'takeover_lease_owned_by_another_owner',",
    replace: "return failure(action, 'takeover_lease_held_by_another_owner',",
    expect: 25,
    expectRed: [25],
    why: 'The habit the guide states most precisely - release with the exact owner_id, and expect this refusal otherwise. Check 7 drives a real lease but tests the OTHER refusal (`takeover_lease_occupied`, from a second takeover_start), so this code is check 25\'s alone.',
    expectVerdict: 'RED',
  },
  {
    id: 'G7',
    file: COMPONENT,
    name: 'the description stops saying observe captures a window',
    find: '`observe` captures ONE WINDOW',
    replace: '`observe` captures THE DESKTOP',
    expect: 25,
    expectRed: [25],
    why: 'The confusion that cost a whole capture: a caller who believes observe is the screen never reaches for screen_capture, and cannot tell a window capture from a screen capture. Check 25 measures the live capture against the claim.',
    expectVerdict: 'RED',
  },
  {
    id: 'G8',
    file: WIN32,
    name: 'the virtual-mode Windows-key refusal stops returning its named code',
    find: "      code: 'windows_key_requires_real_delivery',",
    replace: "      code: 'windows_key_needs_real_delivery',",
    expect: 25,
    expectRed: [22, 25],
    why: 'The guide names this code as the reason a Windows chord is refused in virtual mode. Check 22 asserts the same code, so both go red.',
    expectVerdict: 'RED',
  },
  {
    id: 'G9',
    file: COMPONENT,
    name: 'CONTROL - a bullet is reworded without changing any fact',
    find: '- Prefer `window_handle` over `app_target`: `app_target` has failed to match a window that exists and that `app_list` had just listed with that title. `window_handle` is exact.',
    replace: '- Prefer `window_handle` over `app_target`: `app_target` has failed to match a window that exists and that `app_list` had just listed with that title, so reach for `window_handle`, which is exact.',
    expect: 25,
    expectRed: [],
    why: 'A control. The fact is unchanged and the asserted phrase survives, so the gate must stay green; a check that went red here would be asserting prose rather than the property.',
    expectVerdict: 'GREEN',
  },
  {
    id: 'G10',
    file: WIN32,
    name: 'CONTROL - a comment-only edit beside the receipt',
    find: '   * For a LONE Windows key the effect is measurable in the crudest possible way: if nothing',
    replace: '   * For a lone Windows key the effect is measurable in the crudest possible way: if nothing',
    expect: 22,
    expectRed: [],
    why: 'A second control: a comment cannot change behaviour or a receipt, so the gate must stay green.',
    expectVerdict: 'GREEN',
  },
  {
    id: 'G11',
    file: DOC,
    name: 'the record the description points at is gone',
    remove: true,
    expect: 25,
    expectRed: [25],
    why: 'A description that points at a document nobody kept is worse than a description that names no document: it promises evidence and delivers a 404. Check 25 asserts the file exists before it reads it.',
    expectVerdict: 'RED',
  },
  {
    id: 'G12',
    file: DOC,
    name: 'the record stops carrying the rule it is the record for',
    find: 'ctrl+esc',
    replace: 'the Start chord',
    replaceAll: true,
    expect: 25,
    expectRed: [25],
    why: 'Check 25 asserts the document carries each rule the description points at, not merely that a file exists. Removing the anchor from every occurrence proves those assertions can fail.',
    expectVerdict: 'RED',
  },
];

function runGate() {
  const result = spawnSync(process.execPath, [GATE], { cwd: dirname(REPO), encoding: 'utf8', timeout: 900000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const failed = new Set();
  const names = [];
  for (const raw of output.split(/\r?\n/)) {
    const text = raw.trim();
    const short = /^FAIL\s+(\d+)\.\s+([^--]*?)(?:\s+--\s+(.*))?$/.exec(text);
    if (short) {
      failed.add(Number(short[1]));
      names.push(`${short[1]}. ${short[2].trim()}${short[3] ? ` -- ${short[3].trim()}` : ''}`);
    }
  }
  const summary = (output.split(/\r?\n/).filter(line => /^SUMMARY|^FAIL |^PASS$/.test(line.trim())).slice(-3).join(' | ')) || 'no summary';
  const counts = /assertions=(\d+) passed=(\d+) failed=(\d+)/.exec(output);
  return {
    failed,
    names,
    summary,
    status: result.status,
    output,
    passed: counts ? Number(counts[2]) : null,
    failedCount: counts ? Number(counts[3]) : null,
  };
}

const results = [];
const log = [];
let exitCode = 0;
const record = (text) => { log.push(text); console.log(text); };

try {
  for (const mutation of MUTATIONS) {
    const original = originals.get(mutation.file).toString('utf8');
    if (mutation.remove !== true && mutation.replaceAll !== true) {
      const count = original.split(mutation.find).length - 1;
      if (count !== 1) {
        record(`REFUSE ${mutation.id}: the anchor occurs ${count} times in ${mutation.file}`);
        exitCode = 2;
        break;
      }
    }
    if (mutation.remove === true) fs.rmSync(mutation.file, { force: true });
    else if (mutation.replaceAll === true) fs.writeFileSync(mutation.file, original.split(mutation.find).join(mutation.replace));
    else fs.writeFileSync(mutation.file, original.split(mutation.find).join(mutation.replace));

    let outcome;
    try {
      outcome = runGate();
    } finally {
      fs.writeFileSync(mutation.file, originals.get(mutation.file));
    }
    const restoredSha = sha(fs.readFileSync(mutation.file));
    const expectedSha = sha(originals.get(mutation.file));
    const restoredOk = restoredSha === expectedSha;

    const verdict = mutation.expectVerdict === 'GREEN'
      ? (outcome.failed.size === 0 ? 'GREEN' : 'RED')
      : (outcome.failed.has(mutation.expect) ? 'RED' : 'GREEN');
    const missing = mutation.expectRed.filter(index => !outcome.failed.has(index));
    const ok = verdict === mutation.expectVerdict && restoredOk;
    if (!ok) exitCode = 1;

    record(`${ok ? 'OK  ' : 'BAD '} ${mutation.id} expect=${mutation.expectVerdict} observed=${verdict} restored=${restoredOk}`);
    record(`     ${mutation.name}`);
    record(`     failed checks: ${JSON.stringify([...outcome.failed].sort((a, b) => a - b))}`);
    record(`     ${outcome.summary}`);
    record(`     why: ${mutation.why}`);

    results.push({
      id: mutation.id,
      name: mutation.name,
      file: mutation.file,
      find: mutation.find ?? null,
      replace: mutation.replace ?? null,
      remove: mutation.remove === true,
      expectVerdict: mutation.expectVerdict,
      expectRed: mutation.expectRed,
      verdict,
      missingExpectedRed: missing,
      gateExit: outcome.status,
      passed: outcome.passed,
      failedCount: outcome.failedCount,
      failedChecks: [...outcome.failed].sort((a, b) => a - b),
      failedNames: outcome.names,
      summary: outcome.summary,
      restored: { expected: expectedSha, actual: restoredSha, restored: restoredOk },
      ok,
      why: mutation.why,
    });
  }
} finally {
  for (const [file, buffer] of originals) {
    const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (current === null || sha(current) !== sha(buffer)) fs.writeFileSync(file, buffer);
  }
}

record('\n=== RESTORATION SWEEP ===');
for (const [file, buffer] of originals) {
  const current = sha(fs.readFileSync(file));
  const expected = sha(buffer);
  const ok = current === expected;
  if (!ok) exitCode = 1;
  record(`  ${ok ? 'MATCH  ' : 'MISMATCH'} ${file}`);
  record(`           ${current}`);
}
record(`\n${exitCode === 0 ? 'PASS' : 'FAIL'} ${results.filter(item => item.ok).length}/${results.length} mutations produced their expected verdict`);

fs.mkdirSync(join(EVIDENCE, 'mutations'), { recursive: true });
fs.writeFileSync(join(EVIDENCE, 'mutations', 'mutation-table.json'), JSON.stringify({
  harness: 'measure-cu-guide-mutations',
  finishedAt: new Date().toISOString(),
  gate: GATE,
  checksUnderTest: [23, 24, 25],
  pristine: [...originals.entries()].map(([file, buffer]) => ({ file, sha256: sha(buffer) })),
  table: results,
}, null, 2));
fs.writeFileSync(join(EVIDENCE, 'mutation-harness.log'), `${log.join('\n')}\n`);
process.exit(exitCode);
