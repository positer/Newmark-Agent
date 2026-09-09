const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const desktopRoot = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function targetAt(port) {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/list`, response => {
          let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve(body));
        }).on('error', reject);
      });
      const target = JSON.parse(body).find(item => item.type === 'page' && item.url.includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  throw new Error('Electron main UI not available');
}
function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map(); let id = 0;
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  return { socket, ready, call(method, params = {}, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timeout')); }, timeout);
      pending.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params }));
    });
  } };
}
async function main() {
  const crypto = require('node:crypto');
  const args = process.argv.slice(2);
  const argument = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const label = argument('--label', 'after');
  const output = path.resolve(argument('--output', path.join(desktopRoot, '..', 'archive', '20260905-182710-uniform-popup-visuals', label)));
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-uniform-popup-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: { providers: [{ id:'visual-provider', name:'Visual Models', base_url:'http://127.0.0.1:9/v1', api_key:'', protocol:'openai', enabled:true,
      models: ['Alpha','Beta','Gamma','Delta'].map(name => ({ name:'visual-'+name.toLowerCase(), display:name+' model', max_tokens:4096, enabled:true })) }],
      default_model:'visual-alpha', default_intelligence:'medium', agent_engine:'builtin', auto_switch:false },
    general:{language:'en'}, agent:{default_mode:'build'}, remote:{touch_enabled:false}, workspace:{auto_create_timestamp_workspace:true,prompt_mode:'both'}
  }));
  const report = {label, sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(desktopRoot,'dist/ui/index.html'))).digest('hex'), surfaces:{}, frames:{}, errors:[], failures:[]};
  const port = Number(argument('--port', 49439));
  const child = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`, '--allow-multiple-instances','--no-sandbox','--root',root], {cwd:desktopRoot,stdio:'ignore',windowsHide:true});
  let cdp;
  try {
    cdp=connect(await targetAt(port));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await cdp.call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    const evaluate=async expression => {
      const result=await cdp.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
      return result.result.value;
    };
    await evaluate(`(() => {
      window.__visualErrors=[];
      addEventListener('error',e=>__visualErrors.push(String(e.error?.stack||e.message)));
      addEventListener('unhandledrejection',e=>__visualErrors.push(String(e.reason?.stack||e.reason)));
      window.__probeSurface=function(selector) {
        const surface=document.querySelector(selector); if(!surface) throw new Error('Missing '+selector);
        const r=node=>{const x=node.getBoundingClientRect();return {x:x.x,y:x.y,width:x.width,height:x.height};};
        const material=(node,pseudo)=>{const s=getComputedStyle(node,pseudo);return {background:s.backgroundColor,image:s.backgroundImage,backdrop:s.backdropFilter,shadow:s.boxShadow,border:s.border,opacity:s.opacity,transform:s.transform,transition:s.transition};};
        const options=[...surface.querySelectorAll('button,select,input,label,h1,h2,h3,.setting-label,.sub-win-title,.command-option')].filter(node=>node.getClientRects().length && getComputedStyle(node).visibility!=='hidden').map(node=>({tag:node.tagName,id:node.id,className:node.className,text:node.textContent.trim(),rect:r(node),font:getComputedStyle(node).font}));
        const block=surface._liquidColorBlock;
        return {rect:r(surface),text:surface.textContent.trim(),material:material(surface),before:material(surface,'::before'),after:material(surface,'::after'),options,block:block?{rect:r(block),material:material(block),after:material(block,'::after'),lifted:block.classList.contains('liquid-block-lifted')}:null};
      };
      window.__recordVisualFrames=function(){
        __visualFrames=[];const until=performance.now()+2200;
        function frame(){const m=document.querySelector('#model-select-menu'),b=m&&m._liquidColorBlock;if(b&&b.isConnected){const r=b.getBoundingClientRect(),s=getComputedStyle(b);__visualFrames.push({time:performance.now(),x:r.x,y:r.y,width:r.width,height:r.height,opacity:s.opacity,background:s.backgroundColor,image:s.backgroundImage,backdrop:s.backdropFilter,lifted:b.classList.contains('liquid-block-lifted')});} if(performance.now()<until)requestAnimationFrame(frame);}
        requestAnimationFrame(frame);
      };
    })()`);
    report.gestureSources=await evaluate(`({menu:wireDirectLiquidMenuInteractionsV2.toString(),rail:wireLiquidRailInteractions.toString(),arrival:waitForLiquidSelectionArrival.toString(),landing:landLiquidSelectionFloat.toString()})`);
    for(const key of Object.keys(report.gestureSources)) report.gestureSources[key]=crypto.createHash('sha256').update(report.gestureSources[key]).digest('hex');
    const screenshot=async (name,selector)=>{
      report.surfaces[name]=await evaluate(`__probeSurface(${JSON.stringify(selector)})`);
      const result=await cdp.call('Page.captureScreenshot',{format:'png',fromSurface:true});
      fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));
      process.stdout.write('Captured '+name+'\n');
    };
    let held=false;
    const mouse=async(type,p)=>{if(type==='mousePressed')held=true;if(type==='mouseReleased')held=false;await cdp.call('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:type==='mouseMoved'?'none':'left',buttons:held?1:0,clickCount:1});};
    for(const theme of ['dark','light']){
      await evaluate(`window.setTheme(${JSON.stringify(theme)}); window.openSettings('general');`);
      // The first settings open loads IPC-backed content. A fixed delay can
      // capture only its navigation shell and incorrectly compare its layout.
      let settingsReady = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        settingsReady = await evaluate(`Boolean(document.querySelector('#sub-win-overlay.open') && document.querySelector('#sub-win #stab-general .setting-row'))`);
        if (settingsReady) break;
        await sleep(50);
      }
      if (!settingsReady) throw new Error('General settings content did not become ready');
      await sleep(250);
      await screenshot(theme+'-settings','#sub-win');
      await evaluate('window.closeSubWin()'); await sleep(300);
      await evaluate("window.openCommandSurface('palette')"); await sleep(400);
      await screenshot(theme+'-commands','#command-surface');
      await evaluate('window.closeCommandSurface()'); await sleep(300);
      await evaluate('window.toggleModelSelectMenu(true)'); await sleep(400);
      await screenshot(theme+'-menu-idle','#model-select-menu');
      const points=await evaluate(`(()=>{const m=document.querySelector('#model-select-menu');return [...m.querySelectorAll('button.model-select-menu-option')].filter(n=>!n.disabled).map(n=>{const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,selected:n.classList.contains('selected')};});})()`);
      if(points.length<3) throw new Error('Real model menu has fewer than 3 enabled choices');
      const selected=points.findIndex(p=>p.selected), destination=selected===points.length-1?0:points.length-1;
      const start=points[destination];
      await evaluate('__recordVisualFrames()');
      await mouse('mouseMoved',start); await mouse('mousePressed',start); await sleep(310);
      await screenshot(theme+'-menu-pickup','#model-select-menu');
      await sleep(35); await screenshot(theme+'-menu-mid-move','#model-select-menu');
      await sleep(240);
      const drag={x:start.x+30,y:Math.max(points[0].y,Math.min(points.at(-1).y,start.y+(destination===0?18:-18)))};
      await mouse('mouseMoved',drag); await sleep(50);
      await screenshot(theme+'-menu-drag','#model-select-menu');
      await mouse('mouseReleased',drag); await sleep(45);
      await screenshot(theme+'-menu-landing','#model-select-menu');
      await sleep(800);
      report.frames[theme]=await evaluate('__visualFrames');
      await evaluate('window.closeModelSelectMenu()'); await sleep(250);
    }
    report.errors=await evaluate('__visualErrors');
    if(report.errors.length)report.failures.push('Unexpected renderer exceptions');
    const baselineFile=argument('--baseline','');
    if(baselineFile){
      const baseline=JSON.parse(fs.readFileSync(path.resolve(baselineFile),'utf8'));
      for(const key of Object.keys(report.gestureSources))if(report.gestureSources[key]!==baseline.gestureSources[key])report.failures.push('Gesture implementation changed: '+key);
      for(const name of Object.keys(report.surfaces)){
        const a=baseline.surfaces[name],b=report.surfaces[name];
        const staticStage=/-settings$|-commands$|-menu-idle$/.test(name);
        if(staticStage){
          if(a.text!==b.text)report.failures.push('Surface text changed: '+name);
          for(const key of ['x','y','width','height'])if(Math.abs(a.rect[key]-b.rect[key])>.1)report.failures.push('Surface geometry changed: '+name+' '+key);
        }
        if(a.options.length!==b.options.length)report.failures.push('Content structure changed: '+name);
        a.options.forEach((before,index)=>{const after=b.options[index];if(!after)return;if(before.text!==after.text||before.font!==after.font)report.failures.push('Text/font changed: '+name+' '+index);for(const key of ['x','y','width','height'])if(Math.abs(before.rect[key]-after.rect[key])>.1)report.failures.push('Text geometry changed: '+name+' '+index+' '+key);});
        if(name.includes('-menu-')&&b.block&& (b.block.material.image!=='none'||b.block.material.backdrop!=='none'))report.failures.push('Moving block still uses glass rendering: '+name);
      }
    }
    report.ok=report.failures.length===0;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    process.stdout.write(JSON.stringify({ok:report.ok,output,screenshots:Object.keys(report.surfaces).length,failures:report.failures,errors:report.errors})+'\n');
    if(!report.ok)process.exitCode=1;
  }finally{
    try{cdp?.socket.close();}catch{}
    if(child.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000});
    for(let i=0;i<20;i++){try{fs.rmSync(root,{recursive:true,force:true});break;}catch{await sleep(250);}}
  }
}
module.exports = { connect, targetAt };
if (require.main === module) main().catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});
