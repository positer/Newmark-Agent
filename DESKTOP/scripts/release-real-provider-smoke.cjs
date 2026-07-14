const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const screenshotPath = path.join(repoRoot, 'archive', '2026-06-27-release-ui-real-provider-smoke.png');
const keepRoot = process.env.NEWMARK_KEEP_REAL_PROVIDER_SMOKE === '1';

const providerName = process.env.NEWMARK_APINEBULA_PROVIDER || 'APInebulaRealRepeatable';
const baseUrl = process.env.NEWMARK_APINEBULA_BASE_URL || 'https://apinebula.com/v1';
const modelName = process.env.NEWMARK_APINEBULA_MODEL || 'gpt-5.4-mini';
const apiKey = process.env.NEWMARK_APINEBULA_KEY || process.env.NEWMARK_REAL_API_KEY || '';
const runValidation = process.env.NEWMARK_REAL_VALIDATE_MODELS === '1';
const runUtf8 = process.env.NEWMARK_REAL_UTF8 === '1';
const includeClaudeEnv = process.env.NEWMARK_REAL_INCLUDE_CLAUDE_ENV === '1';
const claudeEnvFile = process.env.NEWMARK_REAL_CLAUDE_ENV_FILE || '';

function log(message) {
  console.log(`[release-real-provider-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sanitize(text) {
  let out = String(text || '');
  for (const secret of [apiKey, process.env.NEWMARK_REAL_API_KEY]) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out;
}

function countOccurrences(text, marker) {
  return String(text || '').split(marker).length - 1;
}

function runPowerShellCli(args, root, extraEnv = {}, timeoutMs = 120000) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-real-cli-run-'));
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
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (error) {
        log(`warning: could not remove temp CLI run dir ${workDir}: ${error.message}`);
      }
      if (code !== 0) {
        reject(new Error(`CLI ${args[0]} exited ${code}. stdout=${sanitize(stdout || psStdout)} stderr=${sanitize(stderr || psStderr)}`));
        return;
      }
      resolve({ stdout, stderr, root });
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  fail('Timed out waiting for Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  function call(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }

  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });

  return { ws, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description || details.text || JSON.stringify(details);
    throw new Error(`Runtime.evaluate exception: ${message}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression, 10000);
    lastValue = value;
    if (value) return value;
    await sleep(750);
  }
  fail(`Timed out waiting for ${label}; last value: ${sanitize(String(lastValue || '').slice(0, 500))}`);
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function assistantMarkerStatsExpression(marker) {
  return `window.api.getState().then(state => {
    const marker = ${jsString(marker)};
    const assistantEls = Array.from(document.querySelectorAll('.chat-msg.assistant .msg-body'));
    const matchingEls = assistantEls.filter(el => (el.innerText || '').includes(marker));
    const messages = (state && Array.isArray(state.chatMessages)) ? state.chatMessages : [];
    const assistantMessages = messages.filter(m => m && m.role === 'assistant');
    const matchingMessages = assistantMessages.filter(m => String(m.content || '').includes(marker));
    return {
      count: matchingEls.length,
      backendCount: matchingMessages.length,
      status: state && state.status,
      conversationId: state && state.conversationId,
      activeText: (window.state && window.state._activeWorkflowText) || '',
      lastCompletedText: (window.state && window.state._lastCompletedWorkflow && window.state._lastCompletedWorkflow.text) || '',
      assistantTexts: assistantEls.map(el => (el.innerText || '').slice(0, 260)).slice(-4),
      backendAssistantTexts: assistantMessages.map(m => String(m.content || '').slice(0, 260)).slice(-4),
      bodyTail: (document.querySelector('#chat-area')?.innerText || document.body.innerText || '').slice(-1200)
    };
  })`;
}

async function waitForAssistantMarker(cdp, marker, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastStats;
  while (Date.now() < deadline) {
    const stats = await evaluate(cdp, assistantMarkerStatsExpression(marker), 10000);
    lastStats = stats;
    if (stats && stats.count > 0) return stats;
    await sleep(750);
  }
  fail(`Timed out waiting for ${label}; last stats: ${sanitize(JSON.stringify(lastStats || {}).slice(0, 1800))}`);
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
    fail('real provider smoke left a packaged Newmark process running');
  }
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
        models: [{
          name: modelName,
          display: modelName,
          description: 'Low-cost repeatable real-provider release smoke model',
          evaluation: { status: 'available', latency: 0 },
        }],
      }],
      default_model: modelName,
      default_intelligence: 'low',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
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

async function runCliChecks(root) {
  const state = await runPowerShellCli(['state', '--root', root], root);
  if (state.stdout.includes(apiKey)) fail('state leaked API key');
  const parsedState = JSON.parse(state.stdout);
  if (parsedState.model !== modelName) fail(`state did not load model ${modelName}`);
  if (!String(parsedState.modelLabel || '').includes(modelName)) fail(`state did not expose model label: ${parsedState.modelLabel}`);
  log('state redaction ok');

  const promptFile = path.join(root, 'real-cli-prompt.txt');
  fs.writeFileSync(promptFile, 'Reply exactly REAL_PROVIDER_CLI_OK_20260627. No tools.', 'utf8');
  const send = await runPowerShellCli(['send', '--input-file', promptFile, '--mode', 'build', '--model', modelName, '--conversation', 'real-provider-cli', '--root', root], root, {}, 180000);
  if (send.stdout.includes(apiKey)) fail('send leaked API key');
  if (!send.stdout.includes('REAL_PROVIDER_CLI_OK_20260627')) fail(`CLI real provider response missing marker: ${sanitize(send.stdout)}`);
  if (countOccurrences(send.stdout, 'REAL_PROVIDER_CLI_OK_20260627') !== 1) fail(`CLI real provider response duplicated marker: ${sanitize(send.stdout)}`);
  log('real CLI send ok');

  if (runUtf8) {
    const utf8PromptFile = path.join(root, 'real-cli-utf8-prompt.txt');
    fs.writeFileSync(utf8PromptFile, '请只回复：真实UTF8_CLI_通过。不要使用工具。', 'utf8');
    const utf8Send = await runPowerShellCli(['send', '--input-file', utf8PromptFile, '--mode', 'build', '--model', modelName, '--language', 'zh', '--conversation', 'real-provider-cli-utf8', '--root', root], root, {}, 180000);
    if (utf8Send.stdout.includes(apiKey)) fail('UTF-8 send leaked API key');
    if (!utf8Send.stdout.includes('真实UTF8_CLI_通过')) fail(`CLI UTF-8 real provider response missing marker: ${sanitize(utf8Send.stdout)}`);
    if (countOccurrences(utf8Send.stdout, '真实UTF8_CLI_通过') !== 1) fail(`CLI UTF-8 real provider response duplicated marker: ${sanitize(utf8Send.stdout)}`);
    log('real CLI UTF-8 send ok');
  } else {
    log('real UTF-8 CLI/UI checks skipped; set NEWMARK_REAL_UTF8=1 to enable');
  }

  if (runValidation) {
    const validation = await runPowerShellCli(['validate-models', '--selected', `${providerName}/${modelName}`, '--root', root], root, {}, 180000);
    if (validation.stdout.includes(apiKey)) fail('validate-models leaked API key');
    const parsedValidation = JSON.parse(validation.stdout);
    const row = Array.isArray(parsedValidation) ? parsedValidation.find(r => r.name === `${providerName}/${modelName}`) : null;
    if (!row || row.status !== 'available') fail(`real validate-models did not mark model available: ${sanitize(validation.stdout)}`);
    log('real validate-models ok');
  } else {
    log('real validate-models skipped; set NEWMARK_REAL_VALIDATE_MODELS=1 to enable');
  }

  if (includeClaudeEnv) {
    if (!fs.existsSync(claudeEnvFile)) fail(`Claude env file not found: ${claudeEnvFile}`);
    const fuzzy = await runPowerShellCli(['fuzzy-inject', '--env-file-env', 'NEWMARK_REAL_CLAUDE_ENV_FILE', '--root', root], root, {
      NEWMARK_REAL_CLAUDE_ENV_FILE: claudeEnvFile,
    }, 240000);
    if (fuzzy.stdout.includes(apiKey)) fail('Claude env fuzzy output leaked baseline key');
    JSON.parse(fuzzy.stdout);
    log('real Claude env fuzzy-inject completed');
  } else {
    log('Claude env fuzzy-inject skipped; set NEWMARK_REAL_INCLUDE_CLAUDE_ENV=1 to enable');
  }
}

async function runUiCheck(root) {
  const port = Number(process.env.NEWMARK_REAL_UI_SMOKE_PORT || '49339');
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForTarget(port);
    log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');

    const initial = await waitFor(cdp, `window.api.getState().then(state => {
      const workspace = state.workspaces && state.workspaces.current ? state.workspaces.current.path : '';
      if (!state.model || !state.mode || !workspace) return null;
      return { model: state.model, mode: state.mode, label: state.modelLabel || '', workspace };
    })`, 30000, 'initial real-provider backend state');
    if (initial.model !== modelName) fail(`unexpected UI model: ${initial.model}`);
    if (!String(initial.label || '').includes(modelName)) fail(`unexpected UI model label: ${initial.label}`);

    await waitFor(cdp, `(() => document.readyState === 'complete' && !!document.querySelector('#prompt'))()`, 30000, 'prompt input');
    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('missing #prompt');
      if (typeof window.sendMessage !== 'function') throw new Error('missing window.sendMessage');
      prompt.focus();
      prompt.value = 'Reply exactly REAL_PROVIDER_UI_OK_20260627. No tools.';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.sendMessage();
      return true;
    })()`);

    const uiMarkerStats = await waitForAssistantMarker(cdp, 'REAL_PROVIDER_UI_OK_20260627', 180000, 'visible real-provider UI assistant marker');
    if (uiMarkerStats.count !== 1) fail(`real-provider UI duplicated assistant marker count=${uiMarkerStats.count}; stats=${sanitize(JSON.stringify(uiMarkerStats).slice(0, 1800))}`);
    const state = await waitFor(cdp, `window.api.getState().then(state => {
      if (!state || state.status !== 'idle') return null;
      return state;
    })`, 60000, 'real-provider UI idle after marker');
    if (!state || state.status !== 'idle') fail(`agent did not return to idle: ${state && state.status}`);
    if (JSON.stringify(state).includes(apiKey)) fail('renderer state leaked API key');

    if (runUtf8) {
      await evaluate(cdp, `(() => {
        const prompt = document.querySelector('#prompt');
        if (!prompt) throw new Error('missing #prompt for UTF-8 send');
        prompt.focus();
        prompt.value = '请只回复：真实UTF8_UI_通过。不要使用工具。';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        window.sendMessage();
        return true;
      })()`);
      const uiUtf8MarkerStats = await waitForAssistantMarker(cdp, '真实UTF8_UI_通过', 180000, 'visible real-provider UTF-8 UI assistant marker');
      if (uiUtf8MarkerStats.count !== 1) fail(`real-provider UTF-8 UI duplicated assistant marker count=${uiUtf8MarkerStats.count}; stats=${sanitize(JSON.stringify(uiUtf8MarkerStats).slice(0, 1800))}`);
      const utf8State = await waitFor(cdp, `window.api.getState().then(state => state && state.status === 'idle' ? state : null)`, 60000, 'real-provider UTF-8 UI idle after marker');
      if (JSON.stringify(utf8State).includes(apiKey)) fail('UTF-8 renderer state leaked API key');
      log('real UI UTF-8 send ok');
    }

    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    log(`screenshot ${screenshotPath}`);
    log('real UI send ok');
  } finally {
    try {
      if (cdp?.ws) cdp.ws.close();
    } catch {}
    try {
      if (child && !child.killed) child.kill();
    } catch {}
    await sleep(1000);
    ensureNoReleaseProcess();
  }
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows real provider smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing release exe: ${exePath}`);
  if (!apiKey) {
    log('skipped: set NEWMARK_APINEBULA_KEY or NEWMARK_REAL_API_KEY to run real provider smoke');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRealProviderSmoke-'));
  try {
    writeConfig(root);
    await runCliChecks(root);
    await runUiCheck(root);
    log('all real provider smoke checks passed');
  } finally {
    if (keepRoot) {
      log(`kept root: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
})().catch(error => {
  console.error(`[release-real-provider-smoke] ${sanitize(error.message)}`);
  process.exit(1);
});
