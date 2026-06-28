const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-goal-continuation-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_GOAL_CONTINUATION_SMOKE === '1';

function log(message) { console.log(`[release-ui-goal-continuation-smoke] ${message}`); }
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

function sendSse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function textChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

function startMockServer() {
  const requests = [];
  let goalCalls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const messagesText = JSON.stringify(parsed.messages || []);

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'release-ui-goal-continuation-mock' }] }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'RELEASE_UI_GOAL_VALIDATE_OK' } }] }));
        return;
      }

      if (messagesText.includes('RELEASE_UI_GOAL_CONTINUATION')) {
        goalCalls += 1;
        if (goalCalls < 3) {
          sendSse(res, [textChunk(`GOAL_CONTINUATION_STEP_${goalCalls}: remaining concrete gap still open.`)]);
          return;
        }
        sendSse(res, [textChunk('[Goal Complete] RELEASE_UI_GOAL_CONTINUATION_COMPLETE after repeated autonomous continuation.')]);
        return;
      }

      sendSse(res, [textChunk('RELEASE_UI_GOAL_DEFAULT_OK')]);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      requests,
      getGoalCalls: () => goalCalls,
    }));
  });
}

function writeConfig(root, mockPort) {
  const config = {
    models: {
      providers: [{
        name: 'ReleaseUiGoalContinuationMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-ui-goal-continuation-mock',
          display: 'release-ui-goal-continuation-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-ui-goal-continuation-mock',
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
  if (count > 0) fail('release UI goal continuation smoke left a packaged Newmark process running');
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI goal continuation smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiGoalContinuation-'));
  const mock = await startMockServer();
  const port = Number(process.env.NEWMARK_UI_GOAL_CONTINUATION_PORT || '49362');
  let child;
  let cdp;

  try {
    writeConfig(root, mock.port);
    const launched = await launch(root, port);
    child = launched.child;
    cdp = launched.cdp;

    const workspace = await evaluate(cdp, `window.api.createWorkspace('goal-continuation-workspace')`, 30000);
    if (!workspace || !workspace.path) fail('workspace creation did not return a workspace path');

    await evaluate(cdp, `window.api.setModel('release-ui-goal-continuation-mock')`);
    await evaluate(cdp, `window.api.updateGoal('RELEASE_UI_GOAL_CONTINUATION must continue until the completion marker appears')`, 30000);
    const result = await evaluate(cdp, `window.api.sendMessage('RELEASE_UI_GOAL_CONTINUATION start repeated goal loop')`, 120000);
    const resultText = JSON.stringify(result || {});
    if (!resultText.includes('RELEASE_UI_GOAL_CONTINUATION_COMPLETE')) fail(`goal completion marker missing: ${resultText}`);
    if (/max[- ]?depth/i.test(resultText)) fail(`goal result contains max-depth warning: ${resultText}`);

    const goalRequestCount = mock.requests.filter(r => r.body.includes('RELEASE_UI_GOAL_CONTINUATION')).length;
    if (mock.getGoalCalls() < 3 || goalRequestCount < 3) {
      fail(`expected at least 3 autonomous Goal model calls, got goalCalls=${mock.getGoalCalls()} requests=${goalRequestCount}`);
    }

    const state = await evaluate(cdp, `window.api.getState()`, 30000);
    const stateText = JSON.stringify(state || {});
    if (!stateText.includes('RELEASE_UI_GOAL_CONTINUATION_COMPLETE')) fail('completed Goal text was not retained in renderer state');
    if (/max[- ]?depth/i.test(stateText)) fail(`renderer state contains max-depth warning: ${stateText}`);

    await captureScreenshot(cdp, screenshotPath);
    log(`goal autonomous continuation ok: calls=${mock.getGoalCalls()} requests=${goalRequestCount}`);
    log('all release UI goal continuation checks passed');
  } finally {
    if (cdp?.ws && cdp.ws.readyState === WebSocket.OPEN) cdp.ws.close();
    stopChild(child);
    mock.server.close();
    if (!keepRoot) fs.rmSync(root, { recursive: true, force: true });
    ensureNoReleaseProcess();
  }
})().catch(error => {
  console.error(`[release-ui-goal-continuation-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
