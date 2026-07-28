const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  process.stdout.write('WSL TUI stress skipped: Windows host required\n');
  process.exit(0);
}

const script = path.resolve(__dirname, 'release-wsl-tui-stress.py').replace(/\\/g, '/');
const converted = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'wslpath', '-u', script], {
  encoding: 'utf8',
  windowsHide: true,
});
if (converted.status !== 0) {
  process.stderr.write(converted.stderr || converted.stdout || 'Unable to resolve WSL stress script path\n');
  process.exit(converted.status ?? 1);
}
const linuxScript = converted.stdout.trim();
const result = spawnSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'python3', linuxScript], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  windowsHide: true,
});
process.exit(result.status ?? 1);
