const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(desktopRoot, 'dist/ui/index.html'))).digest('hex');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-gesture-regression-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: { providers: [] }, general: { language: 'en' }, workspace: { auto_create_timestamp_workspace: true } }));
  const port = Number(process.env.NEWMARK_GESTURE_PORT || 49437);
  const child = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    cdp = connect(await targetAt(port));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const evaluate = async expression => {
      const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    let mouseHeld = false;
    const mouse = (type, x, y) => {
      if (type === 'mousePressed') mouseHeld = true;
      if (type === 'mouseReleased') mouseHeld = false;
      return cdp.call('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: mouseHeld ? 1 : 0, clickCount: 1 });
    };
    await evaluate(`(() => {
      window.__gestureErrors = [];
      window.__pointerEvents = [];
      ['pointerdown','pointerup','pointercancel'].forEach(type => addEventListener(type, event => __pointerEvents.push({type, id:event.pointerId, target:event.target.className, x:event.clientX,y:event.clientY}), true));
      addEventListener('error', event => __gestureErrors.push(String(event.error?.stack || event.message)));
      window.__fixture = function(horizontal = false) {
        document.getElementById('gesture-fixture')?.remove();
        const menu = document.createElement('div');
        menu.id = 'gesture-fixture';
        menu.className = 'model-select-menu newmark-select-menu liquid-glass liquid-glass-carrier liquid-glass-popup';
        menu.style.cssText = 'position:fixed;display:block;left:380px;top:200px;width:280px;height:auto;margin:0;z-index:20000;max-height:none;';
        menu.innerHTML = [0,1,2,3].map(i => '<button class="model-select-menu-option newmark-select-option' + (i === 0 ? ' selected' : '') + '" style="height:48px;width:100%;" data-fixture-index="' + i + '">Option ' + i + '</button>').join('');
        if (horizontal) { menu.style.display='flex'; menu.style.width='500px'; menu.querySelectorAll('button').forEach(button => button.style.width='25%'); }
        document.body.append(menu); wireDirectLiquidMenuInteractionsV2(menu);
        window.__commits = [];
        menu.addEventListener('click', event => {
          const option = event.target.closest('button'); if (!option) return;
          __commits.push({ index: Number(option.dataset.fixtureIndex), time: performance.now() });
          menu.querySelectorAll('button').forEach(button => button.classList.toggle('selected', button === option));
          wireDirectLiquidMenuInteractionsV2(menu);
        });
        return [...menu.querySelectorAll('button')].map(option => { const r = option.getBoundingClientRect(); return { x:r.x + r.width/2, y:r.y+r.height/2 }; });
      };
      window.__sample = function() {
        const menu = document.getElementById('gesture-fixture'), block = menu._liquidColorBlock;
        const r = node => { const v = node.getBoundingClientRect(); return { x:v.x, y:v.y, width:v.width, height:v.height }; };
        const canvas = menu._liquidPopupOpticalCanvas;
        const feedback = menu._liquidPopupFeedback;
        const outset = feedback ? parseFloat(getComputedStyle(feedback.surface).getPropertyValue('--liquid-popup-outset')) || 0 : 0;
        const pullSides = Object.fromEntries(['left','right','top','bottom'].map(side => [side, feedback ? parseFloat(getComputedStyle(feedback.surface).getPropertyValue('--liquid-popup-pull-' + side)) || 0 : 0]));
        let alpha = 0; if (canvas) { const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data; for (let i=3;i<pixels.length;i+=4) alpha += pixels[i]; }
        return { visibility:document.visibilityState, pending:menu.dataset.liquidPendingCommit, outset, pullSides, edgeX:parseFloat(getComputedStyle(menu).getPropertyValue('--liquid-popup-edge-x')) || 0, edgeY:parseFloat(getComputedStyle(menu).getPropertyValue('--liquid-popup-edge-y')) || 0, menu:r(menu), option:r(menu.children[menu.children.length - 2] || menu), options:[...menu.querySelectorAll('button')].map(r), block:r(block), left:parseFloat(getComputedStyle(block).left), top:parseFloat(getComputedStyle(block).top), lifted:block.classList.contains('liquid-block-lifted'), scale:getComputedStyle(menu).scale, blockAfterOpacity:getComputedStyle(block,'::after').opacity, blockBackground:getComputedStyle(block).backgroundImage, canvasAlpha:alpha, commits:__commits.slice(), time:performance.now() };
      };
      window.__recordFrames = function() {
        window.__frameSamples = [];
        const until = performance.now() + 700;
        function sample() {
          const menu = document.getElementById('gesture-fixture');
          const block = menu._liquidColorBlock;
          __frameSamples.push({ top:parseFloat(getComputedStyle(block).top), time:performance.now(), commits:__commits.length });
          if (performance.now() < until) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      };
    })()`);
    const evidence = {}, failures = [];
    const check = (ok, message) => { if (!ok) failures.push(message); };
    let points = await evaluate('__fixture()'); await sleep(350);
    const baseline = await evaluate('__sample()');
    await mouse('mouseMoved', points[2].x, points[2].y); await mouse('mousePressed', points[2].x, points[2].y);
    await sleep(50); await evaluate('__recordFrames()'); await mouse('mouseReleased', points[2].x, points[2].y);
    const tap = [];
    for (let i=0;i<18;i++) { tap.push(await evaluate('__sample()')); await sleep(20); }
    evidence.tap = tap;
    evidence.tapFrames = await evaluate('__frameSamples');
    check(evidence.tapFrames.some(s => s.top > baseline.top + .05 && s.top < baseline.top + 95.95), 'tap has intermediate source-to-target positions');
    check(tap.at(-1).commits.length === 1 && tap.at(-1).commits[0].index === 2, 'tap commits target exactly once after travel');
    check(tap.every(s => Math.abs(s.options[0].width - baseline.options[0].width) < .1 && Math.abs(s.options[0].y - baseline.options[0].y) < .1), 'tap keeps text-bearing option geometry fixed');
    points = await evaluate('__fixture()'); await sleep(350);
    await mouse('mouseMoved', points[2].x, points[2].y); await mouse('mousePressed', points[2].x, points[2].y);
    await sleep(380); const pickup = await evaluate('__sample()'); await sleep(260);
    const held = await evaluate('__sample()');
    await mouse('mouseMoved', points[2].x + 90, points[2].y + 18); await sleep(150);
    const inTrack = await evaluate('__sample()');
    await mouse('mouseMoved', points[2].x + 90, points[3].y + 120); await sleep(150);
    const boundary = await evaluate('__sample()');
    await mouse('mouseReleased', points[2].x + 90, points[3].y + 120); await sleep(450);
    evidence.hold = { pickup, held, inTrack, boundary, landed:await evaluate('__sample()') };
    check(pickup.top > baseline.top && held.top >= baseline.top + 95, 'hold flies from selected source to pressed row');
    check(Math.abs(inTrack.block.x - held.block.x) < .1 && inTrack.scale === '1' && inTrack.edgeX === 0 && inTrack.edgeY === 0 && inTrack.outset === 0, 'in-track drag cannot deform or translate popup/cross-axis');
    check(boundary.edgeX === 0 && boundary.edgeY === 0 && boundary.outset > 2.5 && boundary.outset <= 4, 'endpoint expands only its frosted material within 4px and never clips inward');
    check(boundary.pullSides.bottom === 1 && boundary.pullSides.top === 0 && boundary.pullSides.left === 0 && boundary.pullSides.right === 0, 'vertical lower endpoint extends its lower edge only and leaves opposite/cross-axis contours fixed');
    check(boundary.options.every((r,i) => Math.abs(r.width-baseline.options[i].width)<.1 && Math.abs(r.y-baseline.options[i].y)<.1), 'boundary response keeps text geometry fixed');
    check(held.canvasAlpha === 0 && (Number(held.blockAfterOpacity) === 0 || held.blockBackground.indexOf('radial-gradient') < 0), 'mouse interaction has no popup or block radial bloom');
    // Release during pickup, then immediately start a new gesture after commit.
    points = await evaluate('__fixture()'); await sleep(350);
    await mouse('mousePressed', points[3].x, points[3].y); await sleep(315);
    await mouse('mouseReleased', points[3].x, points[3].y);
    const interrupted = [];
    for (let i=0;i<22;i++) { interrupted.push(await evaluate('__sample()')); await sleep(20); }
    evidence.interrupted = interrupted;
    check(interrupted.at(-1).commits.length === 1 && interrupted.at(-1).commits[0].index === 3, 'release during pickup commits once at destination');
    // Touch must still draw inside the same glass surface.
    await evaluate(`(() => { const menu=document.getElementById('gesture-fixture'); menu.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'touch',clientX:400,clientY:220})); })()`); await sleep(90);
    evidence.touch = await evaluate('__sample()');
    check(evidence.touch.canvasAlpha > 0, 'touch interaction still paints its internal glass bloom');
    points = await evaluate('__fixture(true)'); await sleep(350);
    const horizontalSource = await evaluate('__sample()');
    await mouse('mousePressed', points[2].x, points[2].y); await sleep(650);
    const horizontalHeld = await evaluate('__sample()');
    await mouse('mouseMoved', points[2].x + 20, points[2].y + 70); await sleep(150);
    const horizontalTrack = await evaluate('__sample()');
    await mouse('mouseMoved', points[3].x + 180, points[2].y + 70); await sleep(150);
    const horizontalEnd = await evaluate('__sample()');
    await mouse('mouseReleased', points[3].x + 180, points[2].y + 70); await sleep(450);
    evidence.horizontal = { source:horizontalSource, held:horizontalHeld, track:horizontalTrack, end:horizontalEnd, landed:await evaluate('__sample()') };
    check(horizontalHeld.left > horizontalSource.left + 200, 'horizontal hold flies from selected source to pressed option');
    check(horizontalTrack.left > horizontalHeld.left && horizontalTrack.top === horizontalHeld.top && horizontalTrack.edgeX === 0 && horizontalTrack.edgeY === 0 && horizontalTrack.outset === 0, 'horizontal movement follows its track with no cross-axis shift or elastic response');
    check(horizontalEnd.block.x + horizontalEnd.block.width <= horizontalSource.options[3].x + horizontalSource.options[3].width + .1 && horizontalEnd.edgeX === 0 && horizontalEnd.edgeY === 0 && horizontalEnd.outset > 2.5 && horizontalEnd.outset <= 4, 'horizontal endpoint clamps the block and expands its material within 4px');
    check(horizontalEnd.pullSides.right === 1 && horizontalEnd.pullSides.left === 0 && horizontalEnd.pullSides.top === 0 && horizontalEnd.pullSides.bottom === 0, 'horizontal right endpoint extends its right edge only and leaves opposite/cross-axis contours fixed');
    evidence.wideFloat = await evaluate(`(async () => {
      const float = document.createElement('div');
      float.className='liquid-selection-float visible';
      float.style.cssText='position:fixed;left:100px;top:550px;width:800px;height:180px;--liquid-lift-scale:1;';
      document.body.append(float); startLiquidMotionTracking(float);
      let maxEdge=0, maxScale=1;
      for (let i=0;i<38;i++) {
        float.style.left=(100+(i<19?i:38-i)*12)+'px';
        await new Promise(requestAnimationFrame);
        const rect=float.getBoundingClientRect();
        maxEdge=Math.max(maxEdge,Math.abs(rect.width-float.offsetWidth)*.5,Math.abs(rect.height-float.offsetHeight)*.5);
        maxScale=Math.max(maxScale,parseFloat(float.style.getPropertyValue('--liquid-motion-stretch')) || 1);
      }
      stopLiquidMotionTracking(float); float.remove();
      return {maxEdge,maxScale};
    })()`);
    check(evidence.wideFloat.maxScale > 1.001 && evidence.wideFloat.maxEdge > 2.5 && evidence.wideFloat.maxEdge <= 4.01, 'wide floating glass visibly responds while actual deformation remains bounded to 4px');
    evidence.errors = await evaluate('__gestureErrors'); evidence.pointerEvents = await evaluate('__pointerEvents');
    check(evidence.errors.length === 0, 'renderer produces no uncaught errors');
    const output = { ok: failures.length === 0, sourceSha256, failures, evidence };
    if (process.env.NEWMARK_GESTURE_REPORT) fs.writeFileSync(process.env.NEWMARK_GESTURE_REPORT, JSON.stringify(output,null,2));
    process.stdout.write(JSON.stringify({ ok:output.ok, failures, tapFrames:evidence.tapFrames, tap:tap.map(s=>({top:s.top, y:s.block.y, commits:s.commits.length})), hold:evidence.hold, horizontal:evidence.horizontal, wideFloat:evidence.wideFloat, touchAlpha:evidence.touch.canvasAlpha, errors:evidence.errors, pointerEvents:evidence.pointerEvents },null,2)+'\n');
    if (failures.length) process.exitCode = 1;
  } finally {
    try { cdp?.socket.close(); } catch {}
    if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide:true, timeout:15000 });
    for (let i=0;i<20;i++) { try { fs.rmSync(root,{recursive:true,force:true}); break; } catch { await sleep(250); } }
  }
}
main().catch(error => { process.stderr.write(String(error.stack || error)+'\n'); process.exitCode = 1; });
