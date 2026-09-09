const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert/strict');
const {spawn}=require('child_process');
const {waitForPromotedMainUi}=require('./cdp-main-ui-ready');
const desktop=path.resolve(__dirname,'..'), root=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-consistency-ui-'));
 const out=path.resolve(process.env.NEWMARK_UI_TEST_OUTPUT||path.resolve(desktop,'../archive/20260908-dev-0.6.2-ui-consistency'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const get=url=>new Promise((resolve,reject)=>http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{resolve(JSON.parse(b));}catch(e){reject(e);}});}).on('error',reject));
(async()=>{
 const config={models:{providers:[{id:'fixture',name:'Fixture',protocol:'openai',base_url:'http://127.0.0.1:49997/v1',api_key:'synthetic',enabled:true,models:[{name:'abnormal-model',display:'Abnormal model',enabled:true,vision:false,max_tokens:32000,validation:{level:'standard',status:'unavailable',capabilities:{}}},{name:'another-model',enabled:true,max_tokens:32000}]}],default_model:'deployment:fixture:abnormal-model',auto_switch:false},general:{language:'zh'}};
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
 const port=49277;
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
  const results=[];
  for(const theme of ['dark','light']) {
    await evaluate(`window.setTheme('${theme}')`);
    await sleep(400);
    const baseline=await evaluate(`(()=>{const c=getComputedStyle(document.documentElement);return {primary:c.getPropertyValue('--text-bright').trim(),secondary:c.getPropertyValue('--text').trim(),tertiary:c.getPropertyValue('--text-dim').trim(),hover:c.getPropertyValue('--control-hover-bg').trim()}})()`);
    const expected=theme==='dark'?['#f2f2f2','#cecece','#949494']:['#0a0a1a','#1a1a2e','#6a7090'];
    assert.deepEqual([baseline.primary,baseline.secondary,baseline.tertiary],expected);
    const mobileTheme=fs.readFileSync(path.resolve(desktop,'../android/app/src/main/java/com/newmark/mobile/ui/theme/NewmarkTheme.kt'),'utf8');
    for(const [index,level] of ['Primary','Secondary','Tertiary'].entries()) {
      const name=`Newmark${theme==='light'?'Light':''}Text${level}`;
      const match=mobileTheme.match(new RegExp(`val ${name} = Color\\(0xFF([A-Fa-f0-9]{6})\\)`));
      assert.ok(match,`Mobile ${name} must have an opaque semantic color`);
      assert.equal('#'+match[1].toLowerCase(),expected[index],`PC/mobile ${level} colors match`);
    }
    const pos=await evaluate(`(()=>{const r=document.querySelector('.top-btn').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',...pos});
    await sleep(250);
    const hover=await evaluate(`getComputedStyle(document.querySelector('.top-btn')).backgroundColor`);
    assert.equal(hover,theme==='dark'?'rgba(255, 255, 255, 0.08)':'rgba(0, 0, 0, 0.055)');
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:600,y:100});
    await evaluate("window.closeSubWin()");
    await sleep(300);
    fs.writeFileSync(path.join(out,`pc-${theme}-main.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate("window.openSettings('models')");await sleep(500);
    const geometry=await evaluate(`Array.from(document.querySelectorAll('.model-chip')).map(row=>{const r=row.getBoundingClientRect();return {width:r.width,height:r.height,actions:Array.from(row.querySelector('.model-chip-actions').children).map(b=>{const q=b.getBoundingClientRect();return {x:q.x,right:q.right}})}})`);
    assert.ok(geometry.length>=2);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.model-enable-switch:checked'),'::before').backgroundColor`),'rgb(255, 255, 255)','Selected thumb remains white in both themes');
    for(const row of geometry) for(let i=1;i<row.actions.length;i++) assert.ok(row.actions[i].x>=row.actions[i-1].right-1,'model actions must not overlap');
    fs.writeFileSync(path.join(out,`pc-${theme}-settings.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate("window.closeSubWin()");await sleep(350);
    await evaluate("window.switchRightTab('browser')");
    await waitUntil("!!document.querySelector('webview[data-newmark-browser-runtime-key]')?._newmarkDomReady");
    await sleep(300);
    const blank=await evaluate(`document.querySelector('webview[data-newmark-browser-runtime-key]').executeJavaScript('({url:location.href,bg:getComputedStyle(document.documentElement).backgroundColor})')`);
    assert.equal(blank.url,'about:blank');
    assert.equal(blank.bg,theme==='dark'?'rgb(16, 16, 16)':'rgb(240, 242, 248)','Empty guest follows app theme');
    fs.writeFileSync(path.join(out,`pc-${theme}-browser.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    results.push({theme,...baseline,hover,geometry,blank});
    await evaluate("window.closeSubWin()");
  }
  fs.writeFileSync(path.join(out,'pc-consistency-results.json'),JSON.stringify(results,null,2));
  console.log('PASS: two themes, actual toolbar hover, settings action layout, selected thumbs and blank browser, six screenshots');
 } finally { ws?.close(); child.kill(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
