const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-27-release-ui-agent-tool-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_AGENT_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-agent-smoke] ${message}`);
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
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
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
      if (message.error) {
        callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        callbacks.resolve(message.result);
      }
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

function sendSse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
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
          function: {
            name,
            arguments: JSON.stringify(args),
          },
        }],
      },
    }],
  };
}

function textChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

function startMockServer() {
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
      const messagesText = JSON.stringify(parsed.messages || []);

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'release-ui-agent-mock' }] }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'RELEASE_UI_AGENT_VALIDATE_OK' } }] }));
        return;
      }

      if (!toolOrder.includes('write')) {
        toolOrder.push('write');
        sendSse(res, [toolCallChunk('call_write', 'write', {
          path: 'release-ui-agent-tool-smoke.md',
          content: [
            'LIVE_RELEASE_START',
            'TERMINAL_PLACEHOLDER',
            'EDIT_PLACEHOLDER',
          ].join('\n'),
        })]);
        return;
      }

      if (!toolOrder.includes('bash')) {
        toolOrder.push('bash');
        sendSse(res, [toolCallChunk('call_bash', 'bash', {
          command: "Add-Content -LiteralPath 'release-ui-agent-tool-smoke.md' -Value 'TERMINAL_TOOL_USED'; Write-Output 'TERMINAL_TOOL_USED'",
          timeout_ms: 10000,
        })]);
        return;
      }

      if (!toolOrder.includes('edit')) {
        toolOrder.push('edit');
        sendSse(res, [toolCallChunk('call_edit', 'edit', {
          path: 'release-ui-agent-tool-smoke.md',
          old_str: 'EDIT_PLACEHOLDER',
          new_str: 'EDIT_REPLACED_OK',
        })]);
        return;
      }

      if (!toolOrder.includes('read')) {
        toolOrder.push('read');
        sendSse(res, [toolCallChunk('call_read', 'read', {
          path: 'release-ui-agent-tool-smoke.md',
        })]);
        return;
      }

      sendSse(res, [textChunk('ACTIVE_TOOLCHAIN_RESULT_OK_20260627_SCRIPT TERMINAL_TOOL_USED EDIT_REPLACED_OK READ_TOOL_USED')]);
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
        name: 'ReleaseUiAgentMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-ui-agent-mock',
          display: 'release-ui-agent-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-ui-agent-mock',
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
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force",
    ], { windowsHide: true });
    log('warning: cleaned packaged Newmark release process residue after smoke');
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows UI agent smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiAgentSmoke-'));
  const mock = await startMockServer();
  writeConfig(root, mock.port);

  const port = Number(process.env.NEWMARK_UI_AGENT_SMOKE_PORT || '49337');
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
      if (!state.model || !state.mode || typeof state.terminalInterruptTimeoutMs !== 'number' || !workspace) return null;
      return {
        model: state.model,
        mode: state.mode,
        timeout: state.terminalInterruptTimeoutMs,
        workspace
      };
    })`, 30000, 'initial backend state');
    if (initial.model !== 'release-ui-agent-mock') fail(`unexpected model: ${initial.model}`);
    if (initial.mode !== 'build') fail(`unexpected mode: ${initial.mode}`);
    if (initial.timeout !== 0) fail(`terminal timeout cap expected 0, got ${initial.timeout}`);
    if (!initial.workspace || !String(initial.workspace).startsWith(path.join(root, 'Work'))) {
      fail(`workspace was not auto-created inside temp root: ${initial.workspace}`);
    }

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!document.querySelector('#prompt'))()`, 30000, 'prompt input');

    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('missing #prompt');
      if (typeof window.sendMessage !== 'function') throw new Error('missing window.sendMessage');
      prompt.focus();
      prompt.value = 'Use write, bash, edit, and read tools to prove the release UI agent tool chain.';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.sendMessage();
      return true;
    })()`);

    const finalVisible = await waitFor(cdp, `(() => {
      const text = document.body.innerText || '';
      return text.includes('ACTIVE_TOOLCHAIN_RESULT_OK_20260627_SCRIPT') &&
        text.includes('[write] OK') &&
        text.includes('TERMINAL_TOOL_USED') &&
        text.includes('[edit] OK') &&
        text.includes('EDIT_REPLACED_OK') ? text : '';
    })()`, 90000, 'visible toolchain result');

    const state = await evaluate(cdp, `window.api.getState()`, 30000);
    if (!state || state.status !== 'idle') fail(`agent did not return to idle: ${state && state.status}`);
    if (state.terminalInterruptTimeoutMs !== 0) fail(`terminal timeout cap changed: ${state.terminalInterruptTimeoutMs}`);

    const workspacePath = state.workspaces?.current?.path || initial.workspace;
    const targetFile = path.join(workspacePath, 'release-ui-agent-tool-smoke.md');
    if (!fs.existsSync(targetFile)) fail(`toolchain file missing: ${targetFile}`);
    const fileContent = fs.readFileSync(targetFile, 'utf8');
    for (const marker of ['LIVE_RELEASE_START', 'TERMINAL_TOOL_USED', 'EDIT_REPLACED_OK']) {
      if (!fileContent.includes(marker)) fail(`file missing marker ${marker}: ${fileContent}`);
    }

    const expectedOrder = 'write,bash,edit,read';
    if (mock.toolOrder.join(',') !== expectedOrder) {
      fail(`unexpected tool order: ${mock.toolOrder.join(',')}`);
    }
    if (!mock.requests.some(r => r.body.includes('"timeout_ms":10000') || r.body.includes('\\"timeout_ms\\":10000'))) {
      fail('mock did not receive bash timeout_ms=10000 tool call request');
    }
    const metaText = await evaluate(cdp, `Array.from(document.querySelectorAll('.chat-msg .meta-extra')).map(el => el.textContent || '').join('\\n')`);
    if (!/Mode:\s*(build|Build)/.test(metaText) || !metaText.includes('Model: release-ui-agent-mock')) {
      fail(`timeline hover metadata did not include mode/model: ${metaText}`);
    }

    try {
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, 30000);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
      log(`screenshot ${screenshotPath}`);
    } catch (error) {
      log(`warning: screenshot capture failed: ${error.message}`);
    }

    log('write bash edit read ok');
    log('terminal timeout cap ok');
    log('all release UI agent smoke checks passed');
    completed = true;
  } finally {
    if (!completed) {
      log(`tool order before cleanup: ${mock.toolOrder.join(',') || '(none)'}`);
      const lastRequest = mock.requests[mock.requests.length - 1];
      if (lastRequest) log(`last request body tail: ${lastRequest.body.slice(-600)}`);
      try {
        if (cdp?.ws) {
          const domTail = await evaluate(cdp, `(document.body.innerText || '').slice(-1200)`, 5000);
          log(`dom tail before cleanup: ${domTail}`);
        }
      } catch (error) {
        log(`dom tail unavailable: ${error.message}`);
      }
    }
    try {
      if (cdp?.ws) cdp.ws.close();
    } catch {}
    try {
      if (child && !child.killed) child.kill();
    } catch {}
    await new Promise(resolve => mock.server.close(resolve));
    await sleep(1000);
    if (keepRoot) {
      log(`kept root: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
    ensureNoReleaseProcess();
  }
})().catch(error => {
  console.error(`[release-ui-agent-smoke] ${error.message}`);
  process.exit(1);
});
