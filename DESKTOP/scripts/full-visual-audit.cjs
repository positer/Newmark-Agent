const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert/strict');
const {spawn}=require('child_process');
const {waitForPromotedMainUi}=require('./cdp-main-ui-ready');
const desktop=path.resolve(__dirname,'..'), root=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-full-visual-'));
 const out=path.resolve(process.env.NEWMARK_UI_TEST_OUTPUT||path.resolve(desktop,'../archive/20260908-dev-0.6.2-full-visual'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=url=>new Promise((resolve,reject)=>http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});}).on('error',reject));
(async()=>{
 const config={models:{providers:[{id:'fixture',name:'Fixture',protocol:'openai',base_url:'http://127.0.0.1:49997/v1',api_key:'synthetic',enabled:true,models:[{name:'abnormal-model',display:'Abnormal model',enabled:true,vision:false,max_tokens:32000,validation:{level:'standard',status:'unavailable',capabilities:{}}},{name:'another-model',enabled:true,max_tokens:32000}]}],default_model:'deployment:fixture:abnormal-model',auto_switch:false},general:{language:'zh'}};
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
 const port=49278;
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 fs.mkdirSync(out,{recursive:true});
 const child=spawn(process.env.NEWMARK_TEST_EXE||path.join(desktop,'node_modules/electron/dist/electron.exe'),[...(process.env.NEWMARK_TEST_EXE?[]:[desktop]),'--root',root,`--remote-debugging-port=${port}`,'--no-sandbox'],{cwd:desktop,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
 child.stdout.pipe(fs.createWriteStream(path.join(out,"electron-ui-stdout.log")));
 child.stderr.pipe(fs.createWriteStream(path.join(out,"electron-ui-stderr.log")));
 let ws;
 try{
  let target;for(let i=0;i<100;i++){try{target=(await get(`http://127.0.0.1:${port}/json/list`)).find(t=>t.type==='page'&&t.url.includes('index.html'));if(target)break;}catch{}await sleep(300);}
  assert.ok(target,'Electron renderer ready');
  ws=new WebSocket(target.webSocketDebuggerUrl);const ready=new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout: '+method));},15000);pending.set(key,{resolve:r=>{clearTimeout(timer);resolve(r)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const waitUntil=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100);}console.log(await evaluate(`JSON.stringify({enabled:state.providers[0].models[0].enabled,float:document.querySelector('.liquid-switch-float')?.className,checked:document.querySelector('.model-enable-switch')?.checked,disabled:document.querySelector('.model-enable-switch')?.disabled,events:window.switchEvents,notices:document.body.innerText.slice(-1200)})`));throw Error('Timed out: '+expression);};
  const cdp={ready,call};
  await cdp.ready;
  await waitForPromotedMainUi(cdp);
  console.log('Main UI ready');
  const width=Number(process.env.NEWMARK_UI_WIDTH||1280),height=Number(process.env.NEWMARK_UI_HEIGHT||900);
  assert.ok(Number.isInteger(width)&&width>=320&&Number.isInteger(height)&&height>=240,'Valid audit viewport');
  await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  for(let i=0;i<60;i++){if(await evaluate('typeof state !== "undefined" && state.providers.length > 0'))break;await sleep(250);}
  const cases = [
    ['main','void 0'],
    ...['assistant','user'].map(role=>['code-'+role,`renderChatMessages([{role:'${role}',content:${JSON.stringify('```kotlin\nval raw = "<tag>& value"\n'+'x'.repeat(180)+'\n```\n\n```\necho second\n```')}}]);document.querySelector('#chat-area').scrollTop=0`]),
    ...['general','models','tools','archive','updates'].map(tab=>['settings-'+tab,`window.openSettings('${tab}')`]),
    ['provider-new','window.addProvider()'],['provider-edit','window.editProvider(0)'],
    ['model-new','window.addModel()'],['model-edit','window.editModel(0,0)'],
    ...['mcp','dsh','installed','market','github'].map(tab=>['plugins-'+tab,`window.showPluginList('${tab}')`]),
    ['mcp-new',"(async()=>{await window.showPluginList('mcp');window.openMcpAddForm()})()"],
    ['memory-overview',"(async()=>{await window.showMemoryLab();window.switchMemoryLabView('overview')})()"],
    ['memory-detail',"(async()=>{await window.showMemoryLab();window.switchMemoryLabView('detail')})()"],
    ['automation','window.showAutomationWindow()'],['automation-new','window.showNewAutomationForm()'],
    ['flow','window.showFlowEditor()'],['new-conversation','window.showNewConversationPage()'],
    ['workspace-new','window.showNewWorkspaceDialog()'],['workspace-manager','window.openWorkspaceManager()'],
    ['workspace-settings','window.openWsSettings()'],['mobile-pairing','window.showMobilePairing()'],
    ...['file-tree','editor','plan','subagent','browser','status','archives'].map(tab=>['right-'+tab,`window.switchRightTab('${tab}')`]),
    ['model-menu','window.toggleModelSelectMenu(true)'],
    ['context','window.toggleContextInspector()'],['command-palette',"window.openCommandSurface('palette')"],
  ];
  const results=[];
  for(const theme of ['dark','light']) {
    await evaluate(`window.setTheme('${theme}')`);
    for(const [name,action] of cases.filter(([name])=>!process.env.NEWMARK_UI_CASES||process.env.NEWMARK_UI_CASES.split(',').includes(name))) {
      const row={theme,name,action,viewport:{width,height},capturedAt:new Date().toISOString()};
      try {
        await evaluate(`window.closeCommandSurface?.({restoreFocus:false});state.subWindowStack=[];if(document.querySelector('#sub-win-overlay.open'))window.closeSubWin();window.toggleModelSelectMenu(false);state.contextInspectorOpen=false;window.renderContextInspector();state.mcpDraft=null;state.mcpEditingId=""`);
        await waitUntil("!document.querySelector('#sub-win-overlay.open')");
        await sleep(250);
        await evaluate(action);await sleep(1000);
        if(name==='right-browser'||name==='context') row.browser=await evaluate(`(async()=>{const v=document.querySelector('#browser-webview');return v&&v._newmarkDomReady?{ready:true,url:v.getURL(),style:await v.executeJavaScript('JSON.stringify({bg:getComputedStyle(document.documentElement).backgroundColor,body:getComputedStyle(document.body).backgroundColor})')}:null})()`);
        if (!['main','model-menu','context','command-palette'].includes(name) && !name.startsWith('right-') && !name.startsWith('code-')) assert.ok(await evaluate("!!document.querySelector('#sub-win-overlay.open')"),'Requested modal must be visible: '+name);
        if(name.startsWith('code-')) {
          row.code=await evaluate(`(async()=>{const blocks=[...document.querySelectorAll('#chat-area .msg-body pre')];const original=Object.getOwnPropertyDescriptor(navigator,'clipboard');const copied=[];try{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>copied.push(text)}});for(const pre of blocks){await window.copyMarkdownCode(pre.querySelector('.md-code-copy'));const code=pre.querySelector('code');code.scrollLeft=code.scrollWidth;}return {copied,blocks:blocks.map(pre=>{const r=pre.getBoundingClientRect(),m=pre.closest('.chat-msg').getBoundingClientRect(),b=pre.querySelector('button').getBoundingClientRect();return {leftGap:r.left-m.left,rightGap:m.right-r.right,buttonVisible:b.left>=r.left&&b.right<=r.right}})}}finally{if(original)Object.defineProperty(navigator,'clipboard',original);else delete navigator.clipboard;}})()`);
          assert.deepEqual(row.code.copied,['val raw = "<tag>& value"\n'+'x'.repeat(180),'echo second']);
          assert.ok(row.code.blocks.every(b=>b.leftGap>=24&&b.rightGap>=24&&b.buttonVisible),'Code and copy buttons avoid both timeline rails, including horizontal scroll');
        }
        if(name.startsWith('right-')) assert.equal(await evaluate('state.rightTab'),name.slice(6));
        row.ui=await evaluate(`(()=>{const root=document.querySelector('#sub-win-overlay.open #sub-win')||document.querySelector('#app');const b=root.getBoundingClientRect();const controls=Array.from(root.querySelectorAll('button,input,select,textarea')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'});return {title:document.querySelector('#sub-win-title')?.textContent,text:root.innerText.slice(0,1200),width:b.width,height:b.height,controls:controls.length,overflow:controls.filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+2||r.left< -2}).map(e=>({text:e.textContent.slice(0,50),tag:e.tagName})),theme:document.documentElement.dataset.theme}})()`);
        row.file=`${theme}-${name}.png`;
        fs.writeFileSync(path.join(out,row.file),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
        assert.equal(row.ui.overflow.length,0,'Visible controls must fit viewport: '+JSON.stringify(row.ui.overflow));
        if(name==='context') assert.ok(await evaluate(`(()=>{const p=document.querySelector('#context-inspector').getBoundingClientRect(),c=document.querySelector('#center').getBoundingClientRect();return p.left>=c.left&&p.right<=c.right&&p.top>=c.top&&p.bottom<=c.bottom})()`),'Context inspector must fit its clipping chat column');
        row.status='captured';
        console.log('CAPTURE '+theme+' '+name+' '+row.ui.controls+' controls');
      } catch(error) {row.status='error';row.error=String(error);console.log('ERROR '+theme+' '+name+' '+error);}
      results.push(row);fs.writeFileSync(path.join(out,'desktop-inventory.json'),JSON.stringify(results,null,2));
    }
  }
  if(results.some(r=>r.status==='error'))process.exitCode=1;
  console.log('Desktop sweep: '+results.filter(r=>r.status==='captured').length+'/'+results.length+' captures');
 } finally { ws?.close(); child.kill(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
