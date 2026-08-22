/**
 * dev-0.5.5 queue-unification pressure gate.
 *
 * Mobile-originated queue entries reach the desktop renderer as
 * `backendManaged` rows. Previously those rows were locked (no edit / delete /
 * guide / drag). dev-0.5.5 makes them operable when the kernel exposed their
 * stable `queueItems` id:
 *
 * - `queueItemsByTarget` state + `queueItemIdForText` id lookup;
 * - `renderQueuePanel` renders edit/delete/guide/drag affordances for
 *   backend-managed rows that have an id;
 * - `deleteQueueItem` / `focusQueueItem` / `guideQueueItem` and drop reorder
 *   forward `queue_delete` / `queue_update` / `queue_guide` / `queue_reorder`
 *   through `api.queueAction` -> POST /api/queue-action (same kernel path the
 *   mobile client uses), keeping both surfaces in sync.
 *
 * This test extracts the real renderer functions with a TypeScript AST and
 * executes them in a harness with mocked DOM/api state.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

function uiScriptSource(): string {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ui', 'index.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match) throw new Error('UI script was not found');
  return match[1];
}

function functionSource(source: string, name: string): string {
  const file = ts.createSourceFile('newmark-ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = '';
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(file);
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`function ${name} not found`);
  return found;
}

function assignedFunctionSource(source: string, name: string): string {
  // window.foo = function(...) { ... } with balanced braces (the body may
  // contain `);` sequences, so a naive non-greedy regex would truncate).
  const startMarker = `window.${name} = function`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`assigned function ${name} not found`);
  const fnStart = start + startMarker.length - 'function'.length; // position of 'function'
  let depth = 0;
  let end = fnStart;
  let seenOpen = false;
  for (let i = fnStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth += 1; seenOpen = true; }
    else if (ch === '}') {
      depth -= 1;
      if (seenOpen && depth === 0) { end = i + 1; break; }
    }
  }
  if (!seenOpen || depth !== 0) throw new Error(`assigned function ${name} has unbalanced braces`);
  const raw = source.slice(fnStart, end); // "function(...) { ... }"
  return `function ${name}${raw.slice('function'.length)}`;
}

function check(condition: boolean, message: string): void {
  if (condition) console.log(`  [PASS] ${message}`);
  else console.log(`  [FAIL] ${message}`);
  assert.ok(condition, message);
}

interface Harness {
  state: Record<string, any>;
  apiCalls: Array<Record<string, any>>;
  run(source: string): Promise<any>;
}

function makeHarness(): Harness {
  const apiCalls: Array<Record<string, any>> = [];
  const state: Record<string, any> = {
    nextQueue: [],
    nextQueueRequests: [],
    queueHiddenItems: {},
    queueItemsByTarget: {},
    nextPrompt: '',
    backendQueuesByTarget: {},
    queuePausedByTarget: {},
    nextQueueDrainsByTarget: {},
    nextQueueSchedulesByTarget: {},
    activeSendCallsByTarget: {},
    runningConversations: {},
    conversationRuntimeStates: {},
    workRunsByTarget: {},
    conversationDrafts: {},
    _editingQueueIndex: -1,
    pendingInputEdit: null,
  };
  const harness: Harness = {
    state,
    apiCalls,
    run: (source: string) => {
      const windowObject: Record<string, any> = {
        api: {
          queueAction: async (action: string, input: Record<string, any>) => {
            apiCalls.push({ action, input });
            return { ok: true };
          },
        },
        queueAction: undefined as any,
        renderInputStack: () => {},
        sendMessage: async () => ({ ok: true }),
      };
      const sandbox = `
        var state = ${JSON.stringify(state)};
        var els = {
          prompt: {
            value: '',
            focus: function(){},
            select: function(){},
            dispatchEvent: function(){},
          },
        };
        var renderPromptAttachments = function(){};
        var clearPromptAttachments = function(){};
        var api = window.api;
        window.queueAction = function(action, input){ return api.queueAction(action, input); };
        var currentLang = function(){ return 'zh'; };
        var showUiNotice = function(){};
        var esc = function(v){ return String(v); };
        var escAttr = function(v){ return String(v); };
        var iconSvg = function(){ return ''; };
        var t = function(k){ return k; };
        var normalizeQueuedConversationTarget = function(t){ return t || null; };
        var runtimeKeyFor = function(w, c){ return String(w) + '::' + String(c); };
        var currentConversationTarget = function(){ return { workspaceId: 'ws1', conversationId: 'conv1' }; };
        var normalizeQueueItemText = function(v){ return String(v || ''); };
        var queueBranchPathForTarget = function(){ return ''; };
        var refreshNextPromptForTarget = function(){};
        var queueIndexesForTarget = function(target){ return [0, 1, 2]; };
        var isCurrentConversationRunning = function(){ return true; };
        var restoreQueueItemAfterGuideFailure = function(){};
        var queueHiddenItemKey = function(text, target){ return String(text); };
        var queuedRequestMatchesTarget = function(request, target){ return true; };
        var queuedRequestIsBackendManaged = function(request){ return !!(request && request.backendManaged === true && request.provenance === 'backend-follow-up'); };
        ${source}
        if (typeof deleteQueueItem !== 'undefined') window.deleteQueueItem = deleteQueueItem;
        if (typeof focusQueueItem !== 'undefined') window.focusQueueItem = focusQueueItem;
        if (typeof guideQueueItem !== 'undefined') window.guideQueueItem = guideQueueItem;
        if (typeof startQueueDrag !== 'undefined') window.startQueueDrag = startQueueDrag;
        if (typeof dropQueueDrag !== 'undefined') window.dropQueueDrag = dropQueueDrag;
        if (typeof queueItemsForTarget !== 'undefined') window.queueItemsForTarget = queueItemsForTarget;
        if (typeof setQueueItemsForTarget !== 'undefined') window.setQueueItemsForTarget = setQueueItemsForTarget;
        if (typeof queueItemIdForText !== 'undefined') window.queueItemIdForText = queueItemIdForText;
        window.state = state;
        windowObject = window;
      `;
      const fn = new Function('windowObject', 'window', sandbox + '\nreturn windowObject;');
      return Promise.resolve(fn(windowObject, windowObject));
    },
  };
  return harness;
}

async function main(): Promise<void> {
  console.log('queueUnifyStressVerify');
  const source = uiScriptSource();

  // Extract real renderer helpers.
  const queueItemsForTargetSource = functionSource(source, 'queueItemsForTarget');
  const setQueueItemsForTargetSource = functionSource(source, 'setQueueItemsForTarget');
  const queueItemIdForTextSource = functionSource(source, 'queueItemIdForText');
  const deleteQueueSource = assignedFunctionSource(source, 'deleteQueueItem');
  const focusQueueSource = assignedFunctionSource(source, 'focusQueueItem');
  const guideQueueSource = assignedFunctionSource(source, 'guideQueueItem');
  const startDragSource = assignedFunctionSource(source, 'startQueueDrag');
  const dropDragSource = assignedFunctionSource(source, 'dropQueueDrag');

  // ---- 1. queueItemsForTarget / setQueueItemsForTarget / queueItemIdForText ----
  {
    const h = makeHarness();
    const w = await h.run(`
      ${queueItemsForTargetSource}
      ${setQueueItemsForTargetSource}
      ${queueItemIdForTextSource}
      window.__test = function() {
        var target = { workspaceId: 'ws1', conversationId: 'conv1' };
        setQueueItemsForTarget([
          { id: 'mobile-1', text: 'hello from mobile', queueMode: 'followUp', requestedMode: 'build', createdAt: '2026-08-23T00:00:00Z' },
          { id: 'mobile-2', text: 'second item', queueMode: 'followUp', requestedMode: 'build', createdAt: '2026-08-23T00:00:01Z' },
        ], target);
        var items = queueItemsForTarget(target);
        var id1 = queueItemIdForText('hello from mobile', target);
        var id2 = queueItemIdForText('second item', target);
        var idMissing = queueItemIdForText('not in queue', target);
        return { count: items.length, id1: id1, id2: id2, idMissing: idMissing };
      };
    `);
    const result = w.__test();
    check(result.count === 2, 'queueItemsForTarget returns the stored backend queue items');
    check(result.id1 === 'mobile-1' && result.id2 === 'mobile-2', 'queueItemIdForText resolves stable kernel ids by text');
    check(result.idMissing === '', 'queueItemIdForText returns empty for unknown text');
  }

  // ---- 2. deleteQueueItem forwards queue_delete for backend-managed rows ----
  {
    const h = makeHarness();
    h.state.nextQueue = ['hello from mobile'];
    h.state.nextQueueRequests = [{ backendManaged: true, provenance: 'backend-follow-up', text: 'hello from mobile' }];
    h.state.queueItemsByTarget['ws1::conv1'] = [{ id: 'mobile-1', text: 'hello from mobile' }];
    const w = await h.run(`
      ${queueItemsForTargetSource}
      ${setQueueItemsForTargetSource}
      ${queueItemIdForTextSource}
      ${deleteQueueSource}
    `);
    w.deleteQueueItem(0);
    check(h.apiCalls.length === 1, 'backend-managed delete forwards exactly one queue_delete');
    check(h.apiCalls[0].action === 'queue_delete', 'delete action is queue_delete');
    check(h.apiCalls[0].input.id === 'mobile-1', 'delete forwards the kernel queue item id');
    check(w.state.nextQueue.length === 0, 'delete removes the local row');
  }

  // ---- 3. backend-managed row without an id stays locked (delete returns early) ----
  {
    const h = makeHarness();
    h.state.nextQueue = ['orphan backend row'];
    h.state.nextQueueRequests = [{ backendManaged: true, provenance: 'backend-follow-up', text: 'orphan backend row' }];
    h.state.queueItemsByTarget['ws1::conv1'] = [];
    const w = await h.run(`
      ${queueItemsForTargetSource}
      ${setQueueItemsForTargetSource}
      ${queueItemIdForTextSource}
      ${deleteQueueSource}
    `);
    w.deleteQueueItem(0);
    check(h.apiCalls.length === 0, 'backend-managed row without id stays locked (no delete forwarded)');
    check(w.state.nextQueue.length === 1, 'backend-managed row without id is not removed locally');
  }

  // ---- 4. focusQueueItem enters edit mode for backend-managed rows with id ----
  {
    const h = makeHarness();
    h.state.nextQueue = ['hello from mobile'];
    h.state.nextQueueRequests = [{ backendManaged: true, provenance: 'backend-follow-up', text: 'hello from mobile' }];
    h.state.queueItemsByTarget['ws1::conv1'] = [{ id: 'mobile-1', text: 'hello from mobile' }];
    const w = await h.run(`
      ${queueItemsForTargetSource}
      ${setQueueItemsForTargetSource}
      ${queueItemIdForTextSource}
      ${focusQueueSource}
    `);
    w.focusQueueItem(0);
    check(w.state._editingQueueIndex === 0, 'focusQueueItem enters edit mode for backend-managed row with id');
    check(w.state.pendingInputEdit && w.state.pendingInputEdit.kind === 'queue', 'pendingInputEdit records the queue edit');
    check(w.state.pendingInputEdit.originalText === 'hello from mobile', 'pendingInputEdit preserves original text for id lookup');
  }

  // ---- 5. guideQueueItem forwards queue_guide for backend-managed rows ----
  {
    const h = makeHarness();
    h.state.nextQueue = ['hello from mobile'];
    h.state.nextQueueRequests = [{ backendManaged: true, provenance: 'backend-follow-up', text: 'hello from mobile' }];
    h.state.queueItemsByTarget['ws1::conv1'] = [{ id: 'mobile-1', text: 'hello from mobile' }];
    const w = await h.run(`
      ${queueItemsForTargetSource}
      ${setQueueItemsForTargetSource}
      ${queueItemIdForTextSource}
      ${guideQueueSource}
    `);
    await w.guideQueueItem(0);
    check(h.apiCalls.length === 1, 'backend-managed guide forwards exactly one queue_guide');
    check(h.apiCalls[0].action === 'queue_guide', 'guide action is queue_guide');
    check(h.apiCalls[0].input.id === 'mobile-1', 'guide forwards the kernel queue item id');
    check(w.state.nextQueue.length === 0, 'guide removes the local row');
  }

  // ---- 6. drop reorder forwards queue_reorder with the full ordered id list ----
  {
    const h = makeHarness();
    h.state.nextQueue = ['item-a', 'item-b', 'item-c'];
    h.state.nextQueueRequests = [
      { backendManaged: true, provenance: 'backend-follow-up', text: 'item-a' },
      { backendManaged: true, provenance: 'backend-follow-up', text: 'item-b' },
      { backendManaged: false, text: 'item-c' },
    ];
    h.state.queueItemsByTarget['ws1::conv1'] = [
      { id: 'mobile-a', text: 'item-a' },
      { id: 'mobile-b', text: 'item-b' },
    ];
    h.state.queueDragIndex = 0;
    const w = await h.run(`
      ${queueItemsForTargetSource}
      ${setQueueItemsForTargetSource}
      ${queueItemIdForTextSource}
      ${startDragSource}
      ${dropDragSource}
    `);
    w.startQueueDrag({ dataTransfer: { effectAllowed: '' } }, 0);
    w.dropQueueDrag({ preventDefault: () => {}, dataTransfer: { dropEffect: '' } }, 1);
    check(h.apiCalls.length === 1, 'drop involving backend-managed rows forwards queue_reorder');
    check(h.apiCalls[0].action === 'queue_reorder', 'reorder action is queue_reorder');
    const ordered = h.apiCalls[0].input.orderedIds;
    check(Array.isArray(ordered) && ordered.includes('mobile-a') && ordered.includes('mobile-b'),
      'reorder forwards the complete ordered kernel id list');
    check(w.state.nextQueue[1] === 'item-a', 'local queue reflects the drag reorder');
  }

  // ---- 7. local (non-backend) rows keep the legacy local path (no API call) ----
  {
    const h = makeHarness();
    h.state.nextQueue = ['local item'];
    h.state.nextQueueRequests = [{ backendManaged: false, text: 'local item' }];
    h.state.queueItemsByTarget['ws1::conv1'] = [];
    const w = await h.run(`
      ${queueItemsForTargetSource}
      ${setQueueItemsForTargetSource}
      ${queueItemIdForTextSource}
      ${deleteQueueSource}
    `);
    w.deleteQueueItem(0);
    check(h.apiCalls.length === 0, 'local queue delete stays local (no API forward)');
    check(w.state.nextQueue.length === 0, 'local queue delete removes the row');
  }

  console.log(JSON.stringify({ ok: true }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});