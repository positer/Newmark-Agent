// Actual Chromium paint regression: an optical shell must stay attached to
// its scrollport while option content scrolls. No production gesture mocks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PNG } = require('pngjs');
const crypto = require('node:crypto');
const { connect, targetAt } = require('./dev-uniform-popup-visuals.cjs');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const { testElectronEntry, isolateTestWindow } = require('./cdp-test-window-isolation.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const desktopRoot = path.resolve(__dirname, '..');
function difference(a, b) {
  let total = 0, changed = 0, max = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; c++) delta += Math.abs(a.data[i + c] - b.data[i + c]);
    total += delta; if (delta > 3) changed++; max = Math.max(max, delta);
  }
  return { meanChannelDelta: total / (a.width * a.height * 3), changedPixels: changed, maxPixelDelta: max };
}
async function main() {
  const diagnostic = process.argv.includes('--diagnostic');
  const argument = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
  const label = diagnostic ? 'scroll-before' : 'scroll-after';
  const output = path.resolve(argument('--output', path.resolve(desktopRoot, '../archive/20260905-182712-pc-uniform-frosted', label)));
  const expectedAlpha = argument('--expect-alpha', null);
  const baselinePath = argument('--baseline', null);
  const baseline = baselinePath ? JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8')) : null;
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-popup-scroll-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: { providers: [] }, general: { language: 'en' } }));
  const child = spawn(require('electron'), [testElectronEntry(desktopRoot, root, 49541), '--remote-debugging-port=49441', '--allow-multiple-instances', '--no-sandbox', '--root', root], { cwd: desktopRoot, windowsHide: true, stdio: 'ignore' });
  let cdp;
  const report = { diagnostic, sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(desktopRoot,'dist/ui/index.html'))).digest('hex'), themes: {}, failures: [] };
  try {
    cdp = connect(await targetAt(49441)); await cdp.ready; await waitForPromotedMainUi(cdp);
    await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    report.windowIsolation = await isolateTestWindow(child, 49541, connect);
    const evaluate = async expression => {
      const result = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await evaluate(`(() => {
      window.__scrollErrors=[];
      addEventListener('error',e=>__scrollErrors.push(String(e.error?.stack||e.message)));
      const mat=document.createElement('div'); mat.id='scroll-mat';
      mat.style.cssText='position:fixed;inset:0;background:#444;z-index:998;'; document.body.append(mat);
      const menu=document.createElement('div'); menu.id='scroll-probe';
      menu.className='model-select-menu liquid-glass liquid-glass-carrier liquid-glass-popup';
      menu.style.cssText='display:block;position:fixed;left:230px;top:180px;width:820px;height:430px;max-height:430px;z-index:999;';
      menu.innerHTML=Array.from({length:30},(_,i)=>'<button class="model-select-menu-option'+(!i?' selected':'')+'" style="height:42px;min-height:42px">Model '+i+'</button>').join('');
      document.body.append(menu); wireDirectLiquidMenuInteractionsV2(menu);
      const quiet=document.createElement('style'); quiet.textContent='#scroll-probe button {color:transparent!important;background:transparent!important;} #scroll-probe .liquid-menu-color-block {visibility:hidden;} #scroll-probe::-webkit-scrollbar {display:none;}';document.head.append(quiet);
      window.__scrollProbe=() => {
        const r=n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};};
        const c=menu.querySelector('.liquid-popup-optical-canvas'),s=getComputedStyle(menu,'::after');
        const style=getComputedStyle(menu), color=style.backgroundColor;
        const alpha=color.startsWith('rgba(')?Number(color.slice(color.lastIndexOf(',')+1,-1).trim()):1;
        return{scrollTop:menu.scrollTop,scrollHeight:menu.scrollHeight,menu:r(menu),canvas:c?r(c):null,canvasDisplay:c?getComputedStyle(c).display:null,edge:{position:s.position,top:s.top,bottom:s.bottom,content:s.content},background:style.backgroundImage,material:{color,alpha,backdrop:style.backdropFilter}};
      };
    })()`);
    for (const theme of ['dark', 'light']) {
      await evaluate(`window.setTheme('${theme}'); document.getElementById('scroll-probe').scrollTop=0;`); await sleep(400);
      const screenshots = [];
      const capture = async name => {
        const result = await cdp.call('Page.captureScreenshot', { format: 'png', clip: { x: 230, y: 180, width: 820, height: 430, scale: 1 }, fromSurface: true });
        const data = Buffer.from(result.data, 'base64'); fs.writeFileSync(path.join(output, theme + '-' + name + '.png'), data);
        return PNG.sync.read(data);
      };
      const uniform = await capture('flat');
      let minimum = [255,255,255], maximum = [0,0,0];
      for (let y=40;y<uniform.height-40;y++) for (let x=40;x<uniform.width-40;x++) for (let c=0;c<3;c++) {
        const value=uniform.data[(y*uniform.width+x)*4+c]; minimum[c]=Math.min(minimum[c],value); maximum[c]=Math.max(maximum[c],value);
      }
      // A visible touch spot exposes whether the optical pass scrolls with
      // options; the pointer is held stationary while a trusted wheel moves.
      await evaluate(`document.getElementById('scroll-probe').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'touch',clientX:880,clientY:480}))`); await sleep(100);
      screenshots.push(await capture('top'));
      const states = [await evaluate('__scrollProbe()')];
      for (const deltaY of [230, 360, 1200, -1200]) {
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 380, deltaX: 0, deltaY });
        await sleep(220); screenshots.push(await capture('wheel-' + screenshots.length)); states.push(await evaluate('__scrollProbe()'));
      }
      const diffs = screenshots.slice(1).map(frame=>difference(screenshots[0],frame));
      const touchDelta = difference(uniform,screenshots[0]);
      report.themes[theme] = { minimum, maximum, states, diffs, touchDelta };
      if(touchDelta.changedPixels<100) report.failures.push(theme + ': touch light is not visibly painted');
      if (!states.some(s=>s.scrollTop>100)) report.failures.push(theme + ': wheel did not scroll');
      if (diffs.some(d=>d.meanChannelDelta>.03 || d.changedPixels>25)) report.failures.push(theme + ': shell paint moves with scrolling');
      if (maximum.some((v,c)=>v-minimum[c]>1)) report.failures.push(theme + ': flat backdrop has a baked light plane');
      // A real background change must still pass through the frosted surface.
      await evaluate(`document.getElementById('scroll-mat').style.background='#999'`); await sleep(200);
      const changedBackdrop = await capture('changed-backdrop');
      const backdropDelta = difference(screenshots.at(-1),changedBackdrop); report.themes[theme].backdropDelta=backdropDelta;
      if(backdropDelta.meanChannelDelta<8) report.failures.push(theme + ': glass is opaque to its real backdrop');
      const material = states[0].material;
      if(expectedAlpha !== null && Math.abs(material.alpha-Number(expectedAlpha))>.002) report.failures.push(theme + ': popup alpha differs from the requested material');
      if(baseline){
        const before=baseline.themes[theme];
        if(material.alpha>=before.states[0].material.alpha) report.failures.push(theme + ': popup transparency did not increase');
        if(material.backdrop!==before.states[0].material.backdrop) report.failures.push(theme + ': backdrop blur changed with opacity');
        if(backdropDelta.meanChannelDelta<=before.backdropDelta.meanChannelDelta+.5) report.failures.push(theme + ': changed backdrop is not more visible through the popup');
      }
      await evaluate(`document.getElementById('scroll-mat').style.background='#444'; document.getElementById('scroll-probe').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',clientX:880,clientY:480}));`);
    }
    report.errors=await evaluate('__scrollErrors');
    if(report.errors.length) report.failures.push('renderer errors');
    report.ok=report.failures.length===0;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(!diagnostic&&!report.ok)process.exitCode=1;
  } finally {
    try { cdp?.socket.close(); } catch {}
    if(child.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000});
    for(let i=0;i<20;i++){try{fs.rmSync(root,{recursive:true,force:true});break;}catch{await sleep(250);}}
  }
}
main().catch(error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;});
