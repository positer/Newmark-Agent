const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-workspace-lifecycle-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_WORKSPACE_LIFECYCLE_SMOKE === '1';

function log(message) { console.log(`[release-ui-workspace-lifecycle-smoke] ${message}`); }
function fail(message) { throw new Error(message); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'))
        || targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.title || '').includes('Newmark'))
        || targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview'))
        || targets.find(t => t.webSocketDebuggerUrl);
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
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
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
      clearTimeout(callbacks.timer);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });

  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 15000) {
  let result;
  try {
    result = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
  } catch (error) {
    const summary = String(expression).replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`Runtime.evaluate failed for ${summary}: ${error.message}`);
  }
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description || details.text || JSON.stringify(details);
    throw new Error(`Runtime.evaluate exception: ${message}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression, 10000);
    lastValue = value;
    if (value) return value;
    await sleep(500);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

async function captureScreenshot(cdp, filePath) {
  await cdp.call('Page.bringToFront', {}, 10000);
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  }, 10000).catch(() => undefined);
  await sleep(300);
  const attempts = [
    { params: { format: 'png', fromSurface: true }, timeout: 15000, label: 'viewport-from-surface' },
    { params: { format: 'png', captureBeyondViewport: false, fromSurface: false }, timeout: 15000, label: 'viewport-no-surface' },
    { params: { format: 'png' }, timeout: 30000, label: 'default' },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const screenshot = await cdp.call('Page.captureScreenshot', attempt.params, attempt.timeout);
      if (!screenshot?.data) throw new Error('empty screenshot data');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
      log(`screenshot ${filePath} (${attempt.label})`);
      return;
    } catch (error) {
      errors.push(`${attempt.label}: ${error.message}`);
    }
  }
  fail(`screenshot capture failed: ${errors.join(' | ')}`);
}

function writeConfig(root) {
  const config = {
    models: {
      providers: [],
      default_model: '',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: true,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function launch(root, port) {
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const target = await waitForTarget(port);
  log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
  const cdp = connectCdp(target);
  await cdp.ready;
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await cdp.call('Page.bringToFront');
  await waitFor(cdp, `typeof window.api === 'object' && typeof window.api.getState === 'function'`, 30000, 'preload api');
  return { child, cdp };
}

function stopChild(child) {
  if (!child || child.killed) return;
  child.kill();
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'",
  ], { windowsHide: true, encoding: 'utf8' });
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
  if (count > 0) fail('release UI workspace lifecycle smoke left a packaged Newmark process running');
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI workspace lifecycle smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiWorkspaceLifecycle-'));
  const port = Number(process.env.NEWMARK_UI_WORKSPACE_LIFECYCLE_PORT || '49363');
  let child;
  let cdp;

  try {
    writeConfig(root);
    const launched = await launch(root, port);
    child = launched.child;
    cdp = launched.cdp;

    const alpha = await evaluate(cdp, `window.api.createWorkspace('lifecycle-alpha')`, 30000);
    const beta = await evaluate(cdp, `window.api.createWorkspace('lifecycle-beta')`, 30000);
    if (!alpha?.path || !beta?.path) fail('workspace creation did not return both paths');
    if (!fs.existsSync(alpha.path) || !fs.existsSync(beta.path)) fail('created internal workspace directories are missing');

    const selectedAlpha = await evaluate(cdp, `window.api.selectWorkspace('lifecycle-alpha').then(() => window.api.getState()).then(s => s.workspaces.current.name)`, 30000);
    if (selectedAlpha !== 'lifecycle-alpha') fail(`selectWorkspace did not switch to alpha: ${selectedAlpha}`);

    const selectedBeta = await evaluate(cdp, `window.api.selectWorkspace('lifecycle-beta').then(() => window.api.getState()).then(s => s.workspaces.current.name)`, 30000);
    if (selectedBeta !== 'lifecycle-beta') fail(`selectWorkspace did not switch to beta: ${selectedBeta}`);

    const deleteAlpha = await evaluate(cdp, `window.api.deleteWorkspace('lifecycle-alpha')`, 30000);
    if (deleteAlpha !== true) fail(`deleteWorkspace did not return true: ${deleteAlpha}`);
    if (fs.existsSync(alpha.path)) fail(`deleted internal workspace directory still exists: ${alpha.path}`);
    if (!fs.existsSync(beta.path)) fail('non-deleted internal workspace directory was removed');

    const localPath = path.join(root, 'Work', 'Local.json');
    const local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    if (local.some(w => w.name === 'lifecycle-alpha')) fail('Local.json still contains deleted workspace');
    if (!local.some(w => w.name === 'lifecycle-beta')) fail('Local.json lost remaining workspace');

    const state = await evaluate(cdp, `window.api.getState()`, 30000);
    if (state.workspaces.current.name !== 'lifecycle-beta') fail(`current workspace changed unexpectedly: ${state.workspaces.current.name}`);
    if (JSON.stringify(state.workspaces.internal).includes('lifecycle-alpha')) fail('renderer state still lists deleted workspace');

    await evaluate(cdp, `window.refreshWorkspaceState ? window.refreshWorkspaceState().then(() => true) : window.api.getState().then(s => {
      state.workspaces = [];
      if (s.workspaces && s.workspaces.internal) state.workspaces = state.workspaces.concat(s.workspaces.internal);
      if (s.workspaces && s.workspaces.external) state.workspaces = state.workspaces.concat(s.workspaces.external);
      state.currentWorkspace = s.workspaces && s.workspaces.current ? s.workspaces.current.name : '';
      if (typeof window.renderLeftWsList === 'function') window.renderLeftWsList();
      return true;
    })`, 30000);
    await evaluate(cdp, `Promise.resolve(window.openWorkspaceManager()).then(() => true)`, 30000);
    await waitFor(cdp, `(() => {
      const body = document.getElementById('sub-win-body');
      const text = body ? (body.innerText || '') : '';
      return text.includes('lifecycle-beta') && !text.includes('lifecycle-alpha');
    })()`, 30000, 'workspace manager reflects deletion');
    await captureScreenshot(cdp, screenshotPath);
    log('internal workspace create/select/delete ok');
    log('all release UI workspace lifecycle checks passed');
  } finally {
    if (cdp?.ws && cdp.ws.readyState === WebSocket.OPEN) cdp.ws.close();
    stopChild(child);
    if (!keepRoot) fs.rmSync(root, { recursive: true, force: true });
    ensureNoReleaseProcess();
  }
})().catch(error => {
  console.error(`[release-ui-workspace-lifecycle-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
