const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function patchConsoleSubsystem(exePath) {
  const bytes = fs.readFileSync(exePath);
  if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`Not a Windows PE executable: ${exePath}`);
  const peOffset = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') throw new Error(`Invalid PE signature: ${exePath}`);
  const optionalHeader = peOffset + 4 + 20;
  const magic = bytes.readUInt16LE(optionalHeader);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error(`Unsupported PE optional-header format: ${exePath}`);
  const subsystemOffset = optionalHeader + 68;
  bytes.writeUInt16LE(3, subsystemOffset);
  fs.writeFileSync(exePath, bytes);
}

function createConsoleLauncher(unpackedDir) {
  const guiExe = path.join(unpackedDir, 'Newmark Agent.exe');
  const consoleExe = path.join(unpackedDir, 'Newmark.exe');
  const consoleRuntimeExe = path.join(unpackedDir, 'Newmark Console Runtime.exe');
  if (!fs.existsSync(guiExe)) throw new Error(`GUI executable is missing: ${guiExe}`);
  const source = path.join(__dirname, 'newmark-console-wrapper.c');
  if (!fs.existsSync(source)) throw new Error(`Console wrapper source is missing: ${source}`);
  fs.copyFileSync(guiExe, consoleRuntimeExe);
  patchConsoleSubsystem(consoleRuntimeExe);
  const compiler = String(process.env.NEWMARK_MINGW_GCC || 'gcc').trim() || 'gcc';
  const result = spawnSync(compiler, [
    '-municode',
    '-mconsole',
    '-O2',
    '-s',
    source,
    '-o',
    consoleExe,
  ], {
    cwd: path.dirname(source),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`Console launcher compiler failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Console launcher compiler exited ${result.status}: ${result.stderr || result.stdout || ''}`);
  if (!fs.existsSync(consoleExe) || fs.statSync(consoleExe).size <= 0) throw new Error(`Console launcher was not produced: ${consoleExe}`);
  if (!fs.existsSync(consoleRuntimeExe) || fs.statSync(consoleRuntimeExe).size <= 0) throw new Error(`Console runtime was not produced: ${consoleRuntimeExe}`);
  return consoleExe;
}

if (require.main === module) {
  const unpackedDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'release', 'win-unpacked'));
  const consoleExe = createConsoleLauncher(unpackedDir);
  process.stdout.write(`[console-launcher] created ${consoleExe}\n`);
}

module.exports = { createConsoleLauncher };
