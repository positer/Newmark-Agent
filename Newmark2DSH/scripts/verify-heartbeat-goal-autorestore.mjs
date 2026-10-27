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
let clock = { value: 1793120000000 };
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
    now: () => clock.value,
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
check('post-restart: the paused goal is left paused, not resumed', afterGoals.seed.get('s-paused').phase === 'paused' && receipt.skipped.some((entry) => entry.sessionId === 's-paused' && entry.reason === 'paused_by_user'), JSON.stringify(receipt.skipped.filter((entry) => entry.sessionId === 's-paused')));
check('post-restart: the blocked goal is left blocked even though the service would resume it', afterGoals.seed.get('s-blocked').phase === 'blocked' && receipt.skipped.some((entry) => entry.sessionId === 's-blocked' && entry.reason === 'goal_blocked'), JSON.stringify(receipt.skipped.filter((entry) => entry.sessionId === 's-blocked')));
check('post-restart: a completed goal is not revived', afterGoals.seed.get('s-done').phase === 'complete' && !afterGoals.calls.some((entry) => entry.sessionId === 's-done'), JSON.stringify(afterGoals.calls.map((entry) => entry.sessionId)));
check('post-restart: a goal that exhausted its rounds is reported, not silently dropped', receipt.skipped.some((entry) => entry.sessionId === 's-exhausted' && entry.reason === 'resume_refused' && String(entry.error).includes('exhausted')), JSON.stringify(receipt.skipped.filter((entry) => entry.sessionId === 's-exhausted')));
clock.value += 181000;
await second.tick();
const lateReceipt = JSON.parse(fs.readFileSync(path.join(root, 'heartBeat', 'state.json'), 'utf8')).goalRestore;
check('post-restart: the watch closes when its window elapses and never resumes a late conversation', lateReceipt.closed_reason === 'window_elapsed' && !afterGoals.calls.some((entry) => entry.sessionId === 's-gone'), JSON.stringify({ closed: lateReceipt.closed_reason, calls: afterGoals.calls.map((entry) => entry.sessionId) }));
check('post-restart: the receipt counts what it did', receipt.resumed_count === 1 && receipt.verified_count === 1 && receipt.skipped_count === receipt.skipped.length, JSON.stringify({ resumed: receipt.resumed_count, verified: receipt.verified_count, skipped: receipt.skipped_count }));
check('post-restart: nothing but resume was ever called on the goal service', afterGoals.calls.every((entry) => entry.op === 'resume'), JSON.stringify(afterGoals.calls.map((entry) => entry.op)));
check('post-restart: the receipt records how many agents were visible for this boot', lateReceipt.agents_loaded >= 1 && lateReceipt.agents_expected >= 1, JSON.stringify({ loaded: lateReceipt.agents_loaded, expected: lateReceipt.agents_expected }));

/* ------------------------------------------------ it must not run twice -------------------- */
const resumesAfterFirst = afterGoals.calls.length;
await second.tick();
check('idempotent: a further tick in the SAME boot resumes nothing again', afterGoals.calls.length === resumesAfterFirst, JSON.stringify({ before: resumesAfterFirst, after: afterGoals.calls.length }));
/* A NEW boot is a new decision: it re-examines its own live set (that is the point of the boot
 * sweep), so the receipt must be per-boot rather than inherited. */
const third = beatOn(root, { agents: afterAgents, goals: afterGoals });
await third.tick();
const thirdState = JSON.parse(fs.readFileSync(path.join(root, 'heartBeat', 'state.json'), 'utf8'));
check('a new boot starts its own watch instead of inheriting the previous receipt', thirdState.goalRestore?.bootPid !== undefined && thirdState.goalRestore.bootPid !== 1001, JSON.stringify({ bootPid: thirdState.goalRestore?.bootPid }));

/* ------------------------------------------------ when the host is not ready yet ------------ */
const waitingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-autorestore-wait-'));
const seeded = beatOn(waitingRoot, { agents: fakeAgents([{ id: 's-w', running: true }]), goals: fakeGoals({ 's-w': goal({ id: 'w' }) }) });
await seeded.globalRestart().then((h) => { try { h.cancel(); } catch {} });
const noService = beatOn(waitingRoot, { agents: () => null, goals: () => null });
let waited = { state: null };
for (let i = 0; i < 30; i += 1) { await noService.tick(); }
const waitState = JSON.parse(fs.readFileSync(path.join(waitingRoot, 'heartBeat', 'state.json'), 'utf8'));
check('no services: it waits, then records that it gave up instead of retrying forever', waitState.goalRestore?.closed_reason === 'services_unavailable' && (waitState.goalRestore.attempts ?? 0) >= 30, JSON.stringify({ closed: waitState.goalRestore?.closed_reason, attempts: waitState.goalRestore?.attempts }));


/* ------------------------------------------ no snapshot: boot sweep + prompt refresh -------- */
/* This is the case the user hit: the FIRST restart after an upgrade is performed by the old
 * process, which does not write a snapshot. The invariant must still hold on the new process. */
const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-bootsweep-'));
/* Seed it with a queued continuation that carries a retina-era instruction, exactly as an upgrade
 * would find in the durable queue. */
fs.mkdirSync(path.join(sweepRoot, 'heartBeat'), { recursive: true });
fs.writeFileSync(path.join(sweepRoot, 'heartBeat', 'state.json'), JSON.stringify({
  schema: 3, tasks: [{ id: 'old-task', prompt: 'Newmark2DSH 已重启。先恢复这个对话的目标状态：读 get_goal；若 phase:"active" 且 activation:"disarmed"（会话恢复后宿主会把进行中的目标解除武装），调用 update_goal{action:"resume"} 重新武装；若 phase:"paused" 保持暂停，不要 resume；没有 goal 则跳过。然后从上一句用户消息继续；不要重复已经完成的动作，未完成的工作先说明状态。', destination: 's-sweep', status: 'armed', restartPid: null, folder: null, created: 1 }],
  receipts: [], terminated: [], intent: null, intents: [], goalSnapshot: null, goalRestore: null,
}), 'utf8');
const sweepGoals = fakeGoals({
  's-sweep': goal({ id: 'sweep', phase: 'active', activation: 'disarmed' }),
  's-pause2': goal({ id: 'pause2', phase: 'paused', activation: 'disarmed' }),
  's-block2': goal({ id: 'block2', phase: 'blocked', activation: 'disarmed' }),
});
const sweepAgents = fakeAgents([{ id: 's-sweep', running: true }, { id: 's-pause2', running: false }, { id: 's-block2', running: false }]);
const sweepBeat = beatOn(sweepRoot, { agents: sweepAgents, goals: sweepGoals });
await sweepBeat.tick();
const sweepState = JSON.parse(fs.readFileSync(path.join(sweepRoot, 'heartBeat', 'state.json'), 'utf8'));
check('no snapshot: the boot itself re-arms an active+disarmed goal', sweepState.goalRestore?.mode === 'boot_sweep' && sweepState.goalRestore.resumed_count === 1 && sweepState.goalRestore.resumed[0].sessionId === 's-sweep' && sweepState.goalRestore.resumed[0].verified === true, JSON.stringify(sweepState.goalRestore?.resumed));
check('no snapshot: paused and blocked goals are still untouched by the sweep', sweepGoals.seed.get('s-pause2').phase === 'paused' && sweepGoals.seed.get('s-block2').phase === 'blocked' && sweepState.goalRestore.skipped.some((entry) => entry.sessionId === 's-pause2' && entry.reason === 'paused_by_user') && sweepState.goalRestore.skipped.some((entry) => entry.sessionId === 's-block2' && entry.reason === 'goal_blocked'), JSON.stringify(sweepState.goalRestore?.skipped));
check('no snapshot: a queued continuation with a retired instruction is rewritten, not delivered', sweepState.goalRestore.refreshed_continuations === 1 && sweepState.tasks[0].prompt.includes('自动') && !sweepState.tasks[0].prompt.includes('update_goal{action') && sweepState.tasks[0].refreshedAt !== undefined, JSON.stringify({ refreshed: sweepState.goalRestore.refreshed_continuations, prompt: String(sweepState.tasks[0]?.prompt).slice(0, 80) }));
check('no snapshot: the sweep runs once, not on every tick', (await (async () => { const before = sweepGoals.calls.length; await sweepBeat.tick(); return sweepGoals.calls.length === before; })()));

/* A CONSUMED snapshot from an earlier restart must not be treated as this restart's evidence. */
const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-stale-'));
fs.mkdirSync(path.join(staleRoot, 'heartBeat'), { recursive: true });
fs.writeFileSync(path.join(staleRoot, 'heartBeat', 'state.json'), JSON.stringify({
  schema: 3, tasks: [], receipts: [], terminated: [], intent: null, intents: [],
  goalSnapshot: { schema: 1, at: 1, reason: 'update', appliedAt: 2, entries: [{ sessionId: 's-stale', running: true, phase: 'active', activation: 'disarmed', goalId: 'g-stale', revision: 3 }] },
  goalRestore: null,
}), 'utf8');
const staleGoals = fakeGoals({ 's-stale': goal({ id: 'stale', phase: 'active', activation: 'disarmed', revision: 3 }) });
const staleBeat = beatOn(staleRoot, { agents: fakeAgents([{ id: 's-stale', running: true }]), goals: staleGoals });
await staleBeat.tick();
const staleState = JSON.parse(fs.readFileSync(path.join(staleRoot, 'heartBeat', 'state.json'), 'utf8'));
check('a consumed snapshot is not reused: an external relaunch falls back to the boot sweep', staleState.goalRestore?.mode === 'boot_sweep' && staleState.goalRestore.resumed_count === 1 && staleGoals.calls.some((entry) => entry.op === 'resume'), JSON.stringify({ mode: staleState.goalRestore?.mode, resumed: staleState.goalRestore?.resumed_count }));


/* -------------------------------- an empty registry at the first tick is NOT "nothing to do" ---- */
const lateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-late-'));
const lateGoals = fakeGoals({ 's-late': goal({ id: 'late', phase: 'active', activation: 'disarmed' }) });
let lateSessions = [];
/* A registry that is EMPTY on the first tick and populated later, the way the host loads sessions. */
const lateService = { roots: () => lateSessions, byId: () => lateSessions };
const lateBeat = beatOn(lateRoot, { agents: lateService, goals: lateGoals });
await lateBeat.tick();
const midway = JSON.parse(fs.readFileSync(path.join(lateRoot, 'heartBeat', 'state.json'), 'utf8'));
check('readiness: an empty registry does not produce a done receipt', (midway.goalRestore ?? null) === null, JSON.stringify(midway.goalRestore));
lateSessions = [{ id: 's-late', status: 'running', session: { id: 's-late', title: null } }];
await lateBeat.tick();
const lateState = JSON.parse(fs.readFileSync(path.join(lateRoot, 'heartBeat', 'state.json'), 'utf8'));
check('readiness: once the agents are loaded the same boot restores the goal', lateState.goalRestore?.mode === 'boot_sweep' && lateState.goalRestore.resumed_count === 1 && lateState.goalRestore.agents_loaded === 1, JSON.stringify({ resumed: lateState.goalRestore?.resumed_count, loaded: lateState.goalRestore?.agents_loaded }));

/* -------------------------------- a receipt from an older version is discarded, not reused ------- */
const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-legacy-'));
fs.mkdirSync(path.join(legacyRoot, 'heartBeat'), { recursive: true });
fs.writeFileSync(path.join(legacyRoot, 'heartBeat', 'state.json'), JSON.stringify({
  schema: 3, tasks: [], receipts: [], terminated: [], intent: null, intents: [], goalSnapshot: null,
  goalRestore: { at: 1, bootDoneAt: 1, bootPid: 999, mode: 'snapshot', attempts: 1, resumed: [], skipped: [{ sessionId: 's-legacy', reason: 'not_active_before_restart' }] },
}), 'utf8');
const legacyGoals = fakeGoals({ 's-legacy': goal({ id: 'legacy', phase: 'active', activation: 'disarmed' }) });
const legacyBeat = beatOn(legacyRoot, { agents: fakeAgents([{ id: 's-legacy', running: true }]), goals: legacyGoals });
await legacyBeat.tick();
const legacyState = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'heartBeat', 'state.json'), 'utf8'));
check('a legacy receipt is discarded: the watch starts fresh and still restores', legacyState.goalRestore?.mode === 'boot_sweep' && legacyState.goalRestore.resumed_count === 1 && Array.isArray(legacyState.goalRestore.events) && legacyGoals.calls.some((entry) => entry.op === 'resume'), JSON.stringify({ mode: legacyState.goalRestore?.mode, resumed: legacyState.goalRestore?.resumed_count }));

/* --------------------------- a disarm that lands AFTER a resume is still caught ----------------- */
const flipRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-goal-flip-'));
const flipGoals = fakeGoals({ 's-flip': goal({ id: 'flip', phase: 'active', activation: 'disarmed' }) });
const flipBeat = beatOn(flipRoot, { agents: fakeAgents([{ id: 's-flip', running: true }]), goals: flipGoals });
await flipBeat.tick();
check('flip: the first tick resumes it', flipGoals.seed.get('s-flip').activation === 'armed' && flipGoals.calls.filter((entry) => entry.op === 'resume').length === 1);
/* The host disarms when the session really resumes - after our resume. */
flipGoals.seed.set('s-flip', { ...flipGoals.seed.get('s-flip'), activation: 'disarmed' });
await flipBeat.tick();
check('flip: a disarm that lands after our own resume is caught on the next tick', flipGoals.seed.get('s-flip').activation === 'armed' && flipGoals.calls.filter((entry) => entry.op === 'resume').length === 2, JSON.stringify(flipGoals.calls));
const failedChecks = checks.filter((entry) => entry.pass !== true);
for (const entry of checks) console.log((entry.pass ? 'ok   ' : 'not ok ') + entry.name + (entry.pass ? '' : '  [' + entry.detail + ']'));
console.log('');
console.log('goal autorestore: ' + (checks.length - failedChecks.length) + '/' + checks.length + ' passed');
if (failedChecks.length) { console.log('FAILED: ' + failedChecks.map((entry) => entry.name).join('; ')); process.exit(1); }
console.log('PASS');
