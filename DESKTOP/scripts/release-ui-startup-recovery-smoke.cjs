const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.resolve(process.env.NEWMARK_TEST_EXE || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe'));
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-startup-recovery-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_STARTUP_RECOVERY_SMOKE === '1';

function log(message) { console.log(`[release-ui-startup-recovery-smoke] ${message}`); }
function fail(message) { throw new Error(message); }
function fatal(message) {
  const error = new Error(message);
  error.newmarkFatal = true;
  throw error;
}
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
  let startupSurfaceObserved = false;
  let startupTargetId = '';
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const startupTarget = targets.find(t => t.webSocketDebuggerUrl && String(t.url || '').startsWith('data:text/html'));
      if (startupTarget) {
        startupSurfaceObserved = true;
        startupTargetId = String(startupTarget.id || startupTargetId || '');
      }
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'));
      if (target) {
        if (startupTargetId && String(target.id || '') !== startupTargetId) {
          fatal(`startup shell and final UI used different CDP targets: ${startupTargetId} -> ${String(target.id || '')}`);
        }
        const appPages = targets.filter(t => t.webSocketDebuggerUrl
          && (t.type === 'page' || t.type === 'webview')
          && (String(t.url || '').startsWith('data:text/html') || String(t.url || '').includes('index.html')));
        if (appPages.length !== 1) fatal(`same-window startup exposed ${appPages.length} application page targets`);
        if (startupSurfaceObserved) log('same-window startup surface observed before the final UI navigation');
        else log('startup surface transitioned in the same target before CDP polling observed it');
        return target;
      }
    } catch (error) {
      if (error && error.newmarkFatal) throw error;
    }
    await sleep(100);
  }
  fail('Timed out waiting for prewarmed Electron UI target');
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
    const message = details.exception?.description || details.text || JSON.stringify(details);
    throw new Error(`Runtime.evaluate exception: ${message}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(cdp, expression, 10000);
    if (lastValue) return lastValue;
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
  await evaluate(cdp, `(() => { window.scrollTo(0, 0); return true; })()`);
  await sleep(300);
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  if (!screenshot?.data) fail('empty screenshot data');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
  log(`screenshot ${filePath}`);
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
    log('warning: cleaned packaged Newmark release process residue after smoke');
  }
}

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function verifyRecoveredRoot(root) {
  for (const dir of ['skills', 'Work', 'Flow', 'archive']) {
    if (!fs.statSync(path.join(root, dir)).isDirectory()) fail(`missing recovered directory: ${dir}`);
  }
  for (const file of ['config.json', 'agent.md', 'PC_Hash.config', path.join('Flow', 'Flow.md'), path.join('Work', 'Local.json'), path.join('Work', 'External.json'), path.join('Work', 'State.json')]) {
    if (!fs.statSync(path.join(root, file)).isFile()) fail(`missing recovered file: ${file}`);
  }

  const config = parseJsonFile(path.join(root, 'config.json'));
  if ((config.workspace?.auto_create_timestamp_workspace?.value ?? config.workspace?.auto_create_timestamp_workspace) !== true) {
    fail('config did not enable default timestamp workspace creation');
  }
  const flowGuide = fs.readFileSync(path.join(root, 'Flow', 'Flow.md'), 'utf8');
  if (!flowGuide.includes('Newmark Flow Format Guide') || !flowGuide.includes('{#prompt#}')) fail('Flow/Flow.md guidance is incomplete');
  const pcHash = fs.readFileSync(path.join(root, 'PC_Hash.config'), 'utf8').trim();
  if (!pcHash || !pcHash.includes(process.platform)) fail(`PC_Hash.config invalid: ${pcHash}`);

  const local = parseJsonFile(path.join(root, 'Work', 'Local.json'));
  const external = parseJsonFile(path.join(root, 'Work', 'External.json'));
  const state = parseJsonFile(path.join(root, 'Work', 'State.json'));
  if (!Array.isArray(local) || local.length !== 1) fail(`Local.json did not contain one default internal workspace: ${JSON.stringify(local)}`);
  if (!Array.isArray(external) || external.length !== 0) fail(`External.json should start empty: ${JSON.stringify(external)}`);
  const ws = local[0];
  if (!ws.isInternal || !ws.name || !/^\d{4}-\d{2}-\d{2}_\d{4}(\d{2})?$/.test(ws.name)) fail(`default workspace is not timestamp-like: ${JSON.stringify(ws)}`);
  if (!fs.statSync(ws.path).isDirectory()) fail(`default workspace directory missing: ${ws.path}`);
  if (!state.current || state.current.name !== ws.name || state.current.path !== ws.path || state.current.isInternal !== true) {
    fail(`State.json did not select default internal workspace: ${JSON.stringify(state)}`);
  }
  return ws;
}

async function runUiCheck(root) {
  const port = Number(process.env.NEWMARK_UI_STARTUP_RECOVERY_SMOKE_PORT || '49355');
  let child;
  let cdp;
  const startedAt = Date.now();
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
    const startupMs = Date.now() - startedAt;
    if (startupMs > 8000) fail(`packaged startup exceeded the dev-0.0.10 maximum interaction budget: ${startupMs}ms`);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');

    const windowProbe = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if (!$p) { 'missing' } else { [pscustomobject]@{ id=$p.Id; handle=$p.MainWindowHandle; responding=$p.Responding; name=$p.ProcessName } | ConvertTo-Json -Compress }`,
    ], { encoding: 'utf8', windowsHide: true });
    const windowText = String(windowProbe.stdout || '').trim();
    if (!windowText || windowText === 'missing') fail('packaged process disappeared before renderer ready');
    const windowInfo = JSON.parse(windowText);
    if (!Number(windowInfo.handle)) fail(`packaged process has no visible main window handle: ${windowText}`);
    if (windowInfo.responding === false) fail(`packaged process is not responding: ${windowText}`);

    await waitFor(cdp, `(() => document.visibilityState === 'visible' && document.readyState === 'complete' && !!window.api && !!document.querySelector('#prompt'))()`, 30000, 'prewarmed renderer promoted and visible');
    await cdp.call('Page.bringToFront');
    await waitFor(cdp, `window.api.getState().then(s => !!(s.workspaces && s.workspaces.current && s.workspaces.current.isInternal))`, 30000, 'default internal workspace selected');
    const ws = verifyRecoveredRoot(root);
    const state = await evaluate(cdp, `window.api.getState().then(s => ({
      workspace: s.workspaces.current,
      language: s.language,
      promptPlaceholder: document.querySelector('#prompt')?.getAttribute('placeholder') || '',
      workspaceNames: (s.workspaces.internal || []).map(w => w.name),
      hydration: {
        state: !!(s.workspaces && s.workspaces.current),
        rendered: document.visibilityState === 'visible' && document.readyState === 'complete' && !!document.querySelector('#prompt'),
        browserAbsentBeforeDemand: !document.querySelector('#browser-webview')
      }
    }))`, 30000);
    if (!state.workspace || state.workspace.name !== ws.name || state.workspace.path !== ws.path) {
      fail(`renderer state did not match recovered workspace: ${JSON.stringify(state)}`);
    }
    if (state.language !== 'auto') fail(`renderer language should start auto: ${JSON.stringify(state)}`);
    if (!['Input instruction...', '输入指令...'].includes(state.promptPlaceholder)) fail(`prompt placeholder missing after recovery: ${JSON.stringify(state)}`);
    if (!state.workspaceNames.includes(ws.name)) fail(`renderer internal workspace list missing default workspace: ${JSON.stringify(state)}`);
    const requiredHydration = ['state', 'rendered', 'browserAbsentBeforeDemand'];
    const missingHydration = requiredHydration.filter(key => state.hydration?.[key] !== true);
    if (missingHydration.length > 0) fail(`packaged renderer promoted without complete hydration (${missingHydration.join(', ')}): ${JSON.stringify(state)}`);
    const browserStartedAt = Date.now();
    await evaluate(cdp, `window.switchRightTab('browser'); true`);
    const browserState = await waitFor(cdp, `(() => {
      const views = Array.from(document.querySelectorAll('#browser-webview'));
      const view = views[0];
      if (!view || views.length !== 1) return null;
      try {
        const ready = view.dataset?.newmarkBrowserReady === 'true'
          || !!(view.getWebContentsId && view.getWebContentsId() > 0);
        return ready ? { count: views.length, partition: view.getAttribute('partition') || '' } : null;
      } catch { return null; }
    })()`, 5000, 'single demand-created Browser guest');
    const browserOpenMs = Date.now() - browserStartedAt;
    if (browserOpenMs > 2500) fail(`first Browser open exceeded the 2.5s single-run smoke tolerance: ${browserOpenMs}ms`);
    if (browserState.count !== 1 || browserState.partition !== 'persist:newmark-browser') fail(`Browser guest lifecycle mismatch: ${JSON.stringify(browserState)}`);
    log(`companion files and default internal workspace recovered ok; startupMs=${startupMs}; browserOpenMs=${browserOpenMs}; window=${windowText}`);
    await captureScreenshot(cdp, screenshotPath);
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    ensureNoReleaseProcess();
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseStartupRecovery-'));
  for (const item of ['skills', 'Work', 'Flow', 'archive', 'config.json', 'agent.md', 'PC_Hash.config']) {
    const target = path.join(root, item);
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(target)) fail(`could not prepare missing companion item: ${item}`);
  }
  try {
    await runUiCheck(root);
    log('all startup recovery checks passed');
  } finally {
    if (!keepRoot) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { log(`warning: could not remove temp root ${root}: ${error.message}`); }
    } else {
      log(`kept temp root ${root}`);
    }
  }
})().catch(error => {
  console.error(error.stack || error.message);
  try { ensureNoReleaseProcess(); } catch {}
  process.exit(1);
});
