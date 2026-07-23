const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '20260723-dev-0.1.6-conversation-order-ui.png');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fail(message) { throw new Error(message); }
function getJson(url) {
  return new Promise((resolve, reject) => http.get(url, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).on('error', reject));
}
async function waitForTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(400);
  }
  fail('Timed out waiting for packaged renderer');
}
function connect(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const call = (method, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
  });
  return { ws, ready, call };
}
async function evaluate(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await sleep(400);
  }
  fail(`Timed out waiting for ${label}`);
}

(async () => {
  if (process.platform !== 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkConversationOrder-'));
  const port = 49361;
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const target = await waitForTarget(port);
    cdp = connect(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await evaluate(cdp, `window.api.createWorkspace('conversation-order-smoke')`, 30000);
    await waitFor(cdp, `document.querySelector('#conversation-list') && typeof window.renderConversations === 'function'`, 'conversation UI');
    await evaluate(cdp, `(async () => {
      await window.api.ensureConversation({ workspaceId: state.currentWorkspaceId, conversationId: 'alpha' });
      await window.api.ensureConversation({ workspaceId: state.currentWorkspaceId, conversationId: 'beta' });
      await window.api.ensureConversation({ workspaceId: state.currentWorkspaceId, conversationId: 'gamma' });
      await window.api.renameConversation('beta', 'Release renamed chat');
      var snapshot = await window.api.getState({ workspaceId: state.currentWorkspaceId, conversationId: 'beta' });
      applyWorkspaceStateFromBackend(snapshot);
      renderConversations();
      return true;
    })()`, 30000);
    const initial = await evaluate(cdp, `({
      ids: currentWorkspaceConversations().map(item => item.id),
      betaTitle: (currentWorkspaceConversations().find(item => item.id === 'beta') || {}).summary,
      buttons: Array.from(document.querySelectorAll('.conv-item')).every(row => row.draggable && row.querySelector('.conv-rename-btn') && row.querySelector('.conv-archive-btn') && row.querySelector('.conv-pin-btn')),
      sizes: (() => { var row=document.querySelector('.conv-item'); if(!row) return []; return ['.conv-rename-btn','.conv-archive-btn','.conv-pin-btn'].map(sel => { var r=row.querySelector(sel).getBoundingClientRect(); return [r.width,r.height]; }); })()
    })`);
    if (initial.betaTitle !== 'Release renamed chat' || !initial.buttons) fail(`Rename/action controls failed: ${JSON.stringify(initial)}`);
    if (!initial.sizes.every(size => size[0] === initial.sizes[0][0] && size[1] === initial.sizes[0][1])) fail(`Action button sizes differ: ${JSON.stringify(initial.sizes)}`);
    const reordered = ['gamma', 'beta', 'alpha', ...initial.ids.filter(id => !['gamma', 'beta', 'alpha'].includes(id))];
    const orderOk = await evaluate(cdp, `window.api.reorderConversations(${JSON.stringify(reordered)}).then(() => window.api.getState({ workspaceId: state.currentWorkspaceId, conversationId: 'beta' })).then(s => s.conversations.slice(0,3).map(item => item.id).join(',') === 'gamma,beta,alpha')`);
    if (!orderOk) fail('Persisted reorder did not match requested order');
    const newestOk = await evaluate(cdp, `window.api.ensureConversation({ workspaceId: state.currentWorkspaceId, conversationId: 'newest' }).then(() => window.api.getState({ workspaceId: state.currentWorkspaceId, conversationId: 'newest' })).then(s => s.conversations.filter(item => !item.pinned)[0].id === 'newest')`);
    if (!newestOk) fail('New conversation was not inserted at the top of the unpinned group');
    const settingsOk = await evaluate(cdp, `(() => { window.openSettings('general'); var select=document.querySelector('#stab-general select[onchange*="setExpandToolsDefault"]'); var lazy=document.querySelector('#stab-models[data-lazy="1"]'); return !!select && !!lazy; })()`);
    if (!settingsOk) fail('General setting or lazy settings panel missing');
    await cdp.call('Page.bringToFront');
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
    console.log(JSON.stringify({ ok: true, version: '0.1.6', screenshotPath, buttonSizes: initial.sizes }));
  } finally {
    try { cdp?.ws.close(); } catch {}
    child.kill();
    spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; 'packaged UI stopped'"], { windowsHide: true });
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
