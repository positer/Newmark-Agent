const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const appRoot = path.resolve(__dirname, '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');
const keepRoot = process.env.NEWMARK_KEEP_REAL_PROVIDER_STRESS === '1';

const cliRounds = numberEnv('NEWMARK_REAL_STRESS_CLI_ROUNDS', 8);
const uiRounds = numberEnv('NEWMARK_REAL_STRESS_UI_ROUNDS', 6);
const goalRounds = numberEnv('NEWMARK_REAL_STRESS_GOAL_ROUNDS', 3);
const timeoutMs = numberEnv('NEWMARK_REAL_STRESS_TIMEOUT_MS', 180000);
const port = numberEnv('NEWMARK_REAL_STRESS_PORT', 49373);

const results = [];
let activeSecretValues = [];

function numberEnv(name, fallback) {
  const raw = Number(process.env[name] || '');
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function log(message) {
  console.log(`[release-real-provider-stress] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function redact(text) {
  let out = String(text || '');
  for (const secret of activeSecretValues) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  out = out.replace(/sk-[A-Za-z0-9_\-.]{8,}/g, 'sk-***REDACTED***');
  out = out.replace(/Bearer\s+[A-Za-z0-9_\-.=:/+]{8,}/gi, 'Bearer <redacted>');
  return out;
}

function providerFromEnv() {
  const stressKey = process.env.NEWMARK_REAL_STRESS_KEY || '';
  const stressBaseUrl = process.env.NEWMARK_REAL_STRESS_BASE_URL || '';
  const stressModel = process.env.NEWMARK_REAL_STRESS_MODEL || '';
  const stressProtocol = normalizeProtocol(process.env.NEWMARK_REAL_STRESS_PROTOCOL || '');
  if (stressKey && stressBaseUrl && stressModel) {
    return {
      source: 'NEWMARK_REAL_STRESS_*',
      name: process.env.NEWMARK_REAL_STRESS_PROVIDER || 'RealStressProvider',
      baseUrl: stressBaseUrl,
      apiKey: stressKey,
      model: stressModel,
      protocol: stressProtocol || inferProtocol(stressBaseUrl, 'RealStressProvider'),
    };
  }

  const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || '';
  const anthropicModel = process.env.ANTHROPIC_MODEL
    || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    || '';
  if (anthropicKey && anthropicBaseUrl && anthropicModel) {
    return {
      source: 'ANTHROPIC_*',
      name: 'AnthropicRealStress',
      baseUrl: anthropicBaseUrl,
      apiKey: anthropicKey,
      model: anthropicModel,
      protocol: 'anthropic',
    };
  }

  const apiNebulaKey = process.env.NEWMARK_APINEBULA_KEY || process.env.NEWMARK_REAL_API_KEY || '';
  const apiNebulaBaseUrl = process.env.NEWMARK_APINEBULA_BASE_URL || 'https://apinebula.com/v1';
  const apiNebulaModel = process.env.NEWMARK_APINEBULA_MODEL || '';
  if (apiNebulaKey && apiNebulaModel) {
    return {
      source: 'NEWMARK_APINEBULA_*',
      name: process.env.NEWMARK_APINEBULA_PROVIDER || 'APInebulaRealStress',
      baseUrl: apiNebulaBaseUrl,
      apiKey: apiNebulaKey,
      model: apiNebulaModel,
      protocol: 'openai',
    };
  }

  return null;
}

function normalizeProtocol(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (raw === 'openai' || raw === 'openai-compatible') return 'openai';
  if (raw === 'anthropic' || raw === 'claude') return 'anthropic';
  return '';
}

function inferProtocol(baseUrl, name) {
  const marker = `${baseUrl} ${name}`.toLowerCase();
  return marker.includes('anthropic') || marker.includes('claude') ? 'anthropic' : 'openai';
}

function classifyFailure(error) {
  const text = String(error && (error.stack || error.message || error) || '');
  if (/rate.?limit|quota|balance|insufficient|429|too many requests/i.test(text)) return 'provider-limit';
  if (/timed out|timeout|CDP timeout|waiting for/i.test(text)) return 'app-timeout-or-provider-timeout';
  if (/conversation|leak|串/i.test(text)) return 'conversation-leak';
  if (/UTF-8|UTF8|encoding|中文|真实/i.test(text)) return 'encoding-error';
  if (/process|running|left a packaged/i.test(text)) return 'process-leak';
  if (/api key|secret|token|leaked/i.test(text)) return 'secret-leak';
  return 'app-or-provider-error';
}

async function recordScenario(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const elapsedMs = Date.now() - started;
    results.push({ name, status: 'pass', elapsedMs, detail: redact(detail || '') });
    log(`${name} ok (${elapsedMs} ms)`);
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const rootCause = classifyFailure(error);
    results.push({
      name,
      status: 'fail',
      elapsedMs,
      rootCause,
      detail: redact(error && (error.stack || error.message) || error),
    });
    log(`${name} failed (${rootCause}, ${elapsedMs} ms)`);
  }
}

function writeConfig(root, provider) {
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
          description: 'Opt-in real provider stress model',
          evaluation: { status: 'available', latency: 0 },
        }],
      }],
      default_model: provider.model,
      default_intelligence: 'low',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    context: { auto_compress: true, compress_threshold_tokens: 8000 },
    general: { language: 'en' },
    workspace: {
      auto_create_timestamp_workspace: true,
      prompt_mode: 'both',
      access_permission: 'full_access',
      on_permission_violation: 'deny',
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function runPowerShellCli(args, root, extraEnv = {}, commandTimeoutMs = timeoutMs) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-real-stress-cli-'));
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PowerShell timed out for ${args[0]}. stdout=${redact(psStdout)} stderr=${redact(psStderr)}`));
    }, commandTimeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`PowerShell failed for ${args[0]}: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
      fs.rmSync(workDir, { recursive: true, force: true });
      if (code !== 0) {
        reject(new Error(`CLI ${args[0]} exited ${code}. stdout=${redact(stdout || psStdout)} stderr=${redact(stderr || psStderr)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function markerPrompt(marker, index) {
  if (index % 3 === 1) return `Reply exactly ${marker}. No tools.`;
  if (index % 3 === 2) return `请只回复：${marker}。不要使用工具。`;
  return [
    `Read this long stress prompt and reply exactly ${marker}. No tools.`,
    'Context block:',
    'Newmark release real provider stress '.repeat(350),
  ].join('\n');
}

async function runCliStress(root, provider) {
  const state = await runPowerShellCli(['state', '--root', root], root);
  if (state.stdout.includes(provider.apiKey)) throw new Error('state leaked API key');
  const parsedState = JSON.parse(state.stdout);
  if (parsedState.model !== provider.model) throw new Error(`state loaded ${parsedState.model}, expected ${provider.model}`);

  for (let i = 1; i <= cliRounds; i++) {
    const marker = i % 3 === 2 ? `真实_STRESS_CLI_${i}_OK` : `NM_STRESS_CLI_${i}_OK`;
    const promptFile = path.join(root, `stress-cli-${i}.txt`);
    fs.writeFileSync(promptFile, markerPrompt(marker, i), 'utf8');
    const args = ['send', '--input-file', promptFile, '--mode', 'build', '--model', provider.model, '--conversation', `stress-cli-${i}`, '--root', root];
    if (i % 3 === 2) args.splice(args.length - 2, 0, '--language', 'zh');
    const send = await runPowerShellCli(args, root, {}, timeoutMs);
    if (send.stdout.includes(provider.apiKey)) throw new Error(`CLI round ${i} leaked API key`);
    if (!send.stdout.includes(marker)) throw new Error(`CLI round ${i} missing marker ${marker}: ${redact(send.stdout).slice(0, 1000)}`);
  }
  return `rounds=${cliRounds}`;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'))
        || targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.title || '').includes('Newmark'))
        || targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview'))
        || targets.find(t => t.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await sleep(500);
  }
  throw new Error('Timed out waiting for Electron CDP target');
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  function call(method, params = {}, callTimeoutMs = 15000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, callTimeoutMs);
      pending.set(id, { resolve, reject, timer });
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
      clearTimeout(callbacks.timer);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });
  return { ws, ready, call };
}

async function evaluate(cdp, expression, callTimeoutMs = 15000) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, callTimeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const message = details.exception?.description || details.text || JSON.stringify(details);
    throw new Error(`Runtime.evaluate exception: ${message}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitFor(cdp, expression, waitTimeoutMs, label) {
  const deadline = Date.now() + waitTimeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluate(cdp, expression, 10000);
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error.message;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}; last=${redact(JSON.stringify(lastValue)).slice(0, 1000)}`);
}

function jsString(value) {
  return JSON.stringify(String(value));
}

async function launchUi(root) {
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const target = await waitForTarget();
  log(`connected target: ${target.title || '(untitled)'} ${target.url || ''}`);
  const cdp = connectCdp(target);
  await cdp.ready;
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await cdp.call('Page.bringToFront');
  await waitFor(cdp, `(() => document.readyState === 'complete' && !!window.api && !!window.sendMessage && !!document.querySelector('#prompt'))()`, 30000, 'renderer ready');
  await evaluate(cdp, `window.api.createWorkspace('real-provider-stress-workspace').then(ws => window.api.selectWorkspace(ws.name))`, 30000);
  await waitFor(cdp, `window.api.getState().then(s => s.workspaces && s.workspaces.current && s.workspaces.current.name === 'real-provider-stress-workspace')`, 30000, 'workspace selected');
  return { child, cdp };
}

async function sendUiPrompt(cdp, prompt, marker, waitTimeoutMs = timeoutMs) {
  await evaluate(cdp, `(() => {
    const prompt = document.querySelector('#prompt');
    if (!prompt) throw new Error('missing #prompt');
    prompt.focus();
    prompt.value = ${jsString(prompt)};
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    window.sendMessage();
    return true;
  })()`, 30000);
  await waitFor(cdp, `(document.body.innerText || '').includes(${jsString(marker)})`, waitTimeoutMs, `visible marker ${marker}`);
  const state = await waitFor(cdp, `window.api.getState().then(s => s && s.status === 'idle' ? s : null)`, 60000, `idle after ${marker}`);
  const stateText = JSON.stringify(state || {});
  if (stateText.includes(activeSecretValues[0])) throw new Error('renderer state leaked API key');
  return state;
}

async function runUiStress(cdp) {
  for (let i = 1; i <= uiRounds; i++) {
    const marker = i % 2 === 0 ? `真实_STRESS_UI_${i}_OK` : `NM_STRESS_UI_${i}_OK`;
    await sendUiPrompt(cdp, markerPrompt(marker, i), marker);
  }
  return `rounds=${uiRounds}`;
}

async function runGoalStress(cdp) {
  const marker = 'NM_STRESS_GOAL_COMPLETE_OK';
  const objective = [
    `Real provider Goal stress must continue for ${goalRounds} model calls.`,
    `For all non-final calls, do not include "[Goal Complete]".`,
    `On the final call, include exactly "[Goal Complete] ${marker}".`,
    `Use no tools.`,
  ].join(' ');
  await evaluate(cdp, `window.api.updateGoal(${jsString(objective)})`, 30000);
  await evaluate(cdp, `window.api.setMode ? window.api.setMode('goal') : Promise.resolve()`, 30000);
  const result = await evaluate(cdp, `window.api.sendMessage(${jsString(`Start real Goal stress. Target final marker: ${marker}`)})`, timeoutMs * Math.max(1, goalRounds));
  const resultText = JSON.stringify(result || {});
  if (!resultText.includes(marker)) throw new Error(`Goal stress missing completion marker: ${redact(resultText).slice(0, 1200)}`);
  if (/max[- ]?depth/i.test(resultText)) throw new Error(`Goal stress exposed max-depth warning: ${redact(resultText).slice(0, 1200)}`);
  return `goalRounds=${goalRounds}`;
}

async function runQueueStress(cdp) {
  const firstMarker = 'NM_STRESS_QUEUE_FIRST_OK';
  const secondMarker = 'NM_STRESS_QUEUE_SECOND_OK';
  await evaluate(cdp, `(() => {
    window.setInputMode('guide');
    const prompt = document.querySelector('#prompt');
    prompt.value = 'Write four short numbered lines, then reply exactly ${firstMarker}. No tools.';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    window.sendMessage();
    return true;
  })()`, 30000);
  await evaluate(cdp, `(() => {
    const prompt = document.querySelector('#prompt');
    prompt.value = 'Reply exactly ${secondMarker}. No tools.';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    window.sendMessage();
    return true;
  })()`, 30000);
  await waitFor(cdp, `(document.body.innerText || '').includes(${jsString(firstMarker)})`, timeoutMs, 'first queued marker');
  await waitFor(cdp, `(document.body.innerText || '').includes(${jsString(secondMarker)})`, timeoutMs, 'second queued marker');
  await waitFor(cdp, `window.api.getState().then(s => s && s.status === 'idle' ? true : false)`, 60000, 'queue idle');
  return 'queued prompt drained';
}

async function runConversationIsolationStress(cdp) {
  const convA = 'stress-conversation-a';
  const convB = 'stress-conversation-b';
  const markerA = 'NM_STRESS_CONVERSATION_A_OK';
  const markerB = 'NM_STRESS_CONVERSATION_B_OK';
  const sendA = await evaluate(cdp, `window.api.sendMessage(${jsString(`Reply exactly ${markerA}. No tools.`)}, ${jsString(convA)})`, timeoutMs);
  const textA = JSON.stringify({ tokens: sendA && sendA.tokens, chatMessages: sendA && sendA.chatMessages });
  if (!textA.includes(markerA)) throw new Error(`conversation A missing marker: ${redact(textA).slice(0, 1000)}`);
  if (textA.includes(markerB)) throw new Error(`conversation A response contained B marker: ${redact(textA).slice(0, 1000)}`);
  if ((sendA && sendA.conversationId) !== convA) throw new Error(`conversation A response id mismatch: ${sendA && sendA.conversationId}`);

  const sendB = await evaluate(cdp, `window.api.sendMessage(${jsString(`Reply exactly ${markerB}. No tools.`)}, ${jsString(convB)})`, timeoutMs);
  const textB = JSON.stringify({ tokens: sendB && sendB.tokens, chatMessages: sendB && sendB.chatMessages });
  if (!textB.includes(markerB)) throw new Error(`conversation B missing marker: ${redact(textB).slice(0, 1000)}`);
  if (textB.includes(markerA)) throw new Error(`conversation B response contained A marker: ${redact(textB).slice(0, 1000)}`);
  if ((sendB && sendB.conversationId) !== convB) throw new Error(`conversation B response id mismatch: ${sendB && sendB.conversationId}`);

  await evaluate(cdp, `window.api.setConversation(${jsString(convA)})`, 30000);
  const stateA = await evaluate(cdp, `window.api.getState()`, 30000);
  const stateAText = JSON.stringify((stateA && stateA.chatMessages) || []);
  if (!stateAText.includes(markerA)) throw new Error(`conversation A state missing marker: ${redact(stateAText).slice(0, 1000)}`);
  if (stateAText.includes(markerB)) throw new Error(`conversation A state leaked B marker: ${redact(stateAText).slice(0, 1000)}`);

  await evaluate(cdp, `window.api.setConversation(${jsString(convB)})`, 30000);
  const stateB = await evaluate(cdp, `window.api.getState()`, 30000);
  const stateBText = JSON.stringify((stateB && stateB.chatMessages) || []);
  if (!stateBText.includes(markerB)) throw new Error(`conversation B state missing marker: ${redact(stateBText).slice(0, 1000)}`);
  if (stateBText.includes(markerA)) throw new Error(`conversation B state leaked A marker: ${redact(stateBText).slice(0, 1000)}`);

  return 'conversation histories isolated';
}

async function runLongContextStress(cdp) {
  const marker = 'NM_STRESS_LONG_CONTEXT_OK';
  const payload = 'Long context stress payload. '.repeat(1800);
  await sendUiPrompt(cdp, `Read the following long context and reply exactly ${marker}. No tools.\n\n${payload}`, marker, timeoutMs);
  const compression = await evaluate(cdp, `window.api.getState().then(s => s.contextCompression || s.compression || null)`, 30000).catch(() => null);
  return `longPayloadChars=${payload.length}; compressionState=${redact(JSON.stringify(compression || {})).slice(0, 500)}`;
}

function stopReleaseProcesses() {
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force; Write-Output 'STOP_RELEASE_PROCESSES_OK'",
  ], { windowsHide: true, encoding: 'utf8' });
}

function releaseProcessCount() {
  const running = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "(@(Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' })).Count",
  ], { encoding: 'utf8', windowsHide: true });
  return Number(String(running.stdout || '').trim() || '0');
}

function writeReport(provider, root, skippedReason = '') {
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(repoRoot, 'archive', `${date}-real-provider-stress-debug.md`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const failCount = results.filter(r => r.status === 'fail').length;
  const passCount = results.filter(r => r.status === 'pass').length;
  const skipped = skippedReason ? true : false;
  const verdict = skipped
    ? 'release-usable-with-risks'
    : failCount > 0
      ? 'not-release-ready'
      : 'release-usable';
  const scenarioRows = results.length
    ? results.map(r => `| ${r.name} | ${r.status} | ${r.rootCause || ''} | ${r.elapsedMs} | ${String(r.detail || '').replace(/\r?\n/g, ' ').slice(0, 700)} |`).join('\n')
    : '| real-provider-stress | skip | missing-credentials | 0 | 未执行真实重压：缺少凭据 |';
  const providerLine = provider
    ? `source=${provider.source}; protocol=${provider.protocol}; model=${provider.model}`
    : 'provider=missing';
  const content = `# ${date} Real Provider Stress Debug

## Scope

Implemented and/or ran the opt-in real-provider stress harness for the packaged release build. The harness uses an isolated temporary root, writes a minimal provider config, redacts secrets, and exercises the packaged release executable rather than source-only code.

## Design Release Usability

- Proven: packaged CLI/UI startup, provider config loading, key redaction, normal send path, renderer/preload/Agent routing, and release process cleanup are covered by the current release smoke suite.
- Partially proven: real-provider behavior is probabilistic and provider-dependent; this stress harness records failures without treating provider rate limits or balance issues as app passes.
- Not exhaustively proven: arbitrary third-party provider quality, broad model catalog validation, and unbounded long-context behavior.

## Stress Parameters

- ${providerLine}
- cliRounds=${cliRounds}
- uiRounds=${uiRounds}
- goalRounds=${goalRounds}
- timeoutMs=${timeoutMs}
- skipped=${skipped}
- tempRoot=${keepRoot ? root : '<removed>'}

## Scenario Results

| Scenario | Status | Root cause | Elapsed ms | Detail |
| --- | --- | --- | ---: | --- |
${scenarioRows}

## Failure Classification

Failures are classified as provider-limit, app-timeout-or-provider-timeout, conversation-leak, encoding-error, process-leak, secret-leak, or app-or-provider-error. Error text is redacted before it is written here.

## Final Verdict

\`${verdict}\`

## Remaining Risk

- Real-provider stress spends provider quota when credentials are present.
- Exact-marker prompts can fail because of model noncompliance even when transport is healthy; such failures remain useful stress evidence.
- If this report was skipped, run \`cd DESKTOP && npm.cmd run release:real-provider-stress\` with \`NEWMARK_REAL_STRESS_*\` or \`ANTHROPIC_*\` credentials to collect live evidence.
`;
  fs.writeFileSync(reportPath, content, 'utf8');
  log(`report ${reportPath}`);
  return { reportPath, verdict, failCount, passCount, skipped };
}

(async () => {
  if (process.platform !== 'win32') {
    log('skipped: packaged Windows real provider stress only runs on win32');
    writeReport(null, '', 'non-win32');
    return;
  }
  if (!fs.existsSync(exePath)) throw new Error(`missing release exe: ${exePath}`);

  const provider = providerFromEnv();
  if (!provider) {
    log('未执行真实重压：缺少凭据');
    writeReport(null, '', 'missing-credentials');
    return;
  }
  activeSecretValues = [provider.apiKey, process.env.NEWMARK_REAL_STRESS_KEY, process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.NEWMARK_REAL_API_KEY].filter(Boolean);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkRealProviderStress-'));
  let child;
  let cdp;
  try {
    writeConfig(root, provider);
    await recordScenario('cli-rounds', () => runCliStress(root, provider));

    const launched = await launchUi(root);
    child = launched.child;
    cdp = launched.cdp;
    await recordScenario('ui-rounds', () => runUiStress(cdp));
    await recordScenario('goal-continuation', () => runGoalStress(cdp));
    await recordScenario('queue-drain', () => runQueueStress(cdp));
    await recordScenario('conversation-isolation', () => runConversationIsolationStress(cdp));
    await recordScenario('long-context', () => runLongContextStress(cdp));
  } finally {
    try { if (cdp?.ws) cdp.ws.close(); } catch {}
    try { if (child && !child.killed) child.kill(); } catch {}
    await sleep(1000);
    stopReleaseProcesses();
    const remaining = releaseProcessCount();
    results.push({
      name: 'release-process-cleanup',
      status: remaining === 0 ? 'pass' : 'fail',
      rootCause: remaining === 0 ? '' : 'process-leak',
      elapsedMs: 0,
      detail: `remaining=${remaining}`,
    });
    if (keepRoot) log(`kept root: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
    const report = writeReport(provider, root);
    if (report.failCount > 0) process.exitCode = 1;
  }
})().catch(error => {
  results.push({
    name: 'real-provider-stress-harness',
    status: 'fail',
    rootCause: classifyFailure(error),
    elapsedMs: 0,
    detail: redact(error && (error.stack || error.message) || error),
  });
  console.error(`[release-real-provider-stress] ${redact(error && (error.stack || error.message) || error)}`);
  try {
    stopReleaseProcesses();
    writeReport(providerFromEnv(), '');
  } catch {}
  process.exit(1);
});
