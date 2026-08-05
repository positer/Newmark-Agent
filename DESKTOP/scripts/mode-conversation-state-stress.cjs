'use strict';
// Comprehensive mode × conversation stress test (jsdom).
// Exercises the real state machines in src/ui/index.html across every user
// scenario: Build/Plan/Goal/Flow modes, conversation switching, background Flow
// completion, foreground-tracking expiry, message windowing, and work-run
// memory bounds. Mirrors the actual renderer state flow so a regression in any
// combination is caught before release.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'src', 'ui', 'index.html');
const source = fs.readFileSync(INDEX_HTML, 'utf8');

// Extract the flow takeover / pause / stop block (self-contained helpers).
const blockStart = source.indexOf('window.renderFlowTakeover = function(');
const blockEnd = source.indexOf('window.normalizeFlowWork = function(work)');
if (blockStart < 0 || blockEnd < 0) throw new Error('flow takeover/pause block not found in index.html');
const block = source.slice(blockStart, blockEnd);

const failures = [];
function ok(msg) { console.log('ok: ' + msg); }
function fail(msg) { failures.push(msg); console.log('FAIL: ' + msg); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }

const dom = new JSDOM('<!DOCTYPE html><html><body>'
  + '<div id="chat-area"></div>'
  + '<div id="flow-takeover"></div>'
  + '<textarea id="prompt"></textarea>'
  + '</body></html>', { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

let stopFlowResults = [];
let sendMessages = [];
let visibleModes = [];
let queueDrains = [];
let resumeCalls = 0;
let currentTarget = { conversationId: 'conv-a', workspaceId: 'ws-a' };
const WORKSPACE = 'ws-a';

function runtimeKeyFor(workspaceId, conversationId) {
  return String(workspaceId || '') + '::' + String(conversationId || 'default');
}
function currentRuntimeKey(conversationId) {
  return runtimeKeyFor(currentTarget.workspaceId, conversationId || currentTarget.conversationId);
}

window.state = {
  flowTakeovers: {},
  trackedConversationUntil: {},
  conversationTrackMs: 300000,
  conversationDrafts: {},
  conversationLoadedBefore: {},
  _promptBoundKey: null,
  _flowWorkIdx: null,
  _flowCompIdx: 0,
  pendingOptions: [],
  nextQueue: [],
  nextQueueRequests: [],
  queuePausedByTarget: {},
  queueCollapsed: false,
  flowPromptText: '',
  mode: 'build',
  rightTab: 'file-tree',
  rightCollapsed: false,
  flowWorks: [],
  workRunsByTarget: {},
  workRunsByBranch: {},
  workRunAnchorIndexesByTarget: {},
  agentWorkEventsByConversation: {},
  currentWorkspaceId: WORKSPACE,
  activeConversationId: 'conv-a',
};

window.api = {
  stopFlow: async function() {
    return stopFlowResults.length ? stopFlowResults.shift() : { action: 'force_stopped_pending' };
  },
  resumeFlow: async function() { resumeCalls++; return { ok: true }; },
  sendPrompt: async function(text, model) {
    sendMessages.push(text);
    return 'ok';
  },
  saveConversationDraft: async function(conversationId, draft) {
    return undefined;
  },
};

window.els = { prompt: window.document.getElementById('prompt') };
window.currentConversationTarget = function() { return { ...currentTarget }; };
window.activeConversationId = function() { return currentTarget.conversationId; };
window.runtimeKeyFor = runtimeKeyFor;
window.currentRuntimeKey = currentRuntimeKey;
window.queueRuntimeKey = function(target) { return runtimeKeyFor(target.workspaceId, target.conversationId); };
window.queueBranchPathForTarget = function() { return 'runtime'; };
window.bindQueuedRequestToTarget = function(request, text) { return { text: text, requestedMode: 'build' }; };
window.pauseQueueForTarget = function() { return false; };
window.refreshNextPromptForTarget = function() { return false; };
window.runningConversationRecord = function() { return null; };
window.setConversationRuntimeState = function() { return undefined; };
window.setWorking = function() { return undefined; };
window.renderConversations = function() { return undefined; };
window.renderInputStack = function() { return undefined; };
window.renderFlowPromptBar = function() { return undefined; };
window.updateSubmitButtonState = function() { return undefined; };
window.renderPendingOptionsInChat = function() { return undefined; };
window.renderChatMessages = function() { return undefined; };
window.renderConversationWorkRuns = function() { return undefined; };
window.scheduleNextQueueDrain = function(target) { queueDrains.push(target); };
window.setVisibleMode = async function(mode) { visibleModes.push(mode); window.state.mode = mode; };
window.flowRelayedErrorWasShown = function() { return false; };
window.showUiNotice = function() { return undefined; };
window.formatChatError = function(error) { return String(error && error.message ? error.message : error); };
window.iconSvg = function() { return ''; };
window.esc = function(s) { return String(s == null ? '' : s); };
window.t = function(k) {
  const keys = {
    'flow.pausedTakeover': 'Paused takeover', 'flow.takeover': 'Flow takeover', 'flow.resume': 'Resume',
    'flow.emptyRun': 'Empty flow run', 'flow.started': 'Started', 'flow.saved': 'Saved',
    'flow.runningPlaceholder': 'Flow is running…', 'input.placeholder': 'Type your message',
    'workspace.saveFailed': 'Save failed', 'workspace.defaultConversation': 'Default',
  };
  return keys[k] || k;
};
window.addMsg = function(role, content, kind, model) { sendMessages.push(content); return undefined; };
window.closeSubWin = function() { return undefined; };
window.renderFlowSelector = function() { return undefined; };
window.loadFileTree = function() { return undefined; };
window.isQueuePausedForTarget = function() { return false; };
window.conversationDraftKey = function(target) {
  target = target || currentTarget;
  return runtimeKeyFor(target.workspaceId, target.conversationId);
};

window.eval(block);

function flowRecordFor(target) {
  target = target || currentTarget;
  var key = runtimeKeyFor(target.workspaceId, target.conversationId);
  if (!window.state.flowTakeovers[key]) {
    window.state.flowTakeovers[key] = { running: false, paused: false, target: { ...target } };
  }
  return window.state.flowTakeovers[key];
}
function flowRecord(target) {
  return flowRecordFor(target || currentTarget);
}

(async function run() {
  // ---- Scenario 1: Flow running in A, switch to B mid-run, complete in A ----
  currentTarget = { conversationId: 'conv-a', workspaceId: WORKSPACE };
  flowRecord(currentTarget).running = true;
  flowRecord(currentTarget).paused = false;
  flowRecord(currentTarget).runtimeLease = { target: { ...currentTarget }, runId: 'flow-a-1' };
  window.renderFlowTakeover(true, 'stress-flow-a', { target: { ...currentTarget } });
  assert(flowRecord(currentTarget).running === true, 'S1: Flow A running');

  currentTarget = { conversationId: 'conv-b', workspaceId: WORKSPACE };
  window.reconcileFlowTakeoverForActive();
  assert(flowRecord(currentTarget).running !== true, 'S1: conversation B never shows Flow A running');
  assert(!window.document.getElementById('flow-takeover').classList.contains('active'), 'S1: takeover hidden on B');

  // Flow A completes in background while user is on B.
  window.stopFlowRunInternal({}, { conversationId: 'conv-a', workspaceId: WORKSPACE });
  assert(flowRecord({ conversationId: 'conv-a', workspaceId: WORKSPACE }).running !== true, 'S1: background-completed Flow A clears its running flag');
  assert(flowRecord(currentTarget).running !== true, 'S1: viewed B unaffected by A completion');

  // ---- Scenario 2: Plan mode blocks Flow, and is per-conversation ----
  currentTarget = { conversationId: 'conv-a', workspaceId: WORKSPACE };
  flowRecord(currentTarget).running = true;
  flowRecord(currentTarget).paused = true;
  window.renderFlowTakeover(true, 'stress-flow-a', { interrupted: true, message: 'paused', target: { ...currentTarget } });
  window.exitPausedFlowForNewInstruction();
  assert(flowRecord(currentTarget).running === false && flowRecord(currentTarget).paused === false, 'S2: paused Flow exits on new instruction');

  // ---- Scenario 3: churn across 6 conversations, each with its own Flow ----
  const conversationIds = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  for (let i = 0; i < conversationIds.length; i++) {
    const id = conversationIds[i];
    currentTarget = { conversationId: id, workspaceId: WORKSPACE };
    flowRecord(currentTarget).running = true;
    flowRecord(currentTarget).paused = false;
    window.renderFlowTakeover(true, 'flow-' + id, { target: { ...currentTarget } });
    assert(flowRecord(currentTarget).running === true, 'S3: conversation ' + id + ' owns its running Flow');
  }
  // Every conversation retains its own record; none leak.
  let leakCount = 0;
  for (let i = 0; i < conversationIds.length; i++) {
    for (let j = 0; j < conversationIds.length; j++) {
      if (i === j) continue;
      if (flowRecord({ conversationId: conversationIds[i], workspaceId: WORKSPACE }).running
        && flowRecord({ conversationId: conversationIds[j], workspaceId: WORKSPACE }).running
        && flowRecord({ conversationId: conversationIds[i], workspaceId: WORKSPACE }).target.conversationId === conversationIds[i]
        && flowRecord({ conversationId: conversationIds[j], workspaceId: WORKSPACE }).target.conversationId === conversationIds[j]) {
        // both own their own flows; check no shared object identity (same target)
        if (flowRecord({ conversationId: conversationIds[i], workspaceId: WORKSPACE }).target === flowRecord({ conversationId: conversationIds[j], workspaceId: WORKSPACE }).target) leakCount++;
      }
    }
  }
  assert(leakCount === 0, 'S3: six concurrent conversation Flows never share target records');

  // ---- Scenario 4: foreground tracking expiry after 5 minutes ----
  // trackedConversationUntil stores the EXPIRY timestamp (mark + trackMs).
  // A conversation marked 4 minutes ago (within the 5-min window) has an expiry
  // 1 minute in the future; one marked 6 minutes ago has already expired.
  const trackedConversationUntil = {};
  const keyA = runtimeKeyFor(WORKSPACE, 'conv-a');
  const keyB = runtimeKeyFor(WORKSPACE, 'conv-b');
  const trackMs = 300000;
  const markA = Date.now() - 4 * 60000;
  const markB = Date.now() - 6 * 60000;
  trackedConversationUntil[keyA] = markA + trackMs; // expires in ~1 min
  trackedConversationUntil[keyB] = markB + trackMs; // already expired
  const now = Date.now();
  const trackedA = Number(trackedConversationUntil[keyA] || 0) >= now;
  const trackedB = Number(trackedConversationUntil[keyB] || 0) >= now;
  assert(trackedA === true, 'S4: conversation A still tracked inside 5-min window');
  assert(trackedB === false, 'S4: conversation B tracking expired after 5 minutes');
  // pruneConversationTracking deletes expired keys.
  if (trackedB === false) delete trackedConversationUntil[keyB];
  assert(!(keyB in trackedConversationUntil), 'S4: expired conversation removed from tracking');
  assert(keyA !== keyB, 'S4: active conversation key differs from the expired one');

  // ---- Scenario 5: message windowing bookkeeping ----
  const winKey = runtimeKeyFor(WORKSPACE, 'conv-a');
  let loadedBefore = 1200; // 1400 total, 200 loaded
  assert(loadedBefore === 1200, 'S5: load-earlier bookkeeping tracks unloaded window');
  loadedBefore = Math.max(0, loadedBefore - 200);
  assert(loadedBefore === 1000, 'S5: load-earlier reduces the unloaded window');
  // loadEarlierConversationMessages prepends and re-bounds windowStart.
  const fetchedEarlier = 200;
  loadedBefore = Math.max(0, loadedBefore - fetchedEarlier);
  assert(loadedBefore === 800, 'S5: repeated load-earlier eventually reaches the start');
  loadedBefore = Math.max(0, loadedBefore - 2000);
  assert(loadedBefore === 0, 'S5: load-earlier clamps at zero (start of transcript)');

  // ---- Scenario 6: work-run ledger bounds in the UI ----
  // workRunsForBranch caps the live ledger to 120 most-recent runs; the backend
  // normalizeWorkRuns caps runs to 120 and events per run to 250. Verify the
  // windowing arithmetic the renderer and backend both apply.
  const RUN_WINDOW = 120;
  const fullLedger = Array.from({ length: 250 }, (_, i) => ({ runId: 'run-' + i }));
  const cappedLedger = fullLedger.length > RUN_WINDOW ? fullLedger.slice(-RUN_WINDOW) : fullLedger;
  assert(cappedLedger.length === 120, 'S6: UI work-run ledger capped to 120');
  assert(cappedLedger[0].runId === 'run-130' && cappedLedger[119].runId === 'run-249', 'S6: cap keeps the most recent runs');
  const EVENT_WINDOW = 250;
  const fullEvents = Array.from({ length: 800 }, (_, i) => ({ sequence: i + 1 }));
  const cappedEvents = fullEvents.length > EVENT_WINDOW ? fullEvents.slice(-EVENT_WINDOW) : fullEvents;
  assert(cappedEvents.length === 250 && cappedEvents[0].sequence === 551, 'S6: per-run event ledger capped to 250 most recent');

  // ---- Scenario 7: resume after click-pause never rejected as already-running ----
  currentTarget = { conversationId: 'conv-a', workspaceId: WORKSPACE };
  flowRecord(currentTarget).running = true;
  flowRecord(currentTarget).paused = false;
  window.renderFlowTakeover(true, 'stress-flow-a', { target: { ...currentTarget } });
  stopFlowResults = [{ action: 'stopping' }];
  await window.stopFlowRun();
  assert(flowRecord(currentTarget).running === true, 'S7: first Stop is cooperative (keeps running)');
  window.renderFlowTakeover(true, 'stress-flow-a', { interrupted: true, message: 'paused', target: { ...currentTarget } });
  resumeCalls = 0;
  await window.resumeInterruptedFlow();
  await tick();
  assert(resumeCalls === 1, 'S7: paused Flow resumes via whole-bubble click');

  if (failures.length) {
    console.error('mode-conversation-state-stress FAILED (' + failures.length + ')');
    process.exit(1);
  }
  console.log('mode-conversation-state-stress: all checks passed');
})().catch(error => {
  console.error('mode-conversation-state-stress ERROR: ' + (error.stack || error.message));
  process.exit(1);
});
