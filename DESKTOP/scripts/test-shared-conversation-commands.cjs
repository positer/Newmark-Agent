'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const { loadProduction } = require('./test-queue-continuation-identity.cjs');

async function run(options = {}) {
  const source = fs.readFileSync(options.sourcePath || path.join(__dirname, '../src/main.ts'), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['activeFlowStateKey', 'activeFlowStateFor', 'persistedFlowSuspensionRecord', 'flowSuspensionForTarget', 'flowRunningForTarget',
    'flowAgentTarget', 'setTargetFlowMode', 'discardFlowSuspensionForTarget', 'runtimeSnapshotForTarget', 'selectConversationMode',
    'selectConversationInputMode', 'publishConversationState', 'publishConversationList', 'enqueueConversationGuide', 'mutateConversationQueue', 'applyConversationAction',
    'submitConversationCommand', 'executeConversationCommand', 'runFlowForTarget', 'resumeFlowForTarget', 'stopFlowForTarget', 'interruptActiveFlowForArchive', 'archiveConversation',
    'peekTargetRuntime', 'activateConversation', 'setBranchCommunication', 'branchConversation', 'inspectBranch', 'activateBranch', 'loadEarlier'];
  const ipcNames = { 'agent:archive':'archiveConversation', 'agent:activateConversation':'activateConversation', 'agent:setConversationBranchCommunication':'setBranchCommunication', 'agent:branchConversation':'branchConversation', 'agent:inspectConversationBranch':'inspectBranch', 'agent:activateConversationBranch':'activateBranch', 'conversation:loadEarlier':'loadEarlier' };
  const found = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(ast));
    if (ts.isVariableDeclaration(node) && [...names,'conversationAgentForTarget','branchConversationForTarget','inspectConversationBranchForTarget','activateConversationBranchForTarget','archiveConversationForTarget'].includes(node.name.getText(ast))) found.set(node.name.getText(ast), `const ${node.name.getText(ast)} = ${node.initializer.getText(ast)};`);
    if (ts.isCallExpression(node) && /(?:^|\.)ipcMain\.handle$/.test(node.expression.getText(ast)) && ipcNames[node.arguments[0]?.text]) { const name=ipcNames[node.arguments[0].text]; found.set(name,`const ${name} = ${node.arguments[1].getText(ast)};`); }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of names) if (!found.has(name)) throw Error(`Missing production command: ${name}`);
  const extracted = [...found.values()].join('\n');
  const script = ts.transpileModule(`${extracted}\nglobalThis.commands = { ${names.join(',')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const { Agent } = loadProduction('core/agent.ts').exports;
  const loadedKernel = loadProduction('core/conversationKernel.ts');
  const { ConversationKernel } = loadedKernel.exports;
  const { ConversationCommandStateStore } = loadProduction('core/conversationCommandState.ts').exports;
  const { conversationListEvent } = loadProduction('core/conversationListEvent.ts').exports;
  const { normalizeConversationTarget } = require('../dist/core/conversationTarget');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-shared-commands-'));
  const host = new Agent(root, { agentOnly: true });
  const rows = [], events = [], flowCalls = [], holds = new Map();
  const owners = [];
  const target = id => normalizeConversationTarget({ workspaceId: 'shared-fixture', conversationId: id,
    workspace: { id: 'shared-fixture', name: 'fixture', path: path.join(root, 'workspace'), isInternal: false, kind: 'local' } });
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const a = target('a'), b = target('b');
  class Probe extends Agent {
    claimGoalContinuationMessage() { return null; }
    queueActiveKernelMessage() { return this.acceptGuide === true; }
    async process(message) {
      const text = typeof message === 'string' ? message : message.text;
      rows.push({ target: this.activeConversationId, mode: this.mode, message: structuredClone(message), owner: owners.indexOf(this) });
      this.notifyAgentKernelUserMessageStart(text, typeof message === 'string' ? undefined : message.clientMessageId);
      if (text.startsWith('hold ')) return await new Promise(resolve => holds.set(text, () => resolve([{ type: 'text', text: 'held completed' }])));
      return [{ type: 'text', text: 'fixture completed' }];
    }
  }
  function createOwner(t) {
    const owner = new Probe(root, { agentOnly: true });
    owner.workspace.current = { ...t.workspace, icon: '', hostBinding: '' };
    owner.config.loadWorkspaceConfig(t.workspace.path);
    owner.setConversation(t.conversationId);
    owners.push(owner);
    return owner;
  }
  const poolKernel = new ConversationKernel(root, host, null, { createRunner: createOwner });
  const flowKernel = new ConversationKernel(root, host, null, { createRunner: createOwner });
  poolKernel.subscribe(event => events.push(structuredClone(event)));
  flowKernel.subscribe(event => events.push(structuredClone(event)));
  const pool = {
    peek: t => ({ resident: !!poolKernel.runtimeState(t), running: poolKernel.isRunning(t), stopping: false, connected: !!poolKernel.runtimeState(t) }),
    snapshot: async t => poolKernel.snapshot(t),
    prompt: async p => poolKernel.prompt(p.message, p.target, p.options, p.queueMode),
    setMode: async (t,m) => poolKernel.setMode(t,m), setInputMode: async (t,m) => poolKernel.setInputMode(t,m),
    queueAction: async (t,action,input) => poolKernel.queueAction(t,action,input),
    enqueueGuide: async e => poolKernel.enqueueGuide(e), requestStop: async t => poolKernel.requestStop(t),
  };
  class FlowQuestionPendingError extends Error {}
  const context = {
    console, process, setTimeout, clearTimeout, setImmediate, AbortController, Error, Date, Promise, randomUUID: crypto.randomUUID, path,
    root, agent: host, conversationListEvent, conversationKernel: flowKernel, activeFlowsByRuntimeKey: new Map(),
    conversationSelections: new ConversationCommandStateStore(root), conversationCommands: new Map(), mainConversationOwners: new Set(), pendingFlowStarts: new Map(),
    activePromptLeases: new Map(), activePromptWorkspaces: new Map(), archiveInFlight: new Map(), mutatingRuntimeKeys: new Set(),
    forceStopTargetRuntime: async () => {},
    normalizeConversationTarget, conversationRuntimeTarget: input => target(typeof input === 'string' ? input : input?.conversationId || input?.target?.conversationId || 'a'),
    isolatedConversationAgent: createOwner, ensureConversationKernel: () => flowKernel, electronUtilityRuntimePool: pool,
    localConversationSnapshotForStartup: t => poolKernel.snapshot(t),
    ensureElectronUtilityPool: () => pool, ensureWslConversationPool: () => pool, wslBackendEnabled: () => false,
    assertTargetNotMutating() {}, stopTargetRuntime: async t => { poolKernel.flushPersistence(); },
    mutateTargetConversation: async (t,fn) => fn(), broadcastAgentWorkEvent: event => events.push(structuredClone(event)),
    FlowQuestionPendingError, isUserFlowAbort: () => false,
    FlowEngine: { findWorkflow: name => name === 'test-flow' ? name : null, load: () => ({ name: 'test-flow', components: [{ id: 0 }] }) },
    runFlow: (owner, workflow, opts) => new Promise((resolve,reject) => {
      const call = { owner, target: owner.activeConversationId, opts, done: false };
      const complete = err => { if (call.done) return; call.done = true; opts.signal.removeEventListener('abort', abort); err ? reject(err) : resolve(); };
      const abort = () => complete(Object.assign(new Error('Flow interrupted by user'), { componentId: 0, completedResults: [] }));
      call.complete = () => complete(); flowCalls.push(call);
      owner.acceptGuide = true;
      owner.emitWorkEvent({ type: 'start', content: 'controlled Flow component', runId: crypto.randomUUID() });
      opts.signal.addEventListener('abort', abort, { once: true });
      if (opts.signal.aborted) abort();
    }),
  };
  // A preserved built main.js can reproduce an earlier main-process defect
  // against this same controlled execution boundary without writing dist.
  context.crypto_1=crypto; context.conversationTarget_1={normalizeConversationTarget};
  context.flow_1={FlowEngine:context.FlowEngine};
  context.flow_runner_1={runFlow:context.runFlow,FlowQuestionPendingError};
  vm.createContext(context); vm.runInContext(script, context);
  const c = context.commands;
  const report = { passed: false, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), kernelSha256: loadedKernel.sha256,
    boundary: 'Actual main.ts command/Flow functions plus real source Agent/Kernel, controlled pool transport and process/Flow execution; no Electron/HTTP/emulator claim.', checks: [], captures: [] };
  const check = (name, pass, detail) => { report.checks.push({ name, passed: !!pass, ...(!pass ? { detail } : {}) }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); };
  const until = async fn => { for(let i=0;i<200 && !fn();i++) await new Promise(r=>setTimeout(r,5)); if(!fn()) throw Error('Fixture barrier was not reached'); };
  try {
    await c.applyConversationAction(a,'mode','goal');
    check('Goal selection creates no placeholder goal', !poolKernel.snapshot(a).goal);
    await c.applyConversationAction(a,'mode','chat');
    await c.applyConversationAction(a,'input_mode','next');
    const selected = await c.runtimeSnapshotForTarget(a);
    check('One target snapshot exposes both selected mode and input mode', selected.mode==='chat' && selected.inputMode==='next', selected);
    check('Selection does not cross into another conversation', (await c.runtimeSnapshotForTarget(b)).mode==='build');
    for(const mode of ['build','chat','plan']) {
      const result = await c.submitConversationCommand(`ordinary ${mode}`, a, { requestedMode: mode, inputMode:'next',clientMessageId:`ordinary-${mode}` });
      check(`Canonical idle ${mode} executes requested mode`, !result.error && rows.at(-1).mode===mode, { result, row:rows.at(-1) });
    }
    const held = c.submitConversationCommand('hold ordinary', a, { requestedMode:'build', inputMode:'next',clientMessageId:'held' });
    await until(()=>holds.has('hold ordinary'));
    const replay = c.submitConversationCommand('hold ordinary', a, { requestedMode:'build', inputMode:'next',clientMessageId:'held' });
    await new Promise(r=>setImmediate(r));
    check('Same command id cannot duplicate a held provider execution', rows.filter(r=>r.message.text==='hold ordinary').length===1 && poolKernel.queueItems(a).length===0);
    for(const [id,mode] of [['first','plan'],['second','chat']]) await c.submitConversationCommand('same',a,{requestedMode:mode,inputMode:'next',clientMessageId:id});
    check('Active canonical Next returns immediately with two stable same-text ids', JSON.stringify(poolKernel.queueItems(a).map(r=>r.id))===JSON.stringify(['first','second']));
    await c.applyConversationAction(a,'queue_update','',{id:'second',text:'edited',requestedMode:'chat'});
    await c.applyConversationAction(a,'queue_reorder','',{orderedIds:['second','first']});
    await c.applyConversationAction(a,'queue_set_pause','',{paused:true});
    holds.get('hold ordinary')(); await held; await replay;
    check('Shared paused queue survives active work settlement', poolKernel.queueItems(a).length===2 && poolKernel.snapshot(a).queuePaused);
    await c.applyConversationAction(a,'queue_set_pause','',{paused:false});
    await new Promise(r=>setImmediate(r)); await poolKernel.waitForIdle(a);
    check('Reordered items drain once with their own modes', JSON.stringify(rows.slice(-2).map(r=>[r.mode,typeof r.message==='string'?r.message:r.message.text.replace(/^\[Next queued while current turn is running\]\n/, '')]))===JSON.stringify([['chat','edited'],['plan','same']]),rows.slice(-2));
    const flow = c.submitConversationCommand('flow input',a,{requestedMode:'flow',inputMode:'next',flowName:'test-flow'});
    await until(()=>flowCalls.length===1);
    const flowOwner=flowCalls[0].owner;
    await c.submitConversationCommand('same',a,{requestedMode:'build',inputMode:'next',clientMessageId:'flow-first'});
    const flowNext=await c.submitConversationCommand('same',a,{requestedMode:'chat',inputMode:'next',clientMessageId:'flow-second'});
    check('Flow Next has shared real kernel queue without a second active writer', flowNext.queueItems?.length===2 && context.mainConversationOwners.has(a.runtimeKey) && !poolKernel.isRunning(a),flowNext);
    const afterCount=owners.length;
    await c.applyConversationAction(a,'queue_delete','',{id:'flow-second'});
    check('Flow same-text deletion is exact-id and uses existing owner', JSON.stringify(flowKernel.queueItems(a).map(r=>r.id))===JSON.stringify(['flow-first']) && owners.length===afterCount);
    const guide=await c.submitConversationCommand('guide current flow',a,{requestedMode:'build',inputMode:'guide',clientMessageId:'guide-flow'});
    check('Flow Guide is sent to the same active owner', guide.receipt?.status==='accepted' && flowCalls[0].owner===flowOwner,guide);
    const paused=await c.stopFlowForTarget(a); await flow;
    check('First stop suspends Flow while preserving the entire queue', paused.action==='stopping' && flowKernel.queueItems(a).length===1 && (await c.runtimeSnapshotForTarget(a)).flow?.paused===true);
    const savedFlow=host.getStoredFlowSuspension(a.conversationId,a.workspace);
    const otherWorkspace={...a.workspace,id:'other-workspace',path:path.join(root,'other-workspace')};
    check('Flow suspension writes its exact workspace and original queue lease policy', savedFlow?.target?.workspaceId===a.workspaceId && savedFlow.queueWasPaused===false && host.getStoredFlowSuspension(a.conversationId,otherWorkspace)===null,savedFlow);
    context.activeFlowsByRuntimeKey.delete(a.runtimeKey);
    const lazy=c.activeFlowStateFor(a);
    check('A background target lazily restores its paused Flow without loading another Agent', lazy?.reason==='interrupted' && lazy.queueWasPaused===false && lazy.flowAgent===null && lazy.input==='flow input',lazy);
    await c.selectConversationMode(a,'chat');
    const recoveredState = new ConversationCommandStateStore(root).get(a.runtimeKey);
    check('Flow-time mode and queue pause survive a new state-store instance', recoveredState.mode==='chat' && recoveredState.queuePaused===true && flowOwner.mode==='flow', recoveredState);
    const restoredKernel = new ConversationKernel(root,host,null,{createRunner:createOwner});
    const restored = restoredKernel.snapshot(a);
    check('Cold kernel restores stable queue id/mode/timestamp and keeps it paused', restored.queueItems[0]?.id==='flow-first' && restored.queueItems[0]?.requestedMode==='build' && !!restored.queueItems[0]?.createdAt && restored.queuePaused, restored.queueItems);
    const resumed=c.resumeFlowForTarget('',a); await until(()=>flowCalls.length===2);
    check('Resume keeps the exact Agent object and projects running', flowCalls[1].owner===flowOwner && (await c.runtimeSnapshotForTarget(a)).flow?.paused===false);
    const pausedAgain=await c.stopFlowForTarget(a); await resumed;
    check('Second run can pause again without discarding queue or suspension', pausedAgain.action==='stopping' && flowKernel.queueItems(a).length===1 && context.activeFlowsByRuntimeKey.has(a.runtimeKey));
    const expectedExitMode=context.activeFlowsByRuntimeKey.get(a.runtimeKey).previousMode==='flow'?'build':context.activeFlowsByRuntimeKey.get(a.runtimeKey).previousMode;
    await c.selectConversationMode(a,'flow');
    await c.applyConversationAction(a,'queue_set_pause','',{paused:false});
    await new Promise(r=>setImmediate(r)); await flowKernel.waitForIdle(a);
    check('Shared queue resume exits paused Flow and drains exactly once', !context.activeFlowsByRuntimeKey.has(a.runtimeKey) && flowKernel.queueItems(a).length===0 && rows.filter(r=>r.owner===owners.indexOf(flowOwner)).length===1, rows);
    check('Queue resume exits the Flow selector and persists the restored mode', (await c.runtimeSnapshotForTarget(a)).mode===expectedExitMode && new ConversationCommandStateStore(root).get(a.runtimeKey).mode===expectedExitMode);
    const ownersBeforeGoal = owners.length;
    const goalUpdate=await c.applyConversationAction(a,'goal_update','kept objective');
    check('Goal updates after Flow mutate the existing owner and expose selected Goal mode', goalUpdate.goal?.objective==='kept objective' && owners.length===ownersBeforeGoal && (await c.runtimeSnapshotForTarget(a)).mode==='goal');
    await c.applyConversationAction(a,'goal_clear');
    check('Goal clear after Flow preserves history owner and returns selected Build mode', !flowKernel.snapshot(a).goal && owners.length===ownersBeforeGoal && (await c.runtimeSnapshotForTarget(a)).mode==='build');
    check('Flow operations leave other conversation untouched', (await c.runtimeSnapshotForTarget(b)).mode==='build' && !flowKernel.runtimeState(b));
    check('Structured queue events carry ids and pause state from both owners', events.some(e=>e.type==='queue_update' && e.queueItems?.some(i=>i.id==='first')) && events.some(e=>e.type==='queue_update' && e.queueItems?.some(i=>i.id==='flow-first')) && events.some(e=>e.type==='queue_update' && e.queuePaused===true));
    const prior = c.submitConversationCommand('hold before flow',b,{requestedMode:'build',inputMode:'next',clientMessageId:'prior-b'});
    await until(()=>holds.has('hold before flow'));
    const scheduled = c.submitConversationCommand('wait flow input',b,{requestedMode:'flow',inputMode:'next',flowName:'test-flow',clientMessageId:'flow-b'});
    await until(()=>context.pendingFlowStarts.has(b.runtimeKey));
    await c.submitConversationCommand('queued during waiting',b,{requestedMode:'plan',inputMode:'next',clientMessageId:'waiting-b'});
    check('Flow Next waits behind existing Build with one shared paused queue', flowCalls.length===2 && poolKernel.queueItems(b)[0]?.id==='waiting-b' && poolKernel.snapshot(b).queuePaused);
    holds.get('hold before flow')(); await prior;
    await until(()=>flowCalls.length===3);
    check('Flow starts after prior Build and restores queued metadata onto its exact owner', flowKernel.queueItems(b)[0]?.id==='waiting-b' && flowKernel.queueItems(b)[0]?.requestedMode==='plan');
    flowCalls[2].complete(); await scheduled;
    await new Promise(r=>setImmediate(r)); await flowKernel.waitForIdle(b);
    check('Successful waiting Flow restores prior unpaused policy and drains Next once', rows.filter(r=>r.target==='b' && r.message.text.includes('queued during waiting')).length===1 && !flowKernel.snapshot(b).queuePaused,rows.filter(r=>r.target==='b'));
    check('Natural Flow completion restores its non-Flow visible mode', (await c.runtimeSnapshotForTarget(b)).mode!=='flow');
    await c.applyConversationAction(b,'queue_set_pause','',{paused:true});
    const image={dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=',name:'sample.png',type:'image/png'};
    await c.applyConversationAction(b,'queue_enqueue','',{id:'goal-image',text:'objective',requestedMode:'goal',goalObjective:'objective',images:[image],createdAt:'2026-09-06T00:00:00.000Z'});
    await c.applyConversationAction(b,'queue_update','',{id:'goal-image',text:'edited objective',goalObjective:'edited objective',requestedMode:'goal',images:[image]});
    const cold=new ConversationKernel(root,host,null,{createRunner:createOwner}).snapshot(b).queueItems[0];
    check('Cold queue preserves edited Goal, attachment, original timestamp and id', cold?.id==='goal-image' && cold.requestedMode==='goal' && cold.goalObjective==='edited objective' && cold.images?.[0]?.name==='sample.png' && cold.createdAt==='2026-09-06T00:00:00.000Z',cold);
    await c.applyConversationAction(b,'queue_set_pause','',{paused:false});
    await new Promise(r=>setImmediate(r)); await flowKernel.waitForIdle(b);
    check('Goal queue drain activates the saved objective and carries attachment once', rows.at(-1).mode==='goal' && rows.at(-1).message.goalObjective==='edited objective' && rows.at(-1).message.images?.length===1 && flowKernel.queueItems(b).length===0, rows.at(-1));
    const branchTarget=target('branch-owner');
    const branchOwner=flowKernel.beginExternalRun(branchTarget,{mode:'build',model:'fixture',intelligence:'medium',inputMode:'next',engine:'builtin'},()=>createOwner(branchTarget));
    context.mainConversationOwners.add(branchTarget.runtimeKey);
    const runningPeek=c.peekTargetRuntime(branchTarget);
    check('Main-owned Flow is resident and running for conversation activation', runningPeek.resident && runningPeek.running,runningPeek);
    flowKernel.settleExternalRun(branchTarget,true);
    branchOwner.chatMessages.push({role:'user',content:'prefix input',messageId:'prefix-user',timestamp:new Date().toISOString()},{role:'assistant',content:'prefix reply',timestamp:new Date().toISOString()},{role:'user',content:'original branch input',messageId:'branch-user',timestamp:new Date().toISOString()},{role:'assistant',content:'original reply',timestamp:new Date().toISOString()});
    branchOwner.history.push({role:'user',content:'prefix input'},{role:'assistant',content:'prefix reply'},{role:'user',content:'original branch input'},{role:'assistant',content:'original reply'});
    branchOwner.saveWorkspaceConversationState(true);
    const ownerCount=owners.length;
    const activation=await c.activateConversation(null,branchTarget);
    check('Activating a retained owner uses its live snapshot', activation.runtimeDeferred===false && activation.runtime?.runtimeKey===branchTarget.runtimeKey,activation);
    await c.setBranchCommunication(null,branchTarget,true);
    check('Branch communication updates the retained Agent and avoids a second writer', branchOwner.isBranchCommunicationEnabled() && owners.length===ownerCount,{enabled:branchOwner.isBranchCommunicationEnabled(),created:owners.length-ownerCount});
    flowKernel.queueAction(branchTarget,'set_pause',{paused:true});
    flowKernel.queueAction(branchTarget,'enqueue',{id:'old-branch-queue',text:'old branch only',requestedMode:'build'});
    const branched=await c.branchConversation(null,branchTarget,2,'edited branch input',{messageId:'branch-user'});
    const mainBranch=flowKernel.snapshot(branchTarget);
    check('Branch editing updates the retained history and branch identity', !branched.error && mainBranch.activeBranchId===branched.activeBranchId && JSON.stringify(mainBranch.chatMessages)===JSON.stringify(branched.chatMessages) && mainBranch.chatMessages.length===2,{branched,mainBranch});
    check('New branch does not drain another branch queue', flowKernel.queueItems(branchTarget).length===0 && branchOwner.conversationContinuations().length===0);
    const earlier=await c.loadEarlier(null,{...branchTarget,before:99,window:99});
    check('History pagination reads the retained owner without creating a pool runtime', earlier.chatMessages.length===2 && earlier.chatMessages[0]?.content==='prefix input' && !poolKernel.runtimeState(branchTarget),earlier);
    const originalBranch=branched.branches?.find(x=>x.id!==branched.activeBranchId)?.id;
    if(originalBranch){
      const switched=await c.applyConversationAction(branchTarget,'conversation_branch_activate','',{branchId:originalBranch});
      check('Branch activation changes the retained Agent rather than a cold writer', !switched.error && flowKernel.snapshot(branchTarget).activeBranchId===originalBranch,{switched,live:flowKernel.snapshot(branchTarget).activeBranchId});
      check('Returning to a branch restores its own stable queue while paused', flowKernel.snapshot(branchTarget).queuePaused && flowKernel.queueItems(branchTarget)[0]?.id==='old-branch-queue');
      const inspected=await c.applyConversationAction(branchTarget,'conversation_branch_inspect','',{branchId:originalBranch});
      check('Current-branch inspection retains live runtime and queue projection', !inspected.error && inspected.runtime?.runtimeKey===branchTarget.runtimeKey,inspected);
      const ipcInspection=await c.inspectBranch(null,branchTarget,originalBranch);
      check('IPC and hosted history actions expose the same branch and queue owner', ipcInspection.activeBranchId===inspected.activeBranchId && JSON.stringify(ipcInspection.queueItems)===JSON.stringify(inspected.queueItems));
      const secondBranch=await c.applyConversationAction(branchTarget,'conversation_branch_create','',{messageIndex:2,editedText:'second branch via shared action',messageId:'branch-user'});
      check('Shared branch-create action mutates the same retained Agent', !secondBranch.error && flowKernel.snapshot(branchTarget).activeBranchId===secondBranch.activeBranchId && branchOwner.conversationContinuations().length===0,secondBranch);
      await c.activateBranch(null,branchTarget,originalBranch);
    } else check('Branch fixture produced an original branch',false,branched);
    check('All branch operations preserve one retained Agent', owners.length===ownerCount,{before:ownerCount,after:owners.length});
    if(typeof flowKernel.disposeIdle==='function'){
      let blocked=false; try{flowKernel.disposeIdle(branchTarget.workspaceKey);}catch{blocked=true;}
      check('Workspace cleanup refuses retained queued work without detaching its owner',blocked && flowKernel.conversationOwner(branchTarget)===branchOwner);
      flowKernel.queueAction(branchTarget,'delete',{id:'old-branch-queue'});
      const otherRootTarget=normalizeConversationTarget({workspaceId:'isolated-other',conversationId:'other',workspace:{id:'isolated-other',name:'other',path:path.join(root,'other'),isInternal:false,kind:'local'}});
      fs.mkdirSync(otherRootTarget.workspace.path,{recursive:true});
      const otherOwner=flowKernel.beginExternalRun(otherRootTarget,{mode:'build',model:'fixture',intelligence:'medium',inputMode:'next',engine:'builtin'},()=>createOwner(otherRootTarget));
      flowKernel.disposeIdle(branchTarget.workspaceKey);
      check('Idle workspace cleanup detaches subscriptions and preserves another running workspace',!flowKernel.runtimeState(branchTarget) && branchOwner.agentKernelUserMessageStartSubscribers.length===0 && flowKernel.conversationOwner(otherRootTarget)===otherOwner && flowKernel.isRunning(otherRootTarget));
      flowKernel.settleExternalRun(otherRootTarget,true);
    }
    const archivedTarget=target('archive-flow');
    const beforeArchiveRows=rows.length;
    const archivedFlow=c.submitConversationCommand('archive held Flow',archivedTarget,{requestedMode:'flow',inputMode:'next',flowName:'test-flow'});
    await until(()=>flowCalls.length===4);
    await c.submitConversationCommand('must not run after archive',archivedTarget,{requestedMode:'build',inputMode:'next',clientMessageId:'archive-next'});
    const archived=await c.applyConversationAction(archivedTarget,'conversation_archive'); await archivedFlow;
    await new Promise(r=>setTimeout(r,300));
    check('Real Agent archive succeeds while the held Flow is cooperatively stopped', archived.ok===true && flowCalls[3].done,archived);
    check('Shared archive publishes a workspace directory deletion without changing peer selection', events.some(event => event.type==='conversation_list' && event.stateScope==='workspace' && event.workspaceId===archivedTarget.workspaceId && !('activeConversationId' in event) && event.conversations.every(row=>row.id!==archivedTarget.conversationId)));
    check('Archived Flow never drains queued input or recreates a runtime', rows.length===beforeArchiveRows && !flowKernel.runtimeState(archivedTarget) && !context.mainConversationOwners.has(archivedTarget.runtimeKey) && !context.activeFlowsByRuntimeKey.has(archivedTarget.runtimeKey));
    check('Archive clears only the target command state and suspension', !context.conversationSelections.get(archivedTarget.runtimeKey) && context.conversationSelections.get(a.runtimeKey) && !host.getStoredFlowSuspension(archivedTarget.conversationId,archivedTarget.workspace));
    report.captures.push({ rows, final: await c.runtimeSnapshotForTarget(a), flowOwners: flowCalls.map(call=>owners.indexOf(call.owner)) });
  } finally {
    for(const release of holds.values()) release();
    for(const call of flowCalls) call.complete();
    flowKernel.flushPersistence(); poolKernel.flushPersistence();
    report.passed=report.checks.every(x=>x.passed);
    report.checksPassed=report.checks.filter(x=>x.passed).length;
    report.checksFailed=report.checks.length-report.checksPassed;
    if(options.reportPath) fs.writeFileSync(options.reportPath,JSON.stringify(report,null,2)+'\n');
    // Temporary roots hold no user data; retain diagnostic artifacts in report only.
    fs.rmSync(root,{recursive:true,force:true});
  }
  console.log(JSON.stringify({passed:report.passed,checksPassed:report.checksPassed,checksFailed:report.checksFailed}));
  if(!report.passed) throw Error('Shared conversation command regression failed');
  return report;
}
module.exports={run};
if(require.main===module){const args=process.argv.slice(2);run({sourcePath:args.includes('--source')?path.resolve(args[args.indexOf('--source')+1]):undefined,reportPath:args.includes('--report')?path.resolve(args[args.indexOf('--report')+1]):undefined}).catch(e=>{console.error(e.stack||e);process.exitCode=1;});}
