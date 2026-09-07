const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sourcePath = path.resolve(option('--ui-source', path.join(__dirname, '../src/ui/index.html')));
const html = fs.readFileSync(sourcePath, 'utf8');
const source = html.match(/<script>([\s\S]*)<\/script>/)[1];
for (const [index, script] of Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)).entries()) {
  if (script[1].trim()) new vm.Script(script[1], { filename: sourcePath + '#script-' + index });
}
const ast = ts.createSourceFile('ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^window\.\w+$/.test(node.left.getText(ast))) functions.set(node.left.getText(ast).slice(7), node.getText(ast) + ';');
  ts.forEachChild(node, visit);
}
visit(ast);
let bridgeExpression;
function findBridge(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'api' && node.initializer) bridgeExpression = node.initializer.getText(ast);
  ts.forEachChild(node, findBridge);
}
findBridge(ast);
function bridgeHarness() {
  const calls = [], response = { ok: true, mode: 'goal', inputMode: 'next' };
  const context = vm.createContext({ window: {}, state: { mode: 'build', inputMode: 'guide', defaultFlow: 'fallback-flow' },
    currentConversationTarget: () => target, normalizeQueuedConversationTarget: value => value,
    URLSearchParams, fetch: async (url, options) => { calls.push({ url, options, body: options?.body && JSON.parse(options.body) }); return { json: async () => response }; }
  });
  return { api: vm.runInContext('(' + bridgeExpression + ')', context), calls, response };
}
const target = { workspaceId: 'workspace-a', conversationId: 'conversation-a' };
const other = { workspaceId: 'workspace-b', conversationId: 'conversation-b' };
const results = [];
function harness(names, extra = {}) {
  const calls = [];
  const buttons = ['next', 'guide'].map(mode => ({ getAttribute: () => mode, classList: { toggle: (_name, active) => { buttons.find(b => b.getAttribute() === mode).active = active; } } }));
  const state = { mode: 'build', inputMode: 'next', nextQueue: [], nextQueueRequests: [], queuePausedByTarget: {}, promptAttachments: [], activeSendCallsByTarget: {}, flowTakeovers: {}, ...extra.state };
  const els = { prompt: { value: 'frozen instruction', dispatchEvent() {}, focus() {}, select() {} }, 'mode-select': { value: 'build' }, 'mode-toggle': { querySelectorAll: () => buttons } };
  const snapshot = { ok: true, target, mode: 'build', inputMode: 'next', queuePaused: true, queued: { steering: [], followUp: [] }, queueItems: [] };
  const api = {
    sendMessage: async (message, owner, options) => { calls.push({ action: 'send', message, owner, options }); return snapshot; },
    queueAction: async (action, input, owner) => { calls.push({ action, input, owner }); return { ...snapshot, queuePaused: input.paused ?? true }; },
    setMode: async (mode, owner) => { calls.push({ action: 'mode', mode, owner }); return mode; },
    setInputMode: async (mode, owner) => { calls.push({ action: 'input-mode', mode, owner }); return mode; },
  };
  const window = { requireWorkspace: () => true, renderInputStack() {}, syncNewmarkSelect() {}, scheduleNextQueueDrain() { calls.push({ action: 'local-drain' }); }, sendMessage: async (...input) => { calls.push({ action: 'legacy-send', input }); }, stopFlowRun: async () => { calls.push({ action: 'legacy-stop-flow' }); }, crypto: { randomUUID: () => 'new-command-id' } };
  const context = vm.createContext({
    window, state, els, api, console, Promise, Date, Math, setTimeout, clearTimeout, queueMicrotask,
    Event: function() {}, document: { getElementById: () => null, querySelectorAll: () => [] },
    currentConversationTarget: () => target, activeConversationId: () => target.conversationId,
    runtimeKeyFor: (w, c) => w + '::' + c, normalizeQueuedConversationTarget: value => value,
    isActiveConversationTarget: owner => owner.workspaceId === target.workspaceId && owner.conversationId === target.conversationId,
    currentFlowRunning: () => true, currentFlowPaused: () => false, flowTakeoverMatchesCurrent: () => true,
    isCurrentConversationRunning: () => true, promptHasText: () => !!els.prompt.value,
    queueBranchPathForTarget: () => 'runtime-branch', refreshNextPromptForTarget() {}, pauseQueueForTarget() {},
    bindQueuedRequestToTarget: (request, _text, owner) => ({ ...request, target: owner }),
    queuedRequestMatchesTarget: (request, owner) => !!request && request.target.workspaceId === owner.workspaceId && request.target.conversationId === owner.conversationId,
    queuedRequestIsBackendManaged: request => !!request?.backendManaged,
    queueItemIdForText: (_text, _owner, request) => request.queueItemId,
    queueHiddenItemKey: (text, owner) => owner.workspaceId + '::' + owner.conversationId + '::' + text,
    normalizeQueueItemText: value => String(value || ''),
    publicWorkEventForUi: value => value, eventRuntimeKey() {}, runtimeWorkspaceId: () => target.workspaceId,
    composePromptTextForSend: text => text,
    composePromptRequestForSend: text => ({ text, images: state.promptAttachments.map(image => ({ ...image })) }),
    promptAttachmentsForConversation: () => [], normalizeConversationImageAttachments: items => items,
    runningConversationRecord: () => ({ runId: 'running-fixture' }), markConversationTracked() {},
    recordGuideUiMessage: value => value, renderPendingGuideMessages() {}, normalizeGuideUiStatus: value => value,
    updateSubmitButtonState() {}, nextGuideSequenceForRun: () => 1, guideMessagesForTarget: () => ({}),
    applyAgentWorkEventToRun() {}, recoverableGuideRejection: () => false, activateSubmittedGoal() {},
    bindWorkRunAnchorIndex() {}, setWorking() {}, consumeProvisionalStop: () => false,
    pendingConversationActivation: () => null, conversationWorkUiState: () => ({}),
    setConversationRuntimeState: (owner, status, runId, options) => { state.lastRuntime = { owner, status, runId, options }; },
    isViewingRuntimeConversationBranch: () => true,
    clearPromptAttachments() {}, clearActiveConversationDraft() {}, renderPromptAttachments() {},
    restoreModeAfterGoalEdit() {}, showUiNotice() {}, currentLang: () => 'en',
    setQueueItemsForTarget() {}, setBackendQueueForTarget: value => value, backendQueueForTarget: () => snapshot.queued,
    applyConversationCommandSnapshot() {}, flowTakeoverRecordFor: () => ({}),
    ...extra,
    state,
  });
  window.queueAction = (action, input, owner) => api.queueAction(action, input, owner || target);
  window.syncNextQueueFromBackend = () => {};
  // Imported send/status functions call the same production ownership and
  // context snapshot guards as the full renderer. Keep those guards real.
  vm.runInContext(source.slice(source.indexOf('var _contextWindowRefreshTimer'), source.indexOf('function captureContextWindowSnapshotRequest')), context);
  for (const name of new Set(['queueRequestIndex', 'queueIndexFromElement', 'refreshQueueRowIndexes', 'conversationRunStillOwnsTarget',
    'captureContextWindowSnapshotRequest', 'isCurrentContextWindowSnapshotRequest', 'applyContextWindowSnapshot', 'hydrateConversationDraftSnapshot'].filter(name => functions.has(name)).concat(names))) {
    assert.ok(functions.has(name), 'production function exists: ' + name);
    vm.runInContext(functions.get(name), context);
  }
  return { context, state, els, calls, api, window, buttons, snapshot };
}
async function test(name, body) {
  try { await body(); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: String(error.stack || error) }); }
}
function crossTargetQueueHarness() {
  const rows = [];
  const classes = { toggle() {}, add() {}, remove() {} };
  const panel = { style: {}, classList: classes, querySelector: () => null };
  const list = { set innerHTML(html) {
    rows.splice(0);
    for (const match of html.matchAll(/<div class="queue-item"([^>]*)>([\s\S]*?)<\/div>/g)) {
      const attrs = Object.fromEntries(Array.from(match[1].matchAll(/([\w-]+)="([^"]*)"/g), item => [item[1], item[2]]));
      const row = { attrs, style: {}, classList: classes, getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; }, closest: () => row, getBoundingClientRect: () => ({ top: 0, height: 28 }), buttons: [] };
      for (const button of match[2].matchAll(/<button\b[^>]*onclick="([^"]*)"/g)) row.buttons.push({ handler: button[1], closest: () => row });
      rows.push(row);
    }
  } };
  const document = { getElementById: id => ({ 'queue-panel': panel, 'queue-list': list, 'queue-header-label': {} })[id] || null, querySelectorAll: () => rows };
  const names = ['queueItemsForTarget', 'setQueueItemsForTarget', 'queueItemIdForText', 'bindBackendQueuedRequestToTarget', 'normalizeBackendQueue', 'setBackendQueueForTarget', 'backendQueueForTarget', 'syncNextQueueFromBackend', 'queueIndexesForTarget', 'renderQueuePanel', 'focusQueueItem', 'deleteQueueItem', 'guideQueueItem', 'restoreQueueItemAfterGuideFailure', 'startQueueDrag', 'queueDropTargetIndex', 'previewQueueDrag', 'overQueueDrag', 'dropQueueDrag', 'endQueueDrag'];
  for (const name of ['queueRequestIndex', 'queueIndexFromElement', 'refreshQueueRowIndexes']) if (functions.has(name)) names.push(name);
  const h = harness(names, { document, isQueuePausedForTarget: () => true, t: value => value, esc: value => String(value), escAttr: value => String(value), iconSvg: () => '', state: { queueCollapsed: false, _editingQueueIndex: -1, queueDragIndex: -1 } });
  const seed = (owner, ids) => {
    const items = ids.map((id, index) => ({ id, text: 'duplicate text', requestedMode: index ? 'goal' : 'plan', goalObjective: index ? 'preserved objective' : '', createdAt: `2026-09-06T00:00:0${index}.000Z` }));
    h.context.setQueueItemsForTarget(items, owner);
    const queue = { followUp: items.map(item => item.text), steering: [] };
    h.context.setBackendQueueForTarget(queue, owner);
    h.window.syncNextQueueFromBackend(queue, owner);
  };
  seed(target, ['shared-first', 'shared-second']);
  seed(other, ['shared-first', 'shared-second']);
  h.window.renderQueuePanel();
  const invoke = (element, expression, event) => {
    h.context.__queueElement = element; h.context.__queueEvent = event;
    return vm.runInContext('(function(event){' + expression + '}).call(__queueElement,__queueEvent)', h.context);
  };
  return { ...h, rows, seed, invoke };
}
function flowStartHarness() {
  const h = harness(['flowTakeoverRecordFor', 'normalizeFlowWork', 'applyConversationCommandSnapshot', 'refreshRightStatus', 'stopFlowRunInternal', 'stopFlowRun', 'runFlowWork'], {
    state: { flowWorks: [{ name: 'Fixture Flow', components: [{ type: 'dialog', prompt: 'Frozen component', mode: 'build' }] }] },
    renderConversations() {}, addMsg() {}, t: value => value, settleFlowQueueTakeover() {}, flowRelayedErrorWasShown: () => false, formatChatError: value => value,
    applyAutoRouteRatingState() {}, renderAutoRouteRatingControls() {}, flowTargetMatchesCurrent: () => true, renderPendingOptionsInChat() {},
  });
  h.window.closeSubWin = () => {};
  h.window.renderFlowTakeover = (active, name, options) => { const record = h.context.flowTakeoverRecordFor(options.target); record.running = active; record.name = name; };
  h.context.renderFlowTakeover = h.window.renderFlowTakeover;
  h.window.renderSubagentList = () => {};
  h.window.renderRightStatusPanel = () => {};
  const saves = [];
  h.api.saveFlow = async () => await new Promise(resolve => saves.push(resolve));
  h.api.stopFlow = async () => ({ action: 'not_running' });
  return { ...h, saves };
}
async function run() {
  for (const channel of ['snapshot', 'right-status']) await test(`An idle ${channel} during Flow save does not cancel the frozen start command`, async () => {
    const h = flowStartHarness();
    const running = h.window.runFlowWork(0, { text: 'Frozen Flow input', target, inputMode: 'next' });
    assert.equal(h.saves.length, 1);
    const idle = { target, flowRunning: null, flowSuspension: null };
    if (channel === 'snapshot') h.context.applyConversationCommandSnapshot(idle, target);
    else {
      h.api.getState = async () => idle;
      await h.window.refreshRightStatus({ required: true });
    }
    h.saves[0]({ ok: true });
    await running;
    assert.equal(h.calls.filter(call => call.action === 'send').length, 1);
    assert.equal(h.calls[0].message, 'Frozen Flow input');
    assert.equal(h.calls[0].options.flowName, 'Fixture Flow');
  });
  await test('A pending Flow command keeps an interrupted backend takeover resumable', async () => {
    const h = flowStartHarness();
    h.api.sendMessage = async () => ({ ok: false, pending: true, interrupted: true, flowSuspension: { reason: 'interrupted', workflowName: 'Fixture Flow', input: 'Keep suspended' }, queuePaused: true });
    const running = h.window.runFlowWork(0, { text: 'Keep suspended', target });
    h.saves[0]({ ok: true });
    await running;
    const record = h.context.flowTakeoverRecordFor(target);
    assert.equal(record.running, true);
    assert.equal(record.paused, true);
    assert.equal(record.pendingStart, null);
    assert.equal(h.state.queuePausedByTarget['workspace-a::conversation-a'], true);
    assert.equal(h.calls.some(call => call.action === 'local-drain'), false);
  });
  await test('An explicit stop while Flow save waits prevents any later submission', async () => {
    const h = flowStartHarness();
    const running = h.window.runFlowWork(0, { text: 'Cancelled input', target });
    await h.window.stopFlowRun();
    h.saves[0]({ ok: true });
    await running;
    assert.equal(h.calls.filter(call => call.action === 'send').length, 0);
  });
  await test('A superseded Flow save cannot send or tear down a newer pending start', async () => {
    const h = flowStartHarness();
    const first = h.window.runFlowWork(0, { text: 'Superseded input', target });
    const second = h.window.runFlowWork(0, { text: 'Current input', target });
    h.saves[0]({ ok: true });
    await first;
    assert.equal(h.calls.filter(call => call.action === 'send').length, 0);
    assert.equal(h.context.flowTakeoverRecordFor(target).running, true);
    h.saves[1]({ ok: true });
    await second;
    assert.equal(h.calls.filter(call => call.action === 'send').length, 1);
    assert.equal(h.calls[0].message, 'Current input');
  });
  for (const background of [false, true]) await test(`Workspace conversation-list events reveal remote creation without changing ${background ? 'another workspace or its selection' : 'the foreground selection'}`, async () => {
    const wsA = target.workspaceId, wsB = other.workspaceId;
    const aRows = [{ id: 'a-first', summary: 'A', active: true }];
    const bRows = [{ id: 'b-first', summary: 'B1' }, { id: 'b-selected', summary: 'B2', active: true }];
    let renders = 0;
    const names = ['applyBackendConversations', 'appendAgentWorkEvent'];
    if (functions.has('applyWorkspaceConversationList')) names.push('applyWorkspaceConversationList');
    const h = harness(names, { state: { currentWorkspace: 'workspace-a-path', currentWorkspaceId: wsA, activeConversation: 0, activeBackendConversationId: 'a-first', conversations: aRows, workspaceConversations: { [wsA]: aRows, [wsB]: bRows }, workspaceActiveConversation: { [wsA]: 0, [wsB]: 1 } }, currentWorkspaceKey: value => value || wsA, activeConversationId: () => 'a-first', t: value => value, scheduleConversationsRender: () => { renders += 1; }, isActiveConversationTarget: () => false, isConversationTracked: () => false, flowRunningForTarget: () => false });
    const owner = background ? wsB : wsA;
    const old = background ? bRows : aRows;
    h.context.appendAgentWorkEvent({ type: 'conversation_list', stateScope: 'workspace', workspaceId: owner, conversationId: 'remote-new', conversations: old.map(row => ({ id: row.id, title: row.summary })).concat({ id: 'remote-new', title: 'Remote created' }) });
    assert.equal(h.state.workspaceConversations[owner].at(-1).id, 'remote-new');
    assert.equal(h.state.workspaceConversations[owner].find(row => row.active).id, background ? 'b-selected' : 'a-first');
    assert.equal(h.state.activeBackendConversationId, 'a-first');
    assert.equal(h.state.currentWorkspaceId, wsA);
    assert.equal(h.state.conversations.find(row => row.active).id, 'a-first');
    assert.equal(renders, background ? 0 : 1);
    assert.equal(h.calls.length, 0);
  });
  await test('An unscoped conversation-list event cannot overwrite the foreground workspace', async () => {
    const rows = [{ id: 'a-first', active: true }];
    const names = ['appendAgentWorkEvent'];
    if (functions.has('applyWorkspaceConversationList')) names.push('applyWorkspaceConversationList');
    const h = harness(names, { state: { conversations: rows, workspaceConversations: { [target.workspaceId]: rows } }, isActiveConversationTarget: () => false, isConversationTracked: () => false, flowRunningForTarget: () => false, scheduleConversationsRender() {} });
    h.context.appendAgentWorkEvent({ type: 'conversation_list', conversations: [{ id: 'injected' }] });
    assert.equal(h.state.conversations[0].id, 'a-first');
    assert.equal(h.calls.length, 0);
  });
  for (const operation of ['deleteQueueItem', 'focusQueueItem', 'guideQueueItem']) await test(`Background target replacement cannot redirect the active duplicate ${operation} button`, async () => {
    const h = crossTargetQueueHarness();
    const row = h.rows[1], button = row.buttons.find(item => item.handler.includes(operation));
    assert.ok(button, 'actual rendered button exists');
    h.seed(other, ['shared-second']);
    await h.invoke(button, button.handler);
    if (operation === 'focusQueueItem') {
      assert.equal(h.state.pendingInputEdit?.request.queueItemId, 'shared-second');
      assert.equal(h.state.pendingInputEdit?.target.conversationId, target.conversationId);
      assert.equal(h.state.pendingInputEdit?.request.goalObjective, 'preserved objective');
    } else {
      assert.equal(h.calls[0]?.input.id, 'shared-second');
      assert.equal(h.calls[0]?.owner.conversationId, target.conversationId);
    }
  });
  await test('Background queue refresh rebases visible row indices without replacing nodes', async () => {
    const h = crossTargetQueueHarness(), originalRows = h.rows.slice();
    h.seed(other, ['shared-second']);
    assert.deepEqual(h.rows, originalRows);
    assert.deepEqual(h.rows.map(row => Number(row.getAttribute('data-queue-index'))), [0, 1]);
    for (const row of h.rows) assert.equal(h.state.nextQueueRequests[Number(row.getAttribute('data-queue-index'))].target.conversationId, target.conversationId);
  });
  await test('Background target refresh preserves the held drag source and selected destination identities', async () => {
    const h = crossTargetQueueHarness(), source = h.rows[1], destination = h.rows[0];
    const event = currentTarget => ({ currentTarget, clientY: 1, preventDefault() {}, dataTransfer: {} });
    h.invoke(source, source.attrs.ondragstart, event(source));
    h.seed(other, ['shared-second']);
    await h.invoke(destination, destination.attrs.ondrop, event(destination));
    assert.deepEqual(Array.from(h.calls[0]?.input.orderedIds || []), ['shared-second', 'shared-first']);
    assert.equal(h.calls[0]?.owner.conversationId, target.conversationId);
  });
  await test('A detached row cannot act on an equal-id item in a different target', async () => {
    const h = crossTargetQueueHarness(), row = h.rows[1], button = row.buttons.find(item => item.handler.includes('deleteQueueItem'));
    h.seed(target, []);
    await h.invoke(button, button.handler);
    assert.equal(h.calls.length, 0);
  });
  await test('Background refresh keeps the edited row hidden by its stable identity', async () => {
    const h = crossTargetQueueHarness(), row = h.rows[1], button = row.buttons.find(item => item.handler.includes('focusQueueItem'));
    h.invoke(button, button.handler);
    h.seed(other, ['shared-second']);
    assert.equal(h.state._editingQueueIndex, h.state.nextQueueRequests.findIndex(item => item.target.conversationId === target.conversationId && item.queueItemId === 'shared-second'));
    assert.equal(h.state.pendingInputEdit.request.queueItemId, 'shared-second');
  });
  await test('Flow Next uses frozen target canonical send and no local executable row', async () => {
    const h = harness(['queueFlowNextInput']);
    await h.window.queueFlowNextInput('next after flow');
    assert.equal(h.calls[0]?.action, 'send');
    assert.equal(h.calls[0].options.requestedMode, 'build');
    assert.equal(h.calls[0].options.inputMode, 'next');
    assert.deepEqual(h.calls[0].owner, target);
    assert.equal(h.state.nextQueue.length, 0);
  });
  await test('Queue pause changes shared owner without renderer Flow stop or drain', async () => {
    const h = harness(['queueRuntimeKey', 'toggleQueuePause'], { state: { queuePausedByTarget: { 'workspace-a::conversation-a': true } } });
    await h.window.toggleQueuePause();
    assert.equal(h.calls[0]?.action, 'queue_set_pause');
    assert.equal(h.calls[0].input.paused, false);
    assert.equal(h.calls.some(call => ['local-drain', 'legacy-stop-flow'].includes(call.action)), false);
  });
  await test('Goal edit Next enters shared queue with original objective and images', async () => {
    const h = harness(['sendMessage'], { state: { pendingInputEdit: { kind: 'goal', previousMode: 'build' }, promptAttachments: [{ dataUrl: 'data:image/png;base64,AA==', name: 'goal.png', type: 'image/png' }] } });
    await h.window.sendMessage();
    const call = h.calls.find(call => call.action === 'queue_enqueue');
    assert.ok(call);
    assert.equal(call.input.requestedMode, 'goal');
    assert.equal(call.input.goalObjective, 'frozen instruction');
    assert.equal(call.input.images[0].name, 'goal.png');
    assert.equal(h.state.nextQueue.length, 0);
  });
  await test('Edited duplicate Guide atomically updates and consumes its captured id', async () => {
    const request = { target, backendManaged: true, queueItemId: 'second-duplicate', requestedMode: 'goal', goalObjective: 'original objective', createdAt: '2026-09-06T00:00:00Z' };
    const h = harness(['sendMessage'], { state: { inputMode: 'guide', nextQueue: ['same', 'same'], nextQueueRequests: [{ ...request, queueItemId: 'first-duplicate' }, request], pendingInputEdit: { kind: 'queue', index: 1, request, target, originalText: 'same' } } });
    const actualSend = h.window.sendMessage;
    h.window.sendMessage = async (...input) => { h.calls.push({ action: 'legacy-send', input }); };
    await actualSend();
    const call = h.calls.find(call => call.action === 'queue_guide');
    assert.ok(call);
    assert.equal(call.input.id, 'second-duplicate');
    assert.equal(call.input.text, 'frozen instruction');
    assert.equal(call.input.goalObjective, 'original objective');
    assert.equal(h.calls.some(call => call.action === 'legacy-send'), false);
  });
  await test('Paused Flow new instruction retains text before composer clearing', async () => {
    const h = harness(['submitCurrentAction'], { currentFlowPaused: () => true, state: { mode: 'flow' } });
    h.window.exitPausedFlowForNewInstruction = () => {};
    h.window.submitSelectedFlow = options => { h.calls.push({ action: 'new-flow', options }); };
    await h.window.submitCurrentAction('enter');
    assert.equal(h.calls[0]?.options?.text, 'frozen instruction');
    assert.deepEqual(h.calls[0].options.target, target);
  });
  await test('Snapshot applies mode/input/queue pause to visible controls without writes', async () => {
    const h = harness(['setInputMode', 'applyConversationCommandSnapshot']);
    h.context.applyConversationCommandSnapshot({ mode: 'plan', inputMode: 'guide', queuePaused: true, target }, target);
    assert.equal(h.state.mode, 'plan');
    assert.equal(h.els['mode-select'].value, 'plan');
    assert.equal(h.state.inputMode, 'guide');
    assert.equal(h.buttons[1].active, true);
    assert.equal(h.state.queuePausedByTarget['workspace-a::conversation-a'], true);
    assert.equal(h.calls.length, 0);
    h.context.applyConversationCommandSnapshot({ mode: 'chat', inputMode: 'next', queuePaused: false, target: other }, other);
    assert.equal(h.state.mode, 'plan');
    assert.equal(h.state.inputMode, 'guide');
    assert.equal(h.state.queuePausedByTarget['workspace-b::conversation-b'], false);
  });
  await test('Legacy local drain cannot execute or remove a private queue row', async () => {
    const request = { target, text: 'must not be privately sent' };
    const h = harness(['drainNextQueue'], { isCurrentConversationRunning: () => false, queueIndexesForRuntimeTarget: () => [0], state: { nextQueue: [request.text], nextQueueRequests: [request], queuePausedByTarget: {} } });
    await h.window.drainNextQueue();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.nextQueue.length, 1);
  });
  await test('Remote queue events refresh ids, attachments and pause while no local send exists', async () => {
    const h = harness(['queueItemsForTarget', 'setQueueItemsForTarget', 'queueItemIdForText', 'bindBackendQueuedRequestToTarget', 'normalizeBackendQueue', 'setBackendQueueForTarget', 'backendQueueForTarget', 'syncNextQueueFromBackend', 'setInputMode', 'applyConversationCommandSnapshot', 'appendAgentWorkEvent']);
    const image = { dataUrl: 'data:image/png;base64,AA==', name: 'remote.png', type: 'image/png' };
    const event = { type: 'queue_update', ...target, queue: { followUp: ['duplicate', 'duplicate'], steering: [] }, queueItems: [
      { id: 'remote-plan', text: 'duplicate', requestedMode: 'plan', images: [] },
      { id: 'remote-goal', text: 'duplicate', requestedMode: 'goal', goalObjective: 'preserve me', images: [image] }
    ], queuePaused: true, inputMode: 'guide' };
    h.context.appendAgentWorkEvent(event);
    assert.deepEqual(Array.from(h.state.nextQueueRequests, row => row.queueItemId), ['remote-plan', 'remote-goal']);
    assert.equal(h.state.nextQueueRequests[1].images[0].name, image.name);
    assert.equal(h.state.nextQueueRequests[1].requestedMode, 'goal');
    assert.equal(h.state.nextQueueRequests[1].goalObjective, 'preserve me');
    assert.equal(h.state.queuePausedByTarget['workspace-a::conversation-a'], true);
    h.context.appendAgentWorkEvent({ ...event, ...other, queueItems: [{ id: 'other', text: 'other', requestedMode: 'chat' }], queue: { followUp: ['other'] }, inputMode: 'next' });
    assert.equal(h.state.inputMode, 'guide');
    assert.equal(h.state.nextQueueRequests.length, 3);
    assert.equal(h.state.nextQueueRequests[2].queueItemId, 'other');
    h.context.appendAgentWorkEvent({ ...event, queue: { followUp: [] }, queueItems: [], queuePaused: false });
    assert.equal(h.state.nextQueueRequests.length, 1);
    assert.equal(h.state.nextQueueRequests[0].queueItemId, 'other');
    assert.equal(h.calls.length, 0);
  });
  await test('Legacy Guide has no private executable fallback', async () => {
    const request = { target, text: 'stale local', backendManaged: false };
    const h = harness(['guideQueueItem'], { state: { nextQueue: [request.text], nextQueueRequests: [request] } });
    await h.window.guideQueueItem(0);
    assert.equal(h.calls.length, 0);
  });
  await test('Queue action freezes owner through response and preserves inactive selectors', async () => {
    const h = harness(['setInputMode', 'applyConversationCommandSnapshot', 'queueAction']);
    let resolve;
    h.api.queueAction = async (action, input, owner) => { h.calls.push({ action, input, owner }); return await new Promise(done => { resolve = done; }); };
    const work = h.window.queueAction('queue_update', { id: 'other-entry', text: 'changed' }, other);
    resolve({ ok: true, target: other, queuePaused: false, mode: 'chat', inputMode: 'guide' });
    await work;
    assert.deepEqual(h.calls[0].owner, other);
    assert.equal(h.state.mode, 'build');
    assert.equal(h.state.inputMode, 'next');
    assert.equal(h.state.queuePausedByTarget['workspace-b::conversation-b'], false);
  });
  for (const mode of ['build', 'chat', 'plan', 'goal']) await test(`Paused Flow hands frozen ${mode} command to canonical normal send`, async () => {
    const h = harness(['submitCurrentAction'], { currentFlowPaused: () => true, state: { mode, inputMode: 'next' } });
    h.window.exitPausedFlowForNewInstruction = () => {};
    await h.window.submitCurrentAction('enter');
    assert.equal(h.calls[0].input[0], 'next');
    assert.equal(h.calls[0].input[1], 'frozen instruction');
    assert.equal(h.calls[0].input[2].requestedMode, mode);
    assert.deepEqual(h.calls[0].input[2].target, target);
  });
  for (const mode of ['build', 'chat', 'plan', 'goal']) {
    await test(`Active ${mode} Next submits one canonical message with frozen mode and attachments`, async () => {
      const image = { name: 'own-image.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' };
      const h = harness(['sendMessage'], { state: { mode, inputMode: 'next', promptAttachments: [image] } });
      await h.window.sendMessage();
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].action, 'send');
      assert.equal(h.calls[0].options.requestedMode, mode);
      assert.equal(h.calls[0].options.inputMode, 'next');
      assert.equal(h.calls[0].message.images[0].name, image.name);
      assert.equal(h.calls[0].options.goalObjective, mode === 'goal' ? 'frozen instruction' : '');
      assert.deepEqual(h.calls[0].owner, target);
      assert.equal(h.state.nextQueue.length, 0);
    });
    await test(`Active ${mode} Guide submits through canonical owner and renders its receipt`, async () => {
      const h = harness(['sendMessage'], { state: { mode, inputMode: 'guide' } });
      h.api.sendMessage = async (message, owner, options) => {
        h.calls.push({ action: 'send', message, owner, options });
        return { ...h.snapshot, receipt: { status: 'accepted', clientMessageId: options.clientMessageId, runId: 'running-fixture', target: owner } };
      };
      const result = await h.window.sendMessage();
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].options.requestedMode, mode);
      assert.equal(h.calls[0].options.inputMode, 'guide');
      assert.equal(h.calls[0].message.runId, 'running-fixture');
      assert.equal(result.ok, true);
      assert.equal(result.guideReceipt.status, 'accepted');
    });
  }
  for (const mode of ['build', 'chat', 'plan', 'goal']) for (const inputMode of ['next', 'guide']) await test(`Idle ${mode}/${inputMode} forwards frozen command without pre-setting execution mode`, async () => {
    const h = harness(['sendMessage'], { isCurrentConversationRunning: () => false, runningConversationRecord: () => undefined, isActiveConversationTarget: () => false, state: { mode, inputMode } });
    h.window.drainNextQueue = () => {};
    await h.window.sendMessage();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].action, 'send');
    assert.equal(h.calls[0].options.requestedMode, mode);
    assert.equal(h.calls[0].options.inputMode, inputMode);
    assert.equal(h.calls[0].options.goalObjective, mode === 'goal' ? 'frozen instruction' : '');
    assert.deepEqual(h.calls[0].owner, target);
  });
  for (const failure of ['rejected', 'transport', 'empty']) await test(`Shared Guide ${failure} retains stable row identity, image and unrelated draft`, async () => {
    const image = { name: 'queued.png', dataUrl: 'data:image/png;base64,AA==', type: 'image/png' };
    const request = { target, text: 'queued', queueItemId: 'stable-id', backendManaged: true, images: [image] };
    const h = harness(['restoreQueueItemAfterGuideFailure', 'guideQueueItem'], { state: { nextQueue: ['queued'], nextQueueRequests: [request], promptAttachments: [{ ...image, name: 'unrelated-draft.png' }] } });
    h.api.queueAction = async () => { if (failure === 'transport') throw Error('controlled transport error'); return failure === 'empty' ? undefined : { ok: false, error: 'controlled rejection' }; };
    const result = await h.window.guideQueueItem(0);
    assert.equal(result.ok, false);
    assert.equal(h.state.nextQueue.length, 1);
    assert.equal(h.state.nextQueueRequests[0].queueItemId, 'stable-id');
    assert.equal(h.state.nextQueueRequests[0].images[0].name, 'queued.png');
    assert.equal(h.state.promptAttachments[0].name, 'unrelated-draft.png');
    assert.equal(h.els.prompt.value, 'frozen instruction');
  });
  await test('Stale idle renderer preserves live runtime from canonical acknowledgement', async () => {
    const h = harness(['sendMessage'], { isCurrentConversationRunning: () => false, runningConversationRecord: () => undefined, isActiveConversationTarget: () => false, state: { inputMode: 'guide' } });
    h.window.drainNextQueue = () => {};
    h.api.sendMessage = async () => ({ ok: true, receipt: { status: 'accepted' }, runtime: { running: true, runId: 'actual-shared-run' } });
    await h.window.sendMessage();
    assert.equal(h.state.lastRuntime.status, 'running');
    assert.equal(h.state.lastRuntime.runId, 'actual-shared-run');
  });
  for (const inputMode of ['next', 'guide']) await test(`Flow takeover queue edit ${inputMode} keeps its id and bypasses new-Flow routing`, async () => {
    const request = { target, backendManaged: true, queueItemId: 'selected-goal', requestedMode: 'goal', goalObjective: 'stable objective' };
    const h = harness(['sendMessage', 'submitCurrentAction'], { state: { mode: 'flow', inputMode, pendingInputEdit: { kind: 'queue', index: 0, request, target, originalText: 'old' }, nextQueue: ['old'], nextQueueRequests: [request] } });
    await h.window.submitCurrentAction('enter');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].action, inputMode === 'next' ? 'queue_update' : 'queue_guide');
    assert.equal(h.calls[0].input.id, 'selected-goal');
    assert.equal(h.calls[0].input.requestedMode, 'goal');
    assert.equal(h.calls[0].input.goalObjective, 'stable objective');
  });
  await test('Browser bridge queue edit does not invent mode, objective, timestamp or text fields', async () => {
    const h = bridgeHarness();
    await h.api.queueAction('queue_update', { id: 'goal-row', text: 'updated' }, other);
    assert.deepEqual(h.calls[0].body, { ...other, action: 'queue_update', id: 'goal-row', text: 'updated' });
    await h.api.queueAction('queue_guide', { id: 'goal-row' }, other);
    assert.deepEqual(h.calls[1].body, { ...other, action: 'queue_guide', id: 'goal-row' });
  });
  await test('Browser bridge preserves explicitly cleared fields, images and false pause', async () => {
    const h = bridgeHarness();
    const input = { id: 'same-id', text: '', goalObjective: '', createdAt: '', requestedMode: 'plan', images: [{ name: 'own.png' }], paused: false, orderedIds: [] };
    await h.api.queueAction('queue_update', input, other);
    assert.deepEqual(h.calls[0].body, { ...other, action: 'queue_update', ...input });
  });
  await test('Browser bridge setMode submits target and returns parsed backend acknowledgement', async () => {
    const h = bridgeHarness();
    assert.deepEqual(await h.api.setMode('goal', other), h.response);
    assert.deepEqual(h.calls[0].body, { mode: 'goal', ...other });
  });
  await test('Browser bridge input mode persists for its target and returns parsed acknowledgement', async () => {
    const h = bridgeHarness();
    assert.deepEqual(await h.api.setInputMode('next', other), h.response);
    assert.equal(h.calls[0].url, '/api/input-mode');
    assert.deepEqual(h.calls[0].body, { inputMode: 'next', ...other });
  });
  await test('Browser bridge getState queries the explicit target including encoded identifiers', async () => {
    const h = bridgeHarness();
    const selected = { workspaceId: 'workspace 中文 & +', conversationId: 'conversation / ?' };
    await h.api.getState(selected);
    const url = new URL(h.calls[0].url, 'http://localhost');
    assert.equal(url.pathname, '/api/state');
    assert.equal(url.searchParams.get('workspaceId'), selected.workspaceId);
    assert.equal(url.searchParams.get('conversationId'), selected.conversationId);
  });
  await test('Browser bridge Flow sends explicit workflow identity and keeps legacy defaultFlow', async () => {
    const h = bridgeHarness();
    await h.api.sendMessage('flow instruction', other, { requestedMode: 'flow', inputMode: 'next', clientMessageId: 'flow-id', flowName: 'Selected Flow', flowStart: 2 });
    assert.equal(h.calls[0].body.flowName, 'Selected Flow');
    assert.equal(h.calls[0].body.defaultFlow, 'Selected Flow');
    assert.equal(h.calls[0].body.flowStart, 2);
    assert.equal(h.calls[0].body.workspaceId, other.workspaceId);
    assert.equal(h.calls[0].body.conversationId, other.conversationId);
  });
  const receipt = { sourcePath, sourceSha256: require('node:crypto').createHash('sha256').update(html).digest('hex'), tests: results, passed: results.filter(item => item.pass).length, failed: results.filter(item => !item.pass).length };
  const output = option('--result', '');
  if (output) fs.writeFileSync(output, JSON.stringify(receipt, null, 2));
  for (const row of results) console.log(`[${row.pass ? 'PASS' : 'FAIL'}] ${row.name}${row.pass ? '' : '\n' + row.error}`);
  console.log(`RENDERER_COMMANDS ${receipt.passed}/${results.length}`);
  if (receipt.failed) process.exitCode = 1;
  return receipt;
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
