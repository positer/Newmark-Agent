/**
 * 安装版实机队列测试：真实 provider（deepseek-v4.1-flash-expires-on-0910）。
 *
 * 使用隔离 root + 复制用户 config.json（含凭据），不污染现有会话：
 *   1. 首个真实 Build 运行中提交 Next（走输入框 + Next 模式）
 *   2. 队列面板出现该行（对话区不应提前出现）
 *   3. 暂停 / 恢复
 *   4. 出队后：用户输入 + 模型回复都出现在对话区
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const desktopRoot = path.resolve(__dirname, '..');
const archiveDir = path.join(desktopRoot, '..', 'archive', '20260910-dev064-real-deepseek-queue');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL = String(process.env.NEWMARK_TEST_MODEL || 'deepseek-v4.1-flash-expires-on-0910');

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(error => error ? reject(error) : resolve(address.port)); });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.setTimeout(1500, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function discover(port, child) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`app exited: ${child.exitCode}`);
    try {
      const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = pages.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP timeout');
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
  const call = (method, params = {}) => {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
    const id = ++sequence;
    // Keep the promise itself referenced while awaiting: V8 otherwise collects the
    // pending promise during long real-model runs and rejects with "Promise was collected".
    globalThis.__pending = globalThis.__pending || new Map();
    globalThis.__pending.set(id, promise);
    pending.set(id, { resolve: resolveFn, reject: rejectFn });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) {
        globalThis.__pending.delete(id);
        rejectFn(new Error(`timeout ${method}`));
      }
    }, 600000);
    return promise.finally(() => { globalThis.__pending.delete(id); });
  };
  return { ready: Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('ws timeout')), 15000))]), call, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) return { __exception: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
  return result.result?.value;
}

async function shot(cdp, name) {
  const captured = await cdp.call('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(archiveDir, { recursive: true });
  const file = path.join(archiveDir, name);
  fs.writeFileSync(file, Buffer.from(captured.data, 'base64'));
  return file;
}

const snapshotExpr = `(async () => {
  const target = currentConversationTarget();
  const snapshot = await api.getState(target);
  window.renderInputStack();
  return {
    model: state.model,
    status: snapshot && snapshot.status,
    running: !!(snapshot && snapshot.runtime && snapshot.runtime.running),
    queuePaused: snapshot && snapshot.queuePaused,
    queueItems: (snapshot && snapshot.queueItems || []).map(item => item.text),
    chatMessages: (snapshot.chatMessages || []).map(message => '[' + String(message.role) + '] ' + String(message.content || '').replace(/\\s+/g, ' ').slice(0, 80)),
    renderedUserBubbles: Array.from(document.querySelectorAll('#chat-area .chat-msg.user')).map(node => String(node._newmarkMessageText || '').replace(/\\s+/g, ' ').slice(0, 60)),
    panelRows: Array.from(document.querySelectorAll('#queue-list .queue-item')).map(row => (row.querySelector('.queue-edit') || {}).value || ''),
    inlineQueuedBubbles: document.querySelectorAll('#chat-area .queue-pending-user').length,
    replySnippet: ((snapshot.chatMessages || []).filter(message => String(message.role) === 'assistant').pop() || {}).content || ''
  };
})()`;

(async () => {
  const installedExe = String(process.env.NEWMARK_VISUAL_EXE || 'C:\\Program Files\\Newmark Agent\\Newmark Agent.exe');
  const binary = fs.existsSync(installedExe) ? installedExe : require(path.join(desktopRoot, 'node_modules', 'electron'));
  const spawnCwd = fs.existsSync(installedExe) ? path.dirname(installedExe) : desktopRoot;
  const appArgs = fs.existsSync(installedExe) ? [] : [desktopRoot];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRealQueue-'));
  const userConfig = path.join(os.homedir(), '.Newmark', 'config.json');
  if (fs.existsSync(userConfig)) fs.copyFileSync(userConfig, path.join(root, 'config.json'));
  const port = await freeTcpPort();
  const evidence = { binary, model: MODEL, steps: [] };
  let child;
  let cdp;
  try {
    child = spawn(binary, [...appArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'ElectronData')}`, '--no-sandbox', '--root', root],
      { cwd: spawnCwd, stdio: process.env.NEWMARK_SMOKE_DEBUG === '1' ? 'inherit' : 'ignore', windowsHide: true });
    cdp = connect(await discover(port, child));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await evaluate(cdp, `typeof api !== 'undefined' && !!api.sendMessage && !!api.getState`)) break;
      await sleep(250);
      if (attempt === 159) throw new Error('renderer api not ready');
    }
    evidence.steps.push({ name: 'selectModel', value: await evaluate(cdp, `(async () => {
      const select = document.getElementById('model-select');
      const hasOption = select && Array.from(select.options).some(option => String(option.value) === ${JSON.stringify(MODEL)});
      if (hasOption) { select.value = ${JSON.stringify(MODEL)}; select.dispatchEvent(new Event('change', { bubbles: true })); }
      if (api.setModel) await api.setModel(${JSON.stringify(MODEL)});
      await new Promise(resolve => setTimeout(resolve, 500));
      return { stateModel: state.model, optionPresent: !!hasOption };
    })()`) });

    // 首个真实 Build
    evidence.steps.push({ name: 'firstBuild', value: await evaluate(cdp, `(async () => {
      window.setInputMode('build', false);
      const prompt = document.getElementById('prompt');
      prompt.value = '请用中文写一段约 120 字的说明：为什么要给排队消息保留独立的执行身份。';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      await window.sendMessage('build');
      await new Promise(resolve => setTimeout(resolve, 1500));
      return { model: state.model };
    })()`) });

    // 运行中提交 Next（真实 UI：Next 模式 + 输入框 + 发送）
    let queued = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      queued = await evaluate(cdp, `(async () => {
        const target = currentConversationTarget();
        const snapshot = await api.getState(target);
        const running = !!(snapshot && (snapshot.status === 'running' || (snapshot.runtime && snapshot.runtime.running)));
        if (!running) return null;
        window.setInputMode('next', false);
        const prompt = document.getElementById('prompt');
        prompt.value = '排队测试：请回复 QUEUED_TURN_OK';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        await window.sendMessage('next');
        await new Promise(resolve => setTimeout(resolve, 1500));
        window.renderInputStack();
        return {
          panelRows: Array.from(document.querySelectorAll('#queue-list .queue-item')).map(row => (row.querySelector('.queue-edit') || {}).value || ''),
          inlineQueuedBubbles: document.querySelectorAll('#chat-area .queue-pending-user').length,
          panelVisible: (function() { const panel = document.getElementById('queue-panel'); return !!panel && panel.style.display !== 'none'; })()
        };
      })()`);
      if (queued) break;
      await sleep(500);
    }
    evidence.steps.push({ name: 'queuedWhileRunning', value: queued || { skipped: 'never observed a running build' } });
    evidence.queuedShot = await shot(cdp, 'queued-row-real-model.png');

    // 暂停 / 恢复
    evidence.steps.push({ name: 'pauseResume', value: await evaluate(cdp, `(async () => {
      window.renderInputStack();
      await window.toggleQueuePause();
      await new Promise(resolve => setTimeout(resolve, 400));
      const paused = await api.getState(currentConversationTarget());
      await window.toggleQueuePause();
      await new Promise(resolve => setTimeout(resolve, 600));
      const resumed = await api.getState(currentConversationTarget());
      return { paused: !!(paused && paused.queuePaused), resumed: !!(resumed && resumed.queuePaused) };
    })()`) });

    // 等出队：用户输入 + 真实模型回复进入对话区
    let final = null;
    for (let attempt = 0; attempt < 240; attempt++) {
      final = await evaluate(cdp, snapshotExpr);
      if (final && !final.running && (final.queueItems || []).length === 0
        && (final.renderedUserBubbles || []).some(text => String(text).includes('排队测试'))
        && (final.chatMessages || []).some(line => String(line).includes('[assistant]'))) break;
      await sleep(2000);
    }
    evidence.steps.push({ name: 'afterDrain', value: final });
    evidence.drainShot = await shot(cdp, 'drained-real-model.png');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    try { cdp?.close(); } catch {}
    try { child?.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(String(error && error.stack || error)); process.exitCode = 1; });
