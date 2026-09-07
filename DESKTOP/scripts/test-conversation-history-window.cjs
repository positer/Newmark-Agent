'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), net = require('node:net'), Module = require('node:module'), crypto = require('node:crypto');
const ts = require('typescript');
const { loadProduction } = require('./test-queue-continuation-identity.cjs');

async function run(reportPath, sourceRoot) {
  const receipt = { passed: false, boundary: 'Actual source Agent, Kernel, main snapshot/IPC callbacks and authenticated HTTP server; controlled utility transport, no provider or GUI claim.', checks: [], captures: [], sources: {} };
  const check = (name, passed, detail) => { receipt.checks.push({ name, passed: !!passed, ...(!passed ? { detail } : {}) }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`); };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-history-window-'));
  const sourceFor = f => { const s=fs.readFileSync(path.join(sourceRoot||path.join(__dirname,'../src'),f),'utf8'); receipt.sources[f]=crypto.createHash('sha256').update(s).digest('hex'); return s; };
  const load = f => { sourceFor(f); return loadProduction(f,sourceRoot?path.join(sourceRoot,f):undefined).exports; };
  const { Agent } = load('core/agent.ts');
  const { ConversationKernel } = load('core/conversationKernel.ts');
  const { normalizeConversationTarget } = require('../dist/core/conversationTarget');
  const oldBind=process.env.NEWMARK_BIND_HOST;
  let server;
  try {
    fs.mkdirSync(path.join(root,'Work'));
    const host=new Agent(root,{agentOnly:true});
    const workspace=host.workspace.createInternal('History window fixture');
    host.selectWorkspaceFromStorage(workspace.id);
    const targets={}, owners={};
    for (const [id,count] of [['a',450],['b',230]]) {
      const owner=new Agent(root,{agentOnly:true});
      owner.selectWorkspaceFromStorage(workspace.id); owner.setConversationFromStorage(id); owner.ensureConversationSnapshot(id);
      owner.chatMessages=Array.from({length:count},(_,i)=>({id:`${id}-${i}`,role:i%2?'assistant':'user',content:`${id} message ${i}`,timestamp:'2026-09-06T00:00:00.000Z'}));
      owner.history=owner.chatMessages.map(m=>({role:m.role,content:m.content})); owner.saveWorkspaceConversationState(true);
      owners[id]=owner;
      targets[id]=normalizeConversationTarget({workspaceId:workspace.id,conversationId:id,workspace});
    }
    host.setConversationFromStorage('a');
    const kernel=new ConversationKernel(root,host,null,{createRunner:t=>owners[t.conversationId]});
    kernel.queueAction(targets.a,'set_pause',{paused:true}); kernel.queueAction(targets.b,'set_pause',{paused:true});
    kernel.setMode(targets.a,'build'); kernel.setMode(targets.b,'plan');
    const ids=s=>Array.from(s.chatMessages||[],m=>m.id);
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const expected=(id,start,end)=>Array.from({length:end-start},(_,i)=>`${id}-${i+start}`);
    const pageCheck=(name,s,id,start,end,total)=>check(name,same(ids(s),expected(id,start,end))&&s.windowStart===start&&s.totalMessages===total,{count:ids(s).length,first:ids(s)[0],last:ids(s).at(-1),windowStart:s.windowStart,totalMessages:s.totalMessages});
    pageCheck('Agent latest 200 retains total 450',owners.a.getConversationSnapshot('a'),'a',250,450,450);
    pageCheck('Kernel forwards requested older window to live owner',kernel.snapshot(targets.a,{window:200,before:250}),'a',50,250,450);
    pageCheck('Kernel exposes final partial page',kernel.snapshot(targets.a,{window:200,before:50}),'a',0,50,450);
    pageCheck('Explicit exhausted cursor returns empty page',kernel.snapshot(targets.a,{window:200,before:0}),'a',0,0,450);
    pageCheck('Oversized cursor clamps to total without a gap',kernel.snapshot(targets.a,{window:200,before:999}),'a',250,450,450);
    const mainSource=sourceFor('main.ts'), ast=ts.createSourceFile('main.ts',mainSource,ts.ScriptTarget.Latest,true), pieces=[];
    const functions=['runtimeSnapshotForTarget','localConversationSnapshotForStartup'];
    function visit(n) {
      if(ts.isVariableDeclaration(n)&&functions.includes(n.name.getText(ast))) pieces.push(`const ${n.name.getText(ast)} = ${n.initializer.getText(ast)};`);
      if(ts.isCallExpression(n)&&n.expression.getText(ast)==='ipcMain.handle'&&['agent:getState','conversation:loadEarlier'].includes(n.arguments[0]?.text)) pieces.push(`const ${n.arguments[0].text==='agent:getState'?'getState':'loadEarlier'} = ${n.arguments[1].getText(ast)};`);
      ts.forEachChild(n,visit);
    }
    visit(ast); if(pieces.length!==4)throw Error('Actual IPC extraction seam changed');
    const pool={snapshot:async(t,o)=>kernel.snapshot(t,o),status:()=>({connected:true})};
    const context={console,process,root,agent:host,normalizeConversationTarget,mainConversationOwners:new Set(),pendingFlowStarts:new Map(),conversationSelections:new Map(),
      activeFlowStateKey:t=>t.runtimeKey,activeFlowStateFor:()=>null,ensureConversationKernel:()=>kernel,ensureElectronUtilityPool:()=>pool,ensureWslConversationPool:()=>pool,
      wslBackendEnabled:()=>false,conversationRuntimeTarget:t=>targets[t?.conversationId||'a'],isStartupPrewarmSender:e=>e?.startup===true,availableWslDistros:()=>[],
      sanitizeProvidersForState:()=>[],flowSuspensionForTarget:()=>null,flowRunningForTarget:()=>null,utilityHostToolHandler:{computerUseState:()=>null},
      normalizeUiBackgroundColor:x=>x,normalizeUiFontFamily:x=>x,resolveTerminalShell:()=>({id:'fixture'}),defaultTerminalShell:()=>'',availableTerminalShells:()=>[],
      nativeToolCatalogForState:()=>[],automation:null,electronUtilityRuntimePool:pool,activeAgentBackendMode:'windows'};
    vm.createContext(context); vm.runInContext(ts.transpileModule(pieces.join('\n')+'\nglobalThis.callbacks={getState,loadEarlier,runtimeSnapshotForTarget};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
    const c=context.callbacks;
    const initial=await c.getState({},targets.a), middle=await c.loadEarlier({}, {...targets.a,window:200,before:250}), first=await c.loadEarlier({}, {...targets.a,window:200,before:50});
    pageCheck('PC getState retains owner total and cursor',initial,'a',250,450,450);
    pageCheck('PC earlier returns exact middle 200',middle,'a',50,250,450);
    pageCheck('PC earlier returns exact first 50',first,'a',0,50,450);
    check('PC 200+200+50 reconstructs every ID once',same([...ids(first),...ids(middle),...ids(initial)],expected('a',0,450)));
    receipt.captures.push({route:'PC',pages:[initial,middle,first].map(s=>({ids:ids(s),windowStart:s.windowStart,totalMessages:s.totalMessages}))});
    pageCheck('PC getState supports explicit custom window',await c.getState({}, {...targets.a,window:37,before:111}),'a',74,111,450);
    pageCheck('PC getState exhausted cursor matches HTTP empty page',await c.getState({}, {...targets.a,before:0}),'a',0,0,450);
    pageCheck('PC earlier exhausted cursor never repeats recent messages',await c.loadEarlier({}, {...targets.a,before:0}),'a',0,0,450);
    pageCheck('Startup hydration retains full cursor',await c.getState({startup:true},targets.a),'a',250,450,450);
    pageCheck('Startup explicit exhausted cursor remains empty',await c.getState({startup:true},{...targets.a,before:0}),'a',0,0,450);
    pageCheck('Other target retains its own page',await c.getState({},targets.b),'b',30,230,230);
    context.mainConversationOwners.add(targets.a.runtimeKey);
    pageCheck('Main-owned Flow target uses the same window contract',await c.loadEarlier({}, {...targets.a,before:250}),'a',50,250,450);
    kernel.queueAction(targets.a,'set_pause',{paused:false});
    context.conversationSelections.set(targets.a.runtimeKey,{queuePaused:true});
    pageCheck('Queue policy resnapshot retains the requested earlier cursor',await c.loadEarlier({}, {...targets.a,before:250}),'a',50,250,450);
    check('History resnapshot retains authoritative queue pause',kernel.snapshot(targets.a).queuePaused===true);
    owners.a.chatMessages.push({id:'a-450',role:'assistant',content:'LIVE NOT SAVED',timestamp:'2026-09-06T00:00:01.000Z'});
    pageCheck('Live owner includes unpersisted append',await c.getState({},targets.a),'a',251,451,451);
    pageCheck('Earlier page remains stable after live append',await c.loadEarlier({}, {...targets.a,before:250}),'a',50,250,451);
    check('Reading a page does not change owner selection or history',host.activeConversationId==='a'&&owners.b.activeConversationId==='b'&&owners.a.chatMessages.length===451);
    for(const kind of ['electron','wsl']) {
      const clientFile=kind==='electron'?'core/electronUtilityAgentClient.ts':'core/wslAgentClient.ts';
      const poolFile=kind==='electron'?'core/electronUtilityRuntimePool.ts':'core/wslAgentRuntimePool.ts';
      const hostFile=kind==='electron'?'conversation-utility-host.ts':'wsl-agent-host.ts';
      const Client=load(clientFile)[kind==='electron'?'ElectronUtilityAgentClient':'WslAgentClient'];
      const Pool=load(poolFile)[kind==='electron'?'ElectronUtilityRuntimePool':'WslAgentRuntimePool'];
      const hostSource=sourceFor(hostFile), hostAst=ts.createSourceFile(hostFile,hostSource,ts.ScriptTarget.Latest,true);
      let snapshotBranch;
      function find(n){if(ts.isIfStatement(n)&&/request\.method === 'snapshot'/.test(n.expression.getText(hostAst)))snapshotBranch=n.getText(hostAst);ts.forEachChild(n,find);}
      find(hostAst);if(!snapshotBranch)throw Error('Snapshot host dispatch seam missing');
      const hostContext={kernel,checkedTarget:normalizeConversationTarget,requestTarget:p=>normalizeConversationTarget(p.target),distro:'fixture'};
      vm.createContext(hostContext);vm.runInContext(ts.transpileModule(`globalThis.dispatch=request=>{${snapshotBranch}};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,hostContext);
      const requests=[];
      const client=Object.create(Client.prototype);
      Object.assign(client,{target:targets.a,start:async()=>{},subscribe:()=>()=>{},setHostToolHandler:()=>{},mapTarget:async t=>t,status:()=>({connected:true,quarantined:false}),
        request:async(method,params)=>{requests.push({method,params});return hostContext.dispatch({method,params});}});
      const actualPool=kind==='electron'?new Pool(root,'fixture',()=>client):new Pool('fixture',root,'fixture',()=>client);
      try {
        const latest=await actualPool.snapshot(targets.a);
        const older=await actualPool.snapshot(targets.a,{window:200,before:250});
        pageCheck(`${kind}: real pool/client/host forwards older cursor`,older,'a',50,250,451);
        check(`${kind}: request preserves exact target and window`,requests.at(-1)?.params.target.runtimeKey===targets.a.runtimeKey&&same(requests.at(-1)?.params.options,{window:200,before:250}),requests.at(-1));
        const entry=actualPool.entries.get(targets.a.runtimeKey);
        check(`${kind}: older page never replaces latest supervisor cache`,same(ids(entry.lastSnapshot),ids(latest))&&entry.lastSnapshot.windowStart===251);
        entry.stopIntent={runId:'fixture-stop',generation:1};
        const count=requests.length, stopping=await actualPool.snapshot(targets.a);
        check(`${kind}: default stopping snapshot retains latest page`,same(ids(stopping),ids(latest))&&stopping.runtime.stopRequested===true&&requests.length===count);
        let error;
        try {await actualPool.snapshot(targets.a,{window:200,before:250});}catch(e){error=e;}
        check(`${kind}: stopping rejects unavailable older window without false cursor`,/temporarily unavailable/.test(error?.message||'')&&requests.length===count);
      } finally {
        for(const entry of actualPool.entries.values())if(entry.idleTimer)clearTimeout(entry.idleTimer);
        actualPool.entries.clear();
      }
    }
    const port=await new Promise(resolve=>{const probe=net.createServer().listen(0,'127.0.0.1',()=>{const p=probe.address().port;probe.close(()=>resolve(p));});});
    const serverSource=sourceFor('server.ts'), patched=serverSource.replace('const PORT = 47890;',`const PORT = ${port};`);
    if(patched===serverSource)throw Error('Isolated port seam missing');
    const file=path.resolve(__dirname,'../dist/server.js'), compiled=new Module(file,module); compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));
    let newAgents=0;
    compiled.require=function(name){const value=Module.prototype.require.call(this,name);return name==='./core/agent'?{...value,Agent:new Proxy(Agent,{construct(Type,args){newAgents++;return Reflect.construct(Type,args);}})}:value;};
    compiled._compile(ts.transpileModule(patched,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,file);server=compiled.exports;
    process.env.NEWMARK_BIND_HOST='127.0.0.1';
    const requests=[];
    server.runServer(root,{agent:host,conversationUiState:async(t,o)=>{requests.push({target:t,window:o});return c.runtimeSnapshotForTarget(targets[t.conversationId],o);}});
    const token=require('../dist/core/mobilePairing').ensureMobileToken(root);
    const get=async(query,bearer=token)=>{const r=await fetch(`http://127.0.0.1:${port}/api/mobile/conversation?`+new URLSearchParams(query),{headers:{authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(10000)});return{status:r.status,body:await r.json()};};
    const query={workspaceId:workspace.id,conversationId:'a'};
    pageCheck('HTTP owner read includes unpersisted append',(await get(query)).body,'a',251,451,451);
    pageCheck('HTTP older window equals PC owner page',(await get({...query,window:'200',before:'250'})).body,'a',50,250,451);
    pageCheck('HTTP earliest partial page preserves total',(await get({...query,window:'200',before:'50'})).body,'a',0,50,451);
    pageCheck('HTTP exhausted cursor does not repeat latest',(await get({...query,window:'200',before:'0'})).body,'a',0,0,451);
    pageCheck('HTTP other workspace conversation stays isolated',(await get({...query,conversationId:'b'})).body,'b',30,230,230);
    check('Hosted history never creates a second disk-only Agent',newAgents===0,{newAgents});
    const count=requests.length;
    check('HTTP authentication remains before history owner read',(await get(query,'wrong')).status===401&&requests.length===count);
    check('HTTP unknown target is rejected before owner read',(await get({...query,conversationId:'unknown'})).status===404&&requests.length===count);
    sourceFor('core/agent.ts');sourceFor('core/conversationKernel.ts');
    receipt.passed=receipt.checks.every(c=>c.passed);receipt.passedCount=receipt.checks.filter(c=>c.passed).length;receipt.failedCount=receipt.checks.length-receipt.passedCount;
    if(reportPath){fs.mkdirSync(path.dirname(path.resolve(reportPath)),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(receipt,null,2)+'\n');}
    if(!receipt.passed)throw Error(`${receipt.failedCount} history window assertions failed`);
    return receipt;
  } finally {
    await server?.stopHostedServer();
    if(oldBind===undefined)delete process.env.NEWMARK_BIND_HOST;else process.env.NEWMARK_BIND_HOST=oldBind;
    if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('newmark-history-window-'))throw Error('Temporary cleanup path mismatch');
    fs.rmSync(root,{recursive:true,force:true});
  }
}
module.exports={run};
if(require.main===module)run(process.argv.includes('--report')?process.argv[process.argv.indexOf('--report')+1]:undefined,process.argv.includes('--source-root')?process.argv[process.argv.indexOf('--source-root')+1]:undefined).then(r=>console.log(JSON.stringify({passed:r.passed,passedCount:r.passedCount}))).catch(e=>{console.error(e.stack||e);process.exitCode=1;});
