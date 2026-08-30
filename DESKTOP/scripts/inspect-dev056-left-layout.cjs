const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dev056-layout-'));
const port = 9476;
const installedElectron = process.env.NEWMARK_ELECTRON_EXE || '';
const electron = installedElectron || require('electron');
const launchArgs = [`--remote-debugging-port=${port}`, '--allow-multiple-instances', `--user-data-dir=${path.join(root, 'profile')}`, '--no-sandbox', '--root', root];
if (!installedElectron) launchArgs.unshift('.');
const child = spawn(electron, launchArgs, {
  cwd: installedElectron ? path.dirname(installedElectron) : path.resolve(__dirname, '..'), stdio: 'ignore', windowsHide: true,
});

function targets() {
  return new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/json`, res => {
    let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject));
}

(async () => {
  let pages = [];
  for (let i = 0; i < 80; i++) {
    try { pages = await targets(); if (pages.some(x => x.type === 'page')) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const page = pages.find(x => x.type === 'page' && !String(x.url || '').startsWith('devtools://'));
  if (!page) throw new Error('Electron page unavailable');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const callId = ++id;
      const listener = event => { const msg = JSON.parse(event.data); if (msg.id !== callId) return; ws.removeEventListener('message', listener); msg.error ? reject(msg.error) : resolve(msg.result); };
      ws.addEventListener('message', listener); ws.send(JSON.stringify({ id: callId, method, params }));
    });
  }
  await new Promise(r => setTimeout(r, 1800));
  const expression = `(() => {
    const rect = s => { const e=document.querySelector(s); if(!e)return null; const r=e.getBoundingClientRect(); const c=getComputedStyle(e); return {x:r.x,y:r.y,width:r.width,height:r.height,display:c.display,position:c.position,overflow:c.overflow,flex:c.flex}; };
    const left=document.querySelector('#left');
    return { viewport:{w:innerWidth,h:innerHeight}, left:{...rect('#left'),justify:getComputedStyle(left).justifyContent,children:[...left.children].map(e=>({id:e.id,cls:e.className,...rect('#'+e.id)}))}, content:rect('#left-content'), tools:rect('#left-tool-surface'), firstTool:rect('.left-nav-icon'), workspace:rect('#left-ws-section'), header:rect('#left-ws-header'), list:rect('#left-ws-list') };
  })()`;
  const result = await call('Runtime.evaluate', { expression, returnByValue: true });
  await call('Runtime.evaluate', { expression: `(() => {
    const items=[...document.querySelectorAll('#left-tool-surface .left-nav-icon')];
    if(items.length < 2) return false;
    items.forEach(x=>x.classList.remove('liquid-tool-active'));
    items[0].classList.add('liquid-tool-active');
    window.__liquidFlightSamples=[];
    const sample=()=>{ const f=document.querySelector('.liquid-selection-float:popover-open'); if(f){const r=f.getBoundingClientRect(); window.__liquidFlightSamples.push({t:performance.now(),x:r.x,y:r.y,w:r.width,h:r.height,opacity:getComputedStyle(f).opacity,renderer:f.dataset.kyantRenderer||'',textureReady:!!f._kyantTextureReady,cls:f.className});} if(window.__liquidFlightSamples.length<30) requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
    const a=items[0].getBoundingClientRect(), b=items[1].getBoundingClientRect();
    window.__liquidFlightExpected={source:{x:a.x-9,y:a.y-9,w:a.width+18,h:a.height+18},target:{x:b.x-9,y:b.y-9,w:b.width+18,h:b.height+18},press:{x:b.x+b.width/2,y:b.y+b.height/2}};
    return window.__liquidFlightExpected;
  })()`, returnByValue: true });
  const expectedResult = await call('Runtime.evaluate', { expression: 'window.__liquidFlightExpected', returnByValue: true });
  const press = expectedResult.result.value && expectedResult.result.value.press;
  if (press) {
    await call('Input.dispatchMouseEvent', { type:'mousePressed', x:press.x, y:press.y, button:'left', buttons:1, clickCount:1, pointerType:'mouse' });
    for (let i = 0; i < 30; i++) {
      const ready = await call('Runtime.evaluate', { expression: `(()=>{const f=document.querySelector('.liquid-selection-float:popover-open');return !!(f&&f._kyantTextureReady);})()`, returnByValue: true });
      if (ready.result.value) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const flightShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.resolve(__dirname, '..', '..', 'archive', '20260824-dev056-glass-flight.png'), Buffer.from(flightShot.data, 'base64'));
    await new Promise(r => setTimeout(r, 550));
    await call('Input.dispatchMouseEvent', { type:'mouseReleased', x:press.x, y:press.y, button:'left', buttons:0, clickCount:1, pointerType:'mouse' });
  }
  const flightResult = await call('Runtime.evaluate', { expression: '({expected:window.__liquidFlightExpected,samples:window.__liquidFlightSamples})', returnByValue: true });
  const glassResult = await call('Runtime.evaluate', { expression: `(() => {
    window.previewGlassOpacity(50);
    window.openSettings('general');
    const root=getComputedStyle(document.documentElement), carrier=getComputedStyle(document.getElementById('sub-win'));
    const result={carrierBlur:root.getPropertyValue('--carrier-glass-blur').trim(),carrierAlpha:root.getPropertyValue('--carrier-glass-alpha').trim(),floatAmount:root.getPropertyValue('--liquid-float-refraction-amount').trim(),floatChromatic:root.getPropertyValue('--liquid-float-chromatic-aberration').trim(),carrierFilter:carrier.backdropFilter||carrier.webkitBackdropFilter,carrierClass:document.getElementById('sub-win').className};
    window.previewGlassOpacity(85);
    return result;
  })()`, returnByValue: true });
  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const shotPath = path.resolve(__dirname, '..', '..', 'archive', '20260824-dev056-left-layout.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log(JSON.stringify({ layout: result.result.value, flight: flightResult.result.value, glass: glassResult.result.value, screenshot: shotPath }));
  ws.close(); child.kill();
})().catch(error => { console.error(error); child.kill(); process.exitCode = 1; });
