const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');

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
  run(builder, ['--linux']);
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
  const wslRoot = toWslPath(distro, root);
  log(`forwarding Linux package build to WSL distro ${distro}`);
  const script = `cd ${wslQuote(wslRoot)} && npm run dist:linux:native`;
  run('wsl.exe', ['-d', distro, '--', 'bash', '-lc', script], { cwd: root });
}

try {
  if (process.platform === 'win32') runWindowsWslBuild();
  else runNativeLinuxBuild();
  log('Linux package build completed');
} catch (error) {
  console.error(`[dist-linux] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
