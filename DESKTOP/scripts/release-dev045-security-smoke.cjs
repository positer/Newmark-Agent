'use strict';

/**
 * dev-0.4.5 打包后安全策略 smoke（win-unpack）
 *
 * 针对打包后的 Windows exe 验证本轮安全边界：
 *   1. 删除审查精准拦截（git clean / PowerShell ri -Recurse / CMD for…do del /
 *      逻辑或 || 后的单文件删除放行）；
 *   2. git 上传二轮审查硬性阻挡 + 高危 findings 只报「类型 + 位置」、绝不泄露值；
 *   3. security_review_confirmed=true 二轮确认后放行。
 *
 * 运行：NEWMARK_TEST_EXE=<win-unpacked>\Newmark Agent.exe node scripts/release-dev045-security-smoke.cjs
 * 依赖：先打包（dist-portable）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const exePath = path.resolve(process.env.NEWMARK_TEST_EXE || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe'));

let assertions = 0;
function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runCli(args, runtimeRoot) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dev045-cli-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(exePath)}`,
    `$arguments = @(${args.map(psQuote).join(', ')})`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    '$process = Start-Process -FilePath $exe -ArgumentList $arguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $process.ExitCode',
  ].join('\r\n'), 'utf8');
  try {
    const process = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: path.dirname(exePath),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
    });
    if (process.error) throw process.error;
    return {
      status: Number(process.status || 0),
      stdout: fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8').trim() : '',
      stderr: fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8').trim() : '',
      runtimeRoot,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function runTool(root, tool, argsObj) {
  const argsFile = path.join(root, `.tool-${tool}-args.json`);
  fs.writeFileSync(argsFile, JSON.stringify(argsObj), 'utf8');
  return runCli(['tool', tool, '--args-file', argsFile, '--mode', 'build', '--root', root], root);
}

function parseToolEnvelope(result, label) {
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch {
    throw new Error(`${label} returned invalid JSON: ${result.stdout || '<empty>'}`);
  }
  return envelope;
}

function verifyDeletionPrecision(root) {
  const gitClean = runTool(root, 'bash', { command: 'git clean -fd' });
  const gitCleanEnv = parseToolEnvelope(gitClean, 'git clean');
  assert(gitClean.status === 0 && String(gitCleanEnv.result || '').includes('deletion guard') && String(gitCleanEnv.result || '').includes('git-clean'), 'bash: git clean -fd is hard-blocked as batch deletion');

  const riRecurse = runTool(root, 'bash', { command: 'ri -Recurse build' });
  const riEnv = parseToolEnvelope(riRecurse, 'ri recurse');
  assert(riRecurse.status === 0 && String(riEnv.result || '').includes('deletion guard') && String(riEnv.result || '').includes('Recursive'), 'bash: PowerShell ri -Recurse is hard-blocked');

  const cmdFor = runTool(root, 'bash', { command: 'for /f "delims=" %i in (*.txt) do del %i' });
  const cmdForEnv = parseToolEnvelope(cmdFor, 'cmd for-do');
  assert(cmdFor.status === 0 && String(cmdForEnv.result || '').includes('deletion guard') && String(cmdForEnv.result || '').includes('Loop-based'), 'bash: CMD for ... do del is hard-blocked');

  const orSingle = runTool(root, 'bash', { command: 'echo done || rm __guard_absent__.txt' });
  const orEnv = parseToolEnvelope(orSingle, 'or single');
  assert(orSingle.status === 0 && !String(orEnv.result || '').includes('deletion guard'), 'bash: single rm after || is allowed (not a pipe)');
}

function verifyGitUploadGate(root) {
  const repo = root;
  fs.writeFileSync(path.join(repo, 'secrets.json'), '{"api_key":"sk-testsecret12345678901234567890"}', 'utf8');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'home https://user:pass@example.test/internal and C:\\Users\\alice\\secrets', 'utf8');
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  git(['init']);
  git(['config', 'user.email', 'smoke@example.test']);
  git(['config', 'user.name', 'Newmark Security Smoke']);
  git(['add', 'secrets.json', 'notes.txt']);
  git(['commit', '-m', 'security smoke baseline']);
  git(['remote', 'add', 'origin', 'https://github.com/example/public-audit.git']);

  const audit = runTool(root, 'repo_security_audit', { path: repo });
  const auditEnv = parseToolEnvelope(audit, 'repo_security_audit');
  assert(audit.status === 0, 'repo_security_audit: runs successfully');
  const rawAuditResult = auditEnv.result;
  const auditResult = typeof rawAuditResult === 'string' ? JSON.parse(rawAuditResult || '{}') : (rawAuditResult || {});
  const review = auditResult.security_review || {};
  const secretFindings = Array.isArray(review.secret_findings) ? review.secret_findings : [];
  const privacyFindings = Array.isArray(review.privacy_findings) ? review.privacy_findings : [];
  assert(secretFindings.some(f => f.path === 'secrets.json' && f.type && !('sample' in f) && !('value' in f)), 'audit secret findings report only type + location');
  assert(privacyFindings.some(f => f.path === 'notes.txt' && f.type && !('sample' in f) && !('value' in f)), 'audit privacy findings report only type + location');
  assert(!audit.stdout.includes('sk-testsecret12345678901234567890') && !audit.stdout.includes('user:pass@example.test') && !audit.stdout.includes('alice'), 'audit never exposes secret/privacy values to the Agent');

  const push = runTool(root, 'git_push', { message: 'blocked by security review' });
  const pushEnv = parseToolEnvelope(push, 'git_push blocked');
  const pushText = String(pushEnv.result || '');
  assert(push.status === 0 && pushText.includes('BLOCKED') && pushText.includes('openai_or_generic_sk_key') && pushText.includes('credential_url'), 'git_push: hard-blocked and reports only finding types');
  assert(!pushText.includes('sk-testsecret12345678901234567890') && !pushText.includes('user:pass@example.test'), 'git_push block never exposes secret/privacy values');

  const confirmed = runTool(root, 'git_push', { message: 'confirmed', security_review_confirmed: true });
  const confirmedEnv = parseToolEnvelope(confirmed, 'git_push confirmed');
  const confirmedText = String(confirmedEnv.result || '');
  assert(confirmed.status === 0 && confirmedText.includes('security_review_confirmed=true'), 'git_push: proceeds after security_review_confirmed=true second review');
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('[release-dev045-security-smoke] skipped outside Windows');
    return;
  }
  assert(fs.existsSync(exePath), `release executable is missing: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-dev045-security-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      models: { providers: [], default_model: 'auto', auto_switch: false },
      agent: { default_mode: 'build' },
      workspace: { auto_create_timestamp_workspace: false },
    }, null, 2), 'utf8');
    verifyDeletionPrecision(root);
    verifyGitUploadGate(root);
    console.log(JSON.stringify({ ok: true, version: packageJson.version, assertions, real_api_called: false }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
})().catch(error => {
  console.error(`[release-dev045-security-smoke] ${error.stack || error.message}`);
  process.exit(1);
});
