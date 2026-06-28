const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-28-release-ui-option-feedback-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_OPTION_FEEDBACK_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-option-feedback-smoke] ${message}`);
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

function markerFromMessages(messages) {
  const markers = ['OPTION_SMOKE_DEFAULT', 'OPTION_SMOKE_ASK_MORE', 'OPTION_SMOKE_ASK_LESS', 'OPTION_SMOKE_FULLY_AUTONOMOUS', 'OPTION_SMOKE_PERMISSION_ASK'];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    const content = typeof messages[i].content === 'string' ? messages[i].content : JSON.stringify(messages[i].content || '');
    for (const marker of markers) {
      if (content.includes(marker)) return marker;
    }
  }
  return 'OPTION_SMOKE_UNKNOWN';
}

function startMockServer(outsidePath) {
  const requests = [];
  const toolOrder = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const messagesText = JSON.stringify(messages);

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'release-ui-option-feedback-mock' }] }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'RELEASE_UI_OPTION_FEEDBACK_VALIDATE_OK' } }] }));
        return;
      }

      const marker = markerFromMessages(messages);
      const lastMessage = messages.length ? messages[messages.length - 1] : {};
      const lastContent = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content || '');
      if (lastMessage.role === 'tool' && lastContent.includes('[Options sent]')) {
        sendSse(res, [textChunk(`${marker}_FINAL options delivered`)]);
        return;
      }
      if (lastMessage.role === 'tool' && lastContent.includes('Disabled by fully_autonomous option feedback')) {
        sendSse(res, [textChunk('OPTION_SMOKE_FULLY_AUTONOMOUS_FINAL disabled')]);
        return;
      }
      if (lastMessage.role === 'tool' && lastContent.includes('User approval required')) {
        sendSse(res, [textChunk('OPTION_SMOKE_PERMISSION_ASK_FINAL User approval required')]);
        return;
      }

      if (marker === 'OPTION_SMOKE_PERMISSION_ASK') {
        toolOrder.push('write');
        sendSse(res, [toolCallChunk(`call_${toolOrder.length}_write`, 'write', {
          path: outsidePath,
          content: 'should not be written',
        })]);
        return;
      }

      toolOrder.push('question');
      sendSse(res, [toolCallChunk(`call_${toolOrder.length}_question`, 'question', {
        questions: [{
          header: marker.replace('OPTION_SMOKE_', ''),
          question: `${marker}: choose a path`,
          options: [
            { label: `${marker}_ALLOW`, description: 'Approve this action' },
            { label: `${marker}_DENY`, description: 'Reject this action' },
          ],
        }],
      })]);
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
        name: 'ReleaseUiOptionFeedbackMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-ui-option-feedback-mock',
          display: 'release-ui-option-feedback-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-ui-option-feedback-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'default' },
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
    fail('release UI option feedback smoke left a packaged Newmark process running');
  }
}

async function setFeedback(cdp, level) {
  await evaluate(cdp, `window.api.saveSetting('agent', 'option_feedback', ${JSON.stringify(level)})`, 15000);
  await waitFor(cdp, `window.api.getState().then(s => s.feedback === ${JSON.stringify(level)})`, 15000, `feedback ${level}`);
}

async function setWorkspacePolicy(cdp, access, violation) {
  await evaluate(cdp, `Promise.all([
    window.api.saveSetting('workspace', 'access_permission', ${JSON.stringify(access)}),
    window.api.saveSetting('workspace', 'on_permission_violation', ${JSON.stringify(violation)})
  ])`, 15000);
  await waitFor(cdp, `window.api.getState().then(s => s.accessPerm === ${JSON.stringify(access)})`, 15000, `access ${access}`);
}

async function sendPrompt(cdp, prompt) {
  await evaluate(cdp, `(() => {
    const el = document.getElementById('prompt');
    el.value = ${JSON.stringify(prompt)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    window.sendMessage();
    return true;
  })()`, 15000);
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI option feedback smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiOptionRoot-'));
  const outsidePath = path.join(os.tmpdir(), `NewmarkOptionOutside-${Date.now()}.txt`);
  const mock = await startMockServer(outsidePath);
  writeConfig(root, mock.port);

  const port = Number(process.env.NEWMARK_UI_OPTION_FEEDBACK_PORT || '49370');
  let child;
  let cdp;
  let completed = false;
  try {
    ({ child, cdp } = await launch(root, port));
    await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.isInternal === true)`, 30000, 'initial workspace');
    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.sendMessage && !!window.switchRightTab && !!window.renderRightStatusPanel)()`, 30000, 'renderer send and status functions');

    const levels = [
      ['default', 'OPTION_SMOKE_DEFAULT'],
      ['ask_more', 'OPTION_SMOKE_ASK_MORE'],
      ['ask_less', 'OPTION_SMOKE_ASK_LESS'],
    ];
    for (const [level, marker] of levels) {
      await setFeedback(cdp, level);
      await sendPrompt(cdp, `${marker} trigger question`);
      await waitFor(cdp, `window.api.getState().then(s => (s.pendingOptions || []).some(q => String(q.question || '').includes(${JSON.stringify(marker)})))`, 45000, `${level} pending option`);
      await waitFor(cdp, `(() => document.body.innerText.includes(${JSON.stringify(marker + '_ALLOW')}) && document.body.innerText.includes('Approve this action'))()`, 30000, `${level} visible option block`);
      log(`${level} option prompt ok`);
    }

    await evaluate(cdp, `window.switchRightTab('status')`, 15000);
    await waitFor(cdp, `(() => document.getElementById('right-status-content')?.innerText.includes('Pending options') && document.getElementById('right-status-content')?.innerText.includes('OPTION_SMOKE_ASK_LESS_ALLOW'))()`, 30000, 'right status pending options');
    log('right status pending options ok');

    await setFeedback(cdp, 'fully_autonomous');
    await sendPrompt(cdp, 'OPTION_SMOKE_FULLY_AUTONOMOUS trigger disabled question');
    await waitFor(cdp, `(() => document.body.innerText.includes('Disabled by fully_autonomous option feedback') && document.body.innerText.includes('OPTION_SMOKE_FULLY_AUTONOMOUS_FINAL'))()`, 45000, 'fully autonomous disabled visible result');
    const afterFullyAutonomous = await evaluate(cdp, `window.api.getState().then(s => (s.pendingOptions || []).length)`, 15000);
    if (afterFullyAutonomous !== 0) fail(`fully_autonomous left pending options: ${afterFullyAutonomous}`);
    log('fully autonomous question disabled ok');

    await setFeedback(cdp, 'default');
    await setWorkspacePolicy(cdp, 'outside_readonly', 'ask_user');
    await sendPrompt(cdp, 'OPTION_SMOKE_PERMISSION_ASK trigger outside write');
    await waitFor(cdp, `(() => document.body.innerText.includes('User approval required') && document.body.innerText.includes('OPTION_SMOKE_PERMISSION_ASK_FINAL'))()`, 45000, 'ask_user permission violation visible result');
    if (fs.existsSync(outsidePath)) fail(`outside file was written despite ask_user permission block: ${outsidePath}`);
    log('ask_user permission violation ok');

    await captureScreenshot(cdp);
    log('all release UI option feedback checks passed');
    completed = true;
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    stopChild(child);
    await sleep(1000);
    mock.server.close();
    if (keepRoot) log(`kept root: ${root}; outside path: ${outsidePath}`);
    else {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsidePath, { force: true });
    }
    ensureNoReleaseProcess();
    if (!completed) log('cleanup complete after failed option feedback smoke');
  }
})().catch(error => {
  console.error(`[release-ui-option-feedback-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
