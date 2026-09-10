/**
 * dev-0.6.4 queue control reproduction: enqueue a Next row and toggle the pause
 * state through the real renderer + real ConversationKernel.
 *
 * Default target: the workspace dev Electron build. Set NEWMARK_VISUAL_EXE to
 * run against an installed/packaged executable instead.
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

async function discoverTarget(port, child) {
  let lastError = '';
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) fail(`Electron exited before CDP discovery: ${child.exitCode}`);
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch (error) {
      lastError = String(error && error.message || error);
    }
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
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 60000);
  });
  return { ready: Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('CDP websocket timeout')), 15000))]), call, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    return { __exception: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
  }
  return result.result?.value;
}

const scenario = `(async () => {
  const target = currentConversationTarget();
  const trace = { errors: [], steps: [] };
  window.addEventListener('error', event => trace.errors.push(String(event.message || event.error || '')));
  const record = (name, value) => trace.steps.push({ name, value });
  const snapshotQueue = () => ({
    paused: !!(state.queuePausedByTarget && state.queuePausedByTarget[runtimeKeyFor(target.workspaceId, target.conversationId)]),
    rows: (state.nextQueue || []).slice(),
    requests: (state.nextQueueRequests || []).map(item => item && ({ id: item.queueItemId, text: item.text, branchPath: item.branchPath, backendManaged: item.backendManaged })),
    items: queueItemsForTarget(target).map(item => ({ id: item.id, text: item.text, branchPath: item.branchPath, branchNodeId: item.branchNodeId }))
  });
  try {
    localStorage.removeItem('newmark-queue-probe');
  } catch (error) {}
  record('before', snapshotQueue());

  // 1) 提交新队列：走真实 kernel queue_enqueue
  let enqueueResult;
  try {
    enqueueResult = await api.queueAction('enqueue', {
      id: 'dev064-probe-1', text: 'dev064 probe queued input', requestedMode: 'build', inputMode: 'next'
    }, target);
  } catch (error) {
    enqueueResult = { thrown: String(error && error.message || error) };
  }
  record('enqueue', enqueueResult);
  await new Promise(resolve => setTimeout(resolve, 400));
  record('afterEnqueue', snapshotQueue());

  // 2) 暂停
  let pauseResult;
  try { pauseResult = await api.queueAction('set_pause', { paused: true }, target); }
  catch (error) { pauseResult = { thrown: String(error && error.message || error) }; }
  record('pause', pauseResult);
  await new Promise(resolve => setTimeout(resolve, 300));
  record('afterPause', snapshotQueue());

  // 3) 恢复（用户报告的失败点）
  let resumeResult;
  try { resumeResult = await api.queueAction('set_pause', { paused: false }, target); }
  catch (error) { resumeResult = { thrown: String(error && error.message || error) }; }
  record('resume', resumeResult);
  await new Promise(resolve => setTimeout(resolve, 800));
  record('afterResume', snapshotQueue());

  // 4) 再提交一条，确认暂停/恢复之后仍可入队
  let secondEnqueue;
  try {
    secondEnqueue = await api.queueAction('enqueue', {
      id: 'dev064-probe-2', text: 'dev064 probe second row', requestedMode: 'build', inputMode: 'next'
    }, target);
  } catch (error) {
    secondEnqueue = { thrown: String(error && error.message || error) };
  }
  record('enqueue2', secondEnqueue);
  await new Promise(resolve => setTimeout(resolve, 400));
  record('afterEnqueue2', snapshotQueue());

  // 5) UI 层：面板是否渲染出这两行
  window.renderInputStack();
  const rows = Array.from(document.querySelectorAll('#queue-list .queue-item')).map(row => ({
    id: row.getAttribute('data-queue-id'), text: (row.querySelector('.queue-edit') || {}).value || '', waiting: row.getAttribute('data-queue-branch-waiting')
  }));
  const panel = document.getElementById('queue-panel');
  record('panel', { visible: !!panel && panel.style.display !== 'none', collapsed: !!panel && panel.classList.contains('collapsed'), rows });
  return trace;
})()`;

const uiScenario = `(async () => {
  const target = currentConversationTarget();
  const key = runtimeKeyFor(target.workspaceId, target.conversationId);
  const trace = { calls: [], notices: [], errors: [] };
  window.addEventListener('error', event => trace.errors.push(String(event.message || event.error || '')));
  const originalQueueAction = api.queueAction.bind(api);
  api.queueAction = async (action, input, owner) => {
    let result;
    try { result = await originalQueueAction(action, input, owner); }
    catch (error) { result = { thrown: String(error && error.message || error) }; }
    trace.calls.push({ action, input: { id: input && input.id, text: input && input.text, paused: input && input.paused }, owner, result: result && ({ ok: result.ok, queuePaused: result.queuePaused, items: Array.isArray(result.queueItems) ? result.queueItems.length : undefined, error: result.error, thrown: result.thrown }) });
    return result;
  };
  const notices = () => Array.from(document.querySelectorAll('.ui-notice')).map(node => node.textContent);
  const rows = () => Array.from(document.querySelectorAll('#queue-list .queue-item')).map(row => ({ id: row.getAttribute('data-queue-id'), text: (row.querySelector('.queue-edit') || {}).value || '', waiting: row.getAttribute('data-queue-branch-waiting') }));

  // 让渲染端认为当前对话正在运行，从而把发送路由到队列。
  state.conversationRuntimeStates = state.conversationRuntimeStates || {};
  state.conversationRuntimeStates[key] = { status: 'running', runId: 'probe-running-run', target };
  state.runningConversations = state.runningConversations || {};
  state.runningConversations[key] = { status: 'running', runId: 'probe-running-run', target };
  window.setInputMode('next', false);
  const prompt = document.getElementById('prompt');
  prompt.value = 'ui probe next row';
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  let sendError = '';
  try { await window.sendMessage('next'); } catch (error) { sendError = String(error && error.message || error); }
  await new Promise(resolve => setTimeout(resolve, 600));
  trace.sendError = sendError;
  trace.afterUiSend = { rows: rows(), notices: notices(), nextQueue: (state.nextQueue || []).slice() };

  // 面板上的暂停/恢复按钮（用户报告“无法启动暂停的队列”）
  window.renderInputStack();
  await window.toggleQueuePause();
  await new Promise(resolve => setTimeout(resolve, 400));
  trace.afterUiPause = { paused: !!(state.queuePausedByTarget && state.queuePausedByTarget[key]), rows: rows(), notices: notices() };
  await window.toggleQueuePause();
  await new Promise(resolve => setTimeout(resolve, 900));
  trace.afterUiResume = { paused: !!(state.queuePausedByTarget && state.queuePausedByTarget[key]), rows: rows(), notices: notices() };
  return trace;
})()`;

(async () => {
  const installedExe = String(process.env.NEWMARK_VISUAL_EXE || '').trim();
  const binary = installedExe || require(path.join(desktopRoot, 'node_modules', 'electron'));
  const spawnCwd = installedExe ? path.dirname(installedExe) : desktopRoot;
  const appArgs = installedExe ? [] : [desktopRoot];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkQueueProbe-'));
  const port = await freeTcpPort();
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
      if (await evaluate(cdp, `typeof api !== 'undefined' && !!api.queueAction`)) break;
      await sleep(250);
      if (attempt === 119) fail('renderer api did not become ready');
    }
    const mode = String(process.env.NEWMARK_QUEUE_PROBE_MODE || '').trim();
    const trace = await evaluate(cdp, mode === 'ui' ? uiScenario : scenario);
    console.log(JSON.stringify({ binary: installedExe || 'dev-electron', trace }, null, 2));
  } finally {
    try { cdp?.close(); } catch {}
    try { child?.kill(); } catch {}
    await sleep(400);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(String(error && error.stack || error));
  process.exitCode = 1;
});
