#!/usr/bin/env node
/**
 * measure-heartbeat-restart-barrier-mutations.mjs — prove every required case of the barrier gate
 * can actually fail.
 *
 * The rule this repo keeps re-learning: an assertion that cannot fail is not an assertion. Each
 * mutation below removes exactly the guard, the state transition or the attribution that one
 * required case exists to protect, and the barrier gate is run against the mutated bytes. A
 * mutation that does NOT turn the gate red is reported as UNPROTECTED, not as a pass.
 *
 * Restoration is by the exact bytes captured at start-up and verified with sha256, never trusted to
 * a mutation's own inverse. Two files are mutated — component.js and index.js — and every one is
 * restored in a finally block and re-hashed.
 *
 * Safety: the barrier gate never executes heartbeat_restart with broadcast=false (see its header), so
 * no mutation can make this script launch the real restart helper.
 *
 *     node Newmark2DSH/scripts/measure-heartbeat-restart-barrier-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const GATE = join(REPO, 'scripts', 'verify-heartbeat-restart-barrier.mjs');
const FILES = {
  component: join(REPO, 'packages', 'newmark-core', 'components', 'heartbeat', 'component.js'),
  index: join(REPO, 'packages', 'newmark-core', 'components', 'heartbeat', 'index.js'),
};
const SCRATCH = process.env.NM_BARRIER_MUTATIONS_SCRATCH?.trim()
  ? resolve(process.env.NM_BARRIER_MUTATIONS_SCRATCH.trim())
  : join(os.tmpdir(), 'newmark-barrier-mutations', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(SCRATCH, { recursive: true });

const originals = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, readFileSync(file)]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalSha = Object.fromEntries(Object.entries(originals).map(([key, bytes]) => [key, sha(bytes)]));

/**
 * Each mutation names the required case it is supposed to make able to fail. anchor must occur
 * exactly once in the named file; the script verifies that and reports AMBIGUOUS rather than
 * mutating a guess.
 */
const MUTATIONS = [
  { id: 'M1', file: 'component', protects: 'case 1: auto coverage IS the participant receipt',
    anchor: "ack(entry.view.sessionId, 'registered', 'auto', intent.id); return true; }",
    replacement: "return true; }" },
  { id: 'M2', file: 'component', protects: 'case 1: auto coverage queues a durable continuation per participant',
    anchor: "try { enqueue(CONTINUATION_PROMPT, entry.view.sessionId, entry.agent); ack(entry.view.sessionId, 'registered', 'auto', intent.id); return true; }",
    replacement: "try { ack(entry.view.sessionId, 'registered', 'auto', intent.id); return true; }" },
  { id: 'M3', file: 'component', protects: 'case 2 + case 5: a missing receipt aborts instead of committing',
    anchor: "if (missing.length && !(proceed && at > intent.deadline)) return abort('missing_acks');",
    replacement: "if (false) return abort('missing_acks');" },
  { id: 'M4', file: 'component', protects: 'case 3: the legacy path really prepares and restarts',
    anchor: "const prepared = await controller.prepare(installedVersion()); return this.restart(prepared.ticket);",
    replacement: "return { commit() {}, cancel() {} };" },
  { id: 'M5', file: 'component', protects: 'case 4: a none declaration is terminal',
    anchor: "const TERMINAL_ACKS = ['registered', 'none', 'closed'];",
    replacement: "const TERMINAL_ACKS = ['registered', 'closed'];" },
  { id: 'M6', file: 'component', protects: 'case 5: an ack is attributed to the host-provided caller session id only',
    anchor: "  function acknowledge(options = {}, execution) {\n    const sessionId = currentConversation(execution);",
    replacement: "  function acknowledge(options = {}, execution) {\n    const sessionId = store.read().intent?.participants.find(p => p.ack === 'pending')?.sessionId;" },
  { id: 'M7', file: 'component', protects: 'case 6: a second beginBarrier is rejected with the in-progress intent',
    anchor: "if (running) return { ok: false, phase: 'rejected', reason: 'intent_in_progress', intentId: running.id, progress: progressOf(running) };",
    replacement: "if (running && false) return { ok: false, phase: 'rejected', reason: 'intent_in_progress', intentId: running.id, progress: progressOf(running) };" },
  { id: 'M8', file: 'component', protects: 'case 7: the requester must have registered its own continuation',
    anchor: "if (!requester || requester.ack !== 'registered') return abort('requester_not_registered');",
    replacement: "if (false) return abort('requester_not_registered');" },
  { id: 'M9', file: 'component', protects: 'case 8: a commit after the deadline aborts',
    anchor: "if (at > intent.deadline && !proceed) return abort('deadline_exceeded');",
    replacement: "if (false) return abort('deadline_exceeded');" },
  { id: 'M10', file: 'component', protects: 'case 9: a pending participant that closed is marked closed',
    anchor: "if (!alive.has(participant.sessionId) && !TERMINAL_ACKS.includes(participant.ack)) ack(participant.sessionId, 'closed', 'liveness', intent.id);",
    replacement: "if (false) ack(participant.sessionId, 'closed', 'liveness', intent.id);" },
  { id: 'M11', file: 'component', protects: 'case 10 + case 12: committing -> committed needs a changed owner (and a wait is not a failure)',
    anchor: "if (owner.path !== job.owner.path || owner.created === job.owner.created) return;",
    replacement: "if (owner.path !== job.owner.path || owner.created !== job.owner.created) return;" },
  { id: 'M12', file: 'component', protects: 'case 10: a leftover preparing intent from another pid becomes interrupted',
    anchor: "if (intent.requesterPid !== pid) {",
    replacement: "if (false) {" },
  { id: 'M13', file: 'component', protects: 'failure mode: an unnotifiable session is recorded unreachable',
    anchor: "} catch (error) { ack(entry.view.sessionId, 'unreachable', 'notify', intent.id); note(entry.view.sessionId, 'notify:' + String(error.message), intent.id); return false; }",
    replacement: "} catch (error) { return true; }" },
  { id: 'M14', file: 'index', protects: 'case 3: broadcast=false is the legacy branch of the wrapper',
    anchor: "if (a.broadcast !== true) {",
    replacement: "if (a.broadcast === true) {" },
  { id: 'M15', file: 'index', protects: 'tool surface: the heartbeat tools are registered',
    anchor: "name: 'heartbeat_restart_ack'",
    replacement: "name: 'heartbeat_restart_ack_typo'" },
  { id: 'M16', file: 'index', protects: 'tool surface: broadcast=true opens the barrier rather than faking a phase',
    anchor: "return beat.beginBarrier(a, execution);",
    replacement: "return { ok: true, phase: 'preparing' };" },
  /* --- the cancel tail (case 11) --- */
  { id: 'M17', file: 'component', protects: 'case 11: only the requester may cancel (a stranger is refused)',
    anchor: "    if (intent.requesterSessionId !== requesterSessionId) return { ok: false, phase: 'refused', reason: 'not_requester', intentId: intent.id, missing: pendingOf(intent) };",
    replacement: "    if (false) return { ok: false, phase: 'refused', reason: 'not_requester', intentId: intent.id, missing: pendingOf(intent) };" },
  { id: 'M18', file: 'component', protects: 'case 11: the cancel really closes the intent (preparing -> aborted(cancelled) on disk)',
    anchor: "    const closed = finishIntent('cancelled', 'aborted');",
    replacement: "    const closed = { ...intent, phase: 'aborted', abortReason: 'cancelled', closedAt: now(), updatedAt: now() };" },
  { id: 'M19', file: 'component', protects: 'case 11: the requester is actually notified (durably, not just reported as notified)',
    anchor: "    const notified = await notifyCancelled(closed);",
    replacement: "    const notified = 'sent';" },
  { id: 'M20', file: 'component', protects: 'case 11: a cancelled/closed intentId cannot spend the live barrier',
    anchor: "    if (wanted && intent.id !== wanted) return { ok: false, phase: 'aborted', intentId: wanted, reason: 'intent_mismatch', missing: [] };",
    replacement: "    if (false) return { ok: false, phase: 'aborted', intentId: wanted, reason: 'intent_mismatch', missing: [] };" },
  { id: 'M21', file: 'index', protects: 'tool surface: the cancel tool is registered',
    anchor: "name: 'heartbeat_restart_cancel'",
    replacement: "name: 'heartbeat_restart_cancel_typo'" },
  /* --- the failed-armed termination tail (case 12) --- */
  { id: 'M22', file: 'component', protects: 'case 12: the chosen N (one failure is not terminal, N failures are)',
    anchor: "export const DELIVERY_FAILURE_LIMIT = 3;",
    replacement: "export const DELIVERY_FAILURE_LIMIT = 1;" },
  { id: 'M23', file: 'component', protects: 'case 12: a task that keeps failing is terminated, not left armed',
    anchor: "            if (attempts >= DELIVERY_FAILURE_LIMIT) { terminateTask(task, reason, attempts); return; }",
    replacement: "            if (false) { terminateTask(task, reason, attempts); return; }" },
  { id: 'M24', file: 'component', protects: 'case 12: the helper reporting failed is a FAILURE, not a wait',
    anchor: "            if (status.state === 'failed') { fail(Error(status.detail || '重启辅助程序报告失败')); continue; }",
    replacement: "            if (false) { fail(Error(status.detail || '重启辅助程序报告失败')); continue; }" },
  { id: 'M25', file: 'component', protects: 'case 12: termination sweeps the executable record out of tasks',
    anchor: "      s.tasks = s.tasks.filter(t => t.id !== task.id);",
    replacement: "      void task.id;" },
  { id: 'M26', file: 'component', protects: 'case 12: a task that succeeds is never terminated',
    anchor: "            store.change(s => {s.receipts ||= [];if(!s.receipts.some(r=>r.id===task.id))s.receipts.push({id:task.id,delivered:Date.now()});s.tasks=s.tasks.filter(t=>t.id!==task.id);s.schema=3;});",
    replacement: "            store.change(s => {s.receipts ||= [];if(!s.receipts.some(r=>r.id===task.id))s.receipts.push({id:task.id,delivered:Date.now()});s.terminated ||= [];s.terminated.push({id:task.id,status:TERMINATED_STATUS,reason:'mutation',attempts:99,destination:task.destination,terminated:Date.now()});s.tasks=s.tasks.filter(t=>t.id!==task.id);s.schema=3;});" },
  { id: 'M27', file: 'component', protects: 'case 12: a task waiting for the new process is not deliverable, and that wait is not a failure',
    anchor: "            if (owner.path !== job.owner.path || owner.created === job.owner.created) continue;",
    replacement: "            if (false) continue;" },
  { id: 'M28', file: 'component', protects: 'case 12: the status the component reports actually SHOWS the termination',
    anchor: "    return { ...state, tasks: state.tasks || [], receipts: state.receipts || [], terminated: state.terminated || [] };",
    replacement: "    return { ...state, tasks: state.tasks || [], receipts: state.receipts || [], terminated: [] };" },
  { id: 'M29', file: 'component', protects: 'case 13: the running predicate is the host own status field',
    anchor: "  const looksBusy = agent => agent?.status === 'running';",
    replacement: "  const looksBusy = agent => agent?.running === true || agent?.session?.running === true;" },
  { id: 'M30', file: 'component', protects: 'case 13: the participant set is narrowed to confirmed-running conversations',
    anchor: "    const participants = live.filter(entry => wokenByBarrier(entry, requesterSessionId));",
    replacement: "    const participants = live;" },
  { id: 'M31', file: 'component', protects: 'case 14: the update restart continues ONLY conversations confirmed to be running',
    anchor: "          if (!wokenByUpdate(entry)) continue;",
    replacement: "          if (false) continue;" },
  { id: 'M32', file: 'component', protects: 'case 14: the update restart really queues a continuation for an in-flight conversation',
    anchor: "          try { enqueue(CONTINUATION_PROMPT, entry.view.sessionId, entry.agent); continued.push(entry.view.sessionId); }",
    replacement: "          try { continued.push(entry.view.sessionId); }" },
  { id: 'M33', file: 'component', protects: 'case 15: the continuation bounds its goal advice to what the host actually allows',
    anchor: '调用 goal_restore 补一次',
    replacement: '先了解目标状态' },
  { id: 'M34', file: 'component', protects: 'case 16: a paused conversation is never woken by a restart',
    anchor: "  const pausedByUser = agent => { try { return goals?.()?.get?.(agent)?.phase === 'paused'; } catch { return false; } };",
    replacement: "  const pausedByUser = agent => false;" },
];

/** One gate run. The gate's own verdict is its summary line and its not-ok lines, not the exit code alone. */
function runGate() {
  let out = '';
  let code = 0;
  let timedOut = false;
  try {
    out = execFileSync('node', [GATE], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: REPO, timeout: 120000 });
  } catch (error) {
    out = String(error.stdout || '') + String(error.stderr || '');
    code = typeof error.status === 'number' ? error.status : -1;
    timedOut = error.killed === true || error.signal === 'SIGTERM';
  }
  const summary = /Barrier: (\d+)\/(\d+) passed/.exec(out);
  const failed = out.split(/\r?\n/).filter(line => line.startsWith('not ok ')).map(line => line.trim());
  return {
    exitCode: code,
    timedOut,
    passed: summary ? Number(summary[1]) : null,
    failedCount: summary ? Number(summary[2]) - Number(summary[1]) : null,
    failed,
  };
}

const report = {
  gate: GATE,
  files: Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, { file, sha256: originalSha[key], bytes: originals[key].length }])),
  startedAt: new Date().toISOString(),
  baseline: null,
  mutations: [],
  unprotected: [],
};

console.log('heartBeat restart-barrier mutations');
for (const [key, file] of Object.entries(FILES)) console.log('file ' + key + ':  ' + file);
console.log('gate:  ' + GATE);
console.log('scratch: ' + SCRATCH + '\n');

console.log('--- baseline (unmutated) ---');
report.baseline = runGate();
console.log('    ' + report.baseline.passed + '/' + (report.baseline.passed + report.baseline.failedCount) + ' passed, ' + report.baseline.failedCount + ' failed (exit ' + report.baseline.exitCode + ')');
if (report.baseline.failedCount !== 0) {
  console.log('    the baseline is not green; the mutation table would be meaningless. Stopping.');
  writeFileSync(join(SCRATCH, 'report.json'), JSON.stringify(report, null, 2));
  process.exit(2);
}

for (const mutation of MUTATIONS) {
  const original = originals[mutation.file].toString('utf8');
  const file = FILES[mutation.file];
  const occurrences = original.split(mutation.anchor).length - 1;
  console.log('\n--- ' + mutation.id + ' [' + mutation.file + ']: ' + mutation.protects);
  if (occurrences !== 1) {
    console.log('    AMBIGUOUS: the anchor occurs ' + occurrences + ' time(s); nothing was measured.');
    report.mutations.push({ id: mutation.id, file: mutation.file, protects: mutation.protects, ambiguous: occurrences });
    report.unprotected.push({ id: mutation.id, file: mutation.file, reason: 'anchor occurs ' + occurrences + ' time(s)' });
    continue;
  }
  const mutatedText = original.replace(mutation.anchor, mutation.replacement);
  const mutatedBytes = Buffer.from(mutatedText, 'utf8');
  const mutatedSha = sha(mutatedBytes);
  writeFileSync(file, mutatedBytes);
  let run;
  let restoredSha = null;
  try {
    run = runGate();
  } finally {
    writeFileSync(file, originals[mutation.file]);
    restoredSha = sha(readFileSync(file));
  }
  const caught = run.failedCount !== null && run.failedCount > 0;
  console.log('    planted sha256 ' + mutatedSha + '  (' + mutatedBytes.length + ' B)');
  console.log('    gate: ' + run.passed + '/' + (run.failedCount === null ? '?' : run.passed + run.failedCount) + ' passed, ' + run.failedCount + ' failed (exit ' + run.exitCode + (run.timedOut ? ', TIMED OUT' : '') + ')');
  console.log('    restored sha256 ' + restoredSha + '  byte-for-byte=' + (restoredSha === originalSha[mutation.file]));
  if (caught) {
    for (const name of run.failed) console.log('      red: ' + name);
  } else {
    console.log('    UNPROTECTED: the gate stayed green under this mutation, so that assertion cannot fail.');
    report.unprotected.push({ id: mutation.id, file: mutation.file, reason: 'gate stayed green' });
  }
  if (restoredSha !== originalSha[mutation.file]) {
    console.log('    !! RESTORE FAILED for ' + file + ' — sha256 ' + restoredSha);
    report.mutations.push({ id: mutation.id, file: mutation.file, protects: mutation.protects, caught, mutatedSha, restoredSha, run, restoreFailed: true });
    report.unprotected.push({ id: mutation.id, file: mutation.file, reason: 'restore failed' });
    break;
  }
  report.mutations.push({ id: mutation.id, file: mutation.file, protects: mutation.protects, caught, mutatedSha, restoredSha, run });
}

console.log('\n--- final confirmation (unmutated) ---');
const finalRun = runGate();
const finalSha = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, sha(readFileSync(file))]));
const allRestored = Object.entries(finalSha).every(([key, value]) => value === originalSha[key]);
console.log('    ' + finalRun.passed + '/' + (finalRun.passed + finalRun.failedCount) + ' passed, ' + finalRun.failedCount + ' failed (exit ' + finalRun.exitCode + ')');
for (const [key, value] of Object.entries(finalSha)) console.log('    ' + key + ' sha256 ' + value + '  byte-for-byte-original=' + (value === originalSha[key]));
report.final = { ...finalRun, sha256: finalSha, byteForByteOriginal: allRestored };
report.finishedAt = new Date().toISOString();
writeFileSync(join(SCRATCH, 'report.json'), JSON.stringify(report, null, 2));

console.log('\n=== MUTATION TABLE ===');
for (const entry of report.mutations) {
  const verdict = entry.ambiguous !== undefined ? 'AMBIGUOUS' : entry.caught ? 'RED (caught)' : 'GREEN (UNPROTECTED)';
  const firstRed = entry.caught ? (entry.run.failed[0] || '').slice(0, 70) : '';
  console.log('  ' + entry.id.padEnd(4) + verdict.padEnd(18) + firstRed);
}
const detected = report.mutations.filter(entry => entry.caught === true).length;
console.log('\nunprotected: ' + (report.unprotected.length === 0 ? 'none' : report.unprotected.map(entry => entry.id).join(', ')));
console.log('receipt: ' + join(SCRATCH, 'report.json'));
console.log('Mutations: ' + detected + '/' + MUTATIONS.length + ' detected');
process.exit(detected === MUTATIONS.length && report.unprotected.length === 0 && allRestored && finalRun.failedCount === 0 ? 0 : 1);
