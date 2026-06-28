const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-model-settings-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_MODEL_SETTINGS_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-model-settings-smoke] ${message}`);
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
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
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
    try {
      lastValue = await evaluate(cdp, expression, 10000);
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(300);
  }
  fail(`Timed out waiting for ${label}; last value: ${lastValue}`);
}

async function captureScreenshot(cdp) {
  await cdp.call('Page.bringToFront', {}, 10000);
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  }, 10000).catch(() => undefined);
  await evaluate(cdp, `(() => { window.scrollTo(0, 0); return true; })()`);
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
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
      log(`screenshot ${screenshotPath} (${attempt.label})`);
      return;
    } catch (error) {
      errors.push(`${attempt.label}: ${error.message}`);
    }
  }
  const fallback = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height; $gfx=[System.Drawing.Graphics]::FromImage($bmp); $gfx.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size); $dir=${JSON.stringify(path.dirname(screenshotPath))}; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $file=${JSON.stringify(screenshotPath)}; $bmp.Save($file,[System.Drawing.Imaging.ImageFormat]::Png); $gfx.Dispose(); $bmp.Dispose(); Write-Output 'SCREEN_CAPTURE_OK'`,
  ], { encoding: 'utf8', windowsHide: true });
  if (fallback.status === 0 && fs.existsSync(screenshotPath)) {
    log(`screenshot ${screenshotPath} (windows-screen-fallback after ${errors.join(' | ')})`);
    return;
  }
  fail(`screenshot capture failed: ${errors.join(' | ')} | fallback: ${fallback.stderr || fallback.stdout || 'no output'}`);
}

function writeConfig(root) {
  const config = {
    models: {
      providers: [],
      default_model: '',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      auto_switch_preference: 'default',
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'default' },
    general: { language: 'en' },
    workspace: { auto_create_timestamp_workspace: true, prompt_mode: 'both' },
  };
  fs.mkdirSync(root, { recursive: true });
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
  return { child, cdp };
}

function stopChild(child) {
  try { if (child && !child.killed) child.kill(); } catch {}
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
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'",
    ], { windowsHide: true, encoding: 'utf8' });
    fail('release UI model settings smoke left a packaged Newmark process running');
  }
}

function readProviders(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const raw = ((config.models || {}).providers) || [];
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.value)) return raw.value;
  return [];
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI model settings smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiModelSettingsRoot-'));
  writeConfig(root);
  const port = Number(process.env.NEWMARK_UI_MODEL_SETTINGS_PORT || '49380');
  let child;
  let cdp;
  let completed = false;
  try {
    ({ child, cdp } = await launch(root, port));
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.isInternal === true)`, 30000, 'initial workspace');
    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.openSettings && !!window.addProvider && !!window.addModel && !!window.editProvider && !!window.editModel)()`, 30000, 'model settings functions');

    await evaluate(cdp, `window.openSettings('models')`);
    await waitFor(cdp, `(() => document.body.innerText.includes('Models & Providers'))()`, 15000, 'models settings visible');

    await evaluate(cdp, `(() => {
      window.addProvider();
      document.getElementById('new-provider-name').value = 'CrudProvider';
      document.getElementById('new-provider-protocol').value = 'openai';
      document.getElementById('new-provider-endpoint').value = 'http://127.0.0.1:49999/v1';
      document.getElementById('new-provider-key').value = 'test-key-crud-secret';
      window.saveNewProvider();
      return true;
    })()`, 15000);
    await waitFor(cdp, `window.api.getState().then(s => (s.providers || []).some(p => p.name === 'CrudProvider' && p.has_api_key === true && p.api_key === ''))`, 15000, 'provider add and key redaction');
    log('provider add ok');

    await evaluate(cdp, `(() => {
      window.addModel();
      document.getElementById('new-model-name').value = 'crud-model-a';
      document.getElementById('new-model-provider').value = '0';
      document.getElementById('new-model-ctx').value = '12345';
      document.getElementById('new-model-vision').checked = true;
      document.getElementById('new-model-thinking').checked = false;
      document.getElementById('new-model-desc').value = 'Initial CRUD model description';
      window.saveNewModel();
      return true;
    })()`, 15000);
    await waitFor(cdp, `window.api.getState().then(s => {
      const p = (s.providers || []).find(x => x.name === 'CrudProvider');
      const m = p && (p.models || []).find(x => x.name === 'crud-model-a');
      return !!(m && m.max_tokens === 12345 && m.vision === true && m.thinking === false && m.description === 'Initial CRUD model description');
    })`, 15000, 'model add fields');
    log('model add ok');

    await evaluate(cdp, `(() => {
      const providerIdx = (window.state.providers || []).findIndex(p => p.name === 'CrudProvider');
      if (providerIdx < 0) throw new Error('CrudProvider not found before edit');
      window.editProvider(providerIdx);
      document.getElementById('edit-provider-name').value = 'CrudProviderEdited';
      document.getElementById('edit-provider-protocol').value = 'anthropic';
      document.getElementById('edit-provider-endpoint').value = 'http://127.0.0.1:49998/v1';
      document.getElementById('edit-provider-key').value = '';
      window.saveProviderEdit(providerIdx);
      return true;
    })()`, 15000);
    await waitFor(cdp, `window.api.getState().then(s => (s.providers || []).some(p => p.name === 'CrudProviderEdited' && p.protocol === 'anthropic' && p.has_api_key === true && String(p.base_url || '').includes('49998')))`, 15000, 'provider edit');
    const persistedAfterProviderEdit = readProviders(root);
    const editedProvider = persistedAfterProviderEdit.find(p => p.name === 'CrudProviderEdited');
    if (!editedProvider || editedProvider.api_key !== 'test-key-crud-secret') fail('provider edit did not preserve saved API key');
    log('provider edit and key preservation ok');

    await evaluate(cdp, `(() => {
      const providerIdx = (window.state.providers || []).findIndex(p => p.name === 'CrudProviderEdited');
      if (providerIdx < 0) throw new Error('CrudProviderEdited not found before model edit');
      window.editModel(providerIdx, 0);
      document.getElementById('edit-model-name').value = 'crud-model-b';
      document.getElementById('edit-model-provider').value = String(providerIdx);
      document.getElementById('edit-model-ctx').value = '8192';
      document.getElementById('edit-model-vision').checked = false;
      document.getElementById('edit-model-thinking').checked = true;
      document.getElementById('edit-model-desc').value = 'Edited CRUD model description';
      window.saveModelEdit(providerIdx, 0);
      return true;
    })()`, 15000);
    await waitFor(cdp, `window.api.getState().then(s => {
      const p = (s.providers || []).find(x => x.name === 'CrudProviderEdited');
      const oldM = p && (p.models || []).find(x => x.name === 'crud-model-a');
      const m = p && (p.models || []).find(x => x.name === 'crud-model-b');
      return !!(!oldM && m && m.max_tokens === 8192 && m.vision === false && m.thinking === true && m.description === 'Edited CRUD model description');
    })`, 15000, 'model edit fields');
    log('model edit ok');

    await evaluate(cdp, `(() => {
      const providerIdx = (window.state.providers || []).findIndex(p => p.name === 'CrudProviderEdited');
      if (providerIdx < 0) throw new Error('CrudProviderEdited not found before model delete');
      window.removeModel(providerIdx, 0);
      return true;
    })()`, 15000);
    await waitFor(cdp, `window.api.getState().then(s => {
      const p = (s.providers || []).find(x => x.name === 'CrudProviderEdited');
      return !!(p && (!p.models || p.models.length === 0));
    })`, 15000, 'model delete');
    log('model delete ok');

    await evaluate(cdp, `(() => {
      const providerIdx = (window.state.providers || []).findIndex(p => p.name === 'CrudProviderEdited');
      if (providerIdx < 0) throw new Error('CrudProviderEdited not found before provider delete');
      window.removeProvider(providerIdx);
      return true;
    })()`, 15000);
    await waitFor(cdp, `window.api.getState().then(s => !(s.providers || []).some(p => String(p.name || '').startsWith('CrudProvider')))`, 15000, 'provider delete');
    if (readProviders(root).some(p => String(p.name || '').startsWith('CrudProvider'))) fail('provider delete did not persist');
    log('provider delete ok');

    await captureScreenshot(cdp);
    completed = true;
    log('all release UI model settings checks passed');
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    stopChild(child);
    await sleep(1200);
    if (!keepRoot) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { log(`warning: could not remove temp root ${root}: ${error.message}`); }
    } else {
      log(`kept temp root: ${root}`);
    }
    ensureNoReleaseProcess();
    if (!completed) log('cleanup complete after failed model settings smoke');
  }
})().catch(error => {
  console.error(`[release-ui-model-settings-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
