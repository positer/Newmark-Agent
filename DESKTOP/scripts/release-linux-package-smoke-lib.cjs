const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const expectedVersion = require(path.resolve(__dirname, '..', 'package.json')).version;

function assertLinuxPackageVersion(executable, extraEnv = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-linux-cli-version-'));
  try {
    const result = spawnSync(executable, ['install-update', '--version', '--root', runtimeRoot], {
      cwd: path.dirname(executable),
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
      timeout: 90000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`packaged Linux CLI exited ${result.status}: ${result.stderr || result.stdout}`);
    const stdout = String(result.stdout || '').trim();
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // AppImage's extract-and-run fallback can print an extraction manifest
      // around the packaged CLI result, so accept only a parseable flat JSON
      // object that explicitly contains the expected version response fields.
      const candidates = Array.from(stdout.matchAll(/\{[^{}]*"ok"\s*:\s*true[^{}]*"version"\s*:\s*"[^"]+"[^{}]*\}/g));
      for (let index = candidates.length - 1; index >= 0 && !parsed; index -= 1) {
        try { parsed = JSON.parse(candidates[index][0]); } catch {}
      }
      if (!parsed) throw new Error(`packaged Linux CLI returned invalid JSON: ${stdout || '<empty>'}`);
    }
    if (parsed.ok !== true || parsed.version !== expectedVersion) {
      throw new Error(`packaged Linux version mismatch: expected ${expectedVersion}, got ${parsed.version || '<empty>'}`);
    }
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

function hasCommand(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

module.exports = { assertLinuxPackageVersion, expectedVersion, hasCommand };
