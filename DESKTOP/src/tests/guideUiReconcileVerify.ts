import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

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

function createFixture(): {
  document: Document;
  state: Record<string, any>;
  targetA: { workspaceId: string; conversationId: string };
  targetB: { workspaceId: string; conversationId: string };
  setActiveTarget(target: { workspaceId: string; conversationId: string }): void;
  recordGuideUiMessage(input: Record<string, unknown>, target?: Record<string, unknown>): Record<string, unknown> | null;
  syncGuideMessagesFromWorkRuns(runs: unknown[], target?: Record<string, unknown>): void;
  renderChatMessages(messages: unknown[]): void;
  guideMessagesForTarget(target?: Record<string, unknown>): Record<string, Record<string, unknown>>;
  dedupeGuideWorkEvents(events: unknown[]): unknown[];
  close(): void;
} {
  const source = uiScriptSource();
  const names = [
    'normalizeConversationImageAttachments',
    'appendConversationImageAttachments',
    'normalizeGuideUiStatus',
    'guideUiStatusLabel',
    'guideMessagesForTarget',
    'findGuideMessageElement',
    'applyGuideMessageMeta',
    'recordGuideUiMessage',
    'guideWorkEventKey',
    'guideWorkEventStatus',
    'mergeGuideWorkEvent',
    'dedupeGuideWorkEvents',
    'syncGuideMessagesFromWorkRuns',
    'renderPendingGuideMessages',
    'addMsg',
    'renderChatMessages',
  ];
  const extracted = names.map(name => functionSource(source, name)).join('\n\n');
  const dom = new JSDOM('<!doctype html><html><body><div id="chat-area"></div></body></html>');
  const factory = new Function('window', 'document', `
    var targetA = { workspaceId: 'workspace-a', conversationId: 'default' };
    var targetB = { workspaceId: 'workspace-b', conversationId: 'default' };
    var activeTarget = targetA;
    var state = { model: 'fixture-model', guideMessagesByTarget: {}, workRunsByTarget: {} };
    var els = { 'chat-area': document.getElementById('chat-area') };
    var workUi = { pendingWorkReview: null };
    function runtimeWorkspaceId(value) { return String(value || activeTarget.workspaceId); }
    function runtimeKeyFor(workspaceId, conversationId) { return runtimeWorkspaceId(workspaceId) + '::' + String(conversationId || 'default'); }
    function currentConversationTarget() { return { workspaceId: activeTarget.workspaceId, conversationId: activeTarget.conversationId }; }
    function activeConversationId() { return activeTarget.conversationId; }
    function isActiveConversationTarget(target) { return runtimeKeyFor(target.workspaceId, target.conversationId) === runtimeKeyFor(activeTarget.workspaceId, activeTarget.conversationId); }
    function currentLang() { return 'en'; }
    function uiLocale() { return 'en-US'; }
    function t(value) { return value; }
    function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function redactSensitiveText(value) { return String(value || ''); }
    function renderMessageContent(value) { return '<span>' + esc(value) + '</span>'; }
    function messageActionsHtml() { return ''; }
    function workRunsForTarget() { return state.workRunsByTarget[runtimeKeyFor(activeTarget.workspaceId, activeTarget.conversationId)] || []; }
    function conversationWorkUiState() { return workUi; }
    function resetConversationWorkUi() {}
    function isHiddenWorkflowMessage() { return false; }
    function renderPersistedToolMessage() {}
    function finishToolBatch() {}
    function autoScrollIfAtBottom() {}
    function findWorkRunElement(run) { return document.querySelector('[data-test-run-id="' + String(run && run.runId || '') + '"]'); }
    function renderConversationWorkRun(run) {
      var row = document.createElement('div');
      row.className = 'chat-msg assistant work-run-message';
      row.setAttribute('data-test-run-id', String(run && run.runId || ''));
      row.textContent = 'Build ' + String(run && run.runId || '');
      els['chat-area'].appendChild(row);
    }
    function addWorkReview() {}
    function renderAutoRouteRatingControls() {}
    ${extracted}
    return {
      document: document,
      state: state,
      targetA: targetA,
      targetB: targetB,
      setActiveTarget: function(target) { activeTarget = target; },
      recordGuideUiMessage: recordGuideUiMessage,
      syncGuideMessagesFromWorkRuns: syncGuideMessagesFromWorkRuns,
      renderChatMessages: renderChatMessages,
      guideMessagesForTarget: guideMessagesForTarget
      ,dedupeGuideWorkEvents: dedupeGuideWorkEvents
    };
  `);
  const fixture = factory(dom.window, dom.window.document) as ReturnType<typeof createFixture>;
  return { ...fixture, close: () => dom.window.close() };
}

function guideRows(document: Document, clientMessageId: string): Element[] {
  return Array.from(document.querySelectorAll('.chat-msg[data-client-message-id]')).filter(node =>
    node.getAttribute('data-client-message-id') === clientMessageId);
}

function main(): void {
  const fixture = createFixture();
  try {
    const acceptedId = 'guide-accepted';
    const durableAttachment = {
      id: 'user-image-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      origin: 'user',
      name: 'guide-image.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=',
      width: 1,
      height: 1,
    };
    fixture.recordGuideUiMessage({
      clientMessageId: acceptedId,
      target: fixture.targetA,
      runId: 'run-a',
      status: 'accepted',
      content: 'keep me through redraw',
      attachments: [durableAttachment],
      createdAt: '2026-07-13T00:00:00.000Z',
    }, fixture.targetA);
    fixture.renderChatMessages([]);
    assert.equal(guideRows(fixture.document, acceptedId).length, 1, 'accepted optimistic Guide is rendered once');
    assert.equal(guideRows(fixture.document, acceptedId)[0].getAttribute('data-guide-status'), 'accepted');
    assert.equal(guideRows(fixture.document, acceptedId)[0].querySelectorAll('.conversation-image-attachment').length, 1,
      'accepted Guide attachment is revisitable before message_start persists the chat row');

    fixture.syncGuideMessagesFromWorkRuns([{
      runId: 'run-a',
      target: fixture.targetA,
      guides: [{
        clientMessageId: acceptedId,
        target: fixture.targetA,
        runId: 'run-a',
        status: 'deferred',
        content: 'keep me through redraw',
        attachments: [durableAttachment],
        createdAt: '2026-07-13T00:00:00.000Z',
      }],
    }], fixture.targetA);
    fixture.renderChatMessages([]);
    assert.equal(guideRows(fixture.document, acceptedId).length, 1, 'deferred Guide survives a destructive snapshot redraw');
    assert.equal(guideRows(fixture.document, acceptedId)[0].getAttribute('data-guide-status'), 'deferred');
    assert.equal(guideRows(fixture.document, acceptedId)[0].querySelectorAll('.conversation-image-attachment').length, 1,
      'deferred receipt restores its durable attachment after a destructive snapshot redraw');

    const persisted = [{
      role: 'user',
      content: 'keep me through redraw',
      mode: 'guide',
      model: 'fixture-model',
      clientMessageId: acceptedId,
      runId: 'run-a',
      attachments: [durableAttachment],
    }];
    fixture.renderChatMessages(persisted);
    assert.equal(guideRows(fixture.document, acceptedId).length, 1, 'applied persisted Guide replaces rather than duplicates the optimistic row');
    assert.equal(guideRows(fixture.document, acceptedId)[0].getAttribute('data-guide-status'), 'applied');
    assert.equal(guideRows(fixture.document, acceptedId)[0].querySelectorAll('.conversation-image-attachment').length, 1,
      'applied persisted Guide reuses the attachment without duplicating the optimistic gallery');
    assert.equal(fixture.guideMessagesForTarget(fixture.targetA)[acceptedId], undefined, 'applied Guide leaves the optimistic receipt cache');
    fixture.renderChatMessages(persisted);
    assert.equal(guideRows(fixture.document, acceptedId).length, 1, 'repeated applied snapshots remain exactly once');

    const dedupedEvents = fixture.dedupeGuideWorkEvents([
      { id: 'optimistic', type: 'guide_accepted', clientMessageId: 'guide-nested-id', content: 'summarize' },
      { id: 'backend', type: 'guide_accepted', guide: { clientMessageId: 'guide-nested-id', status: 'accepted' }, content: 'summarize' },
    ]) as Array<Record<string, unknown>>;
    assert.equal(dedupedEvents.length, 1, 'top-level and nested same-id accepted events merge into one Build row');
    assert.equal(dedupedEvents[0].id, 'backend', 'the authoritative backend acknowledgement replaces the optimistic event in place');

    const buildOwnedId = 'guide-build-owned';
    fixture.recordGuideUiMessage({
      clientMessageId: buildOwnedId,
      target: fixture.targetA,
      runId: 'run-build-owned',
      status: 'accepted',
      content: 'owned by build',
    }, fixture.targetA);
    fixture.state.workRunsByTarget['workspace-a::default'] = [{
      runId: 'run-build-owned',
      target: fixture.targetA,
      guides: [{ clientMessageId: buildOwnedId, status: 'accepted', content: 'owned by build' }],
      events: [{ type: 'guide_accepted', clientMessageId: buildOwnedId, content: 'owned by build' }],
    }];
    fixture.renderChatMessages([]);
    assert.equal(guideRows(fixture.document, buildOwnedId).length, 0,
      'a Guide already owned by a Build run never renders as a duplicate standalone user row');
    fixture.state.workRunsByTarget['workspace-a::default'] = [];

    const appliedEvents = fixture.dedupeGuideWorkEvents([
      { id: 'accepted', type: 'guide_accepted', clientMessageId: 'guide-one-row', content: 'summarize' },
      { id: 'applied', type: 'guide_applied', guide: { clientMessageId: 'guide-one-row', status: 'applied' }, content: 'summarize' },
      { id: 'late-accepted', type: 'guide_accepted', clientMessageId: 'guide-one-row', content: 'summarize' },
    ]) as Array<Record<string, unknown>>;
    assert.equal(appliedEvents.length, 1, 'accepted and applied share one Build row for the same Guide id');
    assert.equal(appliedEvents[0].id, 'applied', 'applied upgrades accepted and a late accepted event cannot downgrade it');

    const rejectedId = 'guide-rejected';
    fixture.recordGuideUiMessage({
      clientMessageId: rejectedId,
      target: fixture.targetA,
      runId: 'run-a',
      status: 'rejected',
      content: 'rejected instruction',
      reason: 'run already settled',
    }, fixture.targetA);
    fixture.renderChatMessages(persisted);
    assert.equal(guideRows(fixture.document, rejectedId).length, 1, 'rejected Guide is retained through redraw');
    const rejected = guideRows(fixture.document, rejectedId)[0];
    assert.equal(rejected.getAttribute('data-guide-status'), 'rejected');
    assert.match(rejected.textContent || '', /Guide\s*·\s*Rejected/, 'rejected state is explicit in visible UI');

    fixture.recordGuideUiMessage({
      clientMessageId: 'guide-b',
      target: fixture.targetB,
      status: 'accepted',
      content: 'workspace B only',
    }, fixture.targetB);
    fixture.renderChatMessages(persisted);
    assert.equal(guideRows(fixture.document, 'guide-b').length, 0, 'another workspace target cannot leak an optimistic Guide into the active chat');
    fixture.setActiveTarget(fixture.targetB);
    fixture.renderChatMessages([]);
    assert.equal(guideRows(fixture.document, 'guide-b').length, 1, 'target-scoped optimistic Guide restores when its workspace is foregrounded');

    fixture.setActiveTarget(fixture.targetA);
    fixture.state.guideMessagesByTarget['workspace-a::default'] = {};
    fixture.state.workRunsByTarget['workspace-a::default'] = [
      {
        runId: 'run-history-one',
        primaryPrompt: 'first visible user input',
        startedAt: '2026-07-20T15:58:27.000Z',
        status: 'completed',
        events: [{ type: 'final_response', content: 'first visible final answer' }],
      },
      {
        runId: 'run-history-two',
        primaryPrompt: 'second visible user input',
        status: 'completed',
        events: [{ type: 'final_response', content: 'second visible final answer' }],
      },
    ];
    const switchedConversationMessages = [
      { role: 'user', content: 'first visible user input', runId: 'run-history-one' },
      { role: 'user', content: 'mid-run Guide', mode: 'guide', clientMessageId: 'guide-history-one', runId: 'run-history-one' },
      { role: 'assistant', content: 'first visible final answer', runId: 'run-history-one' },
      { role: 'user', content: 'second visible user input', runId: 'run-history-two' },
      { role: 'assistant', content: 'second visible final answer', runId: 'run-history-two' },
    ];
    fixture.renderChatMessages(switchedConversationMessages);
    const visibleRows = Array.from(fixture.document.querySelectorAll('#chat-area > .chat-msg'));
    assert.deepEqual(visibleRows.map(row => row.getAttribute('data-test-run-id') || row.querySelector('.msg-body')?.textContent?.trim()), [
      'first visible user input',
      'run-history-one',
      'first visible final answer',
      'second visible user input',
      'run-history-two',
      'second visible final answer',
    ], 'conversation reload reconstructs each explicit run as user input, owning Build, then final answer');
    assert.equal(fixture.document.querySelectorAll('.run-final-response[data-run-id="run-history-one"]').length, 1,
      'first completed Build keeps exactly one visible final answer after reload');
    assert.equal(fixture.document.querySelectorAll('.run-final-response[data-run-id="run-history-two"]').length, 1,
      'second completed Build keeps exactly one visible final answer after reload');

    fixture.state.workRunsByTarget['workspace-a::default'] = [{
      runId: 'run-recovery',
      primaryPrompt: 'recovered user input',
      startedAt: '2026-07-20T15:58:50.000Z',
      status: 'completed',
      events: [{ type: 'final_response', content: 'recovered final answer' }],
    }];
    fixture.renderChatMessages([]);
    assert.match(fixture.document.getElementById('chat-area')?.textContent || '', /recovered user input[\s\S]*Build run-recovery[\s\S]*recovered final answer/,
      'a persisted Build recovers both visible boundaries when legacy chat rows are missing');
    assert.match(fixture.document.getElementById('chat-area')?.textContent || '', /Historical record/,
      'synthetic recovery rows are identified as historical instead of appearing newly submitted');

    fixture.state.workRunsByTarget['workspace-a::default'] = [
      {
        runId: 'run-orphan-error',
        primaryPrompt: 'older missing failed input',
        startedAt: '2026-07-20T15:58:50.000Z',
        status: 'error',
        events: [{ type: 'error', content: 'older persisted failure' }],
      },
      {
        runId: 'run-latest-success',
        primaryPrompt: 'latest visible input',
        startedAt: '2026-07-20T16:30:00.000Z',
        status: 'completed',
        events: [{ type: 'final_response', content: 'latest visible final' }],
      },
    ];
    fixture.renderChatMessages([
      { role: 'user', content: 'latest visible input', runId: 'run-latest-success', timestamp: '00:30:00' },
      { role: 'assistant', content: 'latest visible final', runId: 'run-latest-success', timestamp: '00:30:41' },
    ]);
    const orphanOrder = Array.from(fixture.document.querySelectorAll('#chat-area > .chat-msg')).map(row => row.textContent || '').join('\n');
    assert.match(orphanOrder, /older missing failed input[\s\S]*Build run-orphan-error[\s\S]*latest visible input[\s\S]*Build run-latest-success[\s\S]*latest visible final/,
      'an orphaned historical failure is restored before the newer completed run instead of being appended after its final answer');

    console.log('Guide UI reconciliation verification passed');
  } finally {
    fixture.close();
  }
}

main();
