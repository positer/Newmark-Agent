const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotAPath = path.join(repoRoot, 'archive', '2026-07-04-release-ui-fast-conversation-switch-a.png');
const screenshotBPath = path.join(repoRoot, 'archive', '2026-07-04-release-ui-fast-conversation-switch-b.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_FAST_CONVERSATION_SWITCH_SMOKE === '1';

const markerAPrompt = 'FAST_SWITCH_CONV_A_PROMPT_20260704';
const markerAReply = 'FAST_SWITCH_CONV_A_REPLY_20260704';
const markerBPrompt = 'FAST_SWITCH_CONV_B_PROMPT_20260704';
const markerBReply = 'FAST_SWITCH_CONV_B_REPLY_20260704';

function log(message) {
  console.log(`[release-ui-fast-conversation-switch-smoke] ${message}`);
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
      try {
        const debugValue = await evaluate(cdp, `window.__fastSwitchDebug || null`, 10000);
        if (debugValue) lastValue = debugValue;
      } catch {}
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(200);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

function jsString(value) {
  return JSON.stringify(String(value));
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
      assertPngScreenshot(buffer, filePath);
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

function assertPngScreenshot(buffer, filePath) {
  if (buffer.length < 32) fail(`screenshot too small: ${filePath}`);
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    fail(`screenshot is not a PNG: ${filePath}`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1200 || height < 700) fail(`screenshot dimensions too small: ${filePath} ${width}x${height}`);
  if (buffer.length < 50000) fail(`screenshot appears blank or truncated: ${filePath} bytes=${buffer.length}`);
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
      const messagesText = JSON.stringify(parsed.messages || []);

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'release-ui-fast-switch-mock' }] }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      const reply = messagesText.includes(markerAPrompt) ? markerAReply
        : messagesText.includes(markerBPrompt) ? markerBReply
          : 'FAST_SWITCH_DEFAULT_REPLY_20260704';
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
        name: 'ReleaseUiFastSwitchMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-ui-fast-switch-mock',
          display: 'release-ui-fast-switch-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-ui-fast-switch-mock',
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

function activeChatIsolationExpression(expectedId, includePrompt, includeReply, excludePrompt, excludeReply) {
  return `window.api.getState(${jsString(expectedId)}).then(s => {
    const chat = document.querySelector('#chat-area');
    const body = chat?.innerText || '';
    const activeItems = Array.from(document.querySelectorAll('#conversation-list .conv-item.active'));
    const ok = s && s.conversationId === ${jsString(expectedId)} &&
      body.includes(${jsString(includePrompt)}) &&
      body.includes(${jsString(includeReply)}) &&
      !body.includes(${jsString(excludePrompt)}) &&
      !body.includes(${jsString(excludeReply)}) &&
      activeItems.length === 1;
    if (!ok) {
      window.__fastSwitchDebug = {
        expectedId: ${jsString(expectedId)},
        actualId: s && s.conversationId,
        hasIncludePrompt: body.includes(${jsString(includePrompt)}),
        hasIncludeReply: body.includes(${jsString(includeReply)}),
        leakedExcludePrompt: body.includes(${jsString(excludePrompt)}),
        leakedExcludeReply: body.includes(${jsString(excludeReply)}),
        activeItems: activeItems.length,
        activeConversationId: typeof activeConversationId === 'function' ? activeConversationId() : '',
        conversationLoadGeneration: window.state && window.state.conversationLoadGeneration,
        backendMessages: (s && s.chatMessages || []).map(m => String(m && m.content || '')).slice(-6),
        chatTail: body.slice(-1200),
      };
    }
    return ok;
  })`;
}

async function selectConversationAndAssert(cdp, expectedId, includePrompt, includeReply, excludePrompt, excludeReply, label) {
  await evaluate(cdp, `(() => {
    const idx = (window.state?.conversations || []).findIndex(c => c && c.id === ${jsString(expectedId)});
    if (idx < 0) throw new Error('conversation missing before switch: ' + ${jsString(expectedId)});
    window.switchConversation(idx);
    return true;
  })()`, 30000);
  await waitFor(cdp, activeChatIsolationExpression(expectedId, includePrompt, includeReply, excludePrompt, excludeReply), 30000, label);
}

async function assertInputToolbarFits(cdp, width) {
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  }, 10000);
  await sleep(250);
  const geometry = await evaluate(cdp, `(() => {
    const rect = selector => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, width: value.width } : null;
    };
    const area = rect('#input-area');
    const tools = rect('#input-tools');
    const model = rect('#model-select');
    const submit = rect('#submit-btn');
    return { area, tools, model, submit, viewport: innerWidth };
  })()`, 30000);
  if (!geometry?.area || !geometry?.model || !geometry?.submit ||
      geometry.model.width < 70 || geometry.submit.right > geometry.area.right + 1 ||
      geometry.submit.left < geometry.model.right - 1) {
    fail(`input toolbar overflow at ${width}px: ${JSON.stringify(geometry)}`);
  }
  log(`input toolbar ${width}px ok: model=${Math.round(geometry.model.width)} submitRight=${Math.round(geometry.submit.right)} areaRight=${Math.round(geometry.area.right)}`);
}

async function runUiCheck(root) {
  const mock = await startMockServer();
  writeConfig(root, mock.port);
  const port = Number(process.env.NEWMARK_UI_FAST_CONVERSATION_SWITCH_SMOKE_PORT || '49374');
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
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.sendMessage && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');
    await evaluate(cdp, `window.api.createWorkspace('fast-switch-isolation-workspace').then(ws => window.api.selectWorkspace(ws.name))`, 30000);
    await evaluate(cdp, `window.selectWorkspace('fast-switch-isolation-workspace')`, 30000);
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === 'fast-switch-isolation-workspace')`, 30000, 'workspace selected');

    await evaluate(cdp, `window.setInputMode && window.setInputMode('guide')`, 30000);
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('prompt missing for conversation A');
      prompt.value = ${jsString(markerAPrompt)};
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => (document.querySelector('#chat-area')?.innerText || '').includes(${jsString(markerAReply)}) && !(window.state && window.state._sendInFlight))()`, 45000, 'conversation A reply visible');
    const convA = await evaluate(cdp, `window.api.getState(activeConversationId()).then(s => s.conversationId)`, 30000);
    log(`conversation A ready: ${convA}`);

    await evaluate(cdp, `window.newConversation()`, 30000);
    await waitFor(cdp, `window.api.getState(activeConversationId()).then(s => s.conversationId !== ${jsString(convA)})`, 30000, 'conversation B created');
    const convB = await evaluate(cdp, `window.api.getState(activeConversationId()).then(s => s.conversationId)`, 30000);
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('prompt missing for conversation B');
      prompt.value = ${jsString(markerBPrompt)};
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => (document.querySelector('#chat-area')?.innerText || '').includes(${jsString(markerBReply)}) && !(window.state && window.state._sendInFlight))()`, 45000, 'conversation B reply visible');
    log(`conversation B ready: ${convB}`);

    await selectConversationAndAssert(cdp, convA, markerAPrompt, markerAReply, markerBPrompt, markerBReply, 'conversation A isolated before rapid switching');
    await selectConversationAndAssert(cdp, convB, markerBPrompt, markerBReply, markerAPrompt, markerAReply, 'conversation B isolated before rapid switching');

    await evaluate(cdp, `(() => {
      const originalGetState = window.api.getState.bind(window.api);
      window.api.getState = function(id) {
        const result = originalGetState(id);
        return String(id || '') === ${jsString(convA)}
          ? new Promise((resolve, reject) => setTimeout(() => result.then(resolve, reject), 900))
          : result;
      };
      const idxA = window.state.conversations.findIndex(c => c.id === ${jsString(convA)});
      const idxB = window.state.conversations.findIndex(c => c.id === ${jsString(convB)});
      window.switchConversation(idxA);
      setTimeout(() => window.switchConversation(idxB), 20);
      return true;
    })()`, 30000);
    await sleep(1400);
    await waitFor(cdp, activeChatIsolationExpression(convB, markerBPrompt, markerBReply, markerAPrompt, markerAReply), 15000, 'stale delayed conversation A response cannot overwrite conversation B');
    log('out-of-order conversation state response isolation ok');

    const order = [];
    for (let i = 0; i < 20; i++) order.push(i % 2 === 0 ? 0 : 1);
    for (let i = 0; i < order.length; i++) {
      const idx = order[i];
      if (idx === 0) {
        await selectConversationAndAssert(cdp, convA, markerAPrompt, markerAReply, markerBPrompt, markerBReply, `rapid switch ${i + 1} conversation A visual isolation`);
      } else {
        await selectConversationAndAssert(cdp, convB, markerBPrompt, markerBReply, markerAPrompt, markerAReply, `rapid switch ${i + 1} conversation B visual isolation`);
      }
      await sleep(60);
    }
    log('rapid switch-back visual isolation ok');

    await selectConversationAndAssert(cdp, convA, markerAPrompt, markerAReply, markerBPrompt, markerBReply, 'final conversation A visual isolation');
    await captureScreenshot(cdp, screenshotAPath);
    await selectConversationAndAssert(cdp, convB, markerBPrompt, markerBReply, markerAPrompt, markerAReply, 'final conversation B visual isolation');
    await captureScreenshot(cdp, screenshotBPath);

    await assertInputToolbarFits(cdp, 560);
    await assertInputToolbarFits(cdp, 430);
    await cdp.call('Emulation.clearDeviceMetricsOverride', {}, 10000).catch(() => undefined);

    await evaluate(cdp, `window.api.archive(${jsString(convA)})`, 30000);
    await waitFor(cdp, `window.api.getState(${jsString(convB)}).then(s => !((s && s.conversations) || []).some(c => c.id === ${jsString(convA)}))`, 30000, 'archived conversation removed from backend registry');
    await evaluate(cdp, `loadActiveConversationMessages(${jsString(convB)})`, 30000);
    await waitFor(cdp, `(() => !(window.state?.conversations || []).some(c => c.id === ${jsString(convA)}))()`, 30000, 'archived conversation removed from renderer list');
    log('archived conversation removal ok');

    if (cdp?.ws) cdp.ws.close();
    cdp = null;
    if (child && !child.killed) child.kill();
    child = null;
    await sleep(1200);
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const restartTarget = await waitForTarget(port);
    cdp = connectCdp(restartTarget);
    await cdp.ready;
    await cdp.call('Runtime.enable');
    await waitFor(cdp, `window.api.getState(${jsString(convB)}).then(s => !((s && s.conversations) || []).some(c => c.id === ${jsString(convA)}) && ((s && s.conversations) || []).some(c => c.id === ${jsString(convB)}))`, 30000, 'archived conversation remains removed after restart');
    log('archived conversation restart persistence ok');

    if (mock.requests.filter(r => r.method === 'POST' && r.url === '/v1/chat/completions').length < 2) {
      fail('mock provider did not receive both conversation requests');
    }
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    try { mock.server.close(); } catch {}
    ensureNoReleaseProcess();
  }
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

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkFastConversationSwitchSmoke-'));
  try {
    await runUiCheck(root);
    log('all fast conversation switch release UI smoke checks passed');
  } finally {
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[release-ui-fast-conversation-switch-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
