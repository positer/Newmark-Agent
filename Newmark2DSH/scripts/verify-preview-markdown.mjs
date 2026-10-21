/**
 * The reading pane's Markdown/LaTeX assertions, runnable on their own against the live tree.
 *
 * The same block the client gate calls — `lib/preview-markdown-spec.mjs` — driven here with
 * the real `packages/` directory and the real `client.js`, so it can be run without editing
 * `verify-newmark-core-client.mjs`. That file is the one shared resource in this change, and
 * wiring the spec into it is a one-line import plus a one-line call:
 *
 *   import { runPreviewMarkdownSpec } from './lib/preview-markdown-spec.mjs';
 *   …
 *   await runPreviewMarkdownSpec({ check, packagesDir, clientHalf, mountSyntheticStore, renderDetailColumns });
 *
 * placed immediately before the gate's own `SUMMARY` line, so these assertions join its
 * tally and its exit code.
 *
 * Run: node Newmark2DSH/scripts/verify-preview-markdown.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountSyntheticStore, renderDetailColumns } from './lib/detail-harness.mjs';
import { runPreviewMarkdownSpec } from './lib/preview-markdown-spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..');
const clientHalf = path.join(workspace, 'packages', 'newmark-core', 'client.js');
const packagesDir = path.join(workspace, 'packages');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  const number = passed + failed + 1;
  if (condition) {
    passed += 1;
    console.log(`ok ${number} - ${name}`);
    return true;
  }
  failed += 1;
  failures.push(name);
  console.log(`not ok ${number} - ${name}`);
  if (detail !== undefined) console.log(`  ${detail}`);
  return false;
}

console.log('# the reading pane renders Markdown and LaTeX');
console.log('');
await runPreviewMarkdownSpec({ check, packagesDir, clientHalf, mountSyntheticStore, renderDetailColumns });
console.log('');
console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);
if (failed > 0) {
  console.log(`FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
