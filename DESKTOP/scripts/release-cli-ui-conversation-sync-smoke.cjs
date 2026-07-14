const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-07-01-release-cli-ui-conversation-sync-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_CLI_UI_CONVERSATION_SYNC_SMOKE === '1';

function log(message) {
  console.log(`[release-cli-ui-conversation-sync-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShellCli(args, root, extraEnv = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-cli-ui-sync-run-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  const argList = args.map(psQuote).join(', ');
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(exePath)}`,
    `$argList = @(${argList})`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    '$p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $p.ExitCode',
  ].join('\r\n'), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: appRoot,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let psStdout = '';
    let psStderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { psStdout += chunk; });
    child.stderr.on('data', chunk => { psStderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PowerShell timed out for ${args[0]}. stdout=${psStdout} stderr=${psStderr}`));
    }, 90000);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(new Error(`PowerShell failed for ${args[0]}: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timeout);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      if (code !== 0) {
        reject(new Error(`CLI ${args[0]} exited ${code}. stdout=${stdout || psStdout} stderr=${stderr || psStderr}`));
        return;
      }
      resolve({ stdout, stderr, root });
    });
  });
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
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(300);
  }
  fail(`Timed out waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

function textChunk(text) {
  return { choices: [{ delta: { content: text } }] };
}

function sendSse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

function startMockServer() {
  const requests = [];
  const sockets = new Set();
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
        res.end(JSON.stringify({ data: [{ id: 'release-cli-ui-sync-mock' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'CLI_UI_SYNC_VALIDATE_OK' } }] }));
        return;
      }
      if (messagesText.includes('CLI_UI_SYNC_FROM_CLI')) {
        sendSse(res, [textChunk('CLI_UI_SYNC_REPLY_FROM_CLI')]);
        return;
      }
      if (messagesText.includes('CLI_UI_SYNC_FROM_UI')) {
        sendSse(res, [textChunk('CLI_UI_SYNC_REPLY_FROM_UI')]);
        return;
      }
      sendSse(res, [textChunk('CLI_UI_SYNC_DEFAULT_REPLY')]);
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, sockets }));
  });
}

function writeConfig(root, mockPort, autoCreateWorkspace = true) {
  const config = {
    models: {
      providers: [{
        name: 'CliUiSyncMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-cli-ui-sync-mock',
          display: 'release-cli-ui-sync-mock',
          max_tokens: 4096,
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-cli-ui-sync-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: autoCreateWorkspace,
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
    width: 1400,
    height: 880,
    deviceScaleFactor: 1,
    mobile: false,
  }, 10000).catch(() => undefined);
  await sleep(300);
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
  if (!screenshot?.data) fail('empty screenshot data');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  log(`screenshot ${screenshotPath}`);
}

function stopReleaseProcesses() {
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'",
  ], { windowsHide: true, encoding: 'utf8' });
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows CLI/UI conversation sync smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkCliUiConversationSync-'));
  const agentOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkCliAgentOnly-'));
  const mock = await startMockServer();
  writeConfig(root, mock.port);
  writeConfig(agentOnlyRoot, mock.port, false);
  const port = Number(process.env.NEWMARK_CLI_UI_CONVERSATION_SYNC_PORT || '49387');
  let child;
  let cdp;
  try {
    const agentOnlySend = await runPowerShellCli(['send', 'CLI_UI_SYNC_FROM_CLI', '--agent-only', '--mode', 'build', '--model', 'release-cli-ui-sync-mock', '--root', agentOnlyRoot], agentOnlyRoot);
    if (!agentOnlySend.stdout.includes('CLI_UI_SYNC_REPLY_FROM_CLI')) fail(`agent-only CLI send missing expected reply: ${agentOnlySend.stdout}`);
    const agentOnlyState = JSON.parse((await runPowerShellCli(['state', '--agent-only', '--root', agentOnlyRoot], agentOnlyRoot)).stdout);
    const agentOnlyLocal = path.join(agentOnlyRoot, 'Work', 'Local.json');
    const agentOnlyInternal = fs.existsSync(agentOnlyLocal) ? JSON.parse(fs.readFileSync(agentOnlyLocal, 'utf8')) : [];
    if (agentOnlyState.agentOnly !== true || agentOnlyState.workspace !== null || agentOnlyState.chatMessages !== 0 || (agentOnlyState.conversations || []).length !== 0 || agentOnlyInternal.length !== 0) {
      fail(`agent-only CLI depended on workspace/conversation state: ${JSON.stringify({ agentOnlyState, agentOnlyInternal })}`);
    }
    log('pure Agent CLI mode does not depend on workspace');

    const cliPromptFile = path.join(root, 'cli-prompt.txt');
    fs.writeFileSync(cliPromptFile, 'CLI_UI_SYNC_FROM_CLI', 'utf8');
    const cliSend = await runPowerShellCli(['send', '--input-file', cliPromptFile, '--mode', 'build', '--model', 'release-cli-ui-sync-mock', '--conversation', 'cli-sync-conv', '--root', root], root);
    if (!cliSend.stdout.includes('CLI_UI_SYNC_REPLY_FROM_CLI')) fail(`CLI conversation send missing expected reply: ${cliSend.stdout}`);
    const cliState = JSON.parse((await runPowerShellCli(['state', '--conversation', 'cli-sync-conv', '--root', root], root)).stdout);
    if (cliState.conversationId !== 'cli-sync-conv') fail(`CLI state did not select requested conversation: ${JSON.stringify(cliState)}`);
    if (!Array.isArray(cliState.conversations) || !cliState.conversations.some(c => c.id === 'cli-sync-conv' && c.messageCount >= 2)) {
      fail(`CLI state did not persist CLI conversation: ${JSON.stringify(cliState.conversations)}`);
    }
    log('CLI conversation persisted');

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

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.switchConversation && !!window.newConversation && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');
    await waitFor(cdp, `window.api.getState().then(s => (s.conversations || []).some(c => c.id === 'cli-sync-conv' && c.messageCount >= 2))`, 30000, 'UI sees CLI-created conversation');
    const uiCliConversation = await evaluate(cdp, `(() => {
      const idx = (window.state.conversations || []).findIndex(c => c.id === 'cli-sync-conv');
      if (idx < 0) return { ok: false, reason: 'conversation missing', conversations: window.state.conversations };
      window.switchConversation(idx);
      return window.api.getState().then(s => ({
        ok: true,
        active: s.conversationId,
        hasUser: (s.chatMessages || []).some(m => String(m.content || '').includes('CLI_UI_SYNC_FROM_CLI')),
        hasReply: (s.chatMessages || []).some(m => String(m.content || '').includes('CLI_UI_SYNC_REPLY_FROM_CLI')),
      }));
    })()`, 30000);
    if (!uiCliConversation.ok || uiCliConversation.active !== 'cli-sync-conv' || !uiCliConversation.hasUser || !uiCliConversation.hasReply) {
      fail(`UI did not load CLI-created conversation transcript: ${JSON.stringify(uiCliConversation)}`);
    }
    log('UI loaded CLI conversation transcript');

    const uiCreatedId = await evaluate(cdp, `new Promise((resolve, reject) => {
      try {
        window.newConversation();
        setTimeout(() => {
          try { resolve(window.api.getState().then(s => s.conversationId)); }
          catch (error) { reject(error); }
        }, 500);
      } catch (error) { reject(error); }
    })`, 30000);
    if (!String(uiCreatedId || '').startsWith('conv-')) fail(`UI did not create backend conversation id: ${uiCreatedId}`);
    await evaluate(cdp, `(() => {
      document.querySelector('#prompt').value = 'CLI_UI_SYNC_FROM_UI';
      window.sendMessage();
      return true;
    })()`, 30000);
    await waitFor(cdp, `(() => document.body.innerText.includes('CLI_UI_SYNC_REPLY_FROM_UI'))()`, 30000, 'UI-created conversation reply visible');
    log('UI conversation persisted');

    const cliAfterUi = JSON.parse((await runPowerShellCli(['state', '--conversation', String(uiCreatedId), '--root', root], root)).stdout);
    if (cliAfterUi.conversationId !== uiCreatedId) fail(`CLI did not select UI-created conversation: ${JSON.stringify(cliAfterUi)}`);
    if (!Array.isArray(cliAfterUi.conversations) || !cliAfterUi.conversations.some(c => c.id === uiCreatedId && c.messageCount >= 2)) {
      fail(`CLI state did not see UI-created conversation: ${JSON.stringify(cliAfterUi.conversations)}`);
    }
    if (!Array.isArray(cliAfterUi.conversations) || !cliAfterUi.conversations.some(c => c.id === 'cli-sync-conv' && c.messageCount >= 2)) {
      fail(`CLI lost original CLI-created conversation after UI write: ${JSON.stringify(cliAfterUi.conversations)}`);
    }
    log('CLI sees UI-created conversation');

    await captureScreenshot(cdp);
    log('all packaged CLI/UI conversation sync checks passed');
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1200);
    stopReleaseProcesses();
    if (typeof mock.server.closeAllConnections === 'function') mock.server.closeAllConnections();
    for (const socket of mock.sockets || []) {
      try { socket.destroy(); } catch {}
    }
    await new Promise(resolve => mock.server.close(() => resolve()));
    if (keepRoot) {
      log(`kept root: ${root}`);
      log(`kept agent-only root: ${agentOnlyRoot}`);
    }
    else {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { log(`warning: could not remove temp root ${root}: ${error.message}`); }
      try { fs.rmSync(agentOnlyRoot, { recursive: true, force: true }); } catch (error) { log(`warning: could not remove temp agent-only root ${agentOnlyRoot}: ${error.message}`); }
    }
  }
})().catch(error => {
  console.error(`[release-cli-ui-conversation-sync-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
