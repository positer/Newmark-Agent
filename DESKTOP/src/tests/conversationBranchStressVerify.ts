import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent, ConversationSnapshot } from '../core/agent';

function assertDirectory(snapshot: ConversationSnapshot): void {
  const entries = Object.values(snapshot.branchIndexDirectory);
  assert.ok(entries.length > 0, 'branch index directory must not be empty');
  const nodeIds = entries.map(entry => entry.nodeId);
  assert.equal(new Set(nodeIds).size, nodeIds.length, 'node ids must be unique');
  for (const entry of entries) {
    assert.equal(entry.path[entry.path.length - 1], entry.nodeId, 'path must terminate at its node');
    if (entry.parentId) {
      const parent = snapshot.branchIndexDirectory[entry.parentId];
      assert.ok(parent, 'parent must exist');
      assert.ok(parent.childIds.includes(entry.nodeId), 'parent must index its child');
      assert.deepEqual(entry.path.slice(0, -1), parent.path, 'child path must extend the parent path exactly');
    }
    assert.equal(new Set(entry.messageIds).size, entry.messageIds.length, 'message ids must be unique within one branch snapshot');
    assert.equal(new Set(entry.guideIds).size, entry.guideIds.length, 'guide ids must be unique within one branch snapshot');
    assert.equal(new Set(entry.workRunIds).size, entry.workRunIds.length, 'Build ids must be unique within one branch snapshot');
  }
}

function setTranscript(agent: Agent, prefix: string, ordinal: number): ConversationSnapshot {
  agent.chatMessages = [
    { role: 'user', content: `${prefix} start ${ordinal}`, mode: 'Build', model: agent.model, timestamp: `2026-07-25T03:${String(ordinal % 60).padStart(2, '0')}:00.000Z` },
    { role: 'assistant', content: `${prefix} answer ${ordinal}`, mode: 'Build', model: agent.model, timestamp: `2026-07-25T03:${String(ordinal % 60).padStart(2, '0')}:01.000Z` },
    { role: 'user', content: `${prefix} later ${ordinal}`, mode: 'Build', model: agent.model, timestamp: `2026-07-25T03:${String(ordinal % 60).padStart(2, '0')}:02.000Z` },
    { role: 'assistant', content: `${prefix} later answer ${ordinal}`, mode: 'Build', model: agent.model, timestamp: `2026-07-25T03:${String(ordinal % 60).padStart(2, '0')}:03.000Z` },
  ];
  agent.history = agent.chatMessages.map(message => ({ role: message.role, content: message.content }));
  agent.flushConversationState();
  return agent.getConversationSnapshot();
}

function run(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-branch-stress-'));
  const startedAt = Date.now();
  try {
    let agent = new Agent(root);
    agent.createInternalWorkspace('branch-stress');
    agent.setConversation('stress-tree');
    let snapshot = setTranscript(agent, 'root', 0);

    // Repeated edits of one node must remain one pager with every sibling page.
    const rootMessageId = snapshot.chatMessages[0].messageId!;
    const first = agent.branchConversation('stress-tree', 0, 'root edit 0', { messageId: rootMessageId });
    const rootNodeId = first.viewedBranchNodePath[0];
    const rootGroupId = first.branchGroupId;
    for (let index = 1; index < 30; index++) {
      const rootPage = agent.inspectConversationBranch('stress-tree', rootNodeId, rootGroupId);
      snapshot = agent.branchConversation('stress-tree', 0, `root edit ${index}`, {
        messageId: rootPage.chatMessages[0].messageId,
        branchNodePath: rootPage.viewedBranchNodePath,
      });
    }
    const wideGroup = snapshot.branchGroups.find(group => group.id === rootGroupId);
    assert.equal(wideGroup?.branches.length, 31, 'thirty edits of one node must produce one 31-page pager');
    assertDirectory(snapshot);

    // Build a deep chain while an earlier wide pager remains in the ancestry.
    for (let depth = 0; depth < 45; depth++) {
      snapshot = setTranscript(agent, `depth-${depth}`, depth);
      snapshot = agent.branchConversation('stress-tree', 2, `depth edit ${depth}`, {
        messageId: snapshot.chatMessages[2].messageId,
        branchNodePath: snapshot.viewedBranchNodePath,
      });
      assertDirectory(snapshot);
    }
    assert.ok(snapshot.viewedBranchNodePath.length >= 47, 'deep branch path must retain every ancestor');
    assert.ok(snapshot.branchGroups.some(group => group.id === rootGroupId), 'deep edits must retain the root pager');

    // A Guide edit clones the owning Build prefix, then all live and terminal
    // events must persist only under the cloned Build and cloned branch node.
    agent.setConversation('guide-runtime-persistence');
    const guideTarget = { workspaceId: 'guide-runtime-workspace', conversationId: 'guide-runtime-persistence' };
    const originalGuideRunId = 'guide-runtime-original-build';
    const originalGuideId = 'guide-runtime-node';
    const originalClientMessageId = 'guide-runtime-client';
    agent.chatMessages = [
      { role: 'user', content: 'guide runtime start', mode: 'Build', model: agent.model, timestamp: '2026-07-25T04:00:00.000Z', runId: originalGuideRunId },
      { role: 'assistant', content: 'guide runtime prefix', mode: 'Build', model: agent.model, timestamp: '2026-07-25T04:00:01.000Z', runId: originalGuideRunId },
      { role: 'user', content: 'guide runtime old', mode: 'Guide', model: agent.model, timestamp: '2026-07-25T04:00:02.000Z', runId: originalGuideRunId, clientMessageId: originalClientMessageId, guideId: originalGuideId },
      { role: 'assistant', content: 'guide runtime old tail', mode: 'Build', model: agent.model, timestamp: '2026-07-25T04:00:03.000Z', runId: originalGuideRunId },
    ];
    agent.history = agent.chatMessages.map(message => ({ role: message.role, content: message.content }));
    agent.workRuns = [{
      runId: originalGuideRunId,
      target: guideTarget,
      runtimeKey: 'guide-runtime-original-key',
      status: 'completed',
      startedAt: '2026-07-25T04:00:00.000Z',
      endedAt: '2026-07-25T04:00:04.000Z',
      expanded: true,
      sequence: 3,
      primaryPrompt: 'guide runtime start',
      guides: [{ clientMessageId: originalClientMessageId, guideId: originalGuideId, target: guideTarget, runId: originalGuideRunId, status: 'applied', content: 'guide runtime old', createdAt: '2026-07-25T04:00:02.000Z', updatedAt: '2026-07-25T04:00:02.000Z' }],
      events: [
        { id: 'guide-runtime-prefix-event', conversationId: guideTarget.conversationId, type: 'status', content: 'guide runtime prefix event', mode: 'build', model: '', timestamp: '2026-07-25T04:00:01.000Z', runId: originalGuideRunId, sequence: 1 },
        { id: 'guide-runtime-guide-event', conversationId: guideTarget.conversationId, type: 'guide', content: 'guide runtime old', mode: 'build', model: '', timestamp: '2026-07-25T04:00:02.000Z', runId: originalGuideRunId, sequence: 2, guide: { clientMessageId: originalClientMessageId, guideId: originalGuideId, target: guideTarget, runId: originalGuideRunId, status: 'applied', content: 'guide runtime old', createdAt: '2026-07-25T04:00:02.000Z', updatedAt: '2026-07-25T04:00:02.000Z' } },
        { id: 'guide-runtime-tail-event', conversationId: guideTarget.conversationId, type: 'status', content: 'guide runtime old tail event', mode: 'build', model: '', timestamp: '2026-07-25T04:00:03.000Z', runId: originalGuideRunId, sequence: 3 },
      ],
    }];
    agent.flushConversationState();
    const guideSource = agent.getConversationSnapshot('guide-runtime-persistence');
    const guideBranch = agent.branchConversation('guide-runtime-persistence', 2, 'guide runtime edited', {
      messageId: guideSource.chatMessages[2].messageId,
      guideId: originalGuideId,
      branchNodePath: guideSource.viewedBranchNodePath,
    });
    const copiedRunId = guideBranch.workRuns[0].runId;
    assert.notEqual(copiedRunId, originalGuideRunId, 'Guide edit must clone the parent Build with a new runId');
    assert.ok(agent.resumeConversationWorkRun(copiedRunId), 'cloned Guide Build must be resumable');
    const newGuideId = 'guide-runtime-new-node';
    const newClientMessageId = 'guide-runtime-new-client';
    agent.recordGuideReceipt({ clientMessageId: newClientMessageId, guideId: newGuideId, target: guideTarget, runId: copiedRunId, status: 'applied', content: 'guide runtime edited', createdAt: '2026-07-25T04:01:00.000Z', updatedAt: '2026-07-25T04:01:00.000Z' });
    agent.emitWorkEvent({ type: 'tool_call', content: 'Using runtime persistence tool.', toolName: 'runtime_persistence', runId: copiedRunId, conversationId: guideTarget.conversationId });
    agent.emitWorkEvent({ type: 'tool_result', content: 'Runtime persistence tool completed.', toolName: 'runtime_persistence', runId: copiedRunId, conversationId: guideTarget.conversationId });
    assert.ok(agent.finishConversationWorkRun(copiedRunId, 'completed', '2026-07-25T04:01:05.000Z'), 'cloned Guide Build must finish through the runtime completion path');
    agent.flushConversationState();
    const completedGuideBranch = agent.getConversationSnapshot('guide-runtime-persistence');
    const completedCopy = completedGuideBranch.workRuns.find(run => run.runId === copiedRunId)!;
    assert.equal(completedCopy.status, 'completed', 'cloned Guide Build terminal state must persist');
    assert.ok(completedCopy.guides.some(guide => guide.guideId === newGuideId && guide.runId === copiedRunId), 'new Guide must belong only to the cloned Build');
    assert.ok(completedCopy.events.every(event => !event.runId || event.runId === copiedRunId), 'all cloned/live events must retain the cloned runId');
    const originalGuidePageId = completedGuideBranch.branches.find(branch => branch.id !== completedGuideBranch.activeBranchId)!.id;
    const viewedOriginalGuide = agent.inspectConversationBranch('guide-runtime-persistence', originalGuidePageId, completedGuideBranch.branchGroupId);
    assert.ok(viewedOriginalGuide.workRuns.some(run => run.runId === originalGuideRunId), 'original page must retain the original Build');
    assert.ok(!viewedOriginalGuide.workRuns.some(run => run.runId === copiedRunId), 'original page must not receive cloned Build runtime writes');
    agent = new Agent(root);
    agent.setConversationFromStorage('guide-runtime-persistence');
    const reloadedGuideBranch = agent.inspectConversationBranch('guide-runtime-persistence', completedGuideBranch.activeBranchId, completedGuideBranch.branchGroupId);
    const reloadedCopy = reloadedGuideBranch.workRuns.find(run => run.runId === copiedRunId)!;
    assert.equal(reloadedCopy.status, 'completed', 'cloned Guide Build completion must survive cold reload');
    assert.ok(reloadedCopy.guides.some(guide => guide.guideId === newGuideId), 'cloned Guide identity must survive cold reload');
    assert.equal(reloadedGuideBranch.branchIndexDirectory[completedGuideBranch.activeBranchId].workRunIds.includes(copiedRunId), true, 'branch index directory must index the cloned Build on its new node');

    // Random read-only inspections cannot mutate the runtime leaf or its path.
    agent.setConversationFromStorage('stress-tree');
    snapshot = agent.getConversationSnapshot('stress-tree');
    const runtimeLeaf = snapshot.runtimeBranchId;
    const runtimePath = snapshot.runtimeBranchNodePath.join('>');
    const nodeIds = Object.keys(snapshot.branchIndexDirectory);
    for (let index = 0; index < 120; index++) {
      const viewedId = nodeIds[(index * 37) % nodeIds.length];
      const viewed = agent.inspectConversationBranch('stress-tree', viewedId);
      assert.equal(viewed.runtimeBranchId, runtimeLeaf, 'read-only inspection must not switch the runtime leaf');
      assert.equal(viewed.runtimeBranchNodePath.join('>'), runtimePath, 'read-only inspection must not mutate the runtime path');
      assert.equal(viewed.viewedBranchNodePath.at(-1), viewedId, 'viewed path must identify the inspected node');
    }

    // Cold reloads must rebuild the same directory and preserve the selected runtime leaf.
    for (let reload = 0; reload < 8; reload++) {
      agent = new Agent(root);
      agent.setConversationFromStorage('stress-tree');
      snapshot = agent.getConversationSnapshot('stress-tree');
      assert.equal(snapshot.runtimeBranchId, runtimeLeaf, 'cold reload must preserve the runtime leaf');
      assertDirectory(snapshot);
    }

    const archived = agent.archiveConversation('stress-tree');
    assert.ok(archived, 'stress tree must archive');
    const archive = agent.listArchives().find(item => item.name === archived);
    assert.ok(archive?.restorable, 'stress archive must contain structured tree state');
    assert.ok(agent.restoreArchivedConversation(archive!.id).ok, 'stress tree must restore');
    snapshot = agent.getConversationSnapshot('stress-tree');
    assert.equal(snapshot.runtimeBranchId, runtimeLeaf, 'archive restore must preserve the runtime leaf');
    assertDirectory(snapshot);

    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 30_000, `branch stress must finish within 30 seconds, observed ${elapsedMs}ms`);
    console.log(JSON.stringify({ ok: true, nodes: Object.keys(snapshot.branchIndexDirectory).length, groups: snapshot.branchGroups.length, inspections: 120, reloads: 8, elapsedMs }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
