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
  if (!found) throw new Error(`UI function not found: ${name}`);
  return found;
}

function assignedFunctionSource(source: string, name: string): string {
  const file = ts.createSourceFile('newmark-ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = '';
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.left.getText(file) === `window.${name}`
      && (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))) {
      found = node.right.getText(file);
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`UI assignment was not found: window.${name}`);
  return found;
}

function verifyPersistedWorkRunsCannotRewriteRuntimeIdentity(source: string): void {
  const helpers = [
    'runtimeWorkspaceId',
    'runtimeBaseKey',
    'runtimeKeyFor',
    'registerRuntimeKey',
    'syncGuideMessagesFromWorkRuns',
    'eventRuntimeKey',
    'publicWorkEvent',
    'publicToolNameForUi',
    'publicWorkEventForUi',
    'normalizedWorkRun',
    'workRunsForTarget',
    'syncWorkRunsSnapshot',
  ].map(name => functionSource(source, name)).join('\n\n');
  const targetA = { workspaceId: 'workspace-a', conversationId: 'default' };
  const targetB = { workspaceId: 'workspace-b', conversationId: 'default' };
  const targetC = { workspaceId: 'workspace-c', conversationId: 'default' };
  const runtimeA = 'workspace:trusted-a::conversation:default';
  const runtimeB = 'workspace:trusted-b::conversation:default';
  const runtimeC = 'workspace:trusted-c::conversation:default';
  const state: Record<string, any> = {
    currentWorkspaceId: targetA.workspaceId,
    runtimeKeyAliases: {},
    runningConversations: {},
    conversationRuntimeStates: {},
    agentWorkEventsByConversation: {},
    agentWorkUiByConversation: {},
    workRunsByTarget: {},
    guideMessagesByTarget: {},
    trackedConversationUntil: {},
    backendQueuesByTarget: {
      [`${targetA.workspaceId}::${targetA.conversationId}`]: { steering: [], followUp: ['queue-a'] },
      [`${targetB.workspaceId}::${targetB.conversationId}`]: { steering: [], followUp: ['queue-b'] },
    },
  };
  const guideTargets: Array<{ workspaceId: string; conversationId: string }> = [];
  const windowObject: Record<string, any> = {};
  const install = new Function('window', 'state', 'currentConversationTarget', 'recordGuideUiMessage', `
    ${helpers}
    window.runtimeKeyFor = runtimeKeyFor;
    window.registerRuntimeKey = registerRuntimeKey;
    window.eventRuntimeKey = eventRuntimeKey;
    window.syncWorkRunsSnapshot = syncWorkRunsSnapshot;
  `);
  install(
    windowObject,
    state,
    () => ({ ...targetA }),
    (_input: Record<string, any>, target: typeof targetA) => { guideTargets.push({ ...target }); },
  );

  windowObject.registerRuntimeKey(targetA, runtimeA);
  windowObject.registerRuntimeKey(targetB, runtimeB);
  assert.deepEqual(state.backendQueuesByTarget[runtimeA].followUp, ['queue-a']);
  assert.deepEqual(state.backendQueuesByTarget[runtimeB].followUp, ['queue-b']);

  const normalized = windowObject.syncWorkRunsSnapshot([{
    runId: 'persisted-a-run',
    runtimeKey: runtimeB,
    target: targetB,
    status: 'completed',
    guides: [{ clientMessageId: 'guide-from-run', target: targetB, status: 'applied', content: 'guide' }],
    events: [{
      id: 'guide-event-from-run',
      type: 'guide_applied',
      workspaceId: targetB.workspaceId,
      conversationId: targetB.conversationId,
      runtimeKey: runtimeB,
      target: targetB,
      guide: { clientMessageId: 'guide-from-event', target: targetB, status: 'applied', content: 'event guide' },
    }],
  }], targetA);

  assert.equal(state.runtimeKeyAliases[`${targetA.workspaceId}::${targetA.conversationId}`], runtimeA,
    'a persisted workRun runtimeKey cannot rewrite its trusted outer target alias');
  assert.equal(state.runtimeKeyAliases[`${targetB.workspaceId}::${targetB.conversationId}`], runtimeB,
    'the other workspace keeps its own runtime alias');
  assert.deepEqual(state.backendQueuesByTarget[runtimeA].followUp, ['queue-a'],
    'workspace A backend queue survives a forged nested workRun runtimeKey');
  assert.deepEqual(state.backendQueuesByTarget[runtimeB].followUp, ['queue-b'],
    'workspace B backend queue remains isolated from workspace A workRuns');
  assert.deepEqual(guideTargets, [targetA, targetA],
    'persisted Guide receipts and Guide events are rebound to the trusted outer snapshot target');
  assert.deepEqual(normalized[0].target, targetA, 'the normalized workRun belongs to the trusted outer snapshot target');
  assert.equal(normalized[0].events[0].workspaceId, targetA.workspaceId);
  assert.equal(normalized[0].events[0].conversationId, targetA.conversationId);
  assert.deepEqual(normalized[0].events[0].target, targetA,
    'a persisted workRun event cannot retain a foreign nested target');
  assert.equal(normalized[0].events[0].runtimeKey, runtimeA,
    'a persisted workRun event is labeled with the already-trusted outer runtime alias');
  assert.deepEqual(normalized[0].events[0].guide.target, targetA,
    'nested Guide metadata on a workRun event is rebound to the outer target');

  assert.equal(windowObject.eventRuntimeKey({ ...targetC, runtimeKey: runtimeC }), runtimeC,
    'a normal top-level runtime event still registers its runtimeKey alias');
  assert.equal(state.runtimeKeyAliases[`${targetC.workspaceId}::${targetC.conversationId}`], runtimeC);
  assert.match(source, /r\s*&&\s*r\.runtimeKey\)\s*registerRuntimeKey\(lockedTarget,\s*r\.runtimeKey\)/,
    'a normal top-level send response explicitly registers its runtimeKey before nested workRuns are consumed');
}

async function verifyRunningQueuedGuideDelivery(source: string): Promise<void> {
  const helpers = [
    'normalizeQueuedConversationTarget',
    'bindQueuedRequestToTarget',
    'queuedRequestIsBackendManaged',
    'queuedRequestMatchesTarget',
    'queueIndexesForTarget',
    'refreshNextPromptForTarget',
    'queueHiddenItemKey',
  ].map(name => functionSource(source, name)).join('\n\n');
  const normalizeAttachmentsSource = functionSource(source, 'normalizeConversationImageAttachments');
  const restoreQueueSource = functionSource(source, 'restoreQueueItemAfterGuideFailure');
  const sendMessageSource = assignedFunctionSource(source, 'sendMessage');
  const guideQueueSource = assignedFunctionSource(source, 'guideQueueItem');
  const target = { workspaceId: 'workspace-running-guide', conversationId: 'default' };
  const image = {
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=',
    name: 'running-guide.png',
    type: 'image/png',
  };
  const state: Record<string, any> = {
    inputMode: 'next',
    model: 'fixture-model',
    mode: 'build',
    conversationTrackMs: 300_000,
    nextQueue: ['Inspect the queued image\n\n[1 image attachment]'],
    nextQueueRequests: [],
    queueHiddenItems: {},
    promptAttachments: [{ id: 'draft-image', dataUrl: image.dataUrl, name: 'draft.png', type: 'image/png' }],
  };
  const apiCalls: Array<Record<string, any>> = [];
  const guideRecords: Array<Record<string, any>> = [];
  let rejectGuide = false;
  let transportFailure = false;
  let emptyReceipt = false;
  let activeRuntimePresent = true;
  const api = {
    enqueueGuide: (envelope: Record<string, any>) => {
      apiCalls.push(envelope);
      if (transportFailure) return Promise.reject(new Error('transport timeout'));
      if (emptyReceipt) return Promise.resolve(undefined);
      return Promise.resolve({
        clientMessageId: envelope.clientMessageId,
        target: envelope.target,
        runId: envelope.runId,
        status: rejectGuide ? 'rejected' : 'accepted',
        content: envelope.text,
        createdAt: envelope.createdAt,
        updatedAt: envelope.createdAt,
      });
    },
  };
  let promptAttachmentClears = 0;
  let clientMessageSequence = 0;
  const els = { prompt: { value: 'unfinished draft' } };
  const windowObject: Record<string, any> = {
    crypto: { randomUUID: () => `queued-guide-client-${++clientMessageSequence}` },
    requireWorkspace: () => true,
    renderInputStack: () => undefined,
  };
  const install = new Function(
    'window', 'state', 'api', 'els', 'currentConversationTarget', 'runtimeKeyFor',
    'isCurrentConversationRunning', 'activeConversationId', 'runningConversationRecord',
    'markConversationTracked', 'composePromptTextForSend', 'clearPromptAttachments',
    'updateSubmitButtonState', 'recordGuideUiMessage', 'addMsg', 'normalizeGuideUiStatus',
    'applyAgentWorkEventToRun', 'showUiNotice', 'currentLang',
    `${helpers}\n${normalizeAttachmentsSource}\n${restoreQueueSource}\nwindow.bindQueuedRequestToTarget = bindQueuedRequestToTarget;\nwindow.sendMessage = ${sendMessageSource};\nwindow.guideQueueItem = ${guideQueueSource};`,
  );
  install(
    windowObject,
    state,
    api,
    els,
    () => ({ ...target }),
    (workspaceId: string, conversationId: string) => `${workspaceId}::${conversationId}`,
    () => true,
    () => target.conversationId,
    () => activeRuntimePresent ? ({ runId: 'run-running-guide', provisional: false }) : undefined,
    () => undefined,
    (text: string) => text,
    () => { promptAttachmentClears += 1; state.promptAttachments = []; },
    () => undefined,
    (input: Record<string, any>) => { guideRecords.push(input); return input; },
    () => undefined,
    (value: unknown) => String(value || 'accepted'),
    () => undefined,
    () => undefined,
    () => 'en',
  );
  state.nextQueueRequests.push(windowObject.bindQueuedRequestToTarget({ text: 'Inspect the queued image', images: [image] }, 'Inspect the queued image', target));

  await windowObject.guideQueueItem(0);

  assert.equal(apiCalls.length, 1, 'running Queue -> Guide invokes the immediate Guide IPC exactly once');
  assert.deepEqual(apiCalls[0].target, target, 'running Queue -> Guide preserves its composite conversation target');
  assert.equal(apiCalls[0].runId, 'run-running-guide', 'running Queue -> Guide binds the active run');
  assert.equal(apiCalls[0].deliveryMode, 'steer');
  assert.equal(apiCalls[0].text, 'Inspect the queued image', 'the display-only attachment marker is not sent to the Agent');
  assert.deepEqual(apiCalls[0].images, [image], 'running Queue -> Guide preserves the structured image payload');
  assert.deepEqual(state.nextQueue, [], 'an immediately delivered local Next leaves the renderer queue');
  assert.deepEqual(state.nextQueueRequests, [], 'the delivered structured queue record is removed atomically');
  assert.equal(els.prompt.value, 'unfinished draft', 'delivering a queued Guide does not erase the unrelated prompt draft');
  assert.equal(promptAttachmentClears, 0, 'delivering queued images does not clear unrelated draft attachments');
  assert.equal(state.promptAttachments.length, 1);

  rejectGuide = true;
  state.nextQueue = ['Retain rejected guidance'];
  state.nextQueueRequests = [windowObject.bindQueuedRequestToTarget({ text: 'Retain rejected guidance', images: [] }, 'Retain rejected guidance', target)];
  const rejected = await windowObject.guideQueueItem(0);
  assert.equal(rejected.ok, false, 'a rejected direct Guide reports failure to the queue action');
  assert.deepEqual(state.nextQueue, ['Retain rejected guidance'], 'a rejected direct Guide is restored instead of silently losing the queued instruction');
  assert.equal(state.nextQueueRequests.length, 1, 'the target-bound structured request is restored with its text');
  assert.deepEqual(state.nextQueueRequests[0].target, target, 'restoration keeps the original composite conversation target');
  const rejectedClientMessageId = apiCalls[1].clientMessageId;
  rejectGuide = false;
  await windowObject.guideQueueItem(0);
  assert.notEqual(apiCalls[2].clientMessageId, rejectedClientMessageId, 'retrying an explicitly rejected Guide uses a fresh idempotency key instead of replaying a cached rejection');
  assert.equal(guideRecords.some(record => record.clientMessageId === apiCalls[2].clientMessageId && record.allowStatusReset === true), false, 'a new-id retry does not rewrite the explicitly rejected audit row');
  assert.deepEqual(state.nextQueue, [], 'the accepted retry finally removes the restored queue item');

  transportFailure = true;
  state.nextQueue = ['Retain uncertain guidance'];
  state.nextQueueRequests = [windowObject.bindQueuedRequestToTarget({ text: 'Retain uncertain guidance', images: [] }, 'Retain uncertain guidance', target)];
  const uncertain = await windowObject.guideQueueItem(0);
  assert.equal(uncertain.ok, false, 'a transport failure is surfaced to the queue action');
  assert.deepEqual(state.nextQueue, ['Retain uncertain guidance'], 'a Guide with an uncertain delivery outcome is restored');
  const uncertainClientMessageId = apiCalls[3].clientMessageId;
  transportFailure = false;
  await windowObject.guideQueueItem(0);
  assert.equal(apiCalls[4].clientMessageId, uncertainClientMessageId, 'retrying after a lost receipt reuses the idempotency key to prevent duplicate delivery');
  assert.equal(guideRecords.some(record => record.clientMessageId === uncertainClientMessageId && record.allowStatusReset === true), true, 'an uncertain same-id retry resets the optimistic UI state on the existing Guide row');
  assert.deepEqual(state.nextQueue, [], 'the accepted retry removes the transport-restored queue item');

  emptyReceipt = true;
  state.nextQueue = ['Retain unacknowledged guidance'];
  state.nextQueueRequests = [windowObject.bindQueuedRequestToTarget({ text: 'Retain unacknowledged guidance', images: [] }, 'Retain unacknowledged guidance', target)];
  const unacknowledged = await windowObject.guideQueueItem(0);
  assert.equal(unacknowledged.ok, false, 'an empty Guide receipt is treated as an uncertain failure');
  assert.deepEqual(state.nextQueue, ['Retain unacknowledged guidance'], 'an unacknowledged Guide is restored instead of being dropped');
  const unacknowledgedClientMessageId = apiCalls[5].clientMessageId;
  emptyReceipt = false;
  await windowObject.guideQueueItem(0);
  assert.equal(apiCalls[6].clientMessageId, unacknowledgedClientMessageId, 'retrying an unacknowledged Guide retains its idempotency key');
  assert.deepEqual(state.nextQueue, [], 'the acknowledged retry removes the restored queue item');

  activeRuntimePresent = false;
  state.nextQueue = ['Retain guidance after run end'];
  state.nextQueueRequests = [windowObject.bindQueuedRequestToTarget({ text: 'Retain guidance after run end', images: [] }, 'Retain guidance after run end', target)];
  const settledRun = await windowObject.guideQueueItem(0);
  assert.equal(settledRun.ok, false, 'a Guide is rejected locally if its active run ended between click and delivery');
  assert.equal(apiCalls.length, 7, 'the settled-run race never reaches Guide IPC or starts a replacement turn');
  assert.deepEqual(state.nextQueue, ['Retain guidance after run end'], 'the Guide is restored when its target run has already ended');
}

async function main(): Promise<void> {
  const source = uiScriptSource();
  const addMsgSource = functionSource(source, 'addMsg');
  const recordGuideSource = functionSource(source, 'recordGuideUiMessage');
  assert.ok(addMsgSource.includes('findGuideMessageElement(guideMessageId)')
    && addMsgSource.includes('return existingGuide')
    && recordGuideSource.includes('allowStatusReset'),
  'same-id Guide retries reuse one rendered row and can reset an uncertain local status');
  assert.ok(source.includes("'queue.guideAction': 'Guide'")
    && source.includes("'queue.guideAction': '引导'")
    && source.includes('class="stack-icon-btn queue-guide-btn"')
    && source.includes("iconSvg('corner-down-right', t('queue.guideNow'), 'tiny')")
    && source.includes("<span>' + esc(t('queue.guideAction')) + '</span>"),
  'each editable queued message exposes a visible localized Guide action instead of an icon-only affordance');
  verifyPersistedWorkRunsCannotRewriteRuntimeIdentity(source);
  const helpers = [
    'normalizeQueueItemText',
    'normalizeQueuedConversationTarget',
    'bindQueuedRequestToTarget',
    'bindBackendQueuedRequestToTarget',
    'queuedRequestIsBackendManaged',
    'queuedRequestMatchesTarget',
    'queueIndexesForTarget',
    'refreshNextPromptForTarget',
    'queueHiddenItemKey',
    'normalizeBackendQueue',
    'backendQueueForTarget',
    'setBackendQueueForTarget',
  ].map(name => functionSource(source, name)).join('\n\n');
  const drainSource = assignedFunctionSource(source, 'drainNextQueue');
  const syncSource = assignedFunctionSource(source, 'syncNextQueueFromBackend');
  const dropSource = assignedFunctionSource(source, 'dropQueueDrag');
  const editSource = assignedFunctionSource(source, 'editQueueItem');
  const deleteSource = assignedFunctionSource(source, 'deleteQueueItem');
  const guideSource = assignedFunctionSource(source, 'guideQueueItem');
  const startDragSource = assignedFunctionSource(source, 'startQueueDrag');
  const sent: Array<Record<string, any>> = [];
  const scheduled: Array<() => void> = [];
  const targetA = { workspaceId: 'workspace-a', conversationId: 'default' };
  const targetB = { workspaceId: 'workspace-b', conversationId: 'default' };
  let activeTarget = targetA;
  let running = false;
  const state: Record<string, any> = {
    nextQueue: [],
    nextQueueRequests: [],
    nextQueueDrainsByTarget: {},
    nextPrompt: '',
    backendQueue: { steering: [], followUp: [] },
    backendQueuesByTarget: {},
    queueHiddenItems: {},
  };
  const windowObject: Record<string, any> = {
    renderInputStack: () => undefined,
    sendMessage: (mode: string, text: string, options: Record<string, any>) => {
      sent.push({ mode, text, request: options.queuedRequest, activeTarget: { ...activeTarget }, options: { ...options } });
      running = true;
    },
  };
  const install = new Function('window', 'state', 'currentConversationTarget', 'runtimeKeyFor', 'isCurrentConversationRunning', 'setTimeout', `
    ${helpers}
    window.bindQueuedRequestToTarget = bindQueuedRequestToTarget;
    window.queueIndexesForTarget = queueIndexesForTarget;
    window.setBackendQueueForTarget = setBackendQueueForTarget;
    window.backendQueueForTarget = backendQueueForTarget;
    window.syncNextQueueFromBackend = ${syncSource};
    window.drainNextQueue = ${drainSource};
    window.dropQueueDrag = ${dropSource};
    window.editQueueItem = ${editSource};
    window.deleteQueueItem = ${deleteSource};
    window.guideQueueItem = ${guideSource};
    window.startQueueDrag = ${startDragSource};
  `);
  install(
    windowObject,
    state,
    () => ({ ...activeTarget }),
    (workspaceId: string, conversationId: string) => `${workspaceId}::${conversationId}`,
    () => running,
    (callback: () => void) => { scheduled.push(callback); return scheduled.length; },
  );

  activeTarget = targetB;
  const backendA = windowObject.setBackendQueueForTarget({ followUp: ['stale A'] }, targetA);
  windowObject.syncNextQueueFromBackend(backendA, targetA);
  assert.deepEqual(windowObject.queueIndexesForTarget(targetB), [], 'an inactive A backend snapshot cannot bind its follow-up to active workspace B');
  const backendB = windowObject.setBackendQueueForTarget({ followUp: ['fresh B'] }, targetB);
  windowObject.syncNextQueueFromBackend(backendB, targetB);
  assert.equal(windowObject.queueIndexesForTarget(targetA).length, 1, 'workspace A keeps its own cached backend queue');
  assert.equal(windowObject.queueIndexesForTarget(targetB).length, 1, 'workspace B receives only its explicitly targeted backend queue');
  assert.deepEqual(windowObject.backendQueueForTarget(targetA).followUp, ['stale A'], 'same conversation IDs in different workspaces use separate backend queue caches');
  const backendBIndex = windowObject.queueIndexesForTarget(targetB)[0];
  const backendBRequest = state.nextQueueRequests[backendBIndex];
  assert.equal(backendBRequest.backendManaged, true, 'a backend queue mirror has explicit backend-managed provenance');
  assert.equal(backendBRequest.provenance, 'backend-follow-up', 'a backend queue mirror records its backend follow-up origin');

  windowObject.drainNextQueue();
  assert.equal(scheduled.length, 0, 'a backend-managed mirror is display-only and cannot be drained into a second turn');
  windowObject.editQueueItem(backendBIndex, 'mutated B');
  windowObject.deleteQueueItem(backendBIndex);
  windowObject.guideQueueItem(backendBIndex);
  state.queueDragIndex = -1;
  windowObject.startQueueDrag({ currentTarget: null }, backendBIndex);
  assert.equal(state.queueDragIndex, -1, 'a backend-managed mirror cannot begin a drag transaction');
  assert.equal(state.nextQueue[backendBIndex], 'fresh B', 'backend-managed mirrors reject edit, delete, and Guide actions');
  assert.equal(sent.length, 0, 'read-only mirror actions never invoke sendMessage');

  const localDuplicate = windowObject.bindQueuedRequestToTarget({ text: 'duplicate', images: [] }, 'duplicate', targetA);
  state.nextQueue.push('duplicate');
  state.nextQueueRequests.push(localDuplicate);
  const duplicateSnapshot = windowObject.setBackendQueueForTarget({ followUp: ['duplicate', 'duplicate'] }, targetA);
  windowObject.syncNextQueueFromBackend(duplicateSnapshot, targetA);
  const duplicateAIndexes = windowObject.queueIndexesForTarget(targetA);
  assert.equal(duplicateAIndexes.length, 3, 'one local Next plus two same-text backend entries remain three distinct requests');
  assert.equal(duplicateAIndexes.filter((index: number) => state.nextQueueRequests[index].backendManaged === true).length, 2,
    'backend queue reconciliation preserves the snapshot multiplicity for identical text');
  assert.equal(new Set(duplicateAIndexes.map((index: number) => state.nextQueueRequests[index])).size, 3,
    'same-text backend mirrors use distinct records instead of collapsing by text');

  const emptyA = windowObject.setBackendQueueForTarget({ followUp: [] }, targetA);
  windowObject.syncNextQueueFromBackend(emptyA, targetA);
  assert.deepEqual(windowObject.queueIndexesForTarget(targetA).map((index: number) => state.nextQueue[index]), ['duplicate'],
    'an empty backend snapshot removes all target mirrors while retaining the local Next');
  assert.equal(windowObject.queueIndexesForTarget(targetB).length, 1, 'clearing workspace A backend mirrors leaves workspace B untouched');
  const emptyB = windowObject.setBackendQueueForTarget({ followUp: [] }, targetB);
  windowObject.syncNextQueueFromBackend(emptyB, targetB);
  assert.equal(windowObject.queueIndexesForTarget(targetB).length, 0, 'a consumed backend follow-up disappears from the renderer mirror');

  activeTarget = targetA;
  windowObject.drainNextQueue();
  assert.equal(scheduled.length, 1, 'the retained local Next remains executable after backend mirror reconciliation');
  scheduled.shift()!();
  assert.equal(sent.length, 1, 'only the local Next is sent after the backend has consumed its own follow-up');
  assert.equal(sent[0].text, 'duplicate');
  running = false;
  windowObject.drainNextQueue();
  assert.equal(scheduled.length, 0, 'the consumed backend mirror cannot be resurrected and resent');

  state.nextQueue = [];
  state.nextQueueRequests = [];
  sent.length = 0;

  const image = {
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=',
    name: 'guide.png',
    type: 'image/png',
  };
  const requestA = windowObject.bindQueuedRequestToTarget({ text: '', images: [image] }, '', targetA);
  const secondRequestA = windowObject.bindQueuedRequestToTarget({ text: 'second', images: [] }, 'second', targetA);
  state.nextQueue.push('[1 image attachment]');
  state.nextQueueRequests.push(requestA);
  state.nextQueue.push('second');
  state.nextQueueRequests.push(secondRequestA);

  activeTarget = targetB;
  windowObject.drainNextQueue();
  assert.equal(sent.length, 0, 'a queued image from conversation A is never sent while conversation B is active');
  assert.equal(state.nextQueue.length, 2, 'conversation A queue remains intact while B is active');
  assert.deepEqual(windowObject.queueIndexesForTarget(targetB), [], 'conversation B cannot see A queue entries');

  activeTarget = targetA;
  windowObject.drainNextQueue();
  windowObject.drainNextQueue();
  assert.equal(scheduled.length, 1, 'repeated drains schedule only one transaction for a target');
  running = true;
  scheduled.shift()!();
  assert.equal(state.nextQueue.length, 2, 'becoming busy during the delay leaves both queued entries untouched');
  assert.equal(sent.length, 0, 'a delayed drain never calls sendMessage after the target becomes busy');

  running = false;
  windowObject.drainNextQueue();
  windowObject.drainNextQueue();
  assert.equal(scheduled.length, 1, 'retrying an idle target still schedules a single transaction');
  scheduled.shift()!();
  assert.equal(sent.length, 1, 'returning to conversation A drains its queued image exactly once');
  assert.equal(sent[0].request.target.workspaceId, 'workspace-a', 'the queued request remains bound to its original workspace');
  assert.equal(sent[0].request.target.conversationId, 'default', 'the queued request remains bound to its original conversation');
  assert.equal(sent[0].request.images.length, 1, 'the structured user image survives the target-bound queue');
  assert.equal(state.nextQueue.length, 1, 'only the delivered queue entry is removed');

  running = false;
  windowObject.drainNextQueue();
  windowObject.drainNextQueue();
  assert.equal(scheduled.length, 1, 'two immediate drain calls cannot pop two messages before the first send starts');
  activeTarget = targetB;
  scheduled.shift()!();
  assert.equal(sent.length, 1, 'switching workspaces during the delay does not send the original target message into B');
  assert.equal(state.nextQueue.length, 1, 'switching workspaces during the delay keeps the pending item for A');

  activeTarget = targetA;
  windowObject.drainNextQueue();
  assert.equal(scheduled.length, 1, 'the preserved item can be retried after returning to A');
  scheduled.shift()!();
  assert.equal(sent.length, 2, 'the second A item is eventually sent exactly once');
  assert.equal(sent[1].text, 'second');
  assert.equal(state.nextQueue.length, 0, 'all delivered queue entries are removed once');
  running = false;
  windowObject.drainNextQueue();
  assert.equal(scheduled.length, 0, 'an empty queue cannot schedule another delivery');
  assert.equal(sent.length, 2, 'a drained target-bound request cannot be applied twice');

  const firstA = windowObject.bindQueuedRequestToTarget({ text: 'A first', images: [image] }, 'A first', targetA);
  const onlyB = windowObject.bindQueuedRequestToTarget({ text: 'B only', images: [] }, 'B only', targetB);
  const secondA = windowObject.bindQueuedRequestToTarget({ text: 'A second', images: [] }, 'A second', targetA);
  state.nextQueue = ['A first', 'B only', 'A second'];
  state.nextQueueRequests = [firstA, onlyB, secondA];
  state.queueDragIndex = 0;
  activeTarget = targetA;
  windowObject.dropQueueDrag({ preventDefault: () => undefined }, 2);
  assert.deepEqual(state.nextQueue, ['B only', 'A second', 'A first'],
    'dragging across an interleaved absolute index reorders only the visible A sequence');
  assert.equal(state.nextQueueRequests[0], onlyB, 'the hidden workspace B request remains paired with its text');
  assert.equal(state.nextQueueRequests[1], secondA, 'the A destination request keeps its structured payload');
  assert.equal(state.nextQueueRequests[2], firstA, 'the moved A image request keeps its structured payload');
  assert.deepEqual(windowObject.queueIndexesForTarget(targetA), [1, 2], 'A visible indexes are recomputed after the absolute-index move');
  assert.deepEqual(windowObject.queueIndexesForTarget(targetB), [0], 'B retains one untouched visible index after the A drag');

  const idleGuideRequest = windowObject.bindQueuedRequestToTarget({ text: 'idle build', images: [] }, 'idle build', targetA);
  state.nextQueue = ['idle build'];
  state.nextQueueRequests = [idleGuideRequest];
  sent.length = 0;
  activeTarget = targetA;
  running = false;
  windowObject.guideQueueItem(0);
  assert.equal(sent.length, 1, 'an idle local Next still starts exactly one immediate Build request');
  assert.equal(sent[0].mode, 'guide');
  assert.equal(sent[0].options.fromQueue, true);
  assert.equal(sent[0].options.forceBuild, true, 'idle Queue -> Guide preserves the existing force-Build behavior');
  assert.equal(sent[0].options.deliverAsGuide, false, 'idle Queue -> Guide does not pretend an Agent run exists');
  assert.deepEqual(state.nextQueue, []);
  assert.deepEqual(state.nextQueueRequests, []);

  await verifyRunningQueuedGuideDelivery(source);

  console.log('Queue attachment isolation verification passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
