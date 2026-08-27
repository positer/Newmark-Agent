const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };
function getJson(url) { return new Promise((resolve, reject) => { const request=http.get(url, response => { let body=''; response.on('data', chunk => body += chunk); response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } }); }); request.setTimeout(1000,()=>request.destroy(new Error('CDP discovery timeout'))); request.on('error',reject); }); }
function freeTcpPort() { return new Promise((resolve,reject)=>{ const server=http.createServer(); server.unref(); server.once('error',reject); server.listen(0,'127.0.0.1',()=>{ const address=server.address(); server.close(error=>error?reject(error):resolve(address.port)); }); }); }
async function target(port, child) { let lastPages=[],lastError=''; for(let i=0;i<300;i++){ if(child.exitCode!==null)fail(`Electron exited before CDP target discovery: ${child.exitCode}`); try { const pages=await getJson(`http://127.0.0.1:${port}/json/list`); lastPages=pages.map(page=>String(page.url||'')); const page=pages.find(item=>item.webSocketDebuggerUrl&&String(item.url||'').includes('index.html')); if(page)return page; } catch(error) { lastError=String(error?.message||error); } await sleep(300); } fail(`CDP target timeout pages=${JSON.stringify(lastPages)} error=${lastError}`); }
function connect(page) { let id=0; const pending=new Map(); const ws=new WebSocket(page.webSocketDebuggerUrl); const opened=new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;ws.onmessage=event=>{const msg=JSON.parse(event.data);const entry=pending.get(msg.id);if(!entry)return;pending.delete(msg.id);msg.error?entry.reject(new Error(msg.error.message)):entry.resolve(msg.result);};}); const ready=Promise.race([opened,new Promise((_,reject)=>setTimeout(()=>reject(new Error('CDP websocket timeout')),10000))]); const call=(method,params={})=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});ws.send(JSON.stringify({id:current,method,params}));setTimeout(()=>{if(pending.delete(current))reject(new Error(`timeout ${method}`));},20000);}); return{ws,ready,call}; }
async function evaluate(cdp, expression) { const result=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)fail(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value; }

(async()=>{
  const repoRoot=path.resolve(__dirname,'..','..');
  const desktopRoot=path.join(repoRoot,'DESKTOP');
  const electron=path.join(desktopRoot,'node_modules','electron','dist','electron.exe');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'NewmarkWorkReviewBars-'));
  const screenshot=path.join(repoRoot,'archive','2026-07-12-work-review-bars-smoke.png');
  const port=await freeTcpPort();
  let child,cdp;
  try {
    child=spawn(electron,['.',`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(root,'ElectronData')}`,'--no-sandbox','--root',root],{cwd:desktopRoot,stdio:process.env.NEWMARK_SMOKE_DEBUG==='1'?'inherit':'ignore',windowsHide:true});
    cdp=connect(await target(port,child));await cdp.ready;
    await waitForPromotedMainUi(cdp);await cdp.call('Runtime.enable');await cdp.call('Page.enable');
    for(let i=0;i<100;i++){if(await evaluate(cdp,`typeof window.addWorkReview==='function'&&typeof window.renderInputStack==='function'`))break;await sleep(200);if(i===99)fail('renderer init timeout');}
    // The promoted shell can precede the final asynchronous conversation
    // hydration. Inject fixtures only after that startup redraw has settled.
    await sleep(1500);
    await evaluate(cdp,`(() => {
      const stableStyle=document.createElement('style');stableStyle.textContent='.stack-card{animation:none!important}';document.head.appendChild(stableStyle);
      window.state.conversationPlan={items:[{id:'a',text:'Inspect repository changes',status:'pending'},{id:'b',text:'Run UI regression',status:'done'}]};
      window.state.todoCollapsed=true;window.state.queueCollapsed=true;window.state.goalText='Ship a stable interaction pass';window.state.goalVisible=true;window.state.goalPaused=false;
      const queueTarget=window.currentConversationTarget();window.state.backendQueue=window.setBackendQueueForTarget({steering:[],followUp:['Verify packaged interaction']},queueTarget);window.renderInputStack();
      document.documentElement.setAttribute('data-theme','light');
      const reviewRecord={runId:'work-review-smoke-run',diffs:[{path:'DESKTOP/src/ui/index.html',old:12,new:44,oldContent:'old line',newContent:'old line\\nnew line'},{path:'DESKTOP/src/main.ts',old:3,new:8},{path:'README.md',old:1,new:4},{path:'OVERVIEW.md',old:0,new:3},{path:'DESKTOP/src/tests/verify.ts',old:2,new:9}]};
      window.conversationWorkUiState(window.activeConversationId()).workReviews=[reviewRecord];
      window.addWorkReview(reviewRecord.diffs,reviewRecord.runId);
      const updatedDiffs=[{path:'DESKTOP/src/ui/index.html',old:14,new:50},{path:'DESKTOP/src/main.ts',old:4,new:10},{path:'README.md',old:1,new:5},{path:'OVERVIEW.md',old:0,new:4},{path:'DESKTOP/src/tests/verify.ts',old:2,new:11}];
      window.addWorkReview(updatedDiffs,reviewRecord.runId);
      window.addWorkReview(updatedDiffs, 'work-review-canonical-run', [reviewRecord.runId]);
      const more=document.querySelector('.work-review-more');more.click();document.querySelector('.work-review-btn').click();
      return true;
    })()`);
    await sleep(250);
    // A slow startup hydration can finish after fixture injection and rebuild
    // the transcript. Require the fixture to survive a quiet interval before
    // measuring it, reinjecting only when that startup redraw removes it.
    let reviewStable=false;
    for(let attempt=0;attempt<30;attempt++){
      await evaluate(cdp,`(() => {
        if(document.querySelector('.work-review'))return true;
        const updatedDiffs=[{path:'DESKTOP/src/ui/index.html',old:14,new:50},{path:'DESKTOP/src/main.ts',old:4,new:10},{path:'README.md',old:1,new:5},{path:'OVERVIEW.md',old:0,new:4},{path:'DESKTOP/src/tests/verify.ts',old:2,new:11}];
        window.addWorkReview(updatedDiffs,'work-review-canonical-run');
        const more=document.querySelector('.work-review-more');if(more)more.click();
        const open=document.querySelector('.work-review-btn');if(open)open.click();
        return true;
      })()`);
      await sleep(200);
      if(await evaluate(cdp,`!!document.querySelector('.work-review')`)){reviewStable=true;break;}
    }
    if(!reviewStable)fail('review fixture did not survive startup hydration');
    const state=await evaluate(cdp,`(() => {
      const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,width:r.width}};
      const reviewStyle=getComputedStyle(document.querySelector('.work-review'));
      return {todo:rect('todo-wrap'),queue:rect('queue-panel'),goal:rect('goal-bar'),reviewCards:document.querySelectorAll('.work-review').length,reviewRows:document.querySelectorAll('.work-review-file').length,visibleRows:Array.from(document.querySelectorAll('.work-review-file')).filter(x=>getComputedStyle(x).display!=='none').length,reviewRunId:document.querySelector('.work-review')?.getAttribute('data-run-id')||'',reviewOpen:document.getElementById('sub-win-overlay').classList.contains('open'),goalText:document.getElementById('goal-text').textContent,queueLabel:document.getElementById('queue-header-label').textContent,reviewColor:reviewStyle.color,reviewBackground:reviewStyle.backgroundColor,chatCanvas:getComputedStyle(document.getElementById('center')).backgroundColor};
    })()`);
    if(state.todo.height>34||state.queue.height>34||state.goal.height>34)fail(`bars are oversized: ${JSON.stringify(state)}`);
    if((state.queue.height>0&&state.todo.bottom>state.queue.top)||(state.queue.height>0&&state.queue.bottom>state.goal.top)||(state.queue.height===0&&state.todo.bottom>state.goal.top))fail(`bars overlap: ${JSON.stringify(state)}`);
    if(state.reviewCards!==1||state.reviewRows!==5||state.visibleRows!==5||state.reviewRunId!=='work-review-canonical-run'||!state.reviewOpen||!state.goalText.includes('Ship'))fail(`interaction state failed: ${JSON.stringify(state)}`);
    if(!state.chatCanvas||state.chatCanvas==='rgba(0, 0, 0, 0)')fail(`chat theme canvas missing: ${JSON.stringify(state)}`);
    if(state.reviewBackground.includes('18, 20, 28')||state.reviewColor==='rgb(10, 10, 26)')fail(`light review theme failed: ${JSON.stringify(state)}`);
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(cdp,`window.closeSubWin()`);
    const liveToolFold=await evaluate(cdp,`(async()=>{
      const runId='live-tool-fold-smoke';
      window.applyAgentWorkEventToRun({id:'call-1',runId,type:'tool_call',toolName:'bash',toolArgs:'npm.cmd test',status:'running',conversationId:window.activeConversationId()});
      let details=document.querySelector('.conversation-work-run[data-run-id="'+runId+'"] details.conversation-work-activity');
      if(!details)return{created:false};
      details.open=true;
      const key=details.getAttribute('data-activity-key');
      window.applyAgentWorkEventToRun({id:'result-1',runId,type:'tool_result',toolName:'bash',status:'running',conversationId:window.activeConversationId()});
      await new Promise(resolve=>setTimeout(resolve,1250));
      details=document.querySelector('.conversation-work-run[data-run-id="'+runId+'"] details.conversation-work-activity[data-activity-key="'+key+'"]');
      return{created:true,key,open:!!(details&&details.open),title:document.querySelector('.conversation-work-run[data-run-id="'+runId+'"] .conversation-work-run-title')?.textContent||''};
    })()`);
    if(!liveToolFold.created||!liveToolFold.key||!liveToolFold.open||!liveToolFold.title)fail(`live Build tool details collapsed during refresh: ${JSON.stringify(liveToolFold)}`);
    const repeatedBuildToggle=await evaluate(cdp,`(() => {
      const runId='review-toggle-dedup-smoke';
      window.applyAgentWorkEventToRun({id:'edit-1',runId,type:'tool_call',toolName:'apply_patch',toolArgs:JSON.stringify({path:'src/a.ts',old_str:'old',new_str:'old\\nnew'}),status:'completed',completed:true,conversationId:window.activeConversationId()});
      const run=window.state.workRunsByTarget[window.currentRuntimeKey(window.activeConversationId())].find(item=>item.runId===runId);
      run.status='completed';run.expanded=false;window.renderConversationWorkRunImmediately(run);
      const element=document.querySelector('.conversation-work-run[data-run-id="'+runId+'"]');
      const head=element.querySelector('.conversation-work-run-head');
      for(let i=0;i<8;i++)window.toggleConversationWorkRun(head);
      const pseudo=getComputedStyle(head,'::after');
      const style=getComputedStyle(head);const chevronStyle=getComputedStyle(head.querySelector('.conversation-work-run-chevron'));
      return {badges:element.querySelectorAll('.conversation-work-change-badge').length,expanded:element.classList.contains('expanded'),pseudoDisplay:pseudo.display,scale:style.scale,transitionDuration:style.transitionDuration,animationName:style.animationName,transform:style.transform,filter:style.filter,chevronTransitionDuration:chevronStyle.transitionDuration,liquidFloats:document.querySelectorAll('.liquid-selection-float').length};
    })()`);
    if(repeatedBuildToggle.badges!==1||repeatedBuildToggle.expanded||repeatedBuildToggle.pseudoDisplay!=='none'||(repeatedBuildToggle.scale&&repeatedBuildToggle.scale!=='1'&&repeatedBuildToggle.scale!=='none')||repeatedBuildToggle.transitionDuration!=='0s'||repeatedBuildToggle.animationName!=='none'||(repeatedBuildToggle.transform&&repeatedBuildToggle.transform!=='none')||(repeatedBuildToggle.filter&&repeatedBuildToggle.filter!=='none')||repeatedBuildToggle.chevronTransitionDuration!=='0s'||repeatedBuildToggle.liquidFloats!==0)fail(`repeated Build toggle duplicated review or retained glass/motion: ${JSON.stringify(repeatedBuildToggle)}`);
    const shot=await cdp.call('Page.captureScreenshot',{format:'png',fromSurface:true},30000);fs.mkdirSync(path.dirname(screenshot),{recursive:true});fs.writeFileSync(screenshot,Buffer.from(shot.data,'base64'));if(fs.statSync(screenshot).size<10000)fail('screenshot too small');
    console.log(`[release-ui-work-review-bars-smoke] PASS ${JSON.stringify({state,liveToolFold,repeatedBuildToggle})} screenshot=${screenshot}`);
  } finally {
    try{cdp?.ws.close();}catch{}
    if(child?.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:15000});
    for(let i=0;i<6;i++){try{fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:200});if(!fs.existsSync(root))break;}catch{}await sleep(300);}
  }
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
