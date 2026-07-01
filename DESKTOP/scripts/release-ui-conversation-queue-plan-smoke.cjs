const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-conversation-queue-plan-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_CONVERSATION_QUEUE_PLAN_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-conversation-queue-plan-smoke] ${message}`);
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
        const debugValue = await evaluate(cdp, `window.__queueDrainDebug || null`, 10000);
        if (debugValue) lastValue = debugValue;
      } catch {}
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(300);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
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
    { params: { format: 'png', fromSurface: true }, timeout: 30000 },
    { params: { format: 'png', fromSurface: false }, timeout: 30000 },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const screenshot = await cdp.call('Page.captureScreenshot', attempt.params, attempt.timeout);
      if (!screenshot?.data) throw new Error('empty screenshot data');
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
      log(`screenshot ${screenshotPath}`);
      return;
    } catch (error) {
      errors.push(error.message);
    }
  }
  log(`warning: screenshot capture failed after functional pass: ${errors.join(' | ')}`);
}

function sendSse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  let totalDelay = 0;
  for (const chunk of chunks) {
    if (chunk && chunk.delay) totalDelay += chunk.delay;
    const payload = chunk && chunk.payload ? chunk.payload : chunk;
    setTimeout(() => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }, totalDelay);
  }
  setTimeout(() => {
    res.end('data: [DONE]\n\n');
  }, totalDelay + 20);
}

function textChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

function delayedTextChunk(text, delay) {
  return { delay, payload: textChunk(text) };
}

function toolCallChunk(id, name, args) {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  };
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
        res.end(JSON.stringify({ data: [{ id: 'release-ui-conversation-mock' }] }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'RELEASE_UI_CONVERSATION_VALIDATE_OK' } }] }));
        return;
      }

      if (messagesText.includes('QUEUE_SECOND_AUTO_BUILD')) {
        sendSse(res, [textChunk('QUEUE_SECOND_DONE_20260628')]);
        return;
      }
      if (messagesText.includes('QUEUE_FIRST_LOCK_TEST')) {
        setTimeout(() => sendSse(res, [textChunk('QUEUE_FIRST_DONE_20260628')]), 1800);
        return;
      }
      if (messagesText.includes('LONG_PARALLEL_CONV_A_TOOL_RESULT_20260701')) {
        sendSse(res, [
          delayedTextChunk('LONG_PARALLEL_CONV_A_DONE_20260701', 500),
        ]);
        return;
      }
      if (messagesText.includes('LONG_PARALLEL_CONV_B_TOOL_RESULT_20260701')) {
        sendSse(res, [
          delayedTextChunk('LONG_PARALLEL_CONV_B_DONE_20260701', 500),
        ]);
        return;
      }
      if (messagesText.includes('LONG_PARALLEL_CONV_A_20260701')) {
        sendSse(res, [
          delayedTextChunk('LONG_PARALLEL_CONV_A_STREAM_START_20260701 ', 1000),
          delayedTextChunk('LONG_PARALLEL_CONV_A_STREAM_MID_20260701 ', 2000),
          { delay: 3000, payload: toolCallChunk('call-long-a', 'bash', { command: 'Write-Output LONG_PARALLEL_CONV_A_TOOL_RESULT_20260701', timeout_ms: 30000 }) },
        ]);
        return;
      }
      if (messagesText.includes('LONG_PARALLEL_CONV_B_20260701')) {
        sendSse(res, [
          delayedTextChunk('LONG_PARALLEL_CONV_B_STREAM_START_20260701 ', 1000),
          delayedTextChunk('LONG_PARALLEL_CONV_B_STREAM_MID_20260701 ', 2000),
          { delay: 3000, payload: toolCallChunk('call-long-b', 'bash', { command: 'Write-Output LONG_PARALLEL_CONV_B_TOOL_RESULT_20260701', timeout_ms: 30000 }) },
        ]);
        return;
      }
      if (messagesText.includes('PARALLEL_CONV_B_20260701')) {
        setTimeout(() => sendSse(res, [textChunk('PARALLEL_CONV_B_DONE_20260701')]), 900);
        return;
      }
      if (messagesText.includes('PARALLEL_CONV_A_20260701')) {
        setTimeout(() => sendSse(res, [textChunk('PARALLEL_CONV_A_DONE_20260701')]), 1800);
        return;
      }
      sendSse(res, [textChunk('CONVERSATION_DEFAULT_OK_20260628')]);
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
        name: 'ReleaseUiConversationMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-ui-conversation-mock',
          display: 'release-ui-conversation-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-ui-conversation-mock',
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

async function runUiCheck(root) {
  const mock = await startMockServer();
  writeConfig(root, mock.port);
  const port = Number(process.env.NEWMARK_UI_CONVERSATION_QUEUE_PLAN_SMOKE_PORT || '49351');
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
    await evaluate(cdp, `window.api.createWorkspace('conversation-queue-plan-workspace').then(ws => window.api.selectWorkspace(ws.name))`, 30000);
    await evaluate(cdp, `window.selectWorkspace('conversation-queue-plan-workspace')`, 30000);
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === 'conversation-queue-plan-workspace')`, 30000, 'workspace selected');

    await evaluate(cdp, `window.switchRightTab('plan')`, 30000);
    await waitFor(cdp, `(() => !!document.querySelector('#conversation-plan-input'))()`, 30000, 'plan panel visible');
    await evaluate(cdp, `(() => {
      document.querySelector('#conversation-plan-input').value = 'PLAN_ITEM_CONV1_20260628';
      window.addConversationPlanItem();
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.api.getConversationPlan().then(p => p.items && p.items.some(i => i.text === 'PLAN_ITEM_CONV1_20260628'))`, 30000, 'conversation 1 plan persisted');
    log('conversation 1 plan persisted');

    await evaluate(cdp, `window.newConversation()`, 30000);
    await waitFor(cdp, `window.api.getConversationPlan().then(p => p.items && p.items.length === 0)`, 30000, 'new conversation empty plan');
    await evaluate(cdp, `window.switchRightTab('plan')`, 30000);
    await evaluate(cdp, `(() => {
      document.querySelector('#conversation-plan-input').value = 'PLAN_ITEM_CONV2_20260628';
      window.addConversationPlanItem();
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.api.getConversationPlan().then(p => p.items && p.items.some(i => i.text === 'PLAN_ITEM_CONV2_20260628'))`, 30000, 'conversation 2 plan persisted');
    log('conversation 2 plan persisted');

    await evaluate(cdp, `window.switchConversation(0)`, 30000);
    await waitFor(cdp, `window.api.getConversationPlan().then(p => {
      const text = (p.items || []).map(i => i.text).join('\\n');
      return text.includes('PLAN_ITEM_CONV1_20260628') && !text.includes('PLAN_ITEM_CONV2_20260628');
    })`, 30000, 'conversation 1 plan restored without conversation 2 leakage');
    log('conversation plan isolation ok');

    await evaluate(cdp, `window.switchConversation(0)`, 30000);
    const convA = await evaluate(cdp, `window.api.getState().then(s => s.conversationId)`, 30000);
    await evaluate(cdp, `(() => {
      window.setInputMode('guide');
      const prompt = document.querySelector('#prompt');
      prompt.value = 'PARALLEL_CONV_A_20260701';
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => window.state && window.state.runningConversations && window.state.runningConversations[${JSON.stringify(convA)}] === true)()`, 10000, 'conversation A send in flight');
    await evaluate(cdp, `window.switchConversation(1)`, 30000);
    const convB = await evaluate(cdp, `window.api.getState().then(s => s.conversationId)`, 30000);
    if (convB === convA) fail(`conversation did not switch during active turn: ${convA}`);
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      prompt.value = 'PARALLEL_CONV_B_20260701';
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => window.state && window.state.runningConversations && window.state.runningConversations[${JSON.stringify(convB)}] === true)()`, 10000, 'conversation B send in flight');
    await waitFor(cdp, `(() => (document.querySelector('#chat-area')?.innerText || '').includes('PARALLEL_CONV_B_DONE_20260701'))()`, 45000, 'conversation B result visible while A was running');
    await evaluate(cdp, `(() => {
      const idx = (window.state.conversations || []).findIndex(c => c.id === ${JSON.stringify(convA)});
      if (idx < 0) throw new Error('conversation A missing after parallel run');
      window.switchConversation(idx);
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => {
      const body = document.querySelector('#chat-area')?.innerText || '';
      return body.includes('PARALLEL_CONV_A_DONE_20260701') && !body.includes('PARALLEL_CONV_B_DONE_20260701');
    })()`, 45000, 'conversation A result isolated from B');
    log('parallel conversation execution and isolation ok');

    await evaluate(cdp, `(() => {
      const idx = (window.state.conversations || []).findIndex(c => c.id === ${JSON.stringify(convA)});
      if (idx < 0) throw new Error('conversation A missing before long parallel run');
      window.switchConversation(idx);
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.api.getState().then(s => s.conversationId === ${JSON.stringify(convA)})`, 30000, 'conversation A selected before long run');
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      prompt.value = 'LONG_PARALLEL_CONV_A_20260701';
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => window.state && window.state.runningConversations && window.state.runningConversations[${JSON.stringify(convA)}] === true)()`, 10000, 'long conversation A running');
    await waitFor(cdp, `(() => (document.querySelector('#chat-area')?.innerText || '').includes('LONG_PARALLEL_CONV_A_STREAM_START_20260701'))()`, 20000, 'long conversation A stream visible in foreground');
    await evaluate(cdp, `(() => {
      const idx = (window.state.conversations || []).findIndex(c => c.id === ${JSON.stringify(convB)});
      if (idx < 0) throw new Error('conversation B missing before long parallel run');
      window.switchConversation(idx);
      return true;
    })()`, 30000);
    await waitFor(cdp, `window.api.getState().then(s => s.conversationId === ${JSON.stringify(convB)})`, 30000, 'conversation B selected during long A run');
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      prompt.value = 'LONG_PARALLEL_CONV_B_20260701';
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => window.state && window.state.runningConversations && window.state.runningConversations[${JSON.stringify(convA)}] === true && window.state.runningConversations[${JSON.stringify(convB)}] === true)()`, 10000, 'long conversations A and B running together');
    await waitFor(cdp, `(() => {
      const events = window.getAgentWorkEvents(${JSON.stringify(convA)});
      const text = events.map(e => [e.type, e.content || '', e.toolName || '', e.toolArgs || ''].join(' ')).join('\\n');
      return text.includes('LONG_PARALLEL_CONV_A_STREAM_START_20260701') && text.includes('Preparing model request and available tools.');
    })()`, 20000, 'background conversation A work events cached while B is foreground');
    await evaluate(cdp, `(() => {
      const idx = (window.state.conversations || []).findIndex(c => c.id === ${JSON.stringify(convA)});
      window.switchConversation(idx);
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => {
      const body = document.querySelector('#chat-area')?.innerText || '';
      return body.includes('LONG_PARALLEL_CONV_A_STREAM_START_20260701') && body.includes('Preparing model request and available tools.');
    })()`, 20000, 'background conversation A work process replayed when opened');
    await waitFor(cdp, `(() => {
      const events = window.getAgentWorkEvents(${JSON.stringify(convA)});
      const text = events.map(e => [e.type, e.content || '', e.toolName || '', e.toolArgs || ''].join(' ')).join('\\n');
      return text.includes('bash') && text.includes('LONG_PARALLEL_CONV_A_TOOL_RESULT_20260701');
    })()`, 30000, 'background conversation A tool call and result cached');
    await waitFor(cdp, `(() => (document.querySelector('#chat-area')?.innerText || '').includes('LONG_PARALLEL_CONV_A_DONE_20260701'))()`, 45000, 'long conversation A completed visibly');
    await evaluate(cdp, `(() => {
      const idx = (window.state.conversations || []).findIndex(c => c.id === ${JSON.stringify(convB)});
      window.switchConversation(idx);
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => {
      const body = document.querySelector('#chat-area')?.innerText || '';
      return body.includes('LONG_PARALLEL_CONV_B_DONE_20260701') &&
        body.includes('Tool bash result') &&
        body.includes('LONG_PARALLEL_CONV_B_TOOL_RESULT_20260701') &&
        !body.includes('LONG_PARALLEL_CONV_A_DONE_20260701');
    })()`, 45000, 'long conversation B completed with persisted tool process and no A leakage');
    await evaluate(cdp, `(() => {
      const idx = (window.state.conversations || []).findIndex(c => c.id === ${JSON.stringify(convA)});
      window.switchConversation(idx);
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => {
      const body = document.querySelector('#chat-area')?.innerText || '';
      return body.includes('Agent started working.') &&
        body.includes('Preparing model request and available tools.') &&
        body.includes('Executing 1 tool call.') &&
        body.includes('Tool bash result') &&
        body.includes('LONG_PARALLEL_CONV_A_DONE_20260701') &&
        !body.includes('LONG_PARALLEL_CONV_B_DONE_20260701');
    })()`, 45000, 'long conversation A persisted complete work process and isolation');
    log('long-running parallel work event visibility and persisted process ok');

    await evaluate(cdp, `(() => {
      const idx = (window.state.conversations || []).findIndex(c => c.id === ${JSON.stringify(convA)});
      if (idx < 0) throw new Error('conversation A missing before queue test');
      window.switchConversation(idx);
      return true;
    })()`, 30000);
    await evaluate(cdp, `(() => {
      window.setInputMode('guide');
      const prompt = document.querySelector('#prompt');
      prompt.value = 'QUEUE_FIRST_LOCK_TEST';
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => window.state && window.state._sendInFlight === true)()`, 10000, 'queue first send in flight');
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      prompt.value = 'QUEUE_SECOND_AUTO_BUILD';
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => {
      const badge = document.querySelector('#next-queue-count');
      return badge && badge.textContent.includes('1') && document.body.innerText.includes('[Guide queued] QUEUE_SECOND_AUTO_BUILD');
    })()`, 10000, 'queued input visible');
    await waitFor(cdp, `(() => {
      const body = document.querySelector('#chat-area')?.innerText || '';
      const badge = document.querySelector('#next-queue-count');
      const state = window.state || {};
      const ok = body.includes('QUEUE_FIRST_DONE_20260628') && body.includes('QUEUE_SECOND_DONE_20260628') && !badge && state._sendInFlight === false;
      if (!ok) {
        window.__queueDrainDebug = {
          hasFirst: body.includes('QUEUE_FIRST_DONE_20260628'),
          hasSecond: body.includes('QUEUE_SECOND_DONE_20260628'),
          hasQueuedPrompt: body.includes('QUEUE_SECOND_AUTO_BUILD'),
          badge: badge ? badge.textContent : '',
          sendInFlight: state._sendInFlight,
          runningKeys: Object.keys(state.runningConversations || {}),
          nextQueue: state.nextQueue || [],
          conversationId: state.conversationId,
          bodyTail: body.slice(-1200),
        };
      }
      return ok;
    })()`, 45000, 'queued turn drained into next Build turn');
    log('input queue drain ok');

    await evaluate(cdp, `window.switchConversation(1)`, 30000);
    await waitFor(cdp, `window.api.getConversationPlan().then(p => {
      const text = (p.items || []).map(i => i.text).join('\\n');
      return text.includes('PLAN_ITEM_CONV2_20260628') && !text.includes('PLAN_ITEM_CONV1_20260628');
    })`, 30000, 'conversation 2 plan restored');
    await waitFor(cdp, `(() => {
      const body = document.querySelector('#chat-area')?.innerText || '';
      return !body.includes('QUEUE_FIRST_DONE_20260628') && !body.includes('QUEUE_SECOND_DONE_20260628');
    })()`, 30000, 'conversation 2 chat isolated from queued conversation 1 results');
    log('conversation chat isolation after queued turn ok');

    await captureScreenshot(cdp);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkConversationQueuePlanSmoke-'));
  try {
    await runUiCheck(root);
    log('all conversation queue/plan release UI smoke checks passed');
  } finally {
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`[release-ui-conversation-queue-plan-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
