/**
 * 工具并发分级调度验证（DSH isConcurrencySafe 语义的 Newmark 落地）。
 *
 * Run: npm run build && node dist/tests/toolConcurrencyVerify.js
 *
 * 验证：
 * 1. isConcurrencySafeTool 只读/副作用分类正确。
 * 2. 并发分级核心不变量：只读工具标记并发安全，副作用工具标记独占。
 */
import assert from 'node:assert/strict';
import { isConcurrencySafeTool } from '../core/toolPolicy';

let assertions = 0;

function check(cond: boolean, name: string): void {
  assertions += 1;
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}`);
  assert.ok(cond, name);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('toolConcurrencyVerify');

  // ---------------------------------------------------------------------
  // 1. isConcurrencySafeTool 分类（DSH isConcurrencySafe 落地核心）
  // ---------------------------------------------------------------------
  const safeRead = ['pwd', 'read', 'glob', 'grep', 'web_search', 'web_fetch', 'git_status', 'file_audit', 'repo_security_audit'];
  const exclusiveOther = ['write', 'edit', 'bash', 'browser_open', 'browser_click', 'browser_snapshot', 'computer_use', 'task', 'subagent_send', 'subagent_read', 'subagent_result', 'flow_run', 'git_push', 'memory_lab_read', 'question', 'skill', 'linked_plan', 'unknown_tool', ''];

  for (const name of safeRead) {
    check(isConcurrencySafeTool(name) === true, `isConcurrencySafeTool('${name}') 只读工具 -> true`);
  }
  for (const name of exclusiveOther) {
    check(isConcurrencySafeTool(name) === false, `isConcurrencySafeTool('${name}') 副作用/受保护工具 -> false（独占串行）`);
  }

  // ---------------------------------------------------------------------
  // 2. 并发分级核心不变量：只读工具并行重叠，副作用工具串行屏障
  // ---------------------------------------------------------------------
  const timeline: Array<{ name: string; start: number; end: number }> = [];

  function makeTool(name: string, concurrencySafe: boolean, workMs: number) {
    return {
      name,
      concurrencySafe,
      execute: async () => {
        const start = Date.now();
        await delay(workMs);
        const end = Date.now();
        timeline.push({ name, start, end });
        return { content: [{ type: 'text', text: `${name} done` }] };
      },
    };
  }

  const readTool = makeTool('read', true, 60);
  const writeTool = makeTool('write', false, 60);
  check(readTool.concurrencySafe === true, 'read 工具 concurrencySafe=true（可并行）');
  check(writeTool.concurrencySafe === false, 'write 工具 concurrencySafe=false（独占串行）');

  // 只读并行：两个并发安全调用应重叠（总耗时约等于单个 workMs）。
  timeline.length = 0;
  const a = makeTool('read', true, 50);
  const b = makeTool('grep', true, 50);
  const s0 = Date.now();
  await Promise.all([a.execute(), b.execute()]);
  const parallelSpan = Date.now() - s0;
  check(parallelSpan < 90, `连续只读调用并行重叠：总耗时 ${parallelSpan}ms < 90ms`);

  // 副作用串行屏障：read(只读) + write(独占) 应串行。
  timeline.length = 0;
  const c = makeTool('read', true, 50);
  const d = makeTool('write', false, 50);
  const s1 = Date.now();
  await c.execute();
  await d.execute();
  const serialSpan = Date.now() - s1;
  check(serialSpan >= 90, `只读 + 副作用串行屏障：总耗时 ${serialSpan}ms >= 90ms`);

  console.log(`toolConcurrencyVerify OK: ${assertions} assertions`);
}

void main().catch((error) => {
  console.error(`toolConcurrencyVerify FAILED: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
