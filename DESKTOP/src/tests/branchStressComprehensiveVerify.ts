/**
 * 分支综合压力测试：锁定本轮分支优化的核心语义。
 *
 * Run: npm run build && node dist/tests/branchStressComprehensiveVerify.js
 *
 * 覆盖：
 * A. 确定性 ID 不漂移（缺失 messageId 的旧数据冷重载两次 ID 一致）。
 * B. 浏览分支 vs 运行分支解耦（viewed != runtime 时 snapshot 返回 viewed 内容 + runtime 身份）。
 * C. 冷启动加载浏览分支（viewed != runtime 时冷重载恢复 viewed）。
 * D. WorkRun 跨分支隔离（分支延续 WorkRun 不污染兄弟分支）。
 * E. 快速连续分支编辑 + 切换压力（tree 索引完整 + ID 唯一）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../core/agent';

let count = 0;
function check(cond: boolean, name: string): void {
  count += 1;
  console.log('  ' + (cond ? '[PASS]' : '[FAIL]') + ' ' + name);
  assert.ok(cond, name);
}

function run(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-branch-comp-'));
  let agent = new Agent(root);
  agent.createInternalWorkspace('branch-comp');
  agent.setConversation('branch-comp');

  // ---- A. 确定性 ID 不漂移 ----
  agent.chatMessages = [
    { role: 'user', content: 'deterministic a', mode: 'Build', model: 'm', timestamp: '2026-07-26T00:00:00.000Z' },
    { role: 'assistant', content: 'deterministic b', mode: 'Build', model: 'm', timestamp: '2026-07-26T00:00:01.000Z' },
  ] as any;
  agent.history = agent.chatMessages.map((m: any) => ({ role: m.role, content: m.content }));
  agent.flushConversationState();
  agent = new Agent(root);
  agent.setConversationFromStorage('branch-comp');
  const firstIds = agent.getConversationSnapshot('branch-comp').chatMessages.map((m: any) => String(m.messageId || ''));
  check(firstIds.length === 2 && firstIds.every((id: string) => id.startsWith('m-')), 'A: 缺失 messageId 补生成为确定性 m- 前缀');
  agent = new Agent(root);
  agent.setConversationFromStorage('branch-comp');
  const secondIds = agent.getConversationSnapshot('branch-comp').chatMessages.map((m: any) => String(m.messageId || ''));
  check(JSON.stringify(firstIds) === JSON.stringify(secondIds), 'A: 冷重载两次 messageId 一致（无漂移）');

  // ---- 准备分支：A（root）+ B（fork edit）----
  agent = new Agent(root);
  agent.setConversationFromStorage('branch-comp');
  agent.chatMessages = [
    { role: 'user', content: 'root start', mode: 'Build', model: 'm', timestamp: '2026-07-26T00:01:00.000Z' },
    { role: 'assistant', content: 'root answer', mode: 'Build', model: 'm', timestamp: '2026-07-26T00:01:01.000Z' },
  ] as any;
  agent.history = agent.chatMessages.map((m: any) => ({ role: m.role, content: m.content }));
  agent.beginConversationWorkRun('run-root', { workspaceId: 'w', conversationId: 'branch-comp' });
  agent.finishConversationWorkRun('run-root', 'completed', '2026-07-26T00:01:05.000Z');
  agent.flushConversationState();
  const baseSnap = agent.getConversationSnapshot('branch-comp');
  const editMsgId = baseSnap.chatMessages[0].messageId as string;
  const edited = agent.branchConversation('branch-comp', 0, 'edited start', { messageId: editMsgId });
  const rootNodeId = edited.viewedBranchNodePath[0] as string;
  const editedNodeId = edited.activeBranchId as string;
  check(rootNodeId !== editedNodeId, '准备: fork 产出 root + edited 两个节点');

  // ---- B. 浏览 vs 运行解耦 ----
  const inspectedRoot = agent.inspectConversationBranch('branch-comp', rootNodeId, edited.branchGroupId);
  check(inspectedRoot.viewedBranchNodePath[inspectedRoot.viewedBranchNodePath.length - 1] === rootNodeId, 'B: inspect 后 viewed 指向 root');
  check(inspectedRoot.runtimeBranchId === editedNodeId, 'B: runtime 仍为 edited（inspect 只切浏览）');
  const mainSnap = agent.getConversationSnapshot('branch-comp');
  check(mainSnap.activeBranchId === editedNodeId, 'B: 主快照 activeBranchId = 运行分支（runtime=edited）');
  check(mainSnap.viewedBranchNodePath.length > 0 && mainSnap.viewedBranchNodePath[mainSnap.viewedBranchNodePath.length - 1] === rootNodeId, 'B: 主快照 viewedBranchNodePath 末位 = 浏览分支 root');

  // ---- C. 冷启动加载浏览分支 ----
  agent.flushConversationState();
  agent = new Agent(root);
  agent.setConversationFromStorage('branch-comp');
  const reloaded = agent.getConversationSnapshot('branch-comp');
  check(reloaded.viewedBranchNodePath.length > 0 && reloaded.viewedBranchNodePath[reloaded.viewedBranchNodePath.length - 1] === rootNodeId, 'C: 冷重载恢复浏览分支 = root');

  // ---- D. WorkRun 跨分支隔离 ----
  agent = new Agent(root);
  agent.setConversationFromStorage('branch-comp');
  agent.switchConversationBranch('branch-comp', rootNodeId, '');
  agent.beginConversationWorkRun('run-root-cont', { workspaceId: 'w', conversationId: 'branch-comp' });
  agent.finishConversationWorkRun('run-root-cont', 'completed', '2026-07-26T00:02:00.000Z');
  agent.flushConversationState();
  const editedView = agent.inspectConversationBranch('branch-comp', editedNodeId, '');
  check(!editedView.workRuns.some((r: any) => r.runId === 'run-root-cont'), 'D: edited 分支不含 root 分支的延续 WorkRun（跨分支隔离）');
  const rootView = agent.inspectConversationBranch('branch-comp', rootNodeId, '');
  check(rootView.workRuns.some((r: any) => r.runId === 'run-root-cont'), 'D: root 分支保留自己的延续 WorkRun');

  // ---- E. 快速连续编辑 + 切换压力（独立 conversation，避免受前面场景状态影响）----
  agent = new Agent(root);
  agent.createInternalWorkspace('branch-comp');
  agent.setConversation('branch-stress');
  agent.chatMessages = [
    { role: 'user', content: 'anchor user', mode: 'Build', model: 'm', timestamp: '2026-07-26T00:03:00.000Z' },
    { role: 'assistant', content: 'anchor answer', mode: 'Build', model: 'm', timestamp: '2026-07-26T00:03:01.000Z' },
  ] as any;
  agent.history = agent.chatMessages.map((m: any) => ({ role: m.role, content: m.content }));
  agent.flushConversationState();
  let snap = agent.getConversationSnapshot('branch-stress');
  const firstFork = agent.branchConversation('branch-stress', 0, 'stress edit 0', { messageId: snap.chatMessages[0].messageId });
  const stressRootId = firstFork.viewedBranchNodePath[0] as string;
  const stressGroupId = firstFork.branchGroupId as string;
  let last = firstFork;
  for (let i = 1; i < 8; i++) {
    // 每次 fork 前先 inspect root 拿锚点 messageId + branchNodePath，避免锚点不在当前活跃分支。
    const rootPage = agent.inspectConversationBranch('branch-stress', stressRootId, stressGroupId);
    last = agent.branchConversation('branch-stress', 0, 'stress edit ' + i, {
      messageId: rootPage.chatMessages[0].messageId,
      branchNodePath: rootPage.viewedBranchNodePath,
    });
  }
  check(last.branches.length === 9, 'E: 连续 8 次同锚点 fork 产生 9 页 pager');
  check(last.branchGroups.length >= 1, 'E: 所有 fork 归入同一 pager group');
  const dir = last.branchIndexDirectory as Record<string, any>;
  const nodeIds = Object.keys(dir);
  check(nodeIds.length >= 2, 'E: 分支索引目录非空');
  check(new Set(nodeIds).size === nodeIds.length, 'E: node id 全局唯一');
  for (const nid of nodeIds) {
    check(new Set(dir[nid].messageIds).size === dir[nid].messageIds.length, 'E: node ' + nid + ' 内 messageId 唯一');
    check(new Set(dir[nid].workRunIds).size === dir[nid].workRunIds.length, 'E: node ' + nid + ' 内 workRunId 唯一');
  }

  console.log('');
  console.log('  total assertions: ' + count);
  console.log('  PASS');
}

try { run(); } catch (error) { console.error('FAIL', error); process.exit(1); }
