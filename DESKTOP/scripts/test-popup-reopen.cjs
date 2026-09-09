const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert/strict');
const {spawn}=require('child_process');
const {waitForPromotedMainUi}=require('./cdp-main-ui-ready');
const desktop=path.resolve(__dirname,'..'), root=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-consistency-ui-'));
 const out=path.resolve(process.env.NEWMARK_UI_TEST_OUTPUT||path.resolve(desktop,'../archive/20260908-dev-0.6.2-full-visual'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=url=>new Promise((resolve,reject)=>http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});}).on('error',reject));
(async()=>{
 const config={models:{providers:[{id:'fixture',name:'Fixture',protocol:'openai',base_url:'http://127.0.0.1:49997/v1',api_key:'synthetic',enabled:true,models:[{name:'abnormal-model',display:'Abnormal model',enabled:true,vision:false,max_tokens:32000,validation:{level:'standard',status:'unavailable',capabilities:{}}},{name:'another-model',enabled:true,max_tokens:32000}]}],default_model:'deployment:fixture:abnormal-model',auto_switch:false},general:{language:'zh'}};
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
 const port=49279;
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
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  for(let i=0;i<60;i++){if(await evaluate('typeof state !== "undefined" && state.providers.length > 0'))break;await sleep(250);}
  await evaluate("window.openSettings('general')");await sleep(500);
  await evaluate("window.closeSubWin();window.openSettings('models')");await sleep(1500);
  const stateAfter=await evaluate(`({open:!!document.querySelector('#sub-win-overlay.open'),exit:document.querySelector('#sub-win').classList.contains('liquid-popup-exit'),models:!!document.querySelector('#stab-models'),timer:!!document.querySelector('#sub-win')._liquidExitTimer})`);
  console.log(JSON.stringify(stateAfter));
  assert.ok(stateAfter.open&&!stateAfter.exit&&stateAfter.models,'A reopened dialog must remain visible after the old exit finishes');
  console.log('PASS reopened glass dialog survives prior exit');
 }finally{ws?.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});