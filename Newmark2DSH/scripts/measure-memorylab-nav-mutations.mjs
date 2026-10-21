#!/usr/bin/env node
/**
 * measure-memorylab-nav-mutations.mjs — measure EVERY assertion the two tag-navigation reads added.
 *
 * `memory_lab_root_tags` and `memory_lab_subtag_tree` arrived with their own checks, and a check
 * that has never been red is a claim, not a measurement. Each mutation below removes exactly the
 * thing one new assertion exists to protect — a subtree size, an alias, the sort that makes a page
 * readable, the window count, a row's depth, the difference between a shared node and a cycle, the
 * `via` that says why a component is listed, the slug a caller reads back, the alias resolution,
 * the two error codes, the two bounds, the dropped report, the stored-cycle read, the walk's
 * termination, determinism itself, the read-only promise, and the instructions surface — and the
 * named gate is then run against the mutated bytes.
 *
 * Two of the rows are not about a check but about the CLASS this repository has lost two releases
 * to: a value carrying `undefined` in a NEW payload shape, measured through DSH's own validator by
 * `verify-tool-output-boundary.mjs`, and a behaviour-free comment beside it as the control that
 * says the gate is not simply reacting to an edit.
 *
 * A mutation whose named check stays green is reported as UNPROTECTED, not as a pass.
 *
 * Restoration is by the exact bytes captured at start-up and verified with sha256, never trusted to
 * the mutation's own inverse, and the original bytes are written back in a `finally` and again on
 * process exit, so an interrupted run cannot leave a mutated package behind.
 *
 * Every gate here runs against a THROWAWAY root (`mkdtemp`): the store gate aborts if the live
 * `~/.Newmark` store changes by one byte, and the boundary gate holds the same line.
 *
 *     node scripts/measure-memorylab-nav-mutations.mjs
 *     NM_NAV_MUTATION_IDS=N23,N24 node scripts/measure-memorylab-nav-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PKG = join(REPO, 'packages', 'newmark-core');
const SCRATCH = process.env.NM_NAV_MUTATIONS_SCRATCH?.trim()
  ? resolve(process.env.NM_NAV_MUTATIONS_SCRATCH.trim())
  : join(REPO, 'evidence', 'memorylab-nav-mutations', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(SCRATCH, { recursive: true });

const FILES = {
  store: join(PKG, 'components', 'memorylab', 'lib', 'memory-store.js'),
  component: join(PKG, 'components', 'memorylab', 'component.js'),
};
const GATES = {
  tools: join(REPO, 'scripts', 'verify-memorylab-tools.mjs'),
  boundary: join(REPO, 'scripts', 'verify-tool-output-boundary.mjs'),
};

/** The exact bytes of every file this script can mutate, kept for the byte-for-byte restore. */
const ORIGINAL = new Map(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(file)]));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baseline = Object.fromEntries(Array.from(ORIGINAL, ([key, bytes]) => [key, sha(bytes)]));

function restoreAll() {
  for (const [key, bytes] of ORIGINAL) {
    let current = null;
    try {
      current = fs.readFileSync(FILES[key]);
    } catch {
      current = null;
    }
    if (current === null || sha(current) !== sha(bytes)) fs.writeFileSync(FILES[key], bytes);
  }
}
process.on('exit', restoreAll);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

const INSTRUCTIONS_ELEMENT =
  "      'memory_lab_root_tags lists only the root parent tags with the size of the subtree under each, so a branch can be CHOSEN without reading the whole index; memory_lab_subtag_tree then reads one tag\\'s subtree — its structure, the component names in it, and its statistics. Both are reads: they never write, never rebuild and never judge.',";

/**
 * Each mutation names the assertion it is meant to make able to fail, and the check the gate is
 * expected to report as red. `find` must occur EXACTLY once in that file, so a mutation that no
 * longer matches its source is reported as a NO-OP rather than silently measuring something else.
 */
const MUTATIONS = [
  {
    id: 'N1',
    file: 'store',
    gate: 'tools',
    protects: 'a root is SIZED: subtreeTags is the real subtree, not a placeholder',
    find: '        subtreeTags: subtree.tagSet.size,',
    replace: '        subtreeTags: 0,',
    expect: 'the fixture root is sized from the real graph',
  },
  {
    id: 'N2',
    file: 'store',
    gate: 'tools',
    protects: 'a root row carries the aliases the store has',
    find: '        aliases: sortedUnique(toArray(node.aliases)),',
    replace: '        aliases: [],',
    expect: 'a root row carries the aliases the store has',
  },
  {
    id: 'N3',
    file: 'store',
    gate: 'tools',
    protects: 'the page leads with the branch worth descending into (largest subtree first)',
    find: '    rows.sort((a, b) => b.subtreeTags - a.subtreeTags || compareStrings(a.tag, b.tag));',
    replace: '    rows.sort((a, b) => compareStrings(a.tag, b.tag));',
    expect: 'the roots are ordered by subtree size',
  },
  {
    id: 'N4',
    file: 'store',
    gate: 'tools',
    protects: 'a paged answer says how many roots the page left out',
    find: '        omitted: Math.max(0, rows.length - offset - page.length),',
    replace: '        omitted: 0,',
    expect: 'the roots are paged, and the page says how many roots it left out',
  },
  {
    id: 'N5',
    file: 'store',
    gate: 'tools',
    protects: "a structure row carries the tag's real depth",
    find: '        depth: level,',
    replace: '        depth: 0,',
    expect: 'the structure is depth-first, level by level',
  },
  {
    id: 'N6',
    file: 'store',
    gate: 'tools',
    protects: 'a tag reachable by two paths is a SHARED node, not a cycle',
    find: '      if (visited.has(name)) {',
    replace:
      '      if (visited.has(name)) {\n        backEdges.push({ tag: name, reachedFrom: parent ? String(parent) : null, path: [...path, name] });',
    expect: 'the walk reports a tag reachable by two paths as a SHARED node',
  },
  {
    id: 'N7',
    file: 'store',
    gate: 'tools',
    protects: 'via says WHICH way a component is in the subtree: self, descendant, or both',
    find: "        via: carriesSelf && carriesBeneath ? 'both' : carriesSelf ? 'self' : 'descendant',",
    replace: "        via: 'descendant',",
    expect: 'every component in the subtree says WHY it is there',
  },
  {
    id: 'N8',
    file: 'store',
    gate: 'tools',
    protects: 'every component name in the subtree is reachable afterwards with memory_lab_read',
    find: '        slug,\n        name: String((component && component.name) || slug),',
    replace: "        slug: String(slug).concat('-gone'),\n        name: String((component && component.name) || slug),",
    expect: 'every component name in the subtree is reachable afterwards',
  },
  {
    id: 'N9',
    file: 'store',
    gate: 'tools',
    protects: "the tag a subtree is read from has no parent INSIDE its own subtree (the row says null)",
    find: '        parent: parent ? String(parent) : null,',
    replace: "        parent: parent ? String(parent) : 'none',",
    expect: 'a leaf tag answers a subtree of one',
  },
  {
    id: 'N10',
    file: 'store',
    gate: 'tools',
    protects: 'an alias the store advertises resolves to the tag it is an alias of',
    find: "    const key = normalized ? comparisonKey(normalized) : '';\n    if (key) {",
    replace: "    const key = normalized ? comparisonKey(normalized) : '';\n    if (false) {",
    expect: 'the leading # is optional, and an alias the store advertises resolves',
  },
  {
    id: 'N11',
    file: 'store',
    gate: 'tools',
    protects: 'an unknown tag is NOT_FOUND — the code memory_lab_read uses for a missing component',
    find: "  return new MemoryLabStoreError('NOT_FOUND', `Memory Lab tag not found: ${selector}`, {",
    replace: "  return new MemoryLabStoreError('TAG_NOT_FOUND', `Memory Lab tag not found: ${selector}`, {",
    expect: 'an unknown tag is NOT_FOUND',
  },
  {
    id: 'N12',
    file: 'store',
    gate: 'tools',
    protects: 'a tag that was not given is refused as INVALID_TAG, not answered as something else',
    find: "        'INVALID_TAG',",
    replace: "        'INVALID_QUERY',",
    expect: 'an empty tag is refused',
  },
  {
    id: 'N13',
    file: 'store',
    gate: 'tools',
    protects: 'max_tags really bounds the structure table',
    find: '    const structureShown = structure.slice(0, maxTags);',
    replace: '    const structureShown = structure.slice(0, structure.length);',
    expect: 'the payload is bounded by max_tags and max_components',
  },
  {
    id: 'N14',
    file: 'store',
    gate: 'tools',
    protects: 'what was dropped is listed, naming the parameter that dropped it',
    find: '      dropped.push(`structure: ${structureShown.length} of ${structure.length} tags listed (max_tags=${maxTags})`);',
    replace: "      dropped.push('structure truncated');",
    expect: 'the bound is STATED and what it dropped is LISTED',
  },
  {
    id: 'N15',
    file: 'store',
    gate: 'tools',
    protects: 'nothing is reported as dropped when nothing was',
    find: '        truncated: dropped.length > 0,',
    replace: '        truncated: true,',
    expect: 'nothing is reported as dropped when nothing was',
  },
  {
    id: 'N16',
    file: 'store',
    gate: 'tools',
    protects: 'a cycle the STORED graph really holds is named, from index.json',
    find: '    const stored = this.storedCycles();',
    replace: '    const stored = { paths: [], selfEdges: [], truncated: false, read: true };',
    expect: 'a cycle the STORED graph really holds is named',
  },
  {
    id: 'N17',
    file: 'store',
    gate: 'tools',
    protects: 'the walk FINISHES: the subtree under a stored cycle is still the whole repaired one',
    find: '      if (level > MAX_TREE_DEPTH) {\n        depthCapped = true;',
    replace: '      if (level > 1) {\n        depthCapped = true;',
    expect: 'the structure under a stored cycle is still the whole repaired subtree',
  },
  {
    id: 'N18',
    file: 'store',
    gate: 'tools',
    protects: 'two calls on an unchanged graph agree — the walk is deterministic',
    find: '    const structureShown = structure.slice(0, maxTags);',
    replace:
      '    globalThis.__navOrderFlip = !globalThis.__navOrderFlip;\n    const structureShown = globalThis.__navOrderFlip ? structure.slice(0, maxTags) : structure.slice(0, maxTags).reverse();',
    expect: 'two calls on an unchanged graph agree field for field',
  },
  {
    id: 'N19',
    file: 'store',
    gate: 'tools',
    protects: 'a navigation read writes nothing — not the index, not the policy log, not the archive',
    find: '  rootTags(options = {}) {\n    const loaded = this.loadIndex();',
    replace: '  rootTags(options = {}) {\n    const loaded = this.loadIndex();\n    if (loaded.ok) this.writeIndex(loaded.index);',
    expect: 'both navigation tools are READS',
  },
  {
    id: 'N20',
    file: 'store',
    gate: 'tools',
    protects: 'the usage instructions memory_lab_read hands a model name both navigation tools',
    find: INSTRUCTIONS_ELEMENT,
    replace: "      '(removed by the mutation harness)',",
    expect: 'the usage instructions memory_lab_read hands a model name both navigation tools',
  },
  {
    id: 'N21',
    file: 'component',
    gate: 'tools',
    protects: 'the tool that reads a subtree SAYS it is read-only before it is called',
    find: 'never mistaken for a small subtree. Read-only: it writes nothing, rebuilds nothing and judges nothing.',
    replace: 'never mistaken for a small subtree.',
    expect: 'both navigation tools say in their own description that they are read-only',
  },
  {
    id: 'N22',
    file: 'component',
    gate: 'tools',
    protects: 'the tool set is the nine, and a missing one is named rather than counted',
    find: "\n          name: 'memory_lab_root_tags',",
    replace: "\n          name: 'memory_lab_root_tags_gone',",
    expect: 'all nine memory_lab_* tools are registered',
  },
  {
    id: 'N23',
    file: 'store',
    gate: 'boundary',
    protects:
      "the NEW payload shape survives DSH's lossless-JSON boundary: the walk root's absent parent is `null`, never `undefined`",
    find: '        parent: parent ? String(parent) : null,',
    replace: '        parent: parent ? String(parent) : undefined,',
    expect: 'no dispatched value was REJECTED by the registry',
  },
  {
    id: 'N24',
    file: 'store',
    gate: 'boundary',
    protects: 'CONTROL — the boundary gate does not react to any edit in this file',
    find: '  subtagTree(input = {}) {',
    replace: '  /* CONTROL — a comment changes no behaviour and must change no verdict. */\n  subtagTree(input = {}) {',
    expect: null,
  },
  {
    id: 'N25',
    file: 'store',
    gate: 'tools',
    protects: 'CONTROL — the MemoryLab tools gate does not react to any edit in this file',
    find: '  rootTags(options = {}) {',
    replace: '  /* CONTROL — a comment changes no behaviour and must change no verdict. */\n  rootTags(options = {}) {',
    expect: null,
  },
  {
    id: 'N26',
    file: 'store',
    gate: 'tools',
    protects: 'the page repeats the store\'s own root count: roots.length and window.total are one number',
    find: '        total: rows.length,',
    replace: '        total: rows.length + 1,',
    expect: 'memory_lab_root_tags answers the roots, and answers them for the store it is reading',
  },
  {
    id: 'N27',
    file: 'store',
    gate: 'tools',
    protects: 'a root row carries NUMBERS where a caller decides from them, never an absent value',
    find: '        children: sortedUnique(toArray(node.children)).length,',
    replace: '        children: undefined,',
    expect: 'every root row carries what decides a descent',
  },
  {
    id: 'N28',
    file: 'store',
    gate: 'tools',
    protects: 'the walk really stops at MAX_TREE_DEPTH, and the cut is reported',
    find: '      if (level > MAX_TREE_DEPTH) {\n        depthCapped = true;',
    replace: '      if (level > MAX_TREE_DEPTH + 10) {\n        depthCapped = true;',
    expect: 'a chain deeper than the walk allows is CUT at the depth cap',
  },
  {
    id: 'N29',
    file: 'store',
    gate: 'tools',
    protects: 'the statistics size the subtree the caller asked about, not some other one',
    find: '      directComponents: selectedDirect.length,',
    replace: '      directComponents: 0,',
    expect: 'memory_lab_subtag_tree answers the structure, the components and the statistics of one subtree',
  },
  {
    id: 'N30',
    file: 'component',
    gate: 'tools',
    protects: 'the tag a subtree is read from is DECLARED required, so the schema refuses before the body does',
    find: "            required: ['tag'],",
    replace: '            required: [],',
    expect: 'the query, the decision list and the subtree tag are the only required parameters',
  },
  {
    id: 'N31',
    file: 'store',
    gate: 'tools',
    protects: "the stored-cycle reader's own depth bound is reported rather than silent",
    find: '      if (path.length >= MAX_DEPTH) {',
    replace: '      if (false) {',
    expect: "the stored-cycle walk's own depth bound is REPORTED",
  },
];

const selected = process.env.NM_NAV_MUTATION_IDS?.trim()
  ? new Set(process.env.NM_NAV_MUTATION_IDS.split(',').map((id) => id.trim()))
  : null;

/** The check names one gate reported as red, from wherever that gate reports them. */
function failingChecks(output, gate, scratchDir) {
  if (gate === 'boundary') {
    const receipt = join(scratchDir, 'receipt.json');
    if (fs.existsSync(receipt)) {
      const parsed = JSON.parse(fs.readFileSync(receipt, 'utf8'));
      const failed = Array.isArray(parsed.failed) ? parsed.failed.map(String) : [];
      if (failed.length) return failed;
      // A green boundary run writes a receipt with an empty `failed`; fall through to the text so
      // a harness that mis-reads the receipt cannot report a red run as green.
    }
  }
  return output
    .split('\n')
    .filter((line) => /^\s*(not ok|\[FAIL\])/.test(line))
    .map((line) => line.trim());
}

const rows = [];
for (const mutation of selected ? MUTATIONS.filter((entry) => selected.has(entry.id)) : MUTATIONS) {
  const file = FILES[mutation.file];
  const source = ORIGINAL.get(mutation.file).toString('utf8');
  const occurrences = source.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    rows.push({
      id: mutation.id,
      status: 'NO-OP',
      protects: mutation.protects,
      detail: `${occurrences} occurrence(s) of the planted text`,
    });
    console.log(`${mutation.id.padEnd(4)} NO-OP  ${occurrences} occurrence(s): ${mutation.protects}`);
    continue;
  }
  const runScratch = join(SCRATCH, mutation.id);
  fs.mkdirSync(runScratch, { recursive: true });
  let output = '';
  let exitCode = 0;
  let restored = false;
  try {
    fs.writeFileSync(file, source.replace(mutation.find, mutation.replace), 'utf8');
    const command = [GATES[mutation.gate]];
    try {
      output = execFileSync(process.execPath, command, {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 900000,
        env: mutation.gate === 'boundary' ? { ...process.env, NM_TOB_SCRATCH: runScratch } : process.env,
      });
    } catch (error) {
      exitCode = typeof error.status === 'number' ? error.status : 1;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
  } finally {
    restoreAll();
    restored = sha(fs.readFileSync(file)) === baseline[mutation.file];
  }
  /* The gate's own transcript, kept beside the verdict: a red line is evidence about the check,
   * but the PATH a rejected value is reported at is the thing a reader has to be able to see. */
  fs.writeFileSync(join(runScratch, 'gate-output.txt'), output, 'utf8');
  const red = failingChecks(output, mutation.gate, runScratch);
  const hits = mutation.expect === null ? [] : red.filter((line) => line.includes(mutation.expect));
  const status =
    mutation.expect === null
      ? red.length === 0
        ? 'GREEN (control)'
        : 'RED (control broke)'
      : hits.length > 0
        ? 'RED (named check)'
        : red.length > 0
          ? 'RED (other check)'
          : 'UNPROTECTED';
  rows.push({
    id: mutation.id,
    status,
    gate: mutation.gate,
    exitCode,
    restored,
    protects: mutation.protects,
    expected: mutation.expect,
    detail: hits[0] || red.slice(0, 2).join(' ;; ') || 'the gate stayed green',
  });
  console.log(`${mutation.id.padEnd(4)} ${status.padEnd(20)} gate=${mutation.gate.padEnd(8)} exit=${exitCode} restored=${restored}`);
  console.log(`      protects: ${mutation.protects}`);
  console.log(`      red:      ${hits[0] || red.slice(0, 2).join(' ;; ') || '(nothing — the gate stayed green)'}`);
}

console.log('\n=== the table ===');
for (const row of rows) {
  console.log(`${row.id.padEnd(4)} | ${String(row.status).padEnd(20)} | restored=${row.restored === undefined ? '-' : row.restored} | ${row.protects}`);
  if (row.detail) console.log(`     ${row.detail}`);
}
const unprotected = rows.filter((row) => row.status === 'UNPROTECTED' || row.status === 'NO-OP' || row.status === 'RED (control broke)');
const measured = rows.filter((row) => row.status === 'RED (named check)').length;
const controls = rows.filter((row) => row.status === 'GREEN (control)').length;
console.log(`\nmeasured=${measured} controls-green=${controls} unprotected=${unprotected.length}`);
fs.writeFileSync(
  join(SCRATCH, 'mutations.json'),
  JSON.stringify({ baseline, restoreVerified: rows.every((row) => row.restored !== false), rows }, null, 2),
  'utf8',
);
console.log(`receipt: ${join(SCRATCH, 'mutations.json')}`);
process.exitCode = unprotected.length === 0 ? 0 : 1;
