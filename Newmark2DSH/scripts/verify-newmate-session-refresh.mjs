import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate, NEWMATE_RUN_TOOLS, NEWMATE_REQUEST_TOOLS, newMateRunTools } from '../packages/newmark-core/components/newmate/component.js';
import { createSessionBridge, SESSION_TOOLS } from '../packages/newmark-core/components/newmate/lib/sessions.js';
import { SESSION_BUDGET, SESSION_HARD, SESSION_SUMMARY_MAX, sessionFacts, refreshDue, refreshForced, mechanicalSummary } from '../packages/newmark-core/components/newmate/lib/session-refresh.js';
import { newMateContext } from '../packages/newmark-core/lib/newmate-context.js';

/**
 * The gate for NewMate's own session management: refresh (handoff), resume, list and read, plus the
 * two budgets that decide when a handoff is due and when the runtime performs one itself.
 *
 * The assertions are written as the requirement, not as the implementation: "自主检查轮次也能交接",
 * "交接在本轮回复写入后才生效", "旧会话归档但完整可读", "到硬上限时运行时自己交接".
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-session-'));
let time = 10000000, checks = 0;
const check = (name, value) => { assert.ok(value, name); console.log('ok ' + (++checks) + ' - ' + name); };
const refused = (result, code) => Boolean(result) && result.ok === false && result.code === code;

// ---- the pure module: two thresholds and the mechanical digest ------------------------------
check('soft budget is bounded and smaller than the hard cap on both dimensions',
  SESSION_BUDGET.messages > 0 && SESSION_BUDGET.chars > 0 && SESSION_BUDGET.messages < SESSION_HARD.messages && SESSION_BUDGET.chars < SESSION_HARD.chars);
const factsOf = (messages, chars) => ({ messages, chars, title: '', active: true, archived: false, handoff: null });
const stateOf = (messages) => ({ activeThreadId: 'a', threads: [{ id: 'a', title: 't', created: 1, updated: 1 }], messages });
{
  const many = Array.from({ length: SESSION_BUDGET.messages }, (_, i) => ({ threadId: 'a', role: i % 2 ? 'assistant' : 'user', text: 'x' }));
  check('a session past the message budget is due, and the code names messages', refreshDue(stateOf(many), 'a').code === 'messages' && refreshDue(stateOf(many), 'a').due === true);
  const long = [{ threadId: 'a', role: 'user', text: 'y'.repeat(SESSION_BUDGET.chars) }];
  check('a session past the character budget is due, and the code names chars', refreshDue(stateOf(long), 'a').code === 'chars');
  const hard = Array.from({ length: SESSION_HARD.messages }, () => ({ threadId: 'a', role: 'user', text: 'z' }));
  check('the hard cap is a separate decision from the soft budget', refreshForced(stateOf(hard), 'a').forced === true && refreshDue(stateOf(hard), 'a').due === true);
  check('a short session is neither due nor forced', refreshDue(stateOf([{ threadId: 'a', role: 'user', text: 'hi' }]), 'a').due === false);
}
{
  const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '第' + i + '条 ' + 'q'.repeat(400) }));
  const digest = mechanicalSummary(messages, { messages: 4, perMessageChars: 20, chars: 400 });
  check('the mechanical digest says it is mechanical and not a model summary', /运行时机械交接/.test(digest) && /不是模型写的总结/.test(digest));
  check('the mechanical digest reports the turns it left out', /更早的 5[0-9] 条未包含/.test(digest));
  check('the mechanical digest is bounded by its own character budget', digest.length <= 400 + 120 && digest.split('\n').length >= 2);
}

// ---- the group: autonomous rounds get the tools ---------------------------------------------
check('the four session tools are NewMate run tools', SESSION_TOOLS.length === 4 && SESSION_TOOLS.every(name => NEWMATE_RUN_TOOLS.includes(name)));
check('they are NOT request-bound: an autonomous check-in may hand a session off', SESSION_TOOLS.every(name => !NEWMATE_REQUEST_TOOLS.includes(name)));
check('an automatic run is offered them', SESSION_TOOLS.every(name => newMateRunTools({ automatic: true }).includes(name)));
check('discovery comes first: the persona introduces list before the writes', SESSION_TOOLS[0] === 'newmate_session_list');
const dedup = new Set(NEWMATE_RUN_TOOLS);
check('the names are declared once', dedup.size === NEWMATE_RUN_TOOLS.length);

// ---- the bridge: strict schemas and named refusals ------------------------------------------
let mateRef = null;
const bridge = createSessionBridge({ services: { sessions: () => mateRef }, now: () => time });
check('four definitions, each strict and executable', bridge.definitions.length === 4 && bridge.definitions.every(tool => tool.parameters?.type === 'object' && tool.parameters.additionalProperties === false && typeof tool.execute === 'function'));
check('refresh requires a summary and no session id at all', JSON.stringify(bridge.definitions.find(tool => tool.name === 'newmate_session_refresh').parameters.required) === '["summary"]' && !('sessionId' in bridge.definitions.find(tool => tool.name === 'newmate_session_refresh').parameters.properties));
check('a host without the session store refuses by name', refused(await createSessionBridge({ services: {} }).list(), 'sessions_unavailable'));

// ---- a live component: what one session refresh actually does -------------------------------
const tools = { schemas: () => [], execute: async (call) => {
  if (call.name !== 'agent_api_send') throw Error('unexpected dispatch ' + call.name);
  const script = scripts.shift() || {};
  const prompts = script.prompts;
  if (prompts) prompts.push(call.arguments.prompt);
  if (script.call) await script.call(newMateContext());
  return { isError: false, value: { ok: true, result: { output: script.reply || '收到。' } } };
} };
const scripts = [];
const mate = createNewMate({ root: path.join(root, 'live'), now: () => time, agents: () => null, onNotify: async () => {}, tools });
mateRef = mate;
/** One user turn plus a stub answer, with an optional script for the stub (a tool call it makes). */
const turn = async (text, script = {}) => { scripts.push(script); mate.chat(text); await mate.tick(); };
await turn('第一段');
check('a fresh session lists itself as the active one', (() => { const list = mate.sessionList({ limit: 10 }); return list.ok && list.total === 1 && list.sessions[0].active === true && list.sessions[0].messages === 2; })());
check('a session id the store does not carry is a named refusal, never an empty transcript', (() => { try { mate.sessionRead({ sessionId: 'no-such-session' }); return false; } catch (error) { return error.code === 'unknown_session'; } })());
check('the tool refuses outside a run: there is no session context to hand off', refused(await bridge.refresh({ summary: '交接' }), 'no_session_context'));
check('the store refuses too: a handoff needs a turn that is still running', await (async () => { try { mate.sessionRefresh({ summary: '交接' }); return false; } catch (error) { return error.code === 'no_running_turn'; } })());
check('a summary longer than the bound is refused with its own code', refused(await bridge.refresh({ summary: 'x'.repeat(SESSION_SUMMARY_MAX + 1) }), 'summary_too_long'));
check('an empty session id is refused before the store is touched', refused(await bridge.read({ sessionId: '  ' }), 'invalid_session'));

// too short to carry anything: tested inside a turn, because that is the only place a handoff is legal
const shortRoot = path.join(root, 'short');
let shortCode = '';
const shortScripts = [];
const shortMate = createNewMate({ root: shortRoot, now: () => time, agents: () => null, onNotify: async () => {}, tools: { schemas: () => [], execute: async (call) => {
  const script = shortScripts.shift() || {};
  if (script.call) await script.call();
  return { isError: false, value: { ok: true, result: { output: '好。' } } };
} } });
shortMate.chat('一句话');
shortScripts.push({ call: async () => { try { shortMate.sessionRefresh({ summary: '交接' }); } catch (error) { shortCode = error.code; } } });
await shortMate.tick();
check('a session with fewer than four messages cannot be handed off', shortCode === 'session_too_short');
shortMate.stop();

// ---- the handoff: scheduled during the turn, performed after the reply ----------------------
await turn('铺垫一');
await turn('铺垫二');
let newSessionId = null;
let oldSessionId = null;
let handoff = null;
await turn('要继续的长工作', {
  reply: '好的，先交接再继续。',
  call: async (context) => {
    oldSessionId = context.session.id;
    handoff = await bridge.refresh({ summary: '目标：把 NewMate 的会话整理做完；已完成：会话工具与两档预算；未完成：门禁与回写。', title: '会话整理', reason: '换阶段' });
    check('the handoff is scheduled, not performed, while the turn is still running', handoff.ok === true && handoff.scheduled === true && mate.state().activeThreadId === oldSessionId);
  },
});
const afterHandoff = mate.state();
newSessionId = afterHandoff.activeThreadId;
check('the session changed at the turn boundary, not before it', newSessionId !== oldSessionId);
check('the answered exchange stayed whole in the session that asked for it', afterHandoff.messages.filter(message => message.threadId === oldSessionId).at(-1).text === '好的，先交接再继续。');
check('the old session is archived with a reason, never deleted', afterHandoff.threads.find(thread => thread.id === oldSessionId).archived === true && afterHandoff.threads.find(thread => thread.id === oldSessionId).archivedReason === 'refreshed');
check('the new session carries the handoff, its origin and the model as its author', (() => {
  const carried = afterHandoff.threads.find(thread => thread.id === newSessionId).carried;
  return carried.from === oldSessionId && carried.by === 'self' && carried.reason === '换阶段' && /未完成：门禁与回写/.test(carried.summary);
})());
check('the rotation is recorded with its own reason', afterHandoff.lastThreadRotation.from === oldSessionId && afterHandoff.lastThreadRotation.to === newSessionId && afterHandoff.lastThreadRotation.reason === 'self_refresh');
check('the task records which half happened', (() => { const task = afterHandoff.tasks.at(-1); return task.status === 'completed' && task.sessionChange.kind === 'refresh' && task.sessionChange.applied === true && task.sessionChange.to === newSessionId && task.sessionHandoff === undefined; })());
check('the old session is still readable in full', (() => { const read = mate.sessionRead({ sessionId: oldSessionId, limit: 40 }); return read.ok && read.archived === true && read.messages.at(-1).text === '好的，先交接再继续。'; })());
check('the new session starts empty and begins with the handoff, not with the transcript', mate.state().messages.filter(message => message.threadId === newSessionId).length === 0 && (() => {
  const read = mate.sessionRead({ sessionId: newSessionId });
  return read.ok && read.handoff.from === oldSessionId && /已完成：会话工具与两档预算/.test(read.handoff.summary);
})());

// the handoff reaches the next run's prompt as background, once
const nextPrompts = [];
await turn('接着做', { prompts: nextPrompts });
check('the next run in the new session is told where it came from', nextPrompts.length === 1 && new RegExp('本会话由上一个会话 ' + oldSessionId + ' 交接而来').test(nextPrompts[0]) && /已完成：会话工具与两档预算/.test(nextPrompts[0]));
check('the prompt states the session, its size, and both budgets', /会话：/.test(nextPrompts[0]) && /软预算 80 条/.test(nextPrompts[0]) && /硬上限 240 条/.test(nextPrompts[0]));

// ---- resume: an archived session can be brought back ----------------------------------------
await turn('回到上一段', { call: async () => { await bridge.resume({ sessionId: oldSessionId }); } });
const afterResume = mate.state();
check('resume takes effect at the turn boundary too', afterResume.activeThreadId === oldSessionId && afterResume.threads.find(thread => thread.id === newSessionId).archived === true);
check('the session a resume abandoned is archived with its own reason, kept readable', afterResume.threads.find(thread => thread.id === newSessionId).archivedReason === 'resumed_other' && mate.sessionRead({ sessionId: newSessionId }).ok === true);
check('the rotation reason distinguishes a resume from a handoff', afterResume.lastThreadRotation.reason === 'manual_resume');
check('resuming outside a running turn is refused: the switch has no boundary to wait for', refused(await bridge.resume({ sessionId: oldSessionId }), 'no_running_turn'));
let unknownResume = null;
await turn('试恢复一个不存在的会话', { call: async () => { unknownResume = await bridge.resume({ sessionId: 'gone' }); } });
check('a resume of an id that does not exist is a named refusal, not a silent no-op', refused(unknownResume, 'unknown_session'));

// ---- the identity guard: a session switch cannot target another session ---------------------
{
  const guardRoot = path.join(root, 'guard');
  const guardScripts = [];
  const guardMate = createNewMate({ root: guardRoot, now: () => time, agents: () => null, onNotify: async () => {}, tools: { schemas: () => [], execute: async (call) => {
    const script = guardScripts.shift() || {};
    if (script.call) await script.call(guardMate);
    return { isError: false, value: { ok: true, result: { output: '好。' } } };
  } } });
  const guardBridge = createSessionBridge({ services: { sessions: () => guardMate }, now: () => time });
  guardMate.chat('第一段'); await guardMate.tick();
  guardMate.chat('还没轮到'); const pending = guardMate.state().tasks.at(-1).id;
  guardMate.createThread();
  let code = '';
  guardScripts.push({ call: async () => { const result = await guardBridge.refresh({ summary: '交接' }); code = result.code; } });
  await guardMate.tick();
  check('a run whose session is no longer current cannot hand it off', code === 'session_changed' && guardMate.state().threads.filter(thread => thread.archived).length === 1);
  check('the guard leaves the pending task and the current session untouched', guardMate.state().tasks.find(task => task.id === pending).status === 'completed');
  guardMate.stop();
}

// ---- the soft budget: the prompt asks, the model may still finish ---------------------------
{
  const dueRoot = path.join(root, 'due');
  fs.mkdirSync(path.join(dueRoot, 'newMate'), { recursive: true });
  const thread = { id: 'long', title: '很长的会话', created: time - 1000, updated: time - 10, archived: false };
  const messages = Array.from({ length: SESSION_BUDGET.messages + 2 }, (_, index) => ({ id: 'm' + index, threadId: 'long', role: index % 2 ? 'assistant' : 'user', text: '第' + index + '条消息', at: time - 500 + index }));
  fs.writeFileSync(path.join(dueRoot, 'newMate', 'state.json'), JSON.stringify({ schema: 2, threads: [thread], activeThreadId: 'long', settings: { companion: false, notifications: false }, messages, tasks: [], measurements: {}, lastResponse: 0 }));
  const prompts = [];
  const dueMate = createNewMate({ root: dueRoot, now: () => time, agents: () => null, onNotify: async () => {}, tools: { schemas: () => [], execute: async (call) => { prompts.push(call.arguments.prompt); return { isError: false, value: { ok: true, result: { output: '好。' } } }; } } });
  dueMate.chat('继续'); await dueMate.tick();
  check('a session past the soft budget is told so in the run prompt', prompts.length === 1 && /已达软预算（消息条数）/.test(prompts[0]) && /newmate_session_refresh/.test(prompts[0]));
  check('the soft budget is a request: the turn still finished and nothing rotated', dueMate.state().tasks.at(-1).status === 'completed' && dueMate.state().activeThreadId === 'long' && dueMate.sessionStatus().due === 'messages');
  dueMate.stop();
}

// ---- the hard cap: the runtime hands off by itself, labelled as mechanical ------------------
{
  const hardRoot = path.join(root, 'hard');
  fs.mkdirSync(path.join(hardRoot, 'newMate'), { recursive: true });
  const thread = { id: 'huge', title: '没人管的会话', created: time - 10000, updated: time - 10, archived: false };
  const messages = Array.from({ length: SESSION_HARD.messages + 5 }, (_, index) => ({ id: 'm' + index, threadId: 'huge', role: index % 2 ? 'assistant' : 'user', text: '第' + index + '条 ' + 'q'.repeat(30), at: time - 9000 + index }));
  fs.writeFileSync(path.join(hardRoot, 'newMate', 'state.json'), JSON.stringify({ schema: 2, threads: [thread], activeThreadId: 'huge', settings: { companion: false, notifications: false }, messages, tasks: [], measurements: {}, lastResponse: 0 }));
  const hardMate = createNewMate({ root: hardRoot, now: () => time, agents: () => null, onNotify: async () => {}, tools: { schemas: () => [], execute: async () => ({ isError: false, value: { ok: true, result: { output: '好。' } } }) } });
  check('the component reports the hard cap before anything happens', hardMate.sessionStatus().forced === 'messages');
  await hardMate.tick();
  const rotated = hardMate.state();
  const carried = rotated.threads.find(entry => entry.id === rotated.activeThreadId).carried;
  check('an idle tick at the hard cap hands the session off by itself', rotated.threads.find(entry => entry.id === 'huge').archived === true && rotated.activeThreadId !== 'huge');
  check('the mechanical handoff is labelled as the runtime\'s, never the model\'s', carried.by === 'budget' && /运行时机械交接/.test(carried.summary) && rotated.lastThreadRotation.reason === 'budget_hard');
  check('the mechanical handoff is bounded like any other summary', carried.summary.length <= SESSION_SUMMARY_MAX);
  check('the session it replaced stays readable', hardMate.sessionRead({ sessionId: 'huge', limit: 5 }).messages.length === 5);
  // a queued turn must keep the session it was queued for
  const queuedRoot = path.join(root, 'queued');
  fs.mkdirSync(path.join(queuedRoot, 'newMate'), { recursive: true });
  const queuedThread = { id: 'busy', title: '有排队的会话', created: time - 1000, updated: time - 10, archived: false };
  const queuedMessages = Array.from({ length: SESSION_HARD.messages + 5 }, (_, index) => ({ id: 'q' + index, threadId: 'busy', role: 'user', text: '第' + index + '条', at: time - 900 + index }));
  fs.writeFileSync(path.join(queuedRoot, 'newMate', 'state.json'), JSON.stringify({ schema: 2, threads: [queuedThread], activeThreadId: 'busy', settings: { companion: false, notifications: false }, messages: queuedMessages, tasks: [{ id: 'pending-task', prompt: '排队中', destination: 'newmate', threadId: 'busy', status: 'pending', created: time - 5 }], measurements: {}, lastResponse: 0 }));
  const queuedMate = createNewMate({ root: queuedRoot, now: () => time, agents: () => null, onNotify: async () => {}, tools: { schemas: () => [], execute: async () => ({ isError: false, value: { ok: true, result: { output: '好。' } } }) } });
  const before = queuedMate.state().activeThreadId;
  await queuedMate.tick();
  check('a queued turn keeps its own session: no handoff happens under it', before === 'busy' && queuedMate.state().threads.filter(entry => entry.archived).length === 0);
  queuedMate.stop();
  hardMate.stop();
}

// ---- an automatic check-in sees the session it may manage ----------------------------------
{
  const autoRoot = path.join(root, 'auto');
  const autoPrompts = [], autoAllows = [];
  const autoMate = createNewMate({ root: autoRoot, now: () => time, agents: () => null, onNotify: async () => {}, environment: () => ({ ready: true, idleMs: 2 * 60000 }), tools: { schemas: () => [], execute: async (call) => {
    autoPrompts.push(call.arguments.prompt); autoAllows.push(call.arguments.tools?.allow || []);
    return { isError: false, value: { ok: true, result: { structured: { notify: false, text: '' } } } };
  } } });
  autoMate.chat('开始'); await autoMate.tick();
  await autoMate.configure({ companion: true, initiative: true });
  time += 60 * 60000;
  await autoMate.tick();
  const automatic = autoMate.state().tasks.find(task => task.kind === 'self_activation');
  check('an autonomous check-in ran and was offered the session tools', Boolean(automatic) && autoAllows.at(-1).includes('newmate_session_refresh') && autoAllows.at(-1).includes('newmate_session_list'));
  check('the autonomous run still withholds the request-bound tools', !autoAllows.at(-1).includes('computer_use') && !autoAllows.at(-1).includes('newmate_search'));
  check('the autonomous run prompt carries the session line too', /会话：/.test(autoPrompts.at(-1)));
  autoMate.stop();
}

/**
 * THE PROACTIVE HANDOFF: no user message is involved.
 *
 * The soft budget used to be a request printed into whatever turn came next, so a session nobody
 * talked into was never tidied. These assertions pin the autonomy: a quiet over-budget session is
 * refreshed by a maintenance turn that publishes nothing, a conversation in progress is not cut in
 * half for housekeeping, the switches still decide, and three silent failures fall back to the
 * mechanical handoff instead of asking a model forever.
 */
function seeded(root, messages, { companion = true, initiative = true, lastAt } = {}) {
  fs.mkdirSync(path.join(root, 'newMate'), { recursive: true });
  const thread = { id: 'long', title: '需要整理的会话', created: time - 100000, updated: time - 10, archived: false };
  const list = Array.from({ length: messages }, (_, index) => ({ id: 'm' + index, threadId: 'long', role: index % 2 ? 'assistant' : 'user', text: '第' + index + '条内容', at: (lastAt ?? time - 3 * 60 * 60000) - (messages - index) }));
  // The initiative check-in is pushed far into the future on purpose: these scenarios test the
  // MAINTENANCE path, and a scheduled check-in would take the tick's run slot instead.
  const initiativeState = { enabledAt: time, nextAttemptAt: time + 30 * 24 * 60 * 60000, lastUserAt: time - 3 * 60 * 60000, lastMessageAt: 0, unanswered: 0, attempts: 0, sent: 0, day: '', signals: [] };
  fs.writeFileSync(path.join(root, 'newMate', 'state.json'), JSON.stringify({ schema: 2, threads: [thread], activeThreadId: 'long', settings: { companion, initiative, notifications: false }, initiative: initiativeState, messages: list, tasks: [], measurements: {}, lastResponse: 0 }));
}
{
  const dir = path.join(root, 'proactive');
  seeded(dir, SESSION_BUDGET.messages + 2);
  const calls = [];
  const proactive = createNewMate({ root: dir, now: () => time, agents: () => null, environment: () => ({ ready: true, idleMs: 2 * 60000 }), onNotify: async () => {},
    tools: { schemas: () => [], execute: async (call) => { calls.push(call); const prompt = String(call.arguments.prompt || ''); if (/会话维护/.test(prompt)) { await createSessionBridge({ services: { sessions: () => proactive } }).refresh({ summary: '目标：把主动刷新做完；已完成：维护轮与工具；未完成：门禁。', title: '主动交接' }); } return { isError: false, value: { ok: true, result: { output: '已交接。' } } }; } } });
  const before = proactive.state().messages.length;
  time += 5 * 60000;
  await proactive.tick();
  const after = proactive.state();
  check('a quiet session past the soft budget is refreshed without any user message', after.activeThreadId !== 'long' && after.threads.find(thread => thread.id === 'long').archived === true);
  check('the maintenance turn is its own task kind, not a chat and not a check-in', calls.length === 1 && after.tasks.at(-1).kind === 'session_refresh' && after.tasks.at(-1).maintenance.refreshed === true);
  const allow = calls[0].arguments.tools.allow;
  check('the maintenance turn is offered the session tools and no request-bound ones', allow.includes('newmate_session_refresh') && allow.includes('newmate_session_list') && !allow.includes('computer_use') && !allow.includes('newmate_search') && !allow.includes('newmate_ask'));
  check('a maintenance turn publishes nothing: neither a reply nor a status bubble', after.messages.length === before);
  check('the next session starts with the summary the maintenance turn wrote', after.threads.find(thread => thread.id === after.activeThreadId).carried.by === 'self' && /未完成：门禁/.test(after.threads.find(thread => thread.id === after.activeThreadId).carried.summary));
  proactive.stop();
}
{
  const dir = path.join(root, 'busy-talk');
  seeded(dir, SESSION_BUDGET.messages + 2, { lastAt: time - 5 * 60000 });
  let calls = 0;
  const talking = createNewMate({ root: dir, now: () => time, agents: () => null, environment: () => ({ ready: true, idleMs: 2 * 60000 }), onNotify: async () => {},
    tools: { schemas: () => [], execute: async () => { calls += 1; return { isError: false, value: { ok: true, result: { output: '好。' } } }; } } });
  time += 5 * 60000;
  await talking.tick();
  check('a conversation in progress is not cut in half for housekeeping', calls === 0 && talking.state().activeThreadId === 'long');
  talking.stop();
}
{
  const dir = path.join(root, 'switched-off');
  seeded(dir, SESSION_BUDGET.messages + 2, { companion: false });
  let calls = 0;
  const off = createNewMate({ root: dir, now: () => time, agents: () => null, environment: () => ({ ready: true, idleMs: 2 * 60000 }), onNotify: async () => {},
    tools: { schemas: () => [], execute: async () => { calls += 1; return { isError: false, value: { ok: true, result: { output: '好。' } } }; } } });
  time += 5 * 60000;
  await off.tick();
  check('the switches still decide: with the companion off, no maintenance turn is started', calls === 0 && off.state().activeThreadId === 'long');
  off.stop();
}
{
  const dir = path.join(root, 'maintenance-fails');
  seeded(dir, SESSION_BUDGET.messages + 2);
  let calls = 0;
  const failing = createNewMate({ root: dir, now: () => time, agents: () => null, environment: () => ({ ready: true, idleMs: 2 * 60000 }), onNotify: async () => {},
    tools: { schemas: () => [], execute: async () => { calls += 1; return { isError: false, value: { ok: true, result: { output: '已查看，不需要交接。' } } }; } } });
  time += 5 * 60000;
  await failing.tick();
  for (let index = 0; index < 3; index += 1) { time += 3 * 60 * 60000; await failing.tick(); }
  const state = failing.state();
  const carried = state.threads.find(thread => thread.id === state.activeThreadId).carried;
  check('three maintenance turns that produce no summary fall back to the mechanical handoff', calls === 3 && state.activeThreadId !== 'long' && carried.by === 'budget' && /运行时机械交接/.test(carried.summary));
  check('the fallback is recorded as such, and the failure counter is reset', state.lastThreadRotation.reason === 'maintenance_failed' && Number(state.initiative.sessionRefreshFailures) === 0);
  failing.stop();
}

{
  // Measured on the live host 2026-11-01: the first shipped version required environment() to be
  // ready and un-busy, and therefore never ran (busy is true whenever ANY conversation runs; ready
  // needs the desktop pet live). Housekeeping must not hire the attention gates.
  const dir = path.join(root, 'hostile-environment');
  seeded(dir, SESSION_BUDGET.messages + 2);
  let calls = 0;
  const hostile = createNewMate({ root: dir, now: () => time, agents: () => null, environment: () => ({ ready: false, busy: true, idleMs: 0, readerFocused: true }), onNotify: async () => {},
    tools: { schemas: () => [], execute: async (call) => {
      calls += 1;
      if (/会话维护/.test(String(call.arguments.prompt || ''))) await createSessionBridge({ services: { sessions: () => hostile } }).refresh({ summary: '目标：验证家务闸不看打扰闸。' });
      return { isError: false, value: { ok: true, result: { output: '已交接。' } } };
    } } });
  time += 5 * 60000;
  await hostile.tick();
  check('maintenance does not wait for the desktop, the reader or another conversation being busy', calls === 1 && hostile.state().activeThreadId !== 'long');
  hostile.stop();
}

// ---- the streaming contract: private registration, not a global tool -----------------------
{
  const mounted = new Map(), registered = new Map(), disposers = [];
  const core = {};
  const ctx = {
    effect(callback) { const disposer = callback(); if (typeof disposer === 'function') disposers.push(disposer); return disposer; },
    tools: { schemas: () => [], register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); }, execute: async () => ({ isError: false, value: {} }) },
    webServer: { register() { return () => {}; }, tapIndex() {} },
    get(name) { return name === 'newmarkComponents' ? core : undefined; },
    logger: { warn() {}, error() {}, info() {} },
  };
  const row = await import(new URL('../packages/newmark-core/components/newmate/index.js', import.meta.url).href + '?mount=session-gate');
  row.apply(ctx, { root: path.join(root, 'mount') });
  const priv = globalThis[Symbol.for('newmark.newmate.privateTools')] || {};
  check('the mounted row publishes the four session tools privately', SESSION_TOOLS.every(name => priv[name]?.name === name));
  check('and registers none of them in the global tool registry', SESSION_TOOLS.every(name => !registered.has(name)));
  check('the mounted row\'s session tools act on the mounted companion', (await priv.newmate_session_list.execute({ limit: 5 })).ok === true);
  for (const dispose of disposers) { try { dispose(); } catch { /* teardown is best effort */ } }
  mounted.clear();
}

console.log('PASS ' + checks + ' NewMate session refresh checks');
