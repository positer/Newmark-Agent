const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');
const { patchAndVerify, patchExeIdentity, verifyExeIcon } = require('./patch-win-exe-icon.cjs');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, '..', 'release');
const appPackage = require(path.join(root, 'package.json'));
const installerPath = path.join(outputDir, `Newmark-Agent-${appPackage.version}-x64.msi`);
const unpackedDir = path.join(outputDir, 'win-unpacked');
const unpackedExe = path.join(unpackedDir, 'Newmark Agent.exe');
const appAsar = path.join(unpackedDir, 'resources', 'app.asar');
const packageIcon = path.join(root, 'assets', 'icon.ico');
const zipPath = path.join(outputDir, `Newmark-Agent-${appPackage.version}-win-unpacked-x64.zip`);
const expectedProductName = 'Newmark Agent';
const builderCacheDir = path.join(root, '.electron-builder-cache');
const nodePtyRoot = path.join(root, 'node_modules', 'node-pty');

function log(message) {
  console.log(`[dist-windows-release] ${message}`);
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

function quoteCmd(file, args) {
  const quote = value => '"' + String(value).replace(/"/g, '\\"') + '"';
  return [quote(file), ...args.map(arg => quote(arg))].join(' ');
}

function runBuilder(args, label) {
  const builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
  fs.mkdirSync(builderCacheDir, { recursive: true });
  const builderEnv = { ...process.env, ELECTRON_BUILDER_CACHE: builderCacheDir };
  const builderArgs = args.map(arg => String(arg));
  const electronDist = String(process.env.NEWMARK_ELECTRON_DIST_DIR || '').trim();
  if (electronDist && args.includes('dir')) builderArgs.push(`--config.electronDist=${path.resolve(electronDist)}`);
  const result = spawnSync(process.execPath, [builderCli, ...builderArgs], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: builderEnv,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${label} spawn error: ${result.error.code || ''} ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

function ensureNodePtyConptyAssets(baseDir) {
  const sourceDir = path.join(baseDir, 'prebuilds', 'win32-x64', 'conpty');
  const targetDir = path.join(baseDir, 'build', 'Release', 'conpty');
  for (const name of ['conpty.dll', 'OpenConsole.exe']) {
    const source = path.join(sourceDir, name);
    if (!fs.existsSync(source)) throw new Error(`node-pty ${name} source asset is missing: ${source}`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(source, path.join(targetDir, name));
  }
}

function verifyUnpackedOutput() {
  const unpackedRuntimeDist = path.join(unpackedDir, 'resources', 'app.asar.unpacked', 'dist');
  const checks = [
    [unpackedExe, 'win-unpacked exe'],
    [appAsar, 'app.asar'],
    [path.join(unpackedRuntimeDist, 'windows-process-tree-helper.dll'), 'precompiled Windows process-tree helper'],
    [path.join(unpackedRuntimeDist, 'typebox-compile.bundle.cjs'), 'Electron Node 20 TypeBox compiler bundle'],
    [path.join(unpackedRuntimeDist, 'wsl-agent-host.bundle.cjs'), 'WSL Agent host bundle'],
    [path.join(unpackedRuntimeDist, 'conversation-utility-host.bundle.cjs'), 'Electron utility Agent host bundle'],
  ];
  for (const [file, label] of checks) {
    if (!fs.existsSync(file)) throw new Error(`missing ${label}: ${file}`);
    if (fs.statSync(file).size <= 0) throw new Error(`empty ${label}: ${file}`);
  }

  const files = asar.listPackage(appAsar);
  if (!files.includes('\\dist\\ui\\index.html')) throw new Error('app.asar missing dist/ui/index.html');
  if (!files.includes('\\dist\\ui\\lucide-sprite.svg')) throw new Error('app.asar missing dist/ui/lucide-sprite.svg');
  if (!files.includes('\\config.example.json')) throw new Error('app.asar missing config.example.json');

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
  verifyExeIcon(unpackedExe, packageIcon);
  verifyExeIdentity(unpackedExe);
}

function patchPackagedOutput() {
  patchExeIdentity(unpackedExe);
  patchAndVerify(unpackedExe, packageIcon);
}

function verifyExeIdentity(exe) {
  if (process.platform !== 'win32') return;
  const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
  const ps = [
    '$ErrorActionPreference="Stop"',
    `$vi=[System.Diagnostics.FileVersionInfo]::GetVersionInfo(${psQuote(path.resolve(exe))})`,
    '[PSCustomObject]@{ProductName=$vi.ProductName;FileDescription=$vi.FileDescription;OriginalFilename=$vi.OriginalFilename}|ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    cwd: root,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `exe identity check exited ${result.status}`);
  const data = JSON.parse(String(result.stdout || '').trim());
  if (data.ProductName !== expectedProductName) throw new Error(`win-unpacked exe ProductName is ${data.ProductName || '<empty>'}`);
  if (!String(data.FileDescription || '').includes(expectedProductName)) throw new Error(`win-unpacked exe FileDescription is ${data.FileDescription || '<empty>'}`);
  if (String(data.OriginalFilename || '').toLowerCase() === 'electron.exe') throw new Error('win-unpacked exe OriginalFilename still reports electron.exe');
}

function createZipPack() {
  if (!fs.existsSync(unpackedDir)) throw new Error('missing win-unpacked directory for zip pack');
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
  const ps = [
    '$ErrorActionPreference="Stop"',
    `Compress-Archive -LiteralPath ${psQuote(unpackedDir)} -DestinationPath ${psQuote(zipPath)} -Force`,
    'Write-Output "zip-ok"',
  ].join('; ');
  const zip = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    cwd: root,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (zip.error) throw zip.error;
  if (zip.status !== 0) throw new Error(zip.stderr || zip.stdout || `Compress-Archive exited ${zip.status}`);
}

function verifyZipPack() {
  if (!fs.existsSync(zipPath)) throw new Error(`missing zip pack: ${zipPath}`);
  if (fs.statSync(zipPath).size <= 0) throw new Error(`empty zip pack: ${zipPath}`);
}

function verifyMsiInstaller() {
  if (!fs.existsSync(installerPath)) throw new Error(`missing MSI installer: ${installerPath}`);
  if (fs.statSync(installerPath).size <= 0) throw new Error(`empty MSI installer: ${installerPath}`);
}

function verifyReleaseCliSmoke() {
  const smokePath = path.join(root, 'scripts', 'release-cli-smoke.cjs');
  if (!fs.existsSync(smokePath)) throw new Error(`missing release CLI smoke script: ${smokePath}`);
  const result = spawnSync(process.execPath, [smokePath], { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error(`release CLI smoke spawn failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`release CLI smoke failed with exit ${result.status}`);
}

try {
  if (!tryRm(outputDir)) {
    throw new Error(`Refusing to build into a partially locked release directory: ${outputDir}`);
  }
  runBuilder(['--win', 'dir'], 'electron-builder dir');
  ensureNodePtyConptyAssets(nodePtyRoot);
  ensureNodePtyConptyAssets(path.join(unpackedDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty'));
  patchPackagedOutput();
  verifyUnpackedOutput();
  runBuilder(['--win', 'msi', '--prepackaged', unpackedDir], 'electron-builder msi --prepackaged');
  verifyMsiInstaller();
  createZipPack();
  verifyZipPack();
  verifyReleaseCliSmoke();
  log('MSI installer and win-unpacked zip pack verified');
} catch (err) {
  console.error(`[dist-windows-release] ${err.stack || err.message}`);
  process.exit(1);
}
