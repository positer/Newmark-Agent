'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../dist/core/agent.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-context-usage-owner-'));
const checks = [];
const agents = [];
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ workspace: { auto_create_timestamp_workspace: false }, context: { auto_compress: false } }));
const workspace = { id: 'usage-owner', name: 'Usage ownership', path: root, isInternal: false, hostBinding: '', icon: '', kind: 'local' };
const make = id => {
  const agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached' });
  agents.push(agent); agent.workspace.current = { ...workspace }; agent.setConversation(id); return agent;
};
const check = async (name, fn) => {
  try { await fn(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); console.log('FAIL ' + name + ': ' + error.message); }
};
const sample = { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 };
(async () => {
  const agent = make('A');
  await check('new conversation reports unknown cache rate, not zero percent', () => {
    assert.equal(agent.contextWindow().providerCacheReadRatio, null);
    assert.equal(agent.contextWindow().providerUsageRequests, 0);
  });
  await check('cumulative request usage is counted once and survives a final partial update', () => {
    const request = agent.beginProviderUsageRequest();
    agent.recordProviderUsage(sample, request); agent.recordProviderUsage(sample, request);
    agent.recordProviderUsage({ output: 25 }, request);
    assert.deepEqual(agent.providerUsageTotals, { ...sample, output: 25 });
    assert.equal(agent.contextWindow().providerCacheReadRatio, 0.8);
    assert.equal(agent.contextWindow().providerUsageRequests, 1);
  });
  await check('missing cache does not silently lower measured weighted rate', () => {
    agent.recordProviderUsage({ input: 900, output: 40, cacheRead: 0, cacheWrite: 0, reported: { input: true, output: true, cacheRead: false, cacheWrite: false } });
    const c = agent.contextWindow();
    assert.equal(c.providerCacheReadRatio, null); assert.equal(c.providerKnownCacheReadRatio, 0.8);
    assert.equal(c.providerCacheEligibleInputTokens, 100); assert.equal(c.providerUsageCacheReportedRequests, 1);
  });
  await check('explicit zero cache contributes its measured input to weighted denominator', () => {
    agent.recordProviderUsage({ input: 300, output: 5, cacheRead: 0, cacheWrite: 0 });
    assert.equal(agent.contextWindow().providerKnownCacheReadRatio, 0.2);
    assert.equal(agent.contextWindow().providerCacheEligibleInputTokens, 400);
  });
  await check('a request without any usage remains visible as missing coverage', () => {
    agent.beginProviderUsageRequest(); assert.equal(agent.contextWindow().providerUsageRequests, 4);
    assert.equal(agent.contextWindow().providerUsageInputReportedRequests, 3);
  });
  let snapshot;
  await check('actual submitted context includes system, tools, long history and current Build', () => {
    agent.activeWorkRunId = 'current'; agent.attachAgentKernelRuntime({ steer() {}, followUp() {} });
    agent.history = [{ role: 'user', content: 'old stored projection', run_id: 'older' }];
    const request = agent.beginProviderUsageRequest();
    const messages = [{ role: 'user', content: 'long history '.repeat(90), run_id: 'older' },
      { role: 'user', content: 'current task', run_id: 'current' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'pwd-1', function: { name: 'pwd', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'pwd-1', content: 'fresh result '.repeat(60) }];
    agent.recordRequestContext(request, messages, 'stable system '.repeat(80), [{ type: 'function', function: { name: 'pwd', parameters: { type: 'object' } } }], 'fixture-model');
    agent.recordProviderUsage({ input: 4321, output: 10, cacheRead: 3200, cacheWrite: 0 }, request);
    const c = agent.contextWindow(); snapshot = c.requestContext;
    assert.equal(c.contextEstimateSource, 'active_request'); assert.equal(snapshot.messageCount, 4);
    assert.equal(c.estimatedTokens, c.longHistoryTokens + c.buildBlockTokens + c.systemPromptTokens + c.toolSchemaTokens);
    assert.ok(c.longHistoryTokens > 0 && c.buildBlockTokens > 0 && c.systemPromptTokens > 0 && c.toolSchemaTokens > 0);
    assert.equal(snapshot.inputTokens, 4321); assert.notEqual(c.estimatedTokens, 4321);
  });
  await check('idle context uses present history and preserves separate last-request evidence', () => {
    agent.attachAgentKernelRuntime(null); agent.activeWorkRunId = '';
    const c = agent.contextWindow(); assert.equal(c.contextEstimateSource, 'history');
    assert.equal(c.requestContext.requestId, snapshot.requestId); assert.equal(c.requestContext.inputTokens, 4321);
  });
  await check('late main usage remains owned by A while B is selected', () => {
    const pending = agent.beginProviderUsageRequest(); agent.setConversation('B');
    agent.recordProviderUsage(sample, pending); assert.equal(agent.contextWindow().providerInputTokens, 0);
    agent.setConversation('A'); assert.equal(agent.contextWindow().providerInputTokens, 5721);
  });
  await check('late title/compaction-style auxiliary callback stays with its captured conversation', async () => {
    let done;
    const provider = { chat(...args) { return new Promise(resolve => { done = () => { args[7](sample); resolve('fixture text'); }; }); } };
    const pending = agent.chatWithConversationUsage(provider, 'fixture', [], '', 0, 20);
    agent.setConversation('B'); done(); await pending;
    assert.equal(agent.contextWindow().providerInputTokens, 0); agent.setConversation('A');
    assert.equal(agent.contextWindow().providerInputTokens, 5821);
    assert.equal(agent.contextWindow().requestContext.inputTokens, 4321, 'auxiliary usage does not replace main-request measurement');
  });
  await check('coverage and request evidence survive cold load with no double charge', () => {
    agent.saveWorkspaceConversationState(true); const cold = make('A');
    assert.deepEqual(cold.conversationProviderUsage(), agent.conversationProviderUsage());
  });
  await check('B pending store flush cannot roll back late A usage or lose its own pending usage', async () => {
    const owner = make('race-A'); owner.recordProviderUsage(sample); owner.saveWorkspaceConversationState(true);
    const pendingA = owner.beginProviderUsageRequest(); owner.setConversation('race-B');
    owner.recordProviderUsage({ input: 42, output: 4, cacheRead: 0, cacheWrite: 0 });
    owner.recordProviderUsage(sample, pendingA);
    const file = owner.workspaceConversationStorePath(owner.workspace.current);
    const keyA = owner.workspaceConversationStateKeyFor('race-A', owner.workspace.current);
    const keyB = owner.workspaceConversationStateKeyFor('race-B', owner.workspace.current);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).conversations[keyA].providerUsage.totals.input, 200);
    await new Promise(resolve => setTimeout(resolve, 180));
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')).conversations;
    assert.equal(stored[keyA].providerUsage.totals.input, 200);
    assert.equal(stored[keyB].providerUsage.totals.input, 42);
    assert.equal(stored[keyA].providerUsage.accounting.requests, 2);
  });
  await check('full owner mirror transfers usage provenance without mutable aliasing', () => {
    const mirror = make('mirror'); mirror.mirrorConversationStateFrom('mirror', agent);
    assert.deepEqual(mirror.conversationProviderUsage(), agent.conversationProviderUsage());
    const prior = mirror.contextWindow().providerInputTokens; agent.recordProviderUsage(sample);
    assert.equal(mirror.contextWindow().providerInputTokens, prior);
  });
  await check('legacy totals remain available but cannot pretend complete reporting coverage', () => {
    const legacy = make('legacy'); legacy.restoreProviderUsage({ version: 1, totals: sample, last: sample });
    assert.equal(legacy.contextWindow().providerInputTokens, 100);
    assert.equal(legacy.contextWindow().providerCacheReadRatio, null);
    assert.equal(legacy.contextWindow().providerUsageHasLegacyTotals, true);
  });
  for (const item of agents) item.flushWorkspaceConversationState();
  const result = { at: new Date().toISOString(), root, passed: checks.every(c => c.passed), checks };
  const option = process.argv.indexOf('--output');
  if (option >= 0) fs.writeFileSync(process.argv[option + 1], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: result.passed, checks: checks.length }));
  if (!result.passed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const item of agents) { try { item.flushWorkspaceConversationState(); } catch {} }
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('newmark-context-usage-owner-')) throw new Error('Temp path guard failed');
  fs.rmSync(root, { recursive: true, force: true });
});
