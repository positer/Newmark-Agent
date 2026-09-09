const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert/strict');
const {spawn}=require('child_process');
const {waitForPromotedMainUi}=require('./cdp-main-ui-ready');
const desktop=path.resolve(__dirname,'..'), root=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-local-html-'));
 const out=path.resolve(process.env.NEWMARK_UI_TEST_OUTPUT||path.resolve(desktop,'../archive/20260908-local-html-browser'));
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
  const fixture=path.join(root,'本地 pages');fs.mkdirSync(fixture);
  const localFile=path.join(fixture,'index #1.html');
  fs.writeFileSync(localFile,'<!doctype html><meta charset="utf-8"><title>Local HTML ready</title><link rel="stylesheet" href="style.css"><h1 id="result">本地 HTML</h1><script src="script.js"></script><a id="next" href="next.html">Next</a>');
  fs.writeFileSync(path.join(fixture,'style.css'),'h1 { color: rgb(12, 34, 56) }');
  fs.writeFileSync(path.join(fixture,'script.js'),'document.body.dataset.script="ready"');
  fs.writeFileSync(path.join(fixture,'next.html'),'<title>Relative link ready</title>Relative link ready');
  const normalizeToolUrl=require('../dist/core/browserUse').normalizeBrowserUseUrl;
  assert.equal(normalizeToolUrl(localFile),require('url').pathToFileURL(localFile).href);
  assert.equal(normalizeToolUrl('file://remote/share/index.html'),'');
  assert.equal(normalizeToolUrl('javascript:alert(1)'),'');
  assert.equal(await evaluate("window.normalizeBrowserAddress('localhost:8080')"),'https://localhost:8080/');
  for(const raw of [localFile,require('url').pathToFileURL(localFile).href,require('url').pathToFileURL(localFile).href.replace('file:','files:')]) {
    await evaluate(`(async()=>{window.switchRightTab('browser');await window.navigateBrowser(${JSON.stringify(raw)});return true})()`);
    await waitUntil(`(async()=>{const v=document.querySelector('webview[data-newmark-browser-runtime-key]');try{return await v.executeJavaScript('document.title === "Local HTML ready" && document.body.dataset.script === "ready"')}catch{return false}})()`);
    assert.equal(await evaluate(`document.querySelector('webview[data-newmark-browser-runtime-key]').executeJavaScript('getComputedStyle(document.querySelector("h1")).color')`),'rgb(12, 34, 56)');
  }
  if(process.env.NEWMARK_TEST_VIEWPORT) {
    for(const viewport of [{width:800,height:600},{width:390,height:844}]) {
      assert.equal(await evaluate(`window.setBrowserViewport(document.querySelector('webview[data-newmark-browser-runtime-key]').getWebContentsId(),${JSON.stringify(viewport)})`),true);
      await sleep(300);
      const actual=await evaluate(`document.querySelector('webview[data-newmark-browser-runtime-key]').executeJavaScript('({width:innerWidth,height:innerHeight})')`);
      assert.ok(Math.abs(actual.width-viewport.width)<=1 && Math.abs(actual.height-viewport.height)<=1,JSON.stringify({actual,viewport}));
    }
    fs.writeFileSync(path.join(out,'pc-real-panel.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    const footerScript = 'const f=document.createElement("footer");f.style.cssText="position:fixed;bottom:0;left:0;width:100%;height:16px;background:rgb(18,52,86)";document.body.appendChild(f);';
    await evaluate(`document.querySelector('webview[data-newmark-browser-runtime-key]').executeJavaScript(${JSON.stringify(footerScript)})`);
    await sleep(200);
    const guestImage=await evaluate(`document.querySelector('webview[data-newmark-browser-runtime-key]').capturePage().then(image=>image.toDataURL())`);
    fs.writeFileSync(path.join(out,'pc-real-guest.png'),Buffer.from(guestImage.split(',')[1],'base64'));
    console.log('PASS actual built-in webview canvas resizing and fitting in existing panel');
  }
  fs.writeFileSync(path.join(out,'pc-local-html.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate(`document.querySelector('webview[data-newmark-browser-runtime-key]').executeJavaScript('document.querySelector("#next").click()')`);
  await waitUntil(`(async()=>{try{return await document.querySelector('webview[data-newmark-browser-runtime-key]').executeJavaScript('document.title === "Relative link ready"')}catch{return false}})()`);
  console.log('PASS: absolute path, file URL, files alias, Chinese/spaces/hash, relative CSS/JS and relative HTML navigation');
 }finally{ws?.close();child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});