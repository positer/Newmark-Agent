const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const appVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
const keepRoot = process.env.NEWMARK_KEEP_SMOKE === '1';

function log(message) {
  console.log(`[release-cli-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShellCli(args, root, extraEnv = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-cli-run-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  const argList = args.map(psQuote).join(', ');
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
      cwd: appRoot,
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
      reject(new Error(`PowerShell timed out for ${args[0]}. stdout=${psStdout} stderr=${psStderr}`));
    }, 90000);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(new Error(`PowerShell failed for ${args[0]}: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timeout);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (error) {
        log(`warning: could not remove temp CLI run dir ${workDir}: ${error.message}`);
      }
      if (code !== 0) {
        reject(new Error(`CLI ${args[0]} exited ${code}. stdout=${stdout || psStdout} stderr=${stderr || psStderr}`));
        return;
      }
      const running = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "(@(Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })).Count",
      ], { encoding: 'utf8', windowsHide: true });
      if (Number(String(running.stdout || '').trim()) > 0) {
        spawnSync('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force",
        ], { windowsHide: true });
        reject(new Error(`CLI ${args[0]} left a release GUI process running`));
        return;
      }
      resolve({ stdout, stderr, root });
    });
  });
}

function writeConfig(root, port) {
  const config = {
    models: {
      providers: [{
        name: 'ReleaseCliMock',
        base_url: `http://127.0.0.1:${port}/v1`,
        api_key: 'mock-key',
        protocol: 'openai',
        enabled: true,
        models: [
          'release-cli-mock',
          { name: 'gpt-5.5', display: 'GPT 5.5', description: 'Stale release validation metadata: text-only', vision: false },
        ],
      }],
      default_model: 'release-cli-mock',
      default_intelligence: 'medium',
      agent_engine: 'builtin',
      auto_switch: false,
    },
    agent: { default_mode: 'build' },
    terminal: { interrupt_timeout_ms: 0 },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function startMockServer() {
  const requests = [];
  const sockets = new Set();
  const responseText = 'RELEASE_CLI_SEND_OK 做了什么 验证 文件';
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      if (req.method === 'GET' && req.url === '/anthropic/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [{ id: 'claude-release-cli' }, { id: 'claude-release-pro' }] }));
        return;
      }
      if (req.method === 'GET' && req.url === '/env-anthropic/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.method === 'GET' && req.url === '/bad-env-anthropic/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/anthropic/messages') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'ANTHROPIC_RELEASE_OK' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/env-anthropic/messages') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'ANTHROPIC_ENV_RELEASE_OK' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/bad-env-anthropic/messages') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ content: [] }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: responseText } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: responseText } }] }));
      }
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, responseText, sockets }));
  });
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows CLI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkReleaseCliSmoke-'));
  const mock = await startMockServer();
  try {
    writeConfig(root, mock.port);

    const state = await runPowerShellCli(['state', '--root', root], root);
    const parsedState = JSON.parse(state.stdout);
    if (parsedState.root !== root) fail('state did not use requested root');
    if (parsedState.model !== 'release-cli-mock') fail('state did not load mock model');
    if (parsedState.language !== 'auto') fail(`state did not expose default language: ${parsedState.language}`);
    if (parsedState.autoSwitch !== false || parsedState.autoSwitchScope !== 'all') fail(`state did not expose default Auto switch fields: ${state.stdout}`);
    if (parsedState.openAIApiMode !== 'chat_stream') fail(`state did not expose OpenAI API mode: ${state.stdout}`);
    if (!parsedState.contextWindow || parsedState.contextWindow.model !== 'release-cli-mock' || parsedState.contextWindow.maxTokens < 1) fail(`state did not expose context window: ${state.stdout}`);
    const zhState = await runPowerShellCli(['state', '--language', 'zh', '--root', root], root);
    const parsedZhState = JSON.parse(zhState.stdout);
    if (parsedZhState.language !== 'zh') fail(`state --language zh did not override language: ${zhState.stdout}`);
    log('state ok');

    const toolFile = path.join(root, 'cli-tool.txt');
    const toolArgsFile = path.join(root, 'tool-args.json');
    fs.writeFileSync(toolArgsFile, JSON.stringify({ path: toolFile, content: 'RELEASE_CLI_TOOL_OK' }), 'utf8');
    const tool = await runPowerShellCli(['tool', 'write', '--args-file', toolArgsFile, '--root', root], root);
    if (!tool.stdout.includes('[write] OK')) fail('tool write did not report success');
    if (fs.readFileSync(toolFile, 'utf8') !== 'RELEASE_CLI_TOOL_OK') fail('tool write did not create expected file');
    log('tool ok');

    const promptFile = path.join(root, 'prompt.txt');
    fs.writeFileSync(promptFile, '请通过 release CLI 返回中文 UTF-8', 'utf8');
    const send = await runPowerShellCli(['send', '--input-file', promptFile, '--mode', 'build', '--model', 'release-cli-mock', '--conversation', 'release-cli-smoke', '--root', root], root);
    if (!send.stdout.includes(mock.responseText)) fail(`send output missing UTF-8 response: ${send.stdout}`);
    if (/[åæçäè]/.test(send.stdout)) fail(`send output contains mojibake markers: ${send.stdout}`);
    if (!mock.requests.some(r => r.url === '/v1/chat/completions' && r.body.includes('"stream":true'))) fail('send did not call streaming chat completions');
    const englishSend = await runPowerShellCli(['send', 'release cli language override', '--language', 'en', '--mode', 'build', '--model', 'release-cli-mock', '--conversation', 'release-cli-language', '--root', root], root);
    if (!englishSend.stdout.includes(mock.responseText)) fail(`send --language en output missing response: ${englishSend.stdout}`);
    const languageRequest = mock.requests.find(r => r.body.includes('release cli language override'));
    if (!languageRequest || !languageRequest.body.includes('general.language=en')) fail('send --language en did not inject English language policy');
    log('send ok');

    const validation = await runPowerShellCli(['validate-models', '--selected', 'ReleaseCliMock/release-cli-mock', '--root', root], root);
    const parsedValidation = JSON.parse(validation.stdout);
    if (!Array.isArray(parsedValidation)) fail(`validate-models did not return an array: ${validation.stdout}`);
    const releaseModelValidation = parsedValidation.find(r => r.name === 'ReleaseCliMock/release-cli-mock');
    if (!releaseModelValidation || releaseModelValidation.status !== 'available') {
      fail(`validate-models did not mark selected release model available: ${validation.stdout}`);
    }
    if (validation.stdout.includes('mock-key')) fail('validate-models leaked provider API key');
    if (!mock.requests.some(r => r.url === '/v1/chat/completions' && r.body.includes('"model":"release-cli-mock"') && r.body.includes('"content":"Hi"'))) {
      fail('validate-models did not call chat completions for the selected release model');
    }
    const visionValidation = await runPowerShellCli(['validate-models', '--selected', 'ReleaseCliMock/gpt-5.5', '--root', root], root);
    const parsedVisionValidation = JSON.parse(visionValidation.stdout);
    const releaseVisionValidation = parsedVisionValidation.find(r => r.name === 'ReleaseCliMock/gpt-5.5');
    if (!releaseVisionValidation || releaseVisionValidation.status !== 'available' || releaseVisionValidation.vision_input !== true) {
      fail(`validate-models did not infer GPT-5.5 vision input in packaged CLI: ${visionValidation.stdout}`);
    }
    const validatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const validatedProviders = validatedConfig.models?.providers?.value || validatedConfig.models?.providers || [];
    const validatedGpt55 = validatedProviders.find(p => p.name === 'ReleaseCliMock')?.models?.find(m => m.name === 'gpt-5.5');
    if (!validatedGpt55 || validatedGpt55.vision !== true || validatedGpt55.evaluation?.vision_input !== true || !String(validatedGpt55.description || '').includes('vision-input')) {
      fail(`validate-models did not persist inferred GPT-5.5 vision metadata: ${JSON.stringify(validatedGpt55)}`);
    }
    log('validate-models ok');

    const market = await runPowerShellCli(['skills-market', '--query', 'frontend', '--root', root], root);
    JSON.parse(market.stdout);
    log('skills-market ok');

    const memoryContentFile = path.join(root, 'release-cli-memory.md');
    fs.writeFileSync(memoryContentFile, [
      '# Release CLI Memory',
      '',
      'ReleaseCliMemoryNeedle proves packaged memory-lab update/read.',
    ].join('\n'), 'utf8');
    const memoryUpdate = await runPowerShellCli([
      'memory-lab',
      '--update',
      '--name', 'release-cli-memory',
      '--description', 'Release CLI Memory Lab smoke component',
      '--tags', '#Release-CLI,#Agent-Skill',
      '--content-file', memoryContentFile,
      '--root', root,
    ], root);
    const parsedMemoryUpdate = JSON.parse(memoryUpdate.stdout);
    if (parsedMemoryUpdate.ok !== true) fail(`memory-lab update failed: ${memoryUpdate.stdout}`);
    if (!parsedMemoryUpdate.index?.tags?.['#Release-CLI']?.components?.includes('release-cli-memory')) {
      fail(`memory-lab update did not link component to deepest Release tag: ${memoryUpdate.stdout}`);
    }
    if (!parsedMemoryUpdate.index?.tags?.['#Release']?.children?.includes('#Release-CLI')) {
      fail(`memory-lab update did not create Release parent tag: ${memoryUpdate.stdout}`);
    }
    if (!parsedMemoryUpdate.index?.tags?.['#Agent']?.children?.includes('#Agent-Skill')) {
      fail(`memory-lab update did not create Agent parent tag: ${memoryUpdate.stdout}`);
    }
    const memoryRead = await runPowerShellCli(['memory-lab', '--component', 'release-cli-memory', '--root', root], root);
    const parsedMemoryRead = JSON.parse(memoryRead.stdout);
    if (parsedMemoryRead.ok !== true || !parsedMemoryRead.component?.content?.includes('ReleaseCliMemoryNeedle')) {
      fail(`memory-lab read did not return component core markdown: ${memoryRead.stdout}`);
    }
    if (!String(parsedMemoryRead.indexPath || '').startsWith(path.join(root, 'Memory Lab'))) {
      fail(`memory-lab read returned index outside requested root: ${memoryRead.stdout}`);
    }
    if (!String(parsedMemoryRead.instructions || '').includes('Memory Lab')) {
      fail(`memory-lab read did not return usage instructions: ${memoryRead.stdout}`);
    }
    const memoryReindex = await runPowerShellCli(['memory-lab', '--reindex', '--root', root], root);
    const parsedMemoryReindex = JSON.parse(memoryReindex.stdout);
    if (parsedMemoryReindex.ok !== true || !parsedMemoryReindex.index?.tags?.['#Release-CLI']?.components?.includes('release-cli-memory')) {
      fail(`memory-lab reindex did not preserve component links: ${memoryReindex.stdout}`);
    }
    log('memory-lab ok');

    const updateSource = path.join(root, 'release-update-source');
    const updateTarget = path.join(root, 'release-update-target');
    fs.mkdirSync(path.join(updateSource, 'resources'), { recursive: true });
    fs.mkdirSync(path.join(updateTarget, 'Work'), { recursive: true });
    fs.writeFileSync(path.join(updateSource, 'Newmark Agent.exe'), 'release update binary', 'utf8');
    fs.writeFileSync(path.join(updateSource, 'resources', 'update-marker.bin'), 'release update marker', 'utf8');
    fs.writeFileSync(path.join(updateSource, 'config.json'), 'source config should be preserved away', 'utf8');
    fs.writeFileSync(path.join(updateTarget, 'config.json'), 'target config must survive', 'utf8');
    fs.writeFileSync(path.join(updateTarget, 'Work', 'state.txt'), 'target workspace state must survive', 'utf8');
    const installVersion = await runPowerShellCli(['install-update', '--version', '--root', root], root);
    const parsedInstallVersion = JSON.parse(installVersion.stdout);
    if (parsedInstallVersion.ok !== true || parsedInstallVersion.version !== appVersion) fail(`install-update version failed: ${installVersion.stdout}`);
    const installDryRun = await runPowerShellCli(['install-update', '--source', updateSource, '--target', updateTarget, '--expected-version', appVersion, '--dry-run', '--root', root], root);
    const parsedInstallDryRun = JSON.parse(installDryRun.stdout);
    if (parsedInstallDryRun.ok !== true || parsedInstallDryRun.dryRun !== true || !parsedInstallDryRun.preserved.includes('config.json')) {
      fail(`install-update dry-run did not report preserved local data: ${installDryRun.stdout}`);
    }
    const installRun = await runPowerShellCli(['install-update', '--source', updateSource, '--target', updateTarget, '--expected-version', appVersion, '--root', root], root);
    const parsedInstallRun = JSON.parse(installRun.stdout);
    if (parsedInstallRun.ok !== true || !parsedInstallRun.copied.includes('Newmark Agent.exe')) fail(`install-update run failed: ${installRun.stdout}`);
    if (fs.readFileSync(path.join(updateTarget, 'config.json'), 'utf8') !== 'target config must survive') fail('install-update overwrote config.json');
    if (fs.readFileSync(path.join(updateTarget, 'Work', 'state.txt'), 'utf8') !== 'target workspace state must survive') fail('install-update overwrote Work state');
    if (fs.readFileSync(path.join(updateTarget, 'resources', 'update-marker.bin'), 'utf8') !== 'release update marker') fail('install-update did not copy app resource marker');
    log('install-update ok');

    const anthropicKey = 'test-key-release-cli';
    const fuzzy = await runPowerShellCli([
      'fuzzy-inject',
      '--name', 'ReleaseAnthropic',
      '--endpoint-env', 'NEWMARK_RELEASE_ANTHROPIC_ENDPOINT',
      '--key-env', 'NEWMARK_RELEASE_ANTHROPIC_KEY',
      '--protocol', 'anthropic',
      '--root', root,
    ], root, {
      NEWMARK_RELEASE_ANTHROPIC_ENDPOINT: `http://127.0.0.1:${mock.port}/anthropic`,
      NEWMARK_RELEASE_ANTHROPIC_KEY: anthropicKey,
    });
    if (fuzzy.stdout.includes(anthropicKey)) fail('fuzzy-inject leaked API key');
    const fuzzyResult = JSON.parse(fuzzy.stdout);
    if (fuzzyResult.ok !== true || !fuzzyResult.models.includes('claude-release-cli')) fail(`fuzzy-inject did not import/validate anthropic model: ${fuzzy.stdout}`);
    const updatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const persistedProviders = updatedConfig.models?.providers?.value || updatedConfig.models?.providers || [];
    const releaseAnthropic = persistedProviders.find(p => p.name === 'ReleaseAnthropic');
    if (!releaseAnthropic || releaseAnthropic.protocol !== 'anthropic') fail('fuzzy-inject did not persist anthropic protocol');
    if (!releaseAnthropic.models.some(m => m.name === 'claude-release-cli' && m.evaluation?.status === 'available')) fail('fuzzy-inject did not persist available model evaluation');
    const modelListRequest = mock.requests.find(r => r.url === '/anthropic/models');
    const messageRequest = mock.requests.find(r => r.url === '/anthropic/messages');
    if (!modelListRequest || !messageRequest) fail('fuzzy-inject did not call anthropic /models and /messages');
    log('fuzzy-inject anthropic ok');

    const envFileKey = 'test-key-release-env-file';
    const envFile = path.join(root, 'Claude code mock.txt');
    fs.writeFileSync(envFile, [
      `$env:NEWMARK_PROVIDER="ReleaseEnvAnthropic"`,
      `$env:ANTHROPIC_BASE_URL="http://127.0.0.1:${mock.port}/env-anthropic"`,
      `$env:ANTHROPIC_AUTH_TOKEN="${envFileKey}"`,
      `$env:ANTHROPIC_MODEL="claude-release-env"`,
      `$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-release-env"`,
    ].join('\r\n'), 'utf8');
    const envFuzzy = await runPowerShellCli([
      'fuzzy-inject',
      '--env-file-env', 'NEWMARK_RELEASE_CLAUDE_ENV_FILE',
      '--root', root,
    ], root, {
      NEWMARK_RELEASE_CLAUDE_ENV_FILE: envFile,
    });
    if (envFuzzy.stdout.includes(envFileKey)) fail('env-file fuzzy-inject leaked API key');
    const envFuzzyResult = JSON.parse(envFuzzy.stdout);
    if (envFuzzyResult.ok !== true || envFuzzyResult.provider !== 'ReleaseEnvAnthropic' || !envFuzzyResult.models.includes('claude-release-env')) {
      fail(`env-file fuzzy-inject did not import/validate env model: ${envFuzzy.stdout}`);
    }
    const envUpdatedConfig = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const envProviders = envUpdatedConfig.models?.providers?.value || envUpdatedConfig.models?.providers || [];
    const releaseEnvAnthropic = envProviders.find(p => p.name === 'ReleaseEnvAnthropic');
    if (!releaseEnvAnthropic || releaseEnvAnthropic.protocol !== 'anthropic') fail('env-file fuzzy-inject did not persist anthropic protocol');
    if (!releaseEnvAnthropic.models.some(m => m.name === 'claude-release-env' && m.evaluation?.status === 'available')) fail('env-file fuzzy-inject did not persist available env model evaluation');
    if (!mock.requests.some(r => r.url === '/env-anthropic/models') || !mock.requests.some(r => r.url === '/env-anthropic/messages')) {
      fail('env-file fuzzy-inject did not call env anthropic /models and /messages');
    }
    log('fuzzy-inject env-file anthropic ok');

    const badEnvFileKey = 'test-key-release-bad-env-file';
    const badEnvFile = path.join(root, 'Claude bad env mock.txt');
    fs.writeFileSync(badEnvFile, [
      `$env:NEWMARK_PROVIDER="ReleaseBadEnvAnthropic"`,
      `$env:ANTHROPIC_BASE_URL="http://127.0.0.1:${mock.port}/bad-env-anthropic"`,
      `$env:ANTHROPIC_AUTH_TOKEN="${badEnvFileKey}"`,
      `$env:ANTHROPIC_MODEL="claude-release-bad-env"`,
    ].join('\r\n'), 'utf8');
    const badEnvFuzzy = await runPowerShellCli([
      'fuzzy-inject',
      '--env-file-env', 'NEWMARK_RELEASE_BAD_CLAUDE_ENV_FILE',
      '--root', root,
    ], root, {
      NEWMARK_RELEASE_BAD_CLAUDE_ENV_FILE: badEnvFile,
    });
    if (badEnvFuzzy.stdout.includes(badEnvFileKey)) fail('bad env-file fuzzy-inject leaked API key');
    const badEnvFuzzyResult = JSON.parse(badEnvFuzzy.stdout);
    if (badEnvFuzzyResult.ok !== false || badEnvFuzzyResult.provider !== 'ReleaseBadEnvAnthropic' || !badEnvFuzzyResult.models.includes('claude-release-bad-env')) {
      fail(`bad env-file fuzzy-inject did not import failed candidate: ${badEnvFuzzy.stdout}`);
    }
    if (!String(badEnvFuzzyResult.warning || '').includes('none validated as available') || !String(badEnvFuzzyResult.warning || '').includes('claude-release-bad-env: unavailable')) {
      fail(`bad env-file fuzzy-inject warning did not include validation status: ${badEnvFuzzy.stdout}`);
    }
    if (!mock.requests.some(r => r.url === '/bad-env-anthropic/models') || !mock.requests.some(r => r.url === '/bad-env-anthropic/messages')) {
      fail('bad env-file fuzzy-inject did not call bad env anthropic /models and /messages');
    }
    log('fuzzy-inject env-file failure warning ok');

    log('all release CLI smoke checks passed');
  } finally {
    if (typeof mock.server.closeAllConnections === 'function') {
      mock.server.closeAllConnections();
    }
    for (const socket of mock.sockets || []) {
      try { socket.destroy(); } catch {}
    }
    await new Promise(resolve => mock.server.close(() => resolve()));
    if (keepRoot) {
      log(`kept root: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  process.exit(0);
})().catch(error => {
  console.error(`[release-cli-smoke] ${error.message}`);
  process.exit(1);
});
