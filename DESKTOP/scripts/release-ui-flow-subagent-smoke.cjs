const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-flow-subagent-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_FLOW_SUBAGENT_SMOKE === '1';

function log(message) { console.log(`[release-ui-flow-subagent-smoke] ${message}`); }
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
    try {
      lastValue = await evaluate(cdp, expression, 10000);
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(400);
  }
  fail(`Timed out waiting for ${label}; last value: ${String(lastValue || '').slice(0, 800)}`);
}

function sendSse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function toolCallChunk(id, name, args) {
  return { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
}
function textChunk(text) { return { choices: [{ delta: { content: text } }] }; }

function startMockServer() {
  const requests = [];
  const toolOrder = [];
  const steps = [
    ['flow_save', { name: 'agent-designed-release-flow', components: [{ id: 0, type: 'dialog', mode: 'build', prompt: 'FLOW_COMPONENT_RUNTIME_INPUT {#prompt#}' }] }],
    ['flow_list', {}],
    ['flow_run', { name: 'agent-designed-release-flow', input: 'FLOW_USER_INPUT_FROM_PARENT', start: 0 }],
    ['task', { name: 'release-child', prompt: 'SUBAGENT_INITIAL_PROMPT', model: 'release-ui-flow-subagent-mock', mode: 'build', input_mode: 'guide' }],
    ['subagent_send', { name: 'release-child', prompt: 'SUBAGENT_CONTINUE_PROMPT' }],
    ['subagent_result', { name: 'release-child' }],
    ['subagent_close', { name: 'release-child' }],
  ];

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
        res.end(JSON.stringify({ data: [{ id: 'release-ui-flow-subagent-mock' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'RELEASE_UI_FLOW_SUBAGENT_VALIDATE_OK' } }] }));
        return;
      }
      if (messagesText.includes('FLOW_COMPONENT_RUNTIME_INPUT') && messagesText.includes('FLOW_USER_INPUT_FROM_PARENT') && !messagesText.includes('"flow_save"')) {
        sendSse(res, [textChunk('FLOW_COMPONENT_RUNTIME_OK FLOW_USER_INPUT_FROM_PARENT')]);
        return;
      }
      if (messagesText.includes('You are subagent')) {
        sendSse(res, [textChunk(messagesText.includes('SUBAGENT_CONTINUE_PROMPT') ? 'SUBAGENT_CONTINUED_OK' : 'SUBAGENT_INITIAL_OK')]);
        return;
      }
      const next = steps[toolOrder.length];
      if (next) {
        const [name, args] = next;
        toolOrder.push(name);
        sendSse(res, [toolCallChunk(`call_${toolOrder.length}_${name}`, name, args)]);
        return;
      }
      sendSse(res, [textChunk('RELEASE_UI_FLOW_SUBAGENT_OK FLOW_COMPONENT_RUNTIME_OK SUBAGENT_CONTINUED_OK')]);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, toolOrder })));
}

function writeConfig(root, mockPort) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: [{ name: 'ReleaseUiFlowSubagentMock', base_url: `http://127.0.0.1:${mockPort}/v1`, api_key: 'mock-key', protocol: 'openai', enabled: true, models: [{ name: 'release-ui-flow-subagent-mock', display: 'release-ui-flow-subagent-mock', evaluation: { status: 'available', latency: 0.1 } }] }],
      default_model: 'release-ui-flow-subagent-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: { prompt_mode: 'both', access_permission: 'full_access', on_permission_violation: 'deny' },
  }, null, 2), 'utf8');
}

async function captureScreenshot(cdp) {
  await cdp.call('Page.bringToFront', {}, 10000);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 10000).catch(() => undefined);
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  if (!screenshot?.data) return;
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  log(`screenshot ${screenshotPath}`);
}

function ensureNoReleaseProcess() {
  const running = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "(@(Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })).Count"], { encoding: 'utf8', windowsHide: true });
  const count = Number(String(running.stdout || '').trim());
  if (count > 0) {
    spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'"], { windowsHide: true, encoding: 'utf8' });
    fail('release UI Flow/subagent smoke left a packaged Newmark process running');
  }
}

(async () => {
  if (process.platform !== 'win32') { log('skipped: packaged Windows UI Flow/subagent smoke only runs on win32'); return; }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiFlowSubagent-'));
  const mock = await startMockServer();
  writeConfig(root, mock.port);
  const port = Number(process.env.NEWMARK_UI_FLOW_SUBAGENT_PORT || '49381');
  let child;
  let cdp;
  let completed = false;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], { stdio: 'ignore', windowsHide: true });
    const target = await waitForTarget(port);
    log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
    cdp = connectCdp(target);
    await cdp.ready;
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    const initial = await waitFor(cdp, `window.api.getState().then(state => {
      const workspace = state.workspaces && state.workspaces.current ? state.workspaces.current.path : '';
      return state.model === 'release-ui-flow-subagent-mock' && workspace ? { workspace, status: state.status } : null;
    })`, 30000, 'initial Flow/subagent state');
    if (!initial.workspace || !String(initial.workspace).startsWith(path.join(root, 'Work'))) fail(`workspace was not initialized under temp root: ${initial.workspace}`);
    await waitFor(cdp, `(() => document.readyState === 'complete' && !!document.querySelector('#prompt'))()`, 30000, 'prompt input');
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      prompt.value = 'Design a Flow, trigger it, create and close a subagent, then report get.subagent result.';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.sendMessage();
      return true;
    })()`);
    await waitFor(cdp, `(() => {
      const text = document.body.innerText || '';
      return text.includes('RELEASE_UI_FLOW_SUBAGENT_OK') &&
        text.includes('[flow_save] OK: agent-designed-release-flow.Flow.json') &&
        text.includes('[Flow] Completed: agent-designed-release-flow') &&
        text.includes('FLOW_COMPONENT_RUNTIME_OK') &&
        text.includes('get.subagent("release-child")') &&
        text.includes('SUBAGENT_CONTINUED_OK') &&
        text.includes("[Subagent 'release-child' closed]") ? text : '';
    })()`, 120000, 'visible Flow/subagent result');
    const state = await evaluate(cdp, `window.api.getState()`, 30000);
    if (!state || state.status !== 'idle') fail(`agent did not return to idle: ${state && state.status}`);
    const agents = Array.isArray(state.subagents) ? state.subagents : [];
    const childState = agents.find(item => item.name === 'release-child');
    if (!childState || childState.active !== false || childState.status !== 'closed' || !String(childState.result || '').includes('SUBAGENT_CONTINUED_OK')) fail(`closed retained subagent state missing: ${JSON.stringify(agents)}`);
    const flowPath = path.join(root, 'Flow', 'agent-designed-release-flow.Flow.json');
    if (!fs.existsSync(flowPath)) fail(`flow_save did not persist workflow: ${flowPath}`);
    const flowText = fs.readFileSync(flowPath, 'utf8');
    if (!flowText.includes('FLOW_COMPONENT_RUNTIME_INPUT') || !flowText.includes('{#prompt#}')) fail(`persisted Flow did not preserve component prompt: ${flowText}`);
    await evaluate(cdp, `window.switchRightTab('subagent')`);
    await waitFor(cdp, `(() => {
      const text = document.body.innerText || '';
      return text.includes('release-child') && text.includes('closed') ? text : '';
    })()`, 15000, 'right subagent retained history list');
    await evaluate(cdp, `window.openSubagentHistory('release-child')`);
    await waitFor(cdp, `(() => {
      const overlay = document.querySelector('#subagent-history-overlay');
      const text = overlay ? overlay.innerText : '';
      return text.includes('Subagent history is read-only') && text.includes('SUBAGENT_INITIAL_OK') && text.includes('SUBAGENT_CONTINUED_OK') ? text : '';
    })()`, 15000, 'read-only subagent history overlay');
    const expectedOrder = 'flow_save,flow_list,flow_run,task,subagent_send,subagent_result,subagent_close';
    if (mock.toolOrder.join(',') !== expectedOrder) fail(`unexpected tool order: ${mock.toolOrder.join(',')}`);
    if (!mock.requests.some(r => r.body.includes('flow_save'))) fail('mock provider did not request flow_save');
    if (!mock.requests.some(r => r.body.includes('subagent_result'))) fail('mock provider did not request subagent_result');
    await captureScreenshot(cdp).catch(error => log(`warning: screenshot capture failed: ${error.message}`));
    log('flow design and trigger ok');
    log('subagent retained history ok');
    log('all release UI Flow/subagent checks passed');
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
  console.error(`[release-ui-flow-subagent-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
