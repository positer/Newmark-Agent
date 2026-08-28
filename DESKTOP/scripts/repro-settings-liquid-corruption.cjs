const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-settings-liquid-'));
const port = 9487;
const packagedExecutable = process.env.NEWMARK_REPRO_EXE || '';
const electron = packagedExecutable || require('electron');
const runtimeArgs = [`--remote-debugging-port=${port}`, '--allow-multiple-instances', `--user-data-dir=${path.join(profile, 'profile')}`, '--no-sandbox', '--root', profile];
const child = spawn(electron, packagedExecutable ? runtimeArgs : ['.', ...runtimeArgs], {
  cwd: root,
  windowsHide: true,
  stdio: 'ignore',
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function targets() {
  return new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/json`, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject));
}

(async () => {
  let pages = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { pages = await targets(); if (pages.some(target => target.type === 'page')) break; } catch (_) {}
    await delay(200);
  }
  const page = pages.find(target => target.type === 'page' && String(target.url || '').startsWith('file:'));
  if (!page) throw new Error('Electron renderer unavailable');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const callId = ++id;
      const listener = event => {
        const message = JSON.parse(event.data);
        if (message.id !== callId) return;
        socket.removeEventListener('message', listener);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      };
      socket.addEventListener('message', listener);
      socket.send(JSON.stringify({ id: callId, method, params }));
    });
  }
  await delay(1500);
  const windowInfo = await call('Browser.getWindowForTarget', { targetId: page.id }).catch(() => null);
  if (windowInfo && windowInfo.windowId) {
    await call('Browser.setWindowBounds', { windowId: windowInfo.windowId, bounds: { width: 2180, height: 1322, windowState: 'normal' } }).catch(() => {});
  }
  await call('Runtime.evaluate', { expression: 'window.setTheme("light")' });
  await delay(500);
  await call('Runtime.evaluate', { expression: `(() => {
    const float=document.createElement('div');
    float.className='liquid-selection-float liquid-selection-primed';
    float.style.cssText='left:160px;top:240px;width:1708px;height:760px';
    float._liquidTargetRect={left:160,top:240,width:1708,height:760};
    mountLiquidViewportFloat(float); showLiquidViewportFloat(float);
    float.classList.remove('liquid-selection-primed'); beginLiquidSelectionLift(float);
    if(float._renderKyantGlass) float._renderKyantGlass(null,true);
    window.__settingsReproWarmFloat=float;
  })()` });
  await delay(250);
  await call('Runtime.evaluate', { expression: `(() => { const float=window.__settingsReproWarmFloat; if(!float)return; if(float._releaseKyantGlass)float._releaseKyantGlass(); float.remove(); delete window.__settingsReproWarmFloat; })()` });
  await delay(100);
  await call('Runtime.evaluate', { expression: 'window.openSettings("general")' });
  await delay(700);
  // Exercise the real stale-cache path: dragging after this point must invoke
  // capturePage while the backdrop-filtered settings window is already open.
  await delay(5200);
  async function readTabs() {
    const result = await call('Runtime.evaluate', {
      expression: `(() => [...document.querySelectorAll('.settings-tabs:not(.plugin-tabs) .stab-btn')].map(button => { const rect=button.getBoundingClientRect(); return {x:rect.x,y:rect.y,w:rect.width,h:rect.height,text:button.textContent}; }))()`,
      returnByValue: true,
    });
    return result.result.value;
  }
  const rows = await readTabs();
  if (!rows || rows.length < 3) throw new Error('settings tabs unavailable');
  for (let pass = 0; pass < 5; pass += 1) {
    const currentRows = await readTabs();
    const first = currentRows[0];
    const last = currentRows[currentRows.length - 1];
    const y = first.y + first.h / 2;
    const from = pass % 2 === 0 ? first : last;
    const to = pass % 2 === 0 ? last : first;
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x + from.w / 2, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    for (let step = 1; step <= 12; step += 1) {
      const x = from.x + from.w / 2 + (to.x + to.w / 2 - from.x - from.w / 2) * step / 12;
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'mouse' });
      await delay(25);
    }
    if (pass < 4) {
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x + to.w / 2, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
      await delay(300);
    }
  }
  await delay(160);
  async function snapshot(label) {
    const state = await call('Runtime.evaluate', {
      expression: `(() => {
        const float=document.querySelector('.liquid-selection-float:popover-open');
        const canvas=float&&float.querySelector('.liquid-selection-canvas');
        const fr=float&&float.getBoundingClientRect();
        const dialog=document.getElementById('sub-win').getBoundingClientRect();
        const body=document.getElementById('sub-win-body').getBoundingClientRect();
        return {url:location.href,float:fr&&{x:fr.x,y:fr.y,w:fr.width,h:fr.height,style:float.getAttribute('style'),cls:float.className,renderer:float.dataset.kyantRenderer},canvas:canvas&&{cssW:getComputedStyle(canvas).width,cssH:getComputedStyle(canvas).height,w:canvas.width,h:canvas.height},dialog:{x:dialog.x,y:dialog.y,w:dialog.width,h:dialog.height},body:{x:body.x,y:body.y,w:body.width,h:body.height},popoverCount:document.querySelectorAll('.liquid-selection-float:popover-open').length,allFloats:[...document.querySelectorAll('.liquid-selection-float')].map(x=>({connected:x.isConnected,cls:x.className,style:x.getAttribute('style')}))};
      })()`, returnByValue: true,
    });
    const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const output = path.resolve(root, '..', 'archive', `20260828-settings-liquid-${label}.png`);
    fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
    return { state: state.result.value, screenshot: output };
  }
  const held = await snapshot('held');
  const releaseRows = await readTabs();
  const releaseTarget = releaseRows[releaseRows.length - 1];
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: releaseTarget.x + releaseTarget.w / 2, y: releaseTarget.y + releaseTarget.h / 2, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await delay(500);
  const released = await snapshot('released');
  console.log(JSON.stringify({ tabs: rows, held, released }, null, 2));
  socket.close();
  child.kill();
})().catch(error => {
  console.error(error);
  child.kill();
  process.exitCode = 1;
});
