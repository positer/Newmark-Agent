const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const exePath = path.resolve(process.env.NEWMARK_TEST_EXE || 'C:\\Program Files\\Newmark Agent\\Newmark.exe');
const providerConfigPath = String(process.env.NEWMARK_REAL_STRESS_SOURCE_CONFIG || '').trim();
const keepRoot = process.env.NEWMARK_KEEP_INSTALLED_TUI_STRESS === '1';
const timeoutMs = Math.max(30_000, Number(process.env.NEWMARK_INSTALLED_TUI_TIMEOUT_MS) || 180_000);

function assert(condition, message) {
  if (!condition) throw new Error(`installed real-model TUI/CLI stress failed: ${message}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => process.stdout.write(`[installed-real-tui-cli-stress] ${message}\n`);
const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;

function stopExactInstalledProcesses() {
  if (process.platform !== 'win32') return;
  const targets = [exePath, path.join(path.dirname(exePath), 'Newmark Agent.exe')];
  const targetList = targets.map(psQuote).join(', ');
  const command = `$targets=@(${targetList}); @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -in $targets }) | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Output 'INSTALLED_TUI_CHILD_CLEANUP_OK'`;
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    windowsHide: true,
    encoding: 'utf8',
  });
}

function redact(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('<redacted>');
  }
  return text
    .replace(/sk-[A-Za-z0-9_.-]{8,}/g, 'sk-***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9_.=:/+_-]{8,}/gi, 'Bearer <redacted>');
}

function unwrap(value) {
  return value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')
    ? value.value
    : value;
}

function providerFromSourceConfig() {
  if (!providerConfigPath || !fs.existsSync(providerConfigPath)) return null;
  const raw = JSON.parse(fs.readFileSync(providerConfigPath, 'utf8'));
  const providers = unwrap(raw?.models?.providers);
  if (!Array.isArray(providers)) return null;
  for (const candidate of providers) {
    const provider = unwrap(candidate);
    const apiKey = String(provider?.api_key || provider?.apiKey || '').trim();
    const models = unwrap(provider?.models);
    const modelList = Array.isArray(models) ? models : [];
    const selected = modelList.find(item => String(unwrap(item)?.name || '').trim());
    const model = String(
      process.env.NEWMARK_REAL_STRESS_MODEL
        || unwrap(selected)?.name
        || '',
    ).trim();
    const baseUrl = String(provider?.base_url || provider?.baseUrl || '').trim();
    if (!apiKey || !baseUrl || !model) continue;
    const protocol = String(provider?.protocol || '').toLowerCase().includes('anthropic')
      ? 'anthropic'
      : 'openai';
    return {
      name: String(provider?.name || 'InstalledRealStressProvider'),
      apiKey,
      baseUrl,
      model,
      protocol,
      source: providerConfigPath,
    };
  }
  return null;
}

function providerFromEnv() {
  const apiKey = String(
    process.env.NEWMARK_REAL_STRESS_KEY
      || process.env.NEWMARK_APINEBULA_KEY
      || process.env.NEWMARK_REAL_API_KEY
      || '',
  ).trim();
  const baseUrl = String(
    process.env.NEWMARK_REAL_STRESS_BASE_URL
      || process.env.NEWMARK_APINEBULA_BASE_URL
      || 'https://apinebula.com/v1',
  ).trim();
  const model = String(
    process.env.NEWMARK_REAL_STRESS_MODEL
      || process.env.NEWMARK_APINEBULA_MODEL
      || '',
  ).trim();
  if (!apiKey || !model) return providerFromSourceConfig();
  const protocol = String(process.env.NEWMARK_REAL_STRESS_PROTOCOL || 'openai').toLowerCase().includes('anthropic')
    ? 'anthropic'
    : 'openai';
  return {
    name: String(process.env.NEWMARK_REAL_STRESS_PROVIDER || 'InstalledRealStressProvider'),
    apiKey,
    baseUrl,
    model,
    protocol,
    source: 'environment',
  };
}

function writeConfig(root, provider) {
  // Pre-create every mutable root directory so the installed launcher cannot
  // migrate unrelated legacy data into this isolated stress root.
  for (const directory of ['Work', 'Flow', 'skills', 'archive', 'Memory Lab', 'Roots']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of ['Local.json', 'External.json']) {
    fs.writeFileSync(path.join(root, 'Work', file), '[]', 'utf8');
  }
  const config = {
    models: {
      providers: [{
        name: provider.name,
        base_url: provider.baseUrl,
        api_key: provider.apiKey,
        protocol: provider.protocol,
        enabled: true,
        models: [{
          name: provider.model,
          display: provider.model,
          description: 'Opt-in installed real-model stress model',
          max_tokens: 128000,
          evaluation: { status: 'available', latency: 0 },
        }],
      }],
      default_model: provider.model,
      default_intelligence: 'low',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
      openai_api_mode: 'chat_stream',
    },
    agent: {
      default_mode: 'build',
      option_feedback: 'fully_autonomous',
      goal_max_continuations: 4,
    },
    terminal: { interrupt_timeout_ms: 0 },
    context: { auto_compress: true, compress_threshold_tokens: 8000 },
    general: { language: 'en' },
    workspace: {
      // TUI is launched against an explicit external workspace. Avoid an
      // implicit internal workspace so the restart check exercises that same
      // external workspace's persisted conversation store.
      auto_create_timestamp_workspace: false,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function runProcess(args, root, secrets) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`CLI timed out: ${args[0]}; stdout=${redact(stdout, secrets).slice(-1200)} stderr=${redact(stderr, secrets).slice(-1200)}`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runDirectCli(root, workspace, provider, secrets) {
  const promptPath = path.join(root, 'installed-cli-prompt.txt');
  const marker = 'INSTALLED_0312_CLI_OK';
  fs.writeFileSync(promptPath, `Reply with this exact marker as the first line: ${marker}\nNo tools.`, 'utf8');
  const result = await runProcess([
    'send',
    '--input-file', promptPath,
    '--mode', 'build',
    '--model', provider.model,
    '--language', 'en',
    '--conversation', 'installed-0312-cli',
    '--root', root,
  ], workspace, secrets);
  const output = `${result.stdout}\n${result.stderr}`;
  assert(result.code === 0, `Newmark.exe send exited ${result.code}: ${redact(output, secrets).slice(-1800)}`);
  assert(output.includes(marker), `direct console CLI response missed ${marker}: ${redact(output, secrets).slice(-1800)}`);
  assert(!secrets.some(secret => secret && output.includes(secret)), 'direct console CLI output leaked provider credentials');
  log('direct installed Newmark.exe CLI real-model roundtrip');
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function runTui(root, workspace) {
  const terminal = pty.spawn(exePath, [
    '--TUI',
    '--root', root,
    '--workspace', workspace,
  ], {
    name: 'xterm-256color',
    cols: 120,
    rows: 38,
    cwd: workspace,
    env: { ...process.env, TERM: 'xterm-256color' },
    useConpty: true,
    useConptyDll: true,
  });
  let output = '';
  let exited = false;
  let exitEvent = null;
  terminal.onData(chunk => { output += chunk; });
  const exit = new Promise(resolve => terminal.onExit(event => {
    exited = true;
    exitEvent = event;
    resolve(event);
  }));
  const waitFor = async (pattern, label, waitMs = 30_000, startAt = 0) => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const plain = stripAnsi(output.slice(startAt));
      if (pattern.test(plain)) return plain;
      if (exited) throw new Error(`${label}: TUI exited ${exitEvent?.exitCode}; output=${stripAnsi(output).slice(-2600)}`);
      await sleep(80);
    }
    throw new Error(`${label}: timed out; output=${stripAnsi(output).slice(-2600)}`);
  };
  return {
    terminal,
    exit,
    waitFor,
    mark: () => output.length,
    text: () => stripAnsi(output),
    textFrom: startAt => stripAnsi(output.slice(startAt)),
    isExited: () => exited,
  };
}

async function openConversation(session) {
  await session.waitFor(/NEWMARK[\s\S]*WORKSPACES/, 'TUI startup');
  const editorStart = session.mark();
  // A zero-state external workspace has no conversation row to navigate to;
  // README documents N as the supported new-conversation entry in that case.
  session.terminal.write('n');
  await session.waitFor(/Type a message/, 'TUI editor', 30_000, editorStart);
}

async function reopenEditor(session, label) {
  const editorStart = session.mark();
  // README documents N as the stable entry to a fresh conversation from any
  // non-overlay TUI view; it avoids relying on a stale menu selection after a
  // run has completed or been interrupted.
  session.terminal.write('n');
  await session.waitFor(/Type a message/, label, 15_000, editorStart);
}

async function sendTuiPrompt(session, prompt, marker, label, waitMs = timeoutMs, reopen = true) {
  const requestStart = session.mark();
  session.terminal.write(prompt);
  session.terminal.write('\r');
  const markerPattern = new RegExp(`NEWMARK[\\s\\S]{0,240}${marker}`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const response = session.textFrom(requestStart);
    if (markerPattern.test(response)) break;
    if (/Agent error|LLM Error/i.test(response)) {
      throw new Error(`${label}: TUI agent error: ${response.slice(-1800)}`);
    }
    if (session.isExited()) {
      throw new Error(`${label}: TUI exited before marker`);
    }
    await sleep(80);
  }
  if (!markerPattern.test(session.textFrom(requestStart))) {
    throw new Error(`${label}: marker timed out; output=${session.textFrom(requestStart).slice(-1800)}`);
  }
  await session.waitFor(/Build Block[\s\S]*completed|response complete|state persisted|Agent error/i, `${label} completion`, waitMs, requestStart);
  if (reopen) await reopenEditor(session, `${label} editor recovery`);
}

async function exerciseTui(root, workspace) {
  const session = runTui(root, workspace);
  try {
    await openConversation(session);
    await sendTuiPrompt(session, 'Reply with this exact marker as the first line: INSTALLED_0312_TUI_OK\nNo tools.', 'INSTALLED_0312_TUI_OK', 'first TUI request');
    log('direct installed Newmark.exe TUI real-model roundtrip');

    const longPrompt = [
      'Write a very long answer with 1200 numbered lines.',
      'Each line should contain a short sentence and a number.',
      'Do not use tools. Begin with INSTALLED_0312_LONG_START.',
    ].join('\n');
    const longRequestStart = session.mark();
    session.terminal.write(longPrompt);
    session.terminal.write('\r');
    await session.waitFor(/Newmark is working|Running Newmark Agent/i, 'long TUI request started', 10_000, longRequestStart);
    await sleep(700);
    const stopStart = session.mark();
    session.terminal.write('\u001b');
    await sleep(100);
    session.terminal.write('\u001b');
    await session.waitFor(/Stop requested|Force-stop requested|operation was aborted|Agent error:.*abort|stopping|stopped|interrupted/i, 'TUI Esc stop and recovery', 15_000, stopStart);
    log('TUI Esc produced a visible stop/abort state and returned control');
    await reopenEditor(session, 'post-stop editor recovery');
    await sendTuiPrompt(session, 'Reply with this exact marker as the first line: INSTALLED_0312_RECOVERY_OK\nNo tools.', 'INSTALLED_0312_RECOVERY_OK', 'post-stop recovery', timeoutMs, false);
    log('TUI post-stop recovery request');

    session.terminal.write('\u0003');
    const exit = await Promise.race([session.exit, sleep(10_000).then(() => ({ exitCode: -999 }))]);
    assert(exit.exitCode === 0, `TUI clean exit returned ${exit.exitCode}`);
  } finally {
    if (!session.isExited()) {
      try { session.terminal.write('\u0003'); } catch {}
      await Promise.race([session.exit, sleep(1500)]);
    }
    if (!session.isExited()) {
      try { session.terminal.kill(); } catch {}
    }
  }
}

async function exerciseRestart(root, workspace) {
  const session = runTui(root, workspace);
  try {
    await session.waitFor(/NEWMARK[\s\S]*WORKSPACES/, 'TUI restart startup');
    await reopenEditor(session, 'TUI restart editor');
    await sendTuiPrompt(session, 'Reply with this exact marker as the first line: INSTALLED_0312_RESTART_OK\nNo tools.', 'INSTALLED_0312_RESTART_OK', 'TUI restart persistence', timeoutMs, false);
    log('TUI restart startup and real-model request');
    session.terminal.write('\u0003');
    const exit = await Promise.race([session.exit, sleep(10_000).then(() => ({ exitCode: -999 }))]);
    assert(exit.exitCode === 0, `TUI restart clean exit returned ${exit.exitCode}`);
  } finally {
    if (!session.isExited()) {
      try { session.terminal.write('\u0003'); } catch {}
      await Promise.race([session.exit, sleep(1500)]);
    }
    if (!session.isExited()) {
      try { session.terminal.kill(); } catch {}
    }
  }
}

async function main() {
  assert(process.platform === 'win32', 'installed Windows executable test requires Windows');
  assert(fs.existsSync(exePath), `installed console executable is missing: ${exePath}`);
  const provider = providerFromEnv();
  assert(provider, 'real provider credentials/model were not supplied');
  const secrets = [provider.apiKey].filter(Boolean);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-installed-real-tui-root-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-installed-real-tui-workspace-'));
  try {
    writeConfig(root, provider);
    await exerciseTui(root, workspace);
    await exerciseRestart(root, workspace);
    // The real TUI registers the explicit external workspace first. The
    // installed console launcher then exercises the same registered workspace.
    await runDirectCli(root, workspace, provider, secrets);
    log('PASS direct installed CLI + real-model TUI + Esc stop/recovery + restart startup/request');
    if (keepRoot) log(`kept roots: runtime=${root}; workspace=${workspace}`);
  } finally {
    stopExactInstalledProcesses();
    if (!keepRoot) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    } else {
      log(`kept roots after stress: runtime=${root}; workspace=${workspace}`);
    }
  }
}

void main().then(
  () => process.exit(0),
  error => {
    process.stderr.write(`${redact(error?.stack || error?.message || error)}\n`);
    process.exit(1);
  },
);
