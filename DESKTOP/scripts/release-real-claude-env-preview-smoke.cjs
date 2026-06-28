const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const envFile = process.env.NEWMARK_REAL_CLAUDE_ENV_FILE || '';

function log(message) { console.log(`[release-real-claude-env-preview-smoke] ${message}`); }
function fail(message) { throw new Error(message); }
function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function readEnvSecretMarkers(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const markers = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(?:AUTH_TOKEN|API_KEY)\s*=\s*["']?([^"']+)/i);
    if (match && match[1]) markers.push(match[1].trim());
  }
  return markers.filter(Boolean);
}

function runPowerShellCli(args, root, extraEnv = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-claude-preview-cli-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(exePath)}`,
    `$argList = @(${args.map(psQuote).join(', ')})`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    '$p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $p.ExitCode',
  ].join('\r\n'), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: appRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let psStdout = '';
    let psStderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { psStdout += chunk; });
    child.stderr.on('data', chunk => { psStderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PowerShell timed out. stdout=${psStdout} stderr=${psStderr}`));
    }, 90000);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : psStdout;
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : psStderr;
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      if (code !== 0) reject(new Error(`CLI exited ${code}. stdout=${stdout} stderr=${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

function ensureNoReleaseProcess() {
  const running = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "(@(Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })).Count",
  ], { encoding: 'utf8', windowsHide: true });
  const count = Number(String(running.stdout || '').trim());
  if (count > 0) {
    spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force",
    ], { windowsHide: true });
    fail('Claude env preview smoke left a packaged Newmark process running');
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows CLI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  if (!envFile) {
    log('skipped: set NEWMARK_REAL_CLAUDE_ENV_FILE to run Claude env preview smoke');
    return;
  }
  if (!fs.existsSync(envFile)) fail(`missing Claude env file: ${envFile}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkClaudeEnvPreview-'));
  const secrets = readEnvSecretMarkers(envFile);
  try {
    const result = await runPowerShellCli([
      'fuzzy-inject',
      '--env-file-env', 'NEWMARK_REAL_CLAUDE_ENV_FILE',
      '--preview-only',
      '--root', root,
    ], root, { NEWMARK_REAL_CLAUDE_ENV_FILE: envFile });

    for (const secret of secrets) {
      if (secret && result.stdout.includes(secret)) fail('preview leaked Claude env API key/token');
    }
    const preview = JSON.parse(result.stdout);
    if (preview.preview !== true || preview.ok !== true) fail(`preview did not report ok: ${result.stdout}`);
    if (preview.provider !== 'DeepSeekAnthropic') fail(`unexpected provider: ${result.stdout}`);
    if (preview.protocol !== 'anthropic') fail(`unexpected protocol: ${result.stdout}`);
    if (!String(preview.base_url || '').includes('api.deepseek.com/anthropic')) fail(`unexpected base_url: ${result.stdout}`);
    if (!preview.has_api_key) fail(`preview did not detect API key: ${result.stdout}`);
    if (!Array.isArray(preview.models) || !preview.models.includes('deepseek-v4-pro[1m]') || !preview.models.includes('deepseek-v4-flash')) {
      fail(`preview did not include expected DeepSeek models: ${result.stdout}`);
    }
    log('Claude env preview ok');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    ensureNoReleaseProcess();
  }
})().catch(error => {
  console.error(error.stack || error.message);
  try { ensureNoReleaseProcess(); } catch {}
  process.exit(1);
});
