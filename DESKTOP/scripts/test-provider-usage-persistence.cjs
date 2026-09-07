'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : '';
function loadAgent() {
  const filename = path.resolve(__dirname, '../dist/core/agent.js');
  if (!option('--agent-source')) return require(filename).Agent;
  const Module = require('node:module'), ts = require('typescript');
  const item = new Module(filename, module);
  item.filename = filename; item.paths = Module._nodeModulePaths(path.dirname(filename));
  item._compile(ts.transpileModule(fs.readFileSync(option('--agent-source'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, filename);
  return item.exports.Agent;
}
async function run() {
  const Agent = loadAgent();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-usage-persistence-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ workspace: { auto_create_timestamp_workspace: { value: false } }, context: { auto_compress: { value: false } } }));
  const ws = { id: 'usage-ws', name: 'Usage test', path: root, isInternal: false, kind: 'local' };
  const agents = [], checks = [];
  const make = (target = 'A', workspace = ws) => {
    const agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached' });
    agents.push(agent); agent.workspace.current = { ...workspace }; agent.workspace.external = [ws]; agent.setConversation(target); return agent;
  };
  const snapshot = agent => ({ totals: { ...agent.providerUsageTotals }, last: { ...agent.lastProviderUsage } });
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const usageA = { input: 8000, output: 400, cacheRead: 6000, cacheWrite: 50 };
  const usageB = { input: 100, output: 20, cacheRead: 20, cacheWrite: 5 };
  const check = async (name, action) => {
    try { await action(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
    catch (error) { checks.push({ name, passed: false, error: error.stack || String(error) }); console.log('FAIL ' + name + ': ' + error.message); }
  };
  try {
    const a = make();
    a.history = Array.from({ length: 1200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `entry-${i} 长对话 🧪 ${'deterministic '.repeat(32)}`, run_id: `run-${Math.floor(i / 2)}` }));
    a.chatMessages = a.history.map((m, i) => ({ role: m.role, content: m.content, runId: m.run_id, messageId: `A-${i}`, timestamp: new Date(1700000000000 + i * 1000).toISOString() }));
    const digest = messages => crypto.createHash('sha256').update(JSON.stringify(messages.map(m => ({ role: m.role, content: m.content, messageId: m.messageId, runId: m.runId, timestamp: m.timestamp })))).digest('hex');
    const originalDigest = digest(a.chatMessages);
    a.saveWorkspaceConversationState(true);
    a.recordProviderUsage(usageA);
    await new Promise(resolve => setTimeout(resolve, 140));
    await check('usage event itself schedules persistence without requiring another text event', () => assert.deepEqual(snapshot(make()), { totals: usageA, last: usageA }));
    a.saveWorkspaceConversationState(true);
    a.setConversation('B');
    await check('selecting empty B resets totals and last usage', () => assert.deepEqual(snapshot(a), { totals: zero, last: zero }));
    a.recordProviderUsage(usageB); a.setConversation('A');
    await check('switching back restores only A usage including its last request', () => assert.deepEqual(snapshot(a), { totals: usageA, last: usageA }));
    const reopened = make();
    await check('fresh Agent restores whole-conversation totals and cache ratio', () => {
      assert.deepEqual(snapshot(reopened), { totals: usageA, last: usageA });
      assert.equal(reopened.contextWindow().providerCacheReadRatio, 0.75);
    });
    await check('usage persistence does not truncate or rewrite 1200 message identities and content', () => {
      assert.equal(reopened.history.length, 1200); assert.equal(reopened.chatMessages.length, 1200); assert.equal(digest(reopened.chatMessages), originalDigest);
    });
    await check('B survives a separate restart without inheriting A', () => assert.deepEqual(snapshot(make('B')), { totals: usageB, last: usageB }));
    const ws2 = { ...ws, id: 'usage-ws-2', path: path.join(root, 'second-workspace') }; fs.mkdirSync(ws2.path);
    await check('same conversation id in another workspace starts with no provider usage', () => assert.deepEqual(snapshot(make('A', ws2)), { totals: zero, last: zero }));
    await check('branch creation and branch switching retain spent whole-conversation usage without duplicating it', () => {
      const branched = a.branchConversation('A', 2, 'Edited branch input', { messageId: 'A-2' });
      const branchUsage = snapshot(a);
      const original = branched.branches.find(branch => branch.id !== branched.activeBranchId);
      assert.ok(original); a.switchConversationBranch('A', original.id);
      assert.deepEqual(branchUsage, { totals: usageA, last: usageA });
      assert.deepEqual(snapshot(a), { totals: usageA, last: usageA });
    });
    await check('rewinding text does not invent refunds or erase already spent provider usage', () => {
      a.rewindConversation('A', 2); assert.deepEqual(snapshot(a), { totals: usageA, last: usageA });
    });
    const mirror = make('mirror');
    await check('full owner mirror transfers usage with transcript to the target', () => {
      mirror.mirrorConversationStateFrom('mirror', a); assert.deepEqual(snapshot(mirror), snapshot(a));
    });
    await check('usage snapshots do not alias a different owner or cloned target', () => {
      a.recordProviderUsage(usageB); assert.deepEqual(snapshot(mirror), { totals: usageA, last: usageA });
    });
    await check('partial history mirror preserves existing target usage when no usage was supplied', () => {
      mirror.mirrorConversationStateFrom('mirror', { chatMessages: mirror.chatMessages, history: mirror.history, conversationPlan: mirror.conversationPlan });
      assert.deepEqual(snapshot(mirror), { totals: usageA, last: usageA });
      assert.deepEqual(snapshot(make('mirror')), { totals: usageA, last: usageA });
    });
    mirror.saveWorkspaceConversationState(true);
    const archived = await mirror.archiveConversationAsync('mirror');
    await check('archive manifest retains the real cumulative and last provider usage', () => {
      assert.ok(archived); const manifest = JSON.parse(fs.readFileSync(path.join(root, 'archive', archived + '.conversation.json')));
      assert.deepEqual(manifest.entry.providerUsage, { version: 1, totals: usageA, last: usageA,
        accounting: { requests: 1, inputReportedRequests: 1, outputReportedRequests: 1, cacheReportedRequests: 1, cacheEligibleInputTokens: 8000, cacheReadTokens: 6000, hasLegacyTotals: false, lastInputTokens: 8000 }, requestContext: null });
    });
    await check('restoring an archive recovers the same measured usage exactly once', () => {
      assert.equal(mirror.restoreArchivedConversation(archived).ok, true);
      assert.deepEqual(snapshot(mirror), { totals: usageA, last: usageA });
      assert.deepEqual(snapshot(make('mirror')), { totals: usageA, last: usageA });
    });
    await check('legacy transcript without a usage field stays unknown/zero instead of inferring historic spend', () => {
      const key = mirror.workspaceConversationStateKey('legacy');
      mirror.mutateStoredConversationState(ws, state => { state.conversations[key] = { chatMessages: [{ role: 'assistant', content: 'Legacy content', timestamp: '2020-01-01T00:00:00Z' }], history: [] }; return state; });
      mirror.setConversationFromStorage('legacy'); assert.deepEqual(snapshot(mirror), { totals: zero, last: zero });
      assert.equal(mirror.chatMessages[0].content, 'Legacy content');
    });
    await check('loading with no workspace clears the preceding conversation usage', () => {
      mirror.setConversation('mirror'); mirror.workspace.current = null; mirror.loadWorkspaceConversationState();
      assert.deepEqual(snapshot(mirror), { totals: zero, last: zero });
    });
    const sync = make('archive-sync'); sync.recordProviderUsage(usageB);
    await check('synchronous archive flushes pending usage and does not resurrect the removed target', () => {
      const name = sync.archiveConversation('archive-sync'); assert.ok(name);
      sync.flushWorkspaceConversationState();
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'archive', name + '.conversation.json')));
      assert.deepEqual(manifest.entry.providerUsage, { version: 1, totals: usageB, last: usageB,
        accounting: { requests: 1, inputReportedRequests: 1, outputReportedRequests: 1, cacheReportedRequests: 1, cacheEligibleInputTokens: 100, cacheReadTokens: 20, hasLegacyTotals: false, lastInputTokens: 100 }, requestContext: null });
      assert.equal(sync.readStoredConversationState().conversations[sync.workspaceConversationStateKey('archive-sync')], undefined);
      assert.deepEqual(snapshot(sync), snapshot(make(sync.activeConversationId)));
    });
    await check('invalid persisted and incoming counters cannot publish negative, infinite or string-derived usage', () => {
      const key = sync.workspaceConversationStateKey('invalid');
      sync.mutateStoredConversationState(ws, state => {
        state.conversations[key] = { providerUsage: { version: 1, totals: { input: -10, output: Infinity, cacheRead: '400', cacheWrite: 1.9 }, last: { input: null } } };
        return state;
      });
      sync.setConversationFromStorage('invalid');
      assert.deepEqual(snapshot(sync), { totals: { ...zero, cacheWrite: 1 }, last: zero });
      sync.recordProviderUsage({ input: NaN, output: Infinity, cacheRead: -1, cacheWrite: '100' });
      assert.deepEqual(snapshot(sync), { totals: { ...zero, cacheWrite: 1 }, last: zero });
    });
    const passed = checks.every(item => item.passed);
    const result = { passed, at: new Date().toISOString(), checks, boundary: 'Actual Agent save/load/mirror/branch/rewind/archive methods in fresh isolated files; no provider request, no GUI, no production state.', source: option('--agent-source') || 'DESKTOP/dist/core/agent.js' };
    if (option('--output')) fs.writeFileSync(option('--output'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ passed, passedChecks: checks.filter(c => c.passed).length, failedChecks: checks.filter(c => !c.passed).length }));
    if (!passed) process.exitCode = 1;
  } finally {
    for (const agent of agents) agent.flushWorkspaceConversationState();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('newmark-usage-persistence-')) throw Error('Temporary cleanup path guard failed');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
