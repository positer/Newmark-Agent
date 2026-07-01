const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const keepRoot = process.env.NEWMARK_KEEP_REAL_APINEBULA_MEMORY_SWITCH_SMOKE === '1';

const providerName = process.env.NEWMARK_APINEBULA_PROVIDER || 'APInebulaRealMemorySwitch';
const baseUrl = process.env.NEWMARK_APINEBULA_BASE_URL || 'https://apinebula.com/v1';
const modelName = process.env.NEWMARK_APINEBULA_MODEL || 'gpt-5.4-mini';
const apiKey = process.env.NEWMARK_APINEBULA_KEY || process.env.NEWMARK_REAL_API_KEY || '';
const unavailableModel = process.env.NEWMARK_APINEBULA_BAD_MODEL || 'newmark-unavailable-model-for-fallback';
const memoryComponentName = 'Real APInebula Memory Lab Smoke';
const memoryComponentSlug = 'real-apinebula-memory-lab-smoke';

function log(message) {
  console.log(`[release-real-apinebula-memory-switch-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sanitize(text) {
  let out = String(text || '');
  for (const secret of [apiKey, process.env.NEWMARK_REAL_API_KEY, process.env.NEWMARK_APINEBULA_KEY]) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out.replace(/sk-[A-Za-z0-9_\-.]{8,}/g, 'sk-***REDACTED***');
}

function runPowerShellCli(args, root, timeoutMs = 240000) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-real-apinebula-cli-'));
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
      env: process.env,
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
      reject(new Error(`PowerShell timed out for ${args[0]}. stdout=${sanitize(psStdout)} stderr=${sanitize(psStderr)}`));
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(new Error(`PowerShell failed for ${args[0]}: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timeout);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      if (code !== 0) {
        reject(new Error(`CLI ${args[0]} exited ${code}. stdout=${sanitize(stdout || psStdout)} stderr=${sanitize(stderr || psStderr)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function writeConfig(root) {
  const config = {
    models: {
      providers: [{
        name: providerName,
        base_url: baseUrl,
        api_key: apiKey,
        protocol: 'openai',
        enabled: true,
        models: [
          {
            name: unavailableModel,
            display: unavailableModel,
            description: 'Intentionally unavailable model for real fallback validation',
            speed_rating: 'unknown',
            capability_rating: 'unknown',
            evaluation: { status: 'unavailable', notes: 'release smoke pre-marked unavailable' },
          },
          {
            name: modelName,
            display: modelName,
            description: 'Real APInebula release validation model',
            speed_rating: 'fast',
            capability_rating: 'medium',
            evaluation: { status: 'available', latency: 0, notes: 'release smoke selected model' },
          },
        ],
      }],
      default_model: unavailableModel,
      default_intelligence: 'low',
      agent_engine: 'builtin',
      auto_switch: false,
      auto_switch_preference: 'speed',
      fallback_on_unavailable: true,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    general: { language: 'en' },
    workspace: {
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    fail(`${label} did not return JSON: ${sanitize(output).slice(0, 1000)}`);
  }
}

function findConversationAssistantModel(root, conversationId, marker) {
  const stack = [path.join(root, 'Work')];
  while (stack.length) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name !== 'state.json' || !full.includes(`${path.sep}conversations${path.sep}`)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        const rawConversations = parsed.conversations || {};
        const conversations = Array.isArray(rawConversations)
          ? rawConversations
          : Object.entries(rawConversations).map(([key, value]) => ({ key, ...(value || {}) }));
        const conversation = conversations.find(item => item && (item.id === conversationId || item.key === conversationId || String(item.key || '').endsWith(`-${conversationId}`)));
        const assistant = conversation?.messages?.find(msg => msg?.role === 'assistant' && String(msg.content || '').includes(marker));
        const chatAssistant = conversation?.chatMessages?.find(msg => msg?.role === 'assistant' && String(msg.content || '').includes(marker));
        if (assistant?.model) return String(assistant.model);
        if (chatAssistant?.model) return String(chatAssistant.model);
      } catch {}
    }
  }
  return '';
}

async function verifyRealModel(root) {
  const validation = await runPowerShellCli(['validate-models', '--selected', `${providerName}/${modelName}`, '--root', root], root, 240000);
  if (validation.stdout.includes(apiKey)) fail('validate-models leaked API key');
  const parsed = parseJsonOutput(validation.stdout, 'validate-models');
  const row = Array.isArray(parsed) ? parsed.find(item => item.name === `${providerName}/${modelName}`) : null;
  if (!row || row.status !== 'available') {
    fail(`real APInebula selected model did not validate available: ${sanitize(validation.stdout)}`);
  }
  log('real APInebula model validation ok');
}

async function verifyMemoryReadAndCreate(root) {
  const promptPath = path.join(root, 'memory-agent-prompt.txt');
  fs.writeFileSync(promptPath, [
    'You must use Memory Lab tools, not plain prose, for this task.',
    'First call memory_lab_read to inspect the Memory Lab index and instructions.',
    'Then call memory_lab_update to create a durable memory component with:',
    `name: ${memoryComponentName}`,
    'description: Real APInebula model-created Memory Lab release smoke component',
    'tags: #Release-APInebula,#Agent-MemoryLab,#Agent-ModelSwitch',
    'content markdown containing the exact marker REAL_APINEBULA_MEMORY_CREATE_OK_20260701.',
    'After the update, call memory_lab_read for the created component.',
    'Finally reply with exactly REAL_APINEBULA_MEMORY_AGENT_DONE_20260701.',
  ].join('\n'), 'utf8');

  const send = await runPowerShellCli([
    'send',
    '--input-file', promptPath,
    '--mode', 'build',
    '--conversation', 'real-apinebula-memory-agent',
    '--root', root,
  ], root, 300000);
  const output = send.stdout;
  if (output.includes(apiKey)) fail('memory agent send leaked API key');
  if (!output.includes('[memory_lab_read]')) fail(`real model did not call memory_lab_read: ${sanitize(output).slice(0, 2000)}`);
  if (!output.includes('[memory_lab_update]')) fail(`real model did not call memory_lab_update: ${sanitize(output).slice(0, 2000)}`);
  if (!output.includes('REAL_APINEBULA_MEMORY_CREATE_OK_20260701')) fail(`memory component marker missing from tool output: ${sanitize(output).slice(0, 2000)}`);

  const read = await runPowerShellCli(['memory-lab', '--component', memoryComponentSlug, '--root', root], root, 120000);
  if (read.stdout.includes(apiKey)) fail('memory-lab read leaked API key');
  const parsedRead = parseJsonOutput(read.stdout, 'memory-lab read');
  if (parsedRead.ok !== true) fail(`memory-lab read failed after real agent update: ${sanitize(read.stdout)}`);
  if (!parsedRead.component?.content?.includes('REAL_APINEBULA_MEMORY_CREATE_OK_20260701')) {
    fail(`memory-lab read did not return created component content: ${sanitize(read.stdout)}`);
  }
  const tags = parsedRead.index?.tags || {};
  if (!tags['#Release']?.children?.includes('#Release-APInebula')) fail('Memory Lab tag graph missing #Release -> #Release-APInebula');
  if (!tags['#Agent']?.children?.includes('#Agent-MemoryLab')) fail('Memory Lab tag graph missing #Agent -> #Agent-MemoryLab');
  if (!tags['#Agent']?.children?.includes('#Agent-ModelSwitch')) fail('Memory Lab tag graph missing #Agent -> #Agent-ModelSwitch');
  log('real model Memory Lab read/create ok');
}

async function verifyFallbackSwitch(root) {
  const conversationId = 'real-apinebula-model-switch';
  const marker = 'REAL_APINEBULA_MODEL_SWITCH_OK_20260701';
  const promptPath = path.join(root, 'fallback-prompt.txt');
  fs.writeFileSync(promptPath, `Reply exactly ${marker}. Do not use tools.`, 'utf8');
  const send = await runPowerShellCli([
    'send',
    '--input-file', promptPath,
    '--mode', 'build',
    '--conversation', conversationId,
    '--root', root,
  ], root, 240000);
  if (send.stdout.includes(apiKey)) fail('fallback send leaked API key');
  if (!send.stdout.includes(marker)) fail(`fallback response missing marker: ${sanitize(send.stdout).slice(0, 2000)}`);
  const savedModel = findConversationAssistantModel(root, conversationId, marker);
  if (savedModel !== modelName) {
    fail(`fallback did not persist assistant response under expected APInebula model. expected=${modelName} actual=${savedModel || '(missing)'}`);
  }
  log('real APInebula unavailable-model fallback ok');
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
      "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; 'stopped release processes'",
    ], { windowsHide: true });
    fail('real APInebula memory/switch smoke left a packaged Newmark process running');
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows real APInebula smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  if (!apiKey) {
    log('skipped: set NEWMARK_APINEBULA_KEY or NEWMARK_REAL_API_KEY to run real APInebula Memory Lab/model-switch smoke');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRealApiNebulaMemorySwitch-'));
  try {
    writeConfig(root);
    await verifyRealModel(root);
    await verifyMemoryReadAndCreate(root);
    await verifyFallbackSwitch(root);
    ensureNoReleaseProcess();
    log('all real APInebula Memory Lab/model-switch checks passed');
  } finally {
    if (keepRoot) {
      log(`kept root: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
})().catch(error => {
  console.error(`[release-real-apinebula-memory-switch-smoke] ${sanitize(error.message)}`);
  process.exit(1);
});
