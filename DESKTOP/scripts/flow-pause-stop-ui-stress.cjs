'use strict';
// UI Flow pause/stop stress test (jsdom).
// Extracts the flow takeover / pause / stop block from src/ui/index.html and
// exercises the full state machine against a stubbed window. Flow takeover is
// conversation-local state: each conversation owns its own running/paused
// record keyed by runtimeKey, never a global flag. First Stop/Esc while a Flow
// is RUNNING must be cooperative (api.stopFlow returns { action:'stopping' } ->
// no teardown, the interrupted suspension renders the paused takeover), the
// second Stop/Esc must force-stop (tears down, restores Build mode), and a new
// Build/Plan/Goal instruction sent while paused must exit the paused takeover
// without restoring the previous mode. The paused bubble has no local Resume
// button: clicking the whole bubble resumes. Repeated pause/stop churn must
// never leak a running or paused flag across conversations.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'src', 'ui', 'index.html');
const source = fs.readFileSync(INDEX_HTML, 'utf8');

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

function runtimeKeyFor(workspaceId, conversationId) {
  return String(workspaceId || '') + '::' + String(conversationId || 'default');
}
function currentRuntimeKey(conversationId) {
  return runtimeKeyFor(currentTarget.workspaceId, conversationId || currentTarget.conversationId);
}

window.state = {
  flowTakeovers: {},
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
    'flow.pausedTakeover': 'Paused takeover',
    'flow.takeover': 'Flow takeover',
    'flow.resume': 'Resume',
    'flow.emptyRun': 'Empty flow run',
    'flow.started': 'Started',
    'flow.saved': 'Saved',
    'flow.runningPlaceholder': 'Flow is running…',
    'input.placeholder': 'Type your message',
    'workspace.saveFailed': 'Save failed',
  };
  return keys[k] || k;
};
window.addMsg = function(role, content, kind, model) {
  sendMessages.push(content);
  return undefined;
};
window.closeSubWin = function() { return undefined; };
window.renderFlowSelector = function() { return undefined; };
window.loadFileTree = function() { return undefined; };
window.isQueuePausedForTarget = function() { return false; };

window.eval(block);

function flowRecordFor(target) {
  target = target || currentTarget;
  var key = runtimeKeyFor(target.workspaceId, target.conversationId);
  if (!window.state.flowTakeovers[key]) {
    window.state.flowTakeovers[key] = { running: false, paused: false, target: { ...target } };
  }
  return window.state.flowTakeovers[key];
}

(async function run() {
  // 1. First Stop/Esc while a Flow is RUNNING is cooperative.
  flowRecordFor(currentTarget).running = true;
  flowRecordFor(currentTarget).paused = false;
  window.renderFlowTakeover(true, 'pause-stop-flow', { target: { ...currentTarget } });
  stopFlowResults = [{ action: 'stopping' }];
  sendMessages = [];
  var stopResult = await window.stopFlowRun();
  assert(!!stopResult && stopResult.action === 'stopping', 'first Stop returns the cooperative stopping result');
  assert(flowRecordFor(currentTarget).running === true, 'first Stop does not tear down a running Flow');
  assert(!sendMessages.some(m => String(m).includes('Flow stopped manually')), 'first Stop does not print a manual-stop bubble');
  assert(visibleModes.length === 0, 'first Stop does not switch visible mode');

  // 2. The interrupted suspension renders the paused takeover.
  window.renderFlowTakeover(true, 'pause-stop-flow', { interrupted: true, message: 'interrupted by user', target: { ...currentTarget } });
  const takeover = window.document.getElementById('flow-takeover');
  assert(flowRecordFor(currentTarget).paused === true, 'paused takeover flips the conversation flow record paused flag');
  assert(takeover.classList.contains('paused'), 'paused takeover carries the .paused class');
  assert(takeover.classList.contains('active'), 'paused takeover is active');
  assert(takeover.innerHTML.includes('Paused takeover'), 'paused takeover renders the paused label');
  assert(!window.document.querySelector('.flow-resume-btn'), 'paused takeover has no local Resume button');
  assert(takeover.onclick && typeof takeover.onclick === 'function', 'whole paused bubble is the interactive resume affordance');
  resumeCalls = 0;
  takeover.onclick({ stopPropagation: function() {} });
  await tick();
  assert(resumeCalls === 1, 'clicking the whole paused bubble resumes the Flow');

  // A paused takeover belongs to its originating target. Switching away hides
  // it and neither Resume nor Stop may act on the newly foregrounded target.
  currentTarget = { conversationId: 'conv-b', workspaceId: 'ws-b' };
  window.reconcileFlowTakeoverForActive();
  window.renderFlowTakeover(true, 'pause-stop-flow', { interrupted: true, target: { conversationId: 'conv-a', workspaceId: 'ws-a' } });
  assert(!takeover.classList.contains('active'), 'switching conversations hides a takeover owned by another target');
  stopFlowResults = [{ action: 'stopping' }];
  const staleStop = await window.stopFlowRun();
  assert(staleStop && staleStop.action === 'not_running', 'Stop cannot act on a takeover owned by another target');
  resumeCalls = 0;
  const staleResume = await window.resumeInterruptedFlow();
  assert(staleResume && staleResume.ok === false && resumeCalls === 0, 'Resume cannot act on a takeover owned by another target');
  assert(flowRecordFor(currentTarget).running !== true, 'a non-owner conversation never gets a running flow flag');
  currentTarget = { conversationId: 'conv-a', workspaceId: 'ws-a' };
  window.reconcileFlowTakeoverForActive();

  // 3. A new Build/Plan/Goal instruction sent while paused exits the pause
  // without restoring the previous mode.
  flowRecordFor(currentTarget).running = true;
  flowRecordFor(currentTarget).paused = true;
  sendMessages = [];
  visibleModes = [];
  window.exitPausedFlowForNewInstruction();
  assert(flowRecordFor(currentTarget).running === false, 'new-instruction exit clears the running flag');
  assert(flowRecordFor(currentTarget).paused === false, 'new-instruction exit clears the paused flag');
  assert(visibleModes.length === 0, 'new-instruction exit never restores the previous Flow mode');
  assert(!window.document.getElementById('flow-takeover').classList.contains('active'), 'new-instruction exit hides the takeover');
  assert(sendMessages.length === 0, 'new-instruction exit prints no manual-stop bubble');

  // 4. Second Stop/Esc force-stops: tears down and returns to Build.
  flowRecordFor(currentTarget).running = true;
  flowRecordFor(currentTarget).paused = false;
  window.renderFlowTakeover(true, 'pause-stop-flow', { target: { ...currentTarget } });
  stopFlowResults = [{ action: 'force_stopped_pending' }];
  sendMessages = [];
  visibleModes = [];
  queueDrains = [];
  await window.stopFlowRun();
  assert(flowRecordFor(currentTarget).running === false, 'second Stop force-stops the running Flow');
  assert(flowRecordFor(currentTarget).paused === false, 'second Stop clears the paused flag');
  assert(visibleModes.some(m => m === 'build'), 'second Stop returns visible mode to Build');
  assert(sendMessages.some(m => String(m).includes('Flow stopped manually')), 'second Stop prints the manual-stop bubble');

  // 5. A paused Flow that completes keeps the queue paused and never drains.
  window.renderFlowTakeover(true, 'pause-stop-flow', { interrupted: true, message: 'interrupted', target: { ...currentTarget } });
  flowRecordFor(currentTarget).running = true;
  flowRecordFor(currentTarget).paused = true;
  queueDrains = [];
  flowRecordFor(currentTarget).queueLease = { target: { conversationId: 'conv-a', workspaceId: 'ws-a' }, wasPaused: true };
  window.state.nextQueue = ['queued request'];
  window.state.nextQueueRequests = [{ text: 'queued request' }];
  var settlement = window.stopFlowRunInternal({ keepPaused: true });
  assert(window.state.queuePausedByTarget['ws-a::conv-a'] === true, 'abnormal stop keeps the queue paused');
  assert(!settlement || settlement.shouldDrain !== true, 'abnormal stop never drains the queue');
  assert(queueDrains.length === 0, 'abnormal stop schedules no queue drain');

  // 6. Churn: 12 pause/stop/force-stop cycles never leak running or paused flags.
  for (let cycle = 0; cycle < 12; cycle++) {
    flowRecordFor(currentTarget).running = true;
    window.renderFlowTakeover(true, 'pause-stop-flow', { interrupted: true, message: 'interrupted', target: { ...currentTarget } });
    assert(flowRecordFor(currentTarget).paused === true, 'churn ' + cycle + ': pause engages');
    flowRecordFor(currentTarget).running = true;
    stopFlowResults = [{ action: 'stopping' }];
    await window.stopFlowRun();
    assert(flowRecordFor(currentTarget).running === true, 'churn ' + cycle + ': cooperative stop keeps running');
    window.exitPausedFlowForNewInstruction();
    assert(flowRecordFor(currentTarget).running === false && flowRecordFor(currentTarget).paused === false,
      'churn ' + cycle + ': new-instruction exit clears both flags');
    flowRecordFor(currentTarget).running = true;
    stopFlowResults = [{ action: 'force_stopped_pending' }];
    await window.stopFlowRun();
    assert(flowRecordFor(currentTarget).running === false && flowRecordFor(currentTarget).paused === false,
      'churn ' + cycle + ': force stop clears both flags');
  }

  // 7. A Flow paused in conversation A never leaks a running flag into
  // conversation B after the A->B->A round trip.
  currentTarget = { conversationId: 'conv-a', workspaceId: 'ws-a' };
  window.reconcileFlowTakeoverForActive();
  window.renderFlowTakeover(true, 'pause-stop-flow', { interrupted: true, message: 'interrupted', target: { ...currentTarget } });
  assert(flowRecordFor(currentTarget).paused === true, 'round-trip: conversation A keeps its paused Flow');
  currentTarget = { conversationId: 'conv-b', workspaceId: 'ws-b' };
  window.reconcileFlowTakeoverForActive();
  assert(flowRecordFor(currentTarget).running !== true, 'round-trip: conversation B never inherits a running flag');
  assert(flowRecordFor(currentTarget).paused !== true, 'round-trip: conversation B never inherits a paused flag');
  assert(!window.document.getElementById('flow-takeover').classList.contains('active'), 'round-trip: takeover hidden in conversation B');
  currentTarget = { conversationId: 'conv-a', workspaceId: 'ws-a' };
  window.reconcileFlowTakeoverForActive();
  window.renderFlowTakeover(true, 'pause-stop-flow', { interrupted: true, message: 'interrupted', target: { ...currentTarget } });
  assert(flowRecordFor(currentTarget).paused === true, 'round-trip: switching back restores conversation A paused Flow');
  assert(window.document.getElementById('flow-takeover').classList.contains('active'), 'round-trip: takeover visible again in conversation A');

  if (failures.length) {
    console.error('flow-pause-stop UI stress FAILED (' + failures.length + ')');
    process.exit(1);
  }
  console.log('flow-pause-stop UI stress: all checks passed');
})().catch(error => {
  console.error('flow-pause-stop UI stress ERROR: ' + (error.stack || error.message));
  process.exit(1);
});
