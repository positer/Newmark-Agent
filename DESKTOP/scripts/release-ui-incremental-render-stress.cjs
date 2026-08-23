// 真实打包 GUI 压力测试：验证增量渲染修复在高压下正确落实。
//  1) 对话菜单行节点在大量进度更新中保持复用 → 跑马灯动画不重启
//  2) Build 块事件列表增量渲染 → 前缀节点引用不变，只重建变化尾部
//  3) 进度更新不强制滚动跟踪：视口停留位置保持；贴底时才跟随
//  4) 模型回退同步输入框下方选择区（幂等），Auto 模式不被污染
//  5) 工作区对话清空后保持为空（重复同步稳定）
//  6) 风暴期间输入事件不被饿死
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');

function fail(message) { throw new Error(`[release-ui-incremental-render-stress] ${message}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2_000, () => request.destroy(new Error('HTTP timeout')));
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl
        && (item.type === 'page' || item.type === 'webview')
        && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  fail(`timed out waiting for Electron CDP target on port ${port}`);
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 20_000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
  return { socket, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 60_000) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || JSON.stringify(details));
  }
  return result.result?.value;
}

function stopProcessTree(pid) {
  if (pid) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
}

async function removeRootWhenReleased(root) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || attempt === 19) throw error;
      await sleep(250);
    }
  }
}

const PAGE_STRESS = `(async () => {
  if (typeof state === 'undefined') throw new Error('missing page state');
  if (typeof renderConversations !== 'function') throw new Error('missing renderConversations');
  if (typeof updateConversationWorkRunElement !== 'function') throw new Error('missing updateConversationWorkRunElement');
  if (typeof applyModelFallbackToInputSurface !== 'function') throw new Error('missing applyModelFallbackToInputSurface');
  const out = {};
  const prompt = document.querySelector('#prompt');
  const list = document.querySelector('#conversation-list');
  const chatArea = document.querySelector('#chat-area');
  if (!prompt || !list || !chatArea) throw new Error('missing core UI nodes');
  if (!state.currentWorkspaceId && !state.currentWorkspace) {
    state.currentWorkspace = 'Stress Workspace';
    state.currentWorkspaceId = 'stress-ws';
  }
  const wsKey = currentWorkspaceKey();
  const wsId = runtimeWorkspaceId('');

  // 风暴期间的输入响应检查（10ms 间隔计时器 + 300 轮渲染压力并行）
  let maxInputDelayMs = 0;
  let inputEvents = 0;
  let expectedAt = performance.now() + 10;
  const inputTimer = setInterval(() => {
    const now = performance.now();
    maxInputDelayMs = Math.max(maxInputDelayMs, now - expectedAt);
    expectedAt = now + 10;
    prompt.value += 'x';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    inputEvents += 1;
  }, 10);

  // ── 1. 对话菜单行节点复用（跑马灯不重启） ──
  state.workspaceConversations[wsKey] = [
    { id: 'stress-a', summary: 'alpha', archived: false, active: false, pinned: false },
    { id: 'stress-b', summary: 'beta running', archived: false, active: false, pinned: false },
    { id: 'stress-c', summary: 'gamma', archived: false, active: true, pinned: false },
  ];
  state.conversationRuntimeStates = state.conversationRuntimeStates || {};
  state.runningConversations = state.runningConversations || {};
  const runningKey = currentRuntimeKey('stress-b');
  state.conversationRuntimeStates[runningKey] = { status: 'running', runId: 'marquee-run', target: { workspaceId: wsId, conversationId: 'stress-b' } };
  state.runningConversations[runningKey] = state.conversationRuntimeStates[runningKey];
  renderConversations();
  const marqueeRow = list.querySelector('.conv-item[data-conversation-id="stress-b"]');
  if (!marqueeRow || !marqueeRow.classList.contains('marquee-border')) throw new Error('marquee row missing');
  const animationBefore = getComputedStyle(marqueeRow, '::before').animationName;
  if (!animationBefore || animationBefore === 'none') throw new Error('marquee animation not active');
  for (let i = 0; i < 300; i += 1) {
    state.conversationRuntimeStates[runningKey].status = i % 9 === 0 ? 'stopping' : 'running';
    renderConversations();
    if (document.querySelector('.conv-item[data-conversation-id="stress-b"]') !== marqueeRow) {
      throw new Error('marquee row node was replaced at iteration ' + i + ' (animation restarts)');
    }
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const animationAfter = getComputedStyle(marqueeRow, '::before').animationName;
  if (animationAfter !== animationBefore) throw new Error('marquee animation identity changed: ' + animationBefore + ' -> ' + animationAfter);
  out.menu = { rowReused: true, animation: animationAfter };

  // ── 2. Build 块事件列表增量渲染（前缀节点引用不变） ──
  const run = {
    runId: 'incremental-run', status: 'running', expanded: true, startedAt: new Date().toISOString(),
    target: { workspaceId: wsId, conversationId: 'stress-b' }, events: [],
  };
  const baseEvents = [];
  baseEvents.push({ id: 't0', type: 'thought', content: 'thinking', timestamp: new Date().toISOString(), sequence: 0 });
  for (let t = 0; t < 3; t += 1) baseEvents.push({ id: 'tool-' + t, type: 'tool_call', toolName: 'read', toolArgs: '{"path":"a.txt"}', content: 'read', timestamp: new Date().toISOString(), sequence: t + 1 });
  baseEvents.push({ id: 's0', type: 'status', content: 'started', timestamp: new Date().toISOString(), sequence: 4 });
  run.events = baseEvents.slice();
  renderConversationWorkRun(run);
  const body = document.querySelector('.conversation-work-run[data-run-id="incremental-run"] .conversation-work-run-body');
  const container = body && body.querySelector('.conversation-work-run-events');
  if (!container) throw new Error('run events container missing');
  const prefixRefs = Array.prototype.slice.call(container.children);
  let seq = baseEvents.length;
  let nodeReplacements = 0;
  // 同步契约验证：60 轮增量更新（每轮让出事件循环），前缀节点引用必须保持
  for (let i = 0; i < 60; i += 1) {
    const kind = i % 3;
    const ev = kind === 0
      ? { id: 'ev-' + i, type: 'text', content: 'l' + i + '\\n', timestamp: new Date(Date.now() + i).toISOString(), sequence: seq++ }
      : kind === 1
        ? { id: 'ev-' + i, type: 'status', content: 'p' + i, timestamp: new Date(Date.now() + i).toISOString(), sequence: seq++ }
        : { id: 'ev-' + i, type: 'tool_call', toolName: 'grep', toolArgs: '{"pattern":"x"}', content: 'grep', timestamp: new Date(Date.now() + i).toISOString(), sequence: seq++ };
    run.events.push(ev);
    updateConversationWorkRunElement(run);
    const children = Array.prototype.slice.call(container.children);
    for (let p = 0; p < prefixRefs.length && p < children.length; p += 1) {
      if (children[p] !== prefixRefs[p]) {
        nodeReplacements += 1;
        if (nodeReplacements > 2) throw new Error('stable prefix node replaced at index ' + p + ' on event ' + i);
        prefixRefs[p] = children[p];
      }
    }
    if (children.length === 0) throw new Error('run events disappeared on event ' + i);
    await new Promise(r => setTimeout(r, 0));
  }
  // 真实事件风暴形态：300 个事件快速到达，走 100ms 节流渲染路径；
  // 期间输入计时器必须保持响应（不饿死）。
  const stormSeqStart = seq;
  for (let i = 0; i < 300; i += 1) {
    const kind = i % 3;
    const ev = kind === 0
      ? { id: 'storm-' + i, type: 'text', content: 's' + i + '\\n', timestamp: new Date(Date.now() + i).toISOString(), sequence: seq++ }
      : kind === 1
        ? { id: 'storm-' + i, type: 'status', content: 'sp' + i, timestamp: new Date(Date.now() + i).toISOString(), sequence: seq++ }
        : { id: 'storm-' + i, type: 'tool_call', toolName: 'bash', toolArgs: '{"command":"echo"}', content: 'bash', timestamp: new Date(Date.now() + i).toISOString(), sequence: seq++ };
    run.events.push(ev);
    scheduleConversationWorkRunRender(run);
  }
  await new Promise(r => setTimeout(r, 700));
  const stormChildren = Array.prototype.slice.call(container.children);
  for (let p = 0; p < prefixRefs.length && p < stormChildren.length; p += 1) {
    if (stormChildren[p] !== prefixRefs[p]) {
      nodeReplacements += 1;
      if (nodeReplacements > 2) throw new Error('stable prefix node replaced after throttled storm at index ' + p);
      prefixRefs[p] = stormChildren[p];
    }
  }
  out.workRun = { prefixRefs: prefixRefs.length, finalChildren: container.children.length, replacements: nodeReplacements, stormSeq: seq - stormSeqStart };

  // ── 3. 滚动位置保持：视口停留中间时不强制跟踪最新 ──
  const thirdScroll = Math.floor(chatArea.scrollHeight / 3);
  chatArea.scrollTop = thirdScroll;
  chatArea.dispatchEvent(new Event('scroll'));
  const heldScroll = chatArea.scrollTop;
  for (let i = 0; i < 80; i += 1) {
    run.events.push({ id: 'scroll-ev-' + i, type: 'status', content: 's' + i, timestamp: new Date(Date.now() + i).toISOString(), sequence: seq++ });
    updateConversationWorkRunElement(run);
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const scrollAfter = chatArea.scrollTop;
  if (Math.abs(scrollAfter - heldScroll) > 2) throw new Error('scroll was forced toward latest during progress updates: ' + heldScroll + ' -> ' + scrollAfter);
  if (shouldAutoScroll(chatArea)) throw new Error('scroll unexpectedly reported at-bottom while parked mid-view');
  out.scroll = { held: heldScroll, after: scrollAfter, parked: true };
  // 贴底时应跟随最新
  chatArea.scrollTop = chatArea.scrollHeight;
  chatArea.dispatchEvent(new Event('scroll'));
  run.events.push({ id: 'bottom-ev', type: 'status', content: 'bottom', timestamp: new Date().toISOString(), sequence: seq++ });
  updateConversationWorkRunElement(run);
  if (!shouldAutoScroll(chatArea)) throw new Error('bottom-follow was lost after an update');
  out.scroll.bottomFollow = true;

  // ── 4. 模型回退同步输入框下方选择区 ──
  state.providers = [
    { id: 'p1', name: 'Provider One', enabled: true, models: [
      { name: 'primary', display: 'Primary', enabled: true },
      { name: 'backup', display: 'Backup', enabled: true },
    ] },
  ];
  state.models = [];
  state.autoSwitch = 'off';
  state.model = 'deployment:p1:primary';
  state.modelLabel = '';
  refreshModelSelect();
  syncModelSelectSurface();
  const labelBefore = document.querySelector('#model-select-label').textContent;
  if (!/Primary/.test(labelBefore)) throw new Error('model label not primary: ' + labelBefore);
  for (let i = 0; i < 50; i += 1) {
    applyModelFallbackToInputSurface({ type: 'status', fallback: { from: 'primary', to: 'backup', providerId: 'p1' } });
  }
  if (state.model !== 'deployment:p1:backup') throw new Error('model selection was not synced to the fallback model: ' + state.model);
  const labelAfter = document.querySelector('#model-select-label').textContent;
  if (!/Backup/.test(labelAfter)) throw new Error('model label not backup: ' + labelAfter);
  // Auto 模式的路由切换不污染选择区
  state.autoSwitch = 'on';
  state.model = 'auto';
  refreshModelSelect();
  applyModelFallbackToInputSurface({ type: 'status', fallback: { from: 'a', to: 'b', providerId: 'p1' } });
  if (state.model !== 'auto') throw new Error('Auto selection was polluted by a fallback event: ' + state.model);
  out.modelFallback = { labelAfter: labelAfter, autoKept: state.model === 'auto' };

  // ── 5. 工作区对话清空后保持为空（重复同步稳定） ──
  state.workspaceConversations[wsKey] = [
    { id: 'stress-a', summary: 'alpha', archived: false, active: false, pinned: false },
    { id: 'stress-c', summary: 'gamma', archived: false, active: true, pinned: false },
  ];
  applyBackendConversations([], 'stress-a', wsKey);
  if ((state.workspaceConversations[wsKey] || []).length !== 0) throw new Error('emptied workspace was refilled with a default conversation');
  if (state.activeConversation !== -1) throw new Error('active conversation index was not cleared: ' + state.activeConversation);
  renderConversations();
  if (list.querySelector('.conv-item')) throw new Error('empty workspace still renders conversation rows');
  if (!/No conversations/.test(list.textContent || '')) throw new Error('empty-state hint missing: ' + list.textContent);
  for (let i = 0; i < 50; i += 1) {
    applyBackendConversations([], 'x', wsKey);
    renderConversations();
  }
  if ((state.workspaceConversations[wsKey] || []).length !== 0 || list.querySelector('.conv-item')) {
    throw new Error('empty workspace became unstable under repeated backend syncs');
  }
  out.emptyKeep = true;

  // 收尾：恢复 auto 测试前的 providers 状态并关掉输入计时器
  clearInterval(inputTimer);
  out.input = { events: inputEvents, maxDelayMs: maxInputDelayMs };
  if (inputEvents < 60 || maxInputDelayMs > 100) throw new Error('input event loop was starved during the stress storm: ' + JSON.stringify(out.input));
  return out;
})()`;

async function main() {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(exePath)) fail(`missing packaged GUI: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-ui-incremental-render-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: { providers: [], default_model: '', default_intelligence: 'low' },
    general: { language: 'en' },
    workspace: { prompt_mode: 'global_only', auto_create_timestamp_workspace: true },
  }, null, 2), 'utf8');
  const port = Number(process.env.NEWMARK_UI_INCREMENTAL_STRESS_PORT || '49433');
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root], {
      cwd: root, stdio: 'ignore', windowsHide: true,
    });
    const target = await waitForTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    const result = await evaluate(cdp, PAGE_STRESS, 90_000);
    if (!result || result.menu?.rowReused !== true) fail(`conversation-menu row reuse failed: ${JSON.stringify(result)}`);
    if (!result.workRun || !(result.workRun.prefixRefs >= 2) || result.workRun.replacements > 2) fail(`work-run incremental prefix reuse failed: ${JSON.stringify(result.workRun)}`);
    if (!result.scroll?.parked || result.scroll.bottomFollow !== true) fail(`scroll-follow contract failed: ${JSON.stringify(result.scroll)}`);
    if (!result.modelFallback || !/Backup/.test(result.modelFallback.labelAfter) || result.modelFallback.autoKept !== true) fail(`model fallback UI sync failed: ${JSON.stringify(result.modelFallback)}`);
    if (result.emptyKeep !== true) fail('emptied workspace keep-empty failed');
    if (!result.input || result.input.events < 60 || result.input.maxDelayMs > 100) fail(`input starvation: ${JSON.stringify(result.input)}`);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    try { cdp?.socket.close(); } catch {}
    stopProcessTree(child?.pid);
    await removeRootWhenReleased(root);
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
