/**
 * Plant a mutation, confirm red, restore byte-for-byte, confirm green — the mutation table.
 *
 * Nothing here edits a shared file. It stages a copy of the client half, mutates the COPY,
 * and runs the real gate against it. That is not a convenience: a mutation run mutates the
 * exact file a second crew is currently hashing — their gate asserts `client.js` was not
 * rewritten mid-run — so mutating the real file would turn THEIR gate red and be read as a
 * collision.
 *
 * Every restore is proved by sha256 against the staged baseline, and every mutation must
 * turn at least one assertion red BY NAME. A mutation nothing catches is reported MISSED,
 * which is the finding this whole exercise exists to produce.
 *
 * Run: node Newmark2DSH/scripts/probe/probe-preview-markdown-mutations.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { classifyRun, realClient, runGate, stageTree } from '../lib/stage-client-gate.mjs';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * The mutations, each naming the property it destroys.
 *
 * `old` is matched literally and must occur exactly once — a mutation that cannot be
 * applied is reported UNAPPLIED rather than silently skipped, for the same reason the gate
 * refuses a check that cannot run.
 */
const MUTATIONS = [
  {
    id: 'M1',
    name: 'the render path is removed, so the pane always prints the body',
    old: `      if (MarkdownText) {
        return h(
          'div',
          { className: 'ml-preview-doc' },
          h(MarkdownText, { text: body, labels: PREVIEW_MARKDOWN_LABELS, variant: 'compact' }),
        );
      }
`,
    new: '',
  },
  {
    id: 'M2',
    name: 'the labels argument is dropped, so the renderer receives undefined',
    old: `h(MarkdownText, { text: body, labels: PREVIEW_MARKDOWN_LABELS, variant: 'compact' })`,
    new: `h(MarkdownText, { text: body, variant: 'compact' })`,
  },
  {
    id: 'M3',
    name: 'the footnotes key is dropped, which renderFootnoteSection reads unguarded',
    old: `      footnotes: '脚注',\n`,
    new: '',
  },
  {
    id: 'M4',
    name: 'code.toolbarLabels is dropped, which renderCode reads unguarded',
    old: `        toolbarLabels: Object.freeze({ codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消自动换行' }),\n`,
    new: '',
  },
  {
    id: 'M5',
    name: 'the labels literal is spread into a fresh object on every render',
    /* The mutation the identity property is actually about, and it has to be a VALID one:
     * the first version of this entry rewrote `Object.freeze({` to `(({`, which does not
     * even parse — the whole gate stayed green on an unparseable client, and the entry was
     * measuring nothing. This one keeps the module-level frozen constant intact (so the
     * source regex still matches) and builds a new object at the call site, which is the
     * defect that discards the renderer's memo. */
    old: `h(MarkdownText, { text: body, labels: PREVIEW_MARKDOWN_LABELS, variant: 'compact' })`,
    new: `h(MarkdownText, { text: body, labels: { code: { copyLabel: PREVIEW_MARKDOWN_LABELS.code.copyLabel, copiedLabel: PREVIEW_MARKDOWN_LABELS.code.copiedLabel, toolbarLabels: PREVIEW_MARKDOWN_LABELS.code.toolbarLabels }, footnotes: PREVIEW_MARKDOWN_LABELS.footnotes }, variant: 'compact' })`,
  },
  {
    id: 'M5b',
    name: 'the client half is left unparseable, which no other assertion notices',
    old: `      return h('pre', null, body);`,
    new: `      return h('pre', null, body;`,
  },
  {
    id: 'M6',
    name: 'the pane asks for the document variant instead of the compact one',
    old: `variant: 'compact'`,
    new: `variant: 'body'`,
  },
  {
    id: 'M7',
    name: 'the fallback is removed, so a shell without the renderer shows nothing',
    old: `      return h('pre', null, body);`,
    new: `      return null;`,
  },
  {
    id: 'M8',
    name: 'the document container loses min-width: 0, so a wide body can widen the row',
    old: `.ml-preview-doc { min-width: 0; }`,
    new: `.ml-preview-doc { }`,
  },
];

/* ------------------------------------------------------------------ staging */

const staged = stageTree();
const baselineSha = sha(staged.client);
console.log(`stage: ${staged.stage}`);
console.log(`staged client sha256: ${baselineSha}`);
console.log(`real client sha256:   ${sha(realClient)}`);
console.log('');

const baselineOut = runGate(staged);
const baseline = classifyRun(baselineOut);
console.log(`BASELINE: ${baseline.summary || '(no summary — the gate crashed)'} ${baseline.passed ? '(green)' : '(RED)'}`);
if (!baseline.passed || baseline.red.length > 0) {
  console.log('the unmutated stage is not green, so no mutation result would mean anything:');
  for (const name of baseline.red) console.log(`  not ok - ${name}`);
  staged.dispose();
  process.exit(1);
}
console.log('');

/* ------------------------------------------------------------------ the table */

const rows = [];
for (const mutation of MUTATIONS) {
  const source = fs.readFileSync(staged.client, 'utf8');
  const occurrences = source.split(mutation.old).length - 1;
  if (occurrences !== 1) {
    rows.push({ id: mutation.id, name: mutation.name, outcome: `UNAPPLIED (${occurrences} matches)`, red: [], restored: null, greenAfter: null });
    console.log(`${mutation.id}: UNAPPLIED — the literal matched ${occurrences} time(s), expected exactly 1`);
    continue;
  }

  fs.writeFileSync(staged.client, source.replace(mutation.old, mutation.new));
  const mutatedSha = sha(staged.client);
  const run = classifyRun(runGate(staged));
  /* A crash is CAUGHT, not missed: the gate refused to certify the tree. Counting only
   * `not ok` lines would have reported the unparseable-client mutation as MISSED, because
   * the import throws before any assertion can record a failure. */
  const caught = run.red.length > 0 || run.crashed || run.reported;

  /* Restore from the real file, then PROVE the restore by hash before trusting the
   * "green again" run — a restore that quietly produced different bytes would make the
   * whole table a measurement of something else. */
  fs.copyFileSync(realClient, staged.client);
  const restoredSha = sha(staged.client);
  if (restoredSha !== baselineSha) {
    console.error(`${mutation.id}: restore did NOT reproduce the baseline bytes (${restoredSha} != ${baselineSha})`);
    staged.dispose();
    process.exit(2);
  }
  const reRun = classifyRun(runGate(staged));

  rows.push({
    id: mutation.id,
    name: mutation.name,
    outcome: caught ? 'RED' : 'MISSED',
    red: run.red,
    crashed: run.crashed,
    restored: true,
    greenAfter: reRun.passed && reRun.red.length === 0,
    mutatedSha: mutatedSha.slice(0, 12),
  });
  console.log(`${mutation.id}: ${caught ? 'RED' : 'MISSED'} — ${run.red.length} assertion(s) failed${run.crashed ? ', and the gate crashed before reporting' : ''} (mutated sha ${mutatedSha.slice(0, 12)})`);
  for (const name of run.red) console.log(`     not ok - ${name}`);
  if (run.crashed) console.log('     the gate exited without a SUMMARY — it refused to certify the tree');
  console.log(`     restored sha256 == baseline: ${restoredSha === baselineSha} | green after restore: ${reRun.passed && reRun.red.length === 0}`);
}

/* ------------------------------------------------------------------ report */

console.log('');
console.log('| id | mutation | outcome | assertion(s) that failed | restored | green after |');
console.log('|----|----------|---------|--------------------------|----------|-------------|');
for (const row of rows) {
  const red = row.red.length ? row.red.map((name) => `"${name}"`).join('<br>') : (row.crashed ? '*the gate crashed before reporting*' : '—');
  console.log(`| ${row.id} | ${row.name} | ${row.outcome} | ${red} | ${row.restored ? 'yes' : 'n/a'} | ${row.greenAfter ? 'yes' : row.greenAfter === null ? 'n/a' : 'NO'} |`);
}

const missed = rows.filter((row) => row.outcome !== 'RED');
console.log('');
console.log(`mutations: ${rows.length}, caught: ${rows.length - missed.length}, missed or unapplied: ${missed.length}`);
if (missed.length > 0) {
  console.log('MISSED/UNAPPLIED:');
  for (const row of missed) console.log(`  ${row.id} — ${row.name} — ${row.outcome}`);
}
staged.dispose();
process.exit(missed.length === 0 ? 0 : 1);
