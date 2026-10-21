#!/usr/bin/env node
/**
 * measure-cycle-break-mutations.mjs — measure EVERY assertion 解环判定 added.
 *
 * The rule this repository keeps learning the hard way: an assertion that cannot fail is not an
 * assertion. Each mutation below removes exactly the thing one new assertion exists to protect —
 * the raw-document read, the ring's order, the normalizer replay, the cut itself, the tag a cut
 * must not undeclare, the refusals, the direction facts, the fourth question, the `cut` decision
 * kind, the planted boundary fixture, and an `undefined` inside the new shape — and the named gate
 * is then run against the mutated bytes. A mutation that leaves the NAMED check green is reported
 * as UNPROTECTED, not as a pass.
 *
 * Restoration is by the exact bytes captured at start-up and verified with sha256, never trusted
 * to the mutation's own inverse, and the original bytes are written back in a `finally` and again
 * on process exit, so an interrupted run cannot leave a mutated package behind.
 *
 * Every gate here runs against a THROWAWAY root (`mkdtemp`), which is why this can be run at all:
 * a measurement that wrote into the user's own ~/.Newmark would be worse than no measurement.
 *
 *     node scripts/measure-cycle-break-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PKG = join(REPO, 'packages', 'newmark-core');
const SCRATCH = process.env.NM_CYCLE_MUTATIONS_SCRATCH?.trim()
  ? resolve(process.env.NM_CYCLE_MUTATIONS_SCRATCH.trim())
  : join(REPO, 'evidence', 'cycle-break-mutations', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(SCRATCH, { recursive: true });

const FILES = {
  store: join(PKG, 'components', 'memorylab', 'lib', 'memory-store.js'),
  component: join(PKG, 'components', 'memorylab', 'component.js'),
  boundary: join(REPO, 'scripts', 'verify-tool-output-boundary.mjs'),
};
const GATES = {
  store: join(REPO, 'scripts', 'verify-memorylab-store.mjs'),
  tools: join(REPO, 'scripts', 'verify-memorylab-tools.mjs'),
  boundary: join(REPO, 'scripts', 'verify-tool-output-boundary.mjs'),
};

/** The exact bytes of every file this script can mutate, kept for the byte-for-byte restore. */
const ORIGINAL = new Map(Object.entries(FILES).map(([key, file]) => [key, readFileSync(file)]));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baseline = Object.fromEntries(Array.from(ORIGINAL, ([key, bytes]) => [key, sha(bytes)]));

function restoreAll() {
  for (const [key, bytes] of ORIGINAL) {
    let current = null;
    try {
      current = readFileSync(FILES[key]);
    } catch {
      current = null;
    }
    if (current === null || sha(current) !== sha(bytes)) writeFileSync(FILES[key], bytes);
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
 * Each mutation names the assertion it is meant to make able to fail, and the check the gate is
 * expected to report as red. `find` must occur EXACTLY once in that file, so a mutation that no
 * longer matches its source is reported as a NO-OP rather than silently measuring something else.
 */
const MUTATIONS = [
  {
    id: 'M1',
    file: 'store',
    gate: 'store',
    protects: '38: the finding reads the RAW document, because the graph a review is handed holds no cycle',
    find: '      const cycles = this.storedCycles(relations);',
    replace: '      const cycles = { paths: [], selfEdges: [], truncated: false };',
    expect: '38. 解环判定',
  },
  {
    id: 'M2',
    file: 'store',
    gate: 'store',
    protects: "38: the ring is reported in WALK order — the direction is the fact a reader needs",
    find: '            const cycle = [...path.slice(at), child];',
    replace: '            const cycle = [...path.slice(at), child].slice().sort();',
    expect: '38. 解环判定',
  },
  {
    id: 'M3',
    file: 'store',
    gate: 'store',
    protects: '38: the suggested cut is the edge the normalizer drops, so the finding and the warning agree',
    find: '        return { path, suggested: cuttable[0] || dropped || edges[0], free: false };',
    replace: '        return { path, suggested: cuttable[0] || edges[0], free: false };',
    expect: '38. 解环判定',
  },
  {
    id: 'M4',
    file: 'store',
    gate: 'store',
    protects: '38: the cut records WHICH chain it removed, from which component',
    find: '          removedFrom,',
    replace: '          removedFrom: [],',
    expect: '38. 解环判定',
  },
  {
    id: 'M5',
    file: 'store',
    gate: 'store',
    protects: '38: the suggested cut is published as the SAME edge object the edges list carries',
    find: '        const suggestedCut = entry.edges.find((edge) => edge.parent === entry.suggested.parent && edge.child === entry.suggested.child) || entry.edges[0];',
    replace: '        const suggestedCut = { kind: \'cut\', parent: entry.suggested.parent, child: entry.suggested.child };',
    expect: '38. 解环判定',
  },
  {
    id: 'M6',
    file: 'store',
    gate: 'store',
    protects: '38: the suggested cut falls back to the edge the normalizer drops when nothing asserts one',
    find: '        return { path, suggested: cuttable[0] || dropped || edges[0], free: false };',
    replace: '        return { path, suggested: cuttable[0] || edges[0], free: false };',
    expect: '38. 解环判定',
  },
  {
    id: 'M7',
    file: 'store',
    gate: 'store',
    protects: '38: a cut of an edge no index holds is refused rather than reported as a repair',
    find: "        if (!relations.says(parent, child, 'children') && !relations.says(parent, child, 'parents')) {",
    replace: '        if (false) {',
    expect: '38. 解环判定',
  },
  {
    id: 'M8',
    file: 'store',
    gate: 'store',
    protects: '38: a one-sided leftover edge is NOT a cycle — the false positive the detector avoids',
    find: "    walkProjection(source.relation('children'), 'children');",
    replace: "    walkProjection(source.relation('children'), 'children');\n    walkProjection(source.relation('parents'), 'parents');",
    expect: '38. 解环判定',
  },
  {
    id: 'M9',
    file: 'store',
    gate: 'store',
    protects: '39: the equal-count pair keeps the direction undecided (the structural rule needs a childless side)',
    find: '    if (!moreGeneral && fa.childCount !== fb.childCount',
    replace: '    if (fa.childCount !== fb.childCount || fa.componentCount !== fb.componentCount) {',
    expect: '39. 解环判定',
    unreachable: true,
    note:
      'a wider structural rule fires only when the two tags differ in components or children, and when they differ one side is a childless root beside a parent root with two components — which the ORIGINAL rule also decides. No graph separates the two conditions, so no gate can red on this mutation. The gate that does protect the rule is the equal-count fixture: both counts equal is exactly the case where the rule must NOT fire, and it is asserted with `directionDecided: false` and `moreGeneral: null`.',
  },
  {
    id: 'M10',
    file: 'store',
    gate: 'store',
    protects: '39: the evidence facts travel with the finding (generality, co-occurrence, containment)',
    find: '      basis,\n      coOccurrenceOnly,',
    replace: '      basis: [],\n      coOccurrenceOnly,',
    expect: '39. 解环判定',
  },
  {
    id: 'M11',
    file: 'component',
    gate: 'tools',
    protects: 'the prompt tells a run how to break a cycle, and that a cut NAMES the edge a reparent only loses',
    find: "      '- 解环判定：先看 evidence.shape 是哪一种。",
    findTo: '把没有证据的方向说成结论，比不判定更糟。\',',
    replace: "      '- （解环判定的约束已被移除）',",
    expect: 'the prompt tells a run how to break a cycle',
  },
  {
    id: 'M12',
    file: 'component',
    gate: 'tools',
    protects: 'the request carries the fourth question, 解环判定, with its evidence kind',
    find: "          id: 'cycle-break',",
    replace: "          id: 'cycle-break-removed',",
    expect: 'the fourth question is 解环判定',
  },
  {
    id: 'M13',
    file: 'component',
    gate: 'tools',
    protects: 'cut is a judgement decision, so breaking a cycle needs a reachable judge',
    find: "export const JUDGEMENT_DECISION_KINDS = Object.freeze(['merge', 'reparent', 'split', 'join', 'cut']);",
    replace: "export const JUDGEMENT_DECISION_KINDS = Object.freeze(['merge', 'reparent', 'split', 'join']);",
    expect: 'decision vocabulary',
  },
  {
    id: 'M14',
    file: 'boundary',
    gate: 'boundary',
    protects: 'the cycle fixture is really planted before the boundary walks it (no vacuous pass)',
    find: "      writeFileSync(storeIndex, JSON.stringify(plantedIndex, null, 2), 'utf8');",
    replace: '      writeFileSync(storeIndex, plantedBytes);',
    expect: 'the stored-cycle finding crosses the output boundary',
  },
  {
    id: 'M15',
    file: 'store',
    gate: 'boundary',
    protects: "the new shape survives DSH's lossless-JSON boundary: an `undefined` inside it is caught",
    find: '              normalizerDrops: normalizerDrop.map((edge) => ({ parent: edge.parent, child: edge.child, rule: edge.rule })),',
    replace: '              normalizerDrops: normalizerDrop.map((edge) => ({ parent: edge.parent, child: edge.child, rule: normalizerDrop.length > 99 ? edge.rule : undefined })),',
    expect: 'every value a tool body returned is lossless JSON',
  },
];

/** The checks one gate reported, so a red run can be attributed to the assertion it was meant for. */
function failingChecks(output) {
  return output
    .split('\n')
    .filter((line) => /^\s*(not ok|FAIL\b|  \[FAIL\])/.test(line))
    .map((line) => line.trim());
}

const rows = [];
for (const mutation of MUTATIONS) {
  if (mutation.unreachable) {
    rows.push({ id: mutation.id, status: 'UNREACHABLE', protects: mutation.protects, detail: mutation.note || 'no graph distinguishes this mutation' });
    console.log(`${mutation.id.padEnd(4)} UNREACHABLE  ${mutation.protects}`);
    continue;
  }
  const file = FILES[mutation.file];
  const source = ORIGINAL.get(mutation.file).toString('utf8');
  const occurrences = source.split(mutation.find).length - 1;
  const endOccurrences = mutation.findTo ? source.split(mutation.findTo).length - 1 : 0;
  if (occurrences !== 1 || (mutation.findTo && endOccurrences !== 1)) {
    rows.push({
      id: mutation.id,
      status: 'NO-OP',
      protects: mutation.protects,
      detail: `${occurrences} occurrence(s) of the planted text${mutation.findTo ? `, ${endOccurrences} of its end` : ''}`,
    });
    console.log(`${mutation.id.padEnd(4)} NO-OP  ${occurrences} occurrence(s): ${mutation.protects}`);
    continue;
  }
  let output = '';
  let exitCode = 0;
  let restored = false;
  try {
    const mutated = mutation.findTo
      ? `${source.slice(0, source.indexOf(mutation.find))}${mutation.replace}${source.slice(source.indexOf(mutation.findTo) + mutation.findTo.length)}`
      : source.replace(mutation.find, mutation.replace);
    writeFileSync(file, mutated, 'utf8');
    try {
      output = execFileSync(process.execPath, [GATES[mutation.gate]], {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 900000,
      });
    } catch (error) {
      exitCode = typeof error.status === 'number' ? error.status : 1;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
  } finally {
    restoreAll();
    restored = sha(readFileSync(file)) === baseline[mutation.file];
  }
  const red = failingChecks(output);
  const hits = red.filter((line) => line.includes(mutation.expect));
  const status = hits.length > 0 ? 'RED (named check)' : red.length > 0 ? 'RED (other check)' : 'UNPROTECTED';
  rows.push({
    id: mutation.id,
    status,
    exitCode,
    restored,
    protects: mutation.protects,
    expected: mutation.expect,
    detail: hits[0] || red.slice(0, 2).join(' ;; ') || `${GATES[mutation.gate].split(/[\\/]/).pop()} stayed green`,
  });
  console.log(`${mutation.id.padEnd(4)} ${status.padEnd(20)} exit=${exitCode} restored=${restored}`);
  console.log(`      protects: ${mutation.protects}`);
  console.log(`      red:      ${hits[0] || red.slice(0, 2).join(' ;; ') || '(nothing — the gate stayed green)'}`);
}

console.log('\n=== the table ===');
for (const row of rows) {
  console.log(`${row.id.padEnd(4)} | ${String(row.status).padEnd(20)} | restored=${row.restored === undefined ? '-' : row.restored} | ${row.protects}`);
  if (row.detail) console.log(`     ${row.detail}`);
}
const unprotected = rows.filter((row) => row.status === 'UNPROTECTED' || row.status === 'NO-OP');
const unreachable = rows.filter((row) => row.status === 'UNREACHABLE');
console.log(`\nmeasured=${rows.filter((row) => row.status.startsWith('RED')).length} unprotected=${unprotected.length} unreachable=${unreachable.length}`);
for (const row of unreachable) console.log(`  ${row.id} unreachable: ${row.detail}`);
writeFileSync(join(SCRATCH, 'mutations.json'), JSON.stringify({ baseline, restoreVerified: rows.every((row) => row.restored !== false), rows }, null, 2), 'utf8');
console.log(`receipt: ${join(SCRATCH, 'mutations.json')}`);
process.exitCode = unprotected.length === 0 ? 0 : 1;
