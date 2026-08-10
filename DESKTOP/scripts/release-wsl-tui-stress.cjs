const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WSL_PATH_TIMEOUT_MS = Math.max(1_000, Number(process.env.NEWMARK_WSL_PATH_TIMEOUT_MS) || 15_000);
const WSL_STRESS_TIMEOUT_MS = Math.max(5_000, Number(process.env.NEWMARK_WSL_STRESS_TIMEOUT_MS) || 120_000);
const WSL_REQUIRED = process.env.NEWMARK_WSL_TUI_REQUIRED === '1';

if (process.platform !== 'win32') {
  process.stdout.write('WSL TUI stress skipped: Windows host required\n');
  process.exit(0);
}

const script = path.resolve(__dirname, 'release-wsl-tui-stress.py').replace(/\\/g, '/');
const converted = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'wslpath', '-u', script], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: WSL_PATH_TIMEOUT_MS,
});
const conversionOutput = `${converted.stderr || ''}\n${converted.stdout || ''}\n${converted.error?.message || ''}`;
const wslUnavailable = !!(converted.error && ['ENOENT', 'ETIMEDOUT'].includes(converted.error.code))
  || /distribution[^\r\n]*(?:not found|could not be found|does not exist|not installed)/i.test(conversionOutput);
if (converted.error || converted.status !== 0) {
  if (wslUnavailable && !WSL_REQUIRED) {
    process.stdout.write(`WSL TUI stress skipped: Ubuntu-24.04 is unavailable (${conversionOutput.trim().slice(0, 240)})\n`);
    process.exit(0);
  }
  process.stderr.write(converted.stderr || converted.stdout || converted.error?.message || 'Unable to resolve WSL stress script path\n');
  process.exit(converted.status ?? 1);
}
const linuxScript = converted.stdout.trim();
const result = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'python3', linuxScript], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  windowsHide: true,
  timeout: WSL_STRESS_TIMEOUT_MS,
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
}
process.exit(result.status ?? 1);
