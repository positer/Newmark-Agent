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
      found = node.getText(file);
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`UI assignment was not found: window.${name}`);
  return found;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const source = uiScriptSource();
  const helpers = [
    'refreshConversationArchivesAfterBatch',
    'scheduleConversationArchiveRefresh',
    'scheduleConversationArchiveActiveSync',
  ].map(name => functionSource(source, name)).join('\n\n');
  const archiveConv = assignedFunctionSource(source, 'archiveConv');
  const archiveCurrent = assignedFunctionSource(source, 'archiveCurrent');
  const newConversation = assignedFunctionSource(source, 'newConversation');

  assert.ok(newConversation.includes("state.nextConversationSequence = Number(state.nextConversationSequence || 0) + 1")
    && newConversation.includes("var id = 'conv-' + Date.now() + '-' + state.nextConversationSequence"),
  'rapid new-conversation clicks receive collision-free renderer identities');
  assert.ok(newConversation.includes('if (s) applyConversationSnapshot(s, id')
    && !newConversation.includes('loadActiveConversationMessages(id)'),
  'new conversation applies the cold activation snapshot without starting a redundant runtime state request');
  assert.ok(archiveCurrent.includes('window.archiveConv(currentId)')
    && !archiveCurrent.includes('runningConversationRecord'),
  'the active archive action uses the same waiting-spinner path regardless of runtime state');
  assert.ok(!archiveConv.includes('A running conversation cannot be archived.')
    && !archiveConv.includes('workspaceConversations.splice(restoreAt'),
  'archive never blocks a running target or performs a failure rollback');

  const conversations = ['archive-a', 'archive-b', 'archive-c', 'archive-running'].map((id, index) => ({
    id,
    summary: id,
    active: index === 0,
    archived: false,
  }));
  const state: Record<string, any> = {
    currentWorkspace: 'Workspace',
    workspaceConversations: { ws: conversations },
    workspaceActiveConversation: { ws: 0 },
    conversationArchivePending: {},
    conversationArchiveRefreshTimer: null,
    conversationArchiveActiveSyncTimer: null,
    conversations,
    activeConversation: 0,
    workspaceArchives: [],
    allArchives: [],
  };
  const requests = new Map<string, ReturnType<typeof deferred<any>>>();
  const archiveCalls: string[] = [];
  let listCount = 0;
  let renderCount = 0;
  let backgroundSyncCount = 0;
  const api = {
    archive(target: { conversationId: string }): Promise<any> {
      archiveCalls.push(target.conversationId);
      const request = deferred<any>();
      requests.set(target.conversationId, request);
      return request.promise;
    },
    listArchives(): Promise<any[]> {
      listCount += 1;
      return Promise.resolve(archiveCalls.map(id => ({ id, name: `${id}.md`, conversationId: id })));
    },
  };
  const notices: Array<{ message: string; type: string }> = [];
  const windowObject: Record<string, any> = {
    requireWorkspace: () => true,
    renderRightArchives: () => undefined,
  };
  const install = new Function(
    'window', 'state', 'api', 'els', 'currentWorkspaceConversations', 'currentConversationTarget',
    'currentWorkspaceKey', 'runningConversationRecord', 'showUiNotice', 'currentLang', 'currentRuntimeKey',
    'setConversationRuntimeState', 't', 'setWorking', 'activeConversationId', 'renderConversations',
    'syncBackendConversation',
    `${helpers}\n${archiveConv}`,
  );
  install(
    windowObject,
    state,
    api,
    { 'chat-area': { innerHTML: 'chat' } },
    () => state.workspaceConversations.ws,
    (id: string) => ({ workspaceId: 'ws', conversationId: id }),
    () => 'ws',
    (id: string) => id === 'archive-running' ? { status: 'running' } : null,
    (message: string, type: string) => notices.push({ message, type }),
    () => 'en',
    (id: string) => `ws::${id}`,
    () => undefined,
    (key: string) => key,
    () => undefined,
    () => state.workspaceConversations.ws[state.activeConversation]?.id || 'default',
    () => { renderCount += 1; },
    () => { backgroundSyncCount += 1; return Promise.resolve(); },
  );

  const startedAt = Date.now();
  windowObject.archiveConv('archive-a');
  windowObject.archiveConv('archive-b');
  windowObject.archiveConv('archive-c');
  windowObject.archiveConv('archive-running');
  const optimisticElapsedMs = Date.now() - startedAt;

  assert.deepEqual(archiveCalls, ['archive-a', 'archive-b', 'archive-c', 'archive-running'],
    'rapid clicks dispatch all archive requests immediately, including a running target');
  assert.ok(optimisticElapsedMs < 30, `four archive dispatches should complete within one frame, got ${optimisticElapsedMs} ms`);
  assert.deepEqual(state.workspaceConversations.ws.map((item: any) => item.id), ['archive-a', 'archive-b', 'archive-c', 'archive-running'],
    'archive targets stay visible (button spins) until the backend confirms');
  assert.equal(Object.keys(state.conversationArchivePending).length, 4, 'each accepted click records its pending archive state');
  assert.equal(renderCount, 4, 'each accepted click repaints its row with the archiving spinner');
  assert.equal(backgroundSyncCount, 0, 'the waiting archive path never joins a synchronous background sync');

  requests.get('archive-c')!.resolve({ ok: true, fileName: 'c.md', conversationId: 'archive-c' });
  requests.get('archive-a')!.resolve({ ok: true, fileName: 'a.md', conversationId: 'archive-a' });
  requests.get('archive-b')!.resolve({ ok: true, fileName: 'b.md', conversationId: 'archive-b' });
  requests.get('archive-running')!.resolve({ ok: true, fileName: 'running.md', conversationId: 'archive-running' });
  await wait(80);

  assert.deepEqual(state.workspaceConversations.ws.map((item: any) => item.id), ['default'],
    'target rows are removed only after the backend settles their archive');
  assert.equal(listCount, 1, 'closely completed requests coalesce only the non-blocking archive-list refresh');
  assert.equal(Object.keys(state.conversationArchivePending).length, 0, 'successful requests clear their independent rollback records');
  assert.equal(notices.filter(item => item.type === 'success').length, 4, 'every successful archive keeps its own receipt');

  const retained = { id: 'retain-on-error', summary: 'retain-on-error', active: true, archived: false };
  state.workspaceConversations.ws = [retained];
  state.conversations = state.workspaceConversations.ws;
  state.activeConversation = 0;
  windowObject.archiveConv('retain-on-error');
  assert.deepEqual(state.workspaceConversations.ws.map((item: any) => item.id), ['retain-on-error'],
    'a failing request keeps the row visible (button spins) until the backend settles');
  requests.get('retain-on-error')!.resolve({ ok: false, error: 'synthetic archive failure' });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(state.workspaceConversations.ws.map((item: any) => item.id), ['retain-on-error'],
    'a negative IPC receipt keeps the row (button restored) instead of removing it');
  assert.ok(notices.some(item => item.type === 'error' && item.message.includes('synthetic archive failure')),
    'a negative IPC receipt is surfaced as an archive error');

  console.log('conversation archive concurrency verification passed: 19 assertions');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
