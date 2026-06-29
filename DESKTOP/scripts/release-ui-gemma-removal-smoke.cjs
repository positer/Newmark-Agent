const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-29-release-gemma-removal-visual.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_GEMMA_REMOVAL_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-gemma-removal-smoke] ${message}`);
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
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  if (!screenshot?.data) fail('empty screenshot data');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  log(`screenshot ${screenshotPath}`);
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
  const cleanup = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      '$stopped = 0',
      'for ($i = 0; $i -lt 12; $i++) {',
      "  $matches = @(Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })",
      '  if ($matches.Count -eq 0) { break }',
      '  $stopped += $matches.Count',
      '  $matches | Stop-Process -Force -ErrorAction SilentlyContinue',
      '  Start-Sleep -Milliseconds 500',
      '}',
      "$remaining = @((Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })).Count",
      'Write-Output "stopped=$stopped;remaining=$remaining"',
    ].join('; '),
  ], { encoding: 'utf8', windowsHide: true });
  const output = String(cleanup.stdout || '').trim();
  const remaining = Number((output.match(/remaining=(\d+)/) || [])[1] || '0');
  const stopped = Number((output.match(/stopped=(\d+)/) || [])[1] || '0');
  if (remaining > 0) fail(`release UI Gemma removal smoke could not stop packaged Newmark processes: ${output}`);
  if (stopped > 0) log(`stopped lingering packaged processes: ${stopped}`);
}

function readProviders(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const raw = ((config.models || {}).providers) || [];
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.value)) return raw.value;
  return [];
}

function removeTempRoot(root) {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      if (!fs.existsSync(root)) return;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (fs.existsSync(root)) log(`warning: could not remove temp root ${root}`);
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI Gemma removal smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiGemmaRemovalRoot-'));
  writeConfig(root);
  const port = Number(process.env.NEWMARK_UI_GEMMA_REMOVAL_PORT || '49381');
  let child;
  let cdp;
  let completed = false;
  try {
    ({ child, cdp } = await launch(root, port));
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.isInternal === true)`, 30000, 'initial workspace');
    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.openSettings && !!window.addProvider && !!window.addModel && !!window.fuzzyInject)()`, 30000, 'model settings functions');

    const bridgeStatus = await evaluate(cdp, `(() => ({
      downloadGemmaType: typeof window.api.downloadGemma,
      fuzzyInjectType: typeof window.api.fuzzyInject,
      validateModelsType: typeof window.api.validateModels
    }))()`);
    if (bridgeStatus.downloadGemmaType !== 'undefined') fail(`downloadGemma bridge still exposed: ${bridgeStatus.downloadGemmaType}`);
    if (bridgeStatus.fuzzyInjectType !== 'function') fail('fuzzyInject bridge missing');
    if (bridgeStatus.validateModelsType !== 'function') fail('validateModels bridge missing');
    log('preload bridge removal ok');

    await evaluate(cdp, `window.openSettings('models')`);
    await waitFor(cdp, `(() => document.body.innerText.includes('Models & Providers'))()`, 15000, 'models settings visible');
    const modelSettingsText = await evaluate(cdp, `document.body.innerText`);
    if (/Gemma|download\s+Gemma|ollama\s+pull|installed\s+Gemma/i.test(modelSettingsText)) {
      fail(`Gemma download wording still visible: ${modelSettingsText.slice(0, 1000)}`);
    }
    if (!/Fuzzy inject model/i.test(modelSettingsText)) fail('fuzzy injection entry is not visible in model settings');
    if (!/Add provider/i.test(modelSettingsText) || !/Add model/i.test(modelSettingsText)) fail('manual provider/model controls are not visible');
    log('Gemma download UI absent; manual and fuzzy entries visible');

    await evaluate(cdp, `(() => {
      window.addProvider();
      document.getElementById('new-provider-name').value = 'LocalRuntimeCheck';
      document.getElementById('new-provider-protocol').value = 'openai';
      document.getElementById('new-provider-endpoint').value = 'http://127.0.0.1:11434/v1';
      document.getElementById('new-provider-key').value = 'local-runtime-placeholder-key';
      window.saveNewProvider();
      return true;
    })()`, 15000);
    await waitFor(cdp, `window.api.getState().then(s => (s.providers || []).some(p =>
      p.name === 'LocalRuntimeCheck' &&
      p.protocol === 'openai' &&
      p.base_url === 'http://127.0.0.1:11434/v1' &&
      p.has_api_key === true &&
      p.api_key === ''
    ))`, 15000, 'manual local provider persisted');
    log('manual local OpenAI-compatible provider ok');

    await evaluate(cdp, `(() => {
      window.addModel();
      document.getElementById('new-model-name').value = 'local-runtime-manual-model';
      document.getElementById('new-model-provider').value = '0';
      document.getElementById('new-model-ctx').value = '8192';
      document.getElementById('new-model-vision').checked = false;
      document.getElementById('new-model-thinking').checked = true;
      document.getElementById('new-model-desc').value = 'Manual local runtime model, compatible with Ollama or LM Studio endpoints.';
      window.saveNewModel();
      return true;
    })()`, 15000);
    await waitFor(cdp, `window.api.getState().then(s => {
      const p = (s.providers || []).find(x => x.name === 'LocalRuntimeCheck');
      const m = p && (p.models || []).find(x => x.name === 'local-runtime-manual-model');
      return !!(m && m.max_tokens === 8192 && m.thinking === true && m.vision === false && /Ollama or LM Studio/.test(m.description || ''));
    })`, 15000, 'manual local model persisted');

    const persistedProvider = readProviders(root).find(p => p.name === 'LocalRuntimeCheck');
    if (!persistedProvider) fail('manual local provider missing from config.json');
    if (persistedProvider.api_key !== 'local-runtime-placeholder-key') fail('manual provider API key was not persisted in config');
    if (persistedProvider.base_url !== 'http://127.0.0.1:11434/v1') fail('manual provider endpoint was not persisted');
    if (!persistedProvider.models.some(m => m.name === 'local-runtime-manual-model')) fail('manual local model missing from config.json');
    log('manual local model config persistence ok');

    await evaluate(cdp, `window.openSettings('models')`);
    await waitFor(cdp, `(() => document.body.innerText.includes('LocalRuntimeCheck') && document.body.innerText.includes('local-runtime-manual-model'))()`, 15000, 'manual local provider visible');
    await captureScreenshot(cdp);
    completed = true;
    log('all release UI Gemma removal checks passed');
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    stopChild(child);
    await sleep(1200);
    ensureNoReleaseProcess();
    if (!keepRoot) {
      removeTempRoot(root);
    } else {
      log(`kept temp root: ${root}`);
    }
    if (!completed) log('cleanup complete after failed Gemma removal smoke');
  }
})().catch(error => {
  console.error(`[release-ui-gemma-removal-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
