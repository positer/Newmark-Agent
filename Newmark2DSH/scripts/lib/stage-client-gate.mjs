/**
 * Stage a throwaway copy of the client half with the reading-pane spec wired into the gate.
 *
 * Two callers need exactly this and must not drift: the mutation runner (which mutates the
 * staged client) and the dry run (which does not). Staging is what makes a mutation run
 * safe in a tree other agents are working in — the gate a second crew is running asserts
 * that `client.js` was not rewritten mid-run, so mutating the real file would turn THEIR
 * gate red and be read as a collision.
 *
 * The stage mirrors the real layout (`<stage>/packages/...`, `<stage>/scripts/lib/...`),
 * which is why the copied gate's own `path.resolve(here, '..')` lands inside the stage and
 * nothing in it needs editing beyond the two injections below.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const realClient = path.join(workspace, 'packages', 'newmark-core', 'client.js');

/** Copy the client half plus the harness helpers into a fresh staging directory. */
export function stageTree() {
  const stage = path.join(os.tmpdir(), `newmark-mutation-stage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(stage, 'scripts', 'lib'), { recursive: true });

  /* The whole bundle is copied, not just the client half: the store these assertions read
   * is built by the REAL host half (`index.js` -> the composed components), and
   * `mount-newmark-core.mjs` imports it from `<packagesDir>/newmark-core/index.js`. Only
   * `client.js` is ever mutated — the host half is present so the store is real, not so it
   * can be changed. */
  fs.cpSync(path.join(workspace, 'packages'), path.join(stage, 'packages'), { recursive: true });
  for (const name of ['mount-newmark-core.mjs', 'detail-harness.mjs', 'preview-markdown-spec.mjs']) {
    fs.copyFileSync(path.join(workspace, 'scripts', 'lib', name), path.join(stage, 'scripts', 'lib', name));
  }

  const verifierSource = fs.readFileSync(path.join(workspace, 'scripts', 'verify-newmark-core-client.mjs'), 'utf8');
  const importLine = `import { mountSyntheticStore, renderDetailColumns } from './lib/detail-harness.mjs';`;
  const summaryLine = 'console.log(`SUMMARY passed=${passed} failed=${failed} total=${passed + failed}`);';
  if (!verifierSource.includes(importLine)) throw new Error('the gate no longer imports the detail harness — update the stager');
  if (!verifierSource.includes(summaryLine)) throw new Error('the gate no longer prints its SUMMARY line — update the stager');

  const wired = verifierSource
    .replace(importLine, `${importLine}\nimport { runPreviewMarkdownSpec } from './lib/preview-markdown-spec.mjs';`)
    /* The spec runs BEFORE the gate's own summary, so its assertions join the same tally
     * and its failures reach the same `FAILED:` line and exit code. */
    .replace(summaryLine, `await runPreviewMarkdownSpec({ check, packagesDir, clientHalf, mountSyntheticStore, renderDetailColumns });\n${summaryLine}`);
  if (wired === verifierSource) throw new Error('could not wire the spec into the staged gate');

  const verifier = path.join(stage, 'scripts', 'verify-newmark-core-client.mjs');
  fs.writeFileSync(verifier, wired);
  return {
    stage,
    verifier,
    client: path.join(stage, 'packages', 'newmark-core', 'client.js'),
    dispose() {
      fs.rmSync(stage, { recursive: true, force: true });
    },
  };
}

/** Run the staged gate and return its combined output, whether it passed or failed. */
export function runGate(staged) {
  try {
    return execFileSync(process.execPath, [staged.verifier], { cwd: staged.stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return `${error.stdout || ''}${error.stderr || ''}`;
  }
}

/** The assertion names that went red in a run. */
export function redNames(output) {
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^not ok \d+ - (.*)$/.exec(line.trim());
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * Classify a gate run.
 *
 * A run that CRASHES — an unparseable client makes the panel section's dynamic import throw
 * and the gate exits 2 after a handful of assertions — produces no `not ok` line at all. A
 * runner that only counted `not ok` lines therefore read a crashed gate as "nothing
 * failed", which is the most dangerous misreading available: a mutation that destroys the
 * module would have been reported as MISSED, or worse, as a pass. So a crash is its own
 * outcome and it always counts as CAUGHT — the gate refused to certify the tree.
 */
export function classifyRun(output) {
  const red = redNames(output);
  const summary = (output.split(/\r?\n/).find((line) => line.startsWith('SUMMARY')) || '').trim();
  const passed = /^PASS$/m.test(output);
  const reported = /^FAILED: /m.test(output);
  const crashed = summary === '' && !passed;
  return { red, summary, passed, reported, crashed };
}

/** The gate's own SUMMARY line, for a one-line verdict. */
export function summaryOf(output) {
  return (output.split(/\r?\n/).find((line) => line.startsWith('SUMMARY')) || '').trim();
}
