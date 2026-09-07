// Actual Electron renderer measurements; all fixture data stays in an owned runtime.
// --exe <unpacked exe> reuses the same checks against a packaged application.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const desktopRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const evidence = path.resolve(option('--evidence', path.join(desktopRoot, '..', 'archive', 'renderer-stability')));
const label = option('--label', 'result');
const executable = option('--exe', require('electron'));
const packaged = args.includes('--exe');
const port = Number(option('--port', '49803'));
const baseline = args.includes('--baseline');
const uiSource = option('--ui-source', '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  };
  return { socket, ready, call(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, timeout);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  } };
}
async function targetAt() {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    try {
      const items = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1000) })).json();
      const target = items.find(item => item.type === 'page' && item.url.includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(150);
  }
  throw Error('Owned Electron renderer unavailable');
}
async function rendererCases() {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const out = { checks: [], errors: [], actions: [] };
  const check = (name, pass, details) => out.checks.push({ name, pass: !!pass, details });
  window.addEventListener('error', event => out.errors.push(String(event.error?.stack || event.message)));
  const target = currentConversationTarget();
  // The isolated local provider accepts the title and holds its formal stream.
  const activeRun = api.sendMessage('Initialize isolated queue identity fixture', target).catch(() => null);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await api.getState(target)).runtime?.running) break;
    await sleep(50);
  }
  const realQueueAction = window.queueAction;
  const pending = [];
  window.queueAction = function(action, input) {
    const captured = { action, input: JSON.parse(JSON.stringify(input)), target: currentConversationTarget() };
    out.actions.push(captured);
    const promise = Promise.resolve(realQueueAction(action, input)).then(result => { captured.result = result; return result; });
    pending.push(promise);
    return promise;
  };
  const settled = async () => { await Promise.all(pending.splice(0)); await sleep(150); };
  const snapshot = () => api.getState(target);
  function coherentQueue(operation, current) {
    const identified = (current.queueItems || []).filter(item => item.queueMode === 'followUp').map(item => item.text);
    const displayed = (current.queued?.followUp || []).map(normalizeQueueItemText);
    check(operation + ' keeps identified and displayed backend order coherent', JSON.stringify(identified) === JSON.stringify(displayed), { identified, displayed });
  }
  async function seed() {
    let current = await snapshot();
    if (!current.queuePaused) await api.queueAction('queue_toggle_pause', {}, target);
    for (const item of current.queueItems || []) await api.queueAction('queue_delete', { id: item.id }, target);
    for (const item of [
      { id: 'duplicate-first', text: 'same queued text', requestedMode: 'plan', createdAt: '2026-09-06T00:00:01.000Z' },
      { id: 'different-middle', text: 'between the duplicates', requestedMode: 'build', createdAt: '2026-09-06T00:00:02.000Z' },
      { id: 'duplicate-second', text: 'same queued text', requestedMode: 'goal', goalObjective: 'Keep the second queue objective', createdAt: '2026-09-06T00:00:03.000Z' },
    ]) {
      const result = await api.queueAction('queue_enqueue', item, target);
      if (!result.ok) throw new Error('Queue fixture enqueue failed: ' + JSON.stringify(result));
    }
    current = await snapshot();
    state.pendingInputEdit = null; state._editingQueueIndex = -1;
    state.nextQueue = []; state.nextQueueRequests = []; state.queueHiddenItems = {};
    state.queueCollapsed = false; state.inputMode = 'next'; state.mode = 'build';
    setQueueItemsForTarget(current.queueItems, target);
    setBackendQueueForTarget(current.queued, target);
    window.renderInputStack();
    await sleep(100);
    check('Fixture exposes three actual DOM rows with two identical texts', document.querySelectorAll('#queue-list .queue-item').length === 3, Array.from(document.querySelectorAll('#queue-list .queue-edit')).map(node => node.value));
    out.actions.length = 0;
  }
  function button(index, operation) {
    const element = document.querySelector(`#queue-list .queue-item[data-queue-index="${index}"] button[onclick*="${operation}"]`);
    if (!element) throw new Error('Real queue DOM button missing: ' + operation + ':' + index);
    return element;
  }
  await seed();
  button(2, 'deleteQueueItem').click(); await settled();
  let after = await snapshot();
  coherentQueue('Delete', after);
  check('Delete second duplicate sends its stable id', out.actions[0]?.input.id === 'duplicate-second', out.actions[0]);
  check('Delete preserves first duplicate in actual backend', JSON.stringify((after.queueItems || []).map(item => item.id)) === JSON.stringify(['duplicate-first', 'different-middle']), after.queueItems);

  await seed();
  button(2, 'focusQueueItem').click();
  els.prompt.value = 'edited second duplicate'; els.prompt.dispatchEvent(new Event('input', { bubbles: true }));
  await window.sendMessage('next'); await settled();
  after = await snapshot();
  coherentQueue('Edit', after);
  check('Edit second duplicate sends its stable id', out.actions[0]?.input.id === 'duplicate-second', out.actions[0]);
  check('Edit preserves selected Goal metadata and timestamp', out.actions[0]?.input.requestedMode === 'goal' && out.actions[0]?.input.goalObjective === 'Keep the second queue objective' && out.actions[0]?.input.createdAt === '2026-09-06T00:00:03.000Z', out.actions[0]?.input);
  check('Edit modifies only second duplicate in actual backend', after.queueItems?.find(item => item.id === 'duplicate-first')?.text === 'same queued text' && after.queueItems?.find(item => item.id === 'duplicate-second')?.text === 'edited second duplicate', after.queueItems);
  check('Different modes on equal-text rows survive actual backend edit', after.queueItems?.find(item => item.id === 'duplicate-first')?.requestedMode === 'plan' && after.queueItems?.find(item => item.id === 'duplicate-second')?.requestedMode === 'goal', after.queueItems);

  await seed();
  button(2, 'guideQueueItem').click(); await settled();
  coherentQueue('Guide', await snapshot());
  check('Guide second duplicate sends its stable id', out.actions[0]?.input.id === 'duplicate-second', out.actions[0]);
  check('Actual backend Guide receipt refers to second duplicate', out.actions[0]?.result?.receipt?.clientMessageId === 'duplicate-second', out.actions[0]?.result);
  check('Guide preserves selected second Goal objective', out.actions[0]?.result?.receipt?.content?.includes('Keep the second queue objective'), out.actions[0]?.result?.receipt);

  await seed();
  const source = document.querySelector('#queue-list .queue-item[data-queue-index="2"]');
  const destination = document.querySelector('#queue-list .queue-item[data-queue-index="0"]');
  const transfer = new DataTransfer();
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
  const bounds = destination.getBoundingClientRect();
  destination.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: bounds.top + 1 }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  await settled(); after = await snapshot();
  const expectedOrder = ['duplicate-second', 'duplicate-first', 'different-middle'];
  check('Reorder submits unique stable ids in actual dragged order', JSON.stringify(out.actions[0]?.input.orderedIds) === JSON.stringify(expectedOrder), out.actions[0]);
  check('Actual backend persists duplicate row reorder', JSON.stringify((after.queueItems || []).map(item => item.id)) === JSON.stringify(expectedOrder), after.queueItems);
  check('Renderer did not throw during duplicate queue actions', out.errors.length === 0, out.errors);
  window.queueAction = realQueueAction;
  await api.stopConversation({ target, force: false });
  await activeRun;
  return out;
}

async function main() {
  fs.mkdirSync(evidence, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-queue-identity-'));
  const responses = new Set();
  const provider = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const input = JSON.parse(body || '{}');
      if (!input.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Queue identity verification' }, finish_reason: 'stop' }] }));
        return;
      }
      responses.add(response);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Fixture running' }, finish_reason: null }] }) + '\n\n');
      const timer = setInterval(() => response.write(': keepalive\n\n'), 200);
      response.on('close', () => { clearInterval(timer); responses.delete(response); });
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ models: { default: 'queue-identity-model', providers: [{ id: 'queue-identity-fixture', name: 'Queue identity fixture', base_url: `http://127.0.0.1:${provider.address().port}/v1`, api_key: 'fixture-only', protocol: 'openai', enabled: true, models: [{ name: 'queue-identity-model', enabled: true }] }] }, agent: { engine: 'builtin' }, general: { language: 'en', close_behavior: 'exit' }, workspace: { auto_create_timestamp_workspace: true }, mobile: { enabled: false } }));
  const log = fs.openSync(path.join(evidence, label + '-electron.log'), 'w');
  let entry = desktopRoot;
  if (uiSource) {
    if (packaged) throw Error('--ui-source is only for isolated source preview, never packaged acceptance');
    const fixtureHtml = path.join(runtime, 'index.html');
    let html = fs.readFileSync(path.resolve(uiSource), 'utf8');
    const base = pathToFileURL(path.join(desktopRoot, 'dist', 'ui') + path.sep).href;
    html = html.replace('<head>', '<head><base href="' + base + '">');
    if (!html.includes('id="lucide-sprite-root"')) {
      const sprite = fs.readFileSync(path.join(desktopRoot, 'dist', 'ui', 'lucide-sprite.svg'), 'utf8');
      html = html.replace(/href="lucide-sprite\.svg#/g, 'href="#').replace("var ICON_SPRITE_PATH = 'lucide-sprite.svg';", "var ICON_SPRITE_PATH = '';" );
      html = html.replace('<body>', '<body>\n' + sprite + '\n');
    }
    fs.writeFileSync(fixtureHtml, html);
    entry = path.join(runtime, 'renderer-preview.cjs');
    fs.writeFileSync(entry, `const request=require('node:module').createRequire(${JSON.stringify(path.join(desktopRoot, 'package.json'))});const e=request('electron');e.app.setAppPath(${JSON.stringify(desktopRoot)});const original=e.BrowserWindow.prototype.loadFile;e.BrowserWindow.prototype.loadFile=function(file,options){return original.call(this,require('node:path').basename(file)==='index.html'?${JSON.stringify(fixtureHtml)}:file,options)};process.argv[1]=${JSON.stringify(desktopRoot)};request('./dist/main.js');`);
  }
  const child = spawn(executable, [...(packaged ? [] : [entry]), '--no-devtools', '--allow-multiple-instances', '--no-sandbox', '--remote-debugging-port=' + port, '--root', runtime], { cwd: runtime, stdio: ['ignore', log, log], windowsHide: true });
  let cdp;
  const receipt = { label, executable, packaged, runtime, pid: child.pid, startedAt: new Date().toISOString(), uiSource: uiSource ? path.resolve(uiSource) : null,
    uiSourceSha256: uiSource ? crypto.createHash('sha256').update(fs.readFileSync(path.resolve(uiSource))).digest('hex') : null };
  try {
    cdp = connect(await targetAt()); await cdp.ready; await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    const evaluation = await cdp.call('Runtime.evaluate', { expression: '(' + rendererCases.toString() + ')()', awaitPromise: true, returnByValue: true }, 60000);
    if (evaluation.exceptionDetails) throw Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
    Object.assign(receipt, evaluation.result.value);
    const identity = await cdp.call('Runtime.evaluate', { expression: "fetch(location.href).then(r => r.text())", awaitPromise: true, returnByValue: true });
    receipt.uiSha256 = crypto.createHash('sha256').update(identity.result.value).digest('hex');
    receipt.passed = receipt.checks.every(item => item.pass);
    fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ label, uiSha256: receipt.uiSha256, conversationList: receipt.conversationList, streaming: receipt.streaming, checks: receipt.checks }));
    if (!receipt.passed && !baseline) throw Error('Queue identity regression: ' + receipt.checks.filter(item => !item.pass).map(item => item.name).join('; '));
  } finally {
    try { await cdp?.call('Runtime.evaluate', { expression: 'window.api.close()', awaitPromise: true }, 3000); } catch {}
    cdp?.socket.close();
    const deadline = Date.now() + 10000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(100);
    const forced = child.exitCode === null;
    if (forced) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    receipt.runtimeShutdown = { forced, exitCode: child.exitCode, signalCode: child.signalCode, finishedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify(receipt, null, 2));
    fs.closeSync(log);
    for (const response of responses) response.destroy();
    await new Promise(resolve => provider.close(resolve));
    if (forced) throw Error('Owned application did not exit within 10 seconds after its normal close action');
    // Keep the owned root recorded for investigation; never scan or remove user state.
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
