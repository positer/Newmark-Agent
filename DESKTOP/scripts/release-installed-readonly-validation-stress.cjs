const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.argv.slice(2).some(arg => ['--help', '-h'].includes(String(arg).toLowerCase()))) {
  process.stdout.write([
    'Usage: node DESKTOP/scripts/release-installed-readonly-validation-stress.cjs',
    'Validate a real installed Newmark executable without mutating its install tree or user config.',
    'Options:',
    '  --help, -h  Show this help and exit without resolving or launching the installed executable.',
  ].join('\n') + '\n');
  process.exit(0);
}

const installRoot = path.resolve(process.env.NEWMARK_INSTALLED_ROOT || 'C:\\Program Files\\Newmark Agent');
const cliExe = path.join(installRoot, 'Newmark.exe');
const userRoot = path.resolve(process.env.NEWMARK_USER_ROOT || path.join(os.homedir(), '.Newmark'));
const configPath = path.resolve(process.env.NEWMARK_USER_CONFIG || path.join(userRoot, 'config.json'));
const selectedModel = String(process.env.NEWMARK_READONLY_VALIDATION_MODEL || 'APInebula/gpt-5.4-mini');
const rounds = Math.max(1, Number(process.env.NEWMARK_READONLY_VALIDATION_ROUNDS || 2));

function assert(condition, message) {
  if (!condition) throw new Error(`installed read-only validation stress failed: ${message}`);
}

function fileFingerprint(filePath) {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    hash: crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase(),
    bytes: bytes.length,
    mtimeMs: stat.mtimeMs,
  };
}

function scrub(text) {
  return String(text || '')
    .replace(/(api[_-]?key|authorization|token|secret|password)(["'=: ]+)[^\s,"']+/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function runValidation(round) {
  const started = Date.now();
  const result = spawnSync(cliExe, [
    'validate-models',
    '--selected',
    selectedModel,
  ], {
    cwd: userRoot,
    windowsHide: true,
    shell: false,
    timeout: Math.max(30_000, Number(process.env.NEWMARK_READONLY_VALIDATION_TIMEOUT_MS || 180_000)),
    encoding: 'utf8',
    env: { ...process.env },
  });
  const durationMs = Date.now() - started;
  if (result.error) {
    throw new Error(`round ${round} spawn failed after ${durationMs} ms: ${scrub(result.error.message)}`);
  }
  assert(result.status === 0, `round ${round} exit=${result.status} signal=${result.signal || ''} stdout=${JSON.stringify(scrub(result.stdout).slice(0, 600))} stderr=${JSON.stringify(scrub(result.stderr).slice(0, 600))}`);
  return { durationMs, stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || '') };
}

function main() {
  if (process.platform !== 'win32') {
    console.log('installed read-only validation stress skipped outside Windows');
    return;
  }
  assert(fs.existsSync(cliExe), `missing installed CLI: ${cliExe}`);
  assert(fs.existsSync(configPath), `missing user config: ${configPath}`);
  const before = fileFingerprint(configPath);
  const observations = [];
  for (let round = 1; round <= rounds; round += 1) {
    const result = runValidation(round);
    const after = fileFingerprint(configPath);
    assert(after.hash === before.hash, `round ${round} changed config hash ${before.hash} -> ${after.hash}`);
    assert(after.bytes === before.bytes, `round ${round} changed config size ${before.bytes} -> ${after.bytes}`);
    assert(after.mtimeMs === before.mtimeMs, `round ${round} changed config mtime ${before.mtimeMs} -> ${after.mtimeMs}`);
    observations.push(result);
    console.log(`[installed-readonly-validation] round=${round}/${rounds} exit=0 durationMs=${result.durationMs} configUnchanged=true`);
  }
  console.log(`INSTALLED_READ_ONLY_VALIDATION_PASS model=${selectedModel} rounds=${rounds} configHash=${before.hash} configBytes=${before.bytes} configUnchanged=true`);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
}
