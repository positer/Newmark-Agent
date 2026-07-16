const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { expectedVersion, psQuote, smokeWindowsUnpacked } = require('./release-windows-package-smoke-lib.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function removeTreeWithRetry(target) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || attempt === 79) throw error;
      await sleep(250);
    }
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function expandArchive(zipPath, destination) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)} -Force`,
    'Write-Output "expanded"',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Expand-Archive exited ${result.status}: ${result.stderr || result.stdout}`);
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('[release-windows-zip-smoke] skipped outside Windows');
    return;
  }
  const zipPath = path.resolve(argValue('--asset') || process.env.NEWMARK_WINDOWS_ZIP
    || path.join(repoRoot, 'release', `Newmark-Agent-${expectedVersion}-win-unpacked-x64.zip`));
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) throw new Error(`missing Windows unpacked ZIP: ${zipPath}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-windows-zip-smoke-'));
  try {
    expandArchive(zipPath, tempRoot);
    const unpackedRoot = await smokeWindowsUnpacked(tempRoot, 'Windows ZIP');
    for (const featureScript of ['release-dev008-features-smoke.cjs', 'release-dev009-features-smoke.cjs', 'release-dev010-features-smoke.cjs']) {
      const featureUserDataDir = path.join(tempRoot, `.feature-user-data-${featureScript.replace(/[^a-z0-9]+/gi, '-')}`);
      const featureSmoke = spawnSync(process.execPath, [path.join(__dirname, featureScript)], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          NEWMARK_TEST_EXE: path.join(unpackedRoot, 'Newmark Agent.exe'),
          NEWMARK_TEST_USER_DATA_DIR: featureUserDataDir,
        },
        stdio: 'inherit',
        timeout: 360000,
      });
      if (featureSmoke.error) throw featureSmoke.error;
      if (featureSmoke.status !== 0) throw new Error(`${featureScript} exited ${featureSmoke.status}`);
      await removeTreeWithRetry(featureUserDataDir);
    }
    console.log(`[release-windows-zip-smoke] PASS ${path.relative(tempRoot, unpackedRoot) || '.'}`);
  } finally {
    await removeTreeWithRetry(tempRoot);
  }
})().catch(error => {
  console.error(`[release-windows-zip-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
