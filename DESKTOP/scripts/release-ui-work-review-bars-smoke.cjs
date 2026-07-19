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
    await evaluate(cdp,`(() => {
      const stableStyle=document.createElement('style');stableStyle.textContent='.stack-card{animation:none!important}';document.head.appendChild(stableStyle);
      window.state.conversationPlan={items:[{id:'a',text:'Inspect repository changes',status:'pending'},{id:'b',text:'Run UI regression',status:'done'}]};
      window.state.todoCollapsed=true;window.state.nextQueue=['Verify packaged interaction'];window.state.queueCollapsed=true;window.state.goalText='Ship a stable interaction pass';window.state.goalPaused=false;window.renderInputStack();
      document.documentElement.setAttribute('data-theme','light');
      window.addWorkReview([{path:'DESKTOP/src/ui/index.html',old:12,new:44,oldContent:'old line',newContent:'old line\\nnew line'},{path:'DESKTOP/src/main.ts',old:3,new:8},{path:'README.md',old:1,new:4},{path:'OVERVIEW.md',old:0,new:3},{path:'DESKTOP/src/tests/verify.ts',old:2,new:9}]);
      const more=document.querySelector('.work-review-more');more.click();document.querySelector('.work-review-btn').click();
      return true;
    })()`);
    await sleep(250);
    const state=await evaluate(cdp,`(() => {
      const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,width:r.width}};
      const reviewStyle=getComputedStyle(document.querySelector('.work-review'));
      return {todo:rect('todo-wrap'),queue:rect('queue-panel'),goal:rect('goal-bar'),reviewRows:document.querySelectorAll('.work-review-file').length,visibleRows:Array.from(document.querySelectorAll('.work-review-file')).filter(x=>getComputedStyle(x).display!=='none').length,reviewOpen:document.getElementById('sub-win-overlay').classList.contains('open'),goalText:document.getElementById('goal-text').textContent,queueLabel:document.getElementById('queue-header-label').textContent,reviewColor:reviewStyle.color,reviewBackground:reviewStyle.backgroundColor};
    })()`);
    if(state.todo.height>34||state.queue.height>34||state.goal.height>34)fail(`bars are oversized: ${JSON.stringify(state)}`);
    if((state.queue.height>0&&state.todo.bottom>state.queue.top)||(state.queue.height>0&&state.queue.bottom>state.goal.top)||(state.queue.height===0&&state.todo.bottom>state.goal.top))fail(`bars overlap: ${JSON.stringify(state)}`);
    if(state.reviewRows!==5||state.visibleRows!==5||!state.reviewOpen||!state.goalText.includes('Ship'))fail(`interaction state failed: ${JSON.stringify(state)}`);
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
    const shot=await cdp.call('Page.captureScreenshot',{format:'png',fromSurface:true},30000);fs.mkdirSync(path.dirname(screenshot),{recursive:true});fs.writeFileSync(screenshot,Buffer.from(shot.data,'base64'));if(fs.statSync(screenshot).size<10000)fail('screenshot too small');
    console.log(`[release-ui-work-review-bars-smoke] PASS ${JSON.stringify({state,liveToolFold})} screenshot=${screenshot}`);
  } finally {
    try{cdp?.ws.close();}catch{}
    if(child?.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:15000});
    for(let i=0;i<6;i++){try{fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:200});if(!fs.existsSync(root))break;}catch{}await sleep(300);}
  }
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
