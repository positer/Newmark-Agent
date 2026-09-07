// Read-only production-source audit. Actual renderer functions, controlled IPC settlement.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'DESKTOP/node_modules/typescript'));
const uiPath = path.join(root, 'DESKTOP/src/ui/index.html');
const html = fs.readFileSync(uiPath, 'utf8');
const sources = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m, i) => ts.createSourceFile('ui'+i+'.js',m[1],ts.ScriptTarget.Latest,true,ts.ScriptKind.JS));
function nodeOf(name) {
  for (const source of sources) for (const node of source.statements) {
    if ((ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(source) === name)) return {node,source};
  }
  throw Error('Missing actual source '+name);
}
const sourceOf = name => {const x=nodeOf(name);return x.node.getText(x.source);};
const copy = v=>JSON.parse(JSON.stringify(v));
const defer = ()=>{let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const A={workspaceId:'fixture-workspace',conversationId:'fixture-conversation'};
const key=A.workspaceId+'::'+A.conversationId;
const reports=[];
function harness(){
  const state={conversationRuntimeStates:{},runningConversations:{},workRunsByBranch:{},workRunsByTarget:{},conversationLoadGeneration:1,renderedChatMessages:[],rightTab:'status'};
  const ctx={state,api:{},window:{renderInputStack(){},syncNextQueueFromBackend(){}},els:{},console,Date,JSON,Number,String,Object,Array,
    currentConversationTarget:()=>A, activeConversationId:()=>A.conversationId,runtimeWorkspaceId:()=>A.workspaceId,
    runtimeKeyFor:(w,c)=>w+'::'+c,isActiveConversationTarget:t=>t.workspaceId===A.workspaceId&&t.conversationId===A.conversationId,
    conversationBranchIdsForTarget:()=>({viewed:'branch1',runtime:'branch1'}),
    syncGuideMessagesFromWorkRuns(){},dedupeGuideWorkEvents:events=>events,
    normalizedWorkRun:(run,target)=>({...copy(run),target,events:copy(run.events||[])}),
    runningConversationRecord:()=>state.runningConversations[key]||null,
    updateConversationWorkRunElement(){},updateSubmitButtonState(){},renderConversations(){},setWorking(value){ctx.working=value;},showUiNotice(message){ctx.notice=message;},
    registerRuntimeKey(){},setBackendQueueForTarget:q=>q,
    publicToolNameForUi:n=>n,normalizeWorkDisplayImage:v=>v,
    publicWorkEvent:()=>true,guideWorkEventKey:()=>'',workRunGuideEvents:()=>[],terminalAssistantResponseForRun:()=>null,
    markProvisionalStop(){},pauseQueueForTarget(){},
  };
  vm.createContext(ctx);
  vm.runInContext(['workRunBranchKey','workRunsForBranch','compareConversationWorkEvents','syncWorkRunsSnapshot','setConversationRuntimeState','refreshConversationRuntimeAfterStopRace','window.stopCurrentConversation','requestBackendStopForProvisionalStart','publicWorkEventForUi','presentedWorkRunEvents','conversationWorkRevision','advanceConversationWorkRevision','captureConversationWorkSnapshotRequest','isCurrentConversationWorkSnapshotRequest','conversationRunStillOwnsTarget','expandedWorkEventDeltas','mergeConversationWorkEventSnapshots'].map(sourceOf).join('\n'),ctx);
  ctx.live=(runId,status='running',seq=1)=>{
    const run={runId,status,sequence:seq,events:[{id:runId+'-'+seq,type:status==='running'?'text':'done',content:'live-'+runId,sequence:seq}],target:A};
    ctx.workRunsForBranch(A,'branch1').push(run);
    ctx.setConversationRuntimeState(A,status,runId,{generation:seq,provisional:false});
    return run;
  };
  return ctx;
}
async function check(name,fn){const evidence={};try{await fn(evidence);reports.push({name,ok:true,evidence});}catch(error){reports.push({name,ok:false,error:error.message,evidence});}}
async function main(){
  const completedReadCallback=()=>{
    const {node,source}=nodeOf('window.sendMessage');let callback;
    function visit(n){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='then'&&n.expression.expression.getText(source)==='api.getState(lockedTarget)') callback=n.arguments[0].getText(source);ts.forEachChild(n,visit);}
    visit(node);assert.ok(callback,'actual post-send IPC callback is present');return callback;
  };
  await check('control: older cooperative stop cannot replace terminal state of the SAME run',async e=>{
    const h=harness(),d=defer();h.live('old');h.api.stopConversation=()=>d.promise;
    const pending=h.window.stopCurrentConversation();h.setConversationRuntimeState(A,'completed','old');d.resolve({action:'graceful',status:'interrupted'});await pending;
    e.actual=copy(h.state.conversationRuntimeStates[key]);assert.equal(e.actual.status,'completed');
  });
  await check('late cooperative-stop result cannot erase a newer Build',async e=>{
    const h=harness(),d=defer();h.live('old');h.api.stopConversation=()=>d.promise;
    const pending=h.window.stopCurrentConversation();h.setConversationRuntimeState(A,'completed','old');h.live('new','running',2);
    d.resolve({action:'graceful',status:'interrupted'});await pending;
    e.actual=copy(h.state.conversationRuntimeStates[key]);e.running=copy(h.state.runningConversations);assert.equal(e.actual.runId,'new');assert.equal(e.actual.status,'running');
  });
  await check('late stop rejection cannot resurrect the old Build over a newer one',async e=>{
    const h=harness(),d=defer();h.live('old');h.api.stopConversation=()=>d.promise;
    const pending=h.window.stopCurrentConversation();h.setConversationRuntimeState(A,'completed','old');h.live('new','running',2);
    d.reject(Error('fixture delayed IPC stop rejection'));await pending;
    e.actual=copy(h.state.conversationRuntimeStates[key]);assert.equal(e.actual.runId,'new');
  });
  await check('late stop-race snapshot cannot overwrite a newer Build start',async e=>{
    const h=harness(),d=defer();h.live('old');h.api.getState=()=>d.promise;
    const pending=h.refreshConversationRuntimeAfterStopRace(A,'old',{action:'not_running'});h.live('new','running',2);
    d.resolve({runtime:null,status:'idle',workRuns:[{runId:'old',status:'completed',events:[],sequence:1}]});await pending;
    e.actual=copy(h.state.conversationRuntimeStates[key]);assert.equal(e.actual.runId,'new');assert.equal(e.actual.status,'running');
  });
  await check('stale read is rejected before it can replace a newer streamed run; fresh explicit clearing remains valid',e=>{
    const h=harness();h.live('old','completed',1);h.live('new','running',2);
    const request=h.captureConversationWorkSnapshotRequest(A);h.advanceConversationWorkRevision(A);
    assert.equal(h.isCurrentConversationWorkSnapshotRequest(request),false);
    // Authoritative callers that do not have an older pending read can still clear stale/deleted runs.
    const result=h.syncWorkRunsSnapshot([{runId:'old',status:'completed',events:[],sequence:1}],A);
    e.runIds=result.map(r=>r.runId);assert.deepEqual(e.runIds,['old']);
  });
  await check('same-run late running snapshot cannot reverse a newer terminal event',e=>{
    const h=harness();h.live('old','completed',10);
    const result=h.syncWorkRunsSnapshot([{runId:'old',status:'running',events:[],sequence:5}],A);
    e.run=copy(result[0]);assert.equal(e.run.status,'completed');
  });
  await check('tool events retain invocation identity across public UI projection',e=>{
    const h=harness();const event={id:'event-x',type:'tool_result',toolName:'exec',toolCallId:'call-slow',runId:'run',sequence:4,content:'done'};
    e.projected=copy(h.publicWorkEventForUi(event));assert.equal(e.projected.toolCallId,'call-slow');
  });
  await check('coalesced IPC delta partially overlapping an in-flight snapshot renders text once',e=>{
    const h=harness();const coalescerPath=path.join(root,'DESKTOP/src/core/workEventCoalescer.ts');
    const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(coalescerPath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,setTimeout,clearTimeout});
    const received=[],coalescer=new exports.WorkEventCoalescer(event=>received.push(event),1000);
    const first={id:'token1',type:'text',runId:'stream',content:'A',sequence:1,...A};
    const second={...first,id:'token2',content:'B',sequence:2};
    coalescer.push(first);
    // The authoritative snapshot captures token1 before token2 enters the 16 ms IPC batch.
    const snapshot=[{runId:'stream',status:'running',events:[first],sequence:1}];
    coalescer.push(second);coalescer.flushAll();
    // The actual pool snapshot has raw workEvents; the main IPC has a batched event.
    const merged=h.mergeConversationWorkEventSnapshots(received,snapshot[0].events).sort(h.compareConversationWorkEvents);
    const presented=h.presentedWorkRunEvents({status:'running',events:merged},false);
    e.received=copy(received);e.merged=copy(merged);e.presented=copy(presented);assert.equal(presented.events.map(item=>item.content||'').join(''),'AB');
  });
  await check('parallel same-name tools mark the matching invocation complete',e=>{
    const h=harness();const events=[
      {id:'call-a',type:'tool_call',toolName:'exec',toolCallId:'A',content:'slow',sequence:1},
      {id:'call-b',type:'tool_call',toolName:'exec',toolCallId:'B',content:'fast',sequence:2},
      {id:'result-a',type:'tool_result',toolName:'exec',toolCallId:'A',content:'A done',sequence:3},
    ].map(h.publicWorkEventForUi);
    e.presented=copy(h.presentedWorkRunEvents({status:'running',events},false));
    const items=e.presented.events.flatMap(x=>x.items||[]);e.completedIds=items.filter(x=>x.completed).map(x=>x.id);assert.deepEqual(e.completedIds,['call-a']);
  });
  for(const race of ['new-run','same-run-text','leave-return','fresh'])await check('actual post-send IPC callback protects transcript: '+race,e=>{
    const h=harness();h.live('old','completed',1);const rendered=[];
    Object.assign(h,{lockedTarget:A,lockedConversationId:A.conversationId,completedContextRequest:{},completedWorkRequest:h.captureConversationWorkSnapshotRequest(A),
      isViewingRuntimeConversationBranch:()=>true,applyReturnedGoalState(){},applyContextWindowSnapshot(){},applyAutoRouteRatingState(){},hydrateConversationBranchState(){},
      renderChatMessages:messages=>rendered.push(copy(messages)),syncQueueItemsFromSnapshot(){},normalizeConversationPlan:v=>v});
    h.window.renderRightStatusPanel=()=>{};
    vm.runInContext('completeRead='+completedReadCallback(),h);
    if(race==='new-run')h.live('new','running',2);
    else if(race==='same-run-text')h.advanceConversationWorkRevision(A);
    else if(race==='leave-return')h.state.conversationLoadGeneration+=2;
    h.completeRead({workRuns:[{runId:'old',status:'completed',sequence:1,events:[]}],chatMessages:[{content:'old only'}]});
    e.rendered=rendered;e.runIds=h.workRunsForBranch(A,'branch1').map(x=>x.runId);
    assert.equal(rendered.length,race==='fresh'?1:0);if(race==='new-run')assert.ok(e.runIds.includes('new'));
  });
  await check('provisional stop completion cannot overwrite a newer run or same-run terminal event',async e=>{
    const rows=[];for(const type of ['new-run','completed']){
      const h=harness(),d=defer();h.live('old','stopping');h.api.stopConversation=()=>d.promise;
      h.requestBackendStopForProvisionalStart(A,'old');if(type==='new-run')h.live('new','running',2);else h.setConversationRuntimeState(A,'completed','old');
      d.resolve({action:'graceful'});for(let i=0;i<5;i++)await Promise.resolve();
      rows.push(copy(h.state.conversationRuntimeStates[key]));assert.equal(rows.at(-1).status,type==='new-run'?'running':'completed');
    }e.rows=rows;
  });
  await check('coalesced/raw snapshot merge handles before, middle, after, and legacy batches by exact identity',e=>{
    const h=harness(),a={id:'a',sequence:1,type:'text',runId:'r',content:'repeat ',timestamp:'1'},b={...a,id:'b',sequence:2,content:'repeat ',timestamp:'2'},c={...a,id:'c',sequence:3,content:'end',timestamp:'3'};
    const batch={...c,content:'repeat repeat end',coalescedDeltas:[a,b,c].map(({id,sequence,content,timestamp})=>({id,sequence,content,timestamp}))};
    const rows=[];for(const snapshot of [[],[a],[a,b,c]]){
      const merged=h.mergeConversationWorkEventSnapshots([batch],snapshot).sort(h.compareConversationWorkEvents);rows.push(copy(merged));assert.equal(merged.map(x=>x.content).join(''),'repeat repeat end');assert.equal(merged.length,3);
    }
    const legacy=h.expandedWorkEventDeltas({id:'legacy',type:'text',content:'legacy batch'});assert.equal(legacy.length,1);assert.equal(legacy[0].content,'legacy batch');e.rows=rows;
  });
  for(const race of ['leave-return','fresh'])await check('actual activation callback is load-generation scoped: '+race,async e=>{
    const h=harness(),d=defer(),applied=[];h.state.activeConversation=0;
    Object.assign(h,{currentWorkspaceConversations:()=>[{id:A.conversationId}],currentWorkspaceKey:()=>A.workspaceId,
      loadActiveConversationMessages:()=>{h.state.conversationLoadGeneration++;return Promise.resolve();},
      applyConversationSnapshot:s=>applied.push(copy(s)),currentLang:()=> 'en'});
    h.api.ensureConversation=()=>{};h.api.activateConversation=()=>d.promise;
    vm.runInContext(sourceOf('syncBackendConversation'),h);const pending=h.syncBackendConversation();
    if(race==='leave-return')h.state.conversationLoadGeneration+=2;
    d.resolve({conversationId:A.conversationId,chatMessages:[{content:'activated'}]});await pending;
    e.applied=applied;assert.equal(applied.length,race==='fresh'?1:0);
  });
  await check('actual send completion preserves a previously observed interrupted terminal state',e=>{
    const h=harness();h.live('old','interrupted',10);Object.assign(h,{lockedTarget:A,localRunId:'local',r:{runId:'old'},finalRuntime:h.state.conversationRuntimeStates[key]});
    const {node,source}=nodeOf('window.sendMessage');let finalBranch;
    function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(source)==='finalRunMatches'&&n.thenStatement.getText(source).includes('r.status'))finalBranch=n.thenStatement.getText(source);ts.forEachChild(n,visit);}
    visit(node);assert.ok(finalBranch,'actual completion branch found');vm.runInContext(finalBranch,h);
    e.actual=copy(h.state.conversationRuntimeStates[key]);assert.equal(e.actual.status,'interrupted');
  });
  await check('actual runtime-key alias migration preserves the work snapshot revision',e=>{
    const h=harness();vm.runInContext(['runtimeBaseKey','runtimeKeyFor','registerRuntimeKey'].map(sourceOf).join('\n'),h);
    h.advanceConversationWorkRevision(A);const valid=h.captureConversationWorkSnapshotRequest(A);
    h.registerRuntimeKey(A,'canonical-runtime-key');assert.equal(h.conversationWorkRevision(A),1);assert.equal(h.isCurrentConversationWorkSnapshotRequest(valid),true);
    const old=h.captureConversationWorkSnapshotRequest(A);h.advanceConversationWorkRevision(A);h.registerRuntimeKey(A,'canonical-runtime-key-next');
    e.revisions=copy(h.state.conversationWorkRevisions);assert.equal(h.conversationWorkRevision(A),2);assert.equal(h.isCurrentConversationWorkSnapshotRequest(old),false);
  });
  await check('actual send receipt plus finalizer cannot erase an already observed interruption',e=>{
    const h=harness();h.live('old','interrupted',10);Object.assign(h,{lockedTarget:A,lockedRuntimeKey:key,localRunId:'local',r:{runId:'old',status:'completed'},sendResultOwnsRuntime:true});
    const {node,source}=nodeOf('window.sendMessage');let receipt,finalBranch;
    function visit(n){if(ts.isIfStatement(n)){
      if(n.expression.getText(source)==='sendResultOwnsRuntime && r && r.runId')receipt=n.thenStatement.getText(source);
      if(n.expression.getText(source)==='finalRunMatches'&&n.thenStatement.getText(source).includes('r.status'))finalBranch=n.thenStatement.getText(source);
    }ts.forEachChild(n,visit);}
    visit(node);assert.ok(receipt&&finalBranch);vm.runInContext(receipt,h);h.finalRuntime=h.state.conversationRuntimeStates[key];vm.runInContext(finalBranch,h);
    e.actual=copy(h.state.conversationRuntimeStates[key]);assert.equal(e.actual.status,'interrupted');
  });
  const report={uiPath,uiSha256:crypto.createHash('sha256').update(html).digest('hex').toUpperCase(),boundary:'Production renderer functions in node:vm; IPC settlement ordering is controlled. No real provider, no production mutation, no claim of full GUI acceptance.',passed:reports.filter(r=>r.ok).length,total:reports.length,cases:reports};
  if (process.argv.includes('--report')) fs.writeFileSync(path.resolve(process.argv[process.argv.indexOf('--report')+1]),JSON.stringify(report,null,2));
  for (const item of reports) console.log((item.ok?'PASS ':'FAIL ')+item.name+(item.error?' — '+item.error:''));
  console.log(report.passed+'/'+report.total+' actual renderer continuity cases passed');process.exitCode=reports.some(r=>!r.ok)?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=2;});
