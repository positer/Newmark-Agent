'use strict';

/**
 * WSL 交叉压力测试内层（在 Linux/WSL 里直接运行）。
 * 只加载 dist 纯函数模块，正交交叉「删除审查 × 命令链 × 平台 × 场景」，
 * 并对每个用例做多轮确定性复测 + 路径映射交叉验证。
 */

const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const distRoot = path.join(repoRoot, 'DESKTOP', 'dist');
const { evaluateDeletionGuard } = require(path.join(distRoot, 'core', 'toolPolicy.js'));
const { windowsDrivePathToPosix } = require(path.join(distRoot, 'core', 'workspace.js'));

const REPEATS = Number(process.env.NEWMARK_WSL_CROSS_REPEATS || 100);
let assertions = 0;
let failures = 0;

function check(condition, label, detail = '') {
  assertions += 1;
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. 删除审查 × 命令链 × 平台 × 场景 正交交叉矩阵
// ---------------------------------------------------------------------------

// 场景分类：expected=true 表示必须硬性拦截；expected=false 表示必须放行。
const scenarios = [
  { id: 'single-file-allowed', expected: false, cases: [
    ['posix', 'rm file.txt'],
    ['posix', 'rm -f file.txt'],
    ['powershell', 'Remove-Item file.txt'],
    ['powershell', 'ri file.txt'],
    ['cmd', 'del file.txt'],
    ['cmd', 'erase file.txt'],
  ] },
  { id: 'recursive-blocked', expected: true, cases: [
    ['posix', 'rm -rf build'],
    ['posix', 'rm -R build'],
    ['posix', 'rm --recursive build'],
    ['powershell', 'Remove-Item -Recurse build'],
    ['powershell', 'ri -Recurse build'],
    ['cmd', 'del /s build'],
    ['cmd', 'erase /s build'],
    ['cmd', 'rd /s /q build'],
  ] },
  { id: 'wildcard-blocked', expected: true, cases: [
    ['posix', 'rm *.log'],
    ['powershell', 'Remove-Item *.log'],
    ['cmd', 'del *.tmp'],
  ] },
  { id: 'loop-blocked', expected: true, cases: [
    ['posix', 'for f in *.txt; do rm $f; done'],
    ['powershell', 'foreach ($f in Get-ChildItem) { Remove-Item $f }'],
    ['cmd', 'for /f "delims=" %i in (*.txt) do del %i'],
  ] },
  { id: 'find-xargs-blocked', expected: true, cases: [
    ['posix', 'find . -name "*.log" -delete'],
    ['posix', 'find . -type f -exec rm {} \\;'],
    ['posix', 'ls | xargs rm'],
  ] },
  { id: 'pipe-blocked', expected: true, cases: [
    ['posix', 'ls | rm'],
    ['powershell', 'Get-ChildItem | Remove-Item'],
  ] },
  { id: 'multi-target-blocked', expected: true, cases: [
    ['posix', 'rm a.txt b.txt'],
    ['powershell', 'Remove-Item a.txt, b.txt'],
    ['cmd', 'del a.txt b.txt c.txt'],
  ] },
];

// 命令链：把「单删除命令」包装进不同链，验证精准拦截（单删除放行、多语句拦截）。
const commandChains = [
  { id: 'single', wrap: cmd => cmd, multi: false },
  { id: 'and-single', wrap: cmd => `echo ok && ${cmd}`, multi: false },
  { id: 'or-single', wrap: cmd => `echo ok || ${cmd}`, multi: false },
  { id: 'serial-single', wrap: cmd => `echo ok; ${cmd}`, multi: false },
  { id: 'parallel-single', wrap: cmd => `echo ok & ${cmd}`, multi: false },
];

console.log('== 1. deletion guard × command-chain × platform × scenario ==');
for (const scenario of scenarios) {
  for (const [platform, command] of scenario.cases) {
    // 直接场景（不包装命令链）
    for (let i = 0; i < REPEATS; i++) {
      const decision = evaluateDeletionGuard(command);
      if (decision.blocked !== scenario.expected) {
        check(false, `${scenario.id} [${platform}] ${JSON.stringify(command)}`, JSON.stringify(decision));
        break;
      }
      if (i === REPEATS - 1) check(true, `${scenario.id} [${platform}] ${JSON.stringify(command)} (×${REPEATS} 稳定)`);
    }
  }
}

console.log('== 2. command-chain precision for single-file deletion ==');
// 单文件删除 × 命令链：单删除必须放行（无论 &&/||/;/&），多语句必须拦截。
const singleDeletes = [
  ['posix', 'rm file.txt'],
  ['powershell', 'Remove-Item file.txt'],
  ['cmd', 'del file.txt'],
];
for (const [platform, base] of singleDeletes) {
  for (const chain of commandChains) {
    const command = chain.wrap(base);
    for (let i = 0; i < REPEATS; i++) {
      const decision = evaluateDeletionGuard(command);
      if (decision.blocked !== false) {
        check(false, `chain-${chain.id} [${platform}] ${JSON.stringify(command)}`, JSON.stringify(decision));
        break;
      }
      if (i === REPEATS - 1) check(true, `chain-${chain.id} [${platform}] ${JSON.stringify(command)} (×${REPEATS} 放行)`);
    }
  }
}

// 多语句删除 × 命令链：两条删除必须拦截。
console.log('== 3. command-chain precision for multi-statement deletion ==');
const multiDeletes = [
  { id: 'and', command: 'rm a.txt && rm b.txt' },
  { id: 'or', command: 'rm a.txt || rm b.txt' },
  { id: 'serial', command: 'rm a.txt; rm b.txt' },
  { id: 'parallel', command: 'rm a.txt & rm b.txt' },
  { id: 'mixed', command: 'rm a.txt && del b.txt' },
  { id: 'newline', command: 'rm a.txt\nrm b.txt' },
];
for (const item of multiDeletes) {
  for (let i = 0; i < REPEATS; i++) {
    const decision = evaluateDeletionGuard(item.command);
    if (decision.blocked !== true) {
      check(false, `multi-${item.id} ${JSON.stringify(item.command)}`, JSON.stringify(decision));
      break;
    }
    if (i === REPEATS - 1) check(true, `multi-${item.id} ${JSON.stringify(item.command)} (×${REPEATS} 拦截)`);
  }
}

// ---------------------------------------------------------------------------
// 4. WSL 路径映射交叉验证（Windows 盘符 → /mnt/<drive>）
// ---------------------------------------------------------------------------
console.log('== 4. windowsDrivePathToPosix cross mapping ==');
const pathCases = [
  ['C:\\Users\\Test User\\repo', '/mnt/c/Users/Test User/repo'],
  ['D:/work/project', '/mnt/d/work/project'],
  ['C:\\Users\\alice\\secrets\\notes.txt', '/mnt/c/Users/alice/secrets/notes.txt'],
];
for (const [input, expected] of pathCases) {
  check(windowsDrivePathToPosix(input) === expected, `path ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`);
}
check(windowsDrivePathToPosix('/mnt/c/Users/x') === '', 'rejects already-posix path');
check(windowsDrivePathToPosix('relative/file.txt') === '', 'rejects relative path');
check(windowsDrivePathToPosix('C:\\Users\\alice') === '/mnt/c/Users/alice', 'single-segment drive path');

// ---------------------------------------------------------------------------
// 5. git clean 与递归别名（跨平台删除入口）
// ---------------------------------------------------------------------------
console.log('== 5. git-clean / recursive-alias cross platform ==');
for (const [label, command, expected] of [
  ['git clean -fd', 'git clean -fd', true],
  ['git clean -fdx', 'git clean -fdx', true],
  ['git clean --dry-run', 'git clean --dry-run', false],
  ['git clean -n', 'git clean -n', false],
  ['ri -Recurse build', 'ri -Recurse build', true],
  ['erase /s build', 'erase /s build', true],
  ['echo done || rm file.txt', 'echo done || rm file.txt', false],
]) {
  const decision = evaluateDeletionGuard(command);
  check(decision.blocked === expected, `${label} expected=${expected}`, JSON.stringify(decision));
}

console.log(`\n[release-wsl-cross-stress] 结果：${assertions - failures}/${assertions} PASS，${failures} FAIL`);
if (failures > 0) process.exitCode = 1;
