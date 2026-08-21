const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..');
const releaseDir = process.env.NEWMARK_RELEASE_OUTPUT_DIR
  ? path.resolve(process.env.NEWMARK_RELEASE_OUTPUT_DIR)
  : path.join(repoRoot, 'release');
const version = require(path.join(root, 'package.json')).version;
const latencyArchiveName = `20260721-dev-${version}-linux-agent-latency.json`;
const WSL_DISCOVERY_TIMEOUT_MS = Math.max(1_000, Number(process.env.NEWMARK_DIST_LINUX_DISCOVERY_TIMEOUT_MS) || 15_000);
const WSL_BUILD_TIMEOUT_MS = Math.max(60_000, Number(process.env.NEWMARK_DIST_LINUX_TIMEOUT_MS) || 45 * 60 * 1000);

function log(message) {
  console.log(`[dist-linux] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
}

function assertExists(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} was not created: ${filePath}`);
}

function findLinuxExecutable(unpackedDir) {
  const candidates = [
    path.join(unpackedDir, 'newmark-agent'),
    path.join(unpackedDir, 'Newmark Agent'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function decodeWslOutput(buffer) {
  const utf16 = buffer.toString('utf16le').replace(/\0/g, '').trim();
  if (utf16 && /^[\s\S]*[A-Za-z0-9_.-]/.test(utf16)) return utf16;
  return buffer.toString('utf8').replace(/\0/g, '').trim();
}

function listWslDistros() {
  const result = spawnSync('wsl.exe', ['--list', '--quiet'], {
    cwd: root,
    encoding: 'buffer',
    windowsHide: true,
    timeout: WSL_DISCOVERY_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return [];
  const text = decodeWslOutput(result.stdout || Buffer.alloc(0));
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/\s*\(Default\)\s*$/i, '').trim())
    .filter(Boolean)
    .filter(line => !/install|online|windows subsystem/i.test(line));
}

function wslQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function toWslPath(distro, windowsPath) {
  const result = spawnSync('wsl.exe', ['-d', distro, '--', 'wslpath', '-a', windowsPath], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: WSL_DISCOVERY_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`failed to convert path through WSL distro ${distro}: ${result.stderr || result.error?.message || ''}`);
  }
  return result.stdout.trim();
}

function runNativeLinuxBuild() {
  log('running native Linux electron-builder path');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:clean']);
  const builder = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  // Packaging must remain a local, deterministic step. Release upload is a
  // separate explicit workflow and must never be inferred from CI/GH env vars.
  run(builder, ['--linux', '--publish', 'never', `--config.directories.output=${releaseDir}`]);

  const appImage = path.join(releaseDir, `Newmark-Agent-${version}-x86_64.AppImage`);
  const deb = path.join(releaseDir, `Newmark-Agent-${version}-amd64.deb`);
  const unpackedDir = path.join(releaseDir, 'linux-unpacked');
  const unpackedExe = findLinuxExecutable(unpackedDir);
  assertExists(appImage, 'Linux AppImage');
  assertExists(deb, 'Linux Debian package');
  if (!unpackedExe) throw new Error(`Linux unpacked executable was not found in ${unpackedDir}`);

  const zipName = `Newmark-Agent-${version}-linux-unpacked-x64.zip`;
  const zipPath = path.join(releaseDir, zipName);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  run('zip', ['-qr', zipName, 'linux-unpacked'], { cwd: releaseDir });
  assertExists(zipPath, 'Linux unpacked zip');
  log(`created ${zipPath}`);
}

function runWindowsWslBuild() {
  const requested = process.env.NEWMARK_DIST_LINUX_WSL || '';
  const distros = requested ? [requested] : listWslDistros();
  const distro = distros[0];
  if (!distro) {
    throw new Error(
      'Linux packaging must run in Linux/WSL. No WSL distro is available, and Windows-native AppImage/deb packaging is intentionally skipped because it requires symlink privileges and fpm.'
    );
  }
  const wslSourceRoot = toWslPath(distro, root);
  const wslRepoRoot = toWslPath(distro, repoRoot);
  const wslTuiRoot = toWslPath(distro, path.join(repoRoot, 'TUI'));
  const wslReleaseDir = toWslPath(distro, releaseDir);
  const skipVerification = /^(?:1|true|yes)$/i.test(process.env.NEWMARK_DIST_LINUX_SKIP_VERIFICATION || '');
  log(`building in an isolated Linux filesystem through WSL distro ${distro}`);
  const script = [
    'set -euo pipefail',
    "build_root=$(mktemp -d /tmp/newmark-linux-build.XXXXXX)",
    "cleanup() { rm -rf \"$build_root\"; }",
    'trap cleanup EXIT',
    'mkdir -p "$build_root/repo/DESKTOP" "$build_root/repo/TUI" "$build_root/repo/release"',
    `rsync -a --delete --exclude='node_modules/' --exclude='dist/' --exclude='test-tmp*/' ${wslQuote(`${wslSourceRoot}/`)} "$build_root/repo/DESKTOP/"`,
    `rsync -a --delete --exclude='node_modules/' ${wslQuote(`${wslTuiRoot}/`)} "$build_root/repo/TUI/"`,
    `cp ${wslQuote(`${wslRepoRoot}/LICENSE`)} "$build_root/repo/LICENSE"`,
    `cp ${wslQuote(`${wslRepoRoot}/THIRD_PARTY_NOTICES.md`)} "$build_root/repo/THIRD_PARTY_NOTICES.md"`,
    `cp ${wslQuote(`${wslRepoRoot}/HARMONYOS_INTEGRATION.md`)} "$build_root/repo/HARMONYOS_INTEGRATION.md" 2>/dev/null || true`,
    `mkdir -p "$build_root/repo/docs"`,
    `cp ${wslQuote(`${wslRepoRoot}/docs/macos-build.md`)} "$build_root/repo/docs/macos-build.md" 2>/dev/null || true`,
    'cd "$build_root/repo/DESKTOP"',
    process.env.NEWMARK_DIST_LINUX_NPM_REGISTRY
      ? `npm config set registry ${wslQuote(process.env.NEWMARK_DIST_LINUX_NPM_REGISTRY)}`
      : '',
    process.env.ELECTRON_MIRROR
      ? `export ELECTRON_MIRROR=${wslQuote(process.env.ELECTRON_MIRROR)}`
      : '',
    'export ELECTRON_SKIP_BINARY_DOWNLOAD=1',
    'npm ci --include=dev --no-audit --no-fund',
    skipVerification ? 'echo "[dist-linux] reusing verification completed by the immediately preceding packaging attempt"' : 'npm test',
    skipVerification ? '' : 'NEWMARK_LATENCY_OUTPUT="$build_root/linux-agent-latency.json" npm run benchmark:linux-agent-latency',
    skipVerification ? '' : `mkdir -p ${wslQuote(`${wslRepoRoot}/archive`)}`,
    skipVerification ? '' : `cp "$build_root/linux-agent-latency.json" ${wslQuote(`${wslRepoRoot}/archive/${latencyArchiveName}`)}`,
    'node scripts/dist-linux.cjs --native',
    `mkdir -p ${wslQuote(wslReleaseDir)}`,
    `rm -rf ${wslQuote(`${wslReleaseDir}/linux-unpacked`)}`,
    `cp "$build_root/repo/release/Newmark-Agent-${version}-x86_64.AppImage" ${wslQuote(`${wslReleaseDir}/`)}`,
    `cp "$build_root/repo/release/Newmark-Agent-${version}-amd64.deb" ${wslQuote(`${wslReleaseDir}/`)}`,
    `cp "$build_root/repo/release/Newmark-Agent-${version}-linux-unpacked-x64.zip" ${wslQuote(`${wslReleaseDir}/`)}`,
    `rsync -a --delete "$build_root/repo/release/linux-unpacked/" ${wslQuote(`${wslReleaseDir}/linux-unpacked/`)}`,
  ].filter(Boolean).join('\n');
  run('wsl.exe', ['-d', distro, '--', 'bash', '-s'], {
    cwd: root,
    input: `${script}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: WSL_BUILD_TIMEOUT_MS,
  });

  const appImage = path.join(releaseDir, `Newmark-Agent-${version}-x86_64.AppImage`);
  const deb = path.join(releaseDir, `Newmark-Agent-${version}-amd64.deb`);
  const zipPath = path.join(releaseDir, `Newmark-Agent-${version}-linux-unpacked-x64.zip`);
  const unpackedExe = findLinuxExecutable(path.join(releaseDir, 'linux-unpacked'));
  assertExists(appImage, 'copied Linux AppImage');
  assertExists(deb, 'copied Linux Debian package');
  assertExists(zipPath, 'copied Linux unpacked zip');
  if (!unpackedExe) throw new Error(`copied Linux unpacked executable was not found in ${path.join(releaseDir, 'linux-unpacked')}`);
}

try {
  if (process.argv.includes('--native')) runNativeLinuxBuild();
  else if (process.platform === 'win32') runWindowsWslBuild();
  else runNativeLinuxBuild();
  log('Linux package build completed');
} catch (error) {
  console.error(`[dist-linux] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
