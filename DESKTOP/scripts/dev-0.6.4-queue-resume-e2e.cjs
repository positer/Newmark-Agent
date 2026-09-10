/**
 * dev-0.6.4 queue end-to-end gate (installed exe or dev renderer).
 *
 * Runs a real Build against a loopback OpenAI-compatible mock, then:
 *   1. queues a Next row while the Build is running   (提交新队列)
 *   2. pauses the queue through the panel button      (暂停)
 *   3. resumes it                                     (启动暂停的队列)
 *   4. waits for the first Build to settle and the queued row to drain
 *
 * Set NEWMARK_VISUAL_EXE to target an installed/packaged executable.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const desktopRoot = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };

function sseChunk(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function startMockServer(firstDelayMs) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      requests.push({ method: req.method, url: req.url, body: body.slice(0, 400) });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'dev064-queue-mock' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const text = JSON.stringify(parsed.messages || []);
      const isFirstBuild = text.includes('DEV064_FIRST_BUILD');
      const lastUser = Array.isArray(parsed.messages) ? [...parsed.messages].reverse().find(message => message && message.role === 'user') : null;
      const titleSystem = Array.isArray(parsed.messages)
        ? String((parsed.messages.find(message => message && message.role === 'system') || {}).content || '')
        : '';
      const isTitleRequest = /conversation title generator/i.test(titleSystem) || /conversation title|title for|summarize.*title/i.test(JSON.stringify(parsed.messages || parsed.input || '').slice(0, 4000));
      const isFailBuild = !isTitleRequest && JSON.stringify(lastUser || {}).includes('DEV064_FAIL_BUILD');
      const isFailRow = !isTitleRequest && JSON.stringify(lastUser || {}).includes('DEV064_FAIL_ROW');
      requests[requests.length - 1].delayed = parsed.stream && isFirstBuild && !isTitleRequest;
      if (isFailBuild || isFailRow) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'DEV064_SYNTHETIC_FAILURE' } }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        if (requests[requests.length - 1].delayed) await sleep(firstDelayMs);
        res.write(sseChunk(isFirstBuild ? 'DEV064_FIRST_REPLY' : 'DEV064_NEXT_REPLY'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (isFirstBuild) await sleep(firstDelayMs);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ choices: [{ message: { content: isFirstBuild ? 'DEV064_FIRST_REPLY' : 'DEV064_NEXT_REPLY' } }] }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

/** Read the workspace continuation ledger (diagnostic snapshot for the gate). */
function readLedgerSummary(root) {
  try {
    const workRoot = path.join(root, 'Work');
    if (!fs.existsSync(workRoot)) return null;
    for (const workspace of fs.readdirSync(workRoot)) {
      const ledgerPath = path.join(workRoot, workspace, 'conversations', 'continuation-ledger.json');
      if (!fs.existsSync(ledgerPath)) continue;
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      const builds = Object.values(ledger.builds || {}).map(build => ({
        id: String(build.buildId || '').slice(0, 16),
        branch: String(build.branchId || '').slice(-16),
        status: build.status,
        seq: build.queueSequence,
        parent: build.parentBuildId ? String(build.parentBuildId).slice(0, 16) : null,
        waitingReason: build.waitingReason || '',
      }));
      const branches = Object.values(ledger.branches || {}).map(branch => ({
        id: String(branch.branchId || '').slice(-16),
        head: branch.headBuildId ? String(branch.headBuildId).slice(0, 16) : null,
        tail: branch.tailBuildId ? String(branch.tailBuildId).slice(0, 16) : null,
        paused: branch.paused,
      }));
      return { builds, branches, repairs: (ledger.events || []).filter(event => event.type === 'BuildQueueRepaired').length };
    }
  } catch (error) {
    return { error: String(error && error.message || error) };
  }
  return null;
}

function writeConfig(root, mockPort) {
  const config = {
    models: {
      providers: [{
        name: 'Dev064QueueMock',
        base_url: `http://127.0.0.1:${mockPort}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{ name: 'dev064-queue-mock', display: 'dev064-queue-mock', max_tokens: 4096, evaluation: { status: 'available', latency: 0.1 } }],
      }],
      default_model: 'dev064-queue-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: { auto_create_timestamp_workspace: true, prompt_mode: 'both', access_permission: 'full_access', on_permission_violation: 'deny' },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(1500, () => request.destroy(new Error('CDP discovery timeout')));
    request.on('error', reject);
  });
}

async function discoverTarget(port, child) {
  let lastError = '';
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) fail(`app exited before CDP discovery: ${child.exitCode}`);
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch (error) { lastError = String(error && error.message || error); }
    await sleep(200);
  }
  fail(`CDP target timeout: ${lastError}`);
}

function connect(page) {
  let sequence = 0;
  const pending = new Map();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 120000);
  });
  return { ready: Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('CDP websocket timeout')), 15000))]), call, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) return { __exception: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
  return result.result?.value;
}

const installHelpers = `(() => {
  if (window.__dev064Probe) return true;
  window.__dev064Probe = { calls: [], notices: () => Array.from(document.querySelectorAll('.ui-notice')).map(node => node.textContent) };
  window.__dev064OriginalQueueAction = window.queueAction;
  window.queueAction = async (action, input, owner) => {
    let result;
    try { result = await window.__dev064OriginalQueueAction(action, input, owner); }
    catch (error) { result = { ok: false, thrown: String(error && error.message || error) }; }
    window.__dev064Probe.calls.push({ via: 'window.queueAction', action, paused: input && input.paused, ok: result && result.ok, queuePaused: result && result.queuePaused, items: result && Array.isArray(result.queueItems) ? result.queueItems.length : undefined, error: (result && result.error) || (result && result.thrown) || '' });
    return result;
  };
  const original = api.queueAction.bind(api);
  api.queueAction = async (action, input, owner) => {
    let result;
    try { result = await original(action, input, owner); }
    catch (error) { result = { ok: false, thrown: String(error && error.message || error) }; }
    window.__dev064Probe.calls.push({ via: 'api.queueAction', action, paused: input && input.paused, ok: result && result.ok, queuePaused: result && result.queuePaused, items: result && Array.isArray(result.queueItems) ? result.queueItems.length : undefined, error: (result && result.error) || (result && result.thrown) || '' });
    return result;
  };
  window.__dev064Probe.toggleSource = String(window.toggleQueuePause || '');
  return true;
})()`;

const runtimeSnapshot = `(async () => {
  const target = currentConversationTarget();
  const key = runtimeKeyFor(target.workspaceId, target.conversationId);
  let snapshot = null;
  try { snapshot = await api.getState(target); } catch (error) { snapshot = { thrown: String(error && error.message || error) }; }
  return {
    status: snapshot && snapshot.status,
    runtimeRunning: !!(snapshot && snapshot.runtime && snapshot.runtime.running),
    uiRunningKey: !!(state.runningConversations && state.runningConversations[key]),
    queuePaused: snapshot && snapshot.queuePaused,
    queueItemCount: snapshot && Array.isArray(snapshot.queueItems) ? snapshot.queueItems.length : -1
  };
})()`;

const drainDisplaySnapshot = `(async () => {
  const target = currentConversationTarget();
  const key = runtimeKeyFor(target.workspaceId, target.conversationId);
  let backend = null;
  try { backend = await api.getState(target); } catch (error) { backend = { thrown: String(error && error.message || error) }; }
  window.renderInputStack();
  const chatMessages = Array.isArray(backend && backend.chatMessages) ? backend.chatMessages : [];
  return {
    running: !!(state.runningConversations && state.runningConversations[key]),
    queuePaused: backend && backend.queuePaused,
    backendItems: (backend && backend.queueItems) || [],
    backendChatMessages: chatMessages.map(message => ({
      role: String(message.role || ''),
      content: String(message.content || '').slice(0, 60),
      clientMessageId: String(message.clientMessageId || ''),
      messageId: String(message.messageId || ''),
      userMessageId: String(message.userMessageId || ''),
      runId: String(message.runId || ''),
      mode: String(message.mode || ''),
    })),
    renderedMessages: (state.renderedChatMessages || []).map(message => ({
      role: String(message.role || ''),
      content: String(message.content || '').slice(0, 60),
      clientMessageId: String(message.clientMessageId || ''),
      messageId: String(message.messageId || ''),
      runId: String(message.runId || ''),
    })),
    domUserBubbles: Array.from(document.querySelectorAll('#chat-area .chat-msg.user'))
      .map(node => String(node._newmarkMessageText || '').slice(0, 60)),
    workRuns: (backend && backend.workRuns || []).map(run => ({ runId: String(run.runId || ''), status: String(run.status || ''), primaryPrompt: String(run.primaryPrompt || '').slice(0, 40) }))
  };
})()`;

const sendPrompt = (mode, text) => `(async () => {
  window.setInputMode(${JSON.stringify(mode)}, false);
  const prompt = document.getElementById('prompt');
  prompt.value = ${JSON.stringify(text)};
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  const noticesBefore = document.querySelectorAll('.ui-notice').length;
  await window.sendMessage(${JSON.stringify(mode)});
  await new Promise(resolve => setTimeout(resolve, 700));
  return { notices: Array.from(document.querySelectorAll('.ui-notice')).map(node => node.textContent), rows: (state.nextQueue || []).slice(), calls: window.__dev064Probe.calls.slice(-4) };
})()`;

const queueSnapshot = `(async () => {
  const target = currentConversationTarget();
  const key = runtimeKeyFor(target.workspaceId, target.conversationId);
  let backend = null;
  try { backend = await api.getState(target); } catch (error) { backend = { thrown: String(error && error.message || error) }; }
  window.renderInputStack();
  return {
    currentTarget: target,
    uiKey: key,
    currentWorkspaceId: state.currentWorkspaceId,
    currentWorkspacePath: state.currentWorkspacePath,
    backendTarget: backend && backend.target,
    backendQueuesKeys: Object.keys(state.backendQueuesByTarget || {}),
    queueItemKeys: Object.keys(state.queueItemsByTarget || {}),
    pausedKeys: Object.keys(state.queuePausedByTarget || {}),
    uiPaused: !!(state.queuePausedByTarget && state.queuePausedByTarget[key]),
    uiRows: (state.nextQueue || []).slice(),
    panelRows: Array.from(document.querySelectorAll('#queue-list .queue-item')).map(row => (row.querySelector('.queue-edit') || {}).value || ''),
    backendPaused: backend && backend.queuePaused,
    backendItems: backend && Array.isArray(backend.queueItems) ? backend.queueItems.map(item => ({ id: item.id, text: item.text, branchPath: item.branchPath })) : backend,
    running: !!(state.runningConversations && state.runningConversations[key]),
    userMessages: (state.renderedChatMessages || []).filter(message => String(message.role || '') === 'user').map(message => String(message.content || '').slice(0, 60))
  };
})()`;

(async () => {
  const installedExe = String(process.env.NEWMARK_VISUAL_EXE || '').trim();
  const binary = installedExe || require(path.join(desktopRoot, 'node_modules', 'electron'));
  const spawnCwd = installedExe ? path.dirname(installedExe) : desktopRoot;
  const appArgs = installedExe ? [] : [desktopRoot];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkQueueE2E-'));
  const mock = await startMockServer(Number(process.env.NEWMARK_E2E_FIRST_DELAY_MS || 30000));
  writeConfig(root, mock.port);
  const port = await freeTcpPort();
  const evidence = { binary: installedExe || 'dev-electron', steps: [], mockREquests: [] };
  let child;
  let cdp;
  try {
    child = spawn(binary, [
      ...appArgs,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(root, 'ElectronData')}`,
      '--no-sandbox',
      '--root', root,
    ], { cwd: spawnCwd, stdio: process.env.NEWMARK_SMOKE_DEBUG === '1' ? 'inherit' : 'ignore', windowsHide: true });
    cdp = connect(await discoverTarget(port, child));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate(cdp, `typeof api !== 'undefined' && !!api.queueAction && !!api.sendMessage`)) break;
      await sleep(250);
      if (attempt === 119) fail('renderer api did not become ready');
    }
    await evaluate(cdp, installHelpers);

    const mode = String(process.env.NEWMARK_E2E_MODE || 'running').trim();
    if (mode === 'drain-display') {
      // 目标：排队行真正进入对话后，用户输入必须出现在对话区。
      evidence.steps.push({ name: 'pauseQueue', value: await evaluate(cdp, `(async () => { window.renderInputStack(); await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 500)); return true; })()`) });
      evidence.steps.push({ name: 'enqueueRow', value: await evaluate(cdp, `(async () => {
        const target = currentConversationTarget();
        const results = [];
        for (const [id, text] of [['dev064-drain-display', 'DEV064_QUEUED_DISPLAY'], ['dev064-drain-display-2', 'DEV064_QUEUED_DISPLAY_2']]) {
          const result = await window.queueAction('enqueue', { id, text, requestedMode: 'build', inputMode: 'next' }, target);
          results.push({ id, ok: result && result.ok, items: result && Array.isArray(result.queueItems) ? result.queueItems.length : -1 });
          await new Promise(resolve => setTimeout(resolve, 400));
        }
        return results;
      })()`) });
      evidence.steps.push({ name: 'beforeDrain', value: await evaluate(cdp, drainDisplaySnapshot) });
      evidence.steps.push({ name: 'resumeAndDrain', value: await evaluate(cdp, `(async () => { await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 2000)); return true; })()`) });
      for (let attempt = 0; attempt < 60; attempt++) {
        const snapshot = await evaluate(cdp, drainDisplaySnapshot);
        if (snapshot && Array.isArray(snapshot.backendItems) && snapshot.backendItems.length === 0 && !snapshot.running
          && (snapshot.backendChatMessages || []).some(message => String(message.content || '').includes('DEV064_QUEUED_DISPLAY'))
          && (snapshot.backendChatMessages || []).some(message => String(message.content || '').includes('DEV064_QUEUED_DISPLAY_2'))) break;
        await sleep(1000);
      }
      evidence.steps.push({ name: 'afterDrain', value: await evaluate(cdp, drainDisplaySnapshot) });
      evidence.ledger = readLedgerSummary(root);
      const drainShot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.join(desktopRoot, '..', 'archive', '20260910-dev064-queue-drain-fix'), { recursive: true });
      fs.writeFileSync(path.join(desktopRoot, '..', 'archive', '20260910-dev064-queue-drain-fix', 'installed-drained-turns.png'), Buffer.from(drainShot.data, 'base64'));
      console.log(JSON.stringify(evidence, null, 2));
      return;
    }
    if (mode === 'blocked') {
      // 用户现场：一个 Build 失败 → 之后入队的行全部被 DEPENDENCY_FAILED 阻断 →
      // 显式“修复受阻队列”必须把它们重新挂到已提交 frontier 并真正执行。
      evidence.steps.push({ name: 'pauseBeforeRow', value: await evaluate(cdp, `(async () => { window.renderInputStack(); await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 500)); return true; })()`) });
      evidence.steps.push({ name: 'enqueueFailingRow', value: await evaluate(cdp, `(async () => {
        const target = currentConversationTarget();
        const result = await api.queueAction('enqueue', { id: 'dev064-failing-row', text: 'DEV064_FAIL_ROW', requestedMode: 'build', inputMode: 'next' }, target);
        await new Promise(resolve => setTimeout(resolve, 500));
        return { ok: result && result.ok, items: result && Array.isArray(result.queueItems) ? result.queueItems.length : -1 };
      })()`) });
      evidence.steps.push({ name: 'resumeFailingRow', value: await evaluate(cdp, `(async () => { await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 1500)); return true; })()`) });
      for (let attempt = 0; attempt < 40; attempt++) {
        const snapshot = await evaluate(cdp, queueSnapshot);
        if (snapshot && !snapshot.running) break;
        await sleep(500);
      }
      evidence.steps.push({ name: 'afterFailingRow', value: await evaluate(cdp, queueSnapshot) });
      evidence.steps.push({ name: 'enqueueAfterFailure', value: await evaluate(cdp, `(async () => {
        const target = currentConversationTarget();
        const rows = [];
        for (const id of ['dev064-blocked-1', 'dev064-blocked-2']) {
          const result = await window.queueAction('enqueue', { id, text: 'DEV064_BLOCKED_' + id, requestedMode: 'build', inputMode: 'next' }, target);
          rows.push({ id, ok: result && result.ok, paused: result && result.queuePaused, items: result && Array.isArray(result.queueItems) ? result.queueItems.length : -1 });
          await new Promise(resolve => setTimeout(resolve, 400));
        }
        return rows;
      })()`) });
      evidence.steps.push({ name: 'afterBlockedEnqueue', value: await evaluate(cdp, queueSnapshot) });
      evidence.steps.push({ name: 'blockedFlags', value: await evaluate(cdp, `(() => {
        window.renderInputStack();
        const target = currentConversationTarget();
        const items = queueItemsForTarget(target).map(item => ({ id: item.id, waitingReason: item.waitingReason || '', blocked: !!item.blocked }));
        const rows = Array.from(document.querySelectorAll('#queue-list .queue-item')).map(row => ({ id: row.getAttribute('data-queue-id'), blocked: row.getAttribute('data-queue-blocked') }));
        return { items, rows, paused: !!(state.queuePausedByTarget && state.queuePausedByTarget[runtimeKeyFor(target.workspaceId, target.conversationId)]) };
      })()`) });
      evidence.steps.push({ name: 'backendProjection', value: await evaluate(cdp, `(async () => {
        const target = currentConversationTarget();
        const snapshot = await api.getState(target);
        return { queuePaused: snapshot.queuePaused, items: (snapshot.queueItems || []).map(item => ({ id: item.id, buildId: item.buildId, waitingReason: item.waitingReason || '', blocked: !!item.blocked })) };
      })()`) });
      evidence.steps.push({ name: 'repairButtonPresent', value: await evaluate(cdp, `(() => { window.renderInputStack(); const button = document.getElementById('queue-repair-btn'); return { present: !!button, title: button ? button.title : '' }; })()`) });
      evidence.steps.push({ name: 'repairBlockedRows', value: await evaluate(cdp, `(async () => {
        const result = await window.repairBlockedQueue();
        await new Promise(resolve => setTimeout(resolve, 1200));
        return { ok: result && result.ok, queuePaused: result && result.queuePaused, items: result && Array.isArray(result.queueItems) ? result.queueItems.map(item => ({ id: item.id, waitingReason: item.waitingReason || '', blocked: !!item.blocked })) : result };
      })()`) });
      evidence.steps.push({ name: 'afterRepair', value: await evaluate(cdp, queueSnapshot) });
      evidence.steps.push({ name: 'resumeAfterRepair', value: await evaluate(cdp, `(async () => { await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 1500)); return true; })()`) });
      evidence.steps.push({ name: 'afterResumeRepair', value: await evaluate(cdp, queueSnapshot) });
      for (let attempt = 0; attempt < 60; attempt++) {
        const snapshot = await evaluate(cdp, queueSnapshot);
        if (snapshot && Array.isArray(snapshot.backendItems) && snapshot.backendItems.length === 0 && !snapshot.running) break;
        await sleep(1000);
      }
      evidence.steps.push({ name: 'afterDrain', value: await evaluate(cdp, queueSnapshot) });
    evidence.queueActionCalls = await evaluate(cdp, 'window.__dev064Probe ? window.__dev064Probe.calls.slice() : []');
    evidence.mockRequests = mock.requests.length;
    evidence.notices = await evaluate(cdp, 'window.__dev064Probe ? window.__dev064Probe.notices() : []');
    evidence.ledger = readLedgerSummary(root);
    console.log(JSON.stringify(evidence, null, 2));
    return;
    }
    if (mode === 'paused') {
      // 目标场景：队列里真的有行 → 暂停 → 恢复 → 出队（用户报告的“无法启动暂停的队列”）
      evidence.steps.push({ name: 'pauseFirst', value: await evaluate(cdp, `(async () => { window.renderInputStack(); await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 600)); return true; })()`) });
      evidence.steps.push({ name: 'afterPauseFirst', value: await evaluate(cdp, queueSnapshot) });
      evidence.steps.push({ name: 'enqueueRow', value: await evaluate(cdp, `(async () => {
        const target = currentConversationTarget();
        const result = await window.queueAction('enqueue', { id: 'dev064-paused-1', text: 'DEV064_PAUSED_ROW', requestedMode: 'build', inputMode: 'next' }, target);
        await new Promise(resolve => setTimeout(resolve, 800));
        return { ok: result && result.ok, queuePaused: result && result.queuePaused, items: result && Array.isArray(result.queueItems) ? result.queueItems.length : -1, error: (result && result.error) || '' };
      })()`) });
      evidence.steps.push({ name: 'afterEnqueueRow', value: await evaluate(cdp, queueSnapshot) });
      evidence.steps.push({ name: 'enqueueSecondRow', value: await evaluate(cdp, `(async () => {
        const target = currentConversationTarget();
        const result = await window.queueAction('enqueue', { id: 'dev064-paused-2', text: 'DEV064_PAUSED_ROW_2', requestedMode: 'build', inputMode: 'next' }, target);
        await new Promise(resolve => setTimeout(resolve, 800));
        return { ok: result && result.ok, queuePaused: result && result.queuePaused, items: result && Array.isArray(result.queueItems) ? result.queueItems.length : -1, error: (result && result.error) || '' };
      })()`) });
      evidence.steps.push({ name: 'afterSecondEnqueue', value: await evaluate(cdp, queueSnapshot) });
      evidence.steps.push({ name: 'resumeWithRows', value: await evaluate(cdp, `(async () => { await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 1200)); return true; })()`) });
      evidence.steps.push({ name: 'afterResumeWithRows', value: await evaluate(cdp, queueSnapshot) });
      for (let attempt = 0; attempt < 60; attempt++) {
        const snapshot = await evaluate(cdp, queueSnapshot);
        if (snapshot && Array.isArray(snapshot.backendItems) && snapshot.backendItems.length === 0) break;
        await sleep(1000);
      }
      evidence.steps.push({ name: 'afterDrain', value: await evaluate(cdp, queueSnapshot) });
      evidence.queueActionCalls = await evaluate(cdp, 'window.__dev064Probe ? window.__dev064Probe.calls.slice() : []');
      evidence.mockRequests = mock.requests.length;
      console.log(JSON.stringify(evidence, null, 2));
      return;
    }

    // 1) 启动第一个 Build（mock 故意延迟 9s，保持 running）
    evidence.steps.push({ name: 'sendFirstBuild', value: await evaluate(cdp, sendPrompt('build', 'DEV064_FIRST_BUILD')) });
    let runningSeen = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const runtime = await evaluate(cdp, runtimeSnapshot);
      if (runtime && (runtime.status === 'running' || runtime.runtimeRunning || runtime.uiRunningKey)) { runningSeen = true; break; }
      await sleep(250);
    }
    evidence.runningSeen = runningSeen;
    evidence.steps.push({ name: 'afterFirstBuildSend', value: await evaluate(cdp, queueSnapshot) });

    // 2) 运行中提交 Next（用户报告的“无法提交新队列”）
    evidence.steps.push({ name: 'sendQueuedNext', value: await evaluate(cdp, sendPrompt('next', 'DEV064_QUEUED_NEXT')) });
    evidence.steps.push({ name: 'afterQueuedNext', value: await evaluate(cdp, queueSnapshot) });

    // 3) 暂停
    evidence.steps.push({ name: 'uiPause', value: await evaluate(cdp, `(async () => { window.renderInputStack(); await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 500)); return true; })()`) });
    evidence.steps.push({ name: 'afterPause', value: await evaluate(cdp, queueSnapshot) });

    // 4) 恢复（用户报告的“无法启动暂停的队列”）
    evidence.steps.push({ name: 'uiResume', value: await evaluate(cdp, `(async () => { await window.toggleQueuePause(); await new Promise(r => setTimeout(r, 800)); return true; })()`) });
    evidence.steps.push({ name: 'afterResume', value: await evaluate(cdp, queueSnapshot) });

    // 5) 等第一个 Build 结束 + 队列出队
    for (let attempt = 0; attempt < 60; attempt++) {
      const snapshot = await evaluate(cdp, queueSnapshot);
      if (snapshot && Array.isArray(snapshot.backendItems) && snapshot.backendItems.length === 0 && !snapshot.running) break;
      await sleep(1000);
    }
    evidence.steps.push({ name: 'afterDrain', value: await evaluate(cdp, queueSnapshot) });
    evidence.queueActionCalls = await evaluate(cdp, 'window.__dev064Probe ? window.__dev064Probe.calls.slice() : []');
    evidence.notices = await evaluate(cdp, 'window.__dev064Probe ? window.__dev064Probe.notices() : []');
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.join(desktopRoot, '..', 'archive', '20260910-dev064-queue-probe'), { recursive: true });
    fs.writeFileSync(path.join(desktopRoot, '..', 'archive', '20260910-dev064-queue-probe', 'e2e-final.png'), Buffer.from(shot.data, 'base64'));
    evidence.mockRequests = mock.requests.length;
    evidence.mockRequestBodies = mock.requests.map(request => ({ url: request.url, delayed: !!request.delayed, body: String(request.body || '').replace(/\s+/g, ' ').slice(0, 240) }));
    console.log(JSON.stringify(evidence, null, 2));

    const byName = name => (evidence.steps.find(step => step.name === name) || {}).value || {};
    const problems = [];
    if (!byName('afterQueuedNext').queueRowCount && !(byName('afterQueuedNext').uiRows || []).length) problems.push('queued Next row did not appear');
    if (byName('afterPause').backendPaused !== true) problems.push('pause did not reach the backend: ' + JSON.stringify(byName('afterPause').backendPaused));
    if (byName('afterResume').backendPaused !== false) problems.push('resume did not clear queuePaused: ' + JSON.stringify(byName('afterResume').backendPaused));
    if (mock.requests.length < 1) problems.push('mock provider never called');
    if (problems.length) {
      console.error('QUEUE E2E PROBLEMS: ' + problems.join('; '));
      process.exitCode = 2;
    }
  } finally {
    try { cdp?.close(); } catch {}
    try { child?.kill(); } catch {}
    try { mock.server.closeAllConnections?.(); } catch {}
    try { mock.server.close(); } catch {}
    await sleep(500);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(String(error && error.stack || error));
  process.exitCode = 1;
});
