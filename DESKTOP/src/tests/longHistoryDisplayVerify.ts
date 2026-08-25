import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';
import { ConversationKernel } from '../core/conversationKernel';

/**
 * dev-0.5.6 长期历史显示修复回归门。
 *
 * 此前 compressionBuildBlockStart 在无活动 run 时返回 0，导致全部历史被
 * 算进当前 Build Block，上下文显示窗口的长期历史（longHistoryTokens）恒为
 * 0——即使对话已有大量历史。修复后：
 * - 有活动 run：boundary 取活动 run 起点（长期历史 = 之前的消息）；
 * - 无活动 run + 有 run_id 历史：boundary 取最后一个 run 起点之后；
 * - 无活动 run + 无 run_id 历史：全部算长期历史（buildBlockTokens = 0）。
 */

function check(condition: boolean, message: string): void {
  if (condition) console.log(`  [PASS] ${message}`);
  else console.log(`  [FAIL] ${message}`);
  assert.ok(condition, message);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-long-history-'));

try {
  console.log('longHistoryDisplayVerify');

  // 场景 1：无活动 run + 无 run_id 历史 → 全部算长期历史，buildBlock = 0
  const agent1 = new Agent(root);
  agent1.history = [
    { role: 'system', content: 'Stable instructions.' },
    { role: 'user', content: 'Historical task '.repeat(200) },
    { role: 'assistant', content: 'Historical result '.repeat(200) },
  ];
  const window1 = agent1.contextWindow() as {
    longHistoryTokens: number;
    buildBlockTokens: number;
    estimatedTokens: number;
  };
  check(window1.longHistoryTokens > 0, '场景1：无活动 run 时长期历史 > 0（不再恒为 0）');
  check(window1.buildBlockTokens === 0, '场景1：无活动 run 时 buildBlockTokens = 0（没有当前 Build Block）');
  check(window1.longHistoryTokens >= window1.estimatedTokens, '场景1：长期历史覆盖全部历史估算');

  // 场景 2：无活动 run + 有 run_id 历史 → 最后一个 run 起点之前算长期历史
  const agent2 = new Agent(root);
  agent2.history = [
    { role: 'user', content: 'old-1 '.repeat(100), run_id: 'old-run' },
    { role: 'assistant', content: 'old-2 '.repeat(100), run_id: 'old-run' },
    { role: 'user', content: 'recent-unattached-1' },
    { role: 'assistant', content: 'recent-unattached-2' },
  ];
  const window2 = agent2.contextWindow() as {
    longHistoryTokens: number;
    buildBlockTokens: number;
    estimatedTokens: number;
  };
  check(window2.longHistoryTokens > 0, '场景2：无活动 run + 有 run_id 历史 → 长期历史 > 0');
  check(window2.buildBlockTokens > 0, '场景2：无归属的最近消息算当前区块');
  check(
    window2.longHistoryTokens + window2.buildBlockTokens >= window2.estimatedTokens,
    '场景2：长期历史 + 当前区块 ≈ 总估算',
  );

  // 场景 3：有活动 run → 活动 run 起点之前算长期历史（保持原有语义）
  const agent3 = new Agent(root);
  const activeRunId = 'active-run-3';
  agent3.beginConversationWorkRun(activeRunId);
  agent3.history = [
    { role: 'user', content: 'older-1 '.repeat(100), run_id: 'older-run' },
    { role: 'assistant', content: 'older-2 '.repeat(100), run_id: 'older-run' },
    { role: 'user', content: 'active-1 '.repeat(50), run_id: activeRunId },
    { role: 'assistant', content: 'active-2 '.repeat(50), run_id: activeRunId },
  ];
  const window3 = agent3.contextWindow() as {
    longHistoryTokens: number;
    buildBlockTokens: number;
  };
  check(window3.longHistoryTokens > 0, '场景3：有活动 run → 长期历史 = 活动 run 之前');
  check(window3.buildBlockTokens > 0, '场景3：有活动 run → buildBlock = 活动 run 消息');
  check(
    window3.longHistoryTokens > window3.buildBlockTokens,
    '场景3：旧 run 历史（2×100 字符）多于活动 run 区块（2×50 字符）',
  );

  // 场景 4：UI 显示链路——ConversationKernel.snapshot 透传 runner.contextWindow()
  // （真实环境：runner 绑定 workspace，history 从持久化加载）
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-long-history-ws-'));
  const agent4 = new Agent(wsRoot, { agentOnly: true, workspaceRegistryMode: 'detached' });
  agent4.workspace.current = {
    id: 'ws-1',
    name: 'ws-1',
    path: wsRoot,
    isInternal: false,
    hostBinding: '',
    conversationStatePrefix: '',
    icon: '',
    kind: 'local',
  } as never;
  agent4.history = [
    { role: 'user', content: 'old-1 '.repeat(100), run_id: 'old-run' },
    { role: 'assistant', content: 'old-2 '.repeat(100), run_id: 'old-run' },
    { role: 'user', content: 'recent-unattached-1' },
    { role: 'assistant', content: 'recent-unattached-2' },
  ];
  agent4.chatMessages = [
    { role: 'user', content: 'old-1 '.repeat(100), messageId: 'm1', timestamp: '' },
    { role: 'assistant', content: 'old-2 '.repeat(100), messageId: 'm2', timestamp: '' },
    { role: 'user', content: 'recent-unattached-1', messageId: 'm3', timestamp: '' },
    { role: 'assistant', content: 'recent-unattached-2', messageId: 'm4', timestamp: '' },
  ] as never;
  agent4.saveWorkspaceConversationState(true);
  const kernel = new ConversationKernel(wsRoot, agent4 as never, null, {
    createRunner: () => agent4 as never,
  });
  const kernelSnapshot = kernel.snapshot(agent4.activeConversationId) as unknown as {
    contextWindow?: { longHistoryTokens?: number; buildBlockTokens?: number };
    historyMessages?: number;
  };
  check(
    !!kernelSnapshot.contextWindow
      && typeof kernelSnapshot.contextWindow.longHistoryTokens === 'number'
      && kernelSnapshot.contextWindow.longHistoryTokens > 0,
    '场景4：Kernel snapshot.contextWindow.longHistoryTokens > 0（有 workspace 真实链路）',
  );
  check(
    typeof kernelSnapshot.contextWindow?.buildBlockTokens === 'number'
      && kernelSnapshot.contextWindow.buildBlockTokens > 0,
    '场景4：Kernel snapshot.contextWindow.buildBlockTokens > 0（无归属最近消息）',
  );
  check(Number(kernelSnapshot.historyMessages) > 0, '场景4：snapshot.historyMessages > 0（历史已落盘加载）');
  fs.rmSync(wsRoot, { recursive: true, force: true });

  console.log('longHistoryDisplayVerify: all checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}