'use strict';

/**
 * dev-0.4.5 WSL 交叉压力测试（cross stress）
 *
 * 在 WSL Ubuntu-24.04 里跑「删除安全审查 × 命令链 × 跨平台」的正交交叉矩阵，
 * 并在每组合上做多轮确定性复测，验证 Linux 宿主下的纯函数安全边界与 Windows
 * 完全一致。只依赖 dist 里的纯函数模块（toolPolicy.js / workspace.js），不加载
 * 任何原生模块，因此可直接在 WSL 复用 Windows 构建的 dist 运行。
 *
 * 运行（Windows 侧）：
 *   node scripts/release-wsl-cross-stress.cjs [--distro Ubuntu-24.04]
 */

const { spawnSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const distro = process.argv.includes('--distro') ? process.argv[process.argv.indexOf('--distro') + 1] : 'Ubuntu-24.04';
const windowsScriptPath = path.join(__dirname, 'release-wsl-cross-stress-linux.cjs');
const wslScriptPath = windowsScriptPath
  .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
  .replace(/\\/g, '/');

function wslRun(args, options = {}) {
  return spawnSync('wsl.exe', ['-d', distro, '--', ...args], {
    cwd: __dirname,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 300_000,
    stdio: options.stdio || 'pipe',
  });
}

function main() {
  if (process.platform !== 'win32') {
    console.log('[release-wsl-cross-stress] skipped outside Windows (run the inner linux script directly on Linux)');
    return 0;
  }
  const probe = wslRun(['true']);
  if (probe.error || probe.status !== 0) {
    console.log(`[release-wsl-cross-stress] SKIP: WSL distro ${distro} unavailable`);
    return 0;
  }
  const result = wslRun(['node', wslScriptPath], { stdio: 'inherit', timeoutMs: 300_000 });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[release-wsl-cross-stress] ${error.stack || error.message}`);
  process.exitCode = 1;
}
