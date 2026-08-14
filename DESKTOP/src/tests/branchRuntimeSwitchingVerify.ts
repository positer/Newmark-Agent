/**
 * 已有分支运行时逻辑正确性验证：切换到已有分支后继续对话，
 * 新 WorkRun 归属正确分支、不污染其他分支、冷重载后恢复正确。
 *
 * Run: npm run build && node dist/tests/branchRuntimeSwitchingVerify.js
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-branch-runtime-'));
  let agent = new Agent(root);
  agent.createInternalWorkspace('branch-runtime');
  agent.setConversation('branch-runtime');

  // 初始对话 + 完成一个 WorkRun
  agent.chatMessages = [
    { role: 'user', content: 'root start', mode: 'Build', model: agent.model, timestamp: '2026-07-26T00:00:00.000Z' },
    { role: 'assistant', content: 'root answer', mode: 'Build', model: agent.model, timestamp: '2026-07-26T00:00:01.000Z' },
  ];
  agent.history = agent.chatMessages.map(m => ({ role: m.role, content: m.content }));
  agent.beginConversationWorkRun('run-root', { workspaceId: 'w', conversationId: 'branch-runtime' });
  agent.emitWorkEvent({ type: 'status', content: 'root work', runId: 'run-root', conversationId: 'branch-runtime' });
  agent.finishConversationWorkRun('run-root', 'completed', '2026-07-26T00:00:05.000Z');
  agent.flushConversationState();
  let snap = agent.getConversationSnapshot('branch-runtime');

  // 编辑消息 -> 创建分支 B（clone 原 WorkRun 为新 runId）
  const editMsgId = snap.chatMessages[0].messageId!;
  const edited = agent.branchConversation('branch-runtime', 0, 'edited root', { messageId: editMsgId });
  // 编辑从 root 节点 fork：原分支 A 是 root 节点（path[0]），分支 B 是新 fork 的 active 节点。
  const branchAId = edited.viewedBranchNodePath[0] || snap.activeBranchId;
  const branchBId = edited.activeBranchId;
  check(branchAId !== branchBId, '分支编辑产出不同于原分支的新节点');

  // 分支 B 上完成一个新 WorkRun（clone 后继续）
  agent.beginConversationWorkRun('run-branch-b', { workspaceId: 'w', conversationId: 'branch-runtime' });
  agent.finishConversationWorkRun('run-branch-b', 'completed', '2026-07-26T00:01:00.000Z');
  agent.flushConversationState();

  // 切换到分支 A（原分支）
  const switched = agent.switchConversationBranch('branch-runtime', branchAId, '');
  check(switched.activeBranchId === branchAId, '切回原分支 A 生效');
  check(!switched.workRuns.some(r => r.runId === 'run-branch-b'), '切回 A 后不含 B 的 WorkRun（分支隔离）');
  check(switched.workRuns.some(r => r.runId === 'run-root'), '切回 A 后原 WorkRun 完整恢复');

  // 在分支 A 上继续对话（新 WorkRun 归属 A）
  agent.beginConversationWorkRun('run-branch-a-cont', { workspaceId: 'w', conversationId: 'branch-runtime' });
  agent.emitWorkEvent({ type: 'status', content: 'A continued', runId: 'run-branch-a-cont', conversationId: 'branch-runtime' });
  agent.finishConversationWorkRun('run-branch-a-cont', 'completed', '2026-07-26T00:02:00.000Z');
  agent.flushConversationState();

  // 冷重载：A 的运行时延续 WorkRun 持久化 + B 的 WorkRun 不丢失
  agent = new Agent(root);
  agent.setConversationFromStorage('branch-runtime');
  const reloadedA = agent.inspectConversationBranch('branch-runtime', branchAId, '');
  const reloadedB = agent.inspectConversationBranch('branch-runtime', branchBId, '');
  check(reloadedA.workRuns.some(r => r.runId === 'run-branch-a-cont' && r.status === 'completed'), 'A 的延续 WorkRun 冷重载后保持 completed');
  check(reloadedA.workRuns.some(r => r.runId === 'run-root'), 'A 的原 WorkRun 冷重载后仍存在');
  check(reloadedB.workRuns.some(r => r.runId === 'run-branch-b'), 'B 的 WorkRun 冷重载后仍存在');
  check(!reloadedB.workRuns.some(r => r.runId === 'run-branch-a-cont'), 'B 不接收 A 的延续 WorkRun（跨分支不污染）');

  // 唯一性：每个分支内 WorkRun id 唯一
  const aIds = reloadedA.branchIndexDirectory[branchAId].workRunIds;
  const bIds = reloadedB.branchIndexDirectory[branchBId].workRunIds;
  check(new Set(aIds).size === aIds.length, '分支 A workRunIds 唯一');
  check(new Set(bIds).size === bIds.length, '分支 B workRunIds 唯一');

  console.log('');
  console.log('  total assertions: ' + count);
  console.log('  PASS');
}

try { run(); } catch (error) { console.error('FAIL', error); process.exit(1); }
