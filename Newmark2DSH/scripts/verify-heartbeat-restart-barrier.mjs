#!/usr/bin/env node
/**
 * verify-heartbeat-restart-barrier.mjs — the two-phase restart barrier.
 *
 * heartbeat_restart {broadcast:true} is a PROMISE to every other running conversation: none of them
 * is interrupted until each has either registered a post-restart continuation or declared that it
 * needs none. This gate drives that promise through the real state machine and, wherever
 * persistence is the claim, reads <root>/heartBeat/state.json back from disk instead of trusting the
 * return value — a barrier that only SAID it recorded a receipt is the defect this file exists to
 * catch.
 *
 * Fixtures, not the host: agents is a roots()/get()/resume() fake and the restart controller is a
 * fake that records prepare/restart/commit and creates a folder instead of launching anything. No
 * process is started, no restart helper is spawned and no model is called.
 *
 * ONE THING THIS GATE DELIBERATELY DOES NOT DO: it never executes heartbeat_restart with
 * broadcast=false. That branch reaches the REAL controller, whose prepare() probes the desktop and
 * whose restart() spawns the restart helper, so executing it here would launch a process from a
 * gate. The legacy immediate path is instead measured at the component (globalRestart() against the
 * fake controller: one prepare, one restart, ZERO intents, and roots() never called), and the
 * wrapper's branch is pinned on index.js. The broadcast=true branch IS executed through the mounted
 * tool: it opens the barrier and throws on the missing agents service WITHOUT touching the
 * controller, which is exactly the evidence that it does not restart.
 *
 * Run: node Newmark2DSH/scripts/verify-heartbeat-restart-barrier.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHeartBeat } from '../packages/newmark-core/components/heartbeat/component.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, '..', 'packages', 'newmark-core');
const HEARTBEAT_INDEX = path.join(PACKAGE, 'components', 'heartbeat', 'index.js');

let passed = 0;
let failed = 0;
const failures = [];
function check(label, condition, detail) {
  const n = passed + failed + 1;
  if (condition) {
    passed += 1;
    console.log('ok ' + n + ' - ' + label);
    return true;
  }
  failed += 1;
  failures.push(label);
  console.log('not ok ' + n + ' - ' + label);
  if (detail !== undefined) console.log('  ' + detail);
  return false;
}
async function refused(label, run, needle) {
  try {
    await run();
  } catch (error) {
    const message = String(error?.message ?? error);
    check(label, needle === undefined || message.includes(needle), message);
    return;
  }
  check(label, false, 'the call resolved where it had to throw');
}

/**
 * Run one case in its own boundary, so a state the mutation broke becomes a named `not ok` instead
 * of a stack trace. A gate that dies on the broken shape reports nothing about it — and the mutation
 * table would then read "unprotected" for an assertion that exists but never printed its verdict.
 */
async function section(name, run) {
  try {
    await run();
  } catch (error) {
    check(name + ' ran to completion', false, 'the case threw: ' + String(error?.message ?? error));
  }
}

/* ------------------------------------------------------------------ fixtures --- */

let sequence = 0;
const ROOT_BASE = path.join(os.tmpdir(), 'newmark-barrier-gate');
fs.mkdirSync(ROOT_BASE, { recursive: true });

function fakeAgent(id, options = {}) {
  const delivered = [];
  const agent = {
    running: options.running === true,
    options: { provider: 'fixture', model: 'fixture' },
    session: {
      id,
      title: options.title ?? (id + ' 对话'),
      lastActivityAt: options.lastActivityAt ?? 1000,
      running: false,
      snapshotEvents: () => [],
    },
    followup: async message => { delivered.push(message); },
    ctx: { get: name => (name === 'sessions' ? { flush: async () => true } : undefined) },
  };
  // The delivery record is attached to the AGENT so a test can read it back through the same
  // byId map the service's get() resolves, which is how a closed session's message is observed.
  agent.received = delivered;
  return { agent, delivered };
}

/**
 * One isolated fixture: a throwaway root, a fake agents service whose live set the test controls,
 * and a fake controller that records what the barrier asked it to do.
 *
 * live is what the HOST would report as running (roots()); byId is what a delivery can still reach
 * (get()/resume()), which is how a conversation that closed during preparation is still deliverable
 * after the restart.
 */
function scenario(options = {}) {
  const root = fs.mkdtempSync(path.join(ROOT_BASE, 'run-' + (++sequence) + '-'));
  const clock = { value: options.start ?? 5000 };
  const live = [];
  const byId = new Map();
  const blocked = new Set();
  const rootsCalls = { n: 0 };
  const service = {
    roots() { rootsCalls.n += 1; return live.map(id => byId.get(id)).filter(Boolean); },
    get(id) { return blocked.has(id) ? undefined : byId.get(id); },
    async resume({ resumeSessionId }) {
      if (blocked.has(resumeSessionId)) throw Error('fixture: delivery blocked for ' + resumeSessionId);
      const found = byId.get(resumeSessionId);
      if (!found) throw Error('fixture: no session ' + resumeSessionId);
      return { agent: found };
    },
  };
  const calls = { prepare: 0, restart: 0, commits: 0, cancels: 0, versions: [] };
  const controller = {
    async prepare(version) { calls.prepare += 1; calls.versions.push(version); return { ok: true, ticket: 'ticket-' + calls.prepare }; },
    async restart(ticket) {
      calls.restart += 1;
      calls.ticket = ticket;
      const folder = path.join(root, 'core', 'restart', 'fixture-' + calls.restart);
      fs.mkdirSync(folder, { recursive: true });
      let finished = false;
      return {
        folder,
        commit() { if (finished) return; finished = true; calls.commits += 1; },
        cancel() { if (finished) return; finished = true; calls.cancels += 1; },
      };
    },
  };
  const probe = options.probe ?? (async () => ({ path: 'fixture-host', created: 'fixture-created' }));
  const pid = options.pid ?? 1000;
  const create = (overrides = {}) => createHeartBeat({
    root,
    core: () => null,
    agents: () => service,
    controller,
    probe: overrides.probe ?? probe,
    pid: overrides.pid ?? pid,
    version: '0.3.16',
    now: () => clock.value,
  });
  return {
    root,
    clock,
    service,
    calls,
    rootsCalls,
    controller,
    probe,
    pid,
    create,
    beat: create(),
    add(id, opts) { const made = fakeAgent(id, opts); live.push(id); byId.set(id, made.agent); return made; },
    /** The session is gone from the host's live set; its agent is still reachable for delivery. */
    close(id) { const at = live.indexOf(id); if (at !== -1) live.splice(at, 1); },
    /** The session is live but cannot be reached (busy/unnotifiable). */
    block(id) { blocked.add(id); },
    delivered(id) { return byId.get(id)?.received ?? []; },
    state() { return JSON.parse(fs.readFileSync(path.join(root, 'heartBeat', 'state.json'), 'utf8')); },
    exec(id) { return { agent: { session: { id } } }; },
  };
}

/** Mount components/heartbeat/index.js on a minimal ctx, to read what it registers. */
async function mountHeartbeatTools(root) {
  const url = new URL(pathToFileURL(HEARTBEAT_INDEX).href);
  url.searchParams.set('mount', String(Math.random()));
  const module = await import(url.href);
  const tools = new Map();
  const disposers = [];
  const context = {
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    effect(factory) { const disposer = factory(); if (typeof disposer === 'function') disposers.push(disposer); return () => {}; },
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    webServer: { tapIndex: () => () => {} },
  };
  module.apply(context, { root });
  return { tools, dispose() { for (const disposer of disposers.reverse()) { try { disposer(); } catch { /* teardown must not decide the verdict */ } } } };
}

/* ================================================================== case 1 =====
 * Two fake participants both registered -> commitBarrier committed, exactly one helper.commit(). */
await section('case 1', async () => {
  const s = scenario();
  s.add('R', { title: 'requester 对话' });
  s.add('C', { title: 'other 对话' });
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  check('1- beginBarrier opens a preparing intent for both live sessions', begun.ok === true && begun.phase === 'preparing' && begun.participants.length === 2, JSON.stringify(begun));
  check('1- ackMode and deadline are reported from the persisted intent', begun.ackMode === 'auto' && typeof begun.deadline === 'number', JSON.stringify({ ackMode: begun.ackMode, deadline: begun.deadline }));
  const afterBegin = s.state();
  check('1- the persisted intent holds both participants and is schema 3', afterBegin.schema === 3 && afterBegin.intent?.participants.length === 2 && afterBegin.intent.phase === 'preparing');
  check('1- auto mode registered a continuation for every participant (persisted ack)', afterBegin.intent.participants.every(p => p.ack === 'registered' && p.ackSource === 'auto'), JSON.stringify(afterBegin.intent.participants));
  const tasks = s.state().tasks.filter(t => t.status === 'waiting');
  check('1- auto coverage queued one durable continuation per participant', tasks.length === 2 && new Set(tasks.map(t => t.destination)).size === 2, JSON.stringify(tasks));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('1- commit with every receipt in returns committed', committed.ok === true && committed.phase === 'committed' && committed.missing.length === 0 && committed.acks.length === 2, JSON.stringify({ phase: committed.phase, missing: committed.missing, acks: committed.acks }));
  check('1- the persisted intent moved to committing with its acks recorded', s.state().intent?.phase === 'committing' && Array.isArray(s.state().intent.acks) && s.state().intent.acks.length === 2);
  committed.helper.commit();
  committed.helper.commit();
  check('1- exactly one helper.commit() launched the restart', s.calls.commits === 1 && s.calls.prepare === 1 && s.calls.restart === 1, JSON.stringify(s.calls));
});

/* ================================================================== case 2 =====
 * One participant never acks -> aborted, reason missing_acks, and that session is named in
 * missing[] with sessionId/title/state. */
await section('case 2', async () => {
  const s = scenario();
  s.add('R');
  s.add('C', { title: 'silent 对话' });
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  check('2- agent mode leaves every participant pending until it answers', begun.participants.every(p => p.ack === 'pending'), JSON.stringify(begun.participants));
  await s.beat.acknowledge({ intentId: begun.intentId, continuation: 'registered' }, s.exec('R'));
  const aborted = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('2- a participant that never answered aborts the barrier', aborted.ok === false && aborted.phase === 'aborted' && aborted.reason === 'missing_acks', JSON.stringify(aborted));
  const named = aborted.missing.find(entry => entry.sessionId === 'C');
  check('2- the missing receipt names that session with sessionId/title/state', Boolean(named) && named.title === 'silent 对话' && named.state === 'live' && named.ack === 'pending', JSON.stringify(aborted.missing));
  check('2- no restart was launched and the intent closed into history', s.calls.restart === 0 && s.state().intent === null && s.state().intents.at(-1)?.abortReason === 'missing_acks' && s.state().intents.at(-1)?.phase === 'aborted', JSON.stringify({ restart: s.calls.restart, intent: s.state().intent, history: s.state().intents.at(-1)?.abortReason }));
});

/* ================================================================== case 3 =====
 * broadcast=false -> the legacy immediate restart path, zero intent created, zero broadcast calls
 * (regression control). Component half first, then the wrapper's branch. */
await section('case 3', async () => {
  const s = scenario();
  s.add('R');
  const helper = await s.beat.globalRestart();
  helper.commit();
  helper.commit();
  check('3- the legacy path restarts immediately: one prepare and one restart', s.calls.prepare === 1 && s.calls.restart === 1 && s.calls.commits === 1, JSON.stringify(s.calls));
  check('3- the legacy path creates zero intents', s.state().intent === null && (s.state().intents ?? []).length === 0, JSON.stringify({ intent: s.state().intent, intents: s.state().intents }));
  check('3- the legacy path never enumerates participants (zero broadcast calls)', s.rootsCalls.n === 0, 'roots() called ' + s.rootsCalls.n + ' time(s)');
});
await section('case 3 mounted', async () => {
  const mounted = await mountHeartbeatTools(fs.mkdtempSync(path.join(ROOT_BASE, 'mount-')));
  const restartTool = mounted.tools.get('heartbeat_restart');
  const properties = Object.keys(restartTool?.parameters?.properties ?? {});
  check('3- heartbeat_restart declares the opt-in barrier arguments', ['broadcast', 'ackMode', 'ackTimeoutMs', 'onTimeout', 'force', 'reason'].every(name => properties.includes(name)) && restartTool?.parameters?.properties?.broadcast?.type === 'boolean', properties.join(', '));
  check('3- the barrier modes and bounds are the frozen ones', restartTool?.parameters?.properties?.ackMode?.enum?.join(',') === 'auto,agent' && restartTool?.parameters?.properties?.onTimeout?.enum?.join(',') === 'abort,proceed' && restartTool?.parameters?.properties?.ackTimeoutMs?.minimum === 1000 && restartTool?.parameters?.properties?.ackTimeoutMs?.maximum === 600000);
  check('3- the heartBeat component registers exactly its four tools', ['heartbeat_after_restart', 'heartbeat_restart', 'heartbeat_restart_commit', 'heartbeat_restart_ack'].every(name => mounted.tools.has(name)) && mounted.tools.size === 4, [...mounted.tools.keys()].join(', '));
  const indexSource = fs.readFileSync(HEARTBEAT_INDEX, 'utf8');
  const legacyAt = indexSource.indexOf('if (a.broadcast !== true) {');
  const globalAt = indexSource.indexOf('beat.globalRestart()');
  const immediateAt = indexSource.indexOf('return { ok: true, restarting: true };');
  const legacyIntact = legacyAt !== -1 && globalAt !== -1 && immediateAt !== -1 && legacyAt < globalAt && globalAt < immediateAt;
  check('3- broadcast=false stays on the legacy immediate path in the wrapper', legacyIntact, JSON.stringify({ legacyAt, globalAt, immediateAt }));
  check('3- broadcast=true is the ONLY wrapper branch that opens the barrier', indexSource.includes('return beat.beginBarrier(a, execution);'));
  /* Executing this branch would reach the REAL controller if the wrapper contract were broken (the
   * mounted beat uses the live restart controller, which spawns the helper), so it is executed only
   * while the contract holds. A gate must not launch a restart helper to prove a point. */
  if (legacyIntact) {
    await refused('3- broadcast=true opens the barrier (and does not reach the restart controller)', () => restartTool.execute({ broadcast: true }, { agent: { session: { id: 'mounted-requester' } } }), 'agents 服务不可用');
  } else {
    check('3- broadcast=true opens the barrier (SKIPPED: the wrapper contract is broken, so executing it could launch the real restart helper)', false, 'not executed');
  }
  mounted.dispose();
});

/* ================================================================== case 4 =====
 * ack continuation=none counts as terminal, so commit is allowed. */
await section('case 4', async () => {
  const s = scenario();
  s.add('R');
  s.add('C');
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  await s.beat.acknowledge({ intentId: begun.intentId, continuation: 'registered' }, s.exec('R'));
  await s.beat.acknowledge({ intentId: begun.intentId, continuation: 'none' }, s.exec('C'));
  const persisted = s.state().intent.participants.find(p => p.sessionId === 'C');
  check('4- a none declaration is persisted as that session terminal receipt', persisted.ack === 'none' && persisted.ackSource === 'ack', JSON.stringify(persisted));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('4- none is terminal, so the commit is allowed', committed.ok === true && committed.phase === 'committed' && committed.missing.length === 0, JSON.stringify(committed));
  check('4- the committed intent records the none ack', committed.acks.some(entry => entry.sessionId === 'C' && entry.ack === 'none'));
});

/* ================================================================== case 5 =====
 * an impostor ack cannot satisfy another session's receipt: the ack is attributed to the
 * host-provided caller session id only. */
await section('case 5', async () => {
  const s = scenario();
  s.add('R');
  s.add('V');
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  await s.beat.acknowledge({ intentId: begun.intentId, continuation: 'registered' }, s.exec('R'));
  await refused('5- a session that is not a participant cannot answer for the intent', () => s.beat.acknowledge({ intentId: begun.intentId, continuation: 'registered' }, s.exec('impostor')), '不是本次重启准备的参与者');
  check('5- the victim receipt is untouched on disk after the impostor call', s.state().intent.participants.find(p => p.sessionId === 'V')?.ack === 'pending', JSON.stringify(s.state().intent.participants));
  const aborted = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('5- the impostor cannot satisfy the victim, so the commit aborts naming the victim', aborted.ok === false && aborted.reason === 'missing_acks' && aborted.missing.length === 1 && aborted.missing[0].sessionId === 'V', JSON.stringify(aborted));
  check('5- no restart was launched', s.calls.restart === 0 && s.calls.commits === 0);
});
await section('case 5 schedule', async () => {
  /* The tool path's own registration IS that session's receipt (ackSource schedule). */
  const s = scenario();
  s.add('R');
  s.add('C');
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  const registered = s.beat.schedule('继续工作', undefined, s.exec('R'), { intentId: begun.intentId });
  const persisted = s.state().intent.participants.find(p => p.sessionId === 'R');
  check('5- registering with an intentId is that session receipt (ackSource schedule)', registered.ok === true && persisted.ack === 'registered' && persisted.ackSource === 'schedule', JSON.stringify(persisted));
});

/* ================================================================== case 6 =====
 * a second beginBarrier is rejected with reason intent_in_progress and returns the in-progress
 * intentId plus its progress. */
await section('case 6', async () => {
  const s = scenario({ start: 7000 });
  s.add('R');
  s.add('C');
  const first = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const again = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  check('6- the second beginBarrier is rejected', again.ok === false && again.phase === 'rejected' && again.reason === 'intent_in_progress', JSON.stringify(again));
  check('6- the rejection returns the in-progress intentId and its progress', again.intentId === first.intentId && again.progress?.phase === 'preparing' && again.progress?.participants === 2 && again.progress?.acked === 2 && Array.isArray(again.progress?.missing) && again.progress.missing.length === 0 && again.progress?.deadline === first.deadline, JSON.stringify(again.progress));
  check('6- only the first intent exists on disk', s.state().intent?.id === first.intentId && (s.state().intents ?? []).length === 0);
});

/* ================================================================== case 7 =====
 * requester's own continuation not registered -> aborted, reason requester_not_registered,
 * no restart launched. */
await section('case 7', async () => {
  const s = scenario();
  s.add('R');
  s.add('C');
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  await s.beat.acknowledge({ intentId: begun.intentId, continuation: 'none' }, s.exec('C'));
  const aborted = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('7- a requester without its own receipt cannot commit', aborted.ok === false && aborted.phase === 'aborted' && aborted.reason === 'requester_not_registered', JSON.stringify(aborted));
  check('7- no restart was launched', s.calls.restart === 0 && s.calls.commits === 0, JSON.stringify(s.calls));
  check('7- the intent closed into history with that reason', s.state().intent === null && s.state().intents.at(-1)?.abortReason === 'requester_not_registered');
});

/* ================================================================== case 8 =====
 * commit after the deadline -> aborted, reason deadline_exceeded, no restart launched. */
await section('case 8', async () => {
  const s = scenario({ start: 9000 });
  s.add('R');
  s.add('C');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto', ackTimeoutMs: 1000 }, s.exec('R'));
  s.clock.value = begun.deadline + 1;
  const aborted = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('8- a commit after the deadline aborts with deadline_exceeded', aborted.ok === false && aborted.phase === 'aborted' && aborted.reason === 'deadline_exceeded', JSON.stringify(aborted));
  check('8- no restart was launched', s.calls.restart === 0 && s.calls.commits === 0, JSON.stringify(s.calls));
  check('8- the persisted intent records the abort and moved into history', s.state().intent === null && s.state().intents.at(-1)?.abortReason === 'deadline_exceeded' && s.state().intents.at(-1)?.phase === 'aborted');
});

/* ================================================================== case 9 =====
 * A participant no longer live at commit time leaves the required set, is still recorded, and its
 * auto-registered continuation is still delivered after the restart. The two halves live in two
 * barriers because the component cannot produce them on one participant: auto coverage IS the
 * receipt (ack registered, terminal), while a pending participant that closes is what the liveness
 * re-read marks closed. That is the code's actual contract; this gate asserts both facts rather
 * than inventing a state the state machine does not reach. */
await section('case 9', async () => {
  /* 9a — auto mode: covered at prepare time, then closed before the commit. */
  const s = scenario();
  s.add('R');
  s.add('C', { title: 'closed 对话' });
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  s.close('C');
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('9- a participant that is no longer live does not block the commit', committed.ok === true && committed.phase === 'committed' && committed.missing.length === 0, JSON.stringify(committed));
  const record = s.state().intent.participants.find(p => p.sessionId === 'C');
  check('9- it is still recorded with the terminal receipt it earned', Boolean(record) && record.ack === 'registered' && record.ackSource === 'auto', JSON.stringify(record));
  const task = s.state().tasks.find(t => t.destination === 'C');
  check('9- its auto-registered continuation is still recorded and armed', task?.status === 'armed' && task?.restartPid === s.pid && task?.folder === committed.helper.folder, JSON.stringify(task));
  const promptBefore = task.prompt;
  const folder = committed.helper.folder;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'old' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'running' }));
  const rebooted = s.create({ pid: 2000 });
  await rebooted.tick();
  const deliveredToClosed = s.delivered('C');
  check('9- the continuation is delivered to the closed conversation after the restart', deliveredToClosed.length === 1 && deliveredToClosed[0].content?.[0]?.text === promptBefore, JSON.stringify(deliveredToClosed));
  check('9- the consumed task is physically gone and only its receipt remains', s.state().tasks.every(t => t.id !== task.id) && s.state().receipts.some(r => r.id === task.id), JSON.stringify({ tasks: s.state().tasks.map(t => t.id), receipts: s.state().receipts }));
});
await section('case 9b', async () => {
  /* 9b — agent mode: still pending when it closed, so the liveness re-read marks it closed. */
  const s = scenario();
  s.add('R');
  s.add('C');
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  await s.beat.acknowledge({ intentId: begun.intentId, continuation: 'registered' }, s.exec('R'));
  s.close('C');
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  const closed = s.state().intent?.participants?.find(p => p.sessionId === 'C');
  check('9- a pending participant that closed leaves the required set with a closed ack', committed.ok === true && committed.phase === 'committed' && closed?.ack === 'closed' && closed?.ackSource === 'liveness', JSON.stringify({ committed: committed.phase, record: closed }));
  check('9- the closed participant is not named missing and no restart was withheld', committed.missing.length === 0 && s.calls.restart === 1, JSON.stringify({ missing: committed.missing, calls: s.calls }));
});

/* ================================================================== case 10 ====
 * cross-restart sweep: committing -> committed on a changed owner; a leftover preparing intent
 * from a previous pid -> interrupted + the requester is notified. */
await section('case 10', async () => {
  const s = scenario();
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  const taskId = s.state().tasks[0]?.id;
  const folder = committed.helper.folder;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'old' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'running' }));
  const rebooted = s.create({ pid: 2000, probe: async () => ({ path: 'fixture-host', created: 'new' }) });
  await rebooted.tick();
  const swept = s.state();
  const record = swept.intents.at(-1);
  check('10- a committing intent becomes committed when the helper reports a changed owner', swept.intent === null && record?.phase === 'committed' && record?.abortReason == null, JSON.stringify({ intent: swept.intent, last: record?.phase, reason: record?.abortReason }));
  check('10- the committed sweep records the tasks it delivered', Array.isArray(record?.delivery?.tasks) && record.delivery.tasks.includes(taskId), JSON.stringify(record?.delivery));
});
await section('case 10 control', async () => {
  /* Control: an UNCHANGED owner must not commit the intent. */
  const s = scenario();
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  const folder = committed.helper.folder;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'old' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'running' }));
  const rebooted = s.create({ pid: 2000, probe: async () => ({ path: 'fixture-host', created: 'old' }) });
  await rebooted.tick();
  check('10- an unchanged owner does NOT commit the intent', s.state().intent?.phase === 'committing', JSON.stringify(s.state().intent?.phase));
});
await section('case 10 leftover', async () => {
  /* A leftover preparing intent from a previous pid means the restart did NOT happen. */
  const s = scenario();
  s.add('R', { title: 'requester 对话' });
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const rebooted = s.create({ pid: 2000 });
  await rebooted.tick();
  const swept = s.state();
  const record = swept.intents.at(-1);
  check('10- a leftover preparing intent from a previous pid becomes interrupted', swept.intent === null && record?.phase === 'interrupted' && record?.abortReason === 'restart_not_committed', JSON.stringify({ intent: swept.intent, last: record?.phase, reason: record?.abortReason }));
  const noticed = s.delivered('R');
  check('10- the requester is notified that the restart did not happen', noticed.length === 1 && noticed[0].id === ('newmark-task:intent-interrupted:' + begun.intentId) && String(noticed[0].content?.[0]?.text ?? '').includes('没有提交就中断'), JSON.stringify(noticed));
});
await section('case 10 expired', async () => {
  /* An expired preparing intent of THIS pid is closed so the next broadcast is not refused. */
  const s = scenario({ start: 11000 });
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto', ackTimeoutMs: 1000 }, s.exec('R'));
  s.clock.value = begun.deadline + 1;
  await s.beat.tick();
  check('10- an expired preparation of this pid is aborted and the barrier reopens', s.state().intent === null && s.state().intents.at(-1)?.abortReason === 'deadline_exceeded', JSON.stringify({ intent: s.state().intent, last: s.state().intents.at(-1)?.abortReason }));
});

/* ============================================================ failure modes ====
 * A live but unreachable (busy) participant is recorded unreachable and blocks the barrier. */
await section('the failure modes', async () => {
  const s = scenario();
  s.add('R');
  s.add('C', { title: 'busy 对话', running: true });
  s.block('C');
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  const record = s.state().intent.participants.find(p => p.sessionId === 'C');
  check('F- a busy/unnotifiable session is recorded unreachable, not silently acked', record.ack === 'unreachable' && record.ackSource === 'notify' && String(record.note).includes('notify:') && record.state === 'busy', JSON.stringify(record));
  await s.beat.acknowledge({ intentId: begun.intentId, continuation: 'registered' }, s.exec('R'));
  const aborted = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('F- an unreachable participant blocks the commit and is named', aborted.reason === 'missing_acks' && aborted.missing.some(entry => entry.sessionId === 'C' && entry.ack === 'unreachable'), JSON.stringify(aborted));
});

/* ------------------------------------------------- backward compatibility --- */
await section('backward compatibility', async () => {
  const root = fs.mkdtempSync(path.join(ROOT_BASE, 'schema2-'));
  fs.mkdirSync(path.join(root, 'heartBeat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'heartBeat', 'state.json'), JSON.stringify({ schema: 2, tasks: [{ id: 'legacy', prompt: '旧任务', destination: 'old', status: 'waiting', created: 1 }], receipts: [] }));
  const beat = createHeartBeat({ root, core: () => null, agents: () => null, version: '0.3.16', pid: 1, now: () => 1 });
  check('B- a schema-2 state file still reads and keeps its tasks', beat.state().tasks[0]?.id === 'legacy' && beat.state().tasks[0]?.prompt === '旧任务');
});

/* ------------------------------------------------------------------ report --- */
const total = passed + failed;
console.log('');
console.log('Barrier: ' + passed + '/' + total + ' passed; two-phase prepare/commit, receipts, abort reasons, liveness sweep, cross-restart intent recovery.');
console.log('isolated fixtures: ' + ROOT_BASE);
if (failed > 0) {
  console.log('FAILED: ' + failures.join('; '));
  process.exit(1);
}