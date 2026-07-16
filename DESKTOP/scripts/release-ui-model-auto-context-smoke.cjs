const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.resolve(process.env.NEWMARK_TEST_EXE || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe'));
const screenshotPath = path.join(repoRoot, 'archive', '2026-07-15-dev-0.0.10-model-auto-context-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_MODEL_AUTO_CONTEXT_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-model-auto-context-smoke] ${message}`);
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
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

function writeConfig(root) {
  const checkedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const config = {
    models: {
      providers: [{
        name: 'AutoOpenAI',
        base_url: 'http://127.0.0.1:9/v1',
        api_key: 'mock-key-openai',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'auto-text-small',
          display: 'Auto Text Small',
          max_tokens: 4096,
          vision: false,
          thinking: false,
          description: 'capability=medium; speed=fast; cost=cheap; multimodal=text-only; source=release smoke',
          speed_rating: 'fast',
          capability_rating: 'medium',
          evaluation: {
            status: 'available',
            latency: 0.2,
            checked_at: new Date().toISOString(),
            text_output: true,
            vision_input: false,
            image_output: false,
            cost_rating: 'cheap',
            performance_rating: 'medium',
            speed_rating: 'fast',
          },
          validation: {
            level: 'standard',
            status: 'verified',
            checked_at: checkedAt,
            expires_at: expiresAt,
            capabilities: {
              text_input: true,
              text_output: true,
              streaming: true,
              json_schema: true,
              tool_use: true,
              image_input: false,
              image_output: false,
            },
          },
        }],
      }, {
        name: 'AutoAnthropic',
        base_url: 'http://127.0.0.1:9',
        api_key: 'mock-key-anthropic',
        protocol: 'anthropic',
        enabled: true,
        models: [{
          name: 'auto-vision-large',
          display: 'Auto Vision Large',
          max_tokens: 128000,
          vision: true,
          thinking: true,
          description: 'capability=high; speed=medium; cost=standard; multimodal=vision; source=release smoke',
          speed_rating: 'medium',
          capability_rating: 'high',
          evaluation: {
            status: 'available',
            latency: 1.1,
            checked_at: new Date().toISOString(),
            text_output: true,
            vision_input: true,
            image_output: false,
            cost_rating: 'standard',
            performance_rating: 'high',
            speed_rating: 'medium',
          },
          validation: {
            level: 'standard',
            status: 'verified',
            checked_at: checkedAt,
            expires_at: expiresAt,
            capabilities: {
              text_input: true,
              text_output: true,
              streaming: true,
              json_schema: true,
              tool_use: true,
              image_input: true,
              image_output: false,
            },
          },
        }],
      }],
      default_model: 'auto-text-small',
      default_intelligence: 'medium',
      auto_switch: false,
      auto_switch_scope: 'all',
      auto_switch_preference: 'balanced',
      openai_api_mode: 'chat_stream',
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build' },
    general: { language: 'en' },
    workspace: { auto_create_timestamp_workspace: true, prompt_mode: 'both' },
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

async function captureScreenshot(cdp) {
  await cdp.call('Page.bringToFront', {}, 10000);
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  }, 10000).catch(() => undefined);
  await sleep(300);
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
  if (!screenshot?.data) fail('empty screenshot data');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  log(`screenshot ${screenshotPath}`);
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
    await waitForPromotedMainUi(cdp);
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
    log('warning: cleaned packaged Newmark release process residue after smoke');
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI model auto/context smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiModelAutoContext-'));
  writeConfig(root);
  const port = Number(process.env.NEWMARK_UI_MODEL_AUTO_CONTEXT_PORT || '49386');
  let child;
  let cdp;
  let completed = false;
  try {
    ({ child, cdp } = await launch(root, port));
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.isInternal === true)`, 30000, 'initial workspace');
    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.openSettings && !!window.setAutoSwitchMode && !!window.setOpenAIApiMode && !!window.renderContextWindow)()`, 30000, 'model auto/context functions');

    const initialState = await evaluate(cdp, `window.api.getState()`);
    if (initialState.autoSwitch !== false || initialState.autoSwitchScope !== 'all' || initialState.openAIApiMode !== 'chat_stream') {
      fail(`initial model auto state mismatch: ${JSON.stringify(initialState)}`);
    }

    await evaluate(cdp, `window.openSettings('models')`);
    await waitFor(cdp, `(() => document.body.innerText.includes('Models & Providers') && document.body.innerText.includes('Off - Auto unavailable') && document.body.innerText.includes('Full Auto - all providers') && document.body.innerText.includes('Provider Auto - current provider only') && document.body.innerText.includes('Responses API'))()`, 15000, 'models settings auto/api controls visible');

    const offSnapshot = await evaluate(cdp, `(() => {
      window.refreshModelSelect();
      const options = Array.from(document.getElementById('model-select').options).map(o => o.value);
      return { options, hasAuto: options.includes('auto') };
    })()`);
    if (offSnapshot.hasAuto) fail(`Auto option should be hidden while auto switch is off: ${JSON.stringify(offSnapshot)}`);

    await evaluate(cdp, `window.setAutoSwitchMode('all')`);
    await waitFor(cdp, `window.api.getState().then(s => s.autoSwitch === true && s.autoSwitchScope === 'all')`, 15000, 'full Auto state saved');
    const fullAutoSnapshot = await evaluate(cdp, `(() => {
      window.refreshModelSelect();
      const options = Array.from(document.getElementById('model-select').options).map(o => o.value);
      return { options, hasAuto: options.includes('auto') };
    })()`);
    if (!fullAutoSnapshot.hasAuto) fail(`Auto option should be visible in full Auto: ${JSON.stringify(fullAutoSnapshot)}`);

    await evaluate(cdp, `window.setAutoSwitchMode('provider')`);
    await waitFor(cdp, `window.api.getState().then(s => s.autoSwitch === true && s.autoSwitchScope === 'provider')`, 15000, 'provider Auto state saved');
    await evaluate(cdp, `window.setOpenAIApiMode('responses')`);
    await waitFor(cdp, `window.api.getState().then(s => s.openAIApiMode === 'responses')`, 15000, 'Responses API mode saved');

    const ringSnapshot = await evaluate(cdp, `(() => {
      window.state.contextWindow = { estimatedTokens: 1536, maxTokens: 4096, ratio: 1536 / 4096, warning: 'ok', model: 'auto-text-small' };
      window.renderContextWindow();
      const model = document.getElementById('model-select');
      const ring = document.getElementById('context-token-ring');
      const tip = document.getElementById('context-token-tooltip');
      if (!model || !ring || !tip) return { ok: false, reason: 'missing controls' };
      const mr = model.getBoundingClientRect();
      const rr = ring.getBoundingClientRect();
      ring.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const tr = tip.getBoundingClientRect();
      return {
        ok: true,
        ringWidth: Math.round(rr.width),
        ringHeight: Math.round(rr.height),
        besideModel: rr.left >= mr.right && rr.left - mr.right < 24,
        sameRow: Math.abs((mr.top + mr.height / 2) - (rr.top + rr.height / 2)) < 8,
        tooltipDisplay: getComputedStyle(tip).display,
        tooltipText: tip.innerText.trim(),
        tooltipAbove: tr.bottom <= rr.top + 1,
        hasLabel: !!document.querySelector('.context-token-ring-label'),
      };
    })()`);
    if (!ringSnapshot.ok || ringSnapshot.ringWidth !== 16 || ringSnapshot.ringHeight !== 16 || !ringSnapshot.besideModel || !ringSnapshot.sameRow || ringSnapshot.tooltipDisplay !== 'block' || !ringSnapshot.tooltipText.includes('1536 / 4096') || !ringSnapshot.tooltipText.includes('38%') || !ringSnapshot.tooltipAbove || ringSnapshot.hasLabel) {
      fail(`context token ring placement/tooltip mismatch: ${JSON.stringify(ringSnapshot)}`);
    }
    const persistedConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const providers = persistedConfig.models?.providers?.value || persistedConfig.models?.providers || [];
    const persistedModels = providers.flatMap(provider => provider.models || []);
    if (persistedModels.length !== 2 || persistedModels.some(model => model.validation?.level !== 'standard' || model.validation?.status !== 'verified')) {
      fail(`model UI smoke lost Standard validation eligibility: ${JSON.stringify(persistedModels)}`);
    }
    log('model Auto controls and context token ring ok');

    await captureScreenshot(cdp);
    completed = true;
    log('all release UI model auto/context checks passed');
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
    if (!completed) log('cleanup complete after failed model auto/context smoke');
  }
})().catch(error => {
  console.error(`[release-ui-model-auto-context-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
