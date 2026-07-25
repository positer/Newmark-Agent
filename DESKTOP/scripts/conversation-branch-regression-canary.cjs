const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const modulePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'core', 'agent.js'));
const { Agent } = require(modulePath);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-branch-canary-'));

try {
  const agent = new Agent(root);
  agent.createInternalWorkspace('canary');
  agent.setConversation('canary-tree');
  agent.chatMessages = [
    { role: 'user', content: 'canary root', mode: 'Build', model: agent.model, timestamp: 'a' },
    { role: 'assistant', content: 'canary answer', mode: 'Build', model: agent.model, timestamp: 'b' },
    { role: 'user', content: 'canary later', mode: 'Build', model: agent.model, timestamp: 'c' },
  ];
  agent.history = agent.chatMessages.map(message => ({ role: message.role, content: message.content }));
  agent.flushConversationState();
  let snapshot = agent.getConversationSnapshot('canary-tree');
  snapshot = agent.branchConversation('canary-tree', 0, 'canary root edited', { messageId: snapshot.chatMessages[0].messageId });
  const rootNodeId = snapshot.viewedBranchNodePath[0];
  agent.chatMessages = [
    { role: 'user', content: 'canary leaf', mode: 'Build', model: agent.model, timestamp: 'd' },
    { role: 'assistant', content: 'canary leaf answer', mode: 'Build', model: agent.model, timestamp: 'e' },
    { role: 'user', content: 'canary leaf later', mode: 'Build', model: agent.model, timestamp: 'f' },
  ];
  agent.history = agent.chatMessages.map(message => ({ role: message.role, content: message.content }));
  agent.flushConversationState();
  const rootPage = agent.inspectConversationBranch('canary-tree', rootNodeId, snapshot.branchGroupId);
  const rootLater = agent.branchConversation('canary-tree', 2, 'canary root later edited', {
    messageId: rootPage.chatMessages[2].messageId,
    branchNodePath: rootPage.viewedBranchNodePath,
  });
  assert.ok(rootLater.branchIndexDirectory, 'conversation history must expose a full branch index directory');
  assert.equal(rootLater.branchIndexDirectory[rootLater.activeBranchId].parentId, rootNodeId, 'viewed branch path must own the edit');

  agent.setConversation('canary-guide');
  const target = { workspaceId: 'canary-workspace', conversationId: 'canary-guide' };
  agent.chatMessages = [
    { role: 'user', content: 'build', mode: 'Build', model: agent.model, timestamp: 'g', runId: 'old-build' },
    { role: 'user', content: 'guide', mode: 'Guide', model: agent.model, timestamp: 'h', runId: 'old-build', clientMessageId: 'old-client', guideId: 'old-guide' },
  ];
  agent.history = agent.chatMessages.map(message => ({ role: message.role, content: message.content }));
  agent.workRuns = [{ runId: 'old-build', target, runtimeKey: 'old-key', status: 'completed', startedAt: 'g', endedAt: 'i', expanded: true, sequence: 1, primaryPrompt: 'build', guides: [], events: [{ id: 'prefix', conversationId: 'canary-guide', type: 'status', content: 'prefix', mode: 'build', model: '', timestamp: 'g', runId: 'old-build', sequence: 1 }] }];
  agent.flushConversationState();
  const guideSource = agent.getConversationSnapshot('canary-guide');
  const guideBranch = agent.branchConversation('canary-guide', 1, 'guide edited', { messageId: guideSource.chatMessages[1].messageId, guideId: 'old-guide', branchNodePath: guideSource.viewedBranchNodePath });
  assert.notEqual(guideBranch.workRuns[0].runId, 'old-build', 'Guide edit must clone a new Build id');
  assert.ok(guideBranch.branchIndexDirectory[guideBranch.activeBranchId].workRunIds.includes(guideBranch.workRuns[0].runId), 'new branch directory must own the cloned Build');
  console.log(JSON.stringify({ ok: true, modulePath }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
