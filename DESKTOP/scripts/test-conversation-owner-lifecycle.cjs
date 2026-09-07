'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
if (option('--source', 'false') === 'true') {
  const Module = require('node:module'), ts = require('typescript'), native = Module._extensions['.js'];
  const files = new Map(['agent', 'subagent', 'conversationKernel'].map(name => [path.resolve(__dirname, '../dist/core/' + name + '.js'), path.resolve(__dirname, '../src/core/' + name + '.ts')]));
  Module._extensions['.js'] = (loaded, filename) => files.has(filename)
    ? loaded._compile(ts.transpileModule(fs.readFileSync(files.get(filename), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename)
    : native(loaded, filename);
}
const { Agent } = require('../dist/core/agent'), { ConversationKernel } = require('../dist/core/conversationKernel'), { SubagentManager } = require('../dist/core/subagent');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-owner-lifecycle-'));
const runStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
const output = path.resolve(option('--output', '../archive/' + runStamp + '-owner-lifecycle/result.json'));
const report = { boundary: 'Actual Agent/Kernel create, branch refresh and release; controlled standalone peer executors, no provider/HTTP/paid calls.', checks: [], counts: [] };
const check = (name, fn) => { try { fn(); report.checks.push({ name, passed: true }); } catch (error) { report.checks.push({ name, passed: false, error: String(error) }); } };
const turn = () => new Promise(resolve => setTimeout(resolve, 30));
const refs = [];
const agent = () => new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached' });
async function cycle(index) {
  const host = agent(), kernel = new ConversationKernel(root, host, null, { createRunner: agent });
  kernel.queueAction('target', 'set_pause', { paused: true });
  const owner = kernel.conversationOwner('target'), manager = owner.subagents;
  refs.push(new WeakRef(owner));
  if (index % 2) { await kernel.prepareForArchive('target'); kernel.finishArchive('target', true); }
  else kernel.disposeIdle();
  report.counts.push({ listeners: manager.rootInboxListeners.size, runtimes: kernel.runtimes.size });
  check('released facade callbacks ' + index, () => { assert.equal(manager.rootInboxListeners.size, 0); assert.equal(manager.executor, undefined); assert.equal(owner.workEventSubscribers.length, 0); });
  host.releaseConversationRuntimeBindings?.();
}
(async () => {
  for (let index = 0; index < 20; index++) await cycle(index);
  await turn(); global.gc?.(); await turn(); global.gc?.();
  report.retainedAfterGc = refs.filter(ref => ref.deref()).length;
  check('twenty disposed owners are reclaimed', () => assert.equal(report.retainedAfterGc, 0));
  if (typeof SubagentManager.prototype.releaseOwnerBinding === 'function') {
    let resolveJob, started = 0;
    const older = () => false, current = () => false;
    const executor = async () => { started++; return await new Promise(resolve => { resolveJob = resolve; }); };
    const manager = new SubagentManager({ onRootInboxMessage: older, executor });
    manager.bind({ onRootInboxMessage: current, executor });
    check('older owner cannot clear newer callbacks', () => { assert.equal(manager.releaseOwnerBinding(older), true); assert.equal(manager.executor, executor); assert.equal(manager.rootInboxListeners.has(current), true); });
    const peerId = manager.create('held peer', 'held'); await turn();
    check('running peer retains its executor and listener', () => { assert.equal(started, 1); assert.equal(manager.hasPendingWork(), true); assert.equal(manager.releaseOwnerBinding(current), false); assert.equal(manager.executor, executor); assert.ok(manager.rootInboxListeners.has(current)); });
    resolveJob('completed once'); await turn();
    check('settled peer permits owner release and keeps its result', () => { assert.equal(manager.releaseOwnerBinding(current), true); assert.equal(manager.executor, undefined); assert.equal(manager.get(peerId).result, 'completed once'); });
    const queued = new SubagentManager({ onRootInboxMessage: current, executor: async () => { started++; return 'queued result'; } });
    queued.pauseScheduling(); const queuedId = queued.create('paused peer', 'queued');
    check('paused queued peer prevents callback release', () => { assert.equal(queued.releaseOwnerBinding(current), false); assert.equal(queued.hasPendingWork(), true); assert.equal(queued.get(queuedId).status, 'queued'); });
    queued.resumeScheduling(); await turn();
    check('retained queued peer resumes exactly once', () => { assert.equal(started, 2); assert.equal(queued.get(queuedId).result, 'queued result'); assert.equal(queued.releaseOwnerBinding(current), true); });
    const restoredCalls = [], oldExecutor = async () => { restoredCalls.push('older'); return 'older still usable'; };
    const multi = new SubagentManager({ onRootInboxMessage: older, executor: oldExecutor });
    multi.bind({ onRootInboxMessage: current, executor: async () => { restoredCalls.push('current'); return 'current'; } });
    check('releasing current facade restores still-live older callbacks', () => { assert.equal(multi.releaseOwnerBinding(current), true); assert.equal(multi.executor, oldExecutor); assert.ok(multi.rootInboxListeners.has(older)); });
    const restoredId = multi.create('post-disposal peer', 'continue'); await turn();
    check('older facade can execute peer after latest facade disposal', () => { assert.deepEqual(restoredCalls, ['older']); assert.equal(multi.get(restoredId).result, 'older still usable'); });
    multi.close(restoredId); multi.releaseOwnerBinding(older);
    const host = agent(), kernel = new ConversationKernel(root, host, null, { createRunner: agent });
    kernel.queueAction('pending-peer', 'set_pause', { paused: true });
    const owner = kernel.conversationOwner('pending-peer'); owner.subagents.pauseScheduling(); const id = owner.subagents.create('queued root peer', 'wait');
    check('kernel retains queued-peer owner for disposal', () => { assert.equal(kernel.hasRetainedWork(), true); assert.throws(() => kernel.disposeIdle(), /running or queued/); assert.equal(kernel.conversationOwner('pending-peer'), owner); });
    let archiveError; try { await kernel.prepareForArchive('pending-peer'); } catch (error) { archiveError = error; }
    check('archive preparation cannot orphan queued peer', () => { assert.match(String(archiveError), /running or queued subagents/); assert.equal(owner.subagents.get(id).status, 'queued'); });
    owner.subagents.close(id); await turn(); kernel.refreshIdleConversation('pending-peer');
    check('branch refresh preserves reused owner binding', () => { assert.equal(kernel.conversationOwner('pending-peer'), owner); assert.equal(typeof owner.subagents.executor, 'function'); assert.ok(owner.subagents.rootInboxListeners.has(owner.rootInboxListener)); });
    kernel.disposeIdle(); host.releaseConversationRuntimeBindings();
    const front = agent(); front.setConversation('navigation-a');
    const navigation = new ConversationKernel(root, front, null, { createRunner: agent });
    navigation.queueAction('navigation-a', 'set_pause', { paused: true });
    const executionOwner = navigation.conversationOwner('navigation-a'), bound = executionOwner.subagents;
    let continued = 0; bound.bind({ executor: async () => { continued++; return 'completed in ' + executionOwner.activeConversationId; } });
    bound.pauseScheduling(); const navPeer = bound.create('navigation peer', 'continue after foreground navigation');
    front.setConversation('navigation-a');
    check('foreground refresh does not steal a pending executor', () => assert.equal(bound.ownsExecutionBinding(executionOwner.rootInboxListener), true));
    const temporary = agent(); temporary.setConversation('navigation-a');
    check('temporary facade releases while another owner retains pending work', () => { temporary.releaseConversationRuntimeBindings(); assert.ok(!bound.rootInboxListeners.has(temporary.rootInboxListener)); assert.equal(bound.ownsExecutionBinding(executionOwner.rootInboxListener), true); assert.equal(bound.get(navPeer).status, 'queued'); });
    check('foreground host navigates while target peer stays queued', () => { front.setConversation('navigation-b'); assert.equal(front.activeConversationId, 'navigation-b'); assert.equal(bound.get(navPeer).status, 'queued'); assert.equal(executionOwner.activeConversationId, 'navigation-a'); });
    check('execution owner direct switch rejects before state mutation', () => { assert.throws(() => executionOwner.setConversation('navigation-b'), /Cannot switch an execution owner/); assert.equal(executionOwner.activeConversationId, 'navigation-a'); assert.equal(executionOwner.subagents, bound); });
    check('execution owner storage switch rejects before state mutation', () => { assert.throws(() => executionOwner.setConversationFromStorage('navigation-b'), /Cannot switch an execution owner/); assert.equal(executionOwner.activeConversationId, 'navigation-a'); });
    check('execution owner workspace switch rejects before state mutation', () => { const workspace = executionOwner.workspace.current; assert.throws(() => executionOwner.selectWorkspace('different-workspace'), /Cannot switch an execution owner/); assert.equal(executionOwner.workspace.current, workspace); });
    bound.resumeScheduling(); await turn();
    check('original target peer still executes once after foreground navigation', () => { assert.equal(continued, 1); assert.equal(bound.get(navPeer).result, 'completed in navigation-a'); });
    navigation.disposeIdle(); front.releaseConversationRuntimeBindings();
  } else check('owner binding lifecycle API exists', () => assert.fail('Missing releaseOwnerBinding'));
  report.passed = report.checks.every(item => item.passed); report.passedChecks = report.checks.filter(item => item.passed).length; report.failedChecks = report.checks.length - report.passedChecks;
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
