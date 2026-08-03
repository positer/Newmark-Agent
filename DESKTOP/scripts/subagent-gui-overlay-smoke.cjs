'use strict';
// GUI SubAgent live-history overlay smoke test (jsdom).
// Extracts the subagent overlay block from src/ui/index.html and executes the
// full streaming event lifecycle against a stubbed window, then asserts
// overlay DOM behavior: base messages, result block, streaming text chunks,
// tool call/result pairing, completion/error lines, cross-agent isolation,
// cache replay on reopen, 500-entry cap, and terminal refresh.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'src', 'ui', 'index.html');
const source = fs.readFileSync(INDEX_HTML, 'utf8');

const blockStart = source.indexOf('var _subagentLive = null;');
const blockEnd = source.indexOf('// === Browser ===', blockStart);
if (blockStart < 0 || blockEnd < 0) throw new Error('subagent overlay block not found in index.html');
const block = source.slice(blockStart, blockEnd);

const failures = [];
function ok(msg) { console.log('ok: ' + msg); }
function fail(msg) { failures.push(msg); console.log('FAIL: ' + msg); }
function assert(cond, msg) { if (cond) ok(msg); else fail(msg); }

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chat-area"></div></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

const subagents = [
  {
    id: 'a1',
    name: 'a1',
    displayName: 'Agent One',
    qualifiedName: 'team/a1',
    status: 'completed',
    mode: 'build',
    model: 'test-model',
    result: 'final result block',
    messages: [
      { role: 'user', content: 'do the task' },
      { role: 'assistant', content: 'interim report' },
    ],
  },
  {
    id: 'a2',
    name: 'a2',
    displayName: 'Agent Two',
    qualifiedName: 'team/a2',
    status: 'working',
    mode: 'build',
    model: 'test-model',
    messages: [],
  },
];

let renderListCalls = 0;
let refreshCalls = 0;
let apiStateCalls = 0;

window.state = {
  subagents: JSON.parse(JSON.stringify(subagents)),
  subagentPeerEventsByActor: {},
  subagentHistoryActorId: '',
  rightTab: 'subagent',
};

window.api = {
  getState: async function() {
    apiStateCalls++;
    return { subagents: [{ ...subagents[0], status: 'running' }] };
  },
};

window.renderSubagentList = function() { renderListCalls++; };
window.scheduleSubagentStateRefresh = function() { refreshCalls++; };

window.esc = function(s) { return String(s == null ? '' : s); };
window.escAttr = function(s) { return String(s == null ? '' : s); };
window.t = function(k) {
  const keys = {
    'subagent.liveHistory': 'Live history',
    'subagent.noMessages': 'No messages yet',
    'subagent.historyTitle': 'Subagent History',
    'subagent.history': 'History',
    'subagent.result': 'Result',
    'common.close': 'Close',
    'common.idle': 'idle',
    'common.default': 'default',
    'status.contextCompressed': 'Context compressed',
    'status.messages': 'messages',
  };
  return keys[k] || k;
};
window.currentLang = function() { return 'en'; };
window.shouldAutoScroll = function() { return true; };
window.publicToolNameForUi = function(n) { return n; };
window.currentWorkspaceKey = function() { return 'ws-test'; };
window.currentConversationTarget = function() { return 'default'; };

window.eval(block);

(async function run() {
// 1. Open overlay for completed agent a1.
window.openSubagentHistory('a1');
const overlay = window.document.getElementById('subagent-history-overlay');
assert(!!overlay, 'overlay created');
assert(window.state.subagentHistoryActorId === 'a1', 'history actor locked to a1');
const body = window.document.getElementById('subagent-history-body');
assert(body.textContent.includes('do the task') && body.textContent.includes('interim report'), 'base messages rendered');
assert(overlay.textContent.includes('final result block'), 'result block rendered');
assert(window.document.getElementById('subagent-history-meta').textContent.includes('completed'), 'meta shows completed status');
assert(window.document.getElementById('chat-area').textContent === '', 'main chat area untouched');

// 2. Stream a full event sequence for a1.
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'start', content: '', mode: 'build', model: 'test-model', timestamp: 't1' });
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'text', content: 'streaming peer reply ', mode: 'build', model: 'test-model', timestamp: 't2' });
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'text', content: 'with several chunks', mode: 'build', model: 'test-model', timestamp: 't3' });
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'tool_call', toolName: 'bash', content: '', mode: 'build', model: 'test-model', timestamp: 't4' });
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'tool_result', content: 'tool stdout', mode: 'build', model: 'test-model', timestamp: 't5' });
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'final_response', content: 'final answer', mode: 'build', model: 'test-model', timestamp: 't6' });
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'done', content: '', mode: 'build', model: 'test-model', timestamp: 't7' });
assert(body.textContent.includes('streaming peer reply with several chunks'), 'streamed text chunks concatenated');
assert(body.textContent.includes('bash'), 'tool call label rendered');
assert(body.textContent.includes('tool stdout'), 'tool result rendered');
assert(body.textContent.includes('final answer'), 'final response appended');
assert(body.textContent.includes('— Completed —'), 'completion line rendered');
await tick();
assert(apiStateCalls === 1 && renderListCalls === 1, 'terminal refresh triggered once');
assert(window.document.getElementById('subagent-history-meta').textContent.includes('running'), 'meta refreshed to running status');

// 3. Cross-agent isolation: events for a2 are cached but not rendered.
window.openSubagentHistory('a2');
const body2 = window.document.getElementById('subagent-history-body');
assert(body2.textContent.includes('No messages yet'), 'a2 empty state rendered');
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'text', content: 'noise for a1', mode: 'build', model: 'test-model', timestamp: 't8' });
assert(!body2.textContent.includes('noise for a1'), 'foreign actor events not rendered in a2 overlay');
assert(window.state.subagentPeerEventsByActor.a1.length === 8, 'foreign actor events still cached');

// 4. Reopen a1: full cache replay, then close.
window.openSubagentHistory('a1');
const body3 = window.document.getElementById('subagent-history-body');
assert(body3.textContent.includes('streaming peer reply with several chunks') && body3.textContent.includes('final answer'), 'cache replay on reopen');
window.closeSubagentHistory();
assert(!window.document.getElementById('subagent-history-overlay'), 'overlay removed on close');
assert(window.state.subagentHistoryActorId === '', 'history actor cleared on close');

// 5. Cache cap at 500 entries.
for (let i = 0; i < 520; i++) window.appendSubagentPeerEvent({ actorId: 'a3', type: 'status', content: 'e' + i, mode: 'build', model: 'test-model', timestamp: 't' });
assert(window.state.subagentPeerEventsByActor.a3.length === 500, 'cache capped at 500');
assert(window.state.subagentPeerEventsByActor.a3[0].content === 'e20', 'oldest entries dropped first');

// 6. Error terminal line.
window.openSubagentHistory('a2');
window.appendSubagentPeerEvent({ actorId: 'a2', type: 'error', content: 'boom', mode: 'build', model: 'test-model', timestamp: 't9' });
const body4 = window.document.getElementById('subagent-history-body');
assert(body4.textContent.includes('[Error] boom'), 'error line rendered');
await tick();
// Reopening a1 (step 4) replayed the cached a1 'done' event, which fires one
// more idempotent terminal refresh: 1 (done) + 1 (replay) + 1 (this error) = 3.
assert(renderListCalls === 3 && apiStateCalls === 3, 'terminal refresh fired for error too');

// 7. zh locale checks.
window.currentLang = function() { return 'zh'; };
window.openSubagentHistory('a1');
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'start', content: '', mode: 'build', model: 'test-model', timestamp: 't10' });
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'tool_call', toolName: 'bash', content: '', mode: 'build', model: 'test-model', timestamp: 't11' });
const body5 = window.document.getElementById('subagent-history-body');
assert(body5.textContent.includes('助手') && body5.textContent.includes('工具调用'), 'zh assistant/tool labels');
window.appendSubagentPeerEvent({ actorId: 'a1', type: 'done', content: '', mode: 'build', model: 'test-model', timestamp: 't12' });
assert(body5.textContent.includes('—— 已完成 ——'), 'zh completion line');
await tick();
// Opening a1 here replays its cached 'done' event (one more idempotent
// refresh) plus the zh 'done' event: 3 (after step 6) + 1 (replay) + 1 (zh) = 5.
assert(renderListCalls === 5 && apiStateCalls === 5, 'zh terminal refresh fired');

if (failures.length) {
  console.error('subagent GUI overlay smoke FAILED (' + failures.length + ')');
  process.exit(1);
}
console.log('subagent GUI overlay smoke: all checks passed');
})();
