'use strict';

// Actual Agent/native-kernel execution with an in-process provider. The private
// source bundle never overwrites dist and makes no upstream cache-hit claim.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');
const desktop = path.resolve(__dirname, '..');
const repository = path.dirname(desktop);
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const receiptsOnly = argv.includes('--receipts-only');
const sourcePaths = ['DESKTOP/src/core/agent.ts', 'DESKTOP/src/core/subagent.ts', 'DESKTOP/src/core/agentKernelRunner.ts', 'DESKTOP/src/core/agentKernel/agent.ts', 'DESKTOP/src/core/conversationKernel.ts', 'DESKTOP/src/core/subagentCommunication.ts'];

async function loadSource(temporary) {
  const filename = path.join(temporary, 'settlement-source.cjs');
  const sourceFiles = [];
  const esbuild = require('esbuild');
  esbuild.buildSync({ entryPoints: [require.resolve('typebox/compile')], outfile: path.join(temporary, 'typebox-compile.bundle.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  await esbuild.build({
    stdin: { contents: 'export { Agent } from "./src/core/agent"; export { SubagentManager } from "./src/core/subagent"; export { ConversationKernel } from "./src/core/conversationKernel"; export { openAIChatMessages } from "./src/providers/chat-messages"; export { LLMProvider } from "./src/llm/provider";', resolveDir: desktop, sourcefile: 'settlement-entry.ts', loader: 'ts' },
    outfile: filename, bundle: true, platform: 'node', format: 'cjs', target: 'node18', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'exact-source-overrides', setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]core[\\/].*\.ts$/ }, args => {
        const relative = path.relative(repository, args.path).replace(/\\/g, '/');
        if (!sourcePaths.includes(relative)) return;
        const replacement = option('--source-overrides') && path.join(path.resolve(option('--source-overrides')), relative);
        const source = replacement && fs.existsSync(replacement) ? replacement : args.path;
        const contents = fs.readFileSync(source, 'utf8');
        sourceFiles.push({ path: source, sha256: crypto.createHash('sha256').update(contents).digest('hex') });
        return { contents, loader: 'ts', resolveDir: path.dirname(args.path) };
      });
    } }],
  });
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(desktop);
  compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { ...compiled.exports, sourceFiles };
}

function configuration() {
  return {
    models: { providers: { value: [{ id: 'receipt-fixture', name: 'Receipt fixture', enabled: true, base_url: 'https://fixture.invalid/v1', api_key: 'fixture-only', protocol: 'openai', models: [{ name: 'receipt-model', display: 'Receipt fixture', enabled: true, max_tokens: 128000, thinking: false, speed_rating: 'fast', capability_rating: 'high', capabilities: ['text_input', 'text_output', 'tool_use'], validation: { level: 'standard', status: 'verified', checked_at: '2026-09-07T00:00:00.000Z', capabilities: { text_input: true, text_output: true, tool_use: true } } }] }] }, default_model: { value: 'receipt-model' }, auto_switch: { value: false }, fallback_on_unavailable: { value: false } },
    context: { auto_compress: { value: false } }, workspace: { auto_create_timestamp_workspace: { value: false } },
  };
}

async function run() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-settlement-receipts-'));
  const { Agent, SubagentManager, ConversationKernel, openAIChatMessages, LLMProvider, sourceFiles } = await loadSource(temporary);
  const checks = [];
  const scenarios = [];
  const owners = [];
  let active;
  let stopPressure;
  const check = (name, fn) => {
    try { fn(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error.stack || String(error) }); }
    console.log(`[${checks.at(-1).passed ? 'PASS' : 'FAIL'}] ${name}`);
  };
  const provider = {
    intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
    async chat() { return 'Receipt fixture'; },
    async *chatStreamWithTools(model, messages, system, _temperature, _maxTokens, tools, signal) {
      if (stopPressure) {
        const marker = JSON.stringify(messages).match(/STOP_SCOPE_[AB]_[0-3]/)?.[0];
        assert.ok(marker, 'Each concurrent request must belong to an identified peer');
        const peer = stopPressure.peers.get(marker);
        assert.ok(peer, marker);
        peer.requests.push({ messages: copy(openAIChatMessages(messages)), system, tools: copy(tools) });
        if (peer.requests.length === 1) {
          stopPressure.started++;
          await new Promise((resolve, reject) => {
            const abort = () => { peer.aborted = true; const error = Error('Fixture observed actual provider AbortSignal'); error.name = 'AbortError'; reject(error); };
            if (signal?.aborted) return abort();
            signal?.addEventListener('abort', abort, { once: true });
            stopPressure.releases.push(() => { signal?.removeEventListener('abort', abort); resolve(); });
          });
          yield { type: 'tool_call', text: '', toolCall: { id: `${marker}-pwd`, name: 'pwd', arguments: '{}' } };
          return;
        }
        yield { type: 'text', text: `STOP_ISOLATION_COMPLETE_${marker}` };
        return;
      }
      const scenario = active;
      const round = scenario.requests.length + 1;
      if (round > 15) throw Error('Receipt fixture request watchdog exceeded');
      scenario.requests.push({ round, model, messages: copy(openAIChatMessages(messages)), raw: copy(messages), system, tools: copy(tools) });
      yield { type: 'usage', text: '', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } };
      if (scenario.simple) {
        if (round === 1 && scenario.activeMails) {
          scenario.owner.subagents.sendRootMessage(scenario.peers[0], 'ACTIVE_ROOT_WAKE_FALSE', 'directive', undefined, false);
          scenario.owner.subagents.sendRootMessage(scenario.peers[0], 'ACTIVE_ROOT_WAKE_TRUE', 'question', undefined, true);
        }
        yield { type: 'text', text: `ROOT_SIMPLE_RESPONSE_${round}` };
        return;
      }
      if (round === 1) {
        yield { type: 'tool_call', text: '', toolCall: { id: `${scenario.name}-provision`, name: 'tool_provision', arguments: JSON.stringify({ names: [scenario.tool] }) } };
        return;
      }
      if (round === 2) {
        for (const peer of scenario.peers) scenario.owner.subagents.complete(peer, scenario.result);
        scenario.autoNotices = copy(scenario.owner.subagents.readRootInbox({ includeRead: true }));
        if (scenario.controls) {
          for (const kind of ['result', 'directive', 'question']) scenario.owner.subagents.sendRootMessage(scenario.peers[0], `MANUAL_${kind}`, kind, undefined, true);
          scenario.owner.queueActiveKernelMessage('UNRELATED_FOLLOWUP', 'followUp', undefined, undefined, undefined, true);
        }
        if (scenario.noRead) {
          yield { type: 'text', text: 'WAITING_FOR_UNREAD_SETTLEMENT' };
          return;
        }
        for (const peer of scenario.peers) yield { type: 'tool_call', text: '', toolCall: { id: `${scenario.name}-result-${peer}`, name: scenario.tool, arguments: JSON.stringify({ id: peer, ...(scenario.tool === 'subagent_read' ? { max_chars: scenario.maxChars || 8000 } : {}) }) } };
        return;
      }
      yield { type: 'text', text: `SETTLEMENT_SUMMARY_${round}` };
    },
  };
  Object.assign(LLMProvider.prototype, provider);

  function owner(name, state, history) {
    const root = path.join(temporary, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(configuration()));
    const item = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: name });
    item.workspace.current = { id: name, name, path: root, isInternal: false, hostBinding: '', icon: '', kind: 'local' };
    item.config.clearWorkspaceOverrides();
    item.forcedProvider = provider;
    item.model = 'receipt-model';
    item.activeConversationId = name;
    item.history = copy(history || []);
    item.subagents = new SubagentManager({ conversationId: name, rootAgentId: state?.rootAgentId || item.runtimeActorId, state,
      onSettled: record => item.deliverPeerSettlement(record),
      onRootInboxMessage: item.rootInboxListener,
      onMailboxMessage: message => item.deliverActivePeerMailbox(message.toAgentId, message),
      persist: value => item.persistSubagentState(name, value),
    });
    owners.push(item);
    return item;
  }

  const inbox = item => item.subagents.serialize().rootInbox || [];
  function durable(item) {
    const filename = item.workspaceConversationStorePath();
    return filename && fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
  }
  function receiptHistory(item) { return item.history.filter(message => message.subagent_settlement_receipt); }
  function delivered(scenario, id) { return scenario.requests.at(-1)?.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes(`id=${id} `)).length || 0; }
  async function settle(record, runtime, expected) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (record.requests.length >= expected && !record.owner.activeProcessSignal() && !runtime?.activePromise) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error(`Root wake settlement timed out (${record.name}, requests=${record.requests.length}, expected=${expected})`);
  }
  function staticState(item) {
    return JSON.stringify({ history: item.history, systemPromptCache: item.systemPromptCache, tools: Array.from(item.toolDefinitionCache || []), continuations: item.conversationContinuations() });
  }

  async function scenario(name, options = {}) {
    const item = owner(name);
    const record = { name, owner: item, tool: 'subagent_result', result: 'COMPLETE_PEER_RESULT', requests: [], ...options };
    record.peers = Array.from({ length: options.count || 1 }, (_, index) => item.subagents.create(`receipt peer ${index}`, `Produce receipt evidence ${index}.`, 'receipt-model'));
    if (record.controls) {
      const original = item.handleSubagentResultEnvelope.bind(item);
      let revised = false;
      item.handleSubagentResultEnvelope = args => {
        const envelope = original(args);
        if (!revised) { revised = true; item.subagents.complete(record.peers[0], record.result); }
        return envelope;
      };
    }
    const save = item.saveWorkspaceConversationState.bind(item);
    item.saveWorkspaceConversationState = (...args) => {
      if (record.failSave && receiptHistory(item).length && !record.failureInjected) {
        record.failureInjected = true;
        throw Error('FIXTURE_DURABLE_TOOL_SAVE_FAILURE');
      }
      const result = save(...args);
      if (receiptHistory(item).length && !record.beforeAcknowledgement) record.beforeAcknowledgement = { state: copy(item.subagents.serialize()), history: copy(item.history), durable: durable(item) };
      return result;
    };
    active = record;
    try {
      if (record.hosted) {
        const options = { model: 'receipt-model', mode: 'agent', intelligence: 'high', inputMode: 'guide', engine: 'default' };
        const kernel = new ConversationKernel(item.rootPath, item, null);
        const runtime = kernel.runtime(kernel.normalizeTarget(item.activeConversationId), options, item);
        record.response = await kernel.prompt('Read all complete peer results and summarize once.', runtime.target, options);
      } else record.response = await item.process('Read all complete peer results and summarize once.');
    }
    catch (error) { record.error = error.stack || String(error); }
    record.inbox = copy(inbox(item));
    record.history = copy(item.history);
    record.durable = durable(item);
    scenarios.push(record);
    return record;
  }

  try {
    const aggregate = await scenario('four-peer-results', { count: 4 });
    check('four full results require exactly three provider requests, no completion echo', () => assert.equal(aggregate.requests.length, 3));
    check('same-revision automatic notices are retired only after durable tool receipts', () => {
      assert.equal(aggregate.inbox.length, 4);
      assert.ok(aggregate.inbox.every(message => message.source === 'automatic-settlement' && message.readAt));
      assert.equal(receiptHistory(aggregate.owner).length, 4);
      assert.ok(aggregate.beforeAcknowledgement?.durable);
      assert.ok(JSON.stringify(aggregate.beforeAcknowledgement.durable).includes('subagent_settlement_receipt'));
      assert.ok(aggregate.beforeAcknowledgement.state.rootInbox.some(message => !message.readAt));
      assert.ok(aggregate.inbox.every(message => delivered(aggregate, message.id) === 0));
    });
    check('receipt metadata never enters provider messages and root prefix is append-only', () => {
      for (const request of aggregate.requests) {
        assert.ok(!JSON.stringify(request.raw).includes('subagent_settlement_receipt'));
        assert.ok(!JSON.stringify(request.messages).includes('settlementReceipt'));
        assert.equal(request.system, aggregate.requests[0].system);
      }
      for (let index = 1; index < aggregate.requests.length; index++) {
        const previous = aggregate.requests[index - 1].messages;
        assert.deepEqual(aggregate.requests[index].messages.slice(0, previous.length), previous);
      }
      assert.deepEqual(aggregate.requests[2].tools, aggregate.requests[1].tools);
    });
    const hostedAggregate = await scenario('hosted-four-peer-results', { count: 4, hosted: true });
    check('hosted four-peer result receipts suppress all four completion echoes without rebuilding system', () => {
      assert.equal(hostedAggregate.requests.length, 3);
      assert.equal(receiptHistory(hostedAggregate.owner).length, 4);
      assert.ok(hostedAggregate.inbox.every(message => message.readAt && delivered(hostedAggregate, message.id) === 0));
      assert.ok(hostedAggregate.requests.every(request => request.system === hostedAggregate.requests[0].system));
    });

    const controls = await scenario('revision-and-manual', { count: 4, controls: true });
    check('manual result/directive/question, same-body new revision and unrelated followup survive', () => {
      assert.equal(controls.requests.length, 8);
      const old = controls.autoNotices.map(message => message.id);
      assert.ok(controls.inbox.filter(message => old.includes(message.id)).every(message => delivered(controls, message.id) === 0));
      const newer = controls.inbox.find(message => message.source === 'automatic-settlement' && message.settlementRevision === 2);
      assert.ok(newer);
      assert.equal(delivered(controls, newer.id), 1);
      const manual = controls.inbox.filter(message => !message.source);
      assert.equal(manual.length, 3);
      assert.ok(manual.every(message => delivered(controls, message.id) === 1));
      assert.equal(controls.requests.at(-1).messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('UNRELATED_FOLLOWUP')).length, 1);
    });

    const read = await scenario('complete-read', { tool: 'subagent_read' });
    check('bounded read retires a notice when the complete result is returned', () => { assert.equal(read.requests.length, 3); assert.equal(receiptHistory(read.owner).length, 1); });
    const truncated = await scenario('truncated-read', { tool: 'subagent_read', maxChars: 2000, result: 'LONG_RESULT_'.repeat(1000) });
    check('truncated read keeps the unread automatic result deliverable', () => { assert.equal(truncated.requests.length, 4); assert.equal(receiptHistory(truncated.owner).length, 0); assert.equal(delivered(truncated, truncated.inbox[0].id), 1); });
    const unread = await scenario('unread-completion', { noRead: true });
    check('an unread automatic completion still gets exactly one delivery', () => { assert.equal(unread.requests.length, 3); assert.equal(delivered(unread, unread.inbox[0].id), 1); });

    const failed = await scenario('failed-durable-save', { failSave: true });
    check('a failed tool-history save cannot leave a live receipt that later retires a notice', () => {
      assert.ok(failed.failureInjected);
      assert.equal(receiptHistory(failed.owner).length, 0);
      const before = copy(inbox(failed.owner));
      failed.owner.acknowledgeSubagentSettlementReceipts();
      assert.deepEqual(inbox(failed.owner), before);
      assert.ok(before.some(message => !message.readAt) || before.every(message => failed.owner.history.some(entry => entry.role === 'user' && String(entry.content).includes(`id=${message.id} `))));
    });

    for (const alreadyRead of [false, true]) {
      const snapshot = copy(aggregate.beforeAcknowledgement);
      if (!snapshot) { check(`cold ${alreadyRead ? 'read' : 'unread'} notice converges pending durable continuations`, () => assert.fail('No durable receipt snapshot')); continue; }
      const firstNotice = snapshot.state.rootInbox[0];
      if (alreadyRead) firstNotice.readAt = new Date().toISOString();
      const restored = owner(`cold-${alreadyRead}`, snapshot.state, snapshot.history);
      const prompt = `[Root subagent inbox id=${firstNotice.id} result from ${firstNotice.fromAgentId}]\n${firstNotice.body}\n\nReview this persisted peer result and summarize or continue the parent task as needed.`;
      restored.retainConversationContinuations([{ content: prompt, queueMode: 'followUp', hiddenUserInput: true }, { content: 'PRESERVE_COLD_MANUAL_FOLLOWUP', queueMode: 'followUp', hiddenUserInput: true }]);
      const historyBefore = copy(restored.history);
      const kernel = new ConversationKernel(restored.rootPath, restored, null);
      const runtime = kernel.runtime(kernel.normalizeTarget(restored.activeConversationId), {}, restored);
      check(`cold ${alreadyRead ? 'read' : 'unread'} notice converges pending durable continuations`, () => {
        assert.ok(!JSON.stringify(runtime.pendingNextTurn).includes(firstNotice.id));
        assert.ok(JSON.stringify(runtime.pendingNextTurn).includes('PRESERVE_COLD_MANUAL_FOLLOWUP'));
        assert.ok(!JSON.stringify(restored.conversationContinuations()).includes(firstNotice.id));
        assert.deepEqual(restored.history, historyBefore);
      });
    }

    const listOwner = owner('list-projection');
    const listPeer = listOwner.subagents.create('listing identity', 'Retain task context in summaries.', 'receipt-model');
    const peerRecord = listOwner.subagents.get(listPeer);
    peerRecord.messages.push({ role: 'tool', content: 'HISTORY_PAYLOAD_MUST_STAY_PRIVATE'.repeat(500), name: 'read', tool_call_id: 'private-call' });
    peerRecord.metadata = { requestCache: { systemPrompt: 'REQUEST_CACHE_MUST_STAY_PRIVATE', toolCatalog: [{ private: true }] } };
    const list = listOwner.handleSubagentListEnvelope('{}');
    check('model-facing list stays bounded and excludes full transcript/request cache', () => {
      assert.ok(!list.output.includes('HISTORY_PAYLOAD_MUST_STAY_PRIVATE'));
      assert.ok(!list.output.includes('REQUEST_CACHE_MUST_STAY_PRIVATE'));
      assert.ok(!list.output.includes('requestCache'));
      assert.ok(list.output.length < 4000);
      assert.ok(list.output.includes('listing identity'));
      const full = listOwner.subagents.toRecord(listPeer);
      assert.ok(JSON.stringify(full).includes('REQUEST_CACHE_MUST_STAY_PRIVATE'));
      assert.ok(JSON.stringify(full).includes('HISTORY_PAYLOAD_MUST_STAY_PRIVATE'));
    });

    if (!receiptsOnly) {
      const sender = owner('sender-content-integration');
      const receiverId = sender.subagents.create('receiver B', 'RECEIVER_B_DIFFERENT_TASK', 'receipt-model');
      sender.subagents.complete(receiverId, 'RECEIVER_B_LAST_TEXT');
      sender.history = [
        { role: 'user', content: 'SENDER_A_OLDER_VISIBLE_TEXT' },
        { role: 'assistant', content: 'SENDER_A_TOOL_PREFACE', tool_calls: [{ id: 'sender-tool-pair', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'SENDER_A_EVIDENCE_PATH' }) } }], requestCache: { system: 'PRIVATE_TOP_LEVEL_REQUEST_CACHE' } },
        { role: 'tool', name: 'read', tool_call_id: 'sender-tool-pair', content: 'SENDER_A_COMPLETE_TOOL_EVIDENCE', requestCache: { system: 'PRIVATE_TOP_LEVEL_REQUEST_CACHE' } },
        { role: 'assistant', content: 'SENDER_A_LAST_VISIBLE_TEXT' },
        { role: 'user', content: 'SENDER_A_HIDDEN_CONTROL', hidden_user_input: true },
      ];
      sender.subagents.get(receiverId).metadata = { requestCache: { system: 'RECEIVER_B_PRIVATE_CACHE', initialTools: ['read'] } };
      const receiverBefore = JSON.stringify(sender.subagents.get(receiverId));
      const defaultSend = await sender.handleSubagentContinueEnvelope(JSON.stringify({ id: receiverId }));
      const defaultMail = sender.subagents.serialize().mailbox.at(-1);
      check('Agent send with omitted content uses sender latest visible text and preserves inactive receiver cache', () => {
        assert.equal(defaultSend.ok, true);
        assert.ok(defaultMail.body.includes('SENDER_A_LAST_VISIBLE_TEXT'));
        assert.ok(!defaultMail.body.includes('RECEIVER_B_LAST_TEXT'));
        assert.ok(!defaultMail.body.includes('SENDER_A_HIDDEN_CONTROL'));
        assert.equal(defaultMail.wakeup, false);
        assert.equal(JSON.stringify(sender.subagents.get(receiverId)), receiverBefore);
      });
      const selectedSend = await sender.handleSubagentContinueEnvelope(JSON.stringify({ id: receiverId, content: [{ kind: 'tool_history', range: { last: 1 } }] }));
      const selectedMail = sender.subagents.serialize().mailbox.at(-1);
      check('Agent content selection persists the actual complete sender tool pair without top-level cache', () => {
        assert.equal(selectedSend.ok, true);
        assert.ok(selectedMail.body.includes('sender-tool-pair'));
        assert.ok(selectedMail.body.includes('SENDER_A_EVIDENCE_PATH'));
        assert.ok(selectedMail.body.includes('SENDER_A_COMPLETE_TOOL_EVIDENCE'));
        assert.ok(!selectedMail.body.includes('PRIVATE_TOP_LEVEL_REQUEST_CACHE'));
        assert.ok(!selectedMail.body.includes('RECEIVER_B_PRIVATE_CACHE'));
        assert.ok(!selectedMail.body.includes('SENDER_A_LAST_VISIBLE_TEXT'));
        assert.equal(JSON.stringify(sender.subagents.get(receiverId)), receiverBefore);
      });
      const child = new Agent(sender.rootPath, { subagent: true, subagentName: 'sender child', actorId: receiverId, conversationId: sender.activeConversationId });
      child.subagents = sender.subagents;
      child.history = [{ role: 'assistant', content: 'CHILD_TO_ROOT_LAST_VISIBLE_TEXT' }];
      const rootSend = await child.handleSubagentContinueEnvelope(JSON.stringify({ id: 'root' }));
      const rootMail = inbox(sender).at(-1);
      const mailCount = sender.subagents.serialize().mailbox.length;
      const invalid = await sender.handleSubagentContinueEnvelope(JSON.stringify({ id: receiverId, message: 'INVALID_WAKEUP_SHOULD_NOT_PERSIST', wakeup: 'true' }));
      check('child Agent can address root and string wakeup is rejected without writing mail', () => {
        assert.equal(rootSend.ok, true);
        assert.equal(rootMail.fromAgentId, receiverId);
        assert.ok(rootMail.body.includes('CHILD_TO_ROOT_LAST_VISIBLE_TEXT'));
        assert.equal(rootMail.wakeup, false);
        assert.equal(invalid.ok, false);
        assert.equal(sender.subagents.serialize().mailbox.length, mailCount);
      });
    }

    if (!receiptsOnly) for (const hosted of [false, true]) {
      const name = `${hosted ? 'hosted' : 'direct'}-root-wakeup`;
      const item = owner(name);
      const record = { name, owner: item, simple: true, requests: [], peers: [item.subagents.create('root sender', 'Send root messages.', 'receipt-model')] };
      item.subagents.complete(record.peers[0], 'INITIAL_SENDER_COMPLETE');
      item.subagents.readRootInbox().forEach(message => item.subagents.acknowledgeRootInbox(message.id));
      const options = { model: 'receipt-model', mode: 'agent', intelligence: 'high', inputMode: 'guide', engine: 'default' };
      const kernel = hosted ? new ConversationKernel(item.rootPath, item, null) : null;
      const runtime = kernel?.runtime(kernel.normalizeTarget(item.activeConversationId), options, item);
      const prompt = text => hosted ? kernel.prompt(text, runtime.target, options) : item.process(text);
      active = record;
      await prompt('ROOT_INITIAL_STATIC_CONTEXT');
      const before = staticState(item);
      const baseRequests = record.requests.length;
      const quiet = item.subagents.sendRootMessage(record.peers[0], 'INACTIVE_ROOT_WAKE_FALSE', 'directive', undefined, false);
      await new Promise(resolve => setTimeout(resolve, 30));
      check(`${name}: inactive false leaves history/static cache byte-identical and only persists inbox`, () => {
        assert.equal(record.requests.length, baseRequests);
        assert.equal(staticState(item), before);
        assert.ok(item.subagents.readRootInbox().some(message => message.id === quiet.message.id && message.wakeup === false));
        assert.equal(runtime?.pendingNextTurn.length || 0, 0);
      });
      const loud = item.subagents.sendRootMessage(record.peers[0], 'INACTIVE_ROOT_WAKE_TRUE', 'question', undefined, true);
      try { await settle(record, runtime, baseRequests + 2); }
      catch (error) { record.settleError = String(error); }
      record.inbox = copy(inbox(item));
      record.history = copy(item.history);
      check(`${name}: inactive true activates owner and consumes both pending messages exactly once`, () => {
        assert.ok(!record.settleError, record.settleError);
        assert.equal(record.requests.length, baseRequests + 2);
        assert.equal(delivered(record, quiet.message.id), 1);
        assert.equal(delivered(record, loud.message.id), 1);
        assert.equal(item.subagents.readRootInbox().length, 0);
      });
      scenarios.push(record);

      const activeOwner = owner(`${name}-active`);
      const activeRecord = { name: `${name}-active`, owner: activeOwner, simple: true, activeMails: true, requests: [], peers: [activeOwner.subagents.create('active sender', 'Send active root mail.', 'receipt-model')] };
      const activeKernel = hosted ? new ConversationKernel(activeOwner.rootPath, activeOwner, null) : null;
      const activeRuntime = activeKernel?.runtime(activeKernel.normalizeTarget(activeOwner.activeConversationId), options, activeOwner);
      active = activeRecord;
      if (hosted) await activeKernel.prompt('ROOT_ACTIVE_CONTEXT', activeRuntime.target, options);
      else await activeOwner.process('ROOT_ACTIVE_CONTEXT');
      activeRecord.inbox = copy(inbox(activeOwner));
      activeRecord.history = copy(activeOwner.history);
      check(`${name}: active false and true each deliver once without rewriting previous messages`, () => {
        assert.equal(activeRecord.requests.length, 3);
        assert.ok(activeRecord.inbox.every(message => delivered(activeRecord, message.id) === 1));
        assert.ok(activeRecord.inbox.every(message => message.readAt));
        for (let index = 1; index < activeRecord.requests.length; index++) {
          const previous = activeRecord.requests[index - 1].messages;
          assert.deepEqual(activeRecord.requests[index].messages.slice(0, previous.length), previous);
        }
        assert.ok(activeRecord.requests.every(request => request.system === activeRecord.requests[0].system));
        assert.ok(activeRecord.requests.every(request => hash(request.tools) === hash(activeRecord.requests[0].tools)));
      });
      scenarios.push(activeRecord);
    }

    if (!receiptsOnly) {
      const ownerA = owner('stop-scope-a');
      const ownerB = owner('stop-scope-b');
      stopPressure = { started: 0, peers: new Map(), releases: [] };
      for (const [label, item] of [['A', ownerA], ['B', ownerB]]) {
        item.subagents.bind({ executor: async job => item.runSubagentJob(job.record.id, job.prompt, job.flowName, job.reason) });
        for (let index = 0; index < 4; index++) {
          const marker = `STOP_SCOPE_${label}_${index}`;
          const peer = { marker, label, owner: item, requests: [], aborted: false };
          stopPressure.peers.set(marker, peer);
          peer.id = item.subagents.create(marker, `${marker} perform the assigned read-only work.`, 'receipt-model');
        }
      }
      const deadline = Date.now() + 10000;
      while (stopPressure.started < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(stopPressure.started, 8, 'Both conversations must each have four simultaneous actual native provider requests');
      const pressure = stopPressure;
      const scopeB = Array.from(pressure.peers.values()).filter(peer => peer.label === 'B');
      for (const peer of scopeB) {
        const accepted = ownerB.subagents.sendMessage(ownerB.runtimeActorId, peer.id, `CONTINUE_B_AFTER_OTHER_CONVERSATION_STOP_${peer.marker}`, 'directive', {}, false);
        peer.mailId = accepted.message?.id;
        assert.ok(accepted.ok);
      }
      const scopeA = Array.from(pressure.peers.values()).filter(peer => peer.label === 'A');
      const beforeStop = scopeA.map(peer => ({ id: peer.id, messages: JSON.stringify(ownerA.subagents.get(peer.id).messages), requestCache: JSON.stringify(ownerA.subagents.get(peer.id).metadata?.requestCache) }));
      ownerA.abortActiveKernelRun('user_stop');
      ownerA.abortActiveKernelRun('user_stop');
      check('repeated stop does not rewrite peer transcript or persisted static request cache', () => {
        for (const saved of beforeStop) {
          assert.equal(JSON.stringify(ownerA.subagents.get(saved.id).messages), saved.messages);
          assert.equal(JSON.stringify(ownerA.subagents.get(saved.id).metadata?.requestCache), saved.requestCache);
        }
      });
      for (const release of pressure.releases) release();
      await Promise.all(Array.from(pressure.peers.values()).map(peer => peer.owner.subagents.waitForSettlement(peer.id, 10000)));
      check('stopping conversation A aborts all four native child requests while B completes four', () => {
        const peers = Array.from(pressure.peers.values());
        assert.equal(peers.filter(peer => peer.label === 'A' && peer.aborted).length, 4);
        assert.ok(scopeB.every(peer => !peer.aborted && ownerB.subagents.get(peer.id).status === 'completed'));
        assert.ok(ownerA.subagents.isSchedulingPaused());
        assert.ok(!ownerB.subagents.isSchedulingPaused());
        assert.equal(ownerA.activePeerAgents.size, 0);
      });
      check('conversation B mailbox and results retain exact static request prefixes after A stops', () => {
        for (const peer of scopeB) {
          assert.ok(peer.requests.length >= 2);
          assert.ok(ownerB.subagents.serialize().mailbox.find(message => message.id === peer.mailId)?.readAt);
          assert.ok(ownerB.subagents.get(peer.id).result.includes(`STOP_ISOLATION_COMPLETE_${peer.marker}`));
          for (let index = 1; index < peer.requests.length; index++) {
            const before = peer.requests[index - 1];
            const after = peer.requests[index];
            assert.equal(after.system, before.system);
            assert.deepEqual(after.tools, before.tools);
            assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
          }
        }
      });
      const resumedPeer = scopeA[0];
      ownerA.subagents.markWorking(resumedPeer.id);
      const resumedResult = await ownerA.runSubagentJob(resumedPeer.id, 'EXPLICIT_USER_CONTINUATION_AFTER_STOP', '', 'resume');
      ownerA.subagents.complete(resumedPeer.id, resumedResult);
      check('explicit resume after stop restores peer cache without injecting any stop-control message', () => {
        const first = resumedPeer.requests[0];
        const resumed = resumedPeer.requests.at(-1);
        assert.ok(resumedPeer.requests.length >= 2);
        assert.equal(resumed.system, first.system);
        assert.deepEqual(resumed.tools, first.tools);
        const stops = ownerA.subagents.serialize().mailbox.filter(message => message.control?.action === 'stop');
        assert.equal(stops.length, 4);
        assert.ok(stops.every(stop => !JSON.stringify(resumed.messages).includes(`id=${stop.id} `)));
        assert.ok(JSON.stringify(resumed.messages).includes('EXPLICIT_USER_CONTINUATION_AFTER_STOP'));
      });
      stopPressure = null;
      check('stop control is conversation-local durable mailbox data, never a model-history directive', () => {
        const mailboxA = ownerA.subagents.serialize().mailbox;
        const mailboxB = ownerB.subagents.serialize().mailbox;
        const stops = mailboxA.filter(message => message.control?.action === 'stop');
        assert.equal(stops.length, 4);
        assert.ok(stops.every(message => message.wakeup === false));
        assert.ok(!mailboxB.some(message => message.control?.action === 'stop'));
        for (const peer of pressure.peers.values()) {
          const transcript = peer.owner.subagents.get(peer.id).messages;
          assert.ok(stops.every(stop => !JSON.stringify(transcript).includes(`id=${stop.id} `)));
        }
      });
      scenarios.push({ name: 'two-conversation-stop-pressure', requests: [], peers: Array.from(pressure.peers.values()).map(({ owner: _owner, ...peer }) => peer), inboxA: inbox(ownerA), inboxB: inbox(ownerB) });
    }
  } finally {
    for (const item of owners) item.subagents.pauseScheduling();
  }
  const report = { kind: 'actual-native-kernel-settlement-receipts', createdAt: new Date().toISOString(), sourceFiles, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, checks,
    scenarios: scenarios.map(({ owner: _owner, ...scenario }) => ({ ...scenario, requests: scenario.requests.map((request, index) => {
      const previous = scenario.requests[index - 1];
      let systemBoundary;
      if (previous && previous.system !== request.system) {
        let offset = 0;
        while (previous.system[offset] === request.system[offset] && offset < previous.system.length) offset++;
        systemBoundary = { offset, before: previous.system.slice(Math.max(0, offset - 80), offset + 200), after: request.system.slice(Math.max(0, offset - 80), offset + 200) };
      }
      return { round: request.round, systemHash: hash(request.system), toolsHash: hash(request.tools), systemBoundary, messages: request.messages };
    }) })),
    limitations: ['In-process provider; no paid provider or upstream prompt-cache hit claim.', 'Exact result receipt is local durable metadata and is excluded from provider messages.', 'Both direct and hosted active roots assert static system/schema equality; a separate explicit root activation may still rebuild root routing/focus sections.'] };
  const output = option('--output');
  if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2)); }
  console.log(`Settlement receipts: ${report.passed} passed, ${report.failed} failed`);
  if (report.failed) process.exitCode = 1;
  for (const item of owners) item.flushWorkspaceConversationState();
  if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('newmark-settlement-receipts-')) throw Error('Refusing cleanup outside owned temporary fixture directory');
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return report;
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
