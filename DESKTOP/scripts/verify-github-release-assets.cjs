const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const packageJson = require(path.join(appRoot, 'package.json'));
const version = packageJson.version;
const defaultRepo = String(packageJson.homepage || '').match(/github\.com\/([^/]+\/[^/#]+)/i)?.[1] || 'positer/Newmark-Agent';
const expectedNames = [
  `Newmark-Agent-${version}-x64.msi`,
  `Newmark-Agent-${version}-win-unpacked-x64.zip`,
  `Newmark-Agent-${version}-x86_64.AppImage`,
  `Newmark-Agent-${version}-amd64.deb`,
  `Newmark-Agent-${version}-linux-unpacked-x64.zip`,
];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 1800000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`);
  return result;
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b, 'en'));
}

function assertExactNames(actualNames, label) {
  const actual = sorted(actualNames);
  const expected = sorted(expectedNames);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} must contain exactly the five ${version} assets. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

function directoryFiles(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const nonFiles = entries.filter(entry => !entry.isFile()).map(entry => entry.name);
  assert(nonFiles.length === 0, `download directory contains non-file entries: ${JSON.stringify(nonFiles)}`);
  return entries.map(entry => entry.name);
}

function localReleaseAssetFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith('Newmark-Agent-'))
    .map(entry => entry.name);
}

function hasCommand(command) {
  const probe = process.platform === 'win32'
    ? spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function runNodeSmoke(scriptName, envKey, assetPath, options = {}) {
  const scriptPath = path.join(__dirname, scriptName);
  const screenshotPath = scriptName.includes('release-linux-')
    ? path.join(os.tmpdir(), `newmark-${version}-${process.pid}-${path.basename(scriptName, '.cjs')}.png`)
    : '';
  const env = {
    ...process.env,
    [envKey]: assetPath,
    ...(screenshotPath ? { NEWMARK_LINUX_GUI_SCREENSHOT: screenshotPath } : {}),
  };
  try {
    if (options.xvfb) run('xvfb-run', ['-a', process.execPath, scriptPath], { env, stdio: 'inherit' });
    else run(process.execPath, [scriptPath], { env, stdio: 'inherit' });
  } finally {
    if (screenshotPath) fs.rmSync(screenshotPath, { force: true });
  }
}

function decodeWslOutput(buffer) {
  const utf16 = buffer.toString('utf16le').replace(/\0/g, '').trim();
  if (utf16 && /^[\s\S]*[A-Za-z0-9_.-]/.test(utf16)) return utf16;
  return buffer.toString('utf8').replace(/\0/g, '').trim();
}

function findWslDistro() {
  if (process.platform !== 'win32' || !hasCommand('wsl.exe')) return '';
  const requested = process.env.NEWMARK_RELEASE_WSL_DISTRO;
  if (requested) return requested;
  const result = spawnSync('wsl.exe', ['--list', '--quiet'], { encoding: 'buffer', windowsHide: true });
  if (result.error || result.status !== 0) return '';
  return decodeWslOutput(result.stdout || Buffer.alloc(0))
    .split(/\r?\n/)
    .map(line => line.replace(/\s*\(Default\)\s*$/i, '').trim())
    .find(Boolean) || '';
}

function toWslPath(distro, windowsPath) {
  const result = spawnSync('wsl.exe', ['-d', distro, '--', 'wslpath', '-a', windowsPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`failed to convert path through WSL ${distro}: ${result.stderr || result.error?.message || ''}`);
  return result.stdout.trim();
}

function runWslLinuxSmokes(distro, downloadDir) {
  const nodeProbe = spawnSync('wsl.exe', ['-d', distro, '--', 'sh', '-lc', 'command -v node'], { encoding: 'utf8', windowsHide: true });
  if (nodeProbe.error || nodeProbe.status !== 0) {
    console.log(`[verify-github-release-assets] Linux asset smokes skipped in WSL ${distro}: node is unavailable`);
    return;
  }
  const scriptsRoot = toWslPath(distro, __dirname);
  const downloadedRoot = toWslPath(distro, downloadDir);
  const cases = [
    ['release-linux-appimage-smoke.cjs', 'NEWMARK_LINUX_APPIMAGE', expectedNames[2]],
    ['release-linux-deb-smoke.cjs', 'NEWMARK_LINUX_DEB', expectedNames[3]],
    ['release-linux-unpacked-zip-smoke.cjs', 'NEWMARK_LINUX_ZIP', expectedNames[4]],
  ];
  for (const [script, envKey, name] of cases) {
    const screenshot = path.join(os.tmpdir(), `newmark-${version}-wsl-${process.pid}-${path.basename(script, '.cjs')}.png`);
    const wslScreenshot = toWslPath(distro, screenshot);
    try {
      run('wsl.exe', [
        '-d', distro, '--',
        'env',
        `${envKey}=${downloadedRoot}/${name}`,
        `NEWMARK_LINUX_GUI_SCREENSHOT=${wslScreenshot}`,
        'NEWMARK_ALLOW_HEADLESS_ASSET_SMOKE=1',
        'node', `${scriptsRoot}/${script}`,
      ], { stdio: 'inherit' });
    } finally {
      fs.rmSync(screenshot, { force: true });
    }
  }
}

async function main() {
  const repository = argValue('--repo') || process.env.NEWMARK_RELEASE_REPO || defaultRepo;
  const tag = argValue('--tag') || process.env.NEWMARK_RELEASE_TAG || `dev-${version}`;
  const localDir = path.resolve(argValue('--local-dir') || process.env.NEWMARK_LOCAL_RELEASE_DIR || path.join(repoRoot, 'release'));
  const requestedDownloadDir = argValue('--download-dir') || process.env.NEWMARK_DOWNLOADED_RELEASE_DIR;
  const skipDownload = hasArg('--skip-download') || process.env.NEWMARK_SKIP_RELEASE_DOWNLOAD === '1';
  const keepDownload = hasArg('--keep-download') || process.env.NEWMARK_KEEP_RELEASE_DOWNLOAD === '1';
  const ownsDownloadDir = !requestedDownloadDir;
  const downloadDir = requestedDownloadDir
    ? path.resolve(requestedDownloadDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), `newmark-${version}-github-assets-`));

  assert(fs.existsSync(localDir) && fs.statSync(localDir).isDirectory(), `local release directory is missing: ${localDir}`);
  assertExactNames(localReleaseAssetFiles(localDir), 'local release directory');
  for (const name of expectedNames) {
    const localPath = path.join(localDir, name);
    assert(fs.existsSync(localPath) && fs.statSync(localPath).isFile(), `local release asset is missing: ${localPath}`);
  }

  try {
    if (!skipDownload) {
      assert(hasCommand('gh'), 'GitHub CLI (gh) is required to download and verify release assets');
      const view = run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'tagName,isDraft,isPrerelease,assets']);
      const release = JSON.parse(view.stdout);
      assert(release.tagName === tag, `GitHub release tag mismatch: expected ${tag}, got ${release.tagName}`);
      assert(release.isDraft === false, `GitHub release ${tag} is still a draft`);
      assert(release.isPrerelease === true, `GitHub release ${tag} is not marked as a prerelease`);
      assertExactNames((release.assets || []).map(asset => asset.name), `GitHub release ${tag}`);

      if (fs.existsSync(downloadDir)) {
        assert(fs.statSync(downloadDir).isDirectory(), `download destination is not a directory: ${downloadDir}`);
        assert(directoryFiles(downloadDir).length === 0 && fs.readdirSync(downloadDir).length === 0,
          `download destination must be empty so stale assets cannot pass validation: ${downloadDir}`);
      } else {
        fs.mkdirSync(downloadDir, { recursive: true });
      }
      run('gh', ['release', 'download', tag, '--repo', repository, '--dir', downloadDir], { stdio: 'inherit' });
    } else {
      assert(fs.existsSync(downloadDir) && fs.statSync(downloadDir).isDirectory(), `downloaded release directory is missing: ${downloadDir}`);
    }

    assertExactNames(directoryFiles(downloadDir), 'download directory');
    const hashes = [];
    for (const name of expectedNames) {
      const localPath = path.join(localDir, name);
      const downloadedPath = path.join(downloadDir, name);
      const localSize = fs.statSync(localPath).size;
      const downloadedSize = fs.statSync(downloadedPath).size;
      assert(localSize === downloadedSize, `${name} size mismatch: local=${localSize} downloaded=${downloadedSize}`);
      const [localHash, downloadedHash] = await Promise.all([sha256(localPath), sha256(downloadedPath)]);
      assert(localHash === downloadedHash, `${name} SHA256 mismatch: local=${localHash} downloaded=${downloadedHash}`);
      hashes.push({ name, bytes: localSize, sha256: localHash });
      console.log(`[verify-github-release-assets] ${localHash}  ${name}`);
    }

    if (!hasArg('--skip-smokes') && process.env.NEWMARK_SKIP_ASSET_SMOKES !== '1') {
      if (process.platform === 'win32') {
        runNodeSmoke('release-windows-zip-smoke.cjs', 'NEWMARK_WINDOWS_ZIP', path.join(downloadDir, expectedNames[1]));
        runNodeSmoke('release-windows-msi-smoke.cjs', 'NEWMARK_WINDOWS_MSI', path.join(downloadDir, expectedNames[0]));
        if (process.env.NEWMARK_RELEASE_WSL_SMOKES !== '0') {
          const distro = findWslDistro();
          if (distro) runWslLinuxSmokes(distro, downloadDir);
          else console.log('[verify-github-release-assets] Linux asset smokes skipped: no WSL distro is available');
        } else {
          console.log('[verify-github-release-assets] Linux asset smokes skipped because NEWMARK_RELEASE_WSL_SMOKES=0');
        }
      } else if (process.platform === 'linux') {
        runNodeSmoke('release-linux-appimage-smoke.cjs', 'NEWMARK_LINUX_APPIMAGE', path.join(downloadDir, expectedNames[2]));
        process.env.NEWMARK_ALLOW_HEADLESS_ASSET_SMOKE = '1';
        runNodeSmoke('release-linux-deb-smoke.cjs', 'NEWMARK_LINUX_DEB', path.join(downloadDir, expectedNames[3]));
        runNodeSmoke('release-linux-unpacked-zip-smoke.cjs', 'NEWMARK_LINUX_ZIP', path.join(downloadDir, expectedNames[4]));
      } else {
        console.log(`[verify-github-release-assets] asset startup smokes skipped on unsupported host ${process.platform}`);
      }
    }

    console.log(JSON.stringify({ ok: true, repository, tag, version, assets: hashes }, null, 2));
  } finally {
    if (ownsDownloadDir && !keepDownload) fs.rmSync(downloadDir, { recursive: true, force: true });
    else console.log(`[verify-github-release-assets] downloaded assets retained at ${downloadDir}`);
  }
}

main().catch(error => {
  console.error(`[verify-github-release-assets] ${error.stack || error.message}`);
  process.exit(1);
});
