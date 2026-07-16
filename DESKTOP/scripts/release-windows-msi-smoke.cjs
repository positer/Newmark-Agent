const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { expectedVersion, smokeWindowsUnpacked } = require('./release-windows-package-smoke-lib.cjs');

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

function administrativeExtract(msiPath, destination, logPath) {
  const result = spawnSync('msiexec.exe', [
    '/a', msiPath,
    '/qn',
    `TARGETDIR=${destination}`,
    '/L*v', logPath,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 3010) {
    const logTail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-8000) : '';
    throw new Error(`MSI administrative extraction exited ${result.status}: ${result.stderr || result.stdout || logTail}`);
  }
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('[release-windows-msi-smoke] skipped outside Windows');
    return;
  }
  const msiPath = path.resolve(argValue('--asset') || process.env.NEWMARK_WINDOWS_MSI
    || path.join(repoRoot, 'release', `Newmark-Agent-${expectedVersion}-x64.msi`));
  if (!fs.existsSync(msiPath) || !fs.statSync(msiPath).isFile()) throw new Error(`missing Windows MSI: ${msiPath}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-windows-msi-smoke-'));
  const extractRoot = path.join(tempRoot, 'administrative-image');
  const logPath = path.join(tempRoot, 'msiexec.log');
  fs.mkdirSync(extractRoot, { recursive: true });
  try {
    // /a creates an isolated administrative image and never installs over the user's registered product.
    administrativeExtract(msiPath, extractRoot, logPath);
    const unpackedRoot = await smokeWindowsUnpacked(extractRoot, 'Windows MSI administrative image');
    const featureScript = 'release-dev010-features-smoke.cjs';
    const featureSmoke = spawnSync(process.execPath, [path.join(__dirname, featureScript)], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, NEWMARK_TEST_EXE: path.join(unpackedRoot, 'Newmark Agent.exe') },
      stdio: 'inherit',
      timeout: 360000,
    });
    if (featureSmoke.error) throw featureSmoke.error;
    if (featureSmoke.status !== 0) throw new Error(`${featureScript} exited ${featureSmoke.status}`);
    console.log(`[release-windows-msi-smoke] PASS ${path.relative(extractRoot, unpackedRoot) || '.'}`);
  } finally {
    await removeTreeWithRetry(tempRoot);
  }
})().catch(error => {
  console.error(`[release-windows-msi-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
