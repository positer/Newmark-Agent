// Mutation proof for verify-desktop-pet-render.mjs.
//
// Each mutation is planted into the product source (components/computeruse/lib/desktop-pet.cs),
// the gate is run against the planted build, and the gate must go RED on the NAMED assertion the
// mutation targets. The original bytes are then written back and the restore is verified by
// sha256, so a run leaves the tree byte-identical to how it found it even when the gate throws.
//
// A mutation the gate does NOT detect is reported as "unprotected" and makes this script exit 1:
// an assertion that cannot be reddened by the defect it claims to guard is not a gate.
//
// Usage: node Newmark2DSH/scripts/measure-desktop-pet-render-mutations.mjs [scratchDir]
// Env:   NM_PET_RENDER_MUTATIONS_SCRATCH overrides the scratch directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const target = path.join(repo, 'packages/newmark-core/components/computeruse/lib/desktop-pet.cs');
const gate = path.join(here, 'verify-desktop-pet-render.mjs');
const pkg = path.join(repo, 'packages/newmark-core');
const scratch = path.resolve(process.argv[2] || process.env.NM_PET_RENDER_MUTATIONS_SCRATCH || path.join(os.tmpdir(), 'pet-render-mutations'));
fs.mkdirSync(scratch, { recursive: true });

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const original = fs.readFileSync(target);
const originalSha = sha256(original);

/* Each entry names the assertion it must redden. The find string must occur exactly once. */
const mutations = [
  {
    id: 'M1-drop-the-keep-alive-present',
    guards: 'companion_idle_keeps_redrawing',
    why: 'removes the 1 Hz re-present from Tick, restoring the defect exactly: an idle companion pet stops re-presenting, so one bad surface can never be replaced',
    find: '            // (measured: an opaque white rect persisting for minutes). Re-present from the\n            // untouched source pixels on the same one-second cadence.\n            Render();',
    replace: '            // (measured: an opaque white rect persisting for minutes).'
  },
  {
    id: 'M2-present-the-measured-white-plate',
    guards: 'no_opaque_white_plate,transparent_corner_matches_the_desktop',
    why: 'presents an opaque white surface with NO sprite - the defect exactly as it was measured on this host (27234/27234 and 97682/97682 pixels at luma 255, body invisible)',
    find: '        var g=surface.Graphics;g.Clear(Color.Transparent);g.DrawImage(painted,new RectangleF((Width-w)/2,(float)(Height-padding)-h,w,h));g.Flush(FlushIntention.Sync);',
    replace: '        var g=surface.Graphics;g.Clear(Color.White);g.Flush(FlushIntention.Sync);'
  },
  {
    id: 'M3-opaque-padding-sprite-still-drawn',
    guards: 'transparent_corner_matches_the_desktop,transparent_background_preserved',
    why: 'makes the padding opaque white while still drawing the sprite: measured pure255Ratio lands near 0.5, below the white-plate criterion, so this case is what proves the two PIXEL-level assertions are doing work the pixel-ratio assertion cannot',
    find: '        var g=surface.Graphics;g.Clear(Color.Transparent);g.DrawImage(painted,new RectangleF((Width-w)/2,(float)(Height-padding)-h,w,h));g.Flush(FlushIntention.Sync);',
    replace: '        var g=surface.Graphics;g.Clear(Color.White);g.DrawImage(painted,new RectangleF((Width-w)/2,(float)(Height-padding)-h,w,h));g.Flush(FlushIntention.Sync);'
  }
];

function runGate(evidenceDirectory) {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const run = spawnSync(process.execPath, [gate, evidenceDirectory, pkg], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const output = (run.stdout || '') + (run.stderr || '');
  const failed = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('FAIL ')) failed.push(line.slice(5).split(' ')[0]);
  }
  const tally = (output.match(/(\d+)\/(\d+) passed/) || [])[0] || '';
  return { status: run.status, failed, tally, output };
}

const report = { target, originalSha256: originalSha, mutations: [], verdict: 'pending' };

try {
  const planted = mutations.map(mutation => {
    const text = original.toString('utf8');
    const occurrences = text.split(mutation.find).length - 1;
    if (occurrences !== 1) throw new Error(mutation.id + ': find string occurs ' + occurrences + ' times, expected exactly 1');
    const mutated = Buffer.from(text.replace(mutation.find, mutation.replace), 'utf8');
    if (sha256(mutated) === originalSha) throw new Error(mutation.id + ': mutation changed nothing');
    return { mutation, mutated };
  });

  for (const { mutation, mutated } of planted) {
    fs.writeFileSync(target, mutated);
    const plantedSha = sha256(fs.readFileSync(target));
    let run;
    try {
      run = runGate(path.join(scratch, mutation.id));
    } finally {
      fs.writeFileSync(target, original);
    }
    const restoredSha = sha256(fs.readFileSync(target));
    if (restoredSha !== originalSha) throw new Error(mutation.id + ': RESTORE FAILED (sha ' + restoredSha + ')');
    const expected = mutation.guards.split(',');
    const undetected = expected.filter(name => !run.failed.includes(name));
    const entry = {
      id: mutation.id, guards: expected, why: mutation.why,
      plantedSha256: plantedSha, restoredSha256: restoredSha,
      gateExit: run.status, gateTally: run.tally, failedChecks: run.failed,
      detected: undetected.length === 0, undetected,
      evidence: (run.output.match(/^FAIL .*/gm) || []).slice(0, 8)
    };
    report.mutations.push(entry);
    console.log((entry.detected ? 'DETECTED  ' : 'UNPROTECTED  ') + mutation.id + '  exit=' + run.status + '  ' + run.tally);
    console.log('   guards: ' + expected.join(', '));
    console.log('   reddened: ' + (run.failed.length ? run.failed.join(', ') : '(nothing)'));
    console.log('   planted=' + plantedSha.slice(0, 16) + ' restored=' + restoredSha.slice(0, 16) + ' restoreOk=' + (restoredSha === originalSha));
  }

  const unprotected = report.mutations.filter(entry => !entry.detected).map(entry => ({ id: entry.id, undetected: entry.undetected }));
  report.unprotected = unprotected;
  report.verdict = unprotected.length === 0 ? 'every mutation was detected; every file restored' : 'UNPROTECTED MUTATIONS PRESENT';
  console.log('');
  console.log('restore sha256 == original (' + originalSha.slice(0, 16) + '): ' + (sha256(fs.readFileSync(target)) === originalSha));
  console.log('verdict: ' + report.verdict);
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  console.log('report: ' + path.join(scratch, 'report.json'));
  process.exitCode = unprotected.length === 0 ? 0 : 1;
} catch (error) {
  fs.writeFileSync(target, original);
  const restoredSha = sha256(fs.readFileSync(target));
  report.verdict = 'aborted: ' + error.message;
  report.restoredSha256 = restoredSha;
  console.error('aborted: ' + error.message);
  console.error('restore sha256 == original: ' + (restoredSha === originalSha));
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'report.json'), JSON.stringify(report, null, 2));
  process.exitCode = 1;
}
