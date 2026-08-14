/**
 * 浏览其他分支时运行分支的接续位置验证。
 *
 * Run: npm run build && node dist/tests/branchContinuationPositionVerify.js
 *
 * 核心语义：当用户浏览分支 A、而运行分支 B 在后台继续产出 WorkRun 时，
 * B 的新 WorkRun 必须接续到 B 的 WorkRun 列表末尾（branchNodeId=B + sequence 递增），
 * 绝不污染浏览分支 A 的 WorkRun 列表。
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

function runIds(runs: any[]): string[] { return runs.map((r: any) => r.runId); }

function run(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-branch-cont-'));
  const agent = new Agent(root);
  agent.createInternalWorkspace('branch-cont');
  agent.setConversation('branch-cont');
  const t = { workspaceId: 'w', conversationId: 'branch-cont' };

  // 初始分支 A（root）：消息 + 完成 run-a1
  agent.chatMessages = [
    { role: 'user', content: 'root start', mode: 'Build', model: 'm', timestamp: '2026-07-26T00:00:00.000Z' },
    { role: 'assistant', content: 'root answer', mode: 'Build', model: 'm', timestamp: '2026-07-26T00:00:01.000Z' },
  ] as any;
  agent.history = agent.chatMessages.map((m: any) => ({ role: m.role, content: m.content }));
  agent.beginConversationWorkRun('run-a1', t);
  agent.finishConversationWorkRun('run-a1', 'completed', '2026-07-26T00:00:05.000Z');
  agent.flushConversationState();

  // fork 分支 B（edited）
  const base = agent.getConversationSnapshot('branch-cont');
  const edited = agent.branchConversation('branch-cont', 0, 'edited', { messageId: base.chatMessages[0].messageId });
  const rootId = edited.viewedBranchNodePath[0] as string;
  const editedId = edited.activeBranchId as string;

  // 切到 B（activeNodeId=edited），B 上 begin run-b1（running，不 finish）
  agent.switchConversationBranch('branch-cont', editedId, '');
  agent.beginConversationWorkRun('run-b1', t);

  // 用户浏览 A（inspect root）：viewed=A，runtime=B
  const viewingA = agent.inspectConversationBranch('branch-cont', rootId, edited.branchGroupId);
  check(viewingA.viewedBranchNodePath[viewingA.viewedBranchNodePath.length - 1] === rootId, '浏览 A：viewed 指向 root');
  check(viewingA.runtimeBranchId === editedId, '浏览 A：runtime 仍为 edited（B）');

  // B 运行分支继续接续：finish run-b1 + begin/finish run-b2
  agent.finishConversationWorkRun('run-b1', 'completed', '2026-07-26T00:01:00.000Z');
  agent.beginConversationWorkRun('run-b2', t);
  agent.finishConversationWorkRun('run-b2', 'completed', '2026-07-26T00:02:00.000Z');
  agent.flushConversationState();

  // 验证：B 的 WorkRun 接续位置正确（run-b1 在前，run-b2 在后，都在 B）
  const bView = agent.inspectConversationBranch('branch-cont', editedId, '');
  const bRunIds = runIds(bView.workRuns);
  check(bRunIds.indexOf('run-b1') >= 0 && bRunIds.indexOf('run-b2') >= 0, 'B 分支含 run-b1 + run-b2');
  check(bRunIds.indexOf('run-b1') < bRunIds.indexOf('run-b2'), 'B 分支接续位置：run-b1 在 run-b2 之前（顺序正确）');
  check(!bRunIds.includes('run-a1'), 'B 分支不含 A 的 run-a1（不串分支）');

  // 验证：浏览分支 A 的 WorkRun 不被 B 的接续污染
  const aView = agent.inspectConversationBranch('branch-cont', rootId, '');
  const aRunIds = runIds(aView.workRuns);
  check(aRunIds.includes('run-a1'), 'A 分支保留 run-a1');
  check(!aRunIds.includes('run-b1') && !aRunIds.includes('run-b2'), 'A 分支不含 B 的接续 WorkRun（浏览不污染）');

  // 反向：切回 A（activeNodeId=A），inspect B（viewed=B，runtime=A），A 继续 run-a2
  agent.switchConversationBranch('branch-cont', rootId, '');
  agent.inspectConversationBranch('branch-cont', editedId, '');
  agent.beginConversationWorkRun('run-a2', t);
  agent.finishConversationWorkRun('run-a2', 'completed', '2026-07-26T00:03:00.000Z');
  agent.flushConversationState();
  const aFinal = agent.inspectConversationBranch('branch-cont', rootId, '');
  const aFinalIds = runIds(aFinal.workRuns);
  check(aFinalIds.indexOf('run-a1') < aFinalIds.indexOf('run-a2'), 'A 分支接续位置：run-a1 在 run-a2 之前（顺序正确）');
  const bFinal = agent.inspectConversationBranch('branch-cont', editedId, '');
  check(!runIds(bFinal.workRuns).includes('run-a2'), 'B 分支不含 A 的接续 run-a2');

  // 冷重载：接续位置持久化
  const reloaded = new Agent(root);
  reloaded.setConversationFromStorage('branch-cont');
  const aReloaded = reloaded.inspectConversationBranch('branch-cont', rootId, '');
  const aReloadedIds = runIds(aReloaded.workRuns);
  check(aReloadedIds.includes('run-a1') && aReloadedIds.includes('run-a2') && aReloadedIds.indexOf('run-a1') < aReloadedIds.indexOf('run-a2'), '冷重载后 A 分支接续位置保持正确');

  console.log('');
  console.log('  total assertions: ' + count);
  console.log('  PASS');
}

try { run(); } catch (error) { console.error('FAIL', error); process.exit(1); }
