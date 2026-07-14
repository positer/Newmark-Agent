const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-07-03-release-111-ui-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_111_UI_SMOKE === '1';

function log(message) {
  console.log(`[release-111-ui-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  fail('Timed out waiting for Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(`Runtime.evaluate exception: ${details.exception?.description || details.text || JSON.stringify(details)}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(cdp, expression, 10000);
    if (lastValue) return lastValue;
    await sleep(400);
  }
  fail(`Timed out waiting for ${label}; last value: ${String(lastValue || '').slice(0, 500)}`);
}

function ensureNoReleaseProcess() {
  const running = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "(@(Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })).Count",
  ], { encoding: 'utf8', windowsHide: true });
  const count = Number(String(running.stdout || '').trim());
  if (count > 0) {
    spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force",
    ], { windowsHide: true });
    log(`warning: cleaned ${count} packaged Newmark release process(es) after smoke`);
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows release 1.1.1 UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRelease111UiSmoke-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: { providers: [], default_model: '', auto_switch: false },
    general: { language: 'en' },
    ui: {
      gradient_colors: ['#00ff88', '#00ccff', '#aa44ff', '#ff4488'],
      gradient_speed: 2,
      gradient_width: 2,
    },
  }, null, 2), 'utf8');
  const port = Number(process.env.NEWMARK_111_UI_SMOKE_PORT || '49341');
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForTarget(port);
    log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    await waitFor(cdp, `document.readyState === 'complete' && !!window.api && !!document.querySelector('#prompt')`, 30000, 'renderer ready');

    const modelUi = await evaluate(cdp, `(() => {
      window.openSettings('models');
      window.addProvider();
      const text = document.body.innerText || '';
      const newProtocol = document.querySelector('#new-provider-protocol');
      const fuzzyProtocol = document.querySelector('#fuzzy-protocol');
      const githubOption = newProtocol ? Array.from(newProtocol.options).some(o => o.value === 'github_models') : false;
      const fuzzyGithubOption = fuzzyProtocol ? Array.from(fuzzyProtocol.options).some(o => o.value === 'github_models') : false;
      if (newProtocol) {
        newProtocol.value = 'github_models';
        window.syncProviderProtocolDefaults('new-provider-protocol', 'new-provider-endpoint');
      }
      return {
        githubOption,
        fuzzyGithubOption,
        endpoint: document.querySelector('#new-provider-endpoint')?.value || '',
        loginButton: /GitHub Copilot|Sign in with GitHub|Connect GitHub/.test(text),
        hasLoginBridge: typeof window.githubCopilotLogin === 'function',
        hasTakeoverBridge: !!window.api.terminalTakeoverState && !!window.api.terminalTakeoverWrite && !!window.api.onTerminalTakeover,
      };
    })()`);
    if (!modelUi.githubOption || modelUi.fuzzyGithubOption || modelUi.endpoint !== 'https://models.github.ai' || !modelUi.loginButton || !modelUi.hasLoginBridge) {
      fail(`GitHub/Copilot exact-login UI contract failed: ${JSON.stringify(modelUi)}`);
    }
    if (!modelUi.hasTakeoverBridge) fail(`terminal takeover preload bridge missing: ${JSON.stringify(modelUi)}`);
    log('GitHub exact-login UI and fuzzy exclusion ok');

    const takeoverUi = await evaluate(cdp, `(() => {
      if (typeof window.applyTerminalTakeoverEvent !== 'function') throw new Error('missing applyTerminalTakeoverEvent');
      const state = window.state || {};
      state.configGradientColors = ['#00ff88', '#00ccff', '#aa44ff', '#ff4488'];
      state.configGradientSpeed = 2;
      state.configGradientWidth = 2;
      window.applyTerminalTakeoverEvent({
        type: 'started',
        session: {
          id: 'release111-ui',
          name: 'release111-ui',
          shell: 'powershell',
          cwd: 'C:/tmp',
          active: true,
          buffer: 'TAKEOVER_UI_OUTPUT'
        }
      });
      const tab = document.querySelector('.terminal-tab.agent-takeover.marquee-border[data-takeover-session="release111-ui"]');
      const pane = document.querySelector('.terminal-pane.agent-takeover.marquee-border[data-takeover-session="release111-ui"]');
      const status = pane?.querySelector('.terminal-takeover-status')?.textContent || '';
      return {
        tab: !!tab,
        pane: !!pane,
        status,
        output: pane?.innerText || '',
        dataSession: pane?.getAttribute('data-takeover-session') || '',
      };
    })()`);
    if (!takeoverUi.tab || !takeoverUi.pane || takeoverUi.dataSession !== 'release111-ui' || !takeoverUi.status.includes('Agent takeover') || !takeoverUi.output.includes('TAKEOVER_UI_OUTPUT')) {
      fail(`terminal takeover UI mirror failed: ${JSON.stringify(takeoverUi)}`);
    }
    log('terminal takeover bottom UI mirror ok');

    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, 30000);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    log(`screenshot ${screenshotPath}`);
    log('all release 1.1.1 UI feature checks passed');
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
    ensureNoReleaseProcess();
  }
})().catch(error => {
  console.error(`[release-111-ui-smoke] ${error.message}`);
  process.exit(1);
});
