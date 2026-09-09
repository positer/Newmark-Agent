'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProduction } = require('./test-queue-continuation-identity.cjs');

async function run(options = {}) {
  const agent = loadProduction('core/agent.ts');
  const kernelModule = loadProduction('core/conversationKernel.ts', options.kernelSource);
  const { Agent } = agent.exports;
  const { ConversationKernel } = kernelModule.exports;
  const report = { boundary: 'Actual Kernel scheduling and Agent continuation persistence; controlled process acceptance/error only. No provider request or dist writes.', agentSha256: agent.sha256, kernelSha256: kernelModule.sha256, checks: [], captures: [] };
  const check = (name, passed, detail) => { report.checks.push({ name, passed: !!passed, ...(!passed ? { detail } : {}) }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); };
  for (const pathKind of ['scheduled', 'inline']) for (const failure of options.failures || ['before-accept', 'after-accept', 'mode-start']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-queue-start-'));
    const target = { workspaceId: 'fixture', conversationId: 'retry', workspace: { id: 'fixture', name: 'fixture', path: path.join(root, 'workspace'), isInternal: false, kind: 'local' } };
    fs.mkdirSync(target.workspace.path, { recursive: true });
    let runner, kernel, release, failed = false, failEnabled = true, notifications = 0;
    const calls = [], events = [];
    const ledgerState = () => {
      try {
        const ledger = JSON.parse(fs.readFileSync(path.join(target.workspace.path, 'conversations', 'continuation-ledger.json'), 'utf-8'));
        return {
          branches: Object.values(ledger.branches || {}).map(b => ({ id: b.branchId, head: b.headBuildId, tail: b.tailBuildId, rev: b.queueRevision, paused: b.paused })),
          builds: Object.values(ledger.builds || {}).map(b => ({ id: b.buildId, parent: b.parentBuildId, status: b.status, seq: b.queueSequence, waiting: b.waitingReason })),
          guards: Object.values(ledger.guards || {}).map(g => ({ id: g.branchId, active: g.activeBuildId, attempt: g.activeAttemptId, fence: g.fence, lease: g.leaseUntil })),
        };
      } catch (error) { return { error: String(error) }; }
    };
    class Probe extends Agent {
      setMode(mode) { if (failure === 'mode-start' && mode === 'chat' && failEnabled) { failed = true; throw Error('fixture pre-process mode setup failed'); } return super.setMode(mode); }
      async process(message) {
        const text = typeof message === 'string' ? message : message.text;
        calls.push(text);
        if (text === 'initial') { this.notifyAgentKernelUserMessageStart(text); return await new Promise(resolve => { release = () => resolve([]); }); }
        if (failEnabled && failure === 'before-accept') { failed = true; throw Error('fixture no configured model before acceptance'); }
        notifications++;
        this.notifyAgentKernelUserMessageStart(text, typeof message === 'string' ? undefined : message.clientMessageId);
        if (failEnabled) { failed = true; throw Error('fixture provider failed after acceptance'); }
        return [];
      }
    }
    try {
      const host = new Agent(root, { agentOnly: true });
      kernel = new ConversationKernel(root, host, null, { createRunner: () => (runner = new Probe(root, { agentOnly: true })) });
      kernel.subscribe(event => { if (event.type === 'queue_update') events.push(structuredClone(event)); });
      const work = kernel.prompt('initial', target, { mode: 'build', model: 'fixture', intelligence: 'medium', inputMode: 'next', engine: 'builtin' }).catch(error => ({ error: error.message }));
      await Promise.resolve();
      kernel.queueAction(target, 'set_pause', { paused: pathKind === 'scheduled' });
      kernel.queueAction(target, 'enqueue', { id: 'first', text: 'same', requestedMode: failure === 'mode-start' ? 'chat' : 'build', images: [{ dataUrl: 'data:image/png;base64,Zml4dHVyZQ==', name: 'fixture.png' }], createdAt: '2026-09-06T00:00:01Z' });
      kernel.queueAction(target, 'enqueue', { id: 'second', text: 'same', requestedMode: 'build', createdAt: '2026-09-06T00:00:02Z' });
      const subscribers = runner.agentKernelUserMessageStartSubscribers.length;
      release();
      await work;
      if (pathKind === 'scheduled') kernel.queueAction(target, 'set_pause', { paused: false });
      for (let i = 0; i < 100 && (!failed || kernel.isRunning(target)); i++) await new Promise(r => setTimeout(r, 5));
      await new Promise(r => setTimeout(r, 40));
      const rows = kernel.queueItems(target), durable = runner.conversationContinuations(), snapshot = kernel.snapshot(target);
      const expectedIds = failure === 'after-accept' ? ['second'] : ['first', 'second'];
      const label = `${pathKind}/${failure}`;
      check(`${label}: failure boundary was reached`, failed && notifications === (failure === 'after-accept' ? 1 : 0), { failed, notifications });
      check(`${label}: visible and durable queues agree by identity`, JSON.stringify(rows.map(x => x.id)) === JSON.stringify(expectedIds) && JSON.stringify(durable.map(x => x.clientMessageId)) === JSON.stringify(expectedIds), { rows, durable });
      check(`${label}: failure pauses queue without a retry loop`, snapshot.queuePaused && !snapshot.runtime?.running && calls.length === (failure === 'mode-start' ? 1 : 2), { paused: snapshot.queuePaused, runtime: snapshot.runtime, calls });
      check(`${label}: target queue event publishes the recoverable state`, events.some(e => e.queuePaused && JSON.stringify(e.queueItems?.map(x => x.id)) === JSON.stringify(expectedIds)), events.at(-1));
      check(`${label}: acceptance observers are released`, runner.agentKernelUserMessageStartSubscribers.length === subscribers);
      if (failure !== 'after-accept') check(`${label}: failed row retains attachment, mode and submission time`, rows[0]?.images?.[0]?.name === 'fixture.png' && rows[0]?.requestedMode === (failure === 'mode-start' ? 'chat' : 'build') && rows[0]?.createdAt === '2026-09-06T00:00:01Z', rows[0]);
      report.captures.push({ label, rows, durable, paused: snapshot.queuePaused, calls: [...calls], notifications, ledgerBeforeResume: ledgerState() });
      failEnabled = false;
      kernel.queueAction(target, 'set_pause', { paused: false });
      await new Promise(r => setImmediate(r)); await kernel.waitForIdle(target);
      for (let wait = 0; wait < 200 && kernel.queueItems(target).length > 0; wait += 1) {
        await new Promise(r => setTimeout(r, 5));
      }
      const resumeRows = kernel.queueItems(target);
      const resumeLedger = ledgerState();
      if (failure === 'after-accept') {
        const blocked = resumeLedger.builds?.find(build => build.id === resumeRows[0]?.buildId);
        check(`${label}: a failed accepted predecessor blocks its successor with DEPENDENCY_FAILED instead of silently skipping it`,
          notifications === 1 && resumeRows.length === 1 && blocked?.waiting === 'DEPENDENCY_FAILED',
          { notifications, calls, rows: resumeRows, ledger: resumeLedger });
      } else {
        check(`${label}: explicit resume processes only unaccepted rows once`,
          notifications === 2 && resumeRows.length === 0 && runner.conversationContinuations().length === 0,
          { notifications, calls, rows: resumeRows, durable: runner.conversationContinuations(), ledger: resumeLedger });
      }
    } finally { release?.(); kernel?.flushPersistence(); fs.rmSync(root, { recursive: true, force: true }); }
  }
  report.checksPassed = report.checks.filter(x => x.passed).length; report.checksFailed = report.checks.length - report.checksPassed; report.passed = !report.checksFailed;
  if (options.reportPath) fs.writeFileSync(options.reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checksPassed: report.checksPassed, checksFailed: report.checksFailed }));
  if (!report.passed) throw Error('Queue start failure regression failed');
  return report;
}
module.exports = { run };
if (require.main === module) { const args = process.argv.slice(2); const arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined; run({ kernelSource: arg('--kernel-source'), reportPath: arg('--report') }).catch(e => { console.error(e.stack || e); process.exitCode = 1; }); }
