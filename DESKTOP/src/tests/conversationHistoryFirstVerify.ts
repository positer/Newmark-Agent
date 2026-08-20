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
      && (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))) found = node.getText(file);
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) throw new Error(`UI assignment was not found: window.${name}`);
  return found;
}

function main(): void {
  const source = uiScriptSource();
  const helpers = ['conversationMessageCache', 'cacheConversationMessages', 'conversationHasReadableHistory', 'snapshotHasReadableConversationHistory']
    .map(name => functionSource(source, name)).join('\n\n');
  const state: Record<string, any> = { conversationMessagesByTarget: {}, workRunsByTarget: {} };
  const active = { workspaceId: 'workspace-a', conversationId: 'error-history' };
  const install = new Function('state', 'active', `
    function currentConversationTarget() { return active; }
    function runtimeKeyFor(workspaceId, conversationId) { return workspaceId + '::' + conversationId; }
    function workRunsForTarget(target) { return state.workRunsByTarget[runtimeKeyFor(target.workspaceId, target.conversationId)] || []; }
    ${helpers}
    return { conversationMessageCache, cacheConversationMessages, conversationHasReadableHistory, snapshotHasReadableConversationHistory };
  `);
  const fixture = install(state, active);
  const history = [{ role: 'user', content: 'request' }, { role: 'assistant', content: 'LLM Error: synthetic failure' }];
  fixture.cacheConversationMessages(history, active);
  history[1].content = 'mutated outside cache';
  assert.equal(fixture.conversationMessageCache(active)[1].content, 'LLM Error: synthetic failure',
    'readable error history is cloned into a composite-target cache and cannot be mutated by later snapshots');
  assert.equal(fixture.conversationHasReadableHistory(active), true,
    'cached transcript makes the target readable before runtime activation');
  assert.equal(fixture.snapshotHasReadableConversationHistory({ chatMessages: [], workRuns: [] }), false,
    'an empty activation snapshot is not treated as authoritative readable history');
  assert.equal(fixture.snapshotHasReadableConversationHistory({ chatMessages: history }), true,
    'a populated transcript can enhance the already-entered conversation');
  const other = { workspaceId: 'workspace-b', conversationId: 'error-history' };
  assert.deepEqual(fixture.conversationMessageCache(other), [],
    'same-named conversations in different workspaces never share cached history');

  const applySnapshot = functionSource(source, 'applyConversationSnapshot');
  const loadHistory = functionSource(source, 'loadActiveConversationMessages');
  const sync = functionSource(source, 'syncBackendConversation');
  const switchConversation = assignedFunctionSource(source, 'switchConversation');
  const newConversation = assignedFunctionSource(source, 'newConversation');
  assert.match(applySnapshot, /preserveReadableHistory[\s\S]*!snapshotHasReadableConversationHistory\(s\)/,
    'empty enhancement snapshots enter the preservation path');
  assert.match(applySnapshot, /Array\.isArray\(s\.workRuns\) && !preserveReadableHistory/,
    'an empty activation snapshot cannot clear cached Build history');
  assert.match(applySnapshot, /Array\.isArray\(s\.chatMessages\) && !preserveReadableHistory/,
    'an empty activation snapshot cannot clear cached transcript history');
  assert.match(loadHistory, /allowEmptyHistory: true/,
    'only the dedicated history reader may confirm that a genuinely empty conversation should show its welcome page');
  assert.match(loadHistory, /history enhancement failed; current content was preserved/i,
    'history enhancement failure is visible without clearing current content');
  assert.match(sync, /var historyPromise = loadActiveConversationMessages\(conv\.id\);[\s\S]*var activate =/,
    'history reading starts independently before runtime activation settles');
  assert.match(sync, /Promise\.allSettled\(\[historyPromise, activationPromise\]\)/,
    'history and activation are concurrent and either one may fail independently');
  assert.match(sync, /runtime activation failed; history remains available/i,
    'activation failure explicitly preserves readable history');
  assert.match(switchConversation, /renderConversationHistoryFirst\(activeBrowserTarget\)/,
    'conversation switching paints target-scoped readable history before asynchronous enhancement');
  assert.doesNotMatch(switchConversation, /els\['chat-area'\]\.innerHTML = ''/,
    'conversation switching never clears readable history pre-emptively');
  assert.match(switchConversation, /restoredReadableHistory\s*\?\s*null\s*:\s*addMsg/,
    'loading chrome is inserted only when the target has no readable cache');
  assert.match(newConversation, /applyConversationSnapshot\(s, id, \{ preserveReadableHistory: true \}\)/,
    'new-conversation activation cannot erase an immediate send or error transcript');
  assert.match(newConversation, /if \(!conversationHasReadableHistory\(target\)\)/,
    'the empty new-conversation welcome is rendered only when no send/history arrived during activation');
  assert.doesNotMatch(newConversation, /foregroundConversationHoldId = ''/,
    'runtime activation alone cannot release the foreground hold before the authoritative conversation list contains the new target');
  assert.match(newConversation, /state\.pendingConversationActivations\[activationKey\] = activationReady/,
    'new conversations expose a target-bound activation barrier without blocking immediate UI entry');
  const sendMessage = assignedFunctionSource(source, 'sendMessage');
  assert.match(sendMessage, /pendingConversationActivation\(lockedTarget\)[\s\S]*await activationBeforeSend[\s\S]*api\.sendMessage\(requestMessage, lockedTarget\)/,
    'the locked send waits only for its own new-conversation activation before backend submission');
  const normalizeRun = functionSource(source, 'normalizedWorkRun');
  const applyWorkEvent = functionSource(source, 'applyAgentWorkEventToRun');
  assert.match(normalizeRun, /status === 'error'/,
    'persisted error Builds restore expanded when the user has not chosen a display state');
  assert.match(applyWorkEvent, /type === 'error'[\s\S]*run\.expanded = true/,
    'a newly failed Build keeps its readable error details open instead of collapsing after load');

  console.log('conversation history-first verification passed: 24 assertions');
}

main();
