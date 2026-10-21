#!/usr/bin/env node
/**
 * verify-computeruse-native-dialect.mjs - the C# dialect gate for every native helper in the
 * ComputerUse component, and the compile gate that makes the tuple rule exact.
 *
 * =====================================================================================
 * WHY THIS GATE EXISTS AND WHY IT IS NOT PART OF THE OTHER GATES
 * =====================================================================================
 *
 * `lib/win32.js` carries one C# helper (`NATIVE_CSHARP`, 43.5 KB, 87 public static methods) and the
 * lane host falls back to `powershell.exe` (`lib/win32.js` `ensureChild`), where `Add-Type` compiles
 * with the C# 5 compiler from .NET Framework 4. ONE modern construct - one `$"`, one `?.`, one
 * `out var` - and the whole lane stops compiling: every action of ComputerUse, at once, with the
 * failure surfacing as a lane error rather than as a syntax error. A phase wrote and measured this
 * rule, then removed it when it reverted its own changes, and nothing has enforced it since.
 *
 * This gate is separate from the other ComputerUse gates because it needs no runtime, no desktop
 * and no lane: it reads files and, optionally, runs the C# compiler. It spawns nothing else, so it
 * does not disturb the assertion in `verify-computeruse-output-boundary.mjs` that the component
 * starts no process when a gate runs unattended - the component still starts none. The compiler
 * this gate runs is the gate's own tool, the same way that gate's PowerShell lanes are theirs.
 *
 * =====================================================================================
 * TWO MECHANISMS, BECAUSE ONE OF THE SEVEN RULES IS NOT DECIDABLE BY A REGULAR EXPRESSION
 * =====================================================================================
 *
 *   1. TEXTUAL, over comment-stripped and string-stripped payload text (`lib/csharp-dialect.js`):
 *      the seven constructs plus every `System.Drawing` type name. The shipped helper's own doc
 *      comment names `System.Drawing.Bitmap` to explain why it does not use one, so a check over
 *      raw text goes red on the sentence that documents the rule; stripping is load-bearing and the
 *      mutation table proves it by planting a violation inside a comment.
 *
 *      The TUPLE rule is deliberately only the unambiguous markers (`ValueTuple`, `System.Tuple<`,
 *      `var (a, b)`). A first version also matched a tuple type spelled as a parenthesised list of
 *      type-and-name pairs and produced 50 violations on the shipped helper, EVERY ONE an ordinary
 *      parameter list: a tuple type and a parameter list are lexically identical in C#. A rule
 *      narrowed until it stops firing is not a rule.
 *
 *   2. COMPILE, with `csc.exe` from .NET Framework 4 at `/warnaserror`. This is exact where the
 *      regex cannot be: the C# 5 compiler rejects tuple syntax wherever it appears. `/warnaserror`
 *      is not extra strictness - it is what `Add-Type` in Windows PowerShell 5.1 actually does, and
 *      this gate caught a real defect that way: a payload that merely WARNED (CS0078, sign-extended
 *      operand) failed to compile in the lane, so the dialect includes "does not warn".
 *
 * Exit codes: 0 every assertion held; 1 an assertion failed; 2 the probe could not be armed.
 *
 * Invoke: node Newmark2DSH/scripts/verify-computeruse-native-dialect.mjs
 *         node Newmark2DSH/scripts/verify-computeruse-native-dialect.mjs --no-compile
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSHARP_PAYLOADS,
  AGENT_PS1,
  DESKTOP_LAUNCHER_PS1,
  DESKTOP_KEEPER_PS1,
} from '../packages/newmark-core/components/computeruse/lib/hidden-agent.js';
import {
  MODERN_CSHARP,
  FORBIDDEN_DRAWING_NAMES,
  findDialectViolations,
  stripCommentsAndStrings,
  extractTemplateLiteral,
} from '../packages/newmark-core/components/computeruse/lib/csharp-dialect.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const COMPONENT = path.join(REPO, 'packages', 'newmark-core', 'components', 'computeruse');
const LIB = path.join(COMPONENT, 'lib');
const WIN32 = path.join(LIB, 'win32.js');
const AGENT_MODULE = path.join(LIB, 'hidden-agent.js');
const NO_COMPILE = process.argv.includes('--no-compile');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(REPO, 'evidence', 'computeruse-native-dialect', STAMP);
fs.mkdirSync(OUT, { recursive: true });

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const SCRATCH = path.join(os.tmpdir(), `nm-dialect-${process.pid}`);
fs.mkdirSync(SCRATCH, { recursive: true });

let passed = 0;
let failed = 0;
const RESULTS = [];
const say = (line = '') => process.stdout.write(`${String(line)}\n`);

function record(name, ok, detail) {
  RESULTS.push({ name, ok: ok === true, detail: String(detail) });
  if (ok === true) passed += 1; else failed += 1;
  say(`  [${ok === true ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ''}`);
}

function refuse(reason) {
  say(`\nGATE COULD NOT BE ARMED: ${reason}`);
  process.exit(2);
}

/* ------------------------------------------------------------------- the payload set --- */

/**
 * Every C# payload in the component, with the route that produces the text that is COMPILED.
 *
 * `lib/win32.js` is a plain template literal, so its `${...}` sites are JavaScript and not C#:
 * compiled as source text it fails with CS1056 "unexpected character '$'". The payload that
 * actually compiles is the EVALUATED one, and the evaluation below is the module's own - the token
 * is read from the source by an exact anchor, the value comes from the module's own export, and the
 * anchor is required to hit or the gate refuses rather than compiling something else.
 */
const win32Source = fs.readFileSync(WIN32, 'utf8');
const nativeTemplate = extractTemplateLiteral(win32Source, 'const NATIVE_CSHARP_TEMPLATE =');
if (!nativeTemplate.ok) refuse(`the NATIVE_CSHARP template could not be extracted: ${nativeTemplate.reason}`);
const tokenMatch = /^const MOVE_CURVE_TOKEN = '([^']*)';$/m.exec(win32Source);
if (!tokenMatch) refuse('the MOVE_CURVE_TOKEN anchor did not match exactly once');
const MOVE_CURVE_TOKEN = tokenMatch[1];
const win32Module = await import(new URL('../packages/newmark-core/components/computeruse/lib/win32.js', import.meta.url).href);
const interpolationSites = [...new Set(nativeTemplate.body.match(/\$\{[A-Za-z_$][\w$]*\}/g) || [])];
if (interpolationSites.some((site) => site !== '${MOVE_CURVE_TOKEN}')) {
  refuse(`the payload source carries an interpolation site this gate does not know how to evaluate: ${interpolationSites.join(', ')}`);
}
const nativeEvaluated = nativeTemplate.body
  .split('${MOVE_CURVE_TOKEN}').join(MOVE_CURVE_TOKEN)
  .split(MOVE_CURVE_TOKEN).join(String(win32Module.MOVE_CURVE_MS));

const PAYLOADS = [
  { name: 'win32.js NATIVE_CSHARP', file: WIN32, source: nativeEvaluated, line: nativeTemplate.startLine },
  ...Object.entries(CSHARP_PAYLOADS).map(([name, source]) => ({ name: `hidden-agent.js ${name}`, file: AGENT_MODULE, source })),
];

say('=== ComputerUse native dialect gate ===');
say(`evidence: ${OUT}`);
say(`csc:      ${CSC} (exists: ${fs.existsSync(CSC)})`);
say(`payloads: ${PAYLOADS.length}`);
say(`\n--- what was extracted ---`);
record('every C# payload in the component was found and evaluated',
  // Derived from the payload map rather than a hard-coded count: a hard-coded 8 was a copy of
  // the map that goes stale in silence, and a payload added without this file noticing would
  // have gone through this gate unchecked.
  PAYLOADS.length === 1 + Object.keys(CSHARP_PAYLOADS).length && PAYLOADS.every((payload) => typeof payload.source === 'string' && payload.source.length > 200),
  PAYLOADS.map((payload) => `${payload.name}=${Buffer.byteLength(payload.source, 'utf8')}B`).join(' '));
record('the shipped helper was evaluated through its own interpolation token, not copied as source',
  interpolationSites.length === 1 && nativeEvaluated.includes(String(win32Module.MOVE_CURVE_MS)) && !nativeEvaluated.includes('${'),
  `sites=${interpolationSites.join(',')} MOVE_CURVE_MS=${win32Module.MOVE_CURVE_MS} bytes=${Buffer.byteLength(nativeEvaluated, 'utf8')}`);

/* --------------------------------------------------------------------- the textual rule --- */

say(`\n--- textual rule, over comment-stripped and string-stripped text ---`);
for (const payload of PAYLOADS) {
  const violations = findDialectViolations(payload.source);
  record(`${payload.name} is in the dialect`,
    violations.length === 0,
    violations.length === 0 ? `${MODERN_CSHARP.length + FORBIDDEN_DRAWING_NAMES.length} rules, no violation` : violations.map((violation) => `line ${violation.line}: ${violation.description} near ${JSON.stringify(violation.excerpt)}`).join(' | '));
}

/**
 * The stripping is load-bearing and that is measured, not asserted.
 *
 * The shipped helper's doc comment says it returns an HBITMAP rather than a `System.Drawing.Bitmap`.
 * Raw, that text violates the rule; stripped, it does not. If the stripper were removed the gate
 * would go red on the sentence that documents the very rule it enforces, so this checks that both
 * halves are true.
 */
const rawDrawing = /\bSystem\s*\.\s*Drawing\b/.test(nativeTemplate.body);
const strippedDrawing = /\bSystem\s*\.\s*Drawing\b/.test(stripCommentsAndStrings(nativeTemplate.body));
record('the shipped helper NAMES System.Drawing in a comment and the stripped text does not',
  rawDrawing === true && strippedDrawing === false,
  `raw mentions it: ${rawDrawing}; stripped mentions it: ${strippedDrawing} - so the rule is applied to code and the mutation table below proves the stripper can fail`);

/* ------------------------------------------------------------------- the compile rule --- */

say(`\n--- compile rule, csc /warnaserror (the C# 5 compiler Add-Type uses on 5.1) ---`);
let compiled = 0;
if (NO_COMPILE) {
  say('  (skipped: --no-compile)');
} else if (!fs.existsSync(CSC)) {
  refuse(`the C# 5 compiler is not at ${CSC}`);
} else {
  for (const payload of PAYLOADS) {
    const slug = payload.name.replace(/[^A-Za-z0-9]+/g, '_');
    const file = path.join(SCRATCH, `${slug}.cs`);
    fs.writeFileSync(file, payload.source, 'utf8');
    const run = spawnSync(CSC, ['/nologo', '/warnaserror', '/target:library', `/out:${path.join(SCRATCH, `${slug}.dll`)}`, file], { encoding: 'utf8' });
    const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
    record(`${payload.name} compiles under C# 5 with warnings as errors`,
      run.status === 0,
      run.status === 0 ? 'compiled' : output.split(/\r?\n/).slice(0, 4).join(' | '));
    if (run.status === 0) compiled += 1;
  }
  record('every payload compiled, so nothing was silently skipped',
    compiled === PAYLOADS.length, `${compiled}/${PAYLOADS.length}`);
}

/* ------------------------------------------------------ the JavaScript-side trap --- */

say(`\n--- the template-literal trap, which has already broken this lane once ---`);
for (const [name, source] of [['AGENT_PS1', AGENT_PS1], ['DESKTOP_LAUNCHER_PS1', DESKTOP_LAUNCHER_PS1], ['DESKTOP_KEEPER_PS1', DESKTOP_KEEPER_PS1]]) {
  const bad = [];
  if (source.includes('`')) bad.push('a backtick, which terminates the template literal it lives in');
  if (source.includes('${')) bad.push('a dollar-brace, which JavaScript interpolates before PowerShell ever sees it');
  record(`${name} contains no backtick and no dollar-brace`, bad.length === 0, bad.join('; ') || `${source.split('\n').length} lines clean`);
}

/* ------------------------------------------------------------- the mutation table --- */

say(`\n--- mutation table: each rule is planted with a violation and must go red ---`);
/**
 * The mutation table, where EVERY row has to be able to fail.
 *
 * The first version asserted, for every rule, that the C# 5 compiler also refuses the planted
 * construct. Three rows came back "CSC ACCEPTED IT", and every one of them is a fact rather than a
 * broken mutation:
 *
 *   =>            a LAMBDA is C# 3 and C# 5 compiles it happily. What C# 5 cannot compile is an
 *                 EXPRESSION-BODIED MEMBER, which is also `=>`. So the `arrow` rule bans both, and
 *                 the half of it the compiler can check is the expression-bodied half.
 *   ValueTuple    the TYPE exists in .NET Framework 4.8, so naming it compiles. It is tuple
 *                 SYNTAX that C# 5 rejects.
 *   System.Drawing
 *                 csc.exe reads csc.rsp by default, which references System.Drawing.dll, so a bare
 *                 csc invocation accepts what Add-Type refuses. The CS1069 trap this rule exists for
 *                 is a property of Add-Type's reference list, not of the compiler.
 *
 * So each row now declares what the COMPILER is expected to do with it, and the row fails if the
 * compiler does anything else. Rows where the compiler must accept it are not dead weight: they are
 * the measurement that the textual rule is the only thing covering that case, stated so that it
 * stops being true loudly if the framework or the compiler changes.
 */
const MUTATIONS = [
  { id: 'interpolated-string', ruleIds: ['interpolated-string'], compilerRejects: true, plant: () => 'public static class NmMutantA { public static string S(int n) { return $"v={n}"; } }' },
  { id: 'expression-bodied-member', ruleIds: ['arrow'], compilerRejects: true, plant: () => 'public static class NmMutantB { public static int F() => 1; }' },
  {
    id: 'tuple-syntax',
    ruleIds: [],
    compilerRejects: true,
    because: 'the textual rule deliberately CANNOT see this one: a tuple type and a parameter list are lexically identical in C#, which is why the compile gate exists at all',
    plant: () => 'public static class NmMutantC { public static (int, int) T() { return (1, 2); } }',
  },
  { id: 'nameof', ruleIds: ['nameof'], compilerRejects: true, plant: () => 'public static class NmMutantD { public static string N() { return nameof(NmMutantD); } }' },
  { id: 'out-var', ruleIds: ['out-var'], compilerRejects: true, plant: () => 'public static class NmMutantE { public static int O() { int.TryParse("1", out var v); return v; } }' },
  { id: 'null-conditional', ruleIds: ['null-conditional'], compilerRejects: true, plant: () => 'public static class NmMutantF { public static int Q(string s) { return s?.Length ?? 0; } }' },
  { id: 'using-static', ruleIds: ['using-static'], compilerRejects: true, plant: () => 'using static System.Math;\npublic static class NmMutantG { public static double R() { return Abs(-1.0); } }' },
  {
    id: 'lambda',
    ruleIds: ['arrow'],
    compilerRejects: false,
    because: 'a lambda is C# 3, so the compiler accepts it and the textual rule is the ONLY thing keeping it out of the helper',
    plant: () => 'public static class NmMutantH { public static int L() { Func<int, int> g = x => x + 1; return g(1); } }',
  },
  {
    id: 'tuple',
    ruleIds: ['tuple'],
    compilerRejects: false,
    because: 'the ValueTuple TYPE ships in .NET Framework 4.8, so naming it compiles; the textual rule covers the marker and tuple SYNTAX is covered by the tuple-syntax row above',
    plant: () => 'public static class NmMutantI { public static ValueTuple<int, int> T() { return new ValueTuple<int, int>(1, 2); } }',
  },
  {
    id: 'system-drawing',
    ruleIds: ['system-drawing', 'bitmap'],
    compilerRejects: false,
    because: 'csc.exe reads csc.rsp by default and that references System.Drawing.dll, so a bare csc accepts what Add-Type refuses with CS1069',
    plant: () => 'public static class NmMutantJ { public static System.Drawing.Bitmap H() { return null; } }',
  },
  {
    id: 'violation-hidden-in-a-comment',
    ruleIds: [],
    compilerRejects: false,
    expectClean: true,
    because: 'a violation inside a comment must NOT be reported: the stripper removes comments before the rule runs, and this proves the stripper is what keeps the shipped helper green rather than luck',
    plant: () => '/* this comment says return $"v={n}"; and names System.Drawing.Bitmap */\npublic static class NmMutantK { }',
  },
];

const basePayload = CSHARP_PAYLOADS.NmProcessFacts;
for (const mutation of MUTATIONS) {
  const text = `${basePayload}\n${mutation.plant()}\n`;
  const violations = findDialectViolations(text);
  const seen = violations.map((violation) => violation.id);
  const caught = mutation.ruleIds.some((id) => seen.includes(id));
  if (mutation.expectClean) {
    record(`mutation ${mutation.id}: NOT reported`, violations.length === 0,
      violations.length === 0 ? mutation.because : `REPORTED ${seen.join(',')} - the stripper is not doing its job`);
    continue;
  }
  if (mutation.ruleIds.length === 0) {
    /*
     * A row with no expected rule id is a case the TEXTUAL rule is asserted NOT to catch, and it
     * must not catch it: if a future change made the tuple regex fire on `(int, int) T()` it would
     * also fire on every parameter list in the shipped helper, which is the 50-false-positive
     * version of this rule that was thrown away. That makes this row falsifiable in both
     * directions.
     */
    record(`mutation ${mutation.id}: the textual rule deliberately does NOT fire on it`,
      violations.length === 0,
      violations.length === 0 ? mutation.because : `IT FIRED (${seen.join(',')}) - this rule cannot decide this case and a version of it that claims to will fire on ordinary parameter lists`);
  } else {
    record(`mutation ${mutation.id}: the textual rule goes RED on it`,
      caught,
      caught ? seen.join(',') : `EXPECTED ${mutation.ruleIds.join(' or ')} but saw ${seen.length === 0 ? 'nothing (this mutation cannot fail)' : seen.join(',')}`);
  }
  if (NO_COMPILE) continue;
  const verdict = compileVerdict(text);
  if (mutation.compilerRejects === true) {
    record(`mutation ${mutation.id}: the compile rule ALSO goes red on it`,
      verdict.ok === false,
      verdict.ok === false ? `csc refused: ${String(verdict.output).split(/\r?\n/)[0]}` : 'CSC ACCEPTED IT - the compile rule does not cover this construct');
  } else {
    record(`mutation ${mutation.id}: the compiler ACCEPTS it, so the textual rule is the only cover`,
      verdict.ok === true,
      verdict.ok === true ? mutation.because : `csc now REFUSES it (${String(verdict.output).split(/\r?\n/)[0]}), so this row's stated reason is out of date`);
  }
}
record('the unmutated payload is green under both rules, so the mutations measure the rules and not the baseline',
  findDialectViolations(basePayload).length === 0 && (NO_COMPILE || compileVerdict(basePayload).ok === true),
  `textual violations=${findDialectViolations(basePayload).length}`);

function compileVerdict(source) {
  const file = path.join(SCRATCH, `mutant-${Math.random().toString(36).slice(2)}.cs`);
  fs.writeFileSync(file, source, 'utf8');
  const run = spawnSync(CSC, ['/nologo', '/warnaserror', '/target:library', `/out:${file}.dll`, file], { encoding: 'utf8' });
  return { ok: run.status === 0, output: `${run.stdout || ''}${run.stderr || ''}`.trim() };
}

/* --------------------------------------------------------------------------- receipt --- */

const receipt = {
  stamp: STAMP,
  script: 'scripts/verify-computeruse-native-dialect.mjs',
  component: COMPONENT,
  payloads: PAYLOADS.map((payload) => ({ name: payload.name, bytes: Buffer.byteLength(payload.source, 'utf8') })),
  textual_rules: [...MODERN_CSHARP.map((rule) => rule.id), ...FORBIDDEN_DRAWING_NAMES.map((rule) => rule.id)],
  compile_rule: NO_COMPILE ? 'skipped' : `csc /warnaserror ${CSC}`,
  passed,
  failed,
  results: RESULTS,
};
fs.writeFileSync(path.join(OUT, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
say(`\nreceipt: ${path.join(OUT, 'receipt.json')}`);
say(`\nCOMPUTERUSE NATIVE DIALECT: ${passed} passed, ${failed} failed (of ${passed + failed})`);
say(failed === 0 ? 'DIALECT GATE PASS' : 'DIALECT GATE FAIL');
process.exit(failed === 0 ? 0 : 1);
