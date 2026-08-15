'use strict';

/**
 * dev-0.4.2 沙盒内删除安全压力测试（deletion-safety-stress）
 *
 * 覆盖 dev-0.4.2 落地的「允许删除、禁止脚本/命令批量删除、仅在 Agent 监管下删除」
 * 安全边界。全部在一次性临时沙盒根内运行，不触碰真实用户配置、工作区或 Program Files。
 *
 * 运行：node scripts/deletion-safety-stress.cjs
 * 依赖：npm run build（需先编译 dist）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateDeletionGuard } = require('../dist/core/toolPolicy.js');
const { ToolExecutor } = require('../dist/tools/index.js');
const { ConfigManager } = require('../dist/core/config.js');
const { Agent } = require('../dist/core/agent.js');

let assertions = 0;
let failures = 0;

function check(condition, label, detail = '') {
  assertions += 1;
  if (condition) {
    console.log(`[deletion-safety] PASS ${label}`);
  } else {
    failures += 1;
    console.log(`[deletion-safety] FAIL ${label}${detail ? ': ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. evaluateDeletionGuard 对抗矩阵
// ---------------------------------------------------------------------------

/** 必须被硬性拦截的批量删除命令（跨 POSIX / PowerShell / cmd，含大小写、多空格、引号、换行）。 */
const BLOCKED_COMMANDS = [
  // 递归删除（目录整体删除 = 批量删除目录内容）
  'rm -rf node_modules',
  'rm -fr dist',
  'rm -r build',
  'rm -R build',
  'rm -Rf ./dist',
  'rm --recursive build',
  'RM -RF BUILD',
  'rm  -rf  dir',
  'Remove-Item -Recurse -Force build',
  'Remove-Item -Recurse build',
  'Remove-Item -r build',
  'Remove-Item -Force -Recurse build',
  'Remove-Item -Recurse C:\\temp',
  'rd /s /q build',
  'rd /S build',
  'rmdir /s build',
  'rmdir -r build',
  'del /s /q build',
  'del /S build',
  'rm -rf /',
  'Remove-Item -Recurse -Force C:\\',
  // 通配符批量删除
  'rm *.log',
  'rm *.txt',
  'del *.tmp',
  'erase *.bak',
  'Remove-Item *.log',
  'rm dir/*.js',
  'rm ?.txt',
  'rm -f *.log',
  'rm "*.log"',
  'del *',
  // 循环批量删除
  'for f in *.txt; do rm $f; done',
  'foreach ($f in Get-ChildItem) { Remove-Item $f }',
  'for f in *.txt; do rm "$f"; done',
  'while read f; do rm $f; done',
  'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
  'for x in a b c; do del $x; done',
  // find / xargs 批量删除
  'find . -name "*.log" -delete',
  'find . -type f -exec rm {} \\;',
  'find . -name "*.tmp" -exec rm {} +',
  'ls | xargs rm',
  'find . -delete',
  'xargs rm < list.txt',
  'find . -name "*.log" -exec rm -rf {} \\;',
  // 管道接收端批量删除
  'Get-ChildItem | Remove-Item',
  'ls | rm',
  'Get-ChildItem *.txt | Remove-Item -Force',
  'Get-ChildItem -Recurse | Remove-Item',
  // 多目标列举
  'rm a.txt b.txt',
  'del a.txt b.txt c.txt',
  'Remove-Item a.txt, b.txt',
  'rm -f a.txt b.txt',
  // 多语句删除
  'rm a.txt && rm b.txt',
  'rm a.txt; rm b.txt',
  'rm a.txt && del b.txt',
  'rm a.txt ; rm b.txt ; rm c.txt',
  'rm a.txt\nrm b.txt',
];

/** 必须放行的单文件删除 / 非删除命令（避免误伤）。 */
const ALLOWED_COMMANDS = [
  // 单文件删除（无递归/通配符/循环/管道/多目标/多语句）
  'rm file.txt',
  'rm -f file.txt',
  'rm --force file.txt',
  'rm -i file.txt',
  'del file.txt',
  'del /f file.txt',
  'Remove-Item file.txt',
  'Remove-Item -Force file.txt',
  'rm ./file.txt',
  'rm "file with spaces.txt"',
  'rmdir empty-dir',
  'rmdir empty-dir-two',
  // 非删除命令
  'echo hello',
  'echo "rm file.txt"',
  'echo "del /s build"',
  'git status',
  'npm run build',
  'Get-ChildItem *.txt',
  'ls -la',
  'cat file.txt',
  'grep pattern file.txt',
  'git clean -n',
  'rm',
];

function runGuardMatrix() {
  console.log('\n== 1. evaluateDeletionGuard 对抗矩阵 ==');
  for (const cmd of BLOCKED_COMMANDS) {
    const decision = evaluateDeletionGuard(cmd);
    check(decision.blocked === true, `blocked: ${JSON.stringify(cmd)}`, JSON.stringify(decision));
    check(typeof decision.reason === 'string' && decision.reason.includes('deletion guard'), `blocked reason: ${JSON.stringify(cmd)}`);
  }
  for (const cmd of ALLOWED_COMMANDS) {
    const decision = evaluateDeletionGuard(cmd);
    check(decision.blocked === false, `allowed: ${JSON.stringify(cmd)}`, JSON.stringify(decision));
  }
}

// ---------------------------------------------------------------------------
// 2. evaluateDeletionGuard 迭代稳定性（确定性 / 无状态泄漏 / 幂等）
// ---------------------------------------------------------------------------

function runGuardStability() {
  console.log('\n== 2. evaluateDeletionGuard 迭代稳定性 ==');
  const ITERATIONS = 200;
  const sample = ['rm -rf node_modules', 'rm *.log', 'for f in *.txt; do rm $f; done', 'Get-ChildItem | Remove-Item', 'rm file.txt', 'echo hello'];
  const reference = new Map(sample.map(cmd => [cmd, evaluateDeletionGuard(cmd)]));
  let stable = true;
  for (let i = 0; i < ITERATIONS; i += 1) {
    for (const cmd of sample) {
      const now = evaluateDeletionGuard(cmd);
      const ref = reference.get(cmd);
      if (now.blocked !== ref.blocked || now.reason !== ref.reason) {
        stable = false;
        break;
      }
    }
    if (!stable) break;
  }
  check(stable, `guard 决策在 ${ITERATIONS} 次迭代内字节级稳定（纯函数、无状态泄漏）`);
  const empty = evaluateDeletionGuard('   ');
  check(empty.blocked === false, '空白命令放行');
  const nonDeletion = evaluateDeletionGuard('form.txt is not a deletion command');
  check(nonDeletion.blocked === false, '含 "rm" 子串的普通文本不被误判（form.txt）');
}

// ---------------------------------------------------------------------------
// 3. delete_file 工具 + bash 端到端拦截（沙盒内）
// ---------------------------------------------------------------------------

async function runToolSandbox(sandboxRoot) {
  console.log('\n== 3. delete_file 工具 + bash 端到端拦截（沙盒内） ==');
  const ws = path.join(sandboxRoot, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  const cfg = new ConfigManager(path.join(sandboxRoot, 'config'));
  const tools = new ToolExecutor(ws, cfg);

  // 受监管单文件删除
  fs.writeFileSync(path.join(ws, 'one.txt'), 'x');
  fs.writeFileSync(path.join(ws, 'two.txt'), 'y');
  const delOk = await tools.execute('delete_file', JSON.stringify({ path: path.join(ws, 'one.txt') }), ws);
  check(delOk.includes('OK') && !fs.existsSync(path.join(ws, 'one.txt')), 'delete_file: 单文件删除成功且文件消失');

  // 目录删除拒绝
  fs.mkdirSync(path.join(ws, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'dir', 'child.txt'), 'z');
  const delDir = await tools.execute('delete_file', JSON.stringify({ path: path.join(ws, 'dir') }), ws);
  check(delDir.includes('Refused') && fs.existsSync(path.join(ws, 'dir', 'child.txt')), 'delete_file: 目录删除被拒绝且内容保留');

  // 通配符拒绝
  const delWild = await tools.execute('delete_file', JSON.stringify({ path: path.join(ws, '*.txt') }), ws);
  check(delWild.includes('Refused') && fs.existsSync(path.join(ws, 'two.txt')), 'delete_file: 通配符路径被拒绝');

  // 不存在的文件
  const delMissing = await tools.execute('delete_file', JSON.stringify({ path: path.join(ws, 'nope.txt') }), ws);
  check(delMissing.startsWith('[delete_file]'), 'delete_file: 不存在的文件返回受控错误');

  // bash 端到端：批量删除被硬性拦截（guard 在 bash 执行前生效）。
  // bash 工具的工作区根被映射为虚拟 `/`，命令内使用 POSIX 虚拟路径。
  const bashRecursive = await tools.execute('bash', JSON.stringify({ command: 'rm -rf /dir' }), ws);
  check(bashRecursive.includes('deletion guard'), 'bash: rm -rf 被硬性拦截');
  check(fs.existsSync(path.join(ws, 'dir', 'child.txt')), 'bash: 拦截后目录内容未被删除');

  const bashWildcard = await tools.execute('bash', JSON.stringify({ command: 'rm /*.txt' }), ws);
  check(bashWildcard.includes('deletion guard') && fs.existsSync(path.join(ws, 'two.txt')), 'bash: rm 通配符被硬性拦截');

  // bash 单文件删除放行（等价于 delete_file，保持兼容）
  const bashSingle = await tools.execute('bash', JSON.stringify({ command: 'rm /two.txt' }), ws);
  check(!bashSingle.includes('deletion guard') && !fs.existsSync(path.join(ws, 'two.txt')), 'bash: 单文件 rm 放行且成功删除', 'bashSingle=' + JSON.stringify(bashSingle));

  // 受监管通道完整性：剩余文件被 delete_file 逐个清理
  fs.writeFileSync(path.join(ws, 'three.txt'), 'w');
  fs.writeFileSync(path.join(ws, 'four.txt'), 'v');
  const delThree = await tools.execute('delete_file', JSON.stringify({ path: path.join(ws, 'three.txt') }), ws);
  const delFour = await tools.execute('delete_file', JSON.stringify({ path: path.join(ws, 'four.txt') }), ws);
  check(delThree.includes('OK') && delFour.includes('OK') && fs.readdirSync(ws).filter(n => n.endsWith('.txt')).length === 0, 'delete_file: 逐个删除后无残留 .txt');
}

// ---------------------------------------------------------------------------
// 4. 系统 prompt 缓存命中压力（静态删除安全文本不破坏前缀缓存）
// ---------------------------------------------------------------------------

function runPromptCache(sandboxRoot) {
  console.log('\n== 4. 系统 prompt 缓存命中压力 ==');
  const agentRoot = path.join(sandboxRoot, 'agent');
  fs.mkdirSync(agentRoot, { recursive: true });
  const agent = new Agent(agentRoot, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: 'cache-probe' });
  agent.workspace.current = null;

  const first = agent.buildSystemPrompt();
  check(first.includes('delete_file') && first.includes('Deletion safety'), 'buildSystemPrompt: 含 delete_file 工具与 Deletion safety 软性规则');

  // 多轮反复调用 + history/linkedPlan 扰动后仍字节级稳定
  let stable = true;
  for (let i = 0; i < 300; i += 1) {
    agent.history.push({ role: 'user', content: `cache-probe-${i}` });
    agent.linkedPlan = { markdown: `plan-${i}`, revision: i };
    if (agent.buildSystemPrompt() !== first) { stable = false; break; }
  }
  check(stable, 'buildSystemPrompt: 300 轮 history/linkedPlan 扰动后字节级稳定（缓存命中保持）');

  // 工具定义缓存稳定且含 delete_file
  const defs1 = agent.cachedToolDefinitions();
  const defs2 = agent.cachedToolDefinitions();
  check(defs1 === defs2, 'cachedToolDefinitions: 同一实例缓存命中（引用稳定）');
  const names = defs1.map(d => d && d.function && d.function.name).filter(Boolean);
  check(names.includes('delete_file'), 'cachedToolDefinitions: 含 delete_file 工具定义');
}

// ---------------------------------------------------------------------------
// 5. 沙盒隔离与清理验证
// ---------------------------------------------------------------------------

function runSandboxIsolation(sandboxRoot) {
  console.log('\n== 5. 沙盒隔离与清理 ==');
  const realUserRoot = path.join(os.homedir(), '.Newmark');
  check(!realUserRoot || !fs.existsSync(path.join(sandboxRoot, '..', '.Newmark-config-probe')), '测试仅在临时沙盒根内操作');
  check(sandboxRoot.startsWith(os.tmpdir()), '沙盒根位于系统临时目录');
}

// ---------------------------------------------------------------------------

async function main() {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-deletion-safety-'));
  console.log(`[deletion-safety] sandbox: ${sandboxRoot}`);
  try {
    runGuardMatrix();
    runGuardStability();
    await runToolSandbox(sandboxRoot);
    runPromptCache(sandboxRoot);
    runSandboxIsolation(sandboxRoot);
  } finally {
    try { fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (err) {
      console.log(`[deletion-safety] WARN sandbox cleanup: ${err && err.message}`);
    }
  }
  const gone = !fs.existsSync(sandboxRoot);
  check(gone, '沙盒根已清理、无残留');
  console.log(`\n[deletion-safety] 结果：${assertions - failures}/${assertions} PASS，${failures} FAIL`);
  if (failures > 0) {
    console.log('[deletion-safety] 存在失败断言，进程以非零退出。');
    process.exitCode = 1;
  } else {
    console.log('[deletion-safety] 全部通过。');
  }
}

main().catch((err) => {
  console.error('[deletion-safety] 未捕获异常:', err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
