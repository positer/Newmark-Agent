const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertLinuxPackageVersion, hasCommand } = require('./release-linux-package-smoke-lib.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const version = require(path.join(appRoot, 'package.json')).version;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 180000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.stderr || result.stdout}`);
  return result;
}

if (process.platform !== 'linux') {
  console.log('[release-linux-appimage-smoke] skipped outside Linux');
  process.exit(0);
}

const sourcePath = path.resolve(argValue('--asset') || process.env.NEWMARK_LINUX_APPIMAGE
  || path.join(repoRoot, 'release', `Newmark-Agent-${version}-x86_64.AppImage`));
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error(`missing Linux AppImage: ${sourcePath}`);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-appimage-smoke-'));
const appImage = path.join(tempRoot, path.basename(sourcePath));
const screenshotPath = path.join(tempRoot, 'appimage-gui.png');
try {
  fs.copyFileSync(sourcePath, appImage);
  fs.chmodSync(appImage, 0o755);
  const runtimeVersion = run(appImage, ['--appimage-version'], { env: process.env, timeout: 30000 });
  if (!String(runtimeVersion.stdout || runtimeVersion.stderr || '').trim()) throw new Error('AppImage runtime version probe returned no output');
  assertLinuxPackageVersion(appImage, { APPIMAGE_EXTRACT_AND_RUN: '1' });

  const guiScript = path.join(__dirname, 'release-linux-gui-smoke.cjs');
  const env = {
    ...process.env,
    APPIMAGE_EXTRACT_AND_RUN: '1',
    NEWMARK_LINUX_EXE: appImage,
    NEWMARK_LINUX_GUI_SCREENSHOT: screenshotPath,
  };
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    run(process.execPath, [guiScript], { env, stdio: 'inherit' });
  } else if (hasCommand('xvfb-run')) {
    run('xvfb-run', ['-a', process.execPath, guiScript], { env, stdio: 'inherit' });
  } else {
    console.log('[release-linux-appimage-smoke] GUI startup skipped: no DISPLAY, WAYLAND_DISPLAY, or xvfb-run; AppImage runtime execution passed');
  }
  console.log('[release-linux-appimage-smoke] PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
