/**
 * NewMate — the ComputerUse permission and the live agent-loop status.
 *
 * Two things changed together in 0.3.21, and they are one feature rather than two. NewMate may
 * now drive the same ComputerUse tools a conversation does, which is exactly the capability that
 * makes its silent agent loop a problem: a run that takes a desktop lease, clicks, and only
 * explains itself when it ends cannot be watched. So the permission and the live view are
 * asserted here, against the code that runs, in one gate.
 *
 * WHAT IS ASSERTED, and why each half can fail on its own:
 *
 *   permission      the group carries both tools; a user-initiated turn is offered them; an
 *                   autonomous check-in is not. The condition is asserted as the ALLOW LIST the
 *                   dispatch actually carries, not as a constant, because a constant that a run
 *                   never reads grants nothing.
 *   identity        a ComputerUse action taken inside a NewMate run resolves to the stable
 *                   `newmate` owner, while the requesting conversation's identity is still
 *                   visible for origin tracking. Those two must not be the same string: the
 *                   lease is released by its owner, so borrowing the conversation's identity
 *                   would let it end, and confuse, work it did not start.
 *   release         a run that used `computer_use` releases both lease slots before the task
 *                   settles; a run that did not touch it issues no release at all. The lease has
 *                   no expiry, so "the model will remember to stop" is not a bound.
 *   live view       the events agent-api puts in its receipt reach the recorder AS THEY HAPPEN,
 *                   the snapshot names the run's phase/turn/current tool, the ring is bounded,
 *                   and the last finished run stays readable instead of vanishing.
 *   surfaces        the real GET /newmark-newmate route, the `newmate_state` tool and the MCP
 *                   `newmate_task_status` all answer from the same `loopStatus()`, so the page
 *                   and an external agent cannot be told different stories.
 *   seam            the real agent-api loop is driven with a fake model and a NewMate context
 *                   installed, and the events it forwards are byte-identical to the ones in its
 *                   own receipt — the live half is not a second description that can drift.
 *
 * Run: node Newmark2DSH/scripts/verify-newmate-agent-loop.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNewMate, NEWMATE_RUN_TOOLS, NEWMATE_CU_TOOLS, NEWMATE_CU_OWNER, NEWMATE_REQUEST_TOOLS, newMateRunTools } from '../packages/newmark-core/components/newmate/component.js';
import { createNewMateSearch, NEWMATE_SEARCH_TOOL, SEARCH_MAX_QUERIES, SEARCH_MAX_RESULTS } from '../packages/newmark-core/components/newmate/lib/web-search.js';
import { createMemoryContext } from '../packages/newmark-core/components/newmate/lib/memory-context.js';
import { createNewMateMcp } from '../packages/newmark-core/components/newmate/lib/mcp.js';
import { createAgentApi, eventView, THINKING_LIVE_LIMIT } from '../packages/newmark-core/components/agent-api/component.js';
import { computerUseCaller, computerUseOwner, withComputerUseOwner } from '../packages/newmark-core/lib/cu-caller.js';
import { newMateContext, withNewMateContext } from '../packages/newmark-core/lib/newmate-context.js';
import { callRoute } from './lib/mount-newmark-core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmate-agent-loop-'));
const clock = Date.parse('2026-10-21T02:00:00Z');
let checks = 0;
const check = (label, value) => { assert.ok(value, label); console.log(`ok ${++checks} - ${label}`); };
const until = async (predicate) => { for (let i = 0; i < 200; i += 1) { if (predicate()) return true; await new Promise((resolve) => setTimeout(resolve, 10)); } return false; };

try {
  /* ------------------------------------------------------------ the permission --- */

  check('the run group carries both ComputerUse tools', NEWMATE_CU_TOOLS.every((name) => NEWMATE_RUN_TOOLS.includes(name)));
  check('the group still carries no deletion and no recursive Agent API', !NEWMATE_RUN_TOOLS.includes('memory_lab_delete') && !NEWMATE_RUN_TOOLS.includes('agent_api_send') && !NEWMATE_RUN_TOOLS.includes('run_code'));
  check('the group carries the native-search tool, and it is request-bound like the desktop tools', NEWMATE_RUN_TOOLS.includes(NEWMATE_SEARCH_TOOL) && NEWMATE_REQUEST_TOOLS.includes(NEWMATE_SEARCH_TOOL));
  check('a user-initiated turn is offered native search and an autonomous check-in is not', newMateRunTools({}).includes(NEWMATE_SEARCH_TOOL) && !newMateRunTools({ automatic: true }).includes(NEWMATE_SEARCH_TOOL));
  check('a user-initiated turn is offered both desktop tools', newMateRunTools({}).includes('computer_use') && newMateRunTools({}).includes('screen_capture'));
  check('a scheduled todo activation, which the user asked for, is offered them too', newMateRunTools({ automatic: false, origin: 'origin-session' }).includes('computer_use') && newMateRunTools({ automatic: false, origin: 'origin-session' }).includes('screen_capture'));
  check('an autonomous check-in is offered neither desktop tool', !newMateRunTools({ automatic: true }).includes('computer_use') && !newMateRunTools({ automatic: true }).includes('screen_capture'));
  check('only a turn bound to an origin conversation adds newmate_task', !newMateRunTools({}).includes('newmate_task') && newMateRunTools({ origin: 'session-1' }).includes('newmate_task') && !newMateRunTools({ automatic: true, origin: 'session-1' }).includes('newmate_task'));

  const group = createMemoryContext(path.join(root, 'group'), () => clock, {
    toolSchemas: () => ({ schemas: NEWMATE_RUN_TOOLS.map((name) => ({ name, parameters: { type: 'object', properties: {} } })), names: NEWMATE_RUN_TOOLS }),
  })();
  check('the initialization tool group describes both desktop tools and native search', group.tools.some((tool) => tool.name === 'computer_use') && group.tools.some((tool) => tool.name === 'screen_capture') && group.tools.some((tool) => tool.name === NEWMATE_SEARCH_TOOL) && group.toolsMissing.length === 0);
  check('the persona states the desktop boundary rather than only the tool schema', group.prefix.includes('computer_use') && group.prefix.includes('takeover_stop') && group.prefix.includes('自动检查轮次没有这两个工具') && group.prefix.includes('禁止删除记忆'));
  check('the persona states the native-search boundary and the untrusted-content rule', group.prefix.includes('newmate_search') && group.prefix.includes('不是指令') && group.prefix.includes('自动检查轮次没有这个工具'));

  /* ----------------------------------------------------- a run that uses the desktop --- */

  const dispatched = [];
  let mate;
  const tools = {
    execute: async (call) => {
      dispatched.push({ name: call.name, action: call.arguments?.action, allow: call.arguments?.tools?.allow, owner: computerUseOwner({}), caller: computerUseCaller({}) });
      if (call.name === 'agent_api_send') {
        const context = newMateContext();
        check('the dispatch carries the live event hook', typeof context?.onEvent === 'function');
        const live = () => mate.loopStatus();
        context.onEvent({ type: 'agent_start', turn: null });
        context.onEvent({ type: 'turn_start', turn: 1 });
        check('the live view reports the model turn while the run is still inside the dispatch', live().running === true && live().phase === 'model' && live().turns === 1);
        context.onEvent({ type: 'thinking', text: '先确认窗口标题，再决定是否点击。' });
        check('the model reasoning enters the timeline as one thought segment', live().thinking.text.includes('先确认窗口标题') && live().events.filter((event) => event.type === 'thinking').length === 1);
        context.onEvent(eventView({ type: 'thinking', text: '想'.repeat(THINKING_LIVE_LIMIT + 100) }));
        check('an over-long thought is kept as its tail and marked truncated', live().thinking.truncated === true && live().thinking.text.endsWith('想') && live().thinking.text.length <= THINKING_LIVE_LIMIT + 60);
        check('republications extend the same thought segment instead of adding rows', live().events.filter((event) => event.type === 'thinking').length === 1);
        context.onEvent({ type: 'tool_execution_start', turn: 1, tool: 'computer_use', call_id: 'call-1', arguments: '{"action":"takeover_start","mouse_mode":"real"}' });
        check('the tool in flight is named in the live view', live().phase === 'tool' && live().currentTool === 'computer_use');
        check('the thought segment sits in the timeline before the tool it precedes', live().events.findIndex((event) => event.type === 'thinking') < live().events.findIndex((event) => event.type === 'tool_execution_start'));
        context.onEvent({ type: 'tool_execution_end', turn: 1, tool: 'computer_use', call_id: 'call-1', is_error: false, result: '{"ok":true,"takeover":true}' });
        check('a completed call is counted and the phase returns to the model', live().toolCalls === 1 && live().currentTool === null && live().phase === 'model');
        context.onEvent({ type: 'turn_end', turn: 1, tool_results: 1, errors: 0 });
        context.onEvent({ type: 'turn_start', turn: 2 });
        context.onEvent({ type: 'turn_end', turn: 2, tool_results: 0, errors: 0 });
        context.onEvent({ type: 'agent_end', turn: null, stop_reason: 'stop' });
        return { isError: false, value: { ok: true, result: { output: '记事本已经写好并关掉了。' } } };
      }
      if (call.name === 'computer_use') return { isError: false, value: { ok: true, released_owner: NEWMATE_CU_OWNER, action: call.arguments?.action } };
      throw Error('unexpected dispatch ' + call.name);
    },
  };
  mate = createNewMate({ root: path.join(root, 'chat'), now: () => clock, agents: () => null, tools });
  mate.chat('请帮我打开记事本，写一行字然后关掉。', { agent: { session: { id: 'origin-session' } } });
  await mate.tick();
  check('the run completed rather than swallowing an in-dispatch assertion', mate.state().tasks.at(-1).status === 'completed');
  check('the dispatch allow list carries the two desktop tools and native search', dispatched[0].allow.includes('computer_use') && dispatched[0].allow.includes('screen_capture') && dispatched[0].allow.includes(NEWMATE_SEARCH_TOOL));
  check('the requesting conversation identity is still visible for origin tracking', dispatched[0].caller === 'dsh-session:origin-session');
  check('ComputerUse actions are attributed to NewMate, not to the requesting session', dispatched[0].owner === NEWMATE_CU_OWNER && dispatched[0].owner !== 'dsh-session:origin-session');
  const releases = dispatched.filter((call) => call.name === 'computer_use');
  check('both lease slots are released under the NewMate owner after the run', releases.length === 2 && releases.every((call) => call.action === 'takeover_stop' && call.owner === NEWMATE_CU_OWNER));
  check('the release covers both desktop modes', releases.map((call) => call.owner).length === 2 && dispatched.filter((call) => call.action === 'takeover_stop').length === 2);
  const done = mate.loopStatus();
  check('the finished snapshot is not running and names its durable outcome', done.running === false && done.phase === 'done' && done.error === null);
  check('the snapshot keeps the run facts the receipt would report', done.turns === 2 && done.toolCalls === 1 && done.stopReason === 'stop' && done.events.length === 9);
  check('the timeline interleaves thought and tool in the order they happened', done.events.map((event) => event.type).join(',') === 'agent_start,turn_start,thinking,tool_execution_start,tool_execution_end,turn_end,turn_start,turn_end,agent_end');
  check('the ring keeps the tool call and its result as separate, named events', done.events[3].tool === 'computer_use' && done.events[3].text.includes('takeover_start') && done.events[4].is_error === false);
  check('the thought segment is capped and carries its own truncation marker', done.events[2].text.length <= 1300 && done.events[2].text.startsWith('…(+'));
  check('the finished snapshot keeps the last thought, truncated as the view stated', done.thinking.truncated === true && done.thinking.text.endsWith('想'));
  check('the elapsed time is measured, not asserted', done.elapsedMs >= 0 && done.startedAt === clock && done.cleanup.attempted === true);
  check('the live context does not outlive the run', newMateContext() === undefined);

  /* -------------------------------------------------------- a run without the desktop --- */

  const plain = [];
  const plainMate = createNewMate({ root: path.join(root, 'plain'), now: () => clock, agents: () => null, tools: { execute: async (call) => {
    plain.push(call.name);
    if (call.name !== 'agent_api_send') throw Error('no release is expected when ComputerUse was never used');
    const context = newMateContext();
    context.onEvent({ type: 'agent_start', turn: null });
    context.onEvent({ type: 'turn_start', turn: 1 });
    context.onEvent({ type: 'agent_end', turn: null, stop_reason: 'stop' });
    return { isError: false, value: { ok: true, result: { output: '好的。' } } };
  } } });
  plainMate.chat('你好');
  await plainMate.tick();
  check('a run that never touched the desktop issues no lease release', plain.length === 1 && plainMate.loopStatus().phase === 'done');
  check('a run that never thought publishes an empty thought rather than a placeholder', plainMate.loopStatus().thinking.text === '' && plainMate.loopStatus().thinking.at === null);

  /* ------------------------------------------------------------ the autonomous run --- */

  const autoRoot = path.join(root, 'auto');
  createNewMate({ root: autoRoot, now: () => clock, agents: () => null, tools: { execute: async () => ({ isError: false, value: { ok: true } }) } }).stop();
  const autoFile = path.join(autoRoot, 'newMate', 'state.json');
  const autoState = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
  autoState.settings.companion = true;
  autoState.settings.initiative = true;
  autoState.tasks.push({ id: 'auto-run-1', kind: 'self_activation', reason: 'check-in', status: 'pending', prompt: '主动陪伴稀疏检查', destination: 'newmate', threadId: autoState.activeThreadId, created: clock });
  fs.writeFileSync(autoFile, JSON.stringify(autoState));
  let autoAllow = null;
  const autoMate = createNewMate({ root: autoRoot, now: () => clock, agents: () => null, environment: () => ({ ready: true, idleMs: 120000, busy: true }), tools: { execute: async (call) => {
    autoAllow = call.arguments?.tools?.allow ?? null;
    return { isError: false, value: { ok: true, result: { structured: { notify: true, text: '轻量问候' } } } };
  } } });
  await autoMate.tick();
  check('an autonomous check-in never receives the desktop tools', Array.isArray(autoAllow) && !autoAllow.includes('computer_use') && !autoAllow.includes('screen_capture'));
  check('the autonomous run still completes and publishes its live outcome', autoMate.loopStatus().phase === 'done' && autoMate.state().tasks.find((task) => task.id === 'auto-run-1').status === 'completed');

  /* --------------------------------------------------------------- a failed run --- */

  const failMate = createNewMate({ root: path.join(root, 'fail'), now: () => clock, agents: () => null, tools: { execute: async () => {
    const context = newMateContext();
    context.onEvent({ type: 'agent_start', turn: null });
    context.onEvent({ type: 'turn_start', turn: 1 });
    throw Error('provider offline');
  } } });
  failMate.chat('试试');
  await failMate.tick();
  check('a failed run settles the live view as failed with the task error', failMate.loopStatus().phase === 'failed' && failMate.loopStatus().running === false && /provider offline/.test(failMate.loopStatus().error));

  /* ------------------------------------------------------------- boundedness --- */

  const burstMate = createNewMate({ root: path.join(root, 'burst'), now: () => clock, agents: () => null, tools: { execute: async (call) => {
    if (call.name === 'computer_use') return { isError: false, value: { ok: true } };
    const context = newMateContext();
    context.onEvent({ type: 'agent_start', turn: null });
    for (let index = 0; index < 40; index += 1) {
      context.onEvent({ type: 'tool_execution_start', turn: (index % 3) + 1, tool: 'computer_use', call_id: 'c' + index, arguments: '{"action":"observe","x":' + index + '}' });
      context.onEvent({ type: 'tool_execution_end', turn: (index % 3) + 1, tool: 'computer_use', call_id: 'c' + index, is_error: false, result: 'ok' });
    }
    return { isError: false, value: { ok: true, result: { output: 'done' } } };
  } } });
  burstMate.chat('burst');
  await burstMate.tick();
  const burst = burstMate.loopStatus();
  check('the event ring is bounded and says what it dropped', burst.events.length <= 24 && burst.dropped > 0);
  check('a bounded snapshot stays a small lossless JSON value', JSON.stringify(burst).length < 12000 && JSON.stringify(JSON.parse(JSON.stringify(burst))) === JSON.stringify(burst));

  /* -------------------------------------- the real agent-api loop, with a NewMate context --- */

  const requests = [];
  const executed = [];
  const turn = (blocks) => async function* () {
    for (const [index, block] of blocks.entries()) yield { type: 'block-end', index, block };
    yield { type: 'finish', reason: { kind: blocks.some((block) => block.type === 'tool-call') ? 'tool-calls' : 'stop' } };
  };
  const thinkingTurn = (reasoning, blocks) => async function* () {
    const step = Math.ceil(reasoning.length / 3);
    let offset = 0;
    for (let index = 0; index < 3; index += 1) { const piece = reasoning.slice(offset, offset + step); if (piece) yield { type: 'reasoning-delta', index: 0, text: piece }; offset += step; }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } };
    for (const [offset, block] of blocks.entries()) yield { type: 'block-end', index: offset + 1, block };
    yield { type: 'finish', reason: { kind: blocks.some((block) => block.type === 'tool-call') ? 'tool-calls' : 'stop' } };
  };
  const script = [
    thinkingTurn('先确认桌面状态，再决定是否点击。'.repeat(20), [{ type: 'tool-call', id: 'api-call-1', name: 'computer_use', arguments: '{"action":"mode_report"}' }]),
    turn([{ type: 'text', text: '桌面状态已确认。' }]),
  ];
  const apiView = {
    core: { model: () => ({ provider: 'fixture', model: 'fixture-model' }) },
    llm: { async listModels() { return [{ id: 'fixture-model', provider: 'fixture' }]; }, stream(request) { requests.push(request); return (script.shift() || turn([{ type: 'text', text: 'done' }]))(); } },
    tools: {
      schemas: () => [{ name: 'memory_lab_query', description: '', parameters: { type: 'object' } }, { name: 'computer_use', description: '', parameters: { type: 'object' } }, { name: 'screen_capture', description: '', parameters: { type: 'object' } }],
      execute: async (exec) => { executed.push({ name: exec.name, owner: computerUseOwner({}), arguments: exec.arguments }); return { isError: false, value: { ok: true, matches: [] } }; },
    },
  };
  const api = createAgentApi({ root: path.join(root, 'api'), services: () => apiView });
  const send = api.tools().find((tool) => tool.name === 'agent_api_send');
  const seen = [];
  const receipt = await withComputerUseOwner(NEWMATE_CU_OWNER, () => withNewMateContext({ prefix: 'NewMate probe prefix', onEvent: (event) => seen.push(event) }, () => send.execute({ prompt: 'probe', tools: { allow: ['memory_lab_query', 'computer_use', 'screen_capture'] }, max_steps: 4, workspace: path.join(root, 'api', 'Work') })));
  check('the real loop forwards every receipt event to the live hook', receipt.ok === true && seen.filter((event) => event.type !== 'thinking').map((event) => event.type).join(',') === 'agent_start,turn_start,tool_execution_start,tool_execution_end,turn_end,turn_start,turn_end,agent_end');
  const thinkingEvents = seen.filter((event) => event.type === 'thinking');
  check('the real loop publishes the model reasoning while the turn streams, before the tool it precedes', thinkingEvents.length >= 2 && thinkingEvents[0].text.includes('先确认桌面状态') && thinkingEvents.at(-1).text.length > thinkingEvents[0].text.length && seen.indexOf(thinkingEvents[0]) < seen.findIndex((event) => event.type === 'tool_execution_start'));
  check('the live events ARE the receipt events, and thinking is live-only', JSON.stringify(seen.filter((event) => event.type !== 'thinking')) === JSON.stringify(receipt.events) && !receipt.events.some((event) => event.type === 'thinking'));
  check('a tool the real loop executes resolves under the bound owner', executed.length === 1 && executed[0].name === 'computer_use' && executed[0].owner === NEWMATE_CU_OWNER);
  check('the NewMate prefix reaches the real model request', JSON.stringify(requests[0]).includes('NewMate probe prefix'));
  check('the live hook is scoped to the run and gone afterwards', newMateContext() === undefined);

  /* ------------------------------------------------------- NewMate native search --- */

  const seamQueries = [];
  const seamSearch = createNewMateSearch({
    services: () => ({
      web: {
        searchProviderId: 'deepseek-official',
        search: async (request, signal) => {
          seamQueries.push({ ...request, signalled: Boolean(signal) });
          return { sources: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b', snippet: 'B' }, { url: 'https://example.com/a', title: 'duplicate' }], truncated: false };
        },
      },
    }),
  });
  check('the search tool carries its own name and the native query bound', seamSearch.definition.name === NEWMATE_SEARCH_TOOL && seamSearch.definition.parameters.properties.queries.maxItems === SEARCH_MAX_QUERIES && String(seamSearch.definition.description).includes('untrusted'));
  const seamResult = await seamSearch.definition.execute({ queries: ['今天有什么新闻', '今天有什么新闻', ' 第二件事 '] }, {});
  check('the host seam path merges and deduplicates sources and keeps the official provider id', seamResult.ok === true && seamResult.provider === 'deepseek-official' && seamResult.sources.length === 2 && seamResult.queries.length === 2);
  check('every source given to the model is bounded and carries the untrusted-content notice', seamQueries.every((query) => query.maxResults === SEARCH_MAX_RESULTS && query.signalled === true) && seamResult.notice.includes('untrusted'));
  const emptyQueries = await seamSearch.definition.execute({ queries: [] }, {});
  const tooManyQueries = await seamSearch.definition.execute({ queries: ['1', '2', '3', '4', '5'] }, {});
  const blankQuery = await seamSearch.definition.execute({ queries: ['   '] }, {});
  check('an empty, blank or over-full query set is refused by name before any provider call', emptyQueries.code === 'invalid_queries' && tooManyQueries.code === 'invalid_queries' && blankQuery.code === 'invalid_queries' && seamQueries.length === 2);

  let providerOptions = null;
  const providerCalls = [];
  class FakeProvider {
    constructor(options) { providerOptions = options(); }
    available() { return true; }
    async search(request, signal) { providerCalls.push({ request, signalled: Boolean(signal) }); return { sources: [{ url: 'https://deepseek.example/1', title: '官方结果' }], truncated: true, content: '摘要' }; }
  }
  const fallback = createNewMateSearch({
    services: () => ({ web: undefined, credentials: { resolve: async (ref) => ({ value: ref === 'DEEPSEEK_API_KEY' ? 'resolved-key' : undefined }) } }),
    importProvider: async () => ({ DeepSeekSearchProvider: FakeProvider }),
    env: {},
  });
  const fallbackResult = await fallback.definition.execute({ queries: ['深度求索'] }, {});
  check('without the seam the native official provider is used with DSH default endpoint, model and budget', fallbackResult.ok === true && fallbackResult.provider === 'deepseek-official' && providerOptions.apiKeyEnv === 'DEEPSEEK_API_KEY' && providerOptions.baseURL === 'https://api.deepseek.com/anthropic/v1' && providerOptions.model === 'deepseek-v4-flash' && providerOptions.apiVersion === '2023-06-01' && providerOptions.maxTokens === 4096 && providerOptions.maxUses === 5);
  check('the credential store is asked for the official key, and the query reaches the provider', (await providerOptions.resolveApiKey()) === 'resolved-key' && providerCalls.length === 1 && providerCalls[0].request.query === '深度求索' && providerCalls[0].request.maxResults === SEARCH_MAX_RESULTS && providerCalls[0].signalled === true);
  check('the provider answer is passed through with its citation content', fallbackResult.sources[0].url === 'https://deepseek.example/1' && fallbackResult.answers?.[0]?.content === '摘要' && fallbackResult.truncated === true);

  let envOptions = null;
  const envSearch = createNewMateSearch({
    services: () => ({}),
    importProvider: async () => ({ DeepSeekSearchProvider: class { constructor(options) { envOptions = options(); } available() { return true; } async search() { return { sources: [], truncated: false }; } } }),
    env: { DEEPSEEK_API_KEY: 'env-key', DEEPSEEK_SEARCH_BASE_URL: 'https://search.example/v1' },
  });
  const envResult = await envSearch.definition.execute({ queries: ['env'] }, {});
  check('the launch environment supplies the key and the search endpoint when the host exports them', envResult.ok === true && envOptions.baseURL === 'https://search.example/v1' && (await envOptions.resolveApiKey()) === 'env-key' && envResult.note === 'No results found.');

  const unavailable = createNewMateSearch({ services: () => ({}), importProvider: async () => { throw Object.assign(Error('not installed'), { code: 'MODULE_NOT_FOUND' }); } });
  const unavailableResult = await unavailable.definition.execute({ queries: ['x'] }, {});
  check('with neither the seam nor the provider the tool answers a named refusal instead of searching', unavailableResult.ok === false && unavailableResult.code === 'web_search_unavailable');

  class AbortProvider { available() { return true; } async search(request, signal) { return signal?.aborted ? Promise.reject(Object.assign(Error('aborted'), { code: 'WEB_ABORTED' })) : Promise.reject(Error('the signal was not forwarded')); } }
  const abortController = new AbortController();
  abortController.abort(Error('user cancelled'));
  const abortSearch = createNewMateSearch({ services: () => ({}), importProvider: async () => ({ DeepSeekSearchProvider: AbortProvider }) });
  const abortedResult = await abortSearch.definition.execute({ queries: ['x'] }, { signal: abortController.signal });
  check('cancellation is forwarded to the provider and reported by its own code', abortedResult.ok === false && abortedResult.code === 'WEB_ABORTED');

  /* ------------------------------------------------------- the real HTTP surface --- */

  const routeRoot = path.join(root, 'route');
  const registered = new Map();
  const routes = new Map();
  const disposers = [];
  const coreService = {};
  let releaseDispatch;
  let routePrefix = '';
  const held = new Promise((resolve) => { releaseDispatch = resolve; });
  const routeTools = {
    schemas: () => [],
    execute: async (call) => {
      if (call.name !== 'agent_api_send') throw Error('unexpected dispatch ' + call.name);
      const context = newMateContext();
      routePrefix = String(context.prefix ?? '');
      context.onEvent({ type: 'agent_start', turn: null });
      context.onEvent({ type: 'turn_start', turn: 1 });
      await held;
      context.onEvent({ type: 'agent_end', turn: null, stop_reason: 'stop' });
      return { isError: false, value: { ok: true, result: { output: '路由检查的回复。' } } };
    },
  };
  const ctx = {
    effect(callback) { const disposer = callback(); if (typeof disposer === 'function') disposers.push(disposer); return disposer; },
    tools: { ...routeTools, register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); } },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); }, tapIndex() {} },
    get(name) { return name === 'newmarkComponents' ? coreService : undefined; },
    logger: { warn() {}, error() {} },
  };
  const row = await import(new URL('../packages/newmark-core/components/newmate/index.js', import.meta.url).href + '?mount=agent-loop-gate');
  row.apply(ctx, { root: routeRoot });
  const routeMate = coreService.newMate;
  check('the NewMate row mounts and publishes its kernel for the surfaces', Boolean(routeMate) && routes.has('/newmark-newmate'));
  const priv = globalThis[Symbol.for('newmark.newmate.privateTools')] || {};
  check('the mounted row publishes native search privately and does NOT register it globally', priv.newmate_search?.name === NEWMATE_SEARCH_TOOL && !registered.has(NEWMATE_SEARCH_TOOL));
  check('the compaction tool is private too and absent from the global registry', priv.compact_context?.name === 'compact_context' && !registered.has('compact_context'));
  const asked = routeMate.chat('观察一下当前窗口。');
  check('the run reached the dispatch and is still in flight', await until(() => routeMate.loopStatus().running === true));
  const during = await callRoute(routes.get('/newmark-newmate'), 'GET');
  check('GET /newmark-newmate exposes the live loop while the run is in flight', during.status === 200 && during.json.agentLoop?.running === true && during.json.agentLoop.turns === 1);
  releaseDispatch();
  check('the route settles to the finished snapshot', await until(() => routeMate.loopStatus().running === false));
  const after = await callRoute(routes.get('/newmark-newmate'), 'GET');
  check('the finished snapshot is what the route answers after the run', after.json.agentLoop?.running === false && after.json.agentLoop.phase === 'done' && after.json.agentLoop.turns === 1);
  const stateTool = registered.get('newmate_state');
  const stateValue = stateTool.execute({});
  check('the newmate_state tool carries the same live snapshot', stateValue.agentLoop?.phase === 'done' && Array.isArray(stateValue.tasks) && typeof stateValue.activeThreadId === 'string');
  check('the route payload survives a JSON round trip unchanged', JSON.stringify(JSON.parse(JSON.stringify(after.json.agentLoop))) === JSON.stringify(after.json.agentLoop) && JSON.stringify(JSON.parse(JSON.stringify(stateValue.agentLoop))) === JSON.stringify(stateValue.agentLoop));
  const mcp = createNewMateMcp({ root: routeRoot, mate: routeMate });
  const status = mcp.definitions.find((definition) => definition.name === 'newmate_task_status').execute({ id: asked.id });
  check('the MCP task status carries the same live snapshot', status.ok === true && status.agentLoop?.phase === 'done' && status.task.id === asked.id);
  check('the mounted row runs with the persona that states the desktop rule', routePrefix.includes('takeover_stop') && routePrefix.includes('computer_use'));

  const clientSource = fs.readFileSync(new URL('../packages/newmark-core/client.js', import.meta.url), 'utf8');
  check('the page shows only the latest live state: a thought tail or the running tool, never the full activity timeline', clientSource.includes('renderLiveThought(state.agentLoop)') && clientSource.includes('nm-live-thought') && !clientSource.includes('renderProcess(') && !clientSource.includes("className:'nm-run'") && !clientSource.includes('timeline.map'));
  check('the status line names the tool in use, with a dedicated search hint for native search', clientSource.includes("loop.currentTool==='newmate_search'?'正在进行搜索'") && clientSource.includes("'正在'+toolAction(loop.currentTool)"));
  check('the full conversation poll is decoupled from the live loop, which has its own 200 ms route', clientSource.includes('setInterval(read, 2000)') && clientSource.includes("'/newmark-newmate/loop'") && clientSource.includes('setInterval(read, 200)'));
  check('the seconds tick from the local clock and the run start, not from the polled snapshot', clientSource.includes('now-loop.startedAt') && clientSource.includes('Math.floor(elapsed/1000)') && clientSource.includes('h(LiveStatus,{loop:state.agentLoop,question:state.question})'));
  check('the page keeps the short labels for tool use', clientSource.includes("return '查看记忆'") && clientSource.includes("return '控制电脑'") && clientSource.includes("return '调用工具'") && clientSource.includes("'正在'+toolAction"));
  check('the live thought is the newest text only, not a second transcript', clientSource.includes("thought.length>600?'…'+thought.slice(-600):thought") && !clientSource.includes('nm-thinking'))

  for (const dispose of disposers.reverse()) dispose?.();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`PASS ${checks} NewMate ComputerUse permission and live agent-loop checks`);
