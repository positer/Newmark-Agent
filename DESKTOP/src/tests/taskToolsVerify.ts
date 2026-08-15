/**
 * task_read / task_create 专项验证（dev-0.4.3）。
 * 1. 工具定义注册 + policy（build/plan/subagent 面）。
 * 2. task_create create/update/clear 持久化到 conversationPlan。
 * 3. task_read 有界输出。
 * 4. system prompt 不再注入动态清单条目（缓存友好软性提示）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';

let pass = 0, fail = 0;
const check = (cond: boolean, label: string) => {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
};

async function main(): Promise<void> {
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-task-tools-'));
try {
  const agent = new Agent(root);
  const defs = agent.cachedToolDefinitions() as any[];
  const names = defs.map(d => d?.function?.name || '');

  // 1. 注册
  check(names.includes('task_read'), 'task_read: definition registered');
  check(names.includes('task_create'), 'task_create: definition registered');

  // 2. create
  const created = agent.handleTaskCreate(JSON.stringify({ action: 'create', task: 'Fix TUI cursor follow' }));
  const createdJson = JSON.parse(created.output);
  check(created.ok === true && createdJson.ok === true && createdJson.status === 'pending', 'task_create: create appends pending item');
  check(agent.conversationPlan.items.length === 1, 'task_create: conversationPlan persisted (1 item)');

  // 3. update by id
  const updated = agent.handleTaskCreate(JSON.stringify({ action: 'update', id: createdJson.id, status: 'in_progress' }));
  check(updated.ok === true && agent.conversationPlan.items[0].status === 'in_progress', 'task_create: update by id changes status');

  // 4. update invalid status
  const bad = agent.handleTaskCreate(JSON.stringify({ action: 'update', id: createdJson.id, status: 'bogus' }));
  check(bad.ok === false, 'task_create: invalid status rejected');

  // 5. task_read bounded
  const read = agent.handleTaskRead();
  const readJson = JSON.parse(read.output);
  check(read.ok === true && readJson.total === 1 && readJson.unfinished === 1, 'task_read: reports total/unfinished');
  check(readJson.items[0].task === 'Fix TUI cursor follow', 'task_read: item text round-trips');

  // 6. done + clear
  agent.handleTaskCreate(JSON.stringify({ action: 'update', id: createdJson.id, status: 'done' }));
  const cleared = agent.handleTaskCreate(JSON.stringify({ action: 'clear' }));
  const clearedJson = JSON.parse(cleared.output);
  check(clearedJson.ok === true && clearedJson.removed === 1 && agent.conversationPlan.items.length === 0, 'task_create: clear removes done items');

  // 7. system prompt 缓存友好：注入未完成项后 system prompt 不含清单条目文本
  agent.handleTaskCreate(JSON.stringify({ action: 'create', task: 'UNIQUE-CHECKLIST-TOKEN-XYZ' }));
  const sys = (agent as any).buildSystemPrompt();
  check(!sys.includes('UNIQUE-CHECKLIST-TOKEN-XYZ'), 'system prompt: dynamic checklist items NOT injected (cache stable)');

  // 8. policy：plan 模式 task_read 允许、task_create 拒绝
  const { evaluateToolPolicy } = await import('../core/toolPolicy.js');
  check(evaluateToolPolicy({ name: 'task_read', mode: 'plan' }).allowed === true, 'policy: plan mode allows task_read');
  check(evaluateToolPolicy({ name: 'task_create', mode: 'plan' }).allowed === false, 'policy: plan mode blocks task_create');
  check(evaluateToolPolicy({ name: 'task_read', mode: 'build' }).allowed === true, 'policy: build allows task_read');
  check(evaluateToolPolicy({ name: 'task_create', mode: 'build' }).allowed === true, 'policy: build allows task_create');

  // 9. background guard
  const bg = await (agent as any).handleBackgroundTool(JSON.stringify({ tool: 'task_create', args: { action: 'create', task: 'x' } }));
  check(bg.ok === false && String(bg.output).includes('control tools'), 'background_tool: task_create rejected as control tool');

  console.log(`\ntask-tools verify: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
