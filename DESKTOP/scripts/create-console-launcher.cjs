const fs = require('node:fs');
const path = require('node:path');

function createConsoleLauncher(unpackedDir) {
  const guiExe = path.join(unpackedDir, 'Newmark Agent.exe');
  const consoleExe = path.join(unpackedDir, 'Newmark.exe');
  if (!fs.existsSync(guiExe)) throw new Error(`GUI executable is missing: ${guiExe}`);
  const image = fs.readFileSync(guiExe);
  const peOffset = image.readUInt32LE(0x3c);
  if (image.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`Invalid PE signature: ${guiExe}`);
  }
  const optionalHeader = peOffset + 4 + 20;
  const magic = image.readUInt16LE(optionalHeader);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`Unsupported PE optional-header magic 0x${magic.toString(16)}`);
  }
  const subsystemOffset = optionalHeader + 68;
  image.writeUInt16LE(3, subsystemOffset);
  fs.writeFileSync(consoleExe, image);
  const verified = fs.readFileSync(consoleExe).readUInt16LE(subsystemOffset);
  if (verified !== 3) throw new Error('Console launcher subsystem patch did not persist');
  return consoleExe;
}

if (require.main === module) {
  const unpackedDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'release', 'win-unpacked'));
  const consoleExe = createConsoleLauncher(unpackedDir);
  process.stdout.write(`[console-launcher] created ${consoleExe}\n`);
}

module.exports = { createConsoleLauncher };
