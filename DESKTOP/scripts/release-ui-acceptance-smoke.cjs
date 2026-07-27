const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-27-release-ui-acceptance-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_UI_ACCEPTANCE_SMOKE === '1';

function log(message) {
  console.log(`[release-ui-acceptance-smoke] ${message}`);
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
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
  if (!screenshot?.data) fail('empty screenshot data');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
  log(`screenshot ${filePath}`);
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
          function: { name, arguments: JSON.stringify(args) },
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
  const markerCounts = new Map();
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
      const latestUser = [...messages].reverse().find(message => message && message.role === 'user');
      const latestUserText = typeof latestUser?.content === 'string' ? latestUser.content : JSON.stringify(latestUser?.content || '');

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'release-ui-acceptance-mock' }] }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'RELEASE_UI_ACCEPTANCE_VALIDATE_OK' } }] }));
        return;
      }

      const marker = latestUserText.includes('ACCEPTANCE_FLOW_DECISION') ? 'flow-decision'
        : latestUserText.includes('ACCEPTANCE_FLOW_FALSE_BRANCH') ? 'flow-false'
        : latestUserText.includes('ACCEPTANCE_FLOW_TRUE_BRANCH') ? 'flow-true'
        : latestUserText.includes('ACCEPTANCE_FLOW_DIALOG') ? 'flow-dialog'
        : latestUserText.includes('ACCEPTANCE_PLAN_BLOCK') ? 'plan'
        : latestUserText.includes('ACCEPTANCE_BUILD_WRITE') ? 'build'
        : 'default';
      const count = markerCounts.get(marker) || 0;
      markerCounts.set(marker, count + 1);

      if (marker === 'build' && count === 0) {
        sendSse(res, [toolCallChunk('call_acceptance_write', 'write', {
          path: 'acceptance-build-output.md',
          content: 'ACCEPTANCE_BUILD_FILE_OK',
        })]);
        return;
      }

      if (marker === 'plan' && count === 0) {
        sendSse(res, [toolCallChunk('call_acceptance_plan_write', 'write', {
          path: 'acceptance-plan-should-not-exist.md',
          content: 'PLAN_WRITE_SHOULD_BE_BLOCKED',
        })]);
        return;
      }

      if (marker === 'flow-decision') {
        sendSse(res, [textChunk('INTERNAL_FLOW_ARCHITECTURE_MUST_STAY_HIDDEN\nFLOW_DECISION=true')]);
        return;
      }

      if (marker === 'flow-dialog') {
        sendSse(res, [textChunk('ACCEPTANCE_FLOW_DIALOG_OK')]);
        return;
      }

      if (marker === 'flow-true') {
        sendSse(res, [textChunk('ACCEPTANCE_FLOW_RESULT_OK')]);
        return;
      }

      if (marker === 'flow-false') {
        sendSse(res, [textChunk('ACCEPTANCE_FLOW_FALSE_BRANCH_SHOULD_NOT_RUN')]);
        return;
      }

      if (marker === 'plan') {
        sendSse(res, [textChunk('ACCEPTANCE_PLAN_BLOCK_OK')]);
        return;
      }

      if (marker === 'build') {
        sendSse(res, [textChunk('ACCEPTANCE_BUILD_WRITE_OK')]);
        return;
      }

      sendSse(res, [textChunk('ACCEPTANCE_DEFAULT_OK')]);
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
        name: 'ReleaseUiAcceptanceMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'release-ui-acceptance-mock',
          display: 'release-ui-acceptance-mock',
          evaluation: { status: 'available', latency: 0.1 },
        }],
      }],
      default_model: 'release-ui-acceptance-mock',
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
    await waitForPromotedMainUi(cdp);
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
    log('skipped: packaged Windows UI acceptance smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseUiAcceptance-'));
  const mock = await startMockServer();
  const port = Number(process.env.NEWMARK_UI_ACCEPTANCE_PORT || '49345');
  let child;
  let cdp;

  try {
    writeConfig(root, mock.port);
    const first = await launch(root, port);
    child = first.child;
    cdp = first.cdp;

    const workspace = await evaluate(cdp, `window.api.createWorkspace('acceptance-workspace')`, 30000);
    if (!workspace || !workspace.path) fail('workspace creation did not return a workspace path');
    await evaluate(cdp, `window.refreshWorkspaceState()`, 30000);
    log(`workspace ok: ${workspace.name}`);

    await evaluate(cdp, `window.api.setModel('release-ui-acceptance-mock')`);
    await evaluate(cdp, `window.api.setMode('build')`);
    const buildResult = await evaluate(cdp, `window.api.sendMessage('ACCEPTANCE_BUILD_WRITE create a workspace file')`, 90000);
    const buildText = JSON.stringify(buildResult || {});
    if (!buildText.includes('ACCEPTANCE_BUILD_WRITE_OK')) fail(`build result marker missing: ${buildText}`);
    const buildFile = path.join(workspace.path, 'acceptance-build-output.md');
    if (!fs.existsSync(buildFile) || !fs.readFileSync(buildFile, 'utf8').includes('ACCEPTANCE_BUILD_FILE_OK')) {
      fail('Build did not write expected workspace file');
    }
    log('build write ok');

    await evaluate(cdp, `window.api.setMode('plan')`);
    const planModeConfirmed = await evaluate(cdp, `window.api.getState().then(s => s && s.mode === 'plan')`, 30000);
    if (!planModeConfirmed) fail('Plan mode was not active immediately before the permission probe');
    const planResult = await evaluate(cdp, `window.api.sendMessage('ACCEPTANCE_PLAN_BLOCK attempt a forbidden file write')`, 90000);
    const planText = JSON.stringify(planResult || {});
    if (!planText.includes('ACCEPTANCE_PLAN_BLOCK_OK')) fail(`plan result marker missing: ${planText}`);
    const blockedFile = path.join(workspace.path, 'acceptance-plan-should-not-exist.md');
    if (fs.existsSync(blockedFile)) fail('Plan mode allowed a file write');
    log('plan block ok');

    await evaluate(cdp, `window.api.updateGoal('ACCEPTANCE_GOAL objective can pause and resume')`, 30000);
    const goalPaused = await evaluate(cdp, `window.api.toggleGoalPause().then(() => window.api.getState()).then(s => s.status === 'goal_paused' && s.goal && s.goal.paused === true)`, 30000);
    if (!goalPaused) fail('Goal pause state was not persisted in real UI');
    const goalResumed = await evaluate(cdp, `window.api.toggleGoalPause().then(() => window.api.getState()).then(s => s.goal && s.goal.paused === false)`, 30000);
    if (!goalResumed) fail('Goal resume state was not persisted in real UI');
    log('goal pause/resume ok');

    await evaluate(cdp, `window.api.setMode('build')`, 30000);
    const flowJson = {
      name: 'acceptance-flow',
      description: 'Release UI acceptance flow',
      components: [
        { type: 'dialog', id: 10, mode: 'build', prompt: 'ACCEPTANCE_FLOW_DIALOG {#prompt#}' },
        { type: 'logic', id: 30, prompt: 'ACCEPTANCE_FLOW_DECISION {#prompt#}', goto_true: 50, goto_false: 40 },
        { type: 'dialog', id: 40, mode: 'build', prompt: 'ACCEPTANCE_FLOW_FALSE_BRANCH' },
        { type: 'dialog', id: 50, mode: 'build', prompt: 'ACCEPTANCE_FLOW_TRUE_BRANCH' },
      ],
    };
    await evaluate(cdp, `window.api.saveFlow(${JSON.stringify(flowJson)})`, 30000);
    const flowResult = await evaluate(cdp, `window.api.runFlow('acceptance-flow', 'from release UI', 10)`, 90000);
    const flowResultText = JSON.stringify(flowResult || {});
    if (!flowResultText.includes('ACCEPTANCE_FLOW_RESULT_OK')) fail(`flow result marker missing: ${flowResultText}`);
    const flowRuns = (flowResult.workRuns || []).filter(run => run.flow && run.flow.name === 'acceptance-flow');
    const flowRunIds = flowRuns.map(run => run.flow.componentId);
    if (JSON.stringify(flowRunIds) !== JSON.stringify([10, 30, 50])) {
      fail(`Flow did not persist one completed Build block per executed component or jumped incorrectly: ${JSON.stringify(flowRuns)}`);
    }
    if (!flowRuns.every(run => run.status === 'completed')) fail(`Flow advanced before every component Build completed: ${JSON.stringify(flowRuns)}`);
    const logicRun = flowRuns.find(run => run.flow.componentId === 30);
    if (!logicRun || logicRun.flow.activityVisibility !== 'result-only') fail(`logic Build activity is not result-only: ${JSON.stringify(logicRun)}`);
    const flowMessages = (flowResult.chatMessages || []).filter(message => flowRuns.some(run => run.runId === message.runId));
    const visibleLogicInput = flowMessages.find(message => message.role === 'user' && message.runId === logicRun.runId);
    const visibleLogicReply = flowMessages.find(message => message.role === 'assistant' && message.runId === logicRun.runId);
    if (!visibleLogicInput || visibleLogicInput.mode !== 'flow-user-input' || visibleLogicInput.content !== 'ACCEPTANCE_FLOW_DECISION from release UI') {
      fail(`logic visible user input does not match the Flow decision statement: ${JSON.stringify(visibleLogicInput)}`);
    }
    if (!visibleLogicReply || visibleLogicReply.content !== 'Flow 判定：true\nFlow 跳转：#50') {
      fail(`logic visible reply is not the deterministic decision and jump target: ${JSON.stringify(visibleLogicReply)}`);
    }
    if (flowResultText.includes('INTERNAL_FLOW_ARCHITECTURE_MUST_STAY_HIDDEN')) {
      fail('logic internal architecture/reasoning leaked into public Flow state');
    }
    await evaluate(cdp, `(() => {
      const result = ${JSON.stringify(flowResult)};
      if (Array.isArray(result.workRuns)) window.renderConversationWorkRuns(result.workRuns, window.currentConversationTarget());
      if (Array.isArray(result.chatMessages)) window.renderChatMessages(result.chatMessages);
      return true;
    })()`, 30000);
    const flowDom = await evaluate(cdp, `(() => ({
      text: document.body.innerText || '',
      hiddenLogicRuns: document.querySelectorAll('.work-run-message.flow-result-only').length
    }))()`, 30000);
    if (flowDom.text.includes('INTERNAL_FLOW_ARCHITECTURE_MUST_STAY_HIDDEN')) fail('logic internal architecture/reasoning leaked into the rendered UI');
    if (flowDom.hiddenLogicRuns < 1) fail(`logic Build work activity was not hidden in the rendered UI: ${JSON.stringify(flowDom)}`);
    log('flow component boundaries, read-only logic visibility, and conditional jump ok');

    const archiveResult = await evaluate(cdp, `window.api.archive()`, 30000);
    const archiveName = typeof archiveResult === 'string' ? archiveResult : String(archiveResult?.fileName || '');
    if (!archiveName || !String(archiveName).endsWith('.md')) fail(`archive did not return a md name: ${archiveName}`);
    const archiveFile = path.join(workspace.path, 'archive', archiveName);
    if (!fs.existsSync(archiveFile)) fail(`archive was not stored under workspace: ${archiveFile}`);
    log('workspace archive ok');

    const stateBeforeRestart = await evaluate(cdp, `window.api.getState()`, 30000);
    const conversationId = stateBeforeRestart.conversationId;
    if (!conversationId) fail('missing active conversation id before restart');

    await captureScreenshot(cdp, screenshotPath);
    cdp.ws.close();
    stopChild(child);
    child = null;
    await sleep(1500);

    const second = await launch(root, port + 1);
    child = second.child;
    cdp = second.cdp;
    const restored = await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === 'acceptance-workspace' && s.conversationId === ${JSON.stringify(conversationId)})`, 30000, 'workspace and conversation restart restore');
    if (!restored) fail('restart restore returned false');
    const archives = await evaluate(cdp, `window.api.listArchives()`, 30000);
    if (!JSON.stringify(archives || []).includes(String(archiveName))) fail('workspace archive was not visible after restart');
    log('restart restore ok');

    if (!mock.requests.some(r => r.body.includes('ACCEPTANCE_BUILD_WRITE'))) fail('mock provider did not receive Build prompt');
    if (!mock.requests.some(r => r.body.includes('ACCEPTANCE_PLAN_BLOCK'))) fail('mock provider did not receive Plan prompt');
    if (!mock.requests.some(r => r.body.includes('ACCEPTANCE_FLOW_DIALOG'))) fail('mock provider did not receive Flow dialog prompt');
    if (!mock.requests.some(r => r.body.includes('ACCEPTANCE_FLOW_DECISION'))) fail('mock provider did not receive Flow logic prompt');
    if (!mock.requests.some(r => r.body.includes('ACCEPTANCE_FLOW_TRUE_BRANCH'))) fail('mock provider did not receive Flow true-branch prompt');
    if (mock.requests.some(r => r.body.includes('ACCEPTANCE_FLOW_FALSE_BRANCH'))) fail('mock provider incorrectly executed the Flow false branch');
    log('all release UI acceptance checks passed');
  } finally {
    if (cdp?.ws && cdp.ws.readyState === WebSocket.OPEN) cdp.ws.close();
    stopChild(child);
    mock.server.close();
    if (!keepRoot) fs.rmSync(root, { recursive: true, force: true });
    ensureNoReleaseProcess();
  }
})().catch(error => {
  console.error(`[release-ui-acceptance-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
