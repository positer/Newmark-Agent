'use strict';

/**
 * dev-0.6.6 PC left rail fixed-control centering regression gate.
 *
 * The left rail's bottom controls (#left-ws-add "New", .left-collapse-btn) are
 * carried by the shared fixed-control glass float while pressed. Their cloned
 * label lives in .liquid-fixed-control-content, which authors its own inset:0
 * box. The generic stacking fallback
 *   .liquid-selection-float > :not(.liquid-selection-canvas) { position: relative; }
 * has the higher selector weight, so without an explicit same-weight restatement
 * the wrapper degrades into a shrink-to-fit flex item and the carried label
 * paints left-flush instead of centered.
 *
 * This gate drives the real Electron renderer over CDP, holds each control,
 * measures the carried content against the glass box, and writes before/after
 * screenshots for the same build (the "before" frame re-applies the old
 * declaration through a temporary override so no source revert is needed).
 *
 * Run: node scripts/verify-fixed-control-centering.cjs
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const desktopRoot = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function keyOf(selector) {
  return selector.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

async function targetAt(port) {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/list`, response => {
          let body = '';
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => resolve(body));
        }).on('error', reject);
      });
      const target = JSON.parse(body).find(item => item.type === 'page' && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('Electron main UI not available');
}

function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  return {
    socket,
    ready,
    call(method, params = {}, timeout = 20000) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timeout')); }, timeout);
        pending.set(key, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    }
  };
}

const SETUP_EXPRESSION = `(() => {
  window.__fmErrors = [];
  window.__fmClicks = [];
  addEventListener('error', event => window.__fmErrors.push(String((event.error && event.error.stack) || event.message)));
  window.__fmReal = { showNewWorkspaceDialog: window.showNewWorkspaceDialog, toggleLeft: window.toggleLeft };
  // Keep the harness from opening the New-workspace modal or collapsing the rail
  // mid-measurement. The gate asserts the held glass frame, so the click handler
  // body is not part of what it measures.
  window.showNewWorkspaceDialog = function () { window.__fmClicks.push('showNewWorkspaceDialog'); };
  window.toggleLeft = function () { window.__fmClicks.push('toggleLeft'); };
  var REPRO = '.liquid-selection-float > .liquid-fixed-control-content{position:relative !important}'
    + '.liquid-selection-float > .conversation-drag-content{position:relative !important}';
  window.__fmRepro = function (on) {
    var node = document.getElementById('fm-repro');
    if (!on) { if (node && node.parentNode) node.parentNode.removeChild(node); return; }
    if (!node) { node = document.createElement('style'); node.id = 'fm-repro'; document.head.appendChild(node); }
    node.textContent = REPRO;
  };
  window.__fmBox = function (selector) {
    var node = document.querySelector(selector);
    if (!node) return null;
    var rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  window.__fmSample = function (selector) {
    var source = document.querySelector(selector);
    var float = document.querySelector('.liquid-selection-float.liquid-fixed-control-float');
    if (!source || !float) return null;
    var content = float.querySelector('.liquid-fixed-control-content');
    if (!content) return null;
    var sourceRect = source.getBoundingClientRect();
    var floatRect = float.getBoundingClientRect();
    var contentRect = content.getBoundingClientRect();
    var style = getComputedStyle(content);
    return {
      selector: selector,
      sourceBox: { left: +sourceRect.left.toFixed(2), top: +sourceRect.top.toFixed(2), width: +sourceRect.width.toFixed(2), height: +sourceRect.height.toFixed(2) },
      floatBox: { left: +floatRect.left.toFixed(2), top: +floatRect.top.toFixed(2), width: +floatRect.width.toFixed(2), height: +floatRect.height.toFixed(2) },
      contentBox: { left: +contentRect.left.toFixed(2), top: +contentRect.top.toFixed(2), width: +contentRect.width.toFixed(2), height: +contentRect.height.toFixed(2) },
      contentPosition: style.position,
      contentInset: { top: style.top, right: style.right, bottom: style.bottom, left: style.left },
      driftX: +((contentRect.left + contentRect.width / 2) - (floatRect.left + floatRect.width / 2)).toFixed(2),
      driftY: +((contentRect.top + contentRect.height / 2) - (floatRect.top + floatRect.height / 2)).toFixed(2),
      sourceCovered: source.classList.contains('liquid-fixed-source-covered'),
      floatVisible: Number(getComputedStyle(float).opacity) > 0.99,
      carriedText: content.textContent.trim()
    };
  };
  window.__fmState = function (selector) {
    var source = document.querySelector(selector);
    return {
      sourceCovered: source ? source.classList.contains('liquid-fixed-source-covered') : null,
      sourceActive: source ? (source.dataset.fixedLiquidActive || '') : null,
      strandedFloats: document.querySelectorAll('.liquid-selection-float').length,
      clicks: window.__fmClicks.slice()
    };
  };
  window.__fmDragProbe = function () {
    var float = document.createElement('div');
    float.className = 'liquid-selection-float liquid-selection-viewport liquid-fixed-control-float visible';
    float.setAttribute('popover', 'manual');
    float.style.left = '320px';
    float.style.top = '140px';
    float.style.width = '232px';
    float.style.height = '52px';
    var content = document.createElement('div');
    content.className = 'conversation-drag-content';
    var summary = document.createElement('div');
    summary.className = 'conv-summary';
    summary.textContent = 'Carried conversation row';
    content.appendChild(summary);
    float.appendChild(content);
    document.body.appendChild(float);
    try { float.showPopover(); } catch (_) {}
    var style = getComputedStyle(content);
    var floatRect = float.getBoundingClientRect();
    var contentRect = content.getBoundingClientRect();
    var out = {
      contentPosition: style.position,
      inset: { top: style.top, right: style.right, bottom: style.bottom, left: style.left },
      floatBox: { width: +floatRect.width.toFixed(2), height: +floatRect.height.toFixed(2) },
      contentBox: { width: +contentRect.width.toFixed(2), height: +contentRect.height.toFixed(2) },
      insetLeft: +(contentRect.left - floatRect.left).toFixed(2),
      insetTop: +(contentRect.top - floatRect.top).toFixed(2)
    };
    float.remove();
    return out;
  };
  return true;
})()`;

(async () => {
  const distHtml = path.join(desktopRoot, 'dist', 'ui', 'index.html');
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(distHtml)).digest('hex');
  const archiveRoot = path.join(desktopRoot, '..', 'archive', `${timestamp()}-pc-left-rail-fixed-control-centering`);
  const evidenceDir = path.join(archiveRoot, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-fixed-control-centering-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: { providers: [] },
    general: { language: 'en' },
    workspace: { auto_create_timestamp_workspace: true }
  }));
  const port = Number(process.env.NEWMARK_FIXED_CONTROL_PORT || 49461);
  const child = spawn(require('electron'), [
    '.', `--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root
  ], { cwd: desktopRoot, stdio: 'ignore', windowsHide: true });

  const report = {
    sourceSha256,
    port,
    desktopHtml: distHtml,
    targets: {
      '#left-ws-add': 'showNewWorkspaceDialog',
      '.left-collapse-btn': 'toggleLeft'
    },
    samples: {},
    drag: {},
    checks: [],
    failures: [],
    dom: {},
    errors: []
  };
  const check = (ok, message) => {
    report.checks.push({ ok: !!ok, message });
    if (!ok) report.failures.push(message);
  };

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

    await evaluate('(function(){ if (typeof window.setLeftCollapsed === "function") window.setLeftCollapsed(false); return true; })()');
    await sleep(1200);
    await evaluate(SETUP_EXPRESSION);

    async function settleFrames() {
      // The rail controls live at the very bottom of the 900px viewport. A hidden
      // Electron window only produces a fresh compositor frame once the page
      // settles, so wait for two animation frames before capturing.
      await evaluate('new Promise(function(resolve){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ resolve(true); }); }); })');
    }

    async function screenshot(name, box) {
      const clipTop = Math.max(0, Math.round(box.top) - 110);
      const shot = await cdp.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: clipTop, width: 240, height: Math.max(60, 900 - clipTop), scale: 3 }
      });
      const file = path.join(evidenceDir, name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      return file;
    }

    async function holdAndSample(selector, prefix) {
      const box = await evaluate(`__fmBox(${JSON.stringify(selector)})`);
      if (!box || box.width <= 0 || box.height <= 0) throw new Error(`${selector} is not visible`);
      await evaluate('window.__fmClicks.length = 0');
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      await sleep(280);
      const sample = await evaluate(`__fmSample(${JSON.stringify(selector)})`);
      await settleFrames();
      const file = await screenshot(prefix, box);
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
      await sleep(1400);
      const after = await evaluate(`__fmState(${JSON.stringify(selector)})`);
      return { box, sample, after, screenshot: file };
    }

    for (const selector of Object.keys(report.targets)) {
      const key = keyOf(selector);
      report.samples[key] = {};
      // Pre-fix rendering proof, then the fixed rendering, from the same build.
      await evaluate('__fmRepro(true)');
      report.samples[key].before = await holdAndSample(selector, 'before-' + key);
      report.drag.before = await evaluate('__fmDragProbe()');
      await evaluate('__fmRepro(false)');
      report.samples[key].after = await holdAndSample(selector, 'after-' + key);
      if (!report.drag.after) report.drag.after = await evaluate('__fmDragProbe()');
    }

    for (const selector of Object.keys(report.targets)) {
      const key = keyOf(selector);
      const expectedClick = report.targets[selector];
      const before = report.samples[key].before;
      const after = report.samples[key].after;
      check(before.sample.contentPosition === 'relative',
        `${selector}: pre-fix cascade reproduces the shrink-to-fit wrapper (position=relative)`);
      check(Math.abs(before.sample.driftX) > 8,
        `${selector}: pre-fix held label is visibly left-flush (driftX=${before.sample.driftX})`);
      check(after.sample.contentPosition === 'absolute',
        `${selector}: held label wrapper keeps its authored absolute box`);
      check(Math.abs(after.sample.driftX) <= 0.75 && Math.abs(after.sample.driftY) <= 0.75,
        `${selector}: held label is centered in the glass (driftX=${after.sample.driftX}, driftY=${after.sample.driftY})`);
      check(Math.abs(after.sample.contentBox.width - after.sample.floatBox.width) <= 0.75
        && Math.abs(after.sample.contentBox.height - after.sample.floatBox.height) <= 0.75,
        `${selector}: held label fills the float box (inset:0 restored)`);
      check(after.sample.sourceCovered === true && after.sample.floatVisible === true,
        `${selector}: the glass float owns the pressed frame while the local pseudo surface stays suppressed`);
      check(after.after.sourceCovered === false && after.after.sourceActive === '' && after.after.strandedFloats === 0,
        `${selector}: release clears the float and the covered source`);
      check(after.after.clicks.length === 1 && after.after.clicks[0] === expectedClick,
        `${selector}: exactly one committed click reaches ${expectedClick} (got ${JSON.stringify(after.after.clicks)})`);
    }

    check(report.drag.before.contentPosition === 'relative',
      'conversation drag content: pre-fix cascade reproduces the shrink-to-fit wrapper');
    check(report.drag.after.contentPosition === 'absolute',
      'conversation drag content: authored absolute box is restored');
    check(report.drag.after.insetLeft === 9 && report.drag.after.insetTop === 9,
      'conversation drag content: authored inset:9px is restored');
    check(report.drag.after.contentBox.width === 214 && report.drag.after.contentBox.height === 34,
      `conversation drag content: carried row fills the inset box (got ${report.drag.after.contentBox.width}x${report.drag.after.contentBox.height})`);

    // The real collapse path must still work once the measurement stubs are gone.
    await evaluate('(function(){ window.__fmClicks.length = 0; window.toggleLeft = window.__fmReal.toggleLeft; return true; })()');
    const collapseBox = await evaluate('__fmBox(".left-collapse-btn")');
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: collapseBox.x, y: collapseBox.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await sleep(220);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: collapseBox.x, y: collapseBox.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await sleep(1800);
    report.dom.realCollapse = await evaluate(`(function(){
      var left = document.getElementById('left');
      return {
        collapsed: left.classList.contains('collapsed'),
        width: Math.round(left.getBoundingClientRect().width),
        strandedFloats: document.querySelectorAll('.liquid-selection-float').length,
        coveredSources: document.querySelectorAll('.liquid-fixed-source-covered').length
      };
    })()`);
    check(report.dom.realCollapse.collapsed === true, 'real collapse commit still collapses the rail');
    check(Math.abs(report.dom.realCollapse.width - 48) <= 1, `collapsed rail is 48px wide (got ${report.dom.realCollapse.width})`);
    check(report.dom.realCollapse.strandedFloats === 0 && report.dom.realCollapse.coveredSources === 0,
      'no glass float or covered source is stranded after the real collapse commit');
    await evaluate('(function(){ window.setLeftCollapsed(false); return true; })()');
    await sleep(1200);

    report.errors = await evaluate('window.__fmErrors.slice()');
    check(report.errors.length === 0, `no renderer errors during the gate (got ${report.errors.length})`);
  } catch (error) {
    report.failures.push(String((error && error.stack) || error));
  } finally {
    try { if (cdp) cdp.socket.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }

  report.passed = report.failures.length === 0;
  fs.writeFileSync(path.join(evidenceDir, 'verify-fixed-control-centering.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: report.passed,
    failures: report.failures,
    checks: report.checks.map(item => `${item.ok ? 'PASS' : 'FAIL'} ${item.message}`),
    driftX: Object.fromEntries(Object.entries(report.samples).map(([key, value]) => [
      key,
      { before: value.before && value.before.sample && value.before.sample.driftX, after: value.after && value.after.sample && value.after.sample.driftX }
    ])),
    evidenceDir
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
