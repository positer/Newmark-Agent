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
import * as HEARTBEAT from '../packages/newmark-core/components/heartbeat/component.js';
const createHeartBeat = HEARTBEAT.createHeartBeat;
/* The product's own limit, so the gate drives the number the product ships rather than a copy of it.
 * The fallback exists so this gate still RUNS against a build that predates the limit and reports its
 * cases as failures — a gate that dies at import time cannot show anything about the product. */
const DELIVERY_FAILURE_LIMIT = Number.isInteger(HEARTBEAT.DELIVERY_FAILURE_LIMIT) ? HEARTBEAT.DELIVERY_FAILURE_LIMIT : 3;

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
  // The fixture carries the HOST's shape, not the component's assumption: dsh-agent marks a
  // Session's Agent running as `agent.status === 'running'`, and there is deliberately NO
  // `agent.running` and no `session.running` here. Those fields do not exist on the host, and
  // having them in the fixture is what let the component read them and still look green while
  // every loaded conversation was treated as working.
  const agent = {
    status: options.running === true ? 'running' : 'idle',
    options: { provider: 'fixture', model: 'fixture' },
    session: {
      id,
      title: options.title ?? (id + ' 对话'),
      lastActivityAt: options.lastActivityAt ?? 1000,
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
  s.add('C', { title: 'other 对话', running: true });
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
  s.add('C', { title: 'silent 对话', running: true });
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  check('2- agent mode leaves every participant pending until it answers', begun.participants.every(p => p.ack === 'pending'), JSON.stringify(begun.participants));
  await s.beat.acknowledge({ intentId: begun.intentId, continuation: 'registered' }, s.exec('R'));
  const aborted = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('2- a participant that never answered aborts the barrier', aborted.ok === false && aborted.phase === 'aborted' && aborted.reason === 'missing_acks', JSON.stringify(aborted));
  const named = aborted.missing.find(entry => entry.sessionId === 'C');
  // The receipt must carry the state the HOST reports, and C is running: 'busy' is the host's own
// 'agent.status === "running"' rendered, so an assertion that still said 'live' would be pinning
// the very bug this round removed.
  check('2- the missing receipt names that session with sessionId/title/state', Boolean(named) && named.title === 'silent 对话' && named.state === 'busy' && named.ack === 'pending', JSON.stringify(aborted.missing));
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
  /* Five tools since the cancel tail. The COUNT is the point, not the list: a sixth tool without a
   * case for it fails here exactly as a missing one does. */
  check('3- the heartBeat component registers exactly its five tools', ['heartbeat_after_restart', 'heartbeat_restart', 'heartbeat_restart_commit', 'heartbeat_restart_cancel', 'heartbeat_restart_ack'].every(name => mounted.tools.has(name)) && mounted.tools.size === 5, [...mounted.tools.keys()].join(', '));
  const cancelTool = mounted.tools.get('heartbeat_restart_cancel');
  check('3- heartbeat_restart_cancel declares the required intentId and nothing else', Object.keys(cancelTool?.parameters?.properties ?? {}).join(',') === 'intentId' && cancelTool?.parameters?.required?.join(',') === 'intentId' && cancelTool?.parameters?.additionalProperties === false && cancelTool?.parameters?.properties?.intentId?.type === 'string', JSON.stringify(cancelTool?.parameters));
  const wiredCancel = await cancelTool.execute({ intentId: 'no-such-intent' }, { agent: { session: { id: 'mounted-requester' } } });
  check('3- the mounted cancel tool reaches the state machine and refuses an unknown intent', wiredCancel?.ok === false && wiredCancel.phase === 'refused' && wiredCancel.reason === 'unknown_intent', JSON.stringify(wiredCancel));
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
  s.add('C', { running: true });
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
  s.add('V', { running: true });
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
  s.add('C', { running: true });
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
  s.add('C', { running: true });
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
  s.add('C', { running: true });
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
  s.add('C', { running: true });
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
  s.add('C', { title: 'closed 对话', running: true });
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
  s.add('C', { running: true });
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

/* ================================================================== case 11 ====
 * heartbeat_restart_cancel: ONE state transition preparing -> aborted(reason 'cancelled') plus a
 * durable notice to the requester. Afterwards the cancelled promise cannot be spent, the barrier is
 * free to re-open, and a stranger / an unknown id / an intent that is no longer preparing are each
 * refused by name without writing anything. */
await section('case 11 cancel', async () => {
  const s = scenario();
  s.add('R', { title: 'requester 对话' });
  s.add('C', { running: true });
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  const cancelled = await s.beat.cancelBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('11- cancel closes the preparing intent as aborted(cancelled) in one transition', cancelled.ok === true && cancelled.phase === 'aborted' && cancelled.reason === 'cancelled' && cancelled.intentId === begun.intentId, JSON.stringify(cancelled));
  const after = s.state();
  check('11- the persisted intent is closed and its history record says cancelled', after.intent === null && after.intents.at(-1)?.id === begun.intentId && after.intents.at(-1)?.phase === 'aborted' && after.intents.at(-1)?.abortReason === 'cancelled' && typeof after.intents.at(-1)?.closedAt === 'number', JSON.stringify({ intent: after.intent, last: after.intents.at(-1) }));
  check('11- cancelling launches no restart at all', s.calls.prepare === 0 && s.calls.restart === 0 && s.calls.commits === 0, JSON.stringify(s.calls));
  const noticed = s.delivered('R');
  check('11- the requester receives one durable cancellation notice', cancelled.notified === 'sent' && noticed.length === 1 && noticed[0].id === 'newmark-task:intent-cancelled:' + begun.intentId && String(noticed[0].content?.[0]?.text ?? '').includes('取消'), JSON.stringify({ notified: cancelled.notified, noticed }));
  const again = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  check('11- the barrier can be re-opened after a cancel', again.ok === true && again.phase === 'preparing' && again.intentId !== begun.intentId && s.state().intent?.id === again.intentId, JSON.stringify(again));
  const stale = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('11- the cancelled intent can never be committed', stale.ok === false && stale.phase === 'aborted' && stale.intentId === begun.intentId && stale.reason === 'intent_mismatch', JSON.stringify(stale));
  check('11- and the stale commit does not spend the live barrier it could have reached', s.state().intent?.id === again.intentId && s.state().intent?.phase === 'preparing' && s.calls.restart === 0, JSON.stringify({ live: s.state().intent?.id, calls: s.calls }));
  const committed = await s.beat.commitBarrier({ intentId: again.intentId }, s.exec('R'));
  check('11- the live barrier still commits normally after a cancel', committed.ok === true && committed.phase === 'committed' && committed.intentId === again.intentId && s.calls.restart === 1, JSON.stringify({ committed: committed.phase, calls: s.calls }));
});
await section('case 11 impostor', async () => {
  const s = scenario();
  s.add('R');
  s.add('C', { running: true });
  const begun = await s.beat.beginBarrier({ ackMode: 'agent' }, s.exec('R'));
  const refusedCancel = await s.beat.cancelBarrier({ intentId: begun.intentId }, s.exec('C'));
  check('11- a non-requester cancel is refused with the named code not_requester', refusedCancel.ok === false && refusedCancel.phase === 'refused' && refusedCancel.reason === 'not_requester' && refusedCancel.intentId === begun.intentId, JSON.stringify(refusedCancel));
  const state = s.state();
  check('11- the stranger refusal leaves the preparing intent open and writes no history', state.intent?.id === begun.intentId && state.intent?.phase === 'preparing' && state.intents.length === 0 && state.tasks.length === 0, JSON.stringify({ intent: state.intent?.phase, intents: state.intents.length, tasks: state.tasks.length }));
  const noIdentity = await s.beat.cancelBarrier({ intentId: begun.intentId }, {}).then(() => false, error => String(error.message).includes('可信的 DSH 对话身份'));
  check('11- a caller without a host session identity is refused before any state is read', noIdentity === true);
});
await section('case 11 unknown and not preparing', async () => {
  const s = scenario();
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const unknown = await s.beat.cancelBarrier({ intentId: 'no-such-intent' }, s.exec('R'));
  check('11- an unknown intent is refused with the named code unknown_intent', unknown.ok === false && unknown.phase === 'refused' && unknown.reason === 'unknown_intent' && unknown.intentId === 'no-such-intent', JSON.stringify(unknown));
  check('11- the unknown-intent refusal leaves the live intent open', s.state().intent?.id === begun.intentId, JSON.stringify(s.state().intent?.id));
  const first = await s.beat.cancelBarrier({ intentId: begun.intentId }, s.exec('R'));
  const second = await s.beat.cancelBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('11- cancelling an already closed intent is refused as not_preparing', first.ok === true && first.reason === 'cancelled' && second.ok === false && second.reason === 'not_preparing' && s.state().intents.filter(record => record.abortReason === 'cancelled').length === 1, JSON.stringify(second));
});
await section('case 11 committing is not cancellable', async () => {
  /* Once the helper has been launched the intent is a restart that HAS happened, not a promise that
   * can be withdrawn, so the cancel boundary is exactly 'preparing' — and a refused cancel must not
   * close the committing intent. */
  const s = scenario();
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  const late = await s.beat.cancelBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('11- a committing intent cannot be cancelled', late.ok === false && late.phase === 'refused' && late.reason === 'not_preparing' && late.intentId === begun.intentId, JSON.stringify(late));
  check('11- the commit that already happened is untouched by the refused cancel', s.state().intent?.phase === 'committing' && s.state().intent?.id === begun.intentId && s.calls.restart === 1 && typeof committed.helper?.folder === 'string', JSON.stringify({ phase: s.state().intent?.phase, calls: s.calls }));
});

/* ================================================================== case 12 ====
 * A failed armed task is terminated as failed(final) after N consecutive FAILED delivery attempts
 * instead of being retried forever, and a WAITING task is never counted as a failure. N and the
 * reason for it are printed below; every assertion carries a planted mutation in
 * measure-heartbeat-restart-barrier-mutations.mjs. Measured production case this exists for:
 * ~/.Newmark/heartBeat/state.json held 7 tasks, every one status:"armed", every helper status.json
 * state:"failed" — never delivered, never reclaimed. */
check('12- the component exports the delivery-failure limit this gate drives (N=' + DELIVERY_FAILURE_LIMIT + ')', Number.isInteger(HEARTBEAT.DELIVERY_FAILURE_LIMIT) && HEARTBEAT.DELIVERY_FAILURE_LIMIT === 3, String(HEARTBEAT.DELIVERY_FAILURE_LIMIT));
console.log('  termination policy: N=' + DELIVERY_FAILURE_LIMIT + ' consecutive FAILED delivery attempts -> status "failed(final)" with the reason recorded and the executable record swept. WAITING (helper not running yet / owner unchanged / companion target off) is never counted, so a transient has three ticks (~6 s at the 2 s tick) before it is reclaimed.');
await section('case 12 failed task terminates', async () => {
  const s = scenario();
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  const folder = committed.helper.folder;
  const taskId = s.state().tasks.find(t => t.status === 'armed')?.id;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'old' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'failed', detail: 'DSH exited during startup (fixture)' }));
  const rebooted = s.create({ pid: 2000 });
  await rebooted.tick();
  const afterOne = s.state();
  const held = afterOne.tasks.find(t => t.id === taskId);
  check('12- one failed attempt leaves the task armed and records the helper reason', held?.status === 'armed' && held?.failures === 1 && String(held?.error).includes('DSH exited during startup'), JSON.stringify(held));
  check('12- nothing is terminated or delivered before the limit', (afterOne.terminated ?? []).length === 0 && afterOne.receipts.length === 0 && afterOne.tasks.some(t => t.id === taskId), JSON.stringify({ terminated: afterOne.terminated, receipts: afterOne.receipts }));
  for (let attempt = 1; attempt < DELIVERY_FAILURE_LIMIT; attempt += 1) await rebooted.tick();
  const swept = s.state();
  check('12- at N=' + DELIVERY_FAILURE_LIMIT + ' the task is terminated as failed(final), not left armed', swept.tasks.every(t => t.id !== taskId) && swept.terminated?.length === 1 && swept.terminated[0].id === taskId && swept.terminated[0].status === 'failed(final)' && swept.terminated[0].attempts === DELIVERY_FAILURE_LIMIT, JSON.stringify(swept.terminated));
  check('12- the termination carries the reason it was terminated', String(swept.terminated[0]?.reason).includes('DSH exited during startup') && swept.terminated[0]?.destination === 'R', JSON.stringify(swept.terminated[0]));
  check('12- a terminated task is NOT reported as delivered, and the status reports it', swept.receipts.length === 0 && rebooted.state().terminated.length === 1 && rebooted.state().tasks.length === 0, JSON.stringify({ receipts: swept.receipts, statusTerminated: rebooted.state().terminated.length, statusTasks: rebooted.state().tasks.length }));
});
await section('case 12 armed count does not grow', async () => {
  const s = scenario();
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  const folder = committed.helper.folder;
  const taskId = s.state().tasks.find(t => t.status === 'armed')?.id;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'old' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'failed', detail: 'Process identity changed; restart stopped' }));
  const armedBefore = s.state().tasks.filter(t => t.status === 'armed').length;
  const armedCounts = [];
  for (const boot of [2000, 2100, 2200]) {
    const beat = s.create({ pid: boot });
    for (let attempt = 0; attempt < DELIVERY_FAILURE_LIMIT; attempt += 1) await beat.tick();
    armedCounts.push(s.state().tasks.filter(t => t.status === 'armed').length);
  }
  check('12- the armed-and-not-terminated count never grows across repeated restarts', armedBefore === 1 && armedCounts.every(count => count <= armedBefore) && armedCounts.at(-1) === 0, 'armed before=' + armedBefore + ' after each restart=' + JSON.stringify(armedCounts));
  check('12- and it is terminated exactly once across those restarts, with its reason', s.state().terminated?.length === 1 && s.state().terminated[0].id === taskId && String(s.state().terminated[0].reason).includes('Process identity changed'), JSON.stringify(s.state().terminated));
});
await section('case 12 waiting is not failing', async () => {
  /* The wait the policy must NOT eat: the helper is running and the new process has not been
   * observed yet (the job owner equals the current owner), so the task is not deliverable — but
   * nothing has failed. Ticking past the limit must leave it armed and unterminated. */
  const s = scenario();
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  const folder = committed.helper.folder;
  const taskId = s.state().tasks.find(t => t.status === 'armed')?.id;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'fixture-created' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'running' }));
  const rebooted = s.create({ pid: 2000 });
  for (let attempt = 0; attempt < DELIVERY_FAILURE_LIMIT + 2; attempt += 1) await rebooted.tick();
  const state = s.state();
  check('12- a task waiting for the new process is never counted as a failure', state.tasks.some(t => t.id === taskId && t.status === 'armed' && t.error === undefined && t.failures === undefined), JSON.stringify(state.tasks));
  check('12- so it is neither delivered nor terminated, however long the wait', state.receipts.length === 0 && (state.terminated ?? []).length === 0 && s.delivered('R').length === 0, JSON.stringify({ receipts: state.receipts, terminated: state.terminated }));
});
await section('case 12 success is not termination', async () => {
  const s = scenario();
  s.add('R');
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  const folder = committed.helper.folder;
  const taskId = s.state().tasks.find(t => t.status === 'armed')?.id;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'old' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'running' }));
  const rebooted = s.create({ pid: 2000, probe: async () => ({ path: 'fixture-host', created: 'new' }) });
  await rebooted.tick();
  await rebooted.tick();
  const state = s.state();
  check('12- a task that succeeds is consumed as a delivery receipt', state.tasks.every(t => t.id !== taskId) && state.receipts.some(r => r.id === taskId && typeof r.delivered === 'number' && r.status === undefined && r.reason === undefined), JSON.stringify(state.receipts));
  check('12- a task that succeeds is never terminated', (state.terminated ?? []).length === 0 && s.delivered('R').length === 1, JSON.stringify({ terminated: state.terminated, delivered: s.delivered('R').length }));
});

/* ================================================================= case 13 =====
 * The broadcast goes to conversations CONFIRMED to be running, not to every conversation the host
 * happens to have loaded. Measured defect (2026-10-17): the component read \`agent.running\` /
 * \`agent.session.running\` — fields the host never sets — so every live conversation was labelled
 * 'live', became a participant, and was woken by a continuation after the restart. The host's own
 * predicate is \`agent.status === 'running'\` (dsh-agent's installTurnArchiveAdmission reads exactly
 * that). This case pins the narrow set end to end: participants, queued continuations, and the
 * delivery after the restart. */
await section('case 13', async () => {
  const s = scenario();
  s.add('R', { title: 'requester 对话' });                       // idle, but it is the one asking
  s.add('IDLE', { title: '闲着的对话' });                          // live, nothing in flight
  s.add('WORK', { title: '工作中的对话', running: true });
  const begun = await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const ids = begun.participants.map(p => p.sessionId).sort();
  check('13- only the running conversation and the requester are participants', begun.ok === true && ids.length === 2 && ids.includes('R') && ids.includes('WORK') && !ids.includes('IDLE'), JSON.stringify(begun.participants));
  check('13- the idle live conversation is not named in missing[] either', !begun.missing.some(m => m.sessionId === 'IDLE'), JSON.stringify(begun.missing));
  const waiting = s.state().tasks.filter(t => t.status === 'waiting');
  check('13- exactly one continuation per participant and none for the idle conversation', waiting.length === 2 && !waiting.some(t => t.destination === 'IDLE') && new Set(waiting.map(t => t.destination)).size === 2, JSON.stringify(waiting));
  const committed = await s.beat.commitBarrier({ intentId: begun.intentId }, s.exec('R'));
  check('13- the barrier still commits with the confirmed-running set only', committed.ok === true && committed.phase === 'committed' && committed.missing.length === 0, JSON.stringify({ ok: committed.ok, phase: committed.phase, missing: committed.missing }));
  committed.helper.commit();
  const folder = committed.helper.folder;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'old' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'running' }));
  const rebooted = s.create({ pid: 2000, probe: async () => ({ path: 'fixture-host', created: 'new' }) });
  await rebooted.tick();
  await rebooted.tick();
  check('13- after the restart the idle conversation was never woken', s.delivered('WORK').length === 1 && s.delivered('R').length === 1 && s.delivered('IDLE').length === 0, JSON.stringify({ R: s.delivered('R').length, WORK: s.delivered('WORK').length, IDLE: s.delivered('IDLE').length }));
});

/* ================================================================= case 14 =====
 * An UPDATE restart continues the conversations that are IN FLIGHT. It is issued by the panel or the
 * update route, so there is no requesting conversation; before this change nothing got a continuation
 * at all and in-flight work was silently killed (measured 2026-10-17). The predicate is the same one
 * the broadcast uses, so an idle-but-loaded conversation is still not woken. */
await section('case 14', async () => {
  const s = scenario();
  s.add('IDLE', { title: '闲着的对话' });
  s.add('WORK', { title: '工作中的对话', running: true });
  const prepared = await s.beat.prepare('0.3.17');
  const helper = await s.beat.restart(prepared.ticket, true);
  const queued = s.state().tasks.filter(t => t.status === 'waiting');
  const destinations = queued.map(t => t.destination);
  check('14- the update restart queues a continuation for the running conversation', destinations.includes('WORK'), JSON.stringify(destinations));
  check('14- the update restart does not wake the idle conversation', !destinations.includes('IDLE'), JSON.stringify(destinations));
  check('14- the companion update notice is still queued', destinations.includes('newmate'), JSON.stringify(destinations));
  check('14- it reports exactly which conversations it continued', Array.isArray(helper.continued) && helper.continued.includes('WORK') && !helper.continued.includes('IDLE'), JSON.stringify(helper.continued));
  helper.commit();
  const folder = helper.folder;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({ owner: { path: 'fixture-host', created: 'old' } }));
  fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify({ state: 'running' }));
  const rebooted = s.create({ pid: 2000, probe: async () => ({ path: 'fixture-host', created: 'new' }) });
  await rebooted.tick();
  await rebooted.tick();
  check('14- after the restart the in-flight conversation really was continued', s.delivered('WORK').length === 1 && s.delivered('IDLE').length === 0, JSON.stringify({ WORK: s.delivered('WORK').length, IDLE: s.delivered('IDLE').length }));
});

/* ================================================================= case 15 =====
 * A continuation restores the GOAL state, it does not assume it. A resumed session has its active
 * goal DISARMED by the host, so an agent that simply carries on stops being continued by its own
 * goal; a paused goal must stay paused. Both routes that enqueue a conversation continuation are
 * asserted against the same text, so neither can drift away from the other. */
await section('case 15', async () => {
  const s = scenario();
  s.add('R', { title: 'requester 对话' });
  s.add('WORK', { title: '工作中的对话', running: true });
  await s.beat.beginBarrier({ ackMode: 'auto' }, s.exec('R'));
  const text = String(s.state().tasks.find(t => t.destination === 'WORK')?.prompt ?? '');
  check('15- the broadcast continuation tells the resumed conversation to restore its goal', text.includes('get_goal') && text.includes('update_goal') && text.includes('resume') && text.includes('paused') && text.includes('disarmed'), JSON.stringify(text));
  check('15- it re-arms an active goal and leaves a paused one paused', text.includes('phase:"active"') && text.includes('phase:"paused"') && text.includes('不要 resume'), JSON.stringify(text));
  const s2 = scenario();
  s2.add('WORK2', { title: '工作中的对话', running: true });
  const prepared = await s2.beat.prepare('0.3.17');
  await s2.beat.restart(prepared.ticket, true);
  const updateText = String(s2.state().tasks.find(t => t.destination === 'WORK2')?.prompt ?? '');
  check('15- the update-path continuation carries the same goal-restore instruction', updateText === text && updateText !== '', JSON.stringify(updateText));
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