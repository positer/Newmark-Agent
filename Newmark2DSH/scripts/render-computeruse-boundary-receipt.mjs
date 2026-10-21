#!/usr/bin/env node
/** Render the newest boundary-probe receipt as the report's per-tool tables. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const dirs = readdirSync(root)
  .filter((name) => {
    try { return statSync(join(root, name, 'receipt.json')).isFile(); } catch { return false; }
  })
  .sort();
const dir = dirs[dirs.length - 1];
const r = JSON.parse(readFileSync(join(root, dir, 'receipt.json'), 'utf8'));

const pad = (value, width) => String(value === null || value === undefined ? '-' : value).padEnd(width);
console.log(`receipt: ${dir}   passed=${r.passed} failed=${r.failed.length}`);

for (const phase of ['real', 'stub']) {
  const rows = r.dispatches.filter((d) => d.phase === phase);
  if (rows.length === 0) continue;
  console.log(`\n=== ${phase.toUpperCase()} (${rows.length} dispatches) ===`);
  console.log('tool            action          registryErr  errorCode                    toolOk  toolErrorCode');
  for (const d of rows) {
    console.log(
      `${pad(d.tool, 15)} ${pad(d.action, 15)} ${pad(d.isError, 12)} ${pad(d.errorCode || '-', 28)} ${pad(d.toolOk, 7)} ${d.toolErrorCode || ''}`,
    );
  }
}

console.log('\n=== the flagged sites ===');
for (const row of r.results) {
  if (/win32\.js:/.test(row.name)) console.log(`  ${row.ok ? 'PASS' : 'FAIL'}  ${row.name}\n        ${row.detail}`);
}

console.log(`\n=== undefined-valued paths handed to JSON.stringify: ${r.undefinedPathsSeenByStringify.length} ===`);
for (const p of r.undefinedPathsSeenByStringify) console.log(`  ${p}`);
console.log(`\nlane calls served by the fixture: ${r.laneCalls}; spawns: ${r.spawns.length}; overlay starts: ${r.overlayStarts}`);
console.log('\n=== sources measured (sha256) ===');
for (const f of r.sourceFacts) console.log(`  ${f.sha256}  ${f.file}`);
