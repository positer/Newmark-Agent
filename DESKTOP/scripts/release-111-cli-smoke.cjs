const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const keepRoot = process.env.NEWMARK_KEEP_111_CLI_SMOKE === '1';

function log(message) {
  console.log(`[release-111-cli-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

function runPackaged(args, cwd = appRoot, extraEnv = {}, timeoutMs = 120000) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-111-cli-run-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  const argList = args.map(arg => psQuote(cmdQuote(arg))).join(', ');
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(exePath)}`,
    `$argList = @(${argList})`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    '$p = Start-Process -FilePath $exe -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $p.ExitCode',
  ].join('\r\n'), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let psStdout = '';
    let psStderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { psStdout += chunk; });
    child.stderr.on('data', chunk => { psStderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PowerShell timed out for ${args.join(' ')}. stdout=${psStdout} stderr=${psStderr}`));
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(new Error(`PowerShell failed for ${args.join(' ')}: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timeout);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      if (code !== 0) {
        reject(new Error(`CLI ${args.join(' ')} exited ${code}. stdout=${stdout || psStdout} stderr=${stderr || psStderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function startMockServer() {
  const requests = [];
  const sockets = new Set();
  let chatCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'release-111-cli-mock' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'RELEASE_111_CLI_VALIDATE_OK' } }] }));
        return;
      }
      chatCount += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      if (chatCount === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_takeover_start', type: 'function', function: { name: 'terminal_takeover', arguments: JSON.stringify({ action: 'start', name: 'release111', shell: 'powershell' }) } }] } }] })}\n\n`);
      } else if (chatCount === 2) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_takeover_write', type: 'function', function: { name: 'terminal_takeover', arguments: JSON.stringify({ action: 'write', name: 'release111', command: 'Set-Location .; $env:NEWMARK_111_TAKEOVER=\"persisted\"; Write-Output \"TAKEOVER_WRITE_OK:$env:NEWMARK_111_TAKEOVER\"' }) } }] } }] })}\n\n`);
      } else if (chatCount === 3) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_wait', type: 'function', function: { name: 'wait', arguments: JSON.stringify({ seconds: 1 }) } }] } }] })}\n\n`);
      } else if (chatCount === 4) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_takeover_read', type: 'function', function: { name: 'terminal_takeover', arguments: JSON.stringify({ action: 'read', name: 'release111', max_chars: 6000 }) } }] } }] })}\n\n`);
      } else if (chatCount === 5) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_takeover_stop', type: 'function', function: { name: 'terminal_takeover', arguments: JSON.stringify({ action: 'stop', name: 'release111' }) } }] } }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'RELEASE_111_CLI_TERMINAL_TAKEOVER_DONE' } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, sockets }));
  });
}

function writeConfig(root, port) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: [{
        name: 'Release111CliMock',
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [{ name: 'release-111-cli-mock', display: 'release-111-cli-mock', evaluation: { status: 'available', latency: 0.1 } }],
      }],
      default_model: 'release-111-cli-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    workspace: { access_permission: 'full_access', on_permission_violation: 'deny' },
    general: { language: 'en' },
  }, null, 2), 'utf8');
}

async function runOptionalSshWorkspaceSmoke(root, argsDir) {
  const host = process.env.NEWMARK_RELEASE_SSH_HOST || '';
  const user = process.env.NEWMARK_RELEASE_SSH_USER || '';
  const port = Number(process.env.NEWMARK_RELEASE_SSH_PORT || 22) || 22;
  const identity = process.env.NEWMARK_RELEASE_SSH_KEY || '';
  const remotePath = process.env.NEWMARK_RELEASE_SSH_ROOT || '~/.newmark-agent/release-111-vm-workspace';
  const sshVersion = spawnSync('ssh', ['-V'], { encoding: 'utf8', windowsHide: true });
  if (sshVersion.error) {
    log(`OpenSSH unavailable, real SSH workspace smoke skipped: ${sshVersion.error.message}`);
    return;
  }
  const list = await runPackaged(['tool', 'ssh_workspace', '--args-file', writeJson(argsDir, 'ssh-list.json', { action: 'list' }), '--root', root], appRoot);
  const parsedList = JSON.parse(list.stdout);
  if (!parsedList.ok || !Array.isArray(parsedList.connections)) fail(`ssh_workspace list shape invalid: ${list.stdout}`);
  if (!host || !user) {
    log('OpenSSH tool ok; VM SSH real link skipped because NEWMARK_RELEASE_SSH_HOST and NEWMARK_RELEASE_SSH_USER are not set');
    return;
  }
  const create = await runPackaged(['tool', 'ssh_workspace', '--args-file', writeJson(argsDir, 'ssh-create.json', {
    action: 'create_workspace',
    name: 'release-111-vm-ssh',
    host,
    port,
    user,
    identity_file: identity,
    remote_path: remotePath,
    remote_root: remotePath,
  }), '--root', root], appRoot, {}, 180000);
  const parsedCreate = JSON.parse(create.stdout);
  if (!parsedCreate.ok || parsedCreate.workspace?.kind !== 'ssh' || !parsedCreate.workspace?.remotePcHash) {
    fail(`ssh_workspace real VM create failed: ${create.stdout}`);
  }
  const sshJsonPath = path.join(root, 'Work', 'SSH.json');
  const externalJsonPath = path.join(root, 'Work', 'External.json');
  const sshJson = fs.existsSync(sshJsonPath) ? JSON.parse(fs.readFileSync(sshJsonPath, 'utf8')) : [];
  const externalJson = fs.existsSync(externalJsonPath) ? JSON.parse(fs.readFileSync(externalJsonPath, 'utf8')) : [];
  if (!sshJson.some(item => item.remotePcHash === parsedCreate.workspace.remotePcHash)) fail('SSH.json did not persist remote PC_Hash after real SSH validation');
  if (!externalJson.some(item => item.kind === 'ssh' && item.remotePcHash === parsedCreate.workspace.remotePcHash && item.remotePath === remotePath)) {
    fail('External.json did not persist SSH external workspace linkage');
  }
  log(`ssh_workspace real VM link ok: ${host}:${port} pc_hash=${parsedCreate.workspace.remotePcHash}`);
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows release 1.1.1 CLI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRelease111CliSmoke-'));
  const argsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRelease111CliArgs-'));
  const mock = await startMockServer();
  try {
    writeConfig(root, mock.port);

    const repoPath = repoRoot;
    const fileAudit = await runPackaged(['tool', 'file_audit', '--args-file', writeJson(argsDir, 'file-audit.json', { path: path.join(repoPath, 'README.md'), remote: true }), '--root', repoPath], appRoot);
    const parsedFileAudit = JSON.parse(fileAudit.stdout);
    if (!parsedFileAudit.ok || parsedFileAudit.kind !== 'file' || parsedFileAudit.git?.tracked !== true) fail(`file_audit did not return local tracked file metadata: ${fileAudit.stdout}`);
    if (parsedFileAudit.remote?.provider !== 'github' || parsedFileAudit.remote?.repository !== 'positer/Newmark-Agent') fail(`file_audit did not return GitHub remote metadata: ${fileAudit.stdout}`);
    log('file_audit ok');

    const branch = await runPackaged(['tool', 'git_branch', '--args-file', writeJson(argsDir, 'branch.json', { action: 'current' }), '--root', repoPath], appRoot);
    if (!branch.stdout.trim()) fail(`git_branch current returned empty output: ${branch.stdout}`);
    log(`git_branch current ok: ${branch.stdout.trim()}`);

    const fork = await runPackaged(['tool', 'gh_fork', '--args-file', writeJson(argsDir, 'fork.json', { action: 'status' }), '--root', repoPath], appRoot);
    const parsedFork = JSON.parse(fork.stdout);
    if (typeof parsedFork.isFork !== 'boolean' || !String(parsedFork.nameWithOwner || '').includes('/') || !['github-cli', 'git-remote-fallback'].includes(String(parsedFork.source || ''))) fail(`gh_fork status shape invalid: ${fork.stdout}`);
    log('gh_fork status ok');

    const security = await runPackaged(['tool', 'repo_security_audit', '--args-file', writeJson(argsDir, 'security.json', { path: repoPath }), '--root', repoPath], appRoot, {}, 180000);
    const parsedSecurity = JSON.parse(security.stdout);
    if (!parsedSecurity.remote_repository_detected || parsedSecurity.remote?.repo?.visibility !== 'public' || parsedSecurity.security_review?.required !== true) {
      fail(`repo_security_audit did not require public remote review: ${security.stdout}`);
    }
    if (!Array.isArray(parsedSecurity.security_review?.release_excluded_local_files) || !parsedSecurity.security_review.release_excluded_local_files.includes('archive')) {
      fail(`repo_security_audit did not report release-excluded local files: ${security.stdout}`);
    }
    log('repo_security_audit ok');

    const move = await runPackaged(['tool', 'computer_use', '--args-file', writeJson(argsDir, 'computer-move.json', { action: 'move', x: 10, y: 20, dry_run: true }), '--root', repoPath], appRoot);
    const parsedMove = JSON.parse(move.stdout);
    if (!parsedMove.ok || parsedMove.action !== 'move' || parsedMove.dry_run !== true || parsedMove.x !== 10 || parsedMove.y !== 20) fail(`computer_use dry-run move failed: ${move.stdout}`);
    const target = await runPackaged(['tool', 'computer_use', '--args-file', writeJson(argsDir, 'computer-target.json', { action: 'click', target_id: 'ui-1', dry_run: true }), '--root', repoPath], appRoot);
    const parsedTarget = JSON.parse(target.stdout);
    if (parsedTarget.ok !== false || !String(parsedTarget.error || '').includes('Call computer_use observe first')) fail(`computer_use target_id guard failed: ${target.stdout}`);
    const scroll = await runPackaged(['tool', 'computer_use', '--args-file', writeJson(argsDir, 'computer-scroll.json', { action: 'scroll', x: 10, y: 20, scroll_y: 240, dry_run: true }), '--root', repoPath], appRoot);
    const parsedScroll = JSON.parse(scroll.stdout);
    if (!parsedScroll.ok || parsedScroll.action !== 'scroll' || parsedScroll.scroll_y !== 240 || parsedScroll.dry_run !== true) fail(`computer_use dry-run scroll failed: ${scroll.stdout}`);
    log('computer_use dry-run, scroll, and target_id guard ok');
    await runOptionalSshWorkspaceSmoke(root, argsDir);

    const promptFile = path.join(root, 'prompt.txt');
    fs.writeFileSync(promptFile, 'Run terminal takeover start, write, read, stop and report completion.', 'utf8');
    const takeover = await runPackaged(['send', '--input-file', promptFile, '--mode', 'build', '--model', 'release-111-cli-mock', '--conversation', 'release-111-terminal', '--root', root], appRoot, {}, 180000);
    const stateFiles = fs.existsSync(path.join(root, 'Work'))
      ? fs.readdirSync(path.join(root, 'Work'), { recursive: true }).map(name => path.join(root, 'Work', String(name))).filter(name => name.endsWith(path.join('conversations', 'state.json')))
      : [];
    const stateText = stateFiles.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').join('\n');
    const expectedTakeoverCalls = ['action\\":\\"start', 'action\\":\\"write', 'action\\":\\"read', 'action\\":\\"stop'];
    const stateHasTakeoverChain = expectedTakeoverCalls.every(marker => stateText.includes(marker)) && stateText.includes('TAKEOVER_WRITE_OK');
    if (!takeover.stdout.includes('RELEASE_111_CLI_TERMINAL_TAKEOVER_DONE') || !stateHasTakeoverChain) {
      fail(`terminal_takeover Agent CLI path did not persist same session: ${takeover.stdout}`);
    }
    log('terminal_takeover CLI Agent path ok');

    log('all release 1.1.1 CLI feature checks passed');
  } finally {
    if (typeof mock.server.closeAllConnections === 'function') mock.server.closeAllConnections();
    for (const socket of mock.sockets || []) {
      try { socket.destroy(); } catch {}
    }
    await new Promise(resolve => mock.server.close(() => resolve()));
    if (keepRoot) {
      log(`kept root: ${root}`);
      log(`kept args: ${argsDir}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(argsDir, { recursive: true, force: true });
    }
  }
})().catch(error => {
  console.error(`[release-111-cli-smoke] ${error.message}`);
  process.exit(1);
});
