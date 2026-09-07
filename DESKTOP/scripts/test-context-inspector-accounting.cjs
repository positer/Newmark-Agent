// Exercise the actual renderer functions with controlled IPC completion.
// No provider request, user profile, Electron instance or production data is used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('typescript');
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const uiPath = path.resolve(arg('--ui', path.join(__dirname, '../src/ui/index.html')));
const html = fs.readFileSync(uiPath, 'utf8');
const sources = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m, i) => ts.createSourceFile('ui-' + i + '.js', m[1], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
function sourceOf(name, optional = false) {
  for (const source of sources) for (const node of source.statements) {
    if ((ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(source) === name)) return node.getText(source);
  }
  if (optional) return '';
  throw Error('Missing actual renderer function: ' + name);
}
function nestedStatement(needle) {
  let found;
  for (const source of sources) {
    const visit = node => {
      if (!found && ts.isIfStatement(node) && node.expression.getText(source) === needle) found = node.getText(source);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (!found) throw Error('Missing actual renderer statement: ' + needle);
  return found;
}
const translations = {};
for (const source of sources) {
  const visit = node => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteral(node.initializer)
      && node.name.text.startsWith('status.')) translations[node.name.text] = node.initializer.text;
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const A = { workspaceId: 'workspace-a', conversationId: 'same-id' };
const B = { workspaceId: 'workspace-b', conversationId: 'same-id' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(contextWindow = {}) {
  const panel = { innerHTML: '', style: {}, classList: { toggle() {} } };
  const ring = { top: 600, getBoundingClientRect() { return { top: this.top }; }, setAttribute() {}, style: {} };
  const topbar = { bottom: 38, getBoundingClientRect() { return { bottom: this.bottom }; } };
  const timers = new Map(); let timerId = 0;
  const state = { contextWindow, contextCompression: null, contextInspectorOpen: true, conversationLoadGeneration: 1,
    contextMutationPending: false, rightTab: 'status', mode: 'build', subagents: [], fileDiffs: [], pendingOptions: [], conversationDrafts: {} };
  const h = { active: { ...A }, state, panel, ring, topbar, notices: [], renderSnapshots: [], statusRenders: 0, console,
    els: { 'context-token-ring': ring }, api: {}, currentLang: () => 'zh', t: key => translations[key] || key,
    esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    currentConversationTarget: () => ({ ...h.active }), currentWorkspaceKey: () => h.active.workspaceId,
    isActiveConversationTarget: target => target.workspaceId === h.active.workspaceId && target.conversationId === h.active.conversationId,
    isCurrentConversationRunning: () => false, runtimeKeyFor: (w, c) => w + ':' + c,
    document: { getElementById: id => id === 'context-inspector' ? panel : id === 'topbar' ? topbar : ring },
    showUiNotice: (...args) => h.notices.push(args),
    flowTakeoverRecordFor: () => ({}), flowTargetMatchesCurrent: () => false,
    applyAutoRouteRatingState() {}, renderAutoRouteRatingControls() {}, applyConversationCommandSnapshot() {}, applyReturnedGoalState() {},
    hydrateConversationDraftSnapshot() {}, // Draft ownership is independently exercised by its production-function suite.
  };
  h.window = { setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    renderContextWindow() { h.renderSnapshots.push({ contextWindow: state.contextWindow, contextCompression: state.contextCompression }); h.window.renderContextInspector(); },
    renderRightStatusPanel() { h.statusRenders++; }, renderSubagentList() {} };
  vm.createContext(h);
  const globals = html.slice(html.indexOf('var _contextWindowRefreshTimer'), html.indexOf('function scheduleActiveContextWindowRefresh'));
  vm.runInContext(globals + '\n' + ['contextInspectorValue', 'contextInspectorReportedValue', 'contextInspectorCell', 'positionContextInspector',
    'window.renderContextInspector', 'window.compressContextNow', 'scheduleActiveContextWindowRefresh', 'window.refreshRightStatus'].map(name => sourceOf(name, true)).join('\n'), h);
  h.terminalRefresh = target => { h.target = target; h.activeFlag = true; vm.runInContext('(function() { var target = globalThis.target; var active = activeFlag; var terminalEvent = true; ' + nestedStatement('active && terminalEvent && api.getState') + ' })()', h); };
  h.switchTo = target => { h.active = { ...target }; state.conversationLoadGeneration++; };
  h.tick = async () => { const current = [...timers.values()]; timers.clear(); for (const fn of current) fn(); await flush(); };
  h.cells = () => { h.window.renderContextInspector(); return [...panel.innerHTML.matchAll(/context-inspector-label">([^<]*)<\/span><span class="context-inspector-value"[^>]*>([^<]*)/g)].map(m => ({ label: m[1], value: m[2] })); };
  h.cell = key => h.cells().find(c => c.label === h.t(key))?.value;
  return h;
}
const complete = {
  estimatedTokens: 1500, maxTokens: 4000, buildBlockTokens: 200, longHistoryTokens: 800,
  systemPromptTokens: 400, toolSchemaTokens: 100, contextEstimateSource: 'active_request',
  providerUsageRequests: 2, providerUsageInputReportedRequests: 2, providerUsageOutputReportedRequests: 2, providerUsageCacheReportedRequests: 2,
  providerUsageHasLegacyTotals: false, providerInputTokens: 1000, providerOutputTokens: 80, providerTotalTokens: 1080,
  providerCacheReadTokens: 200, providerCacheReadRatio: 0.2, providerKnownCacheReadRatio: 0.2, providerCacheEligibleInputTokens: 1000,
  providerLastInputTokens: 9876, requestContext: { inputTokens: 990, longHistoryTokens: 800, buildBlockTokens: 200, systemPromptTokens: 400, toolSchemaTokens: 100 },
};
const report = { uiPath, sourceSha256: crypto.createHash('sha256').update(html).digest('hex').toUpperCase(), cases: [] };
async function check(name, fn) {
  try { const evidence = await fn(); report.cases.push({ name, ok: true, evidence }); }
  catch (error) { report.cases.push({ name, ok: false, error: error.message }); }
}
async function main() {
  await check('missing usage is unknown rather than zero cache', () => {
    const h = harness(); assert.equal(h.cell('status.cacheHitRate'), '未上报'); assert.equal(h.cell('status.conversationTokens'), '未上报'); return h.cells();
  });
  await check('reported zero cache remains a real zero percent', () => {
    const h = harness({ ...complete, providerCacheReadTokens: 0, providerCacheReadRatio: 0, providerKnownCacheReadRatio: 0 });
    assert.equal(h.cell('status.cacheHitRate'), '0% · 0 cached'); return h.cells();
  });
  await check('conversation rate uses backend weighted totals', () => {
    const h = harness(complete); assert.equal(h.cell('status.cacheHitRate'), '20% · 200 cached'); assert.equal(h.cell('status.conversationTokens'), '1080 · 1000 in / 80 out'); return h.cells();
  });
  await check('partial reporting does not masquerade as a full conversation rate', () => {
    const h = harness({ ...complete, providerUsageRequests: 3, providerUsageCacheReportedRequests: 1, providerCacheReadRatio: null, providerKnownCacheReadRatio: 0.8, providerCacheEligibleInputTokens: 250 });
    assert.equal(h.cell('status.cacheHitRate'), '未上报 · 已上报部分 80%'); assert.match(h.panel.innerHTML, /250 token/); return h.cells();
  });
  await check('legacy totals retain counters but not invented reporting coverage', () => {
    const h = harness({ ...complete, providerUsageHasLegacyTotals: true, providerCacheReadRatio: 0.2, providerKnownCacheReadRatio: null });
    assert.equal(h.cell('status.cacheHitRate'), '未上报'); assert.match(h.cell('status.conversationTokens'), /^已上报部分 1080/); assert.match(h.panel.innerHTML, /历史上报覆盖范围未知/); return h.cells();
  });
  await check('output-only usage never invents a reported input zero', () => {
    const h = harness({ ...complete, providerUsageInputReportedRequests: 0, providerInputTokens: 0, providerTotalTokens: 80, providerCacheReadRatio: null });
    assert.equal(h.cell('status.conversationTokens'), '已上报部分 80 · 未上报 in / 80 out'); return h.cells();
  });
  await check('input-only usage never invents a reported output zero', () => {
    const h = harness({ ...complete, providerUsageOutputReportedRequests: 0, providerOutputTokens: 0, providerTotalTokens: 1000 });
    assert.equal(h.cell('status.conversationTokens'), '已上报部分 1000 · 1000 in / 未上报 out'); return h.cells();
  });
  await check('history and overhead stay estimates while main request input stays measured', () => {
    const h = harness(complete); assert.match(h.cell('status.activeBuild'), /^200 /); assert.match(h.cell('status.longHistory'), /^800 /);
    assert.equal(h.cell('status.requestOverhead'), '400 / 100'); assert.equal(h.cell('status.lastReportedInput'), '990');
    assert.match(h.t('status.activeBuild'), /估算/); assert.match(h.t('status.longHistory'), /估算/); assert.match(h.panel.innerHTML, /不代表服务端计费用量/); return h.cells();
  });
  await check('pending main input does not borrow an unrelated auxiliary usage', () => {
    const h = harness({ ...complete, requestContext: { estimatedTokens: 1000 }, providerLastInputTokens: 12345 });
    assert.equal(h.cell('status.lastReportedInput'), '未上报'); return h.cells();
  });
  await check('idle history does not claim zero system or tool cost and main input identifies its request', () => {
    const h = harness({ ...complete, contextEstimateSource: 'history', systemPromptTokens: 0, toolSchemaTokens: 0,
      requestContext: { inputTokens: 990, model: 'fixture-model', at: '2026-09-06T14:00:00Z' } });
    assert.equal(h.cell('status.requestOverhead'), '当前历史估算未计入'); assert.match(h.panel.innerHTML, /title="fixture-model · 2026-09-06T14:00:00Z"/); return h.cells();
  });
  await check('image token limitations are visible and real zero main input is retained', () => {
    const h = harness({ ...complete, contextEstimateHasImages: true, requestContext: { inputTokens: 0 } });
    assert.equal(h.cell('status.lastReportedInput'), '0'); assert.match(h.panel.innerHTML, /未计入图片 token/); return h.cells();
  });
  await check('a shorter viewport constrains only inspector height and retains scrollable actions', () => {
    const h = harness(complete); h.cells(); h.ring.top = 250; h.positionContextInspector();
    assert.equal(h.panel.style.maxHeight, '192px'); assert.equal(h.panel.style.overflowY, 'auto');
    assert.equal(h.panel.style.overscrollBehavior, 'contain'); assert.match(h.panel.innerHTML, /window.compressContextNow/);
    h.ring.top = 650; h.positionContextInspector(); assert.equal(h.panel.style.maxHeight, '592px');
    h.topbar.bottom = 0; h.positionContextInspector(); assert.equal(h.panel.style.maxHeight, '630px'); return h.panel.style;
  });
  await check('late compression cannot overwrite a different conversation', async () => {
    const h = harness({ estimatedTokens: 100 }), d = deferred(); h.api.compressContext = () => d.promise;
    const p = h.window.compressContextNow(); h.switchTo(B); h.state.contextWindow = { estimatedTokens: 900 };
    d.resolve({ ok: true, contextWindow: { estimatedTokens: 20 }, contextCompression: { originalMessages: 10 } }); await p; await flush();
    assert.equal(h.state.contextWindow.estimatedTokens, 900); assert.equal(h.notices.length, 0); assert.equal(h.state.contextMutationPending, false); return h.state.contextWindow;
  });
  await check('leave and return invalidates old compression and its error notice', async () => {
    const h = harness({ estimatedTokens: 100 }), d = deferred(); h.api.compressContext = () => d.promise;
    const p = h.window.compressContextNow(); h.switchTo(B); h.switchTo(A); h.state.contextWindow = { estimatedTokens: 900 };
    d.reject(Error('stale compression')); await p; await flush(); assert.equal(h.notices.length, 0); assert.equal(h.state.contextWindow.estimatedTokens, 900); return { notices: h.notices.length };
  });
  await check('current compression paints usage and compression metadata in the same frame', async () => {
    const h = harness(); h.api.compressContext = () => Promise.resolve({ ok: true, contextWindow: { estimatedTokens: 20 }, contextCompression: { originalMessages: 10, compressedMessages: 3 } });
    await h.window.compressContextNow(); await flush(); const paint = h.renderSnapshots.at(-1); assert.equal(paint.contextWindow.estimatedTokens, 20); assert.equal(paint.contextCompression.compressedMessages, 3); assert.equal(h.notices.length, 1); return paint;
  });
  await check('a concurrent read during compression is followed by a fresh post-mutation snapshot', async () => {
    const h = harness(), compression = deferred(), reads = []; h.api.compressContext = () => compression.promise;
    h.api.getState = () => { const d = deferred(); reads.push(d); return d.promise; };
    const mutation = h.window.compressContextNow(), status = h.window.refreshRightStatus();
    reads[0].resolve({ contextWindow: { estimatedTokens: 900 } }); await status;
    compression.resolve({ ok: true, contextWindow: { estimatedTokens: 100 } }); await mutation; await flush(); await h.tick();
    assert.equal(reads.length, 2); reads[1].resolve({ contextWindow: { estimatedTokens: 100 }, contextCompression: { compressedMessages: 3 } }); await flush();
    assert.equal(h.state.contextWindow.estimatedTokens, 100); assert.equal(h.state.contextCompression.compressedMessages, 3); return { reads: reads.length, final: h.state.contextWindow };
  });
  await check('later same-target context request prevents old status reply from regressing usage', async () => {
    const h = harness(), reads = []; h.api.getState = () => { const d = deferred(); reads.push(d); return d.promise; };
    const older = h.window.refreshRightStatus(), newer = h.window.refreshRightStatus();
    reads[1].resolve({ contextWindow: { estimatedTokens: 900 } }); await newer;
    reads[0].resolve({ contextWindow: { estimatedTokens: 100 } }); await older; await flush(); assert.equal(h.state.contextWindow.estimatedTokens, 900); return h.state.contextWindow;
  });
  await check('terminal refresh cannot return through A to B to A selection', async () => {
    const h = harness(), d = deferred(); h.api.getState = () => d.promise; h.terminalRefresh(A); h.switchTo(B); h.switchTo(A); h.state.contextWindow = { estimatedTokens: 900 };
    d.resolve({ contextWindow: { estimatedTokens: 100 } }); await flush(); assert.equal(h.state.contextWindow.estimatedTokens, 900); return h.state.contextWindow;
  });
  await check('semantic refresh coalesces twenty usage events without publishing a stale result', async () => {
    const h = harness(), pending = []; h.api.getState = () => { const d = deferred(); pending.push(d); return d.promise; };
    h.scheduleActiveContextWindowRefresh(A); await h.tick(); for (let i = 0; i < 20; i++) h.scheduleActiveContextWindowRefresh(A);
    pending[0].resolve({ contextWindow: { estimatedTokens: 100 } }); await flush(); assert.equal(h.renderSnapshots.length, 0); await h.tick();
    assert.equal(pending.length, 2); pending[1].resolve({ contextWindow: { estimatedTokens: 900 } }); await flush(); assert.equal(h.state.contextWindow.estimatedTokens, 900); return { requests: pending.length, final: h.state.contextWindow };
  });
  report.passed = report.cases.filter(c => c.ok).length; report.ok = report.passed === report.cases.length;
  const output = arg('--report', ''); if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  for (const c of report.cases) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.error ? ': ' + c.error : ''));
  console.log(`${report.passed}/${report.cases.length} actual context inspector cases passed`); process.exitCode = report.ok ? 0 : 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
