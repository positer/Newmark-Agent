// Real renderer functions, with controlled IPC completion and browser timers.
// The DOM seam only records rendering; no production function is reimplemented.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('typescript');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const uiPath = path.resolve(arg('--ui', path.join(__dirname, '../src/ui/index.html')));
const html = fs.readFileSync(uiPath, 'utf8');
const sources = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m, i) => ts.createSourceFile('ui-' + i + '.js', m[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
function sourceOf(name) {
  for (const source of sources) for (const node of source.statements) {
    if ((ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(source) === name)) return node.getText(source);
  }
  throw Error('Missing actual renderer function: ' + name);
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const json = value => JSON.parse(JSON.stringify(value));
const A = { workspaceId: 'workspace-a', conversationId: 'same-id' };
const B = { workspaceId: 'workspace-b', conversationId: 'same-id' };
const report = { uiPath, sourceSha256: crypto.createHash('sha256').update(html).digest('hex').toUpperCase(), cases: [], failures: [] };
function harness() {
  const timers = new Map(); let nextTimer = 0;
  const area = { buttons: [], innerHTML: 'readable transcript', scrollTop: 40,
    querySelectorAll() { return this.buttons.slice(); },
    insertBefore(button) { this.buttons.unshift(button); } };
  const state = { conversationLoadGeneration: 1, activeConversationBranchId: 'branch-1', viewedConversationBranchNodePath: ['branch-1'],
    conversationLoadedBefore: {}, renderedChatMessages: [{ content: 'A-latest' }], agentWorkEventsByConversation: {}, conversationMessagesByTarget: {}, rightTab: 'status', contextWindow: { estimatedTokens: 10 }, contextCompression: null };
  const ctx = { active: { ...A }, state, els: { 'chat-area': area }, api: {}, console,
    currentConversationTarget() { return { ...ctx.active }; }, activeConversationId() { return ctx.active.conversationId; },
    currentWorkspaceKey() { return ctx.active.workspaceId; }, runtimeWorkspaceId() { return ctx.active.workspaceId; },
    runtimeKeyFor(w, c) { return w + ':' + c; },
    isActiveConversationTarget(t) { return t.workspaceId === ctx.active.workspaceId && t.conversationId === ctx.active.conversationId; },
    currentLang() { return 'en'; }, shouldAutoScroll() { return false; }, esc(value) { return String(value); }, t(value) { return value; }, workspaceIdentity(value) { return value.id; },
    document: { createElement() { const b = { addEventListener(name, fn) { this[name] = fn; }, remove() { area.buttons = area.buttons.filter(v => v !== this); } }; return b; }, getElementById(id) { return (id === 'chat-area' || id === 'right-status-content') ? area : null; } },
    renders: [], contextRenders: [], statusRenders: 0,
    renderChatMessages(messages, target) { const actualTarget = target || ctx.currentConversationTarget(); state.renderedChatMessages = ctx.cacheConversationMessages(messages, actualTarget); ctx.renders.push({ target: json(actualTarget), messages: json(messages) }); area.buttons = []; },
    runningConversationRecord() { return null; }, workRunsForTarget() { return []; },
    flowTakeoverRecordFor() { return {}; }, flowTargetMatchesCurrent() { return false; },
  };
  const noops = ['hydrateConversationBranchState', 'rebindQueueToRuntimeBranch', 'applyAutoRouteRatingState', 'renderAutoRouteRatingControls', 'applyBackendConversations', 'markConversationTracked', 'syncQueueItemsFromSnapshot', 'replayActiveAgentWorkEvents', 'setWorking', 'applyConversationCommandSnapshot', 'applyReturnedGoalState'];
  for (const name of noops) ctx[name] = () => {};
  ctx.window = { setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    renderContextWindow() { ctx.contextRenders.push(json(state.contextWindow)); }, renderRightStatusPanel() { ctx.statusRenders++; }, renderSubagentList() {} };
  vm.createContext(ctx);
  const globals = html.slice(html.indexOf('var _contextWindowRefreshTimer'), html.indexOf('function scheduleActiveContextWindowRefresh'));
  vm.runInContext(globals + ['hydrateConversationDraftSnapshot', 'normalizeQueuedConversationTarget', 'conversationBranchIdentity', 'rememberViewedBranchNodeId', 'viewedBranchNodeIdFor', 'branchConversationViewKey', 'cacheConversationMessages', 'conversationMessageCache', 'conversationHasReadableHistory', 'snapshotHasReadableConversationHistory', 'renderLoadEarlierButton', 'scheduleActiveContextWindowRefresh', 'applyConversationModelSelection', 'applyConversationSnapshot', 'window.refreshRightStatus'].map(sourceOf).join('\n'), ctx);
  ctx.tick = async () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); await flush(); };
  ctx.timerCount = () => timers.size;
  ctx.switchTo = target => { ctx.active = { ...target }; state.conversationLoadGeneration++; state.renderedChatMessages = [{ content: target.workspaceId === A.workspaceId ? 'A-latest' : 'B-latest' }]; };
  state.conversationLoadedBefore[ctx.runtimeKeyFor(A.workspaceId, A.conversationId)] = 400;
  return ctx;
}
async function check(name, fn) { const evidence = {}; try { await fn(evidence); report.cases.push({ name, ok: true, evidence }); } catch (error) { report.cases.push({ name, ok: false, error: error.message, evidence }); report.failures.push(name); } }
async function main() {
  await check('late previous-workspace page cannot prepend into selected same-id conversation', async e => {
    const h = harness(), d = deferred(); h.api.loadEarlierConversationMessages = () => d.promise;
    h.renderLoadEarlierButton(); h.els['chat-area'].buttons[0].click(); h.switchTo(B);
    d.resolve({ chatMessages: [{ content: 'A-earlier' }], windowStart: 200 }); await flush();
    e.messages = json(h.state.renderedChatMessages); e.renders = h.renders;
    assert.deepEqual(e.messages, [{ content: 'B-latest' }]); assert.equal(h.renders.length, 0);
  });
  await check('leave and return invalidates an older page request', async e => {
    const h = harness(), d = deferred(); h.api.loadEarlierConversationMessages = () => d.promise;
    h.renderLoadEarlierButton(); h.els['chat-area'].buttons[0].click(); h.switchTo(B); h.switchTo(A);
    d.resolve({ chatMessages: [{ content: 'stale-A-earlier' }], windowStart: 200 }); await flush();
    e.messages = json(h.state.renderedChatMessages); assert.deepEqual(e.messages, [{ content: 'A-latest' }]);
  });
  await check('branch switch rejects the prior branch page', async e => {
    const h = harness(), d = deferred(); h.api.loadEarlierConversationMessages = () => d.promise;
    h.renderLoadEarlierButton(); h.els['chat-area'].buttons[0].click(); h.state.activeConversationBranchId = 'branch-2'; h.state.viewedConversationBranchNodePath = ['branch-2'];
    d.resolve({ chatMessages: [{ content: 'branch-1-earlier' }], windowStart: 200 }); await flush();
    e.messages = json(h.state.renderedChatMessages); assert.deepEqual(e.messages, [{ content: 'A-latest' }]);
  });
  await check('recreated affordance cannot merge the same page twice', async e => {
    const h = harness(), pending = []; h.api.loadEarlierConversationMessages = () => { const d = deferred(); pending.push(d); return d.promise; };
    h.renderLoadEarlierButton(); h.els['chat-area'].buttons[0].click(); h.renderLoadEarlierButton(); h.els['chat-area'].buttons[0].click();
    for (const d of pending) { d.resolve({ chatMessages: [{ content: 'A-earlier' }], windowStart: 200 }); await flush(); }
    e.messages = json(h.state.renderedChatMessages); assert.deepEqual(e.messages, [{ content: 'A-earlier' }, { content: 'A-latest' }]);
  });
  await check('same-target page preserves live additions and writes only its own cache', async e => {
    const h = harness(), d = deferred(); h.api.loadEarlierConversationMessages = () => d.promise;
    h.renderLoadEarlierButton(); h.els['chat-area'].buttons[0].click(); h.state.renderedChatMessages.push({ content: 'A-live-new' });
    d.resolve({ chatMessages: [{ content: 'A-earlier' }], windowStart: 200 }); await flush();
    e.messages = json(h.state.renderedChatMessages); e.cache = json(h.state.conversationMessagesByTarget); e.cursor = h.state.conversationLoadedBefore[h.runtimeKeyFor(A.workspaceId, A.conversationId)];
    assert.deepEqual(e.messages, [{ content: 'A-earlier' }, { content: 'A-latest' }, { content: 'A-live-new' }]); assert.equal(e.cursor, 200); assert.equal(Object.keys(e.cache).length, 1); assert.deepEqual(h.renders[0].target, A);
  });
  await check('failed page preserves current history and allows an explicit retry', async e => {
    const h = harness(), d = deferred(); h.api.loadEarlierConversationMessages = () => d.promise;
    h.renderLoadEarlierButton(); const button = h.els['chat-area'].buttons[0]; button.click(); d.reject(Error('fixture page failure')); await flush();
    e.messages = json(h.state.renderedChatMessages); e.disabled = button.disabled;
    assert.deepEqual(e.messages, [{ content: 'A-latest' }]); assert.equal(e.disabled, false); assert.equal(h.state.conversationLoadedBefore[h.runtimeKeyFor(A.workspaceId, A.conversationId)], 400);
  });
  await check('first snapshot renders its initial earlier-history cursor', async e => {
    const h = harness(); h.state.conversationLoadedBefore = {};
    h.applyConversationSnapshot({ ...A, chatMessages: [{ content: 'latest' }], totalMessages: 501 }, A.conversationId);
    e.buttons = h.els['chat-area'].buttons.map(b => b.textContent); e.cursor = h.state.conversationLoadedBefore[h.runtimeKeyFor(A.workspaceId, A.conversationId)];
    assert.equal(e.cursor, 500); assert.equal(e.buttons.length, 1); assert.match(e.buttons[0], /500/);
  });
  await check('conversation snapshot immediately hydrates its own context metrics', async e => {
    const h = harness(); h.switchTo(B);
    h.applyConversationSnapshot({ ...B, chatMessages: [], totalMessages: 0, contextWindow: { estimatedTokens: 900 }, contextCompression: { count: 3 } }, B.conversationId);
    e.context = json(h.state.contextWindow); e.compression = json(h.state.contextCompression); assert.equal(e.context.estimatedTokens, 900); assert.equal(e.compression.count, 3); assert.equal(h.contextRenders.length, 1);
  });
  await check('empty new-conversation context clears the previous conversation gauge', async e => {
    const h = harness(); h.switchTo(B); h.applyConversationSnapshot({ ...B, chatMessages: [], totalMessages: 0, contextWindow: null, contextCompression: null }, B.conversationId);
    e.context = h.state.contextWindow; assert.equal(e.context, null); assert.equal(h.contextRenders.length, 1);
  });
  await check('debounced refresh follows the most recently selected target', async e => {
    const h = harness(), calls = []; h.api.getState = target => { calls.push(json(target)); return Promise.resolve({ contextWindow: { estimatedTokens: 200 } }); };
    h.scheduleActiveContextWindowRefresh(A); h.switchTo(B); h.scheduleActiveContextWindowRefresh(B); await h.tick();
    e.calls = calls; assert.deepEqual(calls, [B]); assert.equal(h.state.contextWindow.estimatedTokens, 200);
  });
  await check('in-flight refresh retains the new target as a trailing request', async e => {
    const h = harness(), calls = [], pending = []; h.api.getState = target => { calls.push(json(target)); const d = deferred(); pending.push(d); return d.promise; };
    h.scheduleActiveContextWindowRefresh(A); await h.tick(); h.switchTo(B); h.scheduleActiveContextWindowRefresh(B); await h.tick();
    pending[0].resolve({ contextWindow: { estimatedTokens: 100 } }); await flush(); await h.tick();
    e.calls = calls; assert.deepEqual(calls, [A, B]); pending[1].resolve({ contextWindow: { estimatedTokens: 200 } }); await flush(); assert.equal(h.state.contextWindow.estimatedTokens, 200); assert.equal(h.contextRenders.length, 1);
  });
  await check('new usage during an in-flight request is coalesced without publishing old usage', async e => {
    const h = harness(), pending = []; h.api.getState = () => { const d = deferred(); pending.push(d); return d.promise; };
    h.scheduleActiveContextWindowRefresh(A); await h.tick(); for (let i = 0; i < 20; i++) h.scheduleActiveContextWindowRefresh(A); await h.tick();
    pending[0].resolve({ contextWindow: { estimatedTokens: 100 } }); await flush(); e.interimRenders = json(h.contextRenders); await h.tick();
    e.requests = pending.length; assert.equal(pending.length, 2); assert.equal(e.interimRenders.length, 0);
    pending[1].resolve({ contextWindow: { estimatedTokens: 300 } }); await flush(); assert.equal(h.state.contextWindow.estimatedTokens, 300); assert.equal(h.timerCount(), 0);
  });
  await check('failed refresh still releases a pending request and stops when quiet', async e => {
    const h = harness(), pending = []; h.api.getState = () => { const d = deferred(); pending.push(d); return d.promise; };
    h.scheduleActiveContextWindowRefresh(A); await h.tick(); h.scheduleActiveContextWindowRefresh(A); await h.tick(); pending[0].reject(Error('fixture IPC rejection')); await flush(); await h.tick();
    e.requests = pending.length; assert.equal(pending.length, 2); pending[1].resolve({ contextWindow: { estimatedTokens: 444 } }); await flush(); assert.equal(h.state.contextWindow.estimatedTokens, 444); assert.equal(h.timerCount(), 0);
  });
  await check('new history snapshot invalidates an older in-flight context reply', async e => {
    const h = harness(), d = deferred(); h.api.getState = () => d.promise;
    h.scheduleActiveContextWindowRefresh(A); await h.tick(); h.applyConversationSnapshot({ ...A, chatMessages: [], totalMessages: 0, contextWindow: { estimatedTokens: 900 } }, A.conversationId);
    d.resolve({ contextWindow: { estimatedTokens: 50 } }); await flush(); e.context = json(h.state.contextWindow); assert.equal(e.context.estimatedTokens, 900);
  });
  await check('late right-status response cannot replace selected workspace, mode or context', async e => {
    const h = harness(), d = deferred(); h.api.getState = () => d.promise; h.state.model = 'B-model';
    const p = h.window.refreshRightStatus(); h.switchTo(B);
    d.resolve({ ...A, model: 'A-model', contextWindow: { estimatedTokens: 999 }, workspaces: { current: { name: 'A', id: A.workspaceId } } }); await p; await flush();
    e.model = h.state.model; e.context = json(h.state.contextWindow); e.workspace = h.state.currentWorkspace;
    assert.equal(e.model, 'B-model'); assert.equal(e.context.estimatedTokens, 10); assert.equal(e.workspace, undefined);
  });
  await check('late failed right-status response cannot erase new target status', async e => {
    const h = harness(), d = deferred(); h.api.getState = () => d.promise; const p = h.window.refreshRightStatus(); h.switchTo(B);
    d.reject(Error('fixture rejected A')); await p; await flush(); e.visible = h.els['chat-area'].innerHTML; assert.equal(e.visible, 'readable transcript');
  });
  await check('current right-status still updates model and context normally', async e => {
    const h = harness(); h.api.getState = () => Promise.resolve({ ...A, model: 'A-model', contextWindow: { estimatedTokens: 999 } });
    await h.window.refreshRightStatus(); e.model = h.state.model; e.context = json(h.state.contextWindow); assert.equal(e.model, 'A-model'); assert.equal(e.context.estimatedTokens, 999); assert.equal(h.statusRenders, 1);
  });
  await check('required right-status failure stays observable to its caller', async e => {
    const h = harness(); h.api.getState = () => Promise.reject(Error('fixture required failure'));
    await assert.rejects(h.window.refreshRightStatus({ required: true }), /fixture required failure/); e.visible = h.els['chat-area'].innerHTML; assert.match(e.visible, /fixture required failure/);
  });
  report.ok = report.failures.length === 0; report.passed = report.cases.length - report.failures.length;
  const output = arg('--report', ''); if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  for (const c of report.cases) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.error ? ': ' + c.error : ''));
  console.log(`${report.passed}/${report.cases.length} actual renderer cases passed`); process.exitCode = report.ok ? 0 : 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
