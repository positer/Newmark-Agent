'use strict';
// Actual main Flow startup/stop commands and actual utility pool disposal guard.
// Only the utility child is controlled; no production runtime or provider is used.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),ts=require('typescript');
const {loadProduction}=require('./test-queue-continuation-identity.cjs');
const {normalizeConversationTarget}=require('../dist/core/conversationTarget');
const {ElectronUtilityRuntimePool}=loadProduction('core/electronUtilityRuntimePool.ts').exports;
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
async function run(options={}) {
 const source=fs.readFileSync(options.sourcePath||path.join(__dirname,'../src/main.ts'),'utf8'),ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
 const names=['runFlowForTarget','stopFlowForTarget','runtimeSnapshotForTarget','publishConversationState','mutateConversationQueue'];
 const declarations=new Map();
 (function visit(node){if(ts.isVariableDeclaration(node)&&names.includes(node.name.getText(ast)))declarations.set(node.name.getText(ast),'const '+node.name.getText(ast)+'='+node.initializer.getText(ast)+';');ts.forEachChild(node,visit);})(ast);
 for(const name of names)if(!declarations.has(name))throw Error('Missing production function '+name);
 const code=ts.transpileModule([...declarations.values()].join('\n')+'\nglobalThis.commands={'+names.join(',')+'};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const report={sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),boundary:'Actual source main commands + actual utility pool, controlled asynchronous child stop; no GUI claim.',checks:[]};
 const check=(name,passed,detail)=>{report.checks.push({name,passed:!!passed,...(!passed?{detail}:{})});console.log((passed?'PASS ':'FAIL ')+name);};
 for(const operation of ['stop','resume','toggle']) {
  const target=normalizeConversationTarget({workspaceId:'flow-cancel',conversationId:operation}),other=normalizeConversationTarget({workspaceId:'flow-cancel',conversationId:'other-'+operation});
  const states=new Map(),events=[];let releaseStop,enteredStop=false,disposalFinished=false,flowStarted=0,mutationAfterStop=0;
  const stateFor=t=>{if(!states.has(t.runtimeKey))states.set(t.runtimeKey,{mode:'build',model:'fixture',inputMode:'next',runtime:{running:false},queuePaused:true,queued:{followUp:['kept'],steer:[]},queueItems:[{id:'kept-'+t.conversationId,text:'kept',requestedMode:'plan',createdAt:'2026-09-06T00:00:00Z'}],chatMessages:[]});return states.get(t.runtimeKey);};
  const pool=new ElectronUtilityRuntimePool('isolated-flow-cancel','no-child-script',t=>{
   let connected=true;const state=stateFor(t);
   return {subscribe:()=>()=>{},setHostToolHandler(){},status:()=>({enabled:true,connected,pid:0,error:'',runtimeKey:t.runtimeKey}),snapshot:async()=>structuredClone(state),queueAction:async(action,input)=>{if(enteredStop)mutationAfterStop++;if(action==='set_pause')state.queuePaused=input.paused;if(action==='toggle_pause')state.queuePaused=!state.queuePaused;return structuredClone(state);},stop:async()=>{if(t.runtimeKey===target.runtimeKey&&!enteredStop){enteredStop=true;await new Promise(resolve=>{releaseStop=resolve;});disposalFinished=true;}connected=false;}};
  },{idleTtlMs:0});
  const context={console,setTimeout,clearTimeout,Date,Promise,AbortController,Error,path,randomUUID:crypto.randomUUID,root:'isolated-flow-cancel',agent:{rootPath:'isolated-flow-cancel',activeConversationId:target.conversationId},pendingFlowStarts:new Map(),mainConversationOwners:new Set(),activeFlowsByRuntimeKey:new Map(),conversationSelections:new Map(),activeFlowStateKey:t=>normalizeConversationTarget(t).runtimeKey,activeFlowStateFor:()=>null,conversationRuntimeTarget:t=>normalizeConversationTarget(t),wslBackendEnabled:()=>false,ensureElectronUtilityPool:()=>pool,ensureWslConversationPool:()=>pool,stopTargetRuntime:t=>pool.stopTarget(t),ensureConversationKernel:()=>({beginExternalRun(){flowStarted++;throw Error('Cancelled Flow started');}}),FlowEngine:{findWorkflow:()=> 'fixture',load:()=>({name:'fixture',components:[{id:0}]})},broadcastAgentWorkEvent:event=>events.push(event),discardFlowSuspensionForTarget:async()=>{throw Error('No suspension should exist');}};
  vm.createContext(context);vm.runInContext(code,context);
  const c=context.commands;
  await pool.snapshot(other);
  const oldOther=JSON.stringify(await pool.snapshot(other));
  const startup=c.runFlowForTarget('fixture','cancel me',0,target).then(value=>({value}),error=>({error:String(error.message)}));
  for(let i=0;i<100&&!enteredStop;i++)await immediate();
  if(!enteredStop)throw Error('Did not enter actual pool stop boundary');
  let settled=false;
  const action=(operation==='stop'?c.stopFlowForTarget(target):c.mutateConversationQueue(target,operation==='resume'?'queue_set_pause':'queue_toggle_pause',{paused:false})).then(value=>{settled=true;return {value};},error=>{settled=true;return {error:String(error.message)};});
  await immediate();await immediate();
  check(operation+': cancellation is latched during owner disposal',context.pendingFlowStarts.get(target.runtimeKey)?.cancelled===true,{pending:[...context.pendingFlowStarts.keys()],settled});
  check(operation+': state publication/queue mutation waits for owner disposal',!settled&&events.length===0&&mutationAfterStop===0,{settled,events:events.length,mutationAfterStop});
  releaseStop();
  const [started,stopped]=await Promise.all([startup,action]);
  check(operation+': command returns without an is-stopping error',!stopped.error,{started,stopped});
  check(operation+': cancelled Flow never creates a second owner',disposalFinished&&flowStarted===0&&started.value?.interrupted===true&&!context.pendingFlowStarts.has(target.runtimeKey),{started,flowStarted});
  const after=await pool.snapshot(target);
  check(operation+': queued identity, mode and timestamp survive cancellation',after.queueItems[0]?.id==='kept-'+operation&&after.queueItems[0]?.requestedMode==='plan'&&after.queueItems[0]?.createdAt==='2026-09-06T00:00:00Z',after);
  check(operation+': only an explicit queue continue unpauses',after.queuePaused===(operation==='stop'),after.queuePaused);
  check(operation+': another conversation is unchanged',JSON.stringify(await pool.snapshot(other))===oldOther);
  await pool.stopAll();
 }
 report.passed=report.checks.every(row=>row.passed);report.checksPassed=report.checks.filter(row=>row.passed).length;report.checksFailed=report.checks.length-report.checksPassed;
 if(options.reportPath)fs.writeFileSync(options.reportPath,JSON.stringify(report,null,2));
 if(!report.passed)throw Error('Flow startup cancellation regression failed');
 return report;
}
module.exports={run};
if(require.main===module){const args=process.argv.slice(2),get=name=>args[args.indexOf(name)+1];run({sourcePath:args.includes('--source')?get('--source'):undefined,reportPath:args.includes('--report')?get('--report'):undefined}).then(r=>console.log(JSON.stringify({passed:r.passed,checksPassed:r.checksPassed}))).catch(error=>{console.error(error.stack);process.exitCode=1;});}
