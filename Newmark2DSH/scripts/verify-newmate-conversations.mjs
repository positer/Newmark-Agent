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

// ---- fakes: the services the bridge reads, recorded so ordering is measurable ----
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
  list: () => [...live.values()],
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

/**
 * The host's unified session query, modelled on the contract DSH actually declares -
 * sessionQuery.listSessions / readSession / readTitleSnapshots / readTitle - rather than on
 * anything the bridge wishes existed. The counters prove a listing reads no transcript.
 */
const corpus = new Map();
let listSessionsCalls = 0;
let readSessionCalls = 0;
const titleFolds = new Map();
const sessionQuery = {
  listSessions: async () => { listSessionsCalls += 1; return [...corpus.values()].map((entry) => ({ header: entry.session, live: false, persisted: true })); },
  readSession: async (id) => { readSessionCalls += 1; const entry = corpus.get(id); if (!entry) throw Error('missing session ' + id); return { session: entry.session, inheritedEventCount: 0, events: entry.events }; },
  readTitle: async (id) => titleFolds.has(id) ? { title: titleFolds.get(id), messageSeqs: [], source: 'user', eventSeq: 1, updatedAt: 1 } : undefined,
  readTitleSnapshots: async (ids) => ids.map((id) => titleFolds.has(id) ? { sessionId: id, status: 'fulfilled', value: { session: { id }, title: { title: titleFolds.get(id), messageSeqs: [], source: 'auto', eventSeq: 1, updatedAt: 1 } } } : { sessionId: id, status: 'fulfilled', value: { session: { id } } }),
};
let paused = false;
const goals = { get: () => ({ phase: paused ? 'paused' : 'active' }) };

// The bridge reads every service through a getter: a host that lacks one must be a refusal, not a
// mount failure, so the closures are the contract (index.js passes ctx.get lookups the same way).
let bundledModel = { provider: 'fixture', model: 'fixture' };
const build = (extra = {}) => createConversationBridge({ services: { agents: () => agents, presets: () => presets, workspaces: () => workspaces, persistence: () => persistence, sessionQuery: () => sessionQuery, goals: () => goals, model: () => bundledModel, ...extra } });
const bridge = build();

// ---- the group and the exposure --------------------------------------------------------
check('the four conversation tools are declared once, as NewMate run tools', CONVERSATION_TOOLS.every((name) => NEWMATE_RUN_TOOLS.includes(name)) && CONVERSATION_TOOLS.length === 4);
check('they are not request-bound: an autonomous NewMate turn may also list, start or address a conversation', CONVERSATION_TOOLS.every((name) => !NEWMATE_REQUEST_TOOLS.includes(name)));
check('each definition carries a strict parameter schema', bridge.definitions.length === 4 && bridge.definitions.every((tool) => CONVERSATION_TOOLS.includes(tool.name) && tool.parameters?.type === 'object' && tool.parameters.additionalProperties === false && typeof tool.execute === 'function'));
check('discovery is the first name the persona introduces: an id a model cannot see is an id it has to invent', CONVERSATION_TOOLS[0] === 'newmate_conversation_list');

// ---- list -----------------------------------------------------------------------------
const sessionHeader = (id, createdAt, cwd = workspace, extra = {}) => ({ version: 'v4', id, createdAt, cwd, isSeeded: false, ...extra });
corpus.set('older-session', { session: sessionHeader('older-session', 5), events: [] });
corpus.set('newest-session', { session: sessionHeader('newest-session', 9, workspace, { agentPreset: 'rDev' }), events: [] });
corpus.set('middle-session', { session: sessionHeader('middle-session', 3), events: [] });
titleFolds.set('newest-session', '这两天的 DSH 对话');
titleFolds.set('older-session', '较早的一条');

const listed = await bridge.list();
check('the corpus is listed without opening a single transcript', listed.ok === true && listed.source === 'corpus' && readSessionCalls === 0 && listSessionsCalls === 1);
check('newest creation first, and every row carries the id the other tools need', listed.conversations.map((row) => row.sessionId).join(',') === 'newest-session,older-session,middle-session');
check('a title the host folded is reported, and a session with no title reports null rather than an invented one', listed.conversations[0].title === '这两天的 DSH 对话' && listed.conversations[2].title === null);
check('the row carries workspace, creation time, liveness and the preset when the header has one', listed.conversations[0].cwd === workspace && listed.conversations[0].createdAt === 9 && listed.conversations[0].live === false && listed.conversations[0].persisted === true && listed.conversations[0].agentPreset === 'rDev');
check('nothing is marked self when the run is bound to no conversation', listed.conversations.every((row) => row.self === false));
const selfList = await withNewMateContext({ conversation: { origin: 'older-session' } }, () => bridge.list());
check('the conversation this run answers in is marked self, so the model can see what it must not address', selfList.conversations.find((row) => row.sessionId === 'older-session').self === true && selfList.conversations.find((row) => row.sessionId === 'newest-session').self === false);

const paged = await bridge.list({ limit: 2 });
check('a page reports the corpus size it left out instead of implying it saw everything', paged.conversations.length === 2 && paged.returned === 2 && paged.total === 3 && paged.truncated === true);
const clampedList = await bridge.list({ limit: 100000 });
check('an oversized page request is clamped to the documented bound', clampedList.ok === true && clampedList.conversations.length === 3);
const defaulted = await bridge.list({ limit: 'lots' });
check('a non-integer page request falls back to the default instead of throwing', defaulted.ok === true && defaulted.conversations.length === 3);

const liveOnly = await build({ sessionQuery: () => undefined }).list();
check('a host older than the session query lists its LIVE agents and says which source answered', liveOnly.ok === true && liveOnly.source === 'live' && liveOnly.conversations.every((row) => row.live === true && row.persisted === false));
const noSource = await build({ sessionQuery: () => undefined, agents: () => undefined }).list();
check('a host with neither source refuses by name rather than returning an empty list', refused(noSource, 'agents_unavailable'));
const brokenList = await build({ sessionQuery: () => ({ listSessions: async () => { throw Error('corpus offline'); } }) }).list();
check('a corpus that cannot be listed is refused by name, not reported as no conversations', refused(brokenList, 'list_unavailable') && brokenList.error.includes('corpus offline'));
const noTitles = await build({ sessionQuery: () => ({ listSessions: sessionQuery.listSessions }) }).list();
check('a host without the title fold still lists, with null titles', noTitles.ok === true && noTitles.conversations.every((row) => row.title === null));

// ---- create ---------------------------------------------------------------------------
const first = await bridge.create({ prompt: '梳理这个仓库的记忆结构' });
check('a new conversation is created under a fresh id in the requested workspace', first.ok === true && typeof first.sessionId === 'string' && first.cwd === fs.realpathSync(workspace));
check('the preset is recorded on the session metadata and mounted before publication', created[0].meta.agentPreset === 'dev' && mounted[0] === 'dev' && typeof created[0].setup === 'function');
check('the first message is delivered through the same runner contract as newmate_task', order.includes('followup:' + first.sessionId) && order.includes('flush:' + first.sessionId));
check('a created conversation carries an explicit model selection', created[0].agentOptions?.provider === 'fixture' && created[0].agentOptions?.model === 'fixture');
check('the conversation is added to its workspace only after its first message crossed the barrier, so a failed delivery never publishes an empty one', order.indexOf('attach:' + first.sessionId) > order.indexOf('flush:' + first.sessionId) && attached[0] === first.sessionId);
check('the returned id is the one the host created, and the bridge retains its handle', bridge.created().includes(first.sessionId) && live.has(first.sessionId));
const afterCreate = await build({ sessionQuery: () => undefined }).list();
check('a conversation this bridge created is listed by the live-agent source, so the id it just returned is discoverable', afterCreate.conversations.some((row) => row.sessionId === first.sessionId && row.live === true));

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

// A conversation that is NOT live: the host's own read, plus the title fold the contract declares.
corpus.get('older-session').events = readEvents;
const fromCorpus = await bridge.read({ sessionId: 'older-session' });
check('a conversation that is not live is read through the host session query instead', fromCorpus.ok === true && fromCorpus.from === 'persisted' && fromCorpus.title === '较早的一条' && fromCorpus.messages.length === 4);
check('the corpus read is the replay-validated one, and no legacy recovery path was used', readSessionCalls === 1 && loads === 0);
const absent = await bridge.read({ sessionId: 'never-existed' });
check('an unknown conversation is refused rather than returning an empty transcript', refused(absent, 'unknown_conversation'));

// Legacy host: no sessionQuery at all, so the pre-existing persistence pair must still work - and
// the read-only inspect must be preferred over load, which would commit a recovery write.
persisted.set('persisted-session', { meta: { id: 'persisted-session', cwd: workspace, createdAt: 7, title: '历史对话' }, events: readEvents });
const legacyBridge = build({ sessionQuery: () => undefined });
const fromDisk = await legacyBridge.read({ sessionId: 'persisted-session' });
check('a host older than the session query is still read from persistence, heading preserved', fromDisk.ok === true && fromDisk.from === 'persisted' && fromDisk.title === '历史对话' && fromDisk.messages.length === 4);
check('the read-only inspect path is preferred over load, which would commit a recovery write', loads === 0);
const persistless = await build({ sessionQuery: () => undefined, persistence: () => undefined });
const noStore = await persistless.read({ sessionId: 'persisted-session' });
check('a host with neither a corpus nor persistence refuses the read by name', refused(noStore, 'unknown_conversation'));

// ---- teardown -------------------------------------------------------------------------
const ids = bridge.created();
const stopped = await bridge.stop();
check('teardown disposes exactly the conversations this bridge created', stopped === ids.length && bridge.created().length === 0 && ids.every((id) => !live.has(id)));

console.log('SUMMARY passed=' + checks + ' failed=0 total=' + checks);
