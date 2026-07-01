const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-27-release-ui-integration-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_INTEGRATION_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-integration-smoke] ${message}`);
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
    const value = await evaluate(cdp, expression, 10000);
    lastValue = value;
    if (value) return value;
    await sleep(500);
  }
  fail(`Timed out waiting for ${label}; last value: ${String(lastValue || '').slice(0, 500)}`);
}

function sendSse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function toolCallChunk(id, name, args) {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  };
}

function textChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

function startMockServer(browserUrl) {
  const requests = [];
  const toolOrder = [];
  const steps = [
    ['browser_open', { url: browserUrl }],
    ['browser_snapshot', { max_chars: 4000 }],
    ['browser_type', { selector: '#query', text: 'Newmark Browser Smoke' }],
    ['browser_click', { selector: '#run' }],
    ['browser_eval', { script: "document.querySelector('#result').textContent" }],
    ['gh_auth_status', {}],
    ['automation_create', {
      prompt: 'RELEASE_UI_INTEGRATION_AUTOMATION_PROMPT',
      model: 'release-ui-integration-mock',
      condition: 'loop',
      interval_sec: 3600,
      active: false,
    }],
    ['automation_list', {}],
  ];

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'release-ui-integration-mock' }] }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'RELEASE_UI_INTEGRATION_VALIDATE_OK' } }] }));
        return;
      }

      const next = steps[toolOrder.length];
      if (next) {
        const [name, args] = next;
        toolOrder.push(name);
        sendSse(res, [toolCallChunk(`call_${toolOrder.length}_${name}`, name, args)]);
        return;
      }

      sendSse(res, [textChunk('RELEASE_UI_INTEGRATION_OK browser github automation')]);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, toolOrder }));
  });
}

function writeConfig(root, mockPort) {
  const config = {
    models: {
      providers: [{
        name: 'ReleaseUiIntegrationMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-ui-integration-mock',
          display: 'release-ui-integration-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-ui-integration-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function writeBrowserFixture(root) {
  const fixture = path.join(root, 'browser-fixture.html');
  fs.writeFileSync(fixture, `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Newmark Browser Integration Fixture</title></head>
<body>
  <h1>Newmark Browser Fixture</h1>
  <input id="query" value="">
  <button id="run" onclick="document.querySelector('#result').textContent = 'BROWSER_INTERACTION_OK:' + document.querySelector('#query').value">Run</button>
  <div id="result">pending</div>
</body>
</html>`, 'utf8');
  return pathToFileURL(fixture).href;
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
    log('skipped: packaged Windows UI integration smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiIntegration-'));
  const browserUrl = writeBrowserFixture(root);
  const mock = await startMockServer(browserUrl);
  writeConfig(root, mock.port);

  const port = Number(process.env.NEWMARK_UI_INTEGRATION_PORT || '49349');
  let child;
  let cdp;
  let completed = false;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForTarget(port);
    log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
    cdp = connectCdp(target);
    await cdp.ready;
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');

    const initial = await waitFor(cdp, `window.api.getState().then(state => {
      const workspace = state.workspaces && state.workspaces.current ? state.workspaces.current.path : '';
      return state.model === 'release-ui-integration-mock' && workspace ? { workspace, status: state.status } : null;
    })`, 30000, 'initial integration state');
    if (!initial.workspace || !String(initial.workspace).startsWith(path.join(root, 'Work'))) {
      fail(`workspace was not initialized under temp root: ${initial.workspace}`);
    }

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!document.querySelector('#prompt'))()`, 30000, 'prompt input');
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      prompt.value = 'Run browser, GitHub CLI, and automation integration tools.';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.sendMessage();
      return true;
    })()`);

    await waitFor(cdp, `(() => {
      const text = document.body.innerText || '';
      return text.includes('RELEASE_UI_INTEGRATION_OK') &&
        text.includes('[browser:open] OK') &&
        text.includes('[browser:snapshot] OK') &&
        text.includes('[browser:type] OK') &&
        text.includes('[browser:click] OK') &&
        text.includes('[browser:eval] OK') &&
        text.includes('BROWSER_INTERACTION_OK:Newmark Browser Smoke') &&
        text.includes('[automation_create] Created') &&
        text.includes('RELEASE_UI_INTEGRATION_AUTOMATION_PROMPT') ? text : '';
    })()`, 120000, 'visible Browser/GitHub/Automation integration result');

    const state = await evaluate(cdp, `window.api.getState()`, 30000);
    if (!state || state.status !== 'idle') fail(`agent did not return to idle: ${state && state.status}`);
    const schedules = state.automations || [];
    if (!Array.isArray(schedules) || !schedules.some(item => item.prompt === 'RELEASE_UI_INTEGRATION_AUTOMATION_PROMPT' && item.active === false)) {
      fail(`automation was not persisted inactive: ${JSON.stringify(schedules)}`);
    }

    const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const schedulesNode = config.automation?.schedules;
    const persisted = Array.isArray(schedulesNode) ? schedulesNode : (schedulesNode?.value || []);
    if (!Array.isArray(persisted) || !persisted.some(item => item.prompt === 'RELEASE_UI_INTEGRATION_AUTOMATION_PROMPT' && item.condition === 'loop')) {
      fail(`automation config persistence missing: ${JSON.stringify(persisted)}`);
    }

    const expectedOrder = 'browser_open,browser_snapshot,browser_type,browser_click,browser_eval,gh_auth_status,automation_create,automation_list';
    if (mock.toolOrder.join(',') !== expectedOrder) fail(`unexpected tool order: ${mock.toolOrder.join(',')}`);
    if (!mock.requests.some(r => r.body.includes('gh_auth_status'))) fail('mock provider did not request gh_auth_status');
    if (!mock.requests.some(r => r.body.includes('automation_create'))) fail('mock provider did not request automation_create');

    try {
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
      if (screenshot?.data) {
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
        log(`screenshot ${screenshotPath}`);
      }
    } catch (error) {
      log(`warning: screenshot capture failed: ${error.message}`);
    }

    log('browser tools ok');
    log('github cli tool ok');
    log('automation tool ok');
    log('all release UI integration checks passed');
    completed = true;
  } finally {
    if (!completed) log(`tool order before cleanup: ${mock.toolOrder.join(',') || '(none)'}`);
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await new Promise(resolve => mock.server.close(resolve));
    await sleep(1000);
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
    ensureNoReleaseProcess();
  }
})().catch(error => {
  console.error(`[release-ui-integration-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
