'use strict';

// Execute the actual main-process Flow lifecycle and mobile-state projection.
// Only the runFlow/Agent/pool boundaries are controlled; no Electron process,
// network listener, production root or globally compiled dist is used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

function sourceParts(source) {
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(['activeFlowStateKey', 'activeFlowStateFor', 'persistedFlowSuspensionRecord',
    'flowSuspensionForTarget', 'flowRunningForTarget', 'flowAgentTarget', 'setTargetFlowMode',
    'discardFlowSuspensionForTarget', 'resumeFlowForTarget', 'stopFlowForTarget']);
  if (source.includes('const submitConversationCommand')) names.add('runtimeSnapshotForTarget');
  const found = new Map();
  let projection = '';
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
      found.set(node.name.text, node.getText(ast));
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)) {
      found.set(node.name.text, `const ${node.name.text} = ${node.initializer.getText(ast)};`);
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'conversationUiState') {
      if (projection) throw new Error('Ambiguous hosted mobile state projection');
      projection = `const conversationUiState = ${node.initializer.getText(ast)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of names) if (!found.has(name)) throw new Error(`Missing production function: ${name}`);
  if (!projection) throw new Error('Missing production hosted mobile state projection');
  const extracted = [...found.values(), projection].join('\n');
  return {
    extracted,
    compiled: ts.transpileModule(`${extracted}\nglobalThis.lifecycle = { resumeFlowForTarget, stopFlowForTarget, conversationUiState };`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
  };
}

function createHarness(parts, reason = 'interrupted') {
  const targetA = { workspaceId: 'ws-a', conversationId: 'flow-a' };
  const targetB = { workspaceId: 'ws-b', conversationId: 'flow-b' };
  const key = target => `${target.workspaceId}::${target.conversationId}`;
  const states = new Map();
  const stored = new Map();
  const owners = new Map();
  const calls = [];
  const poolStops = [];
  const modeChanges = [];
  let relays = 0;
  class FlowQuestionPendingError extends Error {
    constructor(componentId) { super('question'); this.componentId = componentId; this.completedResults = []; }
  }
  const pool = {
    snapshot: async () => ({ runtime: null, queueItems: [] }),
    setMode: async (target, mode) => { modeChanges.push({ target: key(target), mode }); },
    requestStop: async target => { poolStops.push(key(target)); return { ok: true }; },
  };
  const agent = {
    activeConversationId: targetA.conversationId,
    pendingOptions: [],
    getStoredFlowSuspension: id => stored.get(id) || null,
    clearStoredFlowSuspension: id => stored.delete(id),
    saveStoredFlowSuspension: (record, id) => stored.set(id, structuredClone(record)),
  };
  function owner(target) {
    if (owners.has(key(target))) return owners.get(key(target));
    const value = {
      workspace: { current: { id: target.workspaceId } }, activeConversationId: target.conversationId,
      mode: 'flow', status: 'idle', flow: null, flowPc: 2, pendingOptions: [], chatMessages: [], fileDiffs: [],
      subagents: { listAll: () => [], toRecord: () => null },
      setMode(mode) { this.mode = mode; },
      saveStoredFlowSuspension: (record, id) => agent.saveStoredFlowSuspension(record, id),
      clearStoredFlowSuspension: id => agent.clearStoredFlowSuspension(id),
      interruptRunningConversationWorkRuns() {},
      getConversationSnapshot: () => ({ workRuns: [] }), listConversationStates: () => [],
      getConversationPlan: () => null, getLinkedPlan: () => null,
      abortActiveKernelRun() {
        const current = calls.findLast(call => call.target === key(target) && !call.settled);
        if (current) { current.workerCancelled = true; current.fail(new Error('Agent run aborted')); }
      },
    };
    owners.set(key(target), value);
    return value;
  }
  function seed(target, suspendReason) {
    const state = {
      workflow: { name: `Workflow ${target.conversationId}` }, input: 'original flow input', componentId: 2,
      completedResults: [{ componentId: 1, result: 'prior result' }], previousMode: 'plan', previousFlow: null,
      previousPc: 0, reason: suspendReason, message: 'old suspension message', target,
      abortController: null, name: `Workflow ${target.conversationId}`, flowAgent: owner(target),
    };
    states.set(key(target), state);
    stored.set(target.conversationId, { target, reason: suspendReason, workflowName: state.name });
    return state;
  }
  const stateA = seed(targetA, reason);
  const stateB = seed(targetB, 'question');
  const context = {
    AbortController, Error, Date, console, activeFlowsByRuntimeKey: states, agent, conversationKernel: null,
    normalizeConversationTarget: target => ({ ...target, runtimeKey: key(target) }),
    conversationRuntimeTarget: target => target,
    isolatedConversationAgent: owner,
    root: 'isolated-lifecycle-fixture', mainConversationOwners: new Set([key(targetA), key(targetB)]), conversationSelections: new Map(), pendingFlowStarts: new Map(),
    publishConversationState: async () => {},
    ensureConversationKernel: () => ({ beginExternalRun: (target, options, factory) => factory(), settleExternalRun() {}, snapshot: target => pool.snapshot(target) }),
    wslBackendEnabled: () => false,
    ensureWslConversationPool: () => pool, ensureElectronUtilityPool: () => pool,
    FlowQuestionPendingError,
    relayFlowAgentWorkEvents: () => { relays++; return () => { relays--; }; },
    runFlow: (flowAgent, workflow, options) => new Promise((resolve, reject) => {
      const call = { target: `${flowAgent.workspace.current.id}::${flowAgent.activeConversationId}`,
        resumePrompt: options.resumePrompt, startPc: options.startPc, signal: options.signal,
        completedResults: structuredClone(options.completedResults), settled: false, workerCancelled: false };
      const finish = (error) => {
        if (call.settled) return;
        call.settled = true;
        options.signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };
      const onAbort = () => finish(Object.assign(new Error('Flow interrupted by user'), {
        componentId: 2, completedResults: options.completedResults,
      }));
      call.release = () => finish();
      call.fail = error => finish(error);
      calls.push(call);
      options.signal.addEventListener('abort', onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }),
  };
  vm.createContext(context);
  vm.runInContext(parts.compiled, context, { filename: 'production-flow-lifecycle.js' });
  return { ...context.lifecycle, targetA, targetB, stateA, stateB, states, stored, calls, poolStops,
    modeChanges, key, FlowQuestionPendingError, relays: () => relays };
}

async function run(options = {}) {
  const sourcePath = path.resolve(options.sourcePath || path.join(__dirname, '..', 'src', 'main.ts'));
  const source = fs.readFileSync(sourcePath, 'utf8');
  const parts = sourceParts(source);
  const receipt = { passed: false, sourcePath, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    extractedSha256: crypto.createHash('sha256').update(parts.extracted).digest('hex'),
    boundary: 'Production main.ts AST functions and hosted state projection, controlled held runFlow/Agent/pool; no real provider or GUI.',
    checks: [], cases: [] };
  function check(name, condition, detail) {
    receipt.checks.push({ name, passed: !!condition, ...(condition ? {} : { detail }) });
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  }
  for (const reason of ['interrupted', 'question']) {
    const h = createHarness(parts, reason);
    const otherBefore = JSON.stringify(await h.conversationUiState(h.targetB));
    const resumed = h.resumeFlowForTarget('explicit question reply', h.targetA);
    const firstCall = h.calls[0];
    const during = await h.conversationUiState(h.targetA);
    check(`${reason}: held resumed request is projected running and not paused`, during.flow?.running && !during.flow.paused, during.flow);
    check(`${reason}: running lifecycle reason is cleared`, h.stateA.reason === '', h.stateA.reason);
    check(`${reason}: original resume prompt semantics and component results survive`, firstCall.resumePrompt === (reason === 'interrupted' ? '' : 'explicit question reply') && firstCall.startPc === 2 && firstCall.completedResults[0].result === 'prior result', firstCall.resumePrompt);
    check(`${reason}: stored pause clears before the held component starts`, !h.stored.has(h.targetA.conversationId));
    const duplicate = await h.resumeFlowForTarget('duplicate', h.targetA);
    check(`${reason}: repeated resume is idempotent while the component is held`, duplicate.alreadyRunning === true && h.calls.length === 1, duplicate);
    const paused = await h.stopFlowForTarget(h.targetA);
    check(`${reason}: first stop after resume cooperatively pauses`, paused.action === 'stopping', paused);
    check(`${reason}: stop aborts the exact held Flow signal`, firstCall.signal.aborted, { signalAborted: firstCall.signal.aborted, workerCancelled: firstCall.workerCancelled });
    // A failing implementation may wrongly discard before reaching the worker.
    // Release the controlled boundary only to terminate that failed fixture.
    if (!firstCall.settled) firstCall.fail(new Error('fixture cleanup after missing cancellation'));
    const result = await resumed;
    const afterPause = await h.conversationUiState(h.targetA);
    check(`${reason}: resumed stop retains the owning resumable suspension`, h.states.get(h.key(h.targetA)) === h.stateA && h.stateA.reason === 'interrupted' && h.stateA.abortController === null, { present: h.states.has(h.key(h.targetA)), reason: h.stateA.reason });
    check(`${reason}: pause result and mobile snapshot agree`, result.pending === true && result.interrupted === true && afterPause.flow?.paused === true, { result, flow: afterPause.flow });
    check(`${reason}: pause does not stop an unrelated runtime pool`, h.poolStops.length === 0, h.poolStops);
    check(`${reason}: another workspace and conversation are unchanged`, JSON.stringify(await h.conversationUiState(h.targetB)) === otherBefore && h.states.get(h.key(h.targetB)) === h.stateB);
    check(`${reason}: paused component releases its event relay`, h.relays() === 0, h.relays());
    const forced = await h.stopFlowForTarget(h.targetA);
    check(`${reason}: next stop while actually paused discards only that suspension`, forced.action === 'force_stopped_pending' && !h.states.has(h.key(h.targetA)) && !h.stored.has(h.targetA.conversationId), forced);
    check(`${reason}: forced stop preserves the other conversation`, h.states.get(h.key(h.targetB)) === h.stateB && h.poolStops.every(key => key === h.key(h.targetA)));
    receipt.cases.push({ reason, during: during.flow, stop: paused, result: { pending: result.pending, interrupted: result.interrupted }, afterPause: afterPause.flow, forced });
  }
  for (const outcome of ['completed', 'provider-error', 'question', 'archived']) {
    const h = createHarness(parts);
    const work = h.resumeFlowForTarget('', h.targetA);
    const call = h.calls[0];
    if (outcome === 'completed') call.release();
    else if (outcome === 'question') {
      const question = new h.FlowQuestionPendingError(3);
      question.completedResults = [{ componentId: 2, result: 'second result' }];
      h.stateA.flowAgent.pendingOptions = [{ question: 'Choose', options: [{ label: 'A' }] }];
      call.fail(question);
    } else if (outcome === 'archived') {
      h.stateA.archiveRequested = true;
      call.fail(new Error('archived'));
    } else call.fail(Object.assign(new Error('controlled provider failure'), { componentId: 2 }));
    const result = await work;
    const view = await h.conversationUiState(h.targetA);
    const terminal = outcome === 'completed' || outcome === 'archived';
    check(`${outcome}: lifecycle settles to its actual terminal/pause state`, terminal ? !h.states.has(h.key(h.targetA)) && view.flow === null : h.states.get(h.key(h.targetA)) === h.stateA && view.flow?.paused === (outcome !== 'question' || !source.includes('const submitConversationCommand')), view.flow);
    check(`${outcome}: response preserves success/error/question meaning`, outcome === 'completed' ? result.ok === true && !result.pending : outcome === 'archived' ? result.archived === true && result.ok === false : outcome === 'question' ? result.pending === true && !result.interrupted && h.stateA.reason === 'question' && h.stateA.componentId === 3 : result.interrupted === true && result.error === 'controlled provider failure', result);
    check(`${outcome}: event relays close and other conversation survives`, h.relays() === 0 && h.states.get(h.key(h.targetB)) === h.stateB);
    check(`${outcome}: finished owner restores prior mode; paused owner remains Flow`, h.stateA.flowAgent.mode === (terminal ? 'plan' : 'flow'), h.stateA.flowAgent.mode);
  }
  receipt.passed = receipt.checks.every(check => check.passed);
  receipt.checksPassed = receipt.checks.filter(check => check.passed).length;
  receipt.checksFailed = receipt.checks.length - receipt.checksPassed;
  if (options.reportPath) {
    const filename = path.resolve(options.reportPath);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(receipt, null, 2) + '\n');
  }
  console.log(JSON.stringify({ passed: receipt.passed, checksPassed: receipt.checksPassed, checksFailed: receipt.checksFailed, sourceSha256: receipt.sourceSha256 }));
  if (!receipt.passed) throw new Error(`Flow resume lifecycle: ${receipt.checksFailed} checks failed`);
  return receipt;
}

module.exports = { run };
if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  run({ sourcePath: arg('--source'), reportPath: arg('--report') }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
