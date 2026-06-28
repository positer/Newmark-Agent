const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, '..', 'release');
const appPackage = require(path.join(root, 'package.json'));
const exePath = path.join(outputDir, `Newmark-Agent-${appPackage.version}-portable-x64.exe`);
const unpackedExe = path.join(outputDir, 'win-unpacked', 'Newmark Agent.exe');
const appAsar = path.join(outputDir, 'win-unpacked', 'resources', 'app.asar');

function log(message) {
  console.log(`[dist-portable] ${message}`);
}

function tryRm(target) {
  if (!fs.existsSync(target)) return true;
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    return !fs.existsSync(target);
  } catch (err) {
    log(`could not remove ${target}: ${err.code || err.message}`);
    return false;
  }
}

function verifyPackagedOutput() {
  const checks = [
    [exePath, 'portable exe'],
    [unpackedExe, 'win-unpacked exe'],
    [appAsar, 'app.asar'],
  ];
  for (const [file, label] of checks) {
    if (!fs.existsSync(file)) throw new Error(`missing ${label}: ${file}`);
    if (fs.statSync(file).size <= 0) throw new Error(`empty ${label}: ${file}`);
  }

  const files = asar.listPackage(appAsar);
  if (!files.includes('\\dist\\ui\\index.html')) throw new Error('app.asar missing dist/ui/index.html');
  if (!files.includes('\\dist\\ui\\lucide-sprite.svg')) throw new Error('app.asar missing dist/ui/lucide-sprite.svg');

  const extractDir = path.join(outputDir, '.verify-asar');
  tryRm(extractDir);
  asar.extractAll(appAsar, extractDir);
  const htmlPath = path.join(extractDir, 'dist', 'ui', 'index.html');
  if (!fs.existsSync(htmlPath)) throw new Error('extracted app.asar missing dist/ui/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  tryRm(extractDir);
  if (!html.includes('id="lucide-sprite-root"')) throw new Error('packaged UI missing embedded lucide sprite');
  if (html.includes('href="lucide-sprite.svg#')) throw new Error('packaged UI still uses external lucide sprite hrefs');
  if (!html.includes('href="#message-square') || !html.includes('href="#send')) throw new Error('packaged UI missing expected local icon hrefs');
}

function verifyReleaseCliSmoke() {
  const smokePath = path.join(root, 'scripts', 'release-cli-smoke.cjs');
  if (!fs.existsSync(smokePath)) throw new Error(`missing release CLI smoke script: ${smokePath}`);
  const result = spawnSync(process.execPath, [smokePath], { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error(`release CLI smoke spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`release CLI smoke failed with exit ${result.status}`);
}

tryRm(outputDir);

const builderBin = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'electron-builder.cmd')
  : path.join(root, 'node_modules', '.bin', 'electron-builder');
const result = process.platform === 'win32'
  ? spawnSync(`"${builderBin}" --win portable`, { cwd: root, stdio: 'inherit', shell: true })
  : spawnSync(builderBin, ['--win', 'portable'], { cwd: root, stdio: 'inherit', shell: false });

if (result.error) {
  log(`electron-builder spawn error: ${result.error.code || ''} ${result.error.message}`);
}

if (result.status === 0) {
  verifyPackagedOutput();
  verifyReleaseCliSmoke();
  log('portable package verified');
  process.exit(0);
}

try {
  verifyPackagedOutput();
  verifyReleaseCliSmoke();
  log(`electron-builder exited ${result.status}, but portable outputs are complete and verified`);
  process.exit(0);
} catch (err) {
  console.error(`[dist-portable] verification failed after electron-builder exit ${result.status}: ${err.message}`);
  process.exit(result.status || 1);
}
