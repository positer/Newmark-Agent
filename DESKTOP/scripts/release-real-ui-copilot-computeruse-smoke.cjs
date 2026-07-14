const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const realRoot = path.join(repoRoot, '_local', 'real-ui-user-test');
const screenshotPath = path.join(repoRoot, 'archive', '2026-07-03-real-ui-copilot-computeruse-followup.png');

function log(message) {
  console.log(`[release-real-ui-copilot-computeruse-smoke] ${message}`);
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

function stopReleaseProcesses() {
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Output 'release-process-cleanup-done'",
  ], { windowsHide: true, encoding: 'utf8' });
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: Windows-only release UI smoke');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  if (!fs.existsSync(path.join(realRoot, 'config.json'))) fail(`missing real UI test config: ${realRoot}`);
  stopReleaseProcesses();

  const port = Number(process.env.NEWMARK_REAL_UI_COPILOT_PORT || '49352');
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', `--root=${realRoot}`], {
      cwd: path.dirname(exePath),
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    await waitFor(cdp, `document.readyState === 'complete' && !!window.api && !!document.querySelector('#prompt')`, 30000, 'renderer ready');

    const initial = await waitFor(cdp, `window.api.getState().then(s => {
      const providers = s && s.providers || [];
      const ok = s && s.model === 'gpt-5.4-mini' && providers.some(p => p.name === 'APInebula' && p.protocol === 'openai' && p.has_api_key === true);
      if (!ok) return false;
      window.state.model = s.model || '';
      window.state.providers = providers;
      window.state.models = s.models || [];
      window.refreshModelSelect();
      return {
        model: s.model,
        providers: providers.map(p => ({ name: p.name, protocol: p.protocol, endpoint: p.base_url, hasKey: !!p.has_api_key })),
        models: (s.models || []).map(m => m.name || m.id || m.model || '')
      };
    })`, 30000, 'real APInebula provider state');

    const copilot = await evaluate(cdp, `window.api.githubCopilotLogin().then(async r => {
      const s = await window.api.getState();
      window.state.providers = s.providers || [];
      window.state.models = s.models || [];
      window.refreshModelSelect();
      window.openSettings('models');
      return {
        ok: !!r.ok,
        imported: !!r.imported,
        providerNames: (s.providers || []).map(p => p.name),
        github: (s.providers || []).filter(p => p.name === 'GitHub Copilot').map(p => ({ protocol: p.protocol, endpoint: p.base_url, hasKey: !!p.has_api_key }))[0] || null,
        selectedModel: s.model || '',
        bodyText: (document.body.innerText || '').slice(0, 5000)
      };
    })`, 60000);
    if (!copilot.ok || !copilot.providerNames.includes('GitHub Copilot') || !copilot.github || copilot.github.protocol !== 'github_models' || copilot.github.endpoint !== 'https://models.github.ai') {
      fail(`GitHub Copilot import failed: ${JSON.stringify(copilot)}`);
    }
    if (/gho_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/.test(JSON.stringify(copilot))) {
      fail('GitHub token leaked into renderer result');
    }

    await evaluate(cdp, `window.openSettings('models'); true`);
    await sleep(1000);
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const finalProviders = await evaluate(cdp, `window.api.getState().then(s => (s.providers || []).map(p => ({ name: p.name, protocol: p.protocol, endpoint: p.base_url, hasKey: !!p.has_api_key })))`, 30000);
    if (!finalProviders.some(p => p.name === 'GitHub Copilot' && p.protocol === 'github_models' && p.endpoint === 'https://models.github.ai')) {
      fail(`renderer/backend state missing imported GitHub Copilot provider: ${JSON.stringify(finalProviders)}`);
    }

    log(`real root model ${initial.model}; GitHub Copilot imported; screenshot ${screenshotPath}`);
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    stopReleaseProcesses();
  }
})().catch(error => {
  console.error(`[release-real-ui-copilot-computeruse-smoke] ${error.message}`);
  process.exit(1);
});
