/**
 * dev-0.6.4 visual verification (PC renderer, real Electron window).
 *
 * 场景 A：从 Build 开头编辑产生的分页必须显示分页条；该页新发送的消息留在本页。
 * 场景 B：排队中的用户输入必须可见（输入栈队列行 + 内联「排队中」用户气泡）。
 * 场景 C：时间线里的 Guide 只保留复制按钮。
 *
 * 脚本驱动真实 renderer 函数，不重写任何生产逻辑；截图写入 archive/。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const repoRoot = path.resolve(__dirname, '..', '..');
const desktopRoot = path.resolve(__dirname, '..');
const archiveDir = path.join(repoRoot, 'archive');
const stamp = '20260910-dev-0.6.4-branch-page-queue';
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
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
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
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, 30000);
  });
  return { ready: Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('CDP websocket timeout')), 15000))]), call, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function screenshot(cdp, filePath) {
  const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
  return filePath;
}

const scenarioScript = `(() => {
  const target = currentConversationTarget();
  const stamp = '2026-09-10T02:00:0';
  state.conversationBranchGroups = [];
  state.conversationBranches = [];
  state.seenBranchNodesByClientId = {};
  // 场景 A：Build 开头的用户输入（没有 data-message-id 的 Guide 形卡片）+ 分页
  const runId = 'dev064-build-run';
  const run = {
    runId,
    target,
    status: 'interrupted',
    expanded: true,
    startedAt: stamp + '1.000Z',
    endedAt: stamp + '3.000Z',
    branchNodeId: 'page-b',
    primaryPrompt: '编辑后的输入：从 Build 开头修改',
    events: [
      { id: 'e1', sequence: 1, type: 'tool_call', toolName: 'apply_patch', toolArgs: JSON.stringify({ path: 'DESKTOP/src/ui/index.html' }), completed: true },
      {
        id: 'e-guide', sequence: 2, type: 'guide_applied', timestamp: stamp + '2.000Z',
        guide: { clientMessageId: 'build-start-input', guideId: 'build-start-guide', content: '编辑后的输入：从 Build 开头修改', status: 'applied', runId, createdAt: stamp + '1.000Z' }
      },
      { id: 'e2', sequence: 2, type: 'text', content: '已按分页重写这条输入。' }
    ]
  };
  syncWorkRunsSnapshot([run], target, 'page-b');
  state.guideMessageIndexByClientId = { 'build-start-input': 0 };
  hydrateConversationBranchState({
    branches: [
      { id: 'page-a', sourceMessageIndex: 0, sourceText: '原始输入：从 Build 开头修改' },
      { id: 'page-b', sourceMessageIndex: 0, sourceText: '编辑后的输入：从 Build 开头修改' }
    ],
    activeBranchId: 'page-b',
    runtimeBranchId: 'page-b',
    branchGroupId: 'start-group',
    viewedBranchNodePath: ['root-node', 'page-b'],
    runtimeBranchNodePath: ['root-node', 'page-b'],
    branchGroups: [{
      id: 'start-group',
      sourceMessageIndex: 0,
      activeBranchId: 'page-b',
      branches: [
        { id: 'page-a', sourceMessageIndex: 0, sourceText: '原始输入：从 Build 开头修改' },
        { id: 'page-b', sourceMessageIndex: 0, sourceText: '编辑后的输入：从 Build 开头修改' }
      ]
    }]
  });
  renderChatMessages([
    { role: 'user', content: '编辑后的后续消息：留在本页', messageId: 'page-b-follow-up', timestamp: stamp + '4.000Z' }
  ], target);
  const pager = document.querySelector('.conversation-branch-pager');
  const pagerAnchorIndex = pager && pager.closest('.chat-msg.user') && pager.closest('.chat-msg.user').getAttribute('data-message-index');
  const pageBMessageVisible = Array.from(document.querySelectorAll('.chat-msg.user'))
    .some(node => String(node._newmarkMessageText || '').indexOf('编辑后的后续消息') >= 0);

  // 场景 B：排队中的 Next 输入可见（队列面板行 + 内联排队用户气泡）
  state.nextQueue = ['排队输入：请在该分页继续', '排队输入：属于另一条分页'];
  // 权威队列行（内核 queueItems 载荷）带着受理时捕获的分支节点路径。
  setQueueItemsForTarget([
    { id: 'queue-page-b', text: '排队输入：请在该分页继续', queueMode: 'followUp', requestedMode: 'build', createdAt: '2026-09-10T02:00:05.000Z', images: [], branchNodeId: 'page-b', branchPath: ['root-node', 'page-b'] },
    { id: 'queue-page-a', text: '排队输入：属于另一条分页', queueMode: 'followUp', requestedMode: 'build', createdAt: '2026-09-10T02:00:06.000Z', images: [], branchNodeId: 'page-a', branchPath: ['root-node', 'page-a'] }
  ], target);
  state.nextQueueRequests = [{
    text: '排队输入：请在该分页继续',
    target,
    branchPath: 'page-b',
    queueItemId: 'queue-page-b',
    backendManaged: true,
    provenance: 'backend-follow-up'
  }, {
    text: '排队输入：属于另一条分页',
    target,
    branchPath: 'page-a',
    queueItemId: 'queue-page-a',
    backendManaged: true,
    provenance: 'backend-follow-up'
  }];
  state.backendQueuesByTarget = {};
  state.backendQueuesByTarget[runtimeKeyFor(target.workspaceId, target.conversationId)] = { steering: [], followUp: ['排队输入：请在该分页继续', '排队输入：属于另一条分页'] };
  state.queueCollapsed = true;
  renderInputStack();
  renderChatMessages(state.renderedChatMessages.slice(), target);
  // 让待执行的排队用户气泡出现在可见区域（输入栈正上方）。
  var chatArea = document.getElementById('chat-area');
  if (chatArea) chatArea.scrollTop = chatArea.scrollHeight;
  const queuePanel = document.getElementById('queue-panel');
  const queueRows = Array.from(document.querySelectorAll('#queue-list .queue-item'));
  const waitingRows = queueRows.filter(row => row.getAttribute('data-queue-branch-waiting') === '1');
  // 场景 C：Guide 卡片只保留复制按钮
  const guide = document.querySelector('.work-run-guide-message[data-client-message-id="build-start-input"]');
  const guideActions = guide ? Array.from(guide.querySelectorAll('.msg-action-btn')).map(button => button.title) : [];

  return {
    pagerText: pager ? pager.textContent : '',
    pagerAnchorIndex,
    pagerGroupId: pager ? pager.getAttribute('data-branch-group-id') : '',
    pageBMessageVisible,
    queuePanelVisible: !!queuePanel && queuePanel.style.display !== 'none',
    queuePanelExpanded: !!queuePanel && !queuePanel.classList.contains('collapsed'),
    queueRowCount: queueRows.length,
    queueRowText: queueRows.map(row => (row.querySelector('.queue-edit') || {}).value || ''),
    waitingRowCount: waitingRows.length,
    waitingRowText: waitingRows.map(row => (row.querySelector('.queue-edit') || {}).value || ''),
    // dev-0.6.4：未进入对话的排队输入只出现在队列面板，不再画进对话区。
    inlineQueuedBubbleCount: document.querySelectorAll('.chat-msg.user.queue-pending-user').length,
    inlineQueuedTextCount: Array.from(document.querySelectorAll('#chat-area .chat-msg.user'))
      .filter(node => String(node._newmarkMessageText || '').indexOf('排队输入：') >= 0).length,
    guideActionTitles: guideActions,
    chatMessageCount: document.querySelectorAll('#chat-area .chat-msg').length
  };
})()`;

(async () => {
  // Default: the workspace Electron binary (dev renderer). Set NEWMARK_VISUAL_EXE
  // to run the same gate against an installed/packaged executable.
  const installedExe = String(process.env.NEWMARK_VISUAL_EXE || '').trim();
  const electronBinary = installedExe || require(path.join(desktopRoot, 'node_modules', 'electron'));
  const spawnCwd = installedExe ? path.dirname(installedExe) : desktopRoot;
  const appArgs = installedExe ? [] : [desktopRoot];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkDev064Visual-'));
  const port = await freeTcpPort();
  let child;
  let cdp;
  try {
    child = spawn(electronBinary, [
      ...appArgs,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(root, 'ElectronData')}`,
      '--no-sandbox',
      '--root', root,
    ], {
      cwd: spawnCwd,
      stdio: process.env.NEWMARK_SMOKE_DEBUG === '1' ? 'inherit' : 'ignore',
      windowsHide: true,
    });
    cdp = connect(await discoverTarget(port, child));
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    for (let attempt = 0; attempt < 120; attempt++) {
      const ready = await evaluate(cdp, `typeof renderChatMessages === 'function' && typeof renderConversationBranchPagers === 'function' && typeof renderInputStack === 'function'`);
      if (ready) break;
      await sleep(250);
      if (attempt === 119) fail('renderer functions did not become ready');
    }
    const evidence = await evaluate(cdp, scenarioScript);
    const fullShot = await screenshot(cdp, path.join(archiveDir, `${stamp}-full.png`));
    // 视口底部特写：排队中的用户气泡 + 输入栈里的队列行。
    const bottomClip = await evaluate(cdp, `(() => {
      const chat = document.getElementById('chat-area');
      const queuePanel = document.getElementById('queue-panel');
      const chatRect = chat.getBoundingClientRect();
      const queueRect = queuePanel ? queuePanel.getBoundingClientRect() : chatRect;
      const top = Math.max(chatRect.top, (queuePanel ? queueRect.top : chatRect.bottom) - 200);
      const bottom = (queuePanel ? queueRect.bottom : chatRect.bottom) + 8;
      return { x: chatRect.left, y: top, width: chatRect.width, height: Math.max(120, bottom - top) };
    })()`);
    if (bottomClip && bottomClip.width > 40 && bottomClip.height > 40) {
      const bottomResult = await cdp.call('Page.captureScreenshot', { format: 'png', clip: { ...bottomClip, scale: 1 } });
      fs.writeFileSync(path.join(archiveDir, `${stamp}-pending-queue-bottom.png`), Buffer.from(bottomResult.data, 'base64'));
    }
    const chatClip = await evaluate(cdp, `(() => {
      const chat = document.getElementById('chat-area');
      const composer = document.getElementById('queue-panel') || chat;
      const chatRect = chat.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const top = Math.max(0, Math.min(chatRect.top, composerRect.top) - 12);
      const bottom = Math.max(chatRect.bottom, composerRect.bottom) + 12;
      return { x: Math.max(0, Math.min(chatRect.left, composerRect.left) - 12), y: top, width: Math.min(window.innerWidth, Math.max(chatRect.right, composerRect.right) + 12) - Math.max(0, Math.min(chatRect.left, composerRect.left) - 12), height: bottom - top };
    })()`);
    if (chatClip && chatClip.width > 40 && chatClip.height > 40) {
      const clipResult = await cdp.call('Page.captureScreenshot', { format: 'png', clip: { ...chatClip, scale: 1 } });
      fs.writeFileSync(path.join(archiveDir, `${stamp}-chat-queue.png`), Buffer.from(clipResult.data, 'base64'));
    }
    console.log(JSON.stringify({ ok: true, evidence, screenshots: [fullShot, path.join(archiveDir, `${stamp}-chat-queue.png`)] }, null, 2));
    const problems = [];
    if (!evidence.pagerText) problems.push('pager missing on the edited build-start page');
    if (!evidence.pageBMessageVisible) problems.push('new page message missing from its own transcript');
    if (!evidence.queuePanelVisible) problems.push('queue panel hidden');
    if (evidence.queueRowCount !== 2) problems.push('queued rows missing from the input stack: ' + evidence.queueRowCount);
    if (evidence.waitingRowCount !== 1) problems.push('row bound to another page is not marked as waiting: ' + evidence.waitingRowCount);
    if (evidence.inlineQueuedBubbleCount !== 0) problems.push('queued input must not render inline: ' + evidence.inlineQueuedBubbleCount);
    if (evidence.inlineQueuedTextCount !== 0) problems.push('queued input leaked into the transcript: ' + evidence.inlineQueuedTextCount);
    const guideAction = String(evidence.guideActionTitles[0] || '');
    const guideActionIsCopyOnly = evidence.guideActionTitles.length === 1 && (guideAction.includes('复制') || guideAction.toLowerCase().includes('copy'));
    if (!guideActionIsCopyOnly) {
      problems.push('guide card actions are not copy-only: ' + JSON.stringify(evidence.guideActionTitles));
    }
    if (problems.length) fail('visual verification failed: ' + problems.join('; '));
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
