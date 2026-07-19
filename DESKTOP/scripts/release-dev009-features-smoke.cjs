const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = process.env.NEWMARK_TEST_EXE
  ? path.resolve(process.env.NEWMARK_TEST_EXE)
  : path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const modelName = 'release-dev009-native-browser-use-mock';
const keepRoot = process.env.NEWMARK_KEEP_DEV009_FEATURES_SMOKE === '1';
const screenshotWorkRun = path.join(repoRoot, 'archive', '2026-07-13-dev-0.0.9-work-run.png');
const screenshotPdf = path.join(repoRoot, 'archive', '2026-07-13-dev-0.0.9-pdf-browser-use.png');

function log(message) { console.log(`[release-dev009-features-smoke] ${message}`); }
function fail(message) { throw new Error(message); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function js(value) { return JSON.stringify(value); }

async function removeTreeWithRetry(target) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || attempt === 79) throw error;
      await sleep(250);
    }
  }
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function requestUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(300);
  }
  fail('Timed out waiting for packaged renderer CDP target');
}

function connectCdp(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    ws.onclose = event => {
      for (const entry of pending.values()) entry.reject(new Error(`CDP closed: ${event.code}`));
      pending.clear();
    };
  });
  function call(method, params = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 45_000) {
  const response = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (response.exceptionDetails) {
    fail(response.exceptionDetails.exception?.description || response.exceptionDetails.text || JSON.stringify(response.exceptionDetails));
  }
  return response.result?.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(cdp, expression, 15_000);
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(250);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(last).slice(0, 1600)}`);
}

async function captureScreenshot(cdp, filePath) {
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 45_000);
  const buffer = Buffer.from(shot.data || '', 'base64');
  if (buffer.length < 25_000) fail(`Screenshot appears blank: ${buffer.length} bytes`);
  fs.writeFileSync(filePath, buffer);
  log(`screenshot ${filePath} (${buffer.length} bytes)`);
  return buffer;
}

function renderedPdfSurfaceStats(buffer) {
  const png = PNG.sync.read(buffer);
  const ratio = (xStart, xEnd, yStart, yEnd, predicate) => {
    const left = Math.max(0, Math.floor(png.width * xStart));
    const right = Math.min(png.width, Math.ceil(png.width * xEnd));
    const top = Math.max(0, Math.floor(png.height * yStart));
    const bottom = Math.min(png.height, Math.ceil(png.height * yEnd));
    let matching = 0;
    let total = 0;
    for (let y = top; y < bottom; y += 2) {
      for (let x = left; x < right; x += 2) {
        const offset = (png.width * y + x) * 4;
        if (predicate(png.data[offset], png.data[offset + 1], png.data[offset + 2], png.data[offset + 3])) matching += 1;
        total += 1;
      }
    }
    return total ? matching / total : 0;
  };
  const toolbarDarkRatio = ratio(0.72, 0.99, 0.17, 0.24, (r, g, b, a) => a > 200 && r < 90 && g < 90 && b < 90);
  const pageWhiteRatio = ratio(0.72, 0.99, 0.27, 0.82, (r, g, b, a) => a > 200 && r > 235 && g > 235 && b > 235);
  return { toolbarDarkRatio, pageWhiteRatio, ready: toolbarDarkRatio > 0.3 && pageWhiteRatio > 0.25 };
}

function toolResponse(name, args) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  };
}

function textResponse(text) {
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
}

function messageText(message) {
  return typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content || '');
}

function latestBrowserReceipt(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== 'tool') continue;
    const text = messageText(messages[index]);
    try {
      const parsed = JSON.parse(text);
      if (parsed && ['observe', 'click'].includes(parsed.action)) return parsed;
    } catch {}
    const action = text.match(/"action"\s*:\s*"(observe|click)"/)?.[1];
    if (!action) continue;
    return {
      action,
      pageGeneration: Number(text.match(/"pageGeneration"\s*:\s*(\d+)/)?.[1] || 0),
      observationId: text.match(/"observationId"\s*:\s*"([^"]+)"/)?.[1] || '',
      observation: { refs: [] },
    };
  }
  return null;
}

function startFixtureAndProvider() {
  const requests = [];
  let browserObserveCalls = 0;
  let browserClickCalls = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/fixture') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html><head><title>dev009-browser-use-fixture</title><style>
        body{font:16px system-ui;margin:36px;background:#f7f8fb;color:#202531}button,input{display:block;margin:18px 0;padding:10px 16px}
      </style></head><body><h1>Native Browser-Use fixture</h1>
        <input aria-label="Browser name" value="before">
        <button aria-label="Mark Browser Use" onclick="document.querySelector('#status').textContent='DEV009_BROWSER_CLICKED'">Mark Browser Use</button>
        <p id="status">waiting</p></body></html>`);
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const requestRecord = { method: request.method, url: request.url, parsed, response: { state: 'pending' } };
      requests.push(requestRecord);
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: modelName }] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const allText = messages.map(messageText).join('\n');
      const isNewmarkAgentRequest = messages.some(message =>
        message?.role === 'system' && messageText(message).includes('You are Newmark Agent'));
      const requestToolNames = new Set((Array.isArray(parsed.tools) ? parsed.tools : [])
        .map(tool => String(tool?.function?.name || tool?.name || ''))
        .filter(Boolean));
      const send = (payload, delay = 0) => {
        requestRecord.response = { state: 'scheduled', delay, destroyed: response.destroyed, finished: false, closed: false };
        const timer = setTimeout(() => {
          if (response.destroyed) {
            requestRecord.response = { state: 'destroyed-before-send', delay, destroyed: true };
            return;
          }
          const encoded = JSON.stringify(payload);
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(encoded),
            'Connection': 'close',
          });
          response.end(encoded);
          requestRecord.response.state = 'sent';
          requestRecord.response.destroyed = response.destroyed;
        }, delay);
        timer.unref?.();
        response.once('finish', () => { requestRecord.response.finished = true; });
        response.once('close', () => {
          requestRecord.response.closed = true;
          clearTimeout(timer);
        });
        return timer;
      };

      if (isNewmarkAgentRequest && allText.includes('DEV009_FORCE_STOP_B')) {
        const completedBash = messages.some(message => message?.role === 'tool' && message?.name === 'bash');
        if (!completedBash && !requestToolNames.has('bash') && requestToolNames.has('tool_provision')) {
          send(toolResponse('tool_provision', { names: ['bash'] }));
          return;
        }
        if (!completedBash) {
          send(toolResponse('bash', {
            command: "Start-Sleep -Seconds 30; Write-Output 'DEV009_FORCE_STOP_SHOULD_NOT_COMPLETE'",
            timeout_ms: 60_000,
          }), 900);
        } else {
          send(textResponse('DEV009_FORCE_STOP_SHOULD_NOT_COMPLETE'));
        }
        return;
      }
      if (isNewmarkAgentRequest && allText.includes('DEV009_BROWSER_RUN_A')) {
        const receipt = latestBrowserReceipt(messages);
        if (!receipt && !requestToolNames.has('browser_use') && requestToolNames.has('tool_provision')) {
          send(toolResponse('tool_provision', { names: ['browser_use'] }));
          return;
        }
        if (!receipt) {
          browserObserveCalls += 1;
          // Keep the first provider boundary open long enough to exercise an
          // accepted/deferred Guide snapshot redraw before message_start.
          send(toolResponse('browser_use', { action: 'observe', action_id: 'dev009-observe', max_chars: 5000, max_refs: 40 }), 2500);
          return;
        }
        if (receipt.action === 'observe') {
          const refs = receipt.observation?.refs || [];
          const mark = refs.find(item => item.name === 'Mark Browser Use' || item.role === 'button');
          if (!mark?.ref) {
            send(textResponse(`DEV009_BROWSER_USE_REF_MISSING ${JSON.stringify(receipt).slice(0, 1000)}`));
            return;
          }
          browserClickCalls += 1;
          send(toolResponse('browser_use', {
            action: 'click',
            action_id: 'dev009-click',
            page_generation: receipt.pageGeneration,
            observation_id: receipt.observationId,
            ref: mark.ref,
          }));
          return;
        }
        const guided = allText.includes('DEV009_GUIDE_INSERTED');
        send(textResponse(`DEV009_BROWSER_USE_DONE${guided ? ' DEV009_GUIDE_APPLIED' : ''}`));
        return;
      }
      send(textResponse('DEV009_DEFAULT_RESPONSE'));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      requests,
      counts: () => ({ browserObserveCalls, browserClickCalls }),
    }));
  });
}

function writeConfig(root, providerPort) {
  const config = {
    models: {
      providers: [{
        name: 'ReleaseDev009Mock',
        base_url: `http://127.0.0.1:${providerPort}/v1`,
        api_key: 'dev009-test-key',
        protocol: 'openai',
        enabled: true,
        models: [{ name: modelName, display: modelName, evaluation: { status: 'available', latency: 0.01 } }],
      }],
      default_model: modelName,
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      openai_api_mode: 'chat',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous', run_in_wsl: false },
    general: { language: 'en', close_behavior: 'exit' },
    workspace: { prompt_mode: 'both', access_permission: 'full_access', on_permission_violation: 'deny' },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function buildTwoPagePdf() {
  const pageOne = 'BT /F1 24 Tf 72 700 Td (DEV009 PDF PAGE ONE) Tj ET\n';
  const pageTwo = 'BT /F1 24 Tf 72 700 Td (DEV009 PDF PAGE TWO) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(pageOne, 'ascii')} >>\nstream\n${pageOne}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(pageTwo, 'ascii')} >>\nstream\n${pageTwo}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

function createWorkspaceFixtures(workspacePath) {
  fs.writeFileSync(path.join(workspacePath, 'dev009.md'), '# DEV009 MARKDOWN\n\n- preview works\n', 'utf8');
  fs.writeFileSync(path.join(workspacePath, 'dev009.txt'), 'DEV009 TEXT EDITOR\n', 'utf8');
  fs.writeFileSync(path.join(workspacePath, 'dev009.pdf'), buildTwoPagePdf());
}

async function selectWorkspace(cdp, workspace) {
  return await evaluate(cdp, `(async () => {
    const selected = await window.api.selectWorkspace(${js(workspace.id || workspace.name)});
    if (window.refreshWorkspaceState) await window.refreshWorkspaceState();
    if (window.selectWorkspace) await window.selectWorkspace(${js(workspace.id || workspace.name)});
    return selected;
  })()`, 45_000);
}

async function runtimeState(cdp, target) {
  return await evaluate(cdp, `window.api.getState(${js(target)}).then(s => ({
    target: s.target,
    runtime: s.runtime,
    runId: s.runId,
    status: s.status,
    workRuns: s.workRuns || [],
    chatMessages: s.chatMessages || [],
    agentBackend: s.agentBackend,
    runtimeError: s.runtimeError || ''
  }))`, 30_000);
}

function stopProcessTree(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.error && result.error.code !== 'ENOENT') log(`cleanup warning: ${result.error.message}`);
}

async function stopPackagedRun(child, cdp) {
  if (cdp) {
    try { await cdp.call('Browser.close', {}, 2000); } catch {}
  }
  const gracefulDeadline = Date.now() + 4000;
  while (child && child.exitCode === null && child.signalCode === null && Date.now() < gracefulDeadline) {
    await sleep(100);
  }
  if (child && child.exitCode === null && child.signalCode === null) stopProcessTree(child);
  await sleep(1500);
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: Windows packaged smoke only');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`Missing packaged executable: ${exePath}`);
  fs.mkdirSync(path.join(repoRoot, 'archive'), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkDev009Features-'));
  const userDataDir = process.env.NEWMARK_TEST_USER_DATA_DIR
    ? path.resolve(process.env.NEWMARK_TEST_USER_DATA_DIR)
    : path.join(os.tmpdir(), `NewmarkDev009Electron-${process.pid}`);
  const fixture = await startFixtureAndProvider();
  const cdpPort = Number(process.env.NEWMARK_DEV009_FEATURES_PORT || await freeTcpPort());
  let child;
  let cdp;
  let primaryError = null;
  let childStdout = '';
  let childStderr = '';
  let childExit = null;
  try {
    writeConfig(root, fixture.port);
    const appEntry = String(process.env.NEWMARK_TEST_APP_ENTRY || '').trim();
    const chromiumArgs = [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, '--no-sandbox'];
    child = spawn(exePath, appEntry
      ? [...chromiumArgs, path.resolve(appEntry), '--root', root]
      : [...chromiumArgs, '--root', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NEWMARK_PROVIDER_DIAGNOSTICS: '1' },
    });
    child.stdout?.on('data', chunk => { childStdout = `${childStdout}${String(chunk || '')}`.slice(-8000); });
    child.stderr?.on('data', chunk => { childStderr = `${childStderr}${String(chunk || '')}`.slice(-8000); });
    child.once('exit', (code, signal) => {
      childExit = { code, signal, at: new Date().toISOString() };
      log(`packaged process exited ${JSON.stringify(childExit)}`);
    });
    const rendererTarget = await waitForTarget(cdpPort);
    cdp = connectCdp(rendererTarget);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    await waitFor(cdp, `document.readyState === 'complete' && !!window.api && !!window.sendMessage && !!document.querySelector('#prompt')`, 45_000, 'packaged renderer');
    log('packaged renderer ready');

    const workspaceA = await evaluate(cdp, `window.api.createWorkspace('dev009-alpha')`, 30_000);
    const workspaceB = await evaluate(cdp, `window.api.createWorkspace('dev009-beta')`, 30_000);
    if (!workspaceA?.path || !workspaceB?.path) fail(`Workspace creation failed: ${JSON.stringify({ workspaceA, workspaceB })}`);
    createWorkspaceFixtures(workspaceA.path);
    createWorkspaceFixtures(workspaceB.path);
    const targetA = { workspaceId: workspaceA.id || workspaceA.name, conversationId: 'default' };
    const targetB = { workspaceId: workspaceB.id || workspaceB.name, conversationId: 'default' };

    await selectWorkspace(cdp, workspaceA);
    const duplicateNotices = await evaluate(cdp, `(() => {
      clearUiNotice('dev009-error-dedupe');
      window.showUiNotice('DEV009_DUPLICATE_ERROR', 'error', 'dev009-error-dedupe');
      window.showUiNotice('DEV009_DUPLICATE_ERROR', 'error', 'dev009-error-dedupe');
      const rows = Array.from(document.querySelectorAll('.ui-notice')).filter(node => node.textContent === 'DEV009_DUPLICATE_ERROR');
      const count = rows.length;
      rows.forEach(node => node.remove());
      return count;
    })()`);
    if (duplicateNotices !== 1) fail(`Identical workspace/stop errors were not deduplicated: ${duplicateNotices}`);
    const fixtureUrl = `http://127.0.0.1:${fixture.port}/fixture`;
    const coldBrowserUse = await evaluate(cdp, `window.api.browserControl({ action: 'use', browserUse: { action: 'navigate', action_id: 'dev009-cold-navigate', url: ${js(fixtureUrl)} } })`);
    if (!coldBrowserUse?.ok || coldBrowserUse?.source !== 'native-browser-use') fail(`Cold Browser-Use did not bind the built-in guest: ${JSON.stringify(coldBrowserUse)}`);
    await waitFor(cdp, `(() => { const view = document.querySelector('#browser-webview'); try { return view && view.getURL && view.getURL() === ${js(fixtureUrl)}; } catch { return false; } })()`, 30_000, 'cold Browser-Use fixture in prewarmed built-in guest');
    const coldGuestReady = await evaluate(cdp, `window.ensureBrowserPanel({ activate: false }).then(view => {
      let url = '';
      try { url = view?.getURL ? view.getURL() : ''; } catch {}
      return { ready: view?.dataset?.newmarkBrowserReady === 'true', connected: !!view?.isConnected, url };
    }).catch(error => ({ ready: false, connected: false, url: '', error: String(error?.message || error) }))`);
    if (!coldGuestReady?.ready || !coldGuestReady?.connected || coldGuestReady?.url !== fixtureUrl) {
      fail(`Cold Browser guest readiness was poisoned by immediate navigation: ${JSON.stringify(coldGuestReady)}`);
    }
    await evaluate(cdp, `window.switchRightTab('browser'); true`);
    await waitFor(cdp, `(() => { const view = document.querySelector('#browser-webview'); try { return view && view.getURL && view.getURL() === ${js(fixtureUrl)}; } catch { return false; } })()`, 15_000, 'cold Browser-Use page survives first visible Browser activation');
    log('cold Browser-Use prewarm ready');

    await evaluate(cdp, `(() => {
      window.__dev009Runs = window.__dev009Runs || {};
      window.__dev009Runs.alpha = { done: false, value: null, error: '' };
      window.api.sendMessage('DEV009_BROWSER_RUN_A', ${js(targetA)})
        .then(value => { window.__dev009Runs.alpha = { done: true, value, error: '' }; })
        .catch(error => { window.__dev009Runs.alpha = { done: true, value: null, error: String(error?.stack || error) }; });
      return true;
    })()`);
    const alphaLive = await waitFor(cdp, `window.api.getState(${js(targetA)}).then(s => {
      const runId = s.runtime?.runId || s.runId || '';
      return s.runtime?.running && runId ? { runId, runtimeKey: s.target?.runtimeKey || s.runtimeKey || '' } : null;
    })`, 30_000, 'alpha runtime running');
    await waitFor(cdp, `isCurrentConversationRunning() === true`, 15_000, 'alpha runtime visible to Guide UI');
    const guideUiSubmission = await evaluate(cdp, `(async () => {
      const prompt = document.querySelector('#prompt');
      prompt.value = 'DEV009_GUIDE_INSERTED';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      const result = await window.sendMessage('guide');
      const receipt = result && result.guideReceipt;
      return receipt ? {
        clientMessageId: receipt.clientMessageId || '',
        status: receipt.status || '',
        text: receipt.content || ''
      } : null;
    })()`);
    const guideClientMessageId = String(guideUiSubmission?.clientMessageId || '');
    if (!guideClientMessageId || !String(guideUiSubmission?.text || '').includes('DEV009_GUIDE_INSERTED')) {
      fail(`Guide UI submission did not return a target-bound receipt: ${JSON.stringify(guideUiSubmission)}`);
    }
    const guideReceipt = await waitFor(cdp, `window.api.getState(${js(targetA)}).then(s => {
      const guide = (s.workRuns || []).flatMap(run => run.guides || []).find(item => item.clientMessageId === ${js(guideClientMessageId)});
      const persisted = (s.chatMessages || []).some(message => message.clientMessageId === ${js(guideClientMessageId)});
      return guide && !persisted && ['accepted', 'deferred'].includes(guide.status) ? guide : null;
    })`, 15_000, 'Guide accepted before the next safe boundary');
    if (!['accepted', 'deferred'].includes(guideReceipt?.status)) fail(`Guide was not accepted: ${JSON.stringify(guideReceipt)}`);
    const guideAfterRedraw = await evaluate(cdp, `(async () => {
      const snapshot = await window.api.getState(${js(targetA)});
      syncWorkRunsSnapshot(snapshot.workRuns || [], ${js(targetA)});
      renderChatMessages(snapshot.chatMessages || []);
      const events = (snapshot.workRuns || []).flatMap(run => run.events || []).filter(event =>
        String(event.clientMessageId || event.guide?.clientMessageId || '') === ${js(guideClientMessageId)});
      const body = document.querySelector('#chat-area')?.innerText || '';
      const rows = Array.from(document.querySelectorAll('.chat-msg[data-client-message-id=${JSON.stringify(guideClientMessageId)}]'));
      return { events, body, separateRows: rows.length };
    })()`);
    if (!guideAfterRedraw.events?.length || !String(guideAfterRedraw.body || '').includes('DEV009_GUIDE_INSERTED')
      || guideAfterRedraw.separateRows !== 0) {
      fail(`Guide disappeared after snapshot redraw: ${JSON.stringify(guideAfterRedraw)}`);
    }

    await selectWorkspace(cdp, workspaceB);
    await evaluate(cdp, `(() => {
      window.__dev009Runs.beta = { done: false, value: null, error: '' };
      window.api.sendMessage('DEV009_FORCE_STOP_B', ${js(targetB)})
        .then(value => { window.__dev009Runs.beta = { done: true, value, error: '' }; })
        .catch(error => { window.__dev009Runs.beta = { done: true, value: null, error: String(error?.stack || error) }; });
      return true;
    })()`);
    const betaLive = await waitFor(cdp, `window.api.getState(${js(targetB)}).then(s => {
      const runId = s.runtime?.runId || s.runId || '';
      return s.runtime?.running && runId ? { runId } : null;
    })`, 30_000, 'beta runtime running');
    try {
      await waitFor(cdp, `window.api.getState(${js(targetB)}).then(s => (s.workRuns || []).some(run =>
        (run.events || []).some(event => event.type === 'tool_call' && event.toolName === 'bash')))` , 30_000, 'beta long-running bash tool');
    } catch (error) {
      const betaDiagnostic = await runtimeState(cdp, targetB).catch(diagnosticError => ({ diagnosticError: String(diagnosticError) }));
      const providerDiagnostic = fixture.requests.slice(-8).map(item => ({
        method: item.method,
        url: item.url,
        response: item.response,
        messages: Array.isArray(item.parsed?.messages)
          ? item.parsed.messages.map(message => ({ role: message.role, name: message.name, content: messageText(message).slice(0, 240) }))
          : [],
      }));
      fail(`${error instanceof Error ? error.message : String(error)}; runtime=${JSON.stringify(betaDiagnostic).slice(0, 4000)}; provider=${JSON.stringify(providerDiagnostic).slice(0, 4000)}`);
    }

    const mutationGuards = await evaluate(cdp, `Promise.all([
      window.api.archive(${js(targetB)}).then(value => ({ value })).catch(error => ({ error: String(error) })),
      window.api.rewindConversation(${js(targetB)}, 0).then(value => ({ value })).catch(error => ({ error: String(error) })),
      window.api.deleteWorkspace(${js(workspaceB.id || workspaceB.name)}).then(value => ({ value })).catch(error => ({ error: String(error) }))
    ])`);
    if (!mutationGuards.every(item => /running|stopping|active|being mutated|operation completes/i.test(JSON.stringify(item)))) {
      fail(`Running-target mutation guard failed: ${JSON.stringify(mutationGuards)}`);
    }

    await selectWorkspace(cdp, workspaceA);
    const repeated = await evaluate(cdp, `Promise.all(Array.from({length: 8}, () => window.api.selectWorkspace(${js(workspaceA.id || workspaceA.name)})))`);
    if (!Array.isArray(repeated) || repeated.length !== 8) fail('Repeated current-workspace selection did not settle');
    const stopResult = await evaluate(cdp, `(async () => {
      const first = await window.api.stopConversation({ target: ${js(targetB)}, runId: ${js(betaLive.runId)} });
      const afterFirst = await window.api.getState(${js(targetB)});
      const runtime = afterFirst && afterFirst.runtime;
      const stillStopping = !!(runtime && (runtime.running || runtime.stopRequested));
      const second = stillStopping
        ? await window.api.stopConversation({ target: ${js(targetB)}, runId: ${js(betaLive.runId)} })
        : { action: 'already_settled' };
      return { first, second, stillStopping };
    })()`, 45_000);
    // Cancellable tools may finish cooperative shutdown between the two IPC
    // calls. Treat that terminal race as success here; the focused runtime
    // suite uses a deliberately hung worker to require the hard-restart path.
    const forceRestarted = stopResult.second?.action === 'force' && stopResult.second?.restarted === true;
    const racedToTerminal = ['already_settled', 'not_running', 'stale'].includes(String(stopResult.second?.action || ''));
    if (stopResult.first?.action !== 'graceful' || stopResult.first?.checkpointed !== true || (!forceRestarted && !racedToTerminal)) {
      fail(`Two-stage target stop failed: ${JSON.stringify(stopResult)}`);
    }
    log(`two-stage stop settled ${JSON.stringify(stopResult)}`);

    const alphaRun = await waitFor(cdp, `window.__dev009Runs.alpha?.done ? window.__dev009Runs.alpha : null`, 90_000, 'alpha Browser-Use and Guide completion');
    if (alphaRun.error) fail(`Alpha run failed: ${alphaRun.error}`);
    const alpha = await runtimeState(cdp, targetA);
    const alphaJson = JSON.stringify(alpha);
    if (!alphaJson.includes('DEV009_BROWSER_USE_DONE') || !alphaJson.includes('DEV009_GUIDE_APPLIED')) fail(`Alpha final markers missing: ${alphaJson.slice(-4000)}`);
    const guides = alpha.workRuns.flatMap(run => run.guides || []).filter(item => item.clientMessageId === guideClientMessageId);
    if (guides.length !== 1 || guides[0].status !== 'applied') fail(`Guide lifecycle is not exactly-once applied: ${JSON.stringify(guides)}`);
    const guideAfterAppliedRedraw = await evaluate(cdp, `(async () => {
      const snapshot = await window.api.getState(${js(targetA)});
      syncWorkRunsSnapshot(snapshot.workRuns || [], ${js(targetA)});
      renderChatMessages(snapshot.chatMessages || []);
      const events = (snapshot.workRuns || []).flatMap(run => run.events || []).filter(event =>
        String(event.clientMessageId || event.guide?.clientMessageId || '') === ${js(guideClientMessageId)});
      return {
        events,
        body: document.querySelector('#chat-area')?.innerText || '',
        separateRows: document.querySelectorAll('.chat-msg[data-client-message-id=${JSON.stringify(guideClientMessageId)}]').length
      };
    })()`);
    if (!guideAfterAppliedRedraw.events?.some(event => String(event.guide?.status || event.status || '').toLowerCase() === 'applied')
      || !String(guideAfterAppliedRedraw.body || '').includes('DEV009_GUIDE_INSERTED')
      || guideAfterAppliedRedraw.separateRows !== 0) {
      fail(`Applied Guide was duplicated after snapshot reconciliation: ${JSON.stringify(guideAfterAppliedRedraw)}`);
    }
    if (/reasoning_content|thinking_delta|<think>/i.test(alphaJson)) fail('Hidden reasoning leaked into snapshot/workRuns');
    log('Guide and background target isolation ready');
    const alphaToolEvents = alpha.workRuns.flatMap(run => run.events || []).filter(event => event.type === 'tool_call' || event.type === 'tool_result');
    if (!alphaToolEvents.length || alphaToolEvents.some(event => {
      const keys = Object.keys(event || {});
      const expected = event.type === 'tool_call' ? `Using tool ${event.toolName}.` : `Tool ${event.toolName} completed.`;
      return event.content !== expected
        || keys.some(key => /^(?:toolCallId|args|arguments|command|result)$/i.test(key))
        || (event.type === 'tool_result' && keys.includes('toolArgs'));
    })) fail(`Tool work events exposed implementation details: ${JSON.stringify(alphaToolEvents).slice(0, 4000)}`);
    if (!alphaToolEvents.filter(event => event.type === 'tool_call').every(event => typeof event.toolArgs === 'string' && event.toolArgs.length > 0)) {
      fail(`Tool call details were not retained for the Build fold: ${JSON.stringify(alphaToolEvents).slice(0, 4000)}`);
    }
    const completedRun = alpha.workRuns.find(run => run.status === 'completed');
    if (!completedRun || completedRun.expanded !== true) fail(`Completed work run did not retain its visible Build process: ${JSON.stringify(alpha.workRuns)}`);
    const completedRunToggle = await evaluate(cdp, `(() => {
      const node = Array.from(document.querySelectorAll('.conversation-work-run')).find(item => item.getAttribute('data-run-id') === ${js(completedRun.runId)});
      const button = node && node.querySelector('.conversation-work-run-head');
      if (!button) return null;
      const before = node.classList.contains('expanded');
      button.click();
      const collapsed = node.classList.contains('collapsed');
      const refreshedButton = node.querySelector('.conversation-work-run-head');
      if (!refreshedButton) return { before, collapsed, expandedAgain: false };
      refreshedButton.click();
      return { before, collapsed, expandedAgain: node.classList.contains('expanded') };
    })()`);
    if (!completedRunToggle?.before || !completedRunToggle?.collapsed || !completedRunToggle?.expandedAgain) {
      fail(`Completed work run cannot be folded and reopened: ${JSON.stringify(completedRunToggle)}`);
    }
    const beta = await runtimeState(cdp, targetB);
    if (JSON.stringify(beta).includes('DEV009_BROWSER_USE_DONE')) fail(`Cross-workspace snapshot contamination detected: ${JSON.stringify(beta).slice(0, 6000)}`);
    const betaEvents = (beta.workRuns || []).flatMap(run => run.events || []);
    const stoppedMarkerOutsideCallArgs = betaEvents.some(event =>
      event.type !== 'tool_call' && JSON.stringify(event).includes('DEV009_FORCE_STOP_SHOULD_NOT_COMPLETE'));
    if (stoppedMarkerOutsideCallArgs) fail('A force-stopped Bash command leaked a result or final response into the public work run');
    if (beta.runtime?.running || beta.runtime?.stopRequested) fail(`Beta runtime did not recover idle: ${JSON.stringify(beta.runtime)}`);

    const browserSnapshot = await evaluate(cdp, `window.api.browserControl({ action: 'snapshot', maxChars: 5000 })`);
    if (!browserSnapshot?.ok || !String(browserSnapshot.text || '').includes('DEV009_BROWSER_CLICKED')) fail(`Native Browser-Use click did not affect built-in page: ${JSON.stringify(browserSnapshot)}`);
    const counts = fixture.counts();
    if (counts.browserObserveCalls !== 1 || counts.browserClickCalls !== 1) fail(`Browser-Use tool calls were not exact once: ${JSON.stringify(counts)}`);

    await evaluate(cdp, `window.syncBackendConversation && window.syncBackendConversation()`);
    try {
      await waitFor(cdp, `(() => {
        const run = document.querySelector('.conversation-work-run');
        const title = run?.querySelector('.conversation-work-run-title')?.textContent || '';
        return run && /Processed|已处理/.test(title) && /\\d+[sm秒分]/.test(title) ? title : '';
      })()`, 30_000, 'completed work duration');
    } catch (error) {
      const workRunDiagnostic = await evaluate(cdp, `(() => ({
        currentWorkspaceId: state.currentWorkspaceId,
        currentWorkspacePath: state.currentWorkspacePath,
        activeConversation: activeConversationId(),
        currentTarget: currentConversationTarget(),
        runKeys: Object.keys(state.workRunsByTarget || {}),
        runs: state.workRunsByTarget || {},
        elements: Array.from(document.querySelectorAll('.conversation-work-run')).map(node => ({ className: node.className, title: node.querySelector('.conversation-work-run-title')?.textContent || '' })),
        chatText: document.querySelector('#chat-area')?.textContent?.slice(0, 1200) || ''
      }))()`);
      fail(`${error instanceof Error ? error.message : String(error)}; ui=${JSON.stringify(workRunDiagnostic).slice(0, 8000)}`);
    }
    await waitFor(cdp, `!!document.querySelector('.conversation-work-run.expanded .conversation-work-run-body')`, 15_000, 'completed work run remains expanded');
    await waitFor(cdp, `(() => {
      const body = document.querySelector('.conversation-work-run.expanded .conversation-work-run-body')?.textContent || '';
      const chat = document.querySelector('#chat-area')?.textContent || '';
      return !body.includes('DEV009_BROWSER_USE_DONE') && chat.includes('DEV009_BROWSER_USE_DONE');
    })()`, 15_000, 'final response rendered once below the Build process');
    await evaluate(cdp, `document.querySelector('.conversation-work-run.expanded .conversation-work-run-head')?.click(); true`);
    await waitFor(cdp, `!!document.querySelector('.conversation-work-run.collapsed')`, 15_000, 'work run re-collapsed');
    await evaluate(cdp, `document.querySelector('.conversation-work-run.collapsed .conversation-work-run-head')?.click(); true`);
    await waitFor(cdp, `!!document.querySelector('.conversation-work-run.expanded .conversation-work-run-body')`, 15_000, 'work run re-expanded');
    await evaluate(cdp, `document.querySelector('.conversation-work-run.expanded .conversation-work-run-head')?.click(); true`);
    await waitFor(cdp, `!!document.querySelector('.conversation-work-run.collapsed')`, 15_000, 'work run finally collapsed');
    log('work-run folding ready');
    const collapsedWorkRun = await evaluate(cdp, `(() => {
      const run = document.querySelector('.conversation-work-run.collapsed');
      if (!run) return null;
      run.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = run.getBoundingClientRect();
      return {
        title: run.querySelector('.conversation-work-run-title')?.textContent || '',
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    })()`);
    if (!collapsedWorkRun || collapsedWorkRun.width < 100 || collapsedWorkRun.height < 20
      || collapsedWorkRun.bottom <= 0 || collapsedWorkRun.top >= 1000) {
      fail(`Collapsed elapsed-time work run is not visibly screenshotable: ${JSON.stringify(collapsedWorkRun)}`);
    }
    await captureScreenshot(cdp, screenshotWorkRun);

    await evaluate(cdp, `window.openFile('dev009.md')`);
    await waitFor(cdp, `document.querySelector('#editor-md-toggle')?.classList.contains('visible')`, 20_000, 'Markdown editor');
    await evaluate(cdp, `window.toggleEditorMarkdownPreview()`);
    await waitFor(cdp, `document.querySelector('#editor-md-preview')?.classList.contains('open')`, 15_000, 'Markdown preview');
    await evaluate(cdp, `window.openFile('dev009.txt')`);
    await waitFor(cdp, `(() => {
      const preview = document.querySelector('#editor-md-preview');
      const toggle = document.querySelector('#editor-md-toggle');
      const text = document.querySelector('#editor-textarea');
      return preview && !preview.classList.contains('open') && !preview.textContent && toggle && !toggle.classList.contains('visible') && text?.value.includes('DEV009 TEXT EDITOR');
    })()`, 20_000, 'Markdown preview reset before text file');
    log('editor transition ready');

    const pdfRoute = await evaluate(cdp, `window.api.openWorkspaceFile('dev009.pdf')`);
    if (pdfRoute?.kind !== 'browser' || pdfRoute?.mime !== 'application/pdf' || !/^http:\/\/127\.0\.0\.1:\d+\/pdf\//.test(String(pdfRoute?.url || ''))) {
      fail(`PDF capability route failed: ${JSON.stringify(pdfRoute)}`);
    }
    const head = await requestUrl(pdfRoute.url, { method: 'HEAD' });
    const range = await requestUrl(pdfRoute.url, { headers: { Range: 'bytes=0-31' } });
    if (head.status !== 200 || head.headers['content-type'] !== 'application/pdf' || head.headers['x-content-type-options'] !== 'nosniff') fail(`PDF HEAD failed: ${JSON.stringify(head.headers)}`);
    if (range.status !== 206 || range.body.length !== 32 || !String(range.headers['content-range'] || '').startsWith('bytes 0-31/')) fail(`PDF Range failed: ${range.status} ${JSON.stringify(range.headers)}`);
    await evaluate(cdp, `window.applyWorkspaceFileOpenResult('dev009.pdf', ${js(pdfRoute)}); true`);
    const pdfView = await waitFor(cdp, `(() => {
      const view = document.querySelector('#browser-webview');
      try {
        const url = view?.getURL ? view.getURL() : '';
        const title = view?.getTitle ? view.getTitle() : '';
        const loading = view?.isLoading ? view.isLoading() : true;
        return url && /\\/pdf\\//.test(url) && /dev009\\.pdf/i.test(title) && !loading ? { url, title } : null;
      } catch { return null; }
    })()`, 45_000, 'embedded PDF viewer');
    if (!/dev009\.pdf/i.test(String(pdfView.title || ''))) fail(`PDF viewer title did not use filename: ${JSON.stringify(pdfView)}`);
    const pdfDocument = await waitFor(cdp, `(async () => {
      const view = document.querySelector('#browser-webview');
      if (!view?.executeJavaScript) return null;
      try {
        return await view.executeJavaScript(` + js(`({
          contentType: document.contentType,
          title: document.title,
          hasPdfEmbed: !!document.querySelector('embed[type="application/pdf"]'),
          bodyText: String(document.body?.innerText || '').slice(0, 200)
        })`) + `);
      } catch { return null; }
    })()`, 45_000, 'rendered PDF guest document');
    if (pdfDocument?.contentType !== 'application/pdf' || !pdfDocument?.hasPdfEmbed) {
      fail(`PDF guest did not render a Chromium PDF document: ${JSON.stringify(pdfDocument)}`);
    }
    const errorStorm = await evaluate(cdp, `(() => {
      const chat = Array.from(document.querySelectorAll('.chat-msg')).map(node => node.textContent || '').join('\\n');
      return (chat.match(/selectWorkspace|切换工作区失败|request timed out: reset/g) || []).length;
    })()`);
    if (errorStorm !== 0) fail(`Workspace selection error storm reached conversation history: count=${errorStorm}`);
    // The PDF plugin surface is composited asynchronously after the guest load
    // event.  A fixed delay is racy on packaged Windows builds, so retry the
    // screenshot until both the dark PDF toolbar and a white rendered page are
    // visible.  This rejects both the previous HTML pixels and the gray plugin
    // placeholder even when URL/title/contentType already report the PDF.
    await evaluate(cdp, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    let pdfSurface = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(1_000);
      const screenshot = await captureScreenshot(cdp, screenshotPdf);
      pdfSurface = renderedPdfSurfaceStats(screenshot);
      if (pdfSurface.ready) break;
    }
    log(`PDF compositor pixels ${JSON.stringify(pdfSurface)}`);
    if (!pdfSurface?.ready) fail(`PDF compositor did not expose a rendered page: ${JSON.stringify(pdfSurface)}`);

    log('cross-workspace isolation, Guide, work-run folding, two-stage stop, Browser-Use, editor, and PDF checks passed');
  } catch (error) {
    primaryError = error;
    log(`failure diagnostics child=${JSON.stringify(childExit || { exitCode: child?.exitCode, signalCode: child?.signalCode })} stderr=${JSON.stringify(childStderr)} stdout=${JSON.stringify(childStdout)}`);
    throw error;
  } finally {
    await stopPackagedRun(child, cdp);
    try { cdp?.ws.close(); } catch {}
    await new Promise(resolve => fixture.server.close(resolve));
    try {
      if (keepRoot) log(`kept isolated root: ${root}`);
      else await removeTreeWithRetry(root);
      try { await removeTreeWithRetry(userDataDir); }
      catch (error) { log(`profile cleanup deferred to parent: ${error?.message || error}`); }
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      log(`cleanup warning after primary failure: ${cleanupError?.message || cleanupError}`);
    }
  }
})().catch(error => {
  console.error(`[release-dev009-features-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
