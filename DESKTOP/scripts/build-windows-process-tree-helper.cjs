const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(__dirname, 'windows-process-tree-helper.cs');
const outputPath = path.join(appRoot, 'dist', 'windows-process-tree-helper.dll');

if (process.platform !== 'win32') {
  console.log('[windows-process-tree-helper] skipped: Windows-only helper');
  process.exit(0);
}

function base64Utf8(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function encodedPowerShell(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.rmSync(outputPath, { force: true });

const command = [
  "$ErrorActionPreference = 'Stop'",
  `$sourcePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Utf8(sourcePath)}'))`,
  `$outputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Utf8(outputPath)}'))`,
  '$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)',
  'Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $outputPath -OutputType Library',
  "if (!(Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw 'Windows process-tree helper was not emitted' }",
].join('\n');

const result = spawnSync('powershell.exe', [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  encodedPowerShell(command),
], {
  cwd: appRoot,
  encoding: 'utf8',
  shell: false,
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Windows process-tree helper compilation failed (${result.status}): ${String(result.stderr || result.stdout || '').trim()}`);
}

const bytes = fs.readFileSync(outputPath);
if (bytes.length < 1024 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
  throw new Error(`Windows process-tree helper output is not a valid PE assembly: ${outputPath}`);
}

console.log(`[windows-process-tree-helper] ${path.relative(appRoot, outputPath)} (${bytes.length} bytes)`);
