import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { verifyQueueUnifyStress } from './queueUnifyStressVerify';

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
    'guideWorkEventKey',
    'guideWorkEventStatus',
    'mergeGuideWorkEvent',
    'dedupeGuideWorkEvents',
    'publicWorkEventForUi',
    'compareConversationWorkEvents',
    'normalizedWorkRun',
    'conversationBranchIdsForTarget',
    'workRunBranchKey',
    'workRunsForBranch',
    'workRunsForTarget',
    'syncWorkRunsSnapshot',
    'queueItemsForTarget',
    'setQueueItemsForTarget',
    'queueItemIdForText',
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
    workRunsByBranch: {},
    guideMessagesByTarget: {},
    trackedConversationUntil: {},
    activeSendCallsByTarget: {},
    nextQueueDrainsByTarget: {},
    nextQueueSchedulesByTarget: {},
    backendQueuesByTarget: {
      [`${targetA.workspaceId}::${targetA.conversationId}`]: { steering: [], followUp: ['queue-a'] },
      [`${targetB.workspaceId}::${targetB.conversationId}`]: { steering: [], followUp: ['queue-b'] },
    },
  };
  const guideTargets: Array<{ workspaceId: string; conversationId: string }> = [];
  const windowObject: Record<string, any> = {};
  const install = new Function('window', 'state', 'currentConversationTarget', 'recordGuideUiMessage', 'isActiveConversationTarget', `
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
    () => false,
  );

  windowObject.registerRuntimeKey(targetA, runtimeA);
  windowObject.registerRuntimeKey(targetB, runtimeB);
  assert.deepEqual(state.backendQueuesByTarget[runtimeA].followUp, ['queue-a']);
  assert.deepEqual(state.backendQueuesByTarget[runtimeB].followUp, ['queue-b']);

  const activeSendLock = { owner: 'send-a' };
  const drainLock = { owner: 'drain-a' };
  const scheduleLock = { owner: 'schedule-a' };
  const priorAlias = state.runtimeKeyAliases[`${targetA.workspaceId}::${targetA.conversationId}`];
  delete state.runtimeKeyAliases[`${targetA.workspaceId}::${targetA.conversationId}`];
  state.activeSendCallsByTarget[`${targetA.workspaceId}::${targetA.conversationId}`] = activeSendLock;
  state.nextQueueDrainsByTarget[`${targetA.workspaceId}::${targetA.conversationId}`] = drainLock;
  state.nextQueueSchedulesByTarget[`${targetA.workspaceId}::${targetA.conversationId}`] = scheduleLock;
  windowObject.registerRuntimeKey(targetA, priorAlias || runtimeA);
  assert.equal(state.activeSendCallsByTarget[runtimeA], activeSendLock,
    'runtime alias promotion keeps the active-send mutex on the canonical target');
  assert.equal(state.nextQueueDrainsByTarget[runtimeA], drainLock,
    'runtime alias promotion keeps an in-flight queue drain mutex on the canonical target');
  assert.equal(state.nextQueueSchedulesByTarget[runtimeA], scheduleLock,
    'runtime alias promotion keeps a scheduled queue drain mutex on the canonical target');
  assert.equal(state.activeSendCallsByTarget[`${targetA.workspaceId}::${targetA.conversationId}`], undefined);
  assert.equal(state.nextQueueDrainsByTarget[`${targetA.workspaceId}::${targetA.conversationId}`], undefined);
  assert.equal(state.nextQueueSchedulesByTarget[`${targetA.workspaceId}::${targetA.conversationId}`], undefined);
  delete state.activeSendCallsByTarget[runtimeA];
  delete state.nextQueueDrainsByTarget[runtimeA];
  delete state.nextQueueSchedulesByTarget[runtimeA];

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

async function main(): Promise<void> {
  const source = uiScriptSource();
  const addMsgSource = functionSource(source, 'addMsg');
  const recordGuideSource = functionSource(source, 'recordGuideUiMessage');
  assert.ok(addMsgSource.includes('findGuideMessageElement(guideMessageId)')
    && addMsgSource.includes('return existingGuide')
    && recordGuideSource.includes('allowStatusReset'),
    'same-id Guide receipts retain one rendered row and support uncertain retries');
  assert.ok(source.includes("'queue.guideAction': 'Guide'")
    && source.includes("'queue.guideAction': '引导'")
    && source.includes('class="stack-icon-btn queue-guide-btn"'),
    'shared queue rows retain their visible localized Guide control');
  verifyPersistedWorkRunsCannotRewriteRuntimeIdentity(source);
  await verifyQueueUnifyStress();
  // This replaces the retired renderer-drain fixtures with actual production
  // command functions: target isolation, remote queue event visibility,
  // duplicate ids, attachments, pause, Flow takeover and edited Guide.
  const commands = require(path.join(__dirname, '..', '..', 'scripts', 'test-renderer-conversation-commands.cjs'));
  const result = await commands.run();
  assert.equal(result.failed, 0, 'all canonical renderer command behaviors pass');
  console.log('Queue attachment isolation verification passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
