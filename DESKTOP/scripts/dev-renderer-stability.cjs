// Actual Electron renderer measurements; all fixture data stays in an owned runtime.
// --exe <unpacked exe> reuses the same checks against a packaged application.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
const port = Number(option('--port', '49783'));
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
  const out = { checks: [], errors: [] };
  const check = (name, pass, details) => out.checks.push({ name, pass: !!pass, details });
  const duration = samples => ({ samples: samples.length, meanMs: samples.reduce((a, b) => a + b, 0) / samples.length, maxMs: Math.max(...samples), p95Ms: samples.slice().sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] });
  window.addEventListener('error', event => out.errors.push(String(event.error?.stack || event.message)));
  const ws = currentWorkspaceKey(), target = currentConversationTarget(activeConversationId());
  const list = document.querySelector('#conversation-list'), chat = document.querySelector('#chat-area');
  const originalConversations = state.workspaceConversations[ws];
  const originalId = activeConversationId();
  state.workspaceConversations[ws] = Array.from({ length: 500 }, (_, index) => ({ id: index === 0 ? originalId : 'render-case-' + index, summary: 'Renderer case ' + index, active: index === 0, archived: false, pinned: false }));
  renderConversations();
  await sleep(200);
  const rows = Array.from(list.querySelectorAll('.conv-item'));
  const observer = new MutationObserver(() => {});
  observer.observe(list, { subtree: true, attributes: true, childList: true });
  const listTimes = []; let noOpMutations = 0;
  for (let n = 0; n < 30; n++) {
    const began = performance.now(); renderConversations(); listTimes.push(performance.now() - began);
    noOpMutations += observer.takeRecords().length;
    await sleep(0);
  }
  observer.disconnect();
  out.conversationList = { ...duration(listTimes), noOpMutations, rows: rows.length };
  check('500 conversation rows retain DOM identity', rows.every((row, i) => list.children[i] === row), rows.length);
  check('Unchanged sidebar refresh does not invalidate DOM', noOpMutations === 0, noOpMutations);
  state.workspaceConversations[ws] = originalConversations; renderConversations();

  const run = { runId: 'render-stability-work', target, status: 'running', expanded: true, startedAt: new Date().toISOString(), events: [
    { id: 'thought', type: 'thought', content: 'alpha', sequence: 1 },
    { id: 'later', type: 'status', content: 'stable later event', sequence: 2 }
  ] };
  const element = renderConversationWorkRun(run);
  const thought = element.querySelector('.conversation-work-thought');
  thought.open = true;
  run.events[0].content = 'bravo'; updateConversationWorkRunElement(run, element);
  check('Equal-length thought correction is visible', element.querySelector('.conversation-work-thought-text')?.textContent === 'bravo', element.querySelector('.conversation-work-thought-text')?.textContent);
  const finalRun = { runId: 'render-final-format', target, status: 'running', expanded: true, events: [{ id: 'long-response', type: 'response', content: '**Final bold** ' + 'plain words '.repeat(1200), sequence: 1 }] };
  const finalElement = renderConversationWorkRun(finalRun);
  finalRun.status = 'completed'; updateConversationWorkRunElement(finalRun, finalElement);
  check('Terminal narrative restores Markdown after large live text', !!finalElement.querySelector('strong'), finalElement.querySelectorAll('strong').length);

  const guideRun = { runId: 'render-collapsed-guide', target, status: 'running', expanded: false, events: [
    { id: 'guide-event', type: 'guide_accepted', sequence: 1, guide: { clientMessageId: 'fixture-guide', guideId: 'fixture-guide', content: 'Stable guide content', status: 'accepted' } },
    { id: 'image-event', type: 'tool_result', toolName: 'image_display', sequence: 2, displayImage: { id: 'fixture-image', origin: 'agent', mimeType: 'image/png', caption: 'Stable image', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } }
  ] };
  const guideElement = renderConversationWorkRun(guideRun), guideWrapper = guideElement.closest('.work-run-message');
  const guideBefore = guideWrapper.querySelector('.work-run-collapsed-guides .work-run-guide-message');
  const imageBefore = guideWrapper.querySelector('.work-run-collapsed-images img');
  for (let n = 0; n < 20; n++) updateConversationWorkRunElement(guideRun, guideElement);
  check('Unchanged collapsed Guide retains its node', !!guideBefore && guideBefore === guideWrapper.querySelector('.work-run-collapsed-guides .work-run-guide-message'), !!guideBefore);
  check('Unchanged collapsed image retains its decoded node', !!imageBefore && imageBefore === guideWrapper.querySelector('.work-run-collapsed-images img'), !!imageBefore);

  const streamRun = { runId: 'render-stream-load', target, status: 'running', expanded: true, startedAt: new Date().toISOString(), events: [] };
  for (let n = 0; n < 400; n++) streamRun.events.push({ id: 'history-' + n, type: n % 2 ? 'status' : 'thought', content: 'Recorded event ' + n, completed: true, sequence: n });
  const streamElement = renderConversationWorkRun(streamRun);
  const prefix = streamElement.querySelector('.conversation-work-run-events').firstChild;
  const streamTimes = []; let inputEvents = 0, maxInputDelayMs = 0, expected = performance.now() + 10;
  const timer = setInterval(() => { const now = performance.now(); maxInputDelayMs = Math.max(maxInputDelayMs, now - expected); expected = now + 10; inputEvents++; }, 10);
  for (let n = 0; n < 50; n++) {
    streamRun.events.push({ id: 'stream-' + n, type: 'text', content: ' piece ' + n, sequence: 400 + n });
    const began = performance.now(); updateConversationWorkRunElement(streamRun, streamElement); streamTimes.push(performance.now() - began);
    await sleep(20);
  }
  clearInterval(timer);
  out.streaming = { ...duration(streamTimes), inputEvents, maxInputDelayMs };
  check('Stream updates keep historical prefix DOM', prefix === streamElement.querySelector('.conversation-work-run-events').firstChild, true);
  check('Stream stress keeps event loop responsive', inputEvents >= 50 && maxInputDelayMs < 200, { inputEvents, maxInputDelayMs });
  check('Renderer did not raise exceptions', out.errors.length === 0, out.errors);
  out.dom = { total: document.getElementsByTagName('*').length, popups: document.querySelectorAll('.liquid-popup-optical-surface').length };
  window.__rendererPopupRefs = [];
  for (let n = 0; n < 30; n++) {
    const popup = document.createElement('div'); popup.className = 'liquid-glass-popup'; popup.style.cssText = 'position:fixed;width:160px;height:120px;left:20px;top:20px';
    document.body.appendChild(popup); await sleep(0);
    window.__rendererPopupRefs.push(new WeakRef(popup)); popup.remove();
  }
  await sleep(200);
  return out;
}
async function main() {
  fs.mkdirSync(evidence, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-render-stability-'));
  fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ models: { providers: [] }, general: { language: 'en', close_behavior: 'exit' }, workspace: { auto_create_timestamp_workspace: true }, mobile: { enabled: false } }));
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
    await cdp.call('HeapProfiler.collectGarbage'); await sleep(150);
    await cdp.call('HeapProfiler.collectGarbage');
    const retained = await cdp.call('Runtime.evaluate', { expression: 'window.__rendererPopupRefs.filter(ref => ref.deref()).length', returnByValue: true });
    receipt.popupRetainedAfterGc = retained.result.value;
    receipt.checks.push({ name: 'Removed popup carriers can be collected', pass: receipt.popupRetainedAfterGc === 0, details: receipt.popupRetainedAfterGc });
    const identity = await cdp.call('Runtime.evaluate', { expression: "fetch(location.href).then(r => r.text())", awaitPromise: true, returnByValue: true });
    receipt.uiSha256 = crypto.createHash('sha256').update(identity.result.value).digest('hex');
    receipt.passed = receipt.checks.every(item => item.pass);
    fs.writeFileSync(path.join(evidence, label + '.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ label, uiSha256: receipt.uiSha256, conversationList: receipt.conversationList, streaming: receipt.streaming, checks: receipt.checks }));
    if (!receipt.passed && !baseline) throw Error('Renderer behavior regression: ' + receipt.checks.filter(item => !item.pass).map(item => item.name).join('; '));
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
    if (forced) throw Error('Owned application did not exit within 10 seconds after its normal close action');
    // Keep the owned root recorded for investigation; never scan or remove user state.
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
