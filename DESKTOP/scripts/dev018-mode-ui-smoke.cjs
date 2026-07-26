const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const electronPath = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const screenshotPath = path.join(repoRoot, 'archive', '20260726-dev-0.1.8-flow-takeover-ui.png');
const port = 49381;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fail(message) { throw new Error(message); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl
        && item.type === 'page'
        && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  fail('Timed out waiting for the dev Electron renderer.');
}

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
  }
  return result.result?.value;
}

async function waitForUi(cdp) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, `typeof window.renderFlowTakeover === 'function'
      && document.getElementById('input-area')
      && document.getElementById('mode-select')
      && state._postStartupUiRendering`);
    if (ready) return;
    await sleep(250);
  }
  fail('Timed out waiting for the promoted Newmark UI.');
}

(async () => {
  if (!fs.existsSync(electronPath)) fail(`Missing Electron runtime: ${electronPath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkDev018Ui-'));
  const child = spawn(electronPath, ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
    cwd: desktopRoot,
    stdio: 'ignore',
    windowsHide: true,
  });
  let cdp;
  try {
    const target = await waitForTarget();
    cdp = connect(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    await waitForUi(cdp);
    const result = await evaluate(cdp, `(async () => {
      const input = document.getElementById('input-area');
      const inputStack = document.getElementById('input-stack');
      const floatStack = document.getElementById('input-float-stack');
      const bubble = document.getElementById('flow-takeover');
      const scrollButton = document.getElementById('scroll-bottom-btn');
      const before = input.getBoundingClientRect();
      window.renderFlowTakeover(true, 'dev-0.1.8 acceptance');
      scrollButton.classList.add('visible');
      const after = input.getBoundingClientRect();
      const inputStackRect = inputStack.getBoundingClientRect();
      const floatStackStyle = getComputedStyle(floatStack);
      const bubbleRect = bubble.getBoundingClientRect();
      const scrollButtonRect = scrollButton.getBoundingClientRect();
      const style = getComputedStyle(bubble);
      state.mode = 'flow';
      window.setInputMode('next', false);
      const flowInputMode = state.inputMode;
      state.mode = 'build';
      window.setInputMode('next', false);
      const nextButton = document.querySelector('#mode-toggle [data-mode="next"]');
      const nextAfterFlowExit = state.inputMode;
      const nextButtonDisabledAfterFlowExit = !!(nextButton && nextButton.disabled);
      const modeSequence = ['plan', 'goal', 'flow', 'build'];
      const modeTransitionCycles = 40;
      for (let cycle = 0; cycle < modeTransitionCycles; cycle++) {
        for (const mode of modeSequence) {
          await window.setVisibleMode(mode);
          window.setInputMode(mode === 'flow' ? 'guide' : (cycle % 2 ? 'guide' : 'next'), false);
          if (state.mode !== mode) throw new Error('Mode transition drifted at ' + cycle + ':' + mode);
          if (mode === 'flow' && state.inputMode !== 'guide') throw new Error('Flow accepted Next at cycle ' + cycle);
        }
      }
      state.mode = 'flow';
      window.setInputMode('guide', false);
      return {
        active: bubble.classList.contains('active'),
        floatStackPosition: floatStackStyle.position,
        pointerEvents: style.pointerEvents,
        inputHeightBefore: before.height,
        inputHeightAfter: after.height,
        bubbleBottom: bubbleRect.bottom,
        bubbleTop: bubbleRect.top,
        scrollButtonBottom: scrollButtonRect.bottom,
        inputStackTop: inputStackRect.top,
        inputTop: after.top,
        inputMode: flowInputMode,
        nextAfterFlowExit,
        nextButtonDisabledAfterFlowExit,
        modeTransitionCycles,
        finalModeAfterStress: state.mode,
        text: bubble.textContent,
      };
    })()`);
    if (!result.active || result.floatStackPosition !== 'absolute' || result.pointerEvents !== 'none') fail(`Invalid takeover surface: ${JSON.stringify(result)}`);
    if (Math.abs(result.inputHeightBefore - result.inputHeightAfter) > 0.5) fail(`Takeover changed input height: ${JSON.stringify(result)}`);
    if (result.bubbleBottom > result.inputStackTop - 5) fail(`Takeover is not floating above the complete input-bar stack: ${JSON.stringify(result)}`);
    if (result.scrollButtonBottom > result.bubbleTop - 5) fail(`Scroll-to-bottom button overlaps the Flow takeover bubble: ${JSON.stringify(result)}`);
    if (result.inputMode !== 'guide') fail(`Flow allowed Next input: ${JSON.stringify(result)}`);
    if (result.nextAfterFlowExit !== 'next' || result.nextButtonDisabledAfterFlowExit) {
      fail(`Next did not reactivate after Flow exit: ${JSON.stringify(result)}`);
    }
    if (result.modeTransitionCycles !== 40 || result.finalModeAfterStress !== 'flow') {
      fail(`Mode transition stress did not complete: ${JSON.stringify(result)}`);
    }
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ ok: true, result, screenshotPath }));
  } finally {
    if (cdp?.ws?.readyState === WebSocket.OPEN) cdp.ws.close();
    if (child.pid) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    await sleep(500);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch (error) {
      console.warn(`[dev018-mode-ui-smoke] cleanup warning: ${error.message}`);
    }
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
