const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const releaseRoot = process.env.NEWMARK_RELEASE_OUTPUT_DIR
  ? path.resolve(process.env.NEWMARK_RELEASE_OUTPUT_DIR)
  : path.join(repoRoot, 'release');
const version = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
const npmCli = process.env.npm_execpath;
const gradle = process.platform === 'win32'
  ? path.join(repoRoot, 'android', 'gradlew.bat')
  : path.join(repoRoot, 'android', 'gradlew');

function run(command, args, options = {}) {
  console.log(`[release-all] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: appRoot, stdio: 'inherit', env: process.env, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function runBatch(batchFile, args, options = {}) {
  if (process.platform !== 'win32') return run(batchFile, args, options);
  const tokens = [path.basename(batchFile), ...args.map(String)];
  if (tokens.some(value => !/^[A-Za-z0-9._:-]+$/.test(value))) throw new Error(`unsafe batch argument: ${JSON.stringify(tokens)}`);
  const commandLine = ['call', ...tokens].join(' ');
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], { ...options, cwd: path.dirname(batchFile) });
}

run(process.execPath, [path.join(__dirname, 'sync-release-version.cjs'), '--check']);
if (!npmCli || !fs.existsSync(npmCli)) throw new Error('npm_execpath is unavailable; run this orchestrator through npm run release');
if (process.argv.includes('--package-only')) {
  console.log('[release-all] package-only continuation: reusing the full desktop release gate completed immediately before this run');
} else {
  run(process.execPath, [npmCli, 'run', 'test:full-release']);
}
runBatch(gradle, ['-p', '.', 'testDebugUnitTest', 'lintVitalRelease', 'assembleRelease']);
run(process.execPath, [npmCli, 'run', 'build:clean']);
run(process.execPath, [path.join(__dirname, 'dist-portable.cjs')]);
run(process.execPath, [path.join(__dirname, 'dist-linux.cjs')], {
  env: { ...process.env, NEWMARK_DIST_LINUX_SKIP_VERIFICATION: '1' },
});

const builtApk = path.join(repoRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const releaseApk = path.join(releaseRoot, `Newmark-Agent-${version}-android.apk`);
if (!fs.existsSync(builtApk)) throw new Error(`Android release APK is missing: ${builtApk}`);
fs.copyFileSync(builtApk, releaseApk);
console.log(`[release-all] Windows, Linux, and Android artifacts are ready in ${releaseRoot}`);
