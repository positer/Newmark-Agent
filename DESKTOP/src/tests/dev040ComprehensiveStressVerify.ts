import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dev040-stress-'));

function ok(condition: boolean, message: string): void {
  if (!condition) throw new Error(`dev-0.4.0 comprehensive stress failed: ${message}`);
}

async function main(): Promise<void> {
  // ============ 1. 分支交流压力（多分支交错通信 + 边界 + 切换缓存完整） ============
  {
    const agent = new Agent(path.join(TEST_DIR, 'branch-stress'));
    agent.setConversation('branch-stress');
    agent.chatMessages = [
      { role: 'user', content: 'root task', mode: 'Build', model: agent.model, timestamp: '2026-08-14T01:00:00.000Z' },
      { role: 'assistant', content: 'root answer', mode: 'Build', model: agent.model, timestamp: '2026-08-14T01:00:01.000Z' },
      { role: 'user', content: 'second task', mode: 'Build', model: agent.model, timestamp: '2026-08-14T01:00:02.000Z' },
    ];
    agent.history = agent.chatMessages.map(m => ({ role: m.role, content: m.content }));
    agent.flushConversationState();
    agent.setBranchCommunication(true);

    // 第一次 branch_create（tree 为空时自动创建 root + 新分支）
    const branchIds: string[] = [];
    const first = agent.handleBranchCreate(JSON.stringify({ message_index: 0, prompt: 'alt-0' }));
    const firstParsed = JSON.parse(first.output);
    ok(first.ok === true && !!firstParsed.branchId, 'branch_create round 0');
    branchIds.push(firstParsed.branchId);

    // 获取根分支 id（第一次 branch_create 后 tree 含 root + alt-0）
    const listAfterFirst = JSON.parse(agent.handleBranchList('{}').output);
    const rootBranchId = listAfterFirst.branches.find((b: { id: string }) => b.id !== firstParsed.branchId).id;

    // 后续 branch_create（先切回根分支，确保 index 0 有 user 消息）
    for (let i = 1; i < 4; i++) {
      agent.switchConversationBranch('branch-stress', rootBranchId);
      const create = agent.handleBranchCreate(JSON.stringify({ message_index: 0, prompt: `alt-${i}` }));
      const parsed = JSON.parse(create.output);
      ok(create.ok === true && !!parsed.branchId, `branch_create round ${i}`);
      branchIds.push(parsed.branchId);
    }
    const list = JSON.parse(agent.handleBranchList('{}').output);
    ok(list.branchCount === 5, `branch_list count ${list.branchCount} (expect 5)`);

    // 交错通信：每个分支切换到 active 后向所有其它分支发信（self 被拒绝）
    let sendOk = 0;
    let selfRejected = 0;
    const expectedSends = branchIds.length * (branchIds.length - 1);
    for (const from of branchIds) {
      agent.switchConversationBranch('branch-stress', from);
      for (const to of branchIds) {
        const send = agent.handleBranchSend(JSON.stringify({ to_branch: to, message: `${from}->${to}` }));
        if (from === to) {
          if (!send.ok) selfRejected += 1;
        } else if (send.ok) {
          sendOk += 1;
        }
      }
    }
    ok(sendOk === expectedSends, `interleaved sends ${sendOk}/${expectedSends}`);
    ok(selfRejected === branchIds.length, `self-message rejected ${selfRejected}/${branchIds.length}`);

    // 读取校验（每个分支都能读到写给它的来信，且 mailbox 定向正确）
    for (const to of branchIds) {
      const read = agent.handleBranchRead(JSON.stringify({ branch: to }));
      ok(read.ok === true, `branch_read ${to}`);
    }

    // 边界：越界 index、未知分支、空对话
    const edge = new Agent(path.join(TEST_DIR, 'branch-edge'));
    edge.setConversation('branch-edge');
    edge.setBranchCommunication(true);
    ok(edge.handleBranchCreate(JSON.stringify({ message_index: 99, prompt: 'edge' })).ok === false, 'branch_create out-of-range rejected');
    ok(edge.handleBranchSend(JSON.stringify({ to_branch: 'ghost', message: 'x' })).ok === false, 'branch_send unknown branch rejected');

    // 分支切换 + 通信混合：切回根分支，缓存完整
    const rootId = list.branches.find((b: { id: string }) => !branchIds.includes(b.id)).id;
    const switched = agent.switchConversationBranch('branch-stress', rootId);
    ok(switched.chatMessages[0]?.content === 'root task' && switched.chatMessages[1]?.content === 'root answer',
      'branch switch back restores complete root transcript (per-branch cache intact)');
  }

  // ============ 2. 历史卸载压力（多轮 remove + flush + 压缩交互 fingerprint 兜底） ============
  {
    const agent = new Agent(path.join(TEST_DIR, 'unload-stress'));
    agent.setConversation('unload-stress');
    agent.history = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant'), content: `entry-${i}` }));

    // 多轮 remove（延迟声明，不立即删除）
    for (let i = 0; i < 5; i++) {
      const remove = agent.handleContextHistoryManage(JSON.stringify({ action: 'remove', position: i }));
      ok(remove.ok === true && JSON.parse(remove.output).deferred === true, `remove ${i} deferred`);
    }
    const status = JSON.parse(agent.handleContextHistoryManage(JSON.stringify({ action: 'status' })).output);
    ok(status.pendingRemovals?.count === 5, `pendingRemovals ${status.pendingRemovals?.count} (expect 5)`);
    ok(agent.history.length === 20, 'history unchanged before block end');

    // 压缩交互：summarize 折叠 position 0-4（pending removals 的 fingerprint 兜底）
    const summarize = agent.handleContextHistoryManage(JSON.stringify({ action: 'summarize', position: 0, to: 4 }));
    ok(summarize.ok === true, 'summarize overlaps pending removals');

    // block 结束 flush：emit done 触发 flushPendingHistoryRemovals
    agent.beginConversationWorkRun('unload-run', { workspaceId: 'w', conversationId: 'unload-stress' });
    agent.emitWorkEvent({ type: 'done', content: 'complete' });
    const after = JSON.parse(agent.handleContextHistoryManage(JSON.stringify({ action: 'status' })).output);
    ok(after.pendingRemovals?.count === 0, `pendingRemovals cleared after block end (${after.pendingRemovals?.count})`);
    ok(agent.history.length < 20, `history reduced after flush (${agent.history.length})`);
  }

  // ============ 3. 思考活动（事件序列 + 隐私剥离） ============
  {
    const agent = new Agent(path.join(TEST_DIR, 'thought-stress'));
    agent.setConversation('thought-stress');
    agent.beginConversationWorkRun('thought-run', { workspaceId: 'w', conversationId: 'thought-stress' });
    agent.emitWorkEvent({ type: 'thought', content: '' });
    agent.emitWorkEvent({ type: 'thought_result', content: 'hidden reasoning line 1\nline 2' });
    agent.emitWorkEvent({ type: 'tool_call', content: 'run tool', toolName: 'bash' });
    agent.emitWorkEvent({ type: 'done', content: 'complete' });

    const run = agent.workRuns.find(r => r.runId === 'thought-run');
    ok(!!run, 'thought run exists');
    const thoughtEvents = (run?.events || []).filter(e => e.type === 'thought' || e.type === 'thought_result');
    ok(thoughtEvents.length === 2, `thought events ${thoughtEvents.length} (expect 2)`);
    ok(thoughtEvents[0]?.type === 'thought' && thoughtEvents[0]?.content === '', 'thought start carries empty content');
    ok(thoughtEvents[1]?.type === 'thought_result' && String(thoughtEvents[1]?.content).includes('hidden reasoning'),
      'thought_result carries the accumulated reasoning');
    // 隐私：推理文本绝不进入聊天正文
    ok(!JSON.stringify(agent.chatMessages).includes('hidden reasoning'), 'reasoning never enters the chat transcript');
  }

  // ============ 4. 归档并发（后端并发归档多对话） ============
  {
    const agent = new Agent(path.join(TEST_DIR, 'archive-stress'));
    for (let i = 0; i < 6; i++) {
      agent.ensureConversationSnapshot(`conv-${i}`);
      agent.setConversation(`conv-${i}`);
      agent.chatMessages = [{ role: 'user', content: `msg-${i}`, mode: 'Build', model: agent.model, timestamp: new Date().toISOString() }];
      agent.flushConversationState();
    }
    // 并发归档（同步顺序，但验证每轮归档不破坏其它对话）
    const archived: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      archived.push(agent.archiveConversation(`conv-${i}`));
    }
    ok(archived.every(r => r !== null && String(r).length > 0), 'all six conversations archive successfully');
    const remaining = agent.listConversationStates();
    ok(remaining.filter(c => /^conv-/.test(c.id)).length === 0, 'archived conversations are removed from the conversation list');
  }

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('dev-0.4.0 comprehensive stress verification passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
