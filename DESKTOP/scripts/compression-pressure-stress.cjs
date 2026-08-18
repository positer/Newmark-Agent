'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../dist/core/agent.js');

let assertions = 0;

function check(condition, label, detail = '') {
  assertions += 1;
  if (!condition) throw new Error(`[FAIL] ${label}${detail ? `: ${detail}` : ''}`);
  console.log(`[compression-pressure] PASS ${label}`);
}

function fixtureAgent(root, name, maxTokens) {
  const agentRoot = path.join(root, name);
  fs.mkdirSync(agentRoot, { recursive: true });
  const agent = new Agent(agentRoot, {
    agentOnly: true,
    workspaceRegistryMode: 'detached',
    conversationId: name,
  });
  agent.workspace.current = null;
  agent.config.clearWorkspaceOverrides();
  const providerId = `compression-pressure-${name}`;
  const modelId = `compression-pressure-model-${name}`;
  agent.config.upsertProvider(providerId, `https://${name}.compression-pressure.invalid/v1`, `fixture-${name}`);
  agent.config.addModelToProvider(providerId, modelId, `Compression pressure ${name}`, 'Deterministic compression pressure fixture');
  agent.config.updateModel(providerId, modelId, { max_tokens: maxTokens });
  agent.setModel(modelId);
  agent.config.set('context', 'auto_compress', true);
  agent.config.set('context', 'compression_archive_enabled', true);
  agent.config.set('context', 'keep_recent_messages', 4);
  agent.config.set('context', 'preserve_recent_messages', 5);
  return agent;
}

function history(count, chars, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix}-${index} ` + 'x'.repeat(chars),
  }));
}

function displayMessages(prefix, count = 4) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix}-display-${index}`,
    mode: 'build',
    model: 'compression-pressure-model',
    timestamp: new Date().toISOString(),
  }));
}

class FixtureProvider {
  constructor({ summary, finalText, toolName = '', toolArgs = {}, toolSequence = [] }) {
    this.summary = summary;
    this.finalText = finalText;
    this.toolName = toolName;
    this.toolArgs = toolArgs;
    this.toolSequence = toolSequence;
    this.chatCalls = 0;
    this.streamCalls = 0;
    this.toolCalls = 0;
    this.streamPayloads = [];
  }

  intelligenceConfig() {
    return { temperature: 0, maxTokens: 128 };
  }

  async chat(_model, _messages, _system, _temperature, _maxTokens, signal) {
    if (signal?.aborted) throw new Error('fixture compression aborted');
    this.chatCalls += 1;
    return this.summary;
  }

  async *chatStreamWithTools(_model, _messages, _system, _tools, _temperature, _maxTokens, signal) {
    if (signal?.aborted) return;
    this.streamCalls += 1;
    this.streamPayloads.push(_messages);
    const sequenceEntry = this.toolSequence[this.streamCalls - 1];
    const requestedTool = sequenceEntry || (this.toolName && this.streamCalls === 1 ? { name: this.toolName, args: this.toolArgs } : null);
    if (requestedTool) {
      this.toolCalls += 1;
      yield {
        type: 'tool_call',
        text: '',
        toolCall: {
          id: `compression-pressure-tool-${this.toolCalls}`,
          name: requestedTool.name,
          arguments: JSON.stringify(requestedTool.args || {}),
        },
      };
      return;
    }
    yield { type: 'text', text: this.finalText };
  }
}

async function runAutomaticCompression(root) {
  const agent = fixtureAgent(root, 'automatic', 2_000);
  agent.history = history(72, 1_000, 'AUTO_HISTORY');
  agent.chatMessages = displayMessages('automatic');
  const visiblePrefix = JSON.stringify(agent.chatMessages);
  const beforeHistory = agent.history.length;
  const provider = new FixtureProvider({
    summary: '## Active Or Unfinished Work\nKeep AUTO_NEW_TASK_MARKER and the active release gate.',
    finalText: 'AUTO_COMPRESSION_PROCESS_OK',
  });
  agent.forcedProvider = provider;

  const output = (await agent.process('AUTO_NEW_TASK_MARKER')).map(token => token.text || '').join('');
  check(output.includes('AUTO_COMPRESSION_PROCESS_OK'), 'automatic compression completes the real Agent request');
  check(Boolean(agent.lastCompression) && agent.history.length < beforeHistory + 2,
    'automatic threshold compression reduces durable LLM history');
  check(provider.chatCalls >= 1 && provider.streamCalls >= 1,
    'automatic compression uses the provider summary path and then resumes the request');
  check(JSON.stringify(agent.history).includes('AUTO_NEW_TASK_MARKER'),
    'automatic compression retains the newest user instruction');
  check(JSON.stringify(agent.chatMessages).startsWith(visiblePrefix.slice(0, -1)),
    'automatic compression does not rewrite the pre-existing visible history');

  const repeatMessages = history(64, 1_000, 'AUTO_IDEMPOTENT');
  const repeatProvider = new FixtureProvider({
    summary: '## Active Or Unfinished Work\nPreserve the idempotent compression marker.',
    finalText: 'unused',
  });
  const first = await agent.maybeCompress(repeatMessages, repeatProvider, undefined, agent.activeModelName());
  const callsAfterFirst = repeatProvider.chatCalls;
  const second = await agent.maybeCompress(repeatMessages, repeatProvider, undefined, agent.activeModelName());
  check(first === true && second === false, 'automatic compression is idempotent below its incremental-growth guard');
  check(repeatProvider.chatCalls === callsAfterFirst, 'idempotent repeat does not call the compression model again');
}

async function runDispatchedCompressionTools(root) {
  const active = fixtureAgent(root, 'active-compress', 16_000);
  active.history = history(30, 800, 'ACTIVE_COMPRESS');
  active.chatMessages = displayMessages('active-compress');
  const visibleBefore = JSON.stringify(active.chatMessages);
  const before = active.history.length;
  const compressProvider = new FixtureProvider({
    summary: '## Active Or Unfinished Work\nPreserve ACTIVE_CONTEXT_TOOL_REQUEST and the release test.',
    finalText: 'ACTIVE_CONTEXT_TOOL_OK',
    toolSequence: [
      { name: 'tool_provision', args: { names: ['context_compress'] } },
      { name: 'context_compress', args: { force: true, keep_recent: 4 } },
    ],
  });
  active.forcedProvider = compressProvider;
  const compressOutput = (await active.process('ACTIVE_CONTEXT_TOOL_REQUEST: call context_compress now.')).map(token => token.text || '').join('');
  check(compressOutput.includes('ACTIVE_CONTEXT_TOOL_OK'), 'model-dispatched context_compress returns to the same Build');
  check(compressProvider.toolCalls === 2 && compressProvider.chatCalls >= 1 && Boolean(active.lastCompression),
    'model-dispatched context_compress invokes the active compression handler and summary provider',
    JSON.stringify({ toolCalls: compressProvider.toolCalls, chatCalls: compressProvider.chatCalls, streamCalls: compressProvider.streamCalls, lastCompression: active.lastCompression }));
  check(active.history.length < before + 2, 'model-dispatched context_compress reduces the active context');
  check(JSON.stringify(active.chatMessages.slice(0, 4)) === visibleBefore,
    'active context_compress leaves displayed conversation entries unchanged');

  const manager = fixtureAgent(root, 'active-history-manager', 128_000);
  manager.history = history(24, 700, 'ACTIVE_HISTORY');
  manager.chatMessages = displayMessages('active-history-manager');
  const managerVisibleBefore = JSON.stringify(manager.chatMessages);
  const managerBefore = manager.history.length;
  const managerProvider = new FixtureProvider({
    summary: 'unused',
    finalText: 'ACTIVE_HISTORY_TOOL_OK',
    toolSequence: [
      { name: 'tool_provision', args: { names: ['context_history_manage'] } },
      { name: 'context_history_manage', args: { action: 'summarize', position: 0, to: 4 } },
    ],
  });
  manager.forcedProvider = managerProvider;
  const managerOutput = (await manager.process('ACTIVE_HISTORY_TOOL_REQUEST: call context_history_manage to fold the older range.')).map(token => token.text || '').join('');
  check(managerOutput.includes('ACTIVE_HISTORY_TOOL_OK'), 'model-dispatched context_history_manage returns to the same Build');
  check(managerProvider.toolCalls === 2 && manager.history.length < managerBefore + 2
    && manager.history.some(message => String(message.content || '').includes('[Context History Summary]')),
  'model-dispatched context_history_manage folds an older range',
  JSON.stringify({ history: manager.history.length, before: managerBefore, toolCalls: managerProvider.toolCalls, toolResult: managerProvider.streamPayloads[2]?.at(-1) }));
  check(JSON.stringify(manager.chatMessages.slice(0, 4)) === managerVisibleBefore,
    'active context_history_manage leaves displayed conversation entries unchanged');
}

function runHistoryArchivePressure(root) {
  const agent = fixtureAgent(root, 'history-archive', 128_000);
  const workspacePath = path.join(agent.rootPath, 'archive-workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  agent.workspace.current = {
    id: 'compression-pressure-archive-workspace',
    name: 'compression-pressure-archive-workspace',
    path: workspacePath,
    isInternal: false,
    kind: 'local',
    hostBinding: '',
    icon: '',
  };
  agent.config.set('context', 'compression_cache_max', 3);
  agent.history = history(100, 1_700, 'COLD_UNIQUE');
  agent.chatMessages = displayMessages('history-archive');
  const visibleBefore = JSON.stringify(agent.chatMessages);

  for (let round = 0; round < 12; round += 1) {
    const result = agent.handleContextHistoryManage(JSON.stringify({ action: 'summarize', position: round, to: round + 4 }));
    const body = JSON.parse(result.output);
    check(body.ok === true && body.foldedEntries === 5, `history manager pressure fold ${round + 1}/12`);
  }

  const status = JSON.parse(agent.handleContextHistoryManage(JSON.stringify({ action: 'status' })).output);
  check(status.cache.entries === 3 && status.archive.enabled === true && status.archive.entries >= 9,
    'bounded hot cache evicts older folds into the append-only cold archive', JSON.stringify(status));
  check(status.protectedZone.protectedStartIndex > 0 && status.displayHistory.untouched === true,
    'history manager status reports the protected tail without touching visible history');

  const coldSearch = JSON.parse(agent.handleContextHistoryManage(JSON.stringify({ action: 'search', query: 'COLD_UNIQUE-0' })).output);
  const coldId = String(coldSearch.matches?.find(match => match.source === 'cold-archive')?.cacheId || '');
  check(coldSearch.ok === true && coldId.startsWith('ctx-cache-'),
    'history manager search reaches a cold-archive fold after repeated active summarization');

  const historyBeforeRead = JSON.stringify(agent.history);
  const firstPage = JSON.parse(agent.handleContextHistoryManage(JSON.stringify({
    action: 'read', restore_id: coldId, limit: 1, max_chars: 1_000,
  })).output);
  const secondPage = JSON.parse(agent.handleContextHistoryManage(JSON.stringify({
    action: 'read', restore_id: coldId, offset: firstPage.nextOffset, content_offset: firstPage.nextContentOffset,
    limit: 1, max_chars: 4_000,
  })).output);
  check(firstPage.ok === true && firstPage.source === 'cold-archive' && firstPage.messages?.[0]?.truncated === true
    && String(firstPage.messages[0].content).includes('COLD_UNIQUE-0')
    && String(secondPage.messages?.[0]?.content || '').length > 0,
  'history manager read provides bounded character paging for a cold fold');
  check(JSON.stringify(agent.history) === historyBeforeRead && JSON.stringify(agent.chatMessages) === visibleBefore,
    'cold read is non-injecting and visible history remains byte-identical');

  const hotId = String(status.cache.ids.at(-1) || '');
  const hotRestore = JSON.parse(agent.handleContextHistoryManage(JSON.stringify({ action: 'restore', restore_id: hotId })).output);
  check(hotRestore.ok === true && hotRestore.source === 'hot-cache' && hotRestore.restoredEntries === 5,
    'history manager restores a current hot-cache fold');
  const coldRestore = JSON.parse(agent.handleContextHistoryManage(JSON.stringify({ action: 'restore', restore_id: coldId })).output);
  check(coldRestore.ok === true && coldRestore.source === 'cold-archive' && coldRestore.restoredEntries === 5,
    'history manager restores a cold-archive fold through its explicit restore action');
  check(JSON.stringify(agent.chatMessages) === visibleBefore,
    'hot/cold restore operations never alter displayed conversation history');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-compression-pressure-'));
  const started = Date.now();
  try {
    await runAutomaticCompression(root);
    await runDispatchedCompressionTools(root);
    runHistoryArchivePressure(root);
    console.log(JSON.stringify({
      ok: true,
      assertions,
      durationMs: Date.now() - started,
      scope: ['automatic-threshold', 'automatic-idempotency', 'context_compress-dispatch', 'context_history_manage-dispatch', 'hot-cache', 'cold-archive', 'paged-read', 'hot-cold-restore'],
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`[compression-pressure] ${error?.stack || error}`);
  process.exitCode = 1;
});
