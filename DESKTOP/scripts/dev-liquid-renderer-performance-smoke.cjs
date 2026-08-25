const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const desktopRoot = path.resolve(__dirname, '..');
const electronExe = require('electron');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function removeRootWhenReleased(root) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || attempt === 19) throw error;
      await sleep(250);
    }
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2_000, () => request.destroy(new Error('HTTP timeout')));
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl
        && (item.type === 'page' || item.type === 'webview')
        && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  throw new Error('timed out waiting for Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 20_000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
  return { socket, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function mouseEvent(cdp, type, point, button = 'none') {
  await cdp.call('Input.dispatchMouseEvent', {
    type,
    x: point.x,
    y: point.y,
    button,
    clickCount: button === 'left' ? 1 : 0,
  });
}

async function clickAndHold(cdp, selector) {
  let point = await evaluate(cdp, `(() => {
    const item = document.querySelector(${JSON.stringify(selector)});
    if (!item) throw new Error('missing liquid target: ' + ${JSON.stringify(selector)});
    const rect = item.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await mouseEvent(cdp, 'mouseMoved', point);
  const primeDeadline = Date.now() + 2_000;
  while (Date.now() < primeDeadline) {
    if (await evaluate(cdp, 'window.__liquidBackdropPrimeReady === true')) break;
    await sleep(20);
  }
  point = await evaluate(cdp, `(() => {
    const item = document.querySelector(${JSON.stringify(selector)});
    if (!item) throw new Error('missing liquid target after prewarm');
    const rect = item.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await mouseEvent(cdp, 'mouseMoved', point);
  const startedAt = Date.now();
  await mouseEvent(cdp, 'mousePressed', point, 'left');
  let held = null;
  const readyDeadline = Date.now() + 4_000;
  while (Date.now() < readyDeadline) {
    held = await evaluate(cdp, `(() => {
      const float = document.querySelector('.liquid-selection-float');
      const canvas = float && float.querySelector('canvas.liquid-selection-canvas');
      const target = document.querySelector(${JSON.stringify(selector)});
      return {
        renderer: float && float.dataset.kyantRenderer,
        textureReady: !!(float && float._kyantTextureReady),
        drawReady: !!(float && float._kyantDrawReady),
        width: canvas && canvas.width,
        height: canvas && canvas.height,
        floatCount: document.querySelectorAll('.liquid-selection-float').length,
        locked: !!(window.liquidSidebarGesturesLocked && window.liquidSidebarGesturesLocked()),
        wired: target && target.parentElement && target.parentElement.dataset.liquidRailInteractions,
        targetRect: target && target.getBoundingClientRect().toJSON(),
        hit: document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)})?.outerHTML?.slice(0, 180)
        , errors: window.__liquidErrors
        , renderFrame: float && float._kyantRendererRef && float._kyantRendererRef.renderFrame
        , pendingGeometry: float && float._kyantRendererRef && float._kyantRendererRef.pendingGeometry
        , lastGeometry: float && float._kyantRendererRef && float._kyantRendererRef.lastGeometry
        , visibility: document.visibilityState
        , perfCounts: window.__liquidPerfCounts
      };
    })()`);
    if (held.textureReady && held.drawReady && held.width > 0 && held.height > 0) break;
    await sleep(8);
  }
  held.readyMs = Date.now() - startedAt;
  held.pixelStats = await evaluate(cdp, `(() => {
    const float = document.querySelector('.liquid-selection-float');
    const renderer = float && float._kyantRendererRef;
    if (!renderer || !renderer.canvas.width || !renderer.canvas.height) return null;
    const gl = renderer.gl;
    const pixels = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4);
    gl.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let samples = 0, black = 0, alpha = 0, rgb = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      const a = pixels[index + 3];
      const brightness = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      samples += 1; alpha += a; rgb += brightness;
      if (a > 8 && brightness < 12) black += 1;
    }
    const display = renderer.displayContext?.getImageData(0, 0, renderer.displayCanvas.width, renderer.displayCanvas.height).data;
    let displaySamples = 0, displayBlack = 0, displayAlpha = 0, displayRgb = 0;
    if (display) for (let index = 0; index < display.length; index += 16) {
      const a = display[index + 3];
      const brightness = (display[index] + display[index + 1] + display[index + 2]) / 3;
      displaySamples += 1; displayAlpha += a; displayRgb += brightness;
      if (a > 8 && brightness < 12) displayBlack += 1;
    }
    return { samples, blackRatio: black / samples, averageAlpha: alpha / samples, averageRgb: rgb / samples,
      display: { samples: displaySamples, blackRatio: displayBlack / displaySamples,
        averageAlpha: displayAlpha / displaySamples, averageRgb: displayRgb / displaySamples } };
  })()`);
  const screenshotTag = selector.includes('nth-of-type(1)') ? 'first' : 'second';
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(desktopRoot, `liquid-smoke-${screenshotTag}-composited.png`), Buffer.from(screenshot.data, 'base64'));
  held.computedStyles = await evaluate(cdp, `(() => {
    const float = document.querySelector('.liquid-selection-float');
    const canvas = float && float.querySelector('canvas');
    const pick = node => {
      if (!node) return null;
      const style = getComputedStyle(node);
      return { background: style.background, backgroundColor: style.backgroundColor, opacity: style.opacity,
        display: style.display, boxShadow: style.boxShadow, filter: style.filter, backdropFilter: style.backdropFilter,
        zIndex: style.zIndex, isolation: style.isolation, mixBlendMode: style.mixBlendMode };
    };
    return { float: pick(float), canvas: pick(canvas) };
  })()`);
  await mouseEvent(cdp, 'mouseReleased', point, 'left');
  await sleep(700);
  if (held.renderer !== 'webgl2' || !held.textureReady || !held.drawReady || !(held.width > 0) || !(held.height > 0)) {
    throw new Error(`liquid float did not render a fresh WebGL texture: ${JSON.stringify(held)}`);
  }
  return held;
}

async function clickForLatency(cdp, selector) {
  const point = await evaluate(cdp, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) throw new Error('missing liquid latency target');
    const rect = target.getBoundingClientRect();
    window.__liquidClickTiming = { pointerUpAt: null, commandAt: null };
    target.parentElement.addEventListener('pointerup', () => {
      window.__liquidClickTiming.pointerUpAt = performance.now();
    }, { capture: true, once: true });
    target.parentElement.addEventListener('click', () => {
      if (window.__liquidClickTiming.commandAt === null) {
        window.__liquidClickTiming.commandAt = performance.now();
      }
    }, { capture: false, once: true });
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await mouseEvent(cdp, 'mousePressed', point, 'left');
  const mountDeadline = Date.now() + 1_000;
  while (Date.now() < mountDeadline) {
    const mounted = await evaluate(cdp, "document.querySelectorAll('.liquid-selection-float').length === 1");
    if (mounted) break;
    await sleep(10);
  }
  await mouseEvent(cdp, 'mouseReleased', point, 'left');
  await sleep(900);
  const timing = await evaluate(cdp, 'window.__liquidClickTiming');
  if (!Number.isFinite(timing?.pointerUpAt) || !Number.isFinite(timing?.commandAt)) {
    throw new Error(`missing pointerup/command timing: ${JSON.stringify(timing)}`);
  }
  return timing.commandAt - timing.pointerUpAt;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-liquid-renderer-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: { providers: [], default_model: '', default_intelligence: 'low' },
    general: { language: 'en' },
    workspace: { prompt_mode: 'global_only', auto_create_timestamp_workspace: true },
  }), 'utf8');
  const port = Number(process.env.NEWMARK_LIQUID_PERF_PORT || '49436');
  let child;
  let cdp;
  try {
    child = spawn(electronExe, ['.', `--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root], {
      cwd: desktopRoot, stdio: 'ignore', windowsHide: true,
    });
    cdp = connectCdp(await waitForTarget(port));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    await evaluate(cdp, 'window.resizeTo(1280, 900)');
    await sleep(300);
    await evaluate(cdp, `(() => {
      const counts = window.__liquidPerfCounts = { contexts:0, shaderCompiles:0, programLinks:0, textureUploads:0, uniformLookups:0, uniformUpdates:0, draws:0, bufferUploads:0 };
      window.__liquidErrors = [];
      window.addEventListener('error', event => window.__liquidErrors.push(String(event.error?.stack || event.message || event.error)));
      window.__liquidMaxMotionAmount = 0;
      new MutationObserver(records => {
        for (const record of records) {
          const amount = Number(record.target?.dataset?.liquidMotionAmount || 0);
          if (amount > window.__liquidMaxMotionAmount) window.__liquidMaxMotionAmount = amount;
        }
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-liquid-motion-amount'] });
      Element.prototype.setPointerCapture = function() {};
      Element.prototype.releasePointerCapture = function() {};
      const canvasGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(kind, options) {
        const value = canvasGetContext.call(this, kind, options);
        if (kind === 'webgl2' && value) counts.contexts += 1;
        return value;
      };
      const proto = WebGL2RenderingContext.prototype;
      [['compileShader','shaderCompiles'],['linkProgram','programLinks'],['texImage2D','textureUploads'],['getUniformLocation','uniformLookups'],['uniform1f','uniformUpdates'],['uniform2f','uniformUpdates'],['uniform4f','uniformUpdates'],['drawArrays','draws'],['bufferData','bufferUploads']].forEach(([method,key]) => {
        const original = proto[method];
        proto[method] = function(...args) { counts[key] += 1; return original.apply(this,args); };
      });
    })()`);
    const first = await clickAndHold(cdp, '#mode-toggle .mode-toggle-btn[data-mode]:nth-of-type(1)');
    const second = await clickAndHold(cdp, '#mode-toggle .mode-toggle-btn[data-mode]:nth-of-type(2)');
    const counts = await evaluate(cdp, 'window.__liquidPerfCounts');
    const pool = await evaluate(cdp, `({
      total: liquidKyantRendererPool.filter(item => !item.invalid).length,
      ready: liquidKyantRendererPool.filter(item => !item.invalid && item.textureReady).length
    })`);
    const maxMotionAmount = await evaluate(cdp, 'window.__liquidMaxMotionAmount');
    if (pool.total !== 1 || pool.ready !== 1 || counts.contexts > 1 || counts.shaderCompiles > 2 || counts.programLinks > 1) {
      throw new Error(`renderer resources were rebuilt: ${JSON.stringify({ counts, pool })}`);
    }
    if (counts.textureUploads > 3 || ![0,9].includes(counts.uniformLookups) || counts.draws > 90 || counts.bufferUploads > 1) {
      throw new Error(`prewarmed texture/GPU budget contract failed: ${JSON.stringify({ counts, pool })}`);
    }
    if (!(first.readyMs <= 180) || !(second.readyMs <= 180)) throw new Error(`prewarmed dispersion missed first-frame budget: ${JSON.stringify({ first, second })}`);
    if ((first.pixelStats?.display?.blackRatio ?? 1) > 0.05 || (second.pixelStats?.display?.blackRatio ?? 1) > 0.05) {
      throw new Error(`composited liquid surface regressed to opaque black: ${JSON.stringify({ first: first.pixelStats, second: second.pixelStats })}`);
    }
    if (counts.uniformUpdates > counts.draws * 4 + 12) throw new Error(`uniform update cache regressed: ${JSON.stringify(counts)}`);
    if (!(maxMotionAmount > 0.001)) {
      throw new Error(`liquid float never deformed during real flight: ${maxMotionAmount}`);
    }
    const latencies = [];
    for (let index = 0; index < 20; index += 1) {
      latencies.push(await clickForLatency(cdp, `#mode-toggle .mode-toggle-btn[data-mode]:nth-of-type(${index % 2 + 1})`));
    }
    const ordered = [...latencies].sort((a, b) => a - b);
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1];
    if (!(p95 >= 450 && p95 < 700)) {
      throw new Error(`pointerup-to-command must follow the complete 360ms flight + 180ms landing: ${p95.toFixed(3)}ms`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, counts, pool, maxMotionAmount, first, second, pointerUpToCommandMs: { p95, samples: latencies } })}\n`);
  } finally {
    try { cdp?.socket.close(); } catch {}
    if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
    await removeRootWhenReleased(root);
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
