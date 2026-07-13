const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertLinuxPackageVersion, hasCommand } = require('./release-linux-package-smoke-lib.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const version = require(path.join(repoRoot, 'DESKTOP', 'package.json')).version;
const debPath = path.resolve(process.env.NEWMARK_LINUX_DEB || path.join(repoRoot, 'release', `Newmark-Agent-${version}-amd64.deb`));
const screenshotPath = path.resolve(process.env.NEWMARK_LINUX_GUI_SCREENSHOT || path.join(repoRoot, 'archive', '2026-07-11-linux-deb-extract-gui-smoke.png'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

if (process.platform !== 'linux') {
  console.log('[release-linux-deb-smoke] skipped outside Linux');
  process.exit(0);
}
if (!fs.existsSync(debPath)) throw new Error(`missing deb package: ${debPath}`);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-linux-deb-'));
try {
  run('dpkg-deb', ['--extract', debPath, tempRoot]);
  const installRoot = path.join(tempRoot, 'opt', 'Newmark Agent');
  const executable = path.join(installRoot, 'Newmark Agent');
  const desktopEntry = path.join(tempRoot, 'usr', 'share', 'applications', 'Newmark Agent.desktop');
  const appAsar = path.join(installRoot, 'resources', 'app.asar');
  if (!fs.existsSync(executable) || !(fs.statSync(executable).mode & 0o111)) throw new Error('deb executable missing or not executable');
  if (!fs.existsSync(desktopEntry)) throw new Error('deb desktop entry missing');
  if (!fs.readFileSync(desktopEntry, 'utf8').includes('/opt/Newmark Agent/Newmark Agent')) throw new Error('deb desktop entry has an unexpected Exec target');
  if (!fs.existsSync(appAsar) || fs.statSync(appAsar).size < 1000000) throw new Error('deb app.asar missing or incomplete');
  assertLinuxPackageVersion(executable);
  const guiEnv = { ...process.env, NEWMARK_LINUX_EXE: executable, NEWMARK_LINUX_GUI_SCREENSHOT: screenshotPath };
  const guiScript = path.join(__dirname, 'release-linux-gui-smoke.cjs');
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    run(process.execPath, [guiScript], { cwd: path.resolve(__dirname, '..'), env: guiEnv });
  } else if (hasCommand('xvfb-run')) {
    run('xvfb-run', ['-a', process.execPath, guiScript], { cwd: path.resolve(__dirname, '..'), env: guiEnv });
  } else if (process.env.NEWMARK_ALLOW_HEADLESS_ASSET_SMOKE === '1') {
    console.log('[release-linux-deb-smoke] GUI startup skipped: no display server or xvfb-run; extraction and CLI passed');
  } else {
    throw new Error('DISPLAY/WAYLAND_DISPLAY is not set and xvfb-run is unavailable');
  }
  console.log('[release-linux-deb-smoke] PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
