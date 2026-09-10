/**
 * dev-0.6.4 hotfix gate: 选项提问必须归属到提问的那个会话。
 * 后台会话的提问不得溢出到当前对话区，也不得用当前对话作答。
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
  for (let attempt = 0; attempt < 300; attempt++) {
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
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout ${method}`)); }, 60000);
  });
  return { ready: Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('ws timeout')), 15000))]), call, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) return { __exception: result.exceptionDetails.exception?.description || result.exceptionDetails.text };
  return result.result?.value;
}

const scenario = `(async () => {
  const active = currentConversationTarget();
  const other = { workspaceId: active.workspaceId, conversationId: active.conversationId + '-other' };
  // 1) 后台会话的提问到达：不得渲染到当前对话区
  applyConversationCommandSnapshot({ pendingOptions: [{ id: 'q-other', question: 'OTHER_CONVERSATION_QUESTION', options: ['A', 'B'] }] }, other);
  renderChatMessages(state.renderedChatMessages || [], active);
  const leakedBlocks = document.querySelectorAll('#chat-area [data-option-question]').length;
  const ownerKey = runtimeKeyFor(other.workspaceId, other.conversationId);
  const storedForOwner = (state.pendingOptionsByTarget || {})[ownerKey];
  // 2) 切换到提问所属会话：此时才渲染，并且带着归属属性
  setPendingOptionsForTarget(storedForOwner || [], other);
  const previousActive = state.activeConversation ?? null;
  const chatArea = document.getElementById('chat-area');
  renderPendingOptionsInChat(storedForOwner);
  const ownerAttributes = Array.from(chatArea.querySelectorAll('[data-option-question]')).map(node => ({
    workspace: node.getAttribute('data-option-owner-workspace') || '',
    conversation: node.getAttribute('data-option-owner-conversation') || '',
  }));
  // 3) 在当前对话点击“其它会话”的选项：必须被拒绝（不发送到当前会话）
  let refusal = null;
  const block = chatArea.querySelector('[data-option-question]');
  if (block) {
    // 让当前会话与提问归属不同，再尝试作答
    const foreignOwner = { workspaceId: other.workspaceId, conversationId: 'some-other-conversation' };
    block.setAttribute('data-option-owner-conversation', foreignOwner.conversationId);
    const button = block.querySelector('.option-btn');
    const noticesBefore = document.querySelectorAll('.ui-notice').length;
    if (button) window.optionSelected(decodeURIComponent(button.dataset.optionQuestionKey), button.dataset.optionLabel, button);
    await new Promise(resolve => setTimeout(resolve, 200));
    refusal = { noticesAdded: document.querySelectorAll('.ui-notice').length - noticesBefore, promptValue: String((document.getElementById('prompt') || {}).value || '') };
  }
  return {
    leakedBlocksIntoActive: leakedBlocks,
    storedForOwnerConversations: Array.isArray(storedForOwner) ? storedForOwner.length : 0,
    ownerAttributes,
    refusal,
    activeOtherDifferent: String(active.conversationId) !== String(other.conversationId),
  };
})()`;

(async () => {
  const installedExe = String(process.env.NEWMARK_VISUAL_EXE || '').trim();
  const binary = installedExe || require(path.join(desktopRoot, 'node_modules', 'electron'));
  const spawnCwd = installedExe ? path.dirname(installedExe) : desktopRoot;
  const appArgs = installedExe ? [] : [desktopRoot];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkOptionOwner-'));
  const port = await freeTcpPort();
  let child;
  let cdp;
  try {
    child = spawn(binary, [...appArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'ElectronData')}`, '--no-sandbox', '--root', root],
      { cwd: spawnCwd, stdio: 'ignore', windowsHide: true });
    cdp = connect(await discover(port, child));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate(cdp, `typeof renderPendingOptionsInChat === 'function' && typeof applyConversationCommandSnapshot === 'function'`)) break;
      await sleep(250);
      if (attempt === 119) throw new Error('renderer functions not ready');
    }
    const result = await evaluate(cdp, scenario);
    console.log(JSON.stringify({ binary: installedExe || 'dev-electron', result }, null, 2));
    const problems = [];
    if (result.leakedBlocksIntoActive !== 0) problems.push('background question leaked into the active conversation');
    if (!result.storedForOwnerConversations) problems.push('question was not stored for its owning conversation');
    if (!(result.ownerAttributes || []).some(entry => entry.conversation)) problems.push('rendered option block has no owner conversation attribute');
    if (result.refusal && result.refusal.noticesAdded < 1) problems.push('answering another conversation question was not refused');
    if (problems.length) { console.error('OPTION OWNER PROBLEMS: ' + problems.join('; ')); process.exitCode = 2; }
  } finally {
    try { cdp?.close(); } catch {}
    try { child?.kill(); } catch {}
    await sleep(400);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(String(error && error.stack || error)); process.exitCode = 1; });
