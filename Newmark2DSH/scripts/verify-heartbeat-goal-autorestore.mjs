/**
 * verify-heartbeat-goal-autorestore — the restart re-arms goals itself, without a model turn.
 *
 * The host keeps a goal's durable phase but its continuation authority (activation) is
 * PROCESS-local: dsh-goal starts every process disarmed, and the session-start edge publishes
 * 'disarmed', so a goal that was running stops being continued by dsh-goal-round-driver
 * (phase==='active' && activation==='armed') until something calls goals.resume(agent, ref).
 * The host's tool cannot: update_goal{action:'resume'} requires a direct human turn. So the
 * restart snapshots what was running and re-arms it once the new process has the agents back.
 *
 * This gate drives that whole story through the component: a pre-restart globalRestart(), then a
 * SECOND instance on the same root (the new process) whose host has disarmed everything. It checks
 * the four cases that must not be confused - active is re-armed, paused stays paused, blocked stays
 * blocked (the service WOULD resume it, which is exactly why the component must not ask), and an
 * agent that never came back is reported instead of retried forever.
 *
 * Run: node scripts/verify-heartbeat-goal-autorestore.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHeartBeat } from '../packages/newmark-core/components/heartbeat/component.js';

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });

/** One fake goals service per process, keyed by session id, recording every mutation. */
function fakeGoals(seed = {}) {
  const state = new Map(Object.entries(seed).map(([id, goal]) => [id, goal ? { ...goal } : null]));
  const calls = [];
  const service = {
    calls,
    seed: state,
    get(agent) {
      const id = agent?.session?.id;
      const goal = state.get(id);
      return goal ? { ...goal } : undefined;
    },
    resume(agent, ref) {
      const id = agent?.session?.id;
      calls.push({ op: 'resume', sessionId: id, ref });
      const goal = state.get(id);
      if (!goal) throw Error('no current goal');
      if (ref && (ref.id !== goal.id || ref.revision !== goal.revision)) throw Error('stale goal ref');
      if (goal.exhausted) throw Error('goal exhausted ' + goal.maxGoalRounds + ' goal rounds');
      if (goal.phase === 'active' && goal.activation === 'armed') throw Error('already active and armed');
      state.set(id, { ...goal, phase: 'active', activation: 'armed', revision: goal.revision + 1 });
    },
    edit() { calls.push({ op: 'edit' }); throw Error('edit must never be called'); },
    create() { calls.push({ op: 'create' }); throw Error('create must never be called'); },
    block() { calls.push({ op: 'block' }); throw Error('block must never be called'); },
    pause() { calls.push({ op: 'pause' }); throw Error('pause must never be called'); },
  };
  return service;
}

/** The agents service the component reads: roots() is the live set. */
function fakeAgents(sessions) {
  const agents = sessions.map((spec) => ({
    id: spec.id,
    status: spec.running ? 'running' : 'idle',
    session: { id: spec.id, title: spec.title || null },
  }));
  return { roots: () => agents, byId: () => agents, list: agents };
}

const ctors = [];
function beatOn(root, { agents, goals }) {
  const beat = createHeartBeat({
    root,
    core: () => null,
    agents: () => agents,
    goals: () => goals,
    controller: {
      prepare: async () => ({ ticket: 'fixture-ticket' }),
      restart: async () => ({ folder: path.join(root, 'helper'), commit() {}, cancel() {} }),
    },
    probe: async () => ({ path: 'fixture', created: 1 }),
    pid: 1000 + ctors.length,
    version: '0.0.0-fixture',
    logger: { warn() {}, info() {}, error() {} },
    now: () => 1793120000000,
  });
  ctors.push(beat);
  return beat;
}

const goal = (over) => ({ id: 'goal-' + (over.id || 'x'), revision: 7, phase: 'active', activation: 'armed', roundsStarted: 2, maxGoalRounds: 20, objective: 'fixture objective', ...over });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-autorestore-'));

/* ------------------------------------------------ the process that is about to restart ----- */
const beforeGoals = fakeGoals({
  's-running': goal({ id: 'run' }),
  's-paused': goal({ id: 'pause', phase: 'paused', activation: 'disarmed' }),
  's-blocked': goal({ id: 'block', phase: 'blocked', activation: 'disarmed' }),
  's-nogoal': null,
  's-exhausted': goal({ id: 'exh', exhausted: true, roundsStarted: 20, maxGoalRounds: 20 }),
  's-done': goal({ id: 'done', phase: 'complete', activation: 'disarmed' }),
  's-gone': goal({ id: 'gone' }),
});
const beforeAgents = fakeAgents([
  { id: 's-running', running: true, title: '视频任务' },
  { id: 's-paused', running: false },
  { id: 's-blocked', running: false },
  { id: 's-nogoal', running: true },
  { id: 's-exhausted', running: true },
  { id: 's-done', running: false },
  { id: 's-gone', running: true },
]);
const first = beatOn(root, { agents: beforeAgents, goals: beforeGoals });
const helper = await first.globalRestart();
destroy: {
  try { helper.cancel(); } catch {}
}
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'heartBeat', 'state.json'), 'utf8')).goalSnapshot;
check('pre-restart: every live conversation is snapshotted, including the ones with no goal', Array.isArray(snapshot?.entries) && snapshot.entries.length === 7, JSON.stringify(snapshot?.entries?.map((entry) => entry.sessionId)));
check('pre-restart: the phase and the running state are recorded per conversation', snapshot.entries.find((entry) => entry.sessionId === 's-running')?.phase === 'active' && snapshot.entries.find((entry) => entry.sessionId === 's-running')?.running === true && snapshot.entries.find((entry) => entry.sessionId === 's-paused')?.phase === 'paused' && snapshot.entries.find((entry) => entry.sessionId === 's-blocked')?.phase === 'blocked', JSON.stringify(snapshot.entries.map((entry) => ({ s: entry.sessionId, p: entry.phase, r: entry.running }))));
check('pre-restart: the snapshot carries the ref a re-arm needs, and NOT the objective', snapshot.entries.some((entry) => entry.goalId && entry.revision !== null) && !JSON.stringify(snapshot).includes('fixture objective'));
check('pre-restart: it was recorded because a restart was really asked for', first === undefined || snapshot.reason === 'immediate', String(snapshot.reason));

/* ------------------------------------------------ the process that came back up ------------ */
/* The new host kept every durable phase but disarmed everything; s-running came back without one of
 * its neighbours to prove the agent-not-loaded path. */
const afterGoals = fakeGoals({
  's-running': goal({ id: 'run', phase: 'active', activation: 'disarmed' }),
  's-paused': goal({ id: 'pause', phase: 'paused', activation: 'disarmed' }),
  's-blocked': goal({ id: 'block', phase: 'blocked', activation: 'disarmed' }),
  's-nogoal': null,
  's-exhausted': goal({ id: 'exh', exhausted: true, roundsStart: 20, phase: 'active', activation: 'disarmed', roundsStarted: 20, maxGoalRounds: 20 }),
  's-done': goal({ id: 'done', phase: 'complete', activation: 'disarmed' }),
});
const afterAgents = fakeAgents([
  { id: 's-running', running: true },
  { id: 's-paused', running: false },
  { id: 's-blocked', running: false },
  { id: 's-nogoal', running: false },
  { id: 's-exhausted', running: true },
]);
const second = beatOn(root, { agents: afterAgents, goals: afterGoals });
await second.tick();
await second.tick();
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'heartBeat', 'state.json'), 'utf8')).goalRestore;
check('post-restart: the goal that was active is re-armed without any model turn', receipt?.resumed?.length === 1 && receipt.resumed[0].sessionId === 's-running' && receipt.resumed[0].verified === true, JSON.stringify(receipt?.resumed));
check('post-restart: a resume is issued only for goals that were active, with their exact refs', afterGoals.calls.filter((entry) => entry.op === 'resume').length === 2 && afterGoals.calls.filter((entry) => entry.op === 'resume').every((entry) => ['run', 'exh'].includes(entry.ref.id)) && afterGoals.calls.filter((entry) => entry.op === 'resume').every((entry) => entry.ref.revision === 7), JSON.stringify(afterGoals.calls));
check('post-restart: the paused goal is left paused, not resumed', afterGoals.seed.get('s-paused').phase === 'paused' && receipt.skipped.some((entry) => entry.sessionId === 's-paused' && entry.reason === 'not_active_before_restart'), JSON.stringify(receipt.skipped.filter((entry) => entry.sessionId === 's-paused')));
check('post-restart: the blocked goal is left blocked even though the service would resume it', afterGoals.seed.get('s-blocked').phase === 'blocked' && receipt.skipped.some((entry) => entry.sessionId === 's-blocked' && entry.reason === 'not_active_before_restart'), JSON.stringify(receipt.skipped.filter((entry) => entry.sessionId === 's-blocked')));
check('post-restart: a completed goal is not revived', afterGoals.seed.get('s-done').phase === 'complete' && receipt.skipped.some((entry) => entry.sessionId === 's-done'));
check('post-restart: a goal that exhausted its rounds is reported, not silently dropped', receipt.skipped.some((entry) => entry.sessionId === 's-exhausted' && entry.reason === 'resume_refused' && String(entry.error).includes('exhausted')), JSON.stringify(receipt.skipped.filter((entry) => entry.sessionId === 's-exhausted')));
check('post-restart: a conversation that never came back is named as such', receipt.skipped.some((entry) => entry.sessionId === 's-gone' && entry.reason === 'agent_not_loaded'), JSON.stringify(receipt.skipped));
check('post-restart: the receipt counts what it did', receipt.resumed_count === 1 && receipt.verified_count === 1 && receipt.skipped_count === receipt.skipped.length, JSON.stringify({ resumed: receipt.resumed_count, verified: receipt.verified_count, skipped: receipt.skipped_count }));
check('post-restart: nothing but resume was ever called on the goal service', afterGoals.calls.every((entry) => entry.op === 'resume'), JSON.stringify(afterGoals.calls.map((entry) => entry.op)));
check('post-restart: the snapshot is marked applied so a later tick cannot re-arm twice', receipt.attempts >= 1 && JSON.parse(fs.readFileSync(path.join(root, 'heartBeat', 'state.json'), 'utf8')).goalSnapshot.appliedAt !== undefined);

/* ------------------------------------------------ it must not run twice -------------------- */
const resumesAfterFirst = afterGoals.calls.length;
await second.tick();
const third = beatOn(root, { agents: afterAgents, goals: afterGoals });
await third.tick();
check('idempotent: further ticks and a further process never resume again', afterGoals.calls.length === resumesAfterFirst, JSON.stringify({ before: resumesAfterFirst, after: afterGoals.calls.length }));

/* ------------------------------------------------ when the host is not ready yet ------------ */
const waitingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-autorestore-wait-'));
const seeded = beatOn(waitingRoot, { agents: fakeAgents([{ id: 's-w', running: true }]), goals: fakeGoals({ 's-w': goal({ id: 'w' }) }) });
await seeded.globalRestart().then((h) => { try { h.cancel(); } catch {} });
const noService = beatOn(waitingRoot, { agents: () => null, goals: () => null });
let waited = { state: null };
for (let i = 0; i < 30; i += 1) { await noService.tick(); }
const waitState = JSON.parse(fs.readFileSync(path.join(waitingRoot, 'heartBeat', 'state.json'), 'utf8'));
check('no services: it waits, then records that it gave up instead of retrying forever', waitState.goalRestore?.gaveUp === 'services_unavailable' && waitState.goalRestore.attempts >= 30, JSON.stringify({ gaveUp: waitState.goalRestore?.gaveUp, attempts: waitState.goalRestore?.attempts }));

const failedChecks = checks.filter((entry) => entry.pass !== true);
for (const entry of checks) console.log((entry.pass ? 'ok   ' : 'not ok ') + entry.name + (entry.pass ? '' : '  [' + entry.detail + ']'));
console.log('');
console.log('goal autorestore: ' + (checks.length - failedChecks.length) + '/' + checks.length + ' passed');
if (failedChecks.length) { console.log('FAILED: ' + failedChecks.map((entry) => entry.name).join('; ')); process.exit(1); }
console.log('PASS');
