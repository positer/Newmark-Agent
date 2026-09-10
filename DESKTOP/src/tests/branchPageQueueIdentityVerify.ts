/**
 * dev-0.6.4 regression: branch pages, queue visibility and guide editing.
 *
 * 1. 用户分页（编辑历史输入）与实验性分支交流共用同一套分支身份逻辑。
 * 2. 每个分支节点是独立的「全对话」：消息缓存、Build 列表、排队行都不跨分支共享。
 * 3. 排队中的用户输入必须可见：队列面板不再按分支过滤，并内联渲染为待执行用户气泡。
 * 4. 时间线里的 Guide 只保留复制按钮，不再提供编辑入口。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { Agent } from '../core/agent';
import { branchConversationIdentity } from '../core/branchIdentity';

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

const source = uiScriptSource();

// --- 1. 单一分支身份逻辑 ---------------------------------------------------
{
  const identity = new Function(`${functionSource(source, 'conversationBranchIdentity')}
    return conversationBranchIdentity;`)() as (conversationId: string, branchNodeId: string) => string;
  assert.equal(identity('conv-1', 'node-a'), 'conv-1::branch:node-a', 'branch identity is conversationId::branch:<nodeId>');
  assert.equal(identity('conv-1', ''), 'conv-1', 'a conversation without a branch page keeps the plain conversation id');
  assert.notEqual(identity('conv-1', 'node-a'), identity('conv-1', 'node-b'), 'sibling pages never share the full conversation identity');
  const core = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'branchIdentity.ts'), 'utf-8');
  assert.match(core, /BRANCH_IDENTITY_SEPARATOR = '::branch:'/, 'core exposes the branch identity separator');
  const kernelRunner = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'agentKernelRunner.ts'), 'utf-8');
  assert.match(kernelRunner, /activeWorkRunBranchId\(\)/, 'provider session identity is bound to the Build owner branch, not the current view');
  const agentSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'agent.ts'), 'utf-8');
  assert.match(agentSource, /conversationContinuations\(\): ConversationContinuation\[\]/, 'queued input stays attached to its owning branch node');
  assert.match(agentSource, /branchNodeId: this\.currentBranchNodeId\(\) \|\| undefined/, 'folded history records its owning branch node');
  const kernelSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'conversationKernel.ts'), 'utf-8');
  assert.doesNotMatch(kernelSource, /conversationContinuationsAcrossBranches/, 'a new branch never drains another branch queued input');
  assert.match(source, /branchNodeId: String\(item && item\.branchNodeId \|\| ''\)/,
    'stored queue rows keep the branch node captured at admission time');
  assert.match(source, /branchPath: Array\.isArray\(item && item\.branchPath\)/,
    'stored queue rows keep the captured branch path instead of defaulting to the running branch');
}

// --- 2. 分支级缓存 + 排队可见性 + Guide 只读复制 ---------------------------
{
  const names = [
    'normalizeQueuedConversationTarget',
    'conversationBranchIdentity',
    'rememberViewedBranchNodeId',
    'viewedBranchNodeIdFor',
    'branchConversationViewKey',
    'conversationMessageCache',
    'cacheConversationMessages',
    'queuedRequestMatchesTarget',
    'queueIndexesForTarget',
    'queueRequestBranchMismatch',
    'messageActionsHtml',
    'renderWorkRunGuideMessage',
  ];
  const extracted = names.map(name => functionSource(source, name)).join('\n\n');
  const dom = new JSDOM('<!doctype html><html><body><div id="chat-area"></div></body></html>');
  const factory = new Function('window', 'document', `
    var active = { workspaceId: 'ws-a', conversationId: 'conv-a' };
    var state = {
      model: 'fixture-model',
      nextQueue: [],
      nextQueueRequests: [],
      conversationMessagesByTarget: {},
      viewedBranchNodeIdsByTarget: {},
      viewedConversationBranchNodePath: ['root-node', 'page-a'],
      runtimeConversationBranchNodePath: ['root-node', 'page-a'],
      activeConversationBranchId: 'page-a',
      runtimeConversationBranchId: 'page-a',
      renderedChatMessages: []
    };
    var els = { 'chat-area': document.getElementById('chat-area') };
    function currentConversationTarget() { return { workspaceId: active.workspaceId, conversationId: active.conversationId }; }
    function activeConversationId() { return active.conversationId; }
    function runtimeWorkspaceId(value) { return String(value || active.workspaceId); }
    function runtimeKeyFor(workspaceId, conversationId) { return runtimeWorkspaceId(workspaceId) + '::' + String(conversationId || 'default'); }
    function isActiveConversationTarget(target) { return !!target && runtimeKeyFor(target.workspaceId, target.conversationId) === runtimeKeyFor(active.workspaceId, active.conversationId); }
    function currentLang() { return 'en'; }
    function uiLocale() { return 'en-US'; }
    function t(value) { return value; }
    function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function escAttr(value) { return esc(value).replace(/"/g, '&quot;'); }
    function iconSvg() { return 'svg'; }
    function normalizeGuideUiStatus(value) { return String(value || 'accepted'); }
    function guideUiStatusLabel(value) { return String(value || ''); }
    function renderMessageContent(value) { return '<span>' + esc(value) + '</span>'; }
    function queueBranchPathForTarget(target, preference) {
      var path = preference === 'runtime' ? state.runtimeConversationBranchNodePath : state.viewedConversationBranchNodePath;
      return (path || []).slice(1).join('>') || '';
    }
    function addMsg(role, text, mode, model, messageIndex, meta) {
      var div = document.createElement('div');
      div.className = 'chat-msg ' + String(role || '');
      div.innerHTML = '<div class="meta"><span class="msg-role">' + esc(role) + '</span></div><div class="msg-body">' + renderMessageContent(text) + '</div>';
      div._newmarkMessageText = String(text || '');
      if (meta && meta.target) div._newmarkMessageTarget = meta.target;
      els['chat-area'].appendChild(div);
      return div;
    }
    ${extracted}
    return {
      state: state,
      els: els,
      document: document,
      branchKey: branchConversationViewKey,
      messageCache: conversationMessageCache,
      cacheMessages: cacheConversationMessages,
      queueIndexes: queueIndexesForTarget,
      queueMismatch: queueRequestBranchMismatch,
      guideHtml: renderWorkRunGuideMessage,
      actionsHtml: messageActionsHtml
    };
  `);
  const fixture = factory({}, dom.window.document) as any;

  // 分页缓存键按分支节点隔离
  const pageAKey = fixture.branchKey({ workspaceId: 'ws-a', conversationId: 'conv-a' });
  fixture.state.viewedConversationBranchNodePath = ['root-node', 'page-b'];
  fixture.state.activeConversationBranchId = 'page-b';
  const pageBKey = fixture.branchKey({ workspaceId: 'ws-a', conversationId: 'conv-a' });
  assert.notEqual(pageAKey, pageBKey, 'each page owns a distinct cache key');

  fixture.cacheMessages([{ role: 'user', content: 'page-b request' }], { workspaceId: 'ws-a', conversationId: 'conv-a' });
  fixture.state.viewedConversationBranchNodePath = ['root-node', 'page-a'];
  fixture.state.activeConversationBranchId = 'page-a';
  fixture.cacheMessages([{ role: 'user', content: 'page-a request' }], { workspaceId: 'ws-a', conversationId: 'conv-a' });
  assert.equal(fixture.messageCache({ workspaceId: 'ws-a', conversationId: 'conv-a' })[0].content, 'page-a request',
    'rendering one page never overwrites another page transcript');
  fixture.state.viewedConversationBranchNodePath = ['root-node', 'page-b'];
  fixture.state.activeConversationBranchId = 'page-b';
  assert.equal(fixture.messageCache({ workspaceId: 'ws-a', conversationId: 'conv-a' })[0].content, 'page-b request',
    'the sibling page still has its own transcript');

  // 排队行属于另一条分页时仍然可见（而不是被过滤隐形）
  fixture.state.viewedConversationBranchNodePath = ['root-node', 'page-a'];
  fixture.state.runtimeConversationBranchNodePath = ['root-node', 'page-a'];
  fixture.state.activeConversationBranchId = 'page-a';
  fixture.state.runtimeConversationBranchId = 'page-a';
  const target = { workspaceId: 'ws-a', conversationId: 'conv-a' };
  fixture.state.nextQueue = ['queued on page-b'];
  fixture.state.nextQueueRequests = [{
    text: 'queued on page-b',
    target: { workspaceId: 'ws-a', conversationId: 'conv-a' },
    branchPath: 'page-b',
    queueItemId: 'queue-b',
    backendManaged: true,
    provenance: 'backend-follow-up'
  }];
  assert.deepEqual(fixture.queueIndexes(target), [0], 'a queued row bound to another page stays visible for the conversation');
  assert.equal(fixture.queueMismatch(target, fixture.state.nextQueueRequests[0]), true,
    'the row is flagged as waiting for its own page instead of being silently rerouted');

  // dev-0.6.4: 未进入对话的排队输入只显示在队列面板，绝不画进对话区
  fixture.state.renderedChatMessages = [];
  fixture.els['chat-area'].innerHTML = '';
  fixture.state.nextQueue = ['queued on page-a'];
  fixture.state.nextQueueRequests = [{
    text: 'queued on page-a',
    target: { workspaceId: 'ws-a', conversationId: 'conv-a' },
    branchPath: 'page-a',
    queueItemId: 'queue-a',
    backendManaged: true,
    provenance: 'backend-follow-up'
  }];
  assert.doesNotMatch(source, /renderPendingQueuedUserMessages|queue-pending-badge/,
    'queued input never renders inline in the conversation area; only the queue panel shows it');

  // Guide 时间线只保留复制按钮
  const guideHtml = fixture.guideHtml({
    guide: { clientMessageId: 'client-1', guideId: 'guide-1', content: 'guide body', status: 'applied', runId: 'run-1' }
  });
  assert.match(guideHtml, /copyMessageText/, 'guide card keeps the copy action');
  assert.doesNotMatch(guideHtml, /editUserMessage/, 'guide card no longer offers an edit action');

  // 分页不重写排队行捕获的分支
  const rebind = functionSource(source, 'rebindQueueToRuntimeBranch');
  assert.doesNotMatch(rebind, /request\.branchPath\s*=/, 'activating a page never rebinds queued input to another branch');
  const submitEdit = source.slice(source.indexOf('window.submitUserMessageEdit = async function'), source.indexOf('window.switchConversationBranch = async function'));
  assert.doesNotMatch(submitEdit, /setBackendQueueForTarget\(\{ steering: \[\], followUp: \[\] \}/,
    'creating a page no longer wipes the queued input projection');
}

// --- 3. 真实 Agent：新分页拿到全新全对话 id，Build 绑定自己的分支 ----------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dev064-identity-'));
  try {
    const agent = new Agent(root);
    agent.createInternalWorkspace('identity-workspace');
    agent.setConversation('identity-conversation');
    agent.chatMessages = [
      { role: 'user', content: 'root request', mode: 'Build', model: agent.model, timestamp: 'a' },
      { role: 'assistant', content: 'root answer', mode: 'Build', model: agent.model, timestamp: 'b' },
    ];
    agent.history = agent.chatMessages.map(message => ({ role: message.role, content: message.content }));
    agent.flushConversationState();
    const base = agent.getConversationSnapshot('identity-conversation');
    const sourceBranchId = String(base.runtimeBranchId || base.activeBranchId);
    const branched = agent.branchConversation('identity-conversation', 0, 'edited root request', {
      messageId: base.chatMessages[0].messageId,
    });
    const editedBranchId = String(branched.activeBranchId || '');
    assert.ok(editedBranchId && editedBranchId !== sourceBranchId, 'the new page mints a brand-new branch node id');
    assert.notEqual(
      branchConversationIdentity('identity-conversation', sourceBranchId),
      branchConversationIdentity('identity-conversation', editedBranchId),
      'provider session sequence ids are fully split between the old and the new branch',
    );
    const run = agent.beginConversationWorkRun('identity-run', { workspaceId: 'ws', conversationId: 'identity-conversation' }, undefined, true);
    assert.equal(String(run.branchNodeId || ''), editedBranchId, 'the Build owns the branch it was started on');
    assert.equal(agent.activeWorkRunBranchId(), editedBranchId,
      'provider session identity binds to the Build owner branch, not to the viewed branch');
    agent.finishConversationWorkRun('identity-run', 'completed');
    assert.equal(agent.activeWorkRunBranchId(), editedBranchId,
      'the branch identity stays stable inside the branch after the Build settles');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('Branch page and queue identity verification passed');
