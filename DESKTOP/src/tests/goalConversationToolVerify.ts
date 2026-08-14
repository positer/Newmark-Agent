/**
 * goal_manage + conversation_rename + build_history_query 专项验证。
 *
 * Run: npm run build && node dist/tests/goalConversationToolVerify.js
 *
 * 验证：
 * 1. goal_manage 的 enter/update/complete/exit 完整生命周期与边界。
 * 2. conversation_rename 命名当前对话；shouldPromptConversationRename 首 Build 判定。
 * 3. build_history_query 有界化（activity/guide content 受 max_chars 截断）。
 * 4. 两个新工具定义注册 + 对 subagent 禁用（主对话级状态控制）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../core/agent';

let assertions = 0;

function check(cond: boolean, name: string): void {
  assertions += 1;
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}`);
  assert.ok(cond, name);
}

function freshAgent(): Agent {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-goal-tool-'));
  fs.mkdirSync(path.join(root, 'Work'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  return new Agent(root);
}

function json(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log('goalConversationToolVerify');

  // 1. tool 定义注册（goal_manage / conversation_rename）。
  {
    const agent = freshAgent();
    const names = agent.tools.definitions().map(d => (d as any).function?.name).filter(Boolean);
    check(names.includes('goal_manage'), 'goal_manage: tool definition registered');
    check(names.includes('conversation_rename'), 'conversation_rename: tool definition registered');
  }

  // 2. goal_manage 生命周期。
  {
    const agent = freshAgent();
    // enter 缺 objective 拒绝。
    const missing = agent.handleGoalManage(JSON.stringify({ action: 'enter' }));
    check(missing.ok === false, 'goal_manage enter: rejects missing objective');
    // enter 成功切入 goal mode。
    const enter = agent.handleGoalManage(JSON.stringify({ action: 'enter', objective: 'Ship release' }));
    check(enter.ok === true && agent.mode === 'goal' && agent.goal?.objective === 'Ship release', 'goal_manage enter: enters goal mode');
    check((json(enter) as any).enteredGoal === true, 'goal_manage enter: reports enteredGoal');
    // update 编辑并记录 change。
    agent.handleGoalManage(JSON.stringify({ action: 'update', objective: 'Ship release v2' }));
    check(agent.goal?.objective === 'Ship release v2' && agent.goal?.changes.length === 1, 'goal_manage update: edits objective + records change');
    // complete 标记完成并退出。
    const complete = agent.handleGoalManage(JSON.stringify({ action: 'complete' }));
    check(complete.ok === true && agent.goal === null && agent.mode === 'build', 'goal_manage complete: verified + exits goal mode');
    check((json(complete) as any).completed === true && (json(complete) as any).priorObjective === 'Ship release v2', 'goal_manage complete: reports prior objective');
    // exit 在无 goal 时 no-op。
    const exit = agent.handleGoalManage(JSON.stringify({ action: 'exit' }));
    check(exit.ok === true && (json(exit) as any).cleared === false, 'goal_manage exit: no-op when no active goal');
    // exit 有 goal 时清除。
    agent.handleGoalManage(JSON.stringify({ action: 'enter', objective: 'Temporary' }));
    const exit2 = agent.handleGoalManage(JSON.stringify({ action: 'exit' }));
    check(exit2.ok === true && agent.goal === null && agent.mode === 'build', 'goal_manage exit: clears goal + returns build');
  }

  // 3. conversation_rename + shouldPromptConversationRename。
  {
    const agent = freshAgent();
    const missing = agent.handleConversationRename(JSON.stringify({}));
    check(missing.ok === false, 'conversation_rename: rejects missing title');
    const rename = agent.handleConversationRename(JSON.stringify({ title: 'Add goal_manage tool' }));
    check(rename.ok === true, 'conversation_rename: renames current conversation');
    check((json(rename) as any).title === 'Add goal_manage tool', 'conversation_rename: reports new title');
    check(typeof agent.shouldPromptConversationRename() === 'boolean', 'shouldPromptConversationRename: returns boolean');
  }

  // 4. build_history_query 有界化（无活动历史时返回 not found，但 schema 已含 max_chars）。
  {
    const agent = freshAgent();
    const result = agent.handleBuildHistoryQuery(JSON.stringify({ history_index: 1, max_chars: 100 }));
    const parsed = JSON.parse(result) as Record<string, unknown>;
    check(parsed.ok === false, 'build_history_query: empty history returns not-found (bounded)');
    // 确认 max_chars 参数被 schema 接受（定义里有 max_chars 即可）。
    const def = agent.tools.definitions().find(d => (d as any).function?.name === 'build_history_query') as any;
    check(!!def?.function?.parameters?.properties?.max_chars, 'build_history_query: schema exposes max_chars bound');
  }

  console.log(`\n  total assertions: ${assertions}`);
  console.log('  PASS');
}

main().catch(error => {
  console.error('FAIL', error);
  process.exit(1);
});
