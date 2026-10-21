#!/usr/bin/env node
/**
 * The falsification harness for the three assertions this change adds to
 * `verify-computeruse-win32.mjs` (20, 21, 22).
 *
 * A green assertion that cannot go red is worse than no assertion. Each mutation below plants
 * one defect in the code under test - the exact defect the assertion exists to catch - runs the
 * gate, and checks that the NAMED check fails. Then the file is restored from the bytes
 * captured at start-up and the restoration is verified by sha256.
 *
 * The last entry is a CONTROL whose verdict is GREEN: `previewKeyScript` is a passthrough to
 * the shipped composer, so removing it changes nothing the gate can observe. A harness that
 * went red there would be measuring the edit rather than the property.
 *
 * Invoke by hand:
 *     node Newmark2DSH/scripts/measure-cu-win32-capture-mutations.mjs
 *
 * Exit codes: 0 every mutation produced its expected verdict and every file was restored;
 *             1 a mutation produced the wrong verdict or a file was not restored;
 *             2 the harness could not run (a file or an anchor did not match exactly once).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CU = join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const WIN32 = join(CU, 'lib', 'win32.js');
const COMPONENT = join(CU, 'component.js');
const GATE = join(HERE, 'verify-computeruse-win32.mjs');

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const originals = new Map();
for (const file of [WIN32, COMPONENT, GATE]) originals.set(file, readFileSync(file));

/**
 * Mutations, each against a unique anchor. `expect` is the check that must FAIL; a mutation
 * whose expectation is `GREEN` must leave the gate green.
 */
const MUTATIONS = [
  {
    id: 'M1',
    file: WIN32,
    name: 'the screen capture geometry comes from the PRIMARY monitor, not the virtual screen',
    find: "    '$screenLeft = $virtual[0]; $screenTop = $virtual[1]; $screenWidth = $virtual[2]; $screenHeight = $virtual[3]',",
    replace: "    '$screenLeft = 0; $screenTop = 0; $screenWidth = [NewmarkCuNative]::GetSystemMetrics(0); $screenHeight = [NewmarkCuNative]::GetSystemMetrics(1)',",
    expect: 21,
    why: 'A virtual screen with a negative origin is a multi-monitor layout, and this mutant drops the origin entirely, so the copy starts at the wrong place. On this single-monitor machine the size happens to be the same, which is exactly why the assertion must also require the geometry to be READ from the virtual screen: this mutant removes that read, and the assertion catches it there.',
    expectVerdict: 'RED',
  },
  {
    id: 'M1c',
    file: WIN32,
    name: 'CONTROL — the geometry read stays and a harmless local is added',
    find: "    '$screenLeft = $virtual[0]; $screenTop = $virtual[1]; $screenWidth = $virtual[2]; $screenHeight = $virtual[3]',",
    replace: "    '$screenLeft = $virtual[0]; $screenTop = $virtual[1]; $screenWidth = $virtual[2]; $screenHeight = $virtual[3]',\n    '$virtualScreenWasRead = $true',",
    expect: 21,
    why: 'A control: an extra local that changes no answer. The gate must stay green, or it is measuring the edit rather than the geometry.',
    expectVerdict: 'GREEN',
  },
  {
    id: 'M2',
    file: WIN32,
    name: 'the screen capture stops checking that the copy is the size of the virtual screen',
    find: "    `if ($sourceWidth -ne $screenWidth -or $sourceHeight -ne $screenHeight) { ${psError('capture_scope_mismatch', 'The copied bitmap is not the size of the virtual screen, so it is not a whole-desktop capture.')} }`,\n",
    replace: '',
    expect: 21,
    why: 'Without this check the script would hand back whatever the copy produced, however small, as a whole-desktop capture - the same class as a window dressed up as a screen. The assertion requires the check to be present.',
    expectVerdict: 'RED',
  },
  {
    id: 'M3',
    file: WIN32,
    name: 'the screen capture dresses itself up as a window capture',
    find: "function captureResultFrom(result, { lane, action, fallbackPath, fallbackMethod, targetScope, expectedWidth, expectedHeight, startedAt }) {",
    replace: "function captureResultFrom(result, { lane, action, fallbackPath, fallbackMethod, targetScope, expectedWidth, expectedHeight, startedAt }) {\n  targetScope = typeof targetScope === 'string' && targetScope === 'screen' ? '0x23054A' : targetScope;",
    expect: 21,
    why: 'This is the original defect in one line: a screen capture answering with a window handle as its scope. The assertion requires target_scope to be the literal "screen".',
    expectVerdict: 'RED',
  },
  {
    id: 'M4',
    file: WIN32,
    name: 'the screen capture lands as one flat colour (a black frame)',
    find: "      if (!copied) return new long[0];\n      return new long[] { bitmap.ToInt64(), width, height };",
    replace: "      if (!copied) return new long[0];\n      /* MUTANT: paint the copy flat, which is what PrintWindow on the desktop window tends to\n       * produce. A capture path that accepted this would hand the user a black rectangle. */\n      IntPtr flatBrush = CreateSolidBrush(0x00000000);\n      RECT flat = new RECT(); flat.Left = 0; flat.Top = 0; flat.Right = width; flat.Bottom = height;\n      FillRect(memoryDc, ref flat, flatBrush);\n      DeleteObject(flatBrush);\n      return new long[] { bitmap.ToInt64(), width, height };",
    expect: 21,
    why: 'A black frame must FAIL. The lane-side digest guard is what refuses it, and the assertion requires a successful capture to carry more than one luma level.',
    expectVerdict: 'RED',
  },
  {
    id: 'M5',
    file: COMPONENT,
    name: 'screen_capture target "desktop" goes back to the foreground window',
    find: "              action: application ? 'app_observe' : 'capture_screen',",
    replace: "              action: application ? 'app_observe' : 'observe',",
    expect: 20,
    why: 'The recorded defect itself. The assertion reads the tool layer for the dispatch it must make.',
    expectVerdict: 'RED',
  },
  {
    id: 'M6',
    file: WIN32,
    name: 'the Windows keys leave the key table',
    find: 'const WINDOWS_KEYS = Object.freeze({\n  win: VK_LEFT_WINDOWS,',
    replace: 'const WINDOWS_KEYS = Object.freeze({\n  __win: VK_LEFT_WINDOWS,',
    expect: 22,
    why: 'Exactly the state the user hit: win/meta/super resolve to nothing. The assertion requires each spelling to resolve.',
    expectVerdict: 'RED',
  },
  {
    id: 'M7',
    file: WIN32,
    name: 'a Windows chord is handed back to SendKeys',
    find: "  if (chord.windowsKey) return windowsKeyScript(key, chord, expect);",
    replace: "  if (chord.windowsKey && false) return windowsKeyScript(key, chord, expect);",
    expect: 22,
    why: 'SendKeys cannot express the Windows key: this is the mutant that reproduces "win+r returned ok:true and opened nothing".',
    expectVerdict: 'RED',
  },
  {
    id: 'M8',
    file: WIN32,
    name: 'a lone Windows key is delivered without the stroke inside the hold',
    find: '      `$sent = [NewmarkCuNative]::SendVirtualKeysHeld([uint16[]]@(${windowsKeyCodes}), [uint16[]]@(${VK_DUMMY}))`,',
    replace: '      `$sent = [NewmarkCuNative]::SendVirtualKeys([uint16[]]@(${windowsKeyCodes}))`,',
    expect: 22,
    why: 'The undelivered-key shape the user measured: a bare down/up pair. The assertion requires the held entry point with the dummy stroke in it.',
    expectVerdict: 'RED',
  },
  {
    id: 'M9',
    file: WIN32,
    name: 'the Windows key receipt stops reporting what was measured',
    find: 'windows_key_effect=${held ? \'$(if ($changed -or $backgroundChanged) { "foreground-or-window-changed" } else { "not-observed" })\' : \'"not-measured"\'};',
    replace: 'windows_key_effect="delivered-and-assumed-to-have-worked";',
    expect: 22,
    why: 'The silent ok:true is what cost the most time. The assertion requires the lone key to report not-observed when nothing changed.',
    expectVerdict: 'RED',
  },
  {
    id: 'M10',
    file: WIN32,
    name: 'CONTROL — previewKeyScript is inlined at its one call site',
    find: 'export function previewKeyScript(key, expect = {}) {\n  return realKeyScript(key, expect);\n}',
    replace: 'export function previewKeyScript(key, expect = {}) {\n  return realKeyScript(key, expect); /* unchanged: the call is the same call */\n}',
    expect: 22,
    why: 'A control: a comment cannot change behaviour, so the gate must stay green. A probe that went red here would be measuring the edit rather than the property.',
    expectVerdict: 'GREEN',
  },
];

function runGate() {
  const result = spawnSync(process.execPath, [GATE], { cwd: dirname(REPO), encoding: 'utf8', timeout: 900000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const failed = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = /^FAIL\s+(\d+)\./.exec(line.trim());
    if (match) failed.add(Number(match[1]));
  }
  const summary = (output.split(/\r?\n/).filter(line => /^SUMMARY|^FAIL |^PASS$/.test(line.trim())).slice(-3).join(' | ')) || 'no summary';
  return { failed, summary, status: result.status, output };
}

const results = [];
let exitCode = 0;
try {
  for (const mutation of MUTATIONS) {
    const original = originals.get(mutation.file).toString('utf8');
    const count = original.split(mutation.find).length - 1;
    if (count !== 1) {
      console.log(`REFUSE ${mutation.id}: the anchor occurs ${count} times in ${mutation.file}`);
      exitCode = 2;
      break;
    }
    writeFileSync(mutation.file, original.split(mutation.find).join(mutation.replace));
    let outcome;
    try {
      outcome = runGate();
    } finally {
      writeFileSync(mutation.file, originals.get(mutation.file));
    }
    const restored = sha(readFileSync(mutation.file));
    const expected = sha(originals.get(mutation.file));
    const restoredOk = restored === expected;

    const verdict = mutation.expectVerdict === 'GREEN'
      ? (outcome.failed.size === 0 ? 'GREEN' : 'RED')
      : (outcome.failed.has(mutation.expect) ? 'RED' : 'GREEN');
    const ok = verdict === mutation.expectVerdict && restoredOk;
    if (!ok) exitCode = 1;
    results.push({ id: mutation.id, name: mutation.name, expected: mutation.expectVerdict, observed: verdict, restored: restoredOk, failedChecks: [...outcome.failed], summary: outcome.summary, ok });
    console.log(`${ok ? 'OK  ' : 'BAD '} ${mutation.id} expect=${mutation.expectVerdict} observed=${verdict} restored=${restoredOk}`);
    console.log(`     ${mutation.name}`);
    console.log(`     failed checks: ${JSON.stringify([...outcome.failed])}`);
    console.log(`     ${outcome.summary}`);
    console.log(`     why: ${mutation.why}`);
  }
} finally {
  for (const [file, buffer] of originals) {
    const current = readFileSync(file);
    if (sha(current) !== sha(buffer)) writeFileSync(file, buffer);
  }
}

console.log('\n=== RESTORATION SWEEP ===');
for (const [file, buffer] of originals) {
  const current = sha(readFileSync(file));
  const expected = sha(buffer);
  const ok = current === expected;
  if (!ok) exitCode = 1;
  console.log(`  ${ok ? 'MATCH  ' : 'MISMATCH'} ${file}`);
  console.log(`           ${current}`);
}
console.log(`\n${exitCode === 0 ? 'PASS' : 'FAIL'} ${results.filter(item => item.ok).length}/${results.length} mutations produced their expected verdict`);
process.exit(exitCode);
