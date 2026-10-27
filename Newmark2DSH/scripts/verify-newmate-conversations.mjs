import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationBridge, CONVERSATION_TOOLS } from '../packages/newmark-core/components/newmate/lib/conversations.js';
import { NEWMATE_RUN_TOOLS, NEWMATE_REQUEST_TOOLS } from '../packages/newmark-core/components/newmate/component.js';
import { withNewMateContext } from '../packages/newmark-core/lib/newmate-context.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-conversations-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
let checks = 0;
const check = (label, value) => { assert.ok(value, label); checks += 1; console.log('ok ' + checks + ' - ' + label); };
const refused = (result, code) => result && result.ok === false && result.code === code;

// ---- fakes: the three services the bridge reads, recorded so ordering is measurable ----
const order = [];
const makeAgent = (id, { events = [], cwd = workspace, noFlush = false } = {}) => ({
  session: { header: { id, cwd }, requestHeader: () => ({}), snapshotEvents: () => events },
  options: { provider: 'fixture', model: 'fixture' },
  ctx: { get: (name) => (name === 'sessions' && !noFlush ? { flush: async () => { order.push('flush:' + id); return true; } } : undefined) },
  followup: async (message) => { order.push('followup:' + id); return message; },
});
let failNextDelivery = false;
const live = new Map();
const created = [];
const agents = {
  create: async (options) => {
    created.push(options);
    order.push('create:' + options.sessionId);
    // The host awaits setup BEFORE publication; the fixture must do the same or a preset that is
    // only ever mounted in setup would look recorded-but-unmounted.
    if (typeof options.setup === 'function') await options.setup({ get: () => undefined });
    const agent = makeAgent(options.sessionId, { cwd: options.meta.cwd, noFlush: failNextDelivery });
    failNextDelivery = false;
    live.set(options.sessionId, agent);
    return { agent, dispose: async () => { order.push('dispose:' + options.sessionId); live.delete(options.sessionId); } };
  },
  get: (id) => live.get(id),
};
const mounted = [];
const presets = { defaultId: 'dev', mount: async (ctx, id) => { mounted.push(id); return { id }; } };
const attached = [];
const workspaces = { list: async () => [{ path: workspace }], resolveByPath: async (p) => ({ path: p, attachSession: async (id) => { attached.push(id); order.push('attach:' + id); } }) };
const persisted = new Map();
let loads = 0;
const persistence = {
  // inspect() is the read-only path; load() commits cold recovery, so a transcript read must use
  // inspect when the host has it. The counter proves which one the bridge reached for.
  inspect: async (id) => { const entry = persisted.get(id); if (!entry) throw Error('missing session ' + id); return entry; },
  load: async (id) => { loads += 1; const entry = persisted.get(id); if (!entry) throw Error('missing session ' + id); return entry; },
};
let paused = false;
const goals = { get: () => ({ phase: paused ? 'paused' : 'active' }) };

// The bridge reads every service through a getter: a host that lacks one must be a refusal, not a
// mount failure, so the closures are the contract (index.js passes ctx.get lookups the same way).
let bundledModel = { provider: 'fixture', model: 'fixture' };
const build = (extra = {}) => createConversationBridge({ services: { agents: () => agents, presets: () => presets, workspaces: () => workspaces, persistence: () => persistence, goals: () => goals, model: () => bundledModel, ...extra } });
const bridge = build();

// ---- the group and the exposure --------------------------------------------------------
check('the three conversation tools are declared once, as NewMate run tools', CONVERSATION_TOOLS.every((name) => NEWMATE_RUN_TOOLS.includes(name)) && CONVERSATION_TOOLS.length === 3);
check('they are not request-bound: an autonomous NewMate turn may also start or address a conversation', CONVERSATION_TOOLS.every((name) => !NEWMATE_REQUEST_TOOLS.includes(name)));
check('each definition carries a strict parameter schema', bridge.definitions.length === 3 && bridge.definitions.every((tool) => CONVERSATION_TOOLS.includes(tool.name) && tool.parameters?.type === 'object' && tool.parameters.additionalProperties === false && typeof tool.execute === 'function'));

// ---- create ---------------------------------------------------------------------------
const first = await bridge.create({ prompt: '梳理这个仓库的记忆结构' });
check('a new conversation is created under a fresh id in the requested workspace', first.ok === true && typeof first.sessionId === 'string' && first.cwd === fs.realpathSync(workspace));
check('the preset is recorded on the session metadata and mounted before publication', created[0].meta.agentPreset === 'dev' && mounted[0] === 'dev' && typeof created[0].setup === 'function');
const firstSplice = order.indexOf('create:' + first.sessionId);
check('the first message is delivered through the same runner contract as newmate_task', order.includes('followup:' + first.sessionId) && order.includes('flush:' + first.sessionId));
check('a created conversation carries an explicit model selection', created[0].agentOptions?.provider === 'fixture' && created[0].agentOptions?.model === 'fixture');
check('the conversation is added to its workspace only after its first message crossed the barrier, so a failed delivery never publishes an empty one', order.indexOf('attach:' + first.sessionId) > order.indexOf('flush:' + first.sessionId) && attached[0] === first.sessionId);
check('the returned id is the one the host created, and the bridge retains its handle', bridge.created().includes(first.sessionId) && live.has(first.sessionId));

const relative = await bridge.create({ prompt: 'x', cwd: 'relative/path' });
check('a relative workspace is refused rather than resolved against an unknown root', refused(relative, 'workspace_invalid'));
const missing = await bridge.create({ prompt: 'x', cwd: path.join(root, 'nope') });
check('a missing workspace is refused by name', refused(missing, 'workspace_missing'));
const empty = await bridge.create({ prompt: '   ' });
check('an empty first message is refused', refused(empty, 'invalid_prompt'));
failNextDelivery = true;
const undelivered = await bridge.create({ prompt: '首条消息无法越过屏障' });
check('a conversation whose first message could not be delivered is reported and not attached to the workspace', refused(undelivered, 'delivery_failed') && !attached.includes(undelivered.sessionId) && !bridge.created().includes(undelivered.sessionId));
const noModel = await build({ model: () => undefined }).create({ prompt: 'x', cwd: workspace });
check('a host with no authorisable model refuses instead of creating an undeliverable conversation', refused(noModel, 'model_unavailable') && live.size === 1);
const noAgents = await build({ agents: () => undefined }).create({ prompt: 'x', cwd: workspace });
check('a host without the agents service refuses instead of throwing', refused(noAgents, 'agents_unavailable'));

// Default workspace: inherited from the run's own conversation, never guessed from process.cwd().
const other = path.join(root, 'other');
fs.mkdirSync(other, { recursive: true });
const inherited = await withNewMateContext({ conversation: { origin: 'parent-session', cwd: other, preset: 'rDev', model: { provider: 'fixture', model: 'fixture' } } }, () => bridge.create({ prompt: '继承工作区' }));
check('without an explicit cwd the new conversation inherits the requesting conversation workspace', inherited.cwd === fs.realpathSync(other) && persistedSize() === 0);
check('the inherited preset and model selection are used, not a hardcoded default', created.at(-1).meta.agentPreset === 'rDev' && created.at(-1).agentOptions?.model === 'fixture');
function persistedSize() { return persisted.size; }

// ---- send -----------------------------------------------------------------------------
const sent = await bridge.send({ sessionId: first.sessionId, prompt: '请在这里继续' });
check('a message to an existing conversation carries a stable runner identity', sent.ok === true && sent.messageId.startsWith('newmark-task:'));
const self = await withNewMateContext({ conversation: { origin: first.sessionId } }, () => bridge.send({ sessionId: first.sessionId, prompt: 'x' }));
check('addressing the conversation that is currently running is refused', refused(self, 'self_target'));
paused = true;
const pausedSend = await withNewMateContext({ conversation: { origin: 'elsewhere' } }, () => bridge.send({ sessionId: first.sessionId, prompt: 'x' }));
check('a conversation the user paused is not woken by a delivery', refused(pausedSend, 'target_paused'));
paused = false;
const unknown = await bridge.send({ sessionId: 'not-a-real-session', prompt: 'x' });
check('a delivery to a conversation that cannot be resumed is reported, not claimed', refused(unknown, 'delivery_failed'));

// ---- read -----------------------------------------------------------------------------
const readEvents = [
  { type: 'session', data: {} },
  { type: 'user/message', time: 1, data: { id: 'u1', content: [{ type: 'text', text: '用户的问题一' }], source: { kind: 'user' } } },
  { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'reasoning', text: '内部思考不应出现' }, { type: 'tool-call', name: 'pwsh' }, { type: 'text', text: '助手的回答一' }] } } },
  { type: 'user/message', time: 3, data: { id: 'u2', content: [{ type: 'text', text: '用户的问题二' }], source: { kind: 'cordis-host-runner' } } },
  { type: 'assistant/message', time: 4, data: { message: { content: [{ type: 'text', text: '助手的回答二' }] } } },
];
live.get(first.sessionId).session.snapshotEvents = () => readEvents;
const read = await bridge.read({ sessionId: first.sessionId, limit: 10 });
check('a live conversation is read without resuming it', read.ok === true && read.from === 'live' && read.cwd === fs.realpathSync(workspace));
check('only user and assistant text is returned: no reasoning, no tool calls', read.messages.length === 4 && read.messages.map((m) => m.text).join('|') === '用户的问题一|助手的回答一|用户的问题二|助手的回答二' && !JSON.stringify(read).includes('内部思考'));
check('the message origin is reported so a runner-injected message is not read as the user', read.messages[2].source === 'cordis-host-runner' && read.messages[0].source === 'user');
const bounded = await bridge.read({ sessionId: first.sessionId, limit: 2 });
check('the newest messages win and the drop is reported rather than hidden', bounded.messages.length === 2 && bounded.messages[0].text === '用户的问题二' && bounded.truncated.messages === true && bounded.truncated.droppedMessages === 2);
const clamped = await bridge.read({ sessionId: first.sessionId, limit: 10000, maxChars: 100000 });
check('an oversized request is clamped to the documented bounds', clamped.ok === true && clamped.messages.length <= 4);
persisted.set('persisted-session', { meta: { id: 'persisted-session', cwd: workspace, createdAt: 7, title: '历史对话' }, events: readEvents });
const fromDisk = await bridge.read({ sessionId: 'persisted-session' });
check('a conversation that is not live is read from persistence instead', fromDisk.ok === true && fromDisk.from === 'persisted' && fromDisk.title === '历史对话' && fromDisk.messages.length === 4);
check('the read-only inspect path is preferred over load, which would commit a recovery write', loads === 0);
const absent = await bridge.read({ sessionId: 'never-existed' });
check('an unknown conversation is refused rather than returning an empty transcript', refused(absent, 'unknown_conversation'));

// ---- teardown -------------------------------------------------------------------------
const ids = bridge.created();
const stopped = await bridge.stop();
check('teardown disposes exactly the conversations this bridge created', stopped === ids.length && bridge.created().length === 0 && ids.every((id) => !live.has(id)));

console.log('SUMMARY passed=' + checks + ' failed=0 total=' + checks);
