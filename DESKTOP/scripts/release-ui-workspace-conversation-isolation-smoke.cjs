const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotAPath = path.join(repoRoot, 'archive', '2026-07-05-release-ui-workspace-conversation-isolation-alpha.png');
const screenshotBPath = path.join(repoRoot, 'archive', '2026-07-05-release-ui-workspace-conversation-isolation-beta.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_WORKSPACE_CONVERSATION_ISOLATION_SMOKE === '1';

const workspaceA = 'workspace-isolation-alpha';
const workspaceB = 'workspace-isolation-beta';
const markerAPrompt = 'WS_ALPHA_CONV_PROMPT_20260705';
const markerAReply = 'WS_ALPHA_CONV_REPLY_20260705';
const markerBPrompt = 'WS_BETA_CONV_PROMPT_20260705';
const markerBReply = 'WS_BETA_CONV_REPLY_20260705';

function log(message) { console.log(`[release-ui-workspace-conversation-isolation-smoke] ${message}`); }
function fail(message) { throw new Error(message); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function js(value) { return JSON.stringify(String(value)); }

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
      const debug = await evaluate(cdp, `window.__workspaceIsolationDebug || null`, 10000).catch(() => null);
      if (debug) lastValue = debug;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(250);
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
  await sleep(250);
  const attempts = [
    { params: { format: 'png', fromSurface: true }, timeout: 30000, label: 'viewport-from-surface' },
    { params: { format: 'png', captureBeyondViewport: false, fromSurface: false }, timeout: 30000, label: 'viewport-no-surface' },
    { params: { format: 'png' }, timeout: 30000, label: 'default' },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const screenshot = await cdp.call('Page.captureScreenshot', attempt.params, attempt.timeout);
      if (!screenshot?.data) throw new Error('empty screenshot data');
      const buffer = Buffer.from(screenshot.data, 'base64');
      if (buffer.length < 50000) throw new Error(`screenshot appears blank or truncated: ${buffer.length}`);
      if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('not a PNG');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buffer);
      log(`screenshot ${filePath} (${attempt.label})`);
      return;
    } catch (error) {
      errors.push(`${attempt.label}: ${error.message}`);
    }
  }
  fail(`screenshot capture failed: ${errors.join(' | ')}`);
}

function sendSse(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const text = JSON.stringify(parsed.messages || []);
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'release-ui-workspace-isolation-mock' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const reply = text.includes(markerAPrompt) ? markerAReply
        : text.includes(markerBPrompt) ? markerBReply
          : 'WS_ISOLATION_DEFAULT_REPLY_20260705';
      if (parsed.stream) {
        sendSse(res, reply);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function writeConfig(root, mockPort) {
  const config = {
    models: {
      providers: [{
        name: 'ReleaseUiWorkspaceIsolationMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-ui-workspace-isolation-mock',
          display: 'release-ui-workspace-isolation-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-ui-workspace-isolation-mock',
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

function workspaceVisibleExpression(workspaceName, conversationId, includePrompt, includeReply, excludePrompt, excludeReply) {
  return `window.api.getState(${js(conversationId)}).then(s => {
    const body = document.querySelector('#chat-area')?.innerText || '';
    const current = s && s.workspaces && s.workspaces.current ? s.workspaces.current.name : '';
    const activeItems = Array.from(document.querySelectorAll('#conversation-list .conv-item.active'));
    const ok = current === ${js(workspaceName)} &&
      s && s.conversationId === ${js(conversationId)} &&
      body.includes(${js(includePrompt)}) &&
      body.includes(${js(includeReply)}) &&
      !body.includes(${js(excludePrompt)}) &&
      !body.includes(${js(excludeReply)}) &&
      activeItems.length === 1;
    if (!ok) {
      window.__workspaceIsolationDebug = {
        expectedWorkspace: ${js(workspaceName)},
        actualWorkspace: current,
        expectedConversation: ${js(conversationId)},
        actualConversation: s && s.conversationId,
        hasIncludePrompt: body.includes(${js(includePrompt)}),
        hasIncludeReply: body.includes(${js(includeReply)}),
        leakedExcludePrompt: body.includes(${js(excludePrompt)}),
        leakedExcludeReply: body.includes(${js(excludeReply)}),
        activeItems: activeItems.length,
        chatTail: body.slice(-1200),
      };
    }
    return ok;
  })`;
}

async function selectWorkspaceAndAssert(cdp, workspaceName, conversationId, includePrompt, includeReply, excludePrompt, excludeReply, label) {
  await evaluate(cdp, `window.api.selectWorkspace(${js(workspaceName)}).then(() => window.refreshWorkspaceState()).then(() => { window.selectWorkspace(${js(workspaceName)}); return true; })`, 30000);
  await waitFor(cdp, `window.api.getState(${js(conversationId)}).then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === ${js(workspaceName)})`, 30000, `${label} backend workspace selected`);
  await waitFor(cdp, workspaceVisibleExpression(workspaceName, conversationId, includePrompt, includeReply, excludePrompt, excludeReply), 30000, label);
}

async function sendInWorkspace(cdp, workspaceName, promptText, replyText) {
  await evaluate(cdp, `window.api.createWorkspace(${js(workspaceName)}).then(ws => window.api.selectWorkspace(ws.name))`, 30000);
  await evaluate(cdp, `window.refreshWorkspaceState().then(() => window.selectWorkspace(${js(workspaceName)}))`, 30000);
  await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === ${js(workspaceName)})`, 30000, `${workspaceName} selected`);
  await evaluate(cdp, `window.setInputMode && window.setInputMode('guide')`, 30000);
  await evaluate(cdp, `(() => {
    const prompt = document.querySelector('#prompt');
    if (!prompt) throw new Error('prompt missing');
    prompt.value = ${js(promptText)};
    window.sendMessage();
    return true;
  })()`, 30000);
  await waitFor(cdp, `(() => (document.querySelector('#chat-area')?.innerText || '').includes(${js(replyText)}) && !(window.state && window.state._sendInFlight))()`, 45000, `${workspaceName} reply visible`);
  return evaluate(cdp, `window.api.getState(activeConversationId()).then(s => s.conversationId)`, 30000);
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
    ], { encoding: 'utf8', windowsHide: true });
    log('warning: cleaned packaged Newmark release process residue after smoke');
  }
}

async function runUiCheck(root) {
  const mock = await startMockServer();
  writeConfig(root, mock.port);
  const port = Number(process.env.NEWMARK_UI_WORKSPACE_CONVERSATION_ISOLATION_PORT || '49378');
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
    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.sendMessage && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');

    const convA = await sendInWorkspace(cdp, workspaceA, markerAPrompt, markerAReply);
    log(`${workspaceA} ready: ${convA}`);
    const convB = await sendInWorkspace(cdp, workspaceB, markerBPrompt, markerBReply);
    log(`${workspaceB} ready: ${convB}`);
    if (convA !== convB) fail(`default conversation IDs should match across separate workspaces for this isolation check: ${convA} vs ${convB}`);

    await selectWorkspaceAndAssert(cdp, workspaceA, convA, markerAPrompt, markerAReply, markerBPrompt, markerBReply, 'workspace A isolated before rapid switching');
    await selectWorkspaceAndAssert(cdp, workspaceB, convB, markerBPrompt, markerBReply, markerAPrompt, markerAReply, 'workspace B isolated before rapid switching');
    for (let i = 0; i < 16; i++) {
      if (i % 2 === 0) {
        await selectWorkspaceAndAssert(cdp, workspaceA, convA, markerAPrompt, markerAReply, markerBPrompt, markerBReply, `rapid workspace switch ${i + 1} A isolation`);
      } else {
        await selectWorkspaceAndAssert(cdp, workspaceB, convB, markerBPrompt, markerBReply, markerAPrompt, markerAReply, `rapid workspace switch ${i + 1} B isolation`);
      }
      await sleep(70);
    }

    await selectWorkspaceAndAssert(cdp, workspaceA, convA, markerAPrompt, markerAReply, markerBPrompt, markerBReply, 'final workspace A visual isolation');
    await captureScreenshot(cdp, screenshotAPath);
    await selectWorkspaceAndAssert(cdp, workspaceB, convB, markerBPrompt, markerBReply, markerAPrompt, markerAReply, 'final workspace B visual isolation');
    await captureScreenshot(cdp, screenshotBPath);

    const postCount = mock.requests.filter(r => r.method === 'POST' && r.url === '/v1/chat/completions').length;
    if (postCount < 2) fail(`mock provider did not receive both workspace requests: ${postCount}`);
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    try { mock.server.close(); } catch {}
    ensureNoReleaseProcess();
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkWorkspaceConversationIsolationSmoke-'));
  try {
    await runUiCheck(root);
    log('all workspace/conversation isolation release UI smoke checks passed');
  } finally {
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[release-ui-workspace-conversation-isolation-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
