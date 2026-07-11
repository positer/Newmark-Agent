const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const zipPath = path.join(repoRoot, 'release', 'Newmark-Agent-0.0.5-linux-unpacked-x64.zip');
const screenshotPath = path.join(repoRoot, 'archive', '2026-07-11-linux-unpacked-zip-gui-smoke.png');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

if (process.platform !== 'linux') {
  console.log('[release-linux-unpacked-zip-smoke] skipped outside Linux');
  process.exit(0);
}
if (!fs.existsSync(zipPath)) throw new Error(`missing Linux unpacked zip: ${zipPath}`);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-linux-unpacked-zip-'));
try {
  run('unzip', ['-q', zipPath, '-d', tempRoot]);
  const unpackedRoot = path.join(tempRoot, 'linux-unpacked');
  const executable = path.join(unpackedRoot, 'Newmark Agent');
  const appAsar = path.join(unpackedRoot, 'resources', 'app.asar');
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw new Error('zip executable missing');
  if (!(fs.statSync(executable).mode & 0o111)) throw new Error('zip executable permission missing');
  if (!fs.existsSync(appAsar) || fs.statSync(appAsar).size < 1000000) throw new Error('zip app.asar missing or incomplete');
  run(process.execPath, [path.join(__dirname, 'release-linux-gui-smoke.cjs')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NEWMARK_LINUX_EXE: executable,
      NEWMARK_LINUX_GUI_SCREENSHOT: screenshotPath,
    },
  });
  console.log('[release-linux-unpacked-zip-smoke] PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
