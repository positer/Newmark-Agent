'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const ts = require('typescript');

// Fresh production Kernel/Agent code, compiled in memory against the existing
// dependency runtime. No dist writes, HTTP server or external provider calls.
function loadProduction(relative, override) {
  const file = path.join(__dirname, '..', 'dist', relative.replace(/\.ts$/, '.js'));
  const sourcePath = override || path.join(__dirname, '..', 'src', relative);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const item = new Module(file, module);
  item.filename = file;
  item.paths = Module._nodeModulePaths(path.dirname(file));
  item._compile(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText, file);
  return { exports: item.exports, sha256: crypto.createHash('sha256').update(source).digest('hex') };
}

async function run(options = {}) {
  const loadedAgent = loadProduction('core/agent.ts', options.agentSource);
  const loadedKernel = loadProduction('core/conversationKernel.ts', options.kernelSource);
  const { Agent } = loadedAgent.exports;
  const { ConversationKernel } = loadedKernel.exports;
  const receipt = { passed: false, agentSha256: loadedAgent.sha256, kernelSha256: loadedKernel.sha256,
    boundary: 'Real production Kernel and Agent persistence, in-memory TypeScript compilation; only process/provider boundary is controlled.', checks: [], states: [] };
  const check = (name, ok, detail) => {
    receipt.checks.push({ name, passed: !!ok, ...(!ok ? { detail } : {}) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  };
  const prefix = '[Next queued while current turn is running]\n';
  const strip = text => String(text).replace(prefix, '');
  const waitForQueueDrain = async (kernel, target, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (kernel.queueItems(target).length === 0 && kernel.queued(target).followUp.length === 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const cases = (process.env.QUEUE_SCENARIOS
    ? process.env.QUEUE_SCENARIOS.split(',').map(value => value.trim()).filter(Boolean)
    : ['delete-second', 'edit-first', 'edit-second', 'reorder', 'guide-deferred', 'drain-duplicates', 'paused-resume', 'target-mismatch']);
  for (const scenario of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-queue-identity-kernel-'));
    const target = { workspaceId: 'queue-fixture', conversationId: 'identity', workspace: {
      id: 'queue-fixture', name: 'fixture', path: path.join(root, 'workspace'), isInternal: false, kind: 'local',
    } };
    fs.mkdirSync(target.workspace.path, { recursive: true });
    let runner;
    let kernel;
    class Probe extends Agent {
      inputs = [];
      runIds = [];
      conversationIds = [];
      visibleQueuesAtStart = [];
      release = null;
      queueActiveKernelMessage() { return false; }
      async process(input) {
        this.inputs.push(input);
        this.runIds.push(this.currentWorkRunId());
        this.conversationIds.push(this.activeConversationId);
        const text = typeof input === 'string' ? input : input.text;
        this.notifyAgentKernelUserMessageStart(text, typeof input === 'string' ? undefined : input.clientMessageId);
        if (this.inputs.length > 1) this.visibleQueuesAtStart.push(kernel.queued(target).followUp.map(strip));
        if (this.inputs.length === 1) return await new Promise(resolve => { this.release = () => resolve([{ type: 'text', text: 'initial completed' }]); });
        return [{ type: 'text', text: `completed ${this.inputs.length}` }];
      }
    }
    try {
      const host = new Agent(root, { agentOnly: true });
      kernel = new ConversationKernel(root, host, null, { createRunner: () => (runner = new Probe(root, { agentOnly: true })) });
      const events = [];
      kernel.subscribe(event => { if (event.type === 'queue_update' && Array.isArray(event.queueItems)) events.push(structuredClone(event)); });
      const work = kernel.prompt('initial held request', target, { mode: 'build', model: 'fixture', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }, 'followUp');
      await Promise.resolve();
      if (scenario === 'target-mismatch') {
        kernel.queueAction(target, 'enqueue', {
          id: 'foreign', text: 'must-not-run', requestedMode: 'build',
          createdAt: '2026-09-06T00:00:04.000Z',
          targetRuntimeKey: 'workspace:external:wrong::conversation:other',
        });
      } else {
        for (const [id, text] of [['first', 'same'], ['middle', 'between'], ['second', 'same']]) kernel.queueAction(target, 'enqueue', {
          id, text, requestedMode: 'build', createdAt: `2026-09-06T00:00:0${id === 'first' ? 1 : id === 'middle' ? 2 : 3}.000Z`,
        });
      }
      const initial = runner.conversationContinuations();
      let authoritativeReorderRejected = false;
      if (scenario === 'delete-second') kernel.queueAction(target, 'delete', { id: 'second' });
      if (scenario === 'edit-first' || scenario === 'edit-second') kernel.queueAction(target, 'update', { id: scenario === 'edit-first' ? 'first' : 'second', text: 'edited' });
      if (scenario === 'reorder') {
        try {
          kernel.queueAction(target, 'reorder', { orderedIds: ['second', 'middle', 'first'] });
        } catch (error) {
          authoritativeReorderRejected = String(error && error.message || error).includes('fixed parents');
        }
      }
      if (scenario === 'guide-deferred') {
        const guided = kernel.queueAction(target, 'guide', { id: 'second' });
        check(`${scenario}: Guide uses the selected id and is accepted or deferred`, guided.receipt?.clientMessageId === 'second' && ['accepted', 'deferred'].includes(guided.receipt.status), guided);
        check(`${scenario}: durable promoted Guide survives removal of the old Next`, runner.conversationContinuations().some(item => item.clientMessageId === 'second' && item.queueMode === 'steer'), runner.conversationContinuations());
      }
      const rows = kernel.queueItems(target);
      const queue = kernel.queued(target).followUp.map(strip);
      const persisted = runner.conversationContinuations();
      const followUps = persisted.filter(item => item.queueMode === 'followUp');
      check(`${scenario}: projected text order equals authoritative item order`, JSON.stringify(queue) === JSON.stringify(rows.map(item => item.text)), { rows, queue });
      if (scenario === 'reorder') check(`${scenario}: reordering admitted builds is rejected instead of silently rebasing parents`, authoritativeReorderRejected === true);
      check(`${scenario}: durable id order equals authoritative item order`, JSON.stringify(followUps.map(item => item.clientMessageId)) === JSON.stringify(rows.map(item => item.id)), { rows, persisted });
      check(`${scenario}: every structured queue event agrees with its rows`, events.length > 0 && events.every(event => JSON.stringify(event.queue.followUp.map(strip)) === JSON.stringify(event.queueItems.map(item => item.text))), events.filter(event => JSON.stringify(event.queue.followUp.map(strip)) !== JSON.stringify(event.queueItems.map(item => item.text))));
      if (scenario.startsWith('edit')) check(`${scenario}: editing preserves original submission timestamps`, followUps.every(item => item.createdAt === initial.find(old => old.clientMessageId === item.clientMessageId)?.createdAt), followUps);
      if (scenario === 'paused-resume') kernel.queueAction(target, 'toggle_pause');
      runner.release();
      await work;
      if (scenario === 'target-mismatch') {
        await new Promise(resolve => setTimeout(resolve, 200));
        check(`${scenario}: a queued turn for another conversation never executes here`, runner.inputs.length === 1, { inputs: runner.inputs.map(item => strip(typeof item === 'string' ? item : item.text)) });
        check(`${scenario}: the mismatched turn stays paused for correction`, kernel.queueItems(target).length === 1 && kernel.snapshot(target).queuePaused === true, { items: kernel.queueItems(target), paused: kernel.snapshot(target).queuePaused });
        continue;
      }
      if (scenario === 'paused-resume') {
        check(`${scenario}: paused queue does not execute when the first turn finishes`, runner.inputs.length === 1 && kernel.queueItems(target).length === 3);
        kernel.queueAction(target, 'toggle_pause');
      }
      // A Next item is now a new user turn: it drains after the previous run
      // settles, so wait for the deferred scheduler instead of assuming the
      // first prompt promise still owns the whole queue.
      await waitForQueueDrain(kernel, target);
      const processed = runner.inputs.slice(1).map(item => strip(typeof item === 'string' ? item : item.text));
      // A promoted Guide steers the Build that is currently running; the
      // remaining Next rows are fresh user turns that start only after that
      // Build has settled.
      const expected = scenario === 'guide-deferred'
        ? ['same', ...rows.map(item => item.text)]
        : rows.map(item => item.text);
      check(`${scenario}: actual process calls drain each selected item once in order`, JSON.stringify(processed) === JSON.stringify(expected), { processed, expected });
      const queuedRunIds = scenario === 'guide-deferred' ? runner.runIds.slice(2) : runner.runIds.slice(1);
      check(`${scenario}: every queued Next starts a fresh Build run`,
        queuedRunIds.length > 0
        && queuedRunIds.every(id => !!id && id !== runner.runIds[0])
        && new Set(queuedRunIds).size === queuedRunIds.length,
        { runIds: runner.runIds });
      check(`${scenario}: every process call stays in the target conversation`,
        runner.conversationIds.length > 0 && runner.conversationIds.every(id => id === 'identity'),
        { conversationIds: runner.conversationIds });
      check(`${scenario}: final queue and persisted continuations are empty`, kernel.queueItems(target).length === 0 && kernel.queued(target).followUp.length === 0 && runner.conversationContinuations().length === 0, runner.conversationContinuations());
      if (scenario === 'drain-duplicates') check(`${scenario}: starting first duplicate does not remove the later duplicate from UI`, JSON.stringify(runner.visibleQueuesAtStart[0]) === JSON.stringify(['between', 'same']), runner.visibleQueuesAtStart);
      receipt.states.push({ scenario, rows, queue, persisted, processed, visibleQueuesAtStart: runner.visibleQueuesAtStart });
    } finally {
      runner?.release?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  receipt.checksPassed = receipt.checks.filter(item => item.passed).length;
  receipt.checksFailed = receipt.checks.length - receipt.checksPassed;
  receipt.passed = receipt.checksFailed === 0;
  if (options.reportPath) { fs.mkdirSync(path.dirname(path.resolve(options.reportPath)), { recursive: true }); fs.writeFileSync(options.reportPath, JSON.stringify(receipt, null, 2) + '\n'); }
  console.log(JSON.stringify({ passed: receipt.passed, checksPassed: receipt.checksPassed, checksFailed: receipt.checksFailed }));
  if (!receipt.passed) throw new Error(`Queue identity: ${receipt.checksFailed} assertions failed`);
  return receipt;
}
module.exports = { run, loadProduction };
if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  run({ reportPath: arg('--report'), kernelSource: arg('--kernel-source'), agentSource: arg('--agent-source') })
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
