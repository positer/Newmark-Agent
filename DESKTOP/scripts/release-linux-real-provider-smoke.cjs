const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const releaseRoot = path.join(repoRoot, 'release');
const exePath = process.env.NEWMARK_LINUX_EXE || path.join(releaseRoot, 'linux-unpacked', 'newmark-agent');
const defaultConfigPath = '/mnt/c/Users/12252/Desktop/Files/Code/Newmark Agent/_local/real-ui-user-test/config.json';
const sourceConfigPath = process.env.NEWMARK_LINUX_REAL_CONFIG || defaultConfigPath;
const screenshotPath = process.env.NEWMARK_LINUX_REAL_SCREENSHOT || path.join(repoRoot, 'archive', '2026-07-06-linux-real-provider-smoke.png');
const cliMarker = process.env.NEWMARK_LINUX_REAL_CLI_MARKER || 'LINUX_REAL_CLI_OK_20260706';
const uiMarker = process.env.NEWMARK_LINUX_REAL_UI_MARKER || 'LINUX_REAL_UI_OK_20260706';

function log(message) {
  console.log(`[release-linux-real-provider-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readConfig(filePath) {
  const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const modelsSection = config.models || {};
  const providersEntry = modelsSection.providers;
  const providers = Array.isArray(providersEntry?.value) ? providersEntry.value : (Array.isArray(providersEntry) ? providersEntry : []);
  const defaultModel = String(modelsSection.default_model?.value || modelsSection.default_model || '').trim();
  const provider = providers.find(p => p && p.enabled !== false && Array.isArray(p.models) && p.models.length && p.api_key)
    || providers.find(p => p && p.enabled !== false && p.api_key)
    || providers[0];
  if (!provider) fail(`No provider found in ${filePath}`);
  const model = defaultModel || String((provider.models || [])[0]?.name || provider.models?.[0] || '').trim();
  if (!model) fail(`No model found in ${filePath}`);
  if (!provider.api_key) fail(`Provider ${provider.name || '(unnamed)'} has no API key`);
  return { config, provider, model, apiKey: String(provider.api_key) };
}

function sanitize(text, secrets) {
  let out = String(text || '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  return out;
}

function countOccurrences(text, marker) {
  return String(text || '').split(marker).length - 1;
}

function runCli(args, cwd, secrets, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`CLI timed out: ${args[0]}\nstdout=${sanitize(stdout, secrets)}\nstderr=${sanitize(stderr, secrets)}`));
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`CLI exited ${code}: ${args.join(' ')}\nstdout=${sanitize(stdout, secrets)}\nstderr=${sanitize(stderr, secrets)}`));
        return;
      }
      resolve({ stdout, stderr });
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
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview') && String(t.url || '').includes('index.html'))
        || targets.find(t => t.webSocketDebuggerUrl && (t.type === 'page' || t.type === 'webview'))
        || targets.find(t => t.webSocketDebuggerUrl);
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
  fail(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue).slice(0, 800)}`);
}

function jsString(value) {
  return JSON.stringify(String(value));
}

async function captureScreenshot(cdp, filePath) {
  await cdp.call('Page.bringToFront', {}, 10000).catch(() => undefined);
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  }, 10000).catch(() => undefined);
  await sleep(500);
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
  if (!screenshot?.data) fail('CDP screenshot returned no data');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
  const stat = fs.statSync(filePath);
  if (stat.size < 10000) fail(`Screenshot too small: ${stat.size}`);
  log(`screenshot ${filePath} (${stat.size} bytes)`);
}

function markerStatsExpression(marker) {
  return `window.api.getState().then(state => {
    const marker = ${jsString(marker)};
    const assistantEls = Array.from(document.querySelectorAll('.chat-msg.assistant .msg-body'));
    const matchingEls = assistantEls.filter(el => (el.innerText || '').includes(marker));
    const messages = (state && Array.isArray(state.chatMessages)) ? state.chatMessages : [];
    const matchingMessages = messages.filter(m => m && m.role === 'assistant' && String(m.content || '').includes(marker));
    return {
      count: matchingEls.length,
      backendCount: matchingMessages.length,
      status: state && state.status,
      platform: window.state && window.state.platform,
      model: state && state.model,
      selectedShell: document.querySelector('#terminal-shell-select')?.value || '',
      connected: Array.from(document.querySelectorAll('.terminal-output span')).map(el => el.textContent || '').find(text => text.includes('Terminal connected') || text.includes('终端已连接')) || '',
      bodyTail: (document.querySelector('#chat-area')?.innerText || document.body.innerText || '').slice(-1200)
    };
  })`;
}

async function runCliChecks(root, model, secrets) {
  const state = await runCli(['state', '--root', root], root, secrets, 60000);
  if (state.stdout.includes(secrets[0])) fail('Linux state leaked API key');
  const parsed = JSON.parse(state.stdout);
  if (parsed.model !== model) fail(`Linux state model mismatch: expected ${model}, got ${parsed.model}`);
  if (parsed.platform !== 'linux') fail(`Linux state platform mismatch: ${parsed.platform}`);
  if (parsed.defaultTerminalShell !== 'bash') fail(`Linux state default shell mismatch: ${parsed.defaultTerminalShell}`);
  log(`state ok provider model=${model}`);

  const promptFile = path.join(root, 'linux-real-cli-prompt.txt');
  fs.writeFileSync(promptFile, `Reply exactly ${cliMarker}. No tools.`, 'utf8');
  const send = await runCli(['send', '--input-file', promptFile, '--mode', 'build', '--model', model, '--conversation', 'linux-real-cli', '--root', root], root, secrets, 240000);
  if (send.stdout.includes(secrets[0]) || send.stderr.includes(secrets[0])) fail('Linux CLI send leaked API key');
  if (!send.stdout.includes(cliMarker)) fail(`Linux CLI real model response missing marker: ${sanitize(send.stdout, secrets)}`);
  if (countOccurrences(send.stdout, cliMarker) !== 1) fail(`Linux CLI real model response duplicated marker: ${sanitize(send.stdout, secrets)}`);
  log('real Linux CLI send ok');
}

async function runGuiCheck(root, model, secrets) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) fail('DISPLAY/WAYLAND_DISPLAY is not set; WSLg or a Linux display server is required');
  const port = 50400 + Math.floor(Math.random() * 1000);
  let child = null;
  let cdp = null;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', `--root=${root}`], {
      cwd: path.dirname(exePath),
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    child.on('exit', code => log(`process exited code=${code}`));
    const target = await waitForTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable').catch(() => undefined);
    const initial = await waitFor(cdp, `window.api.getState().then(state => {
      if (!state || !state.model || !document.querySelector('#prompt')) return null;
      return {
        model: state.model,
        platform: window.state?.platform || '',
        defaultTerminalShell: window.state?.defaultTerminalShell || '',
        selectedShell: document.querySelector('#terminal-shell-select')?.value || '',
        connected: Array.from(document.querySelectorAll('.terminal-output span')).map(el => el.textContent || '').find(text => text.includes('Terminal connected') || text.includes('终端已连接')) || ''
      };
    })`, 45000, 'initial Linux real UI state');
    if (initial.model !== model) fail(`Linux UI model mismatch: expected ${model}, got ${initial.model}`);
    if (initial.platform !== 'linux') fail(`Linux UI platform mismatch: ${initial.platform}`);
    if (initial.defaultTerminalShell !== 'bash' || initial.selectedShell !== 'bash') fail(`Linux UI shell mismatch: ${JSON.stringify(initial)}`);

    await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('missing #prompt');
      if (typeof window.sendMessage !== 'function') throw new Error('missing window.sendMessage');
      prompt.focus();
      prompt.value = ${jsString(`Reply exactly ${uiMarker}. No tools.`)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.sendMessage();
      return true;
    })()`);

    const stats = await waitFor(cdp, `(${markerStatsExpression(uiMarker)}).then(stats => stats && stats.count > 0 ? stats : null)`, 240000, 'visible Linux real UI assistant marker');
    if (stats.count !== 1) fail(`Linux UI duplicated marker count=${stats.count}; stats=${sanitize(JSON.stringify(stats), secrets)}`);
    const idle = await waitFor(cdp, `window.api.getState().then(state => state && state.status === 'idle' ? state : null)`, 60000, 'Linux real UI idle');
    const stateText = JSON.stringify(idle);
    if (stateText.includes(secrets[0])) fail('Linux UI renderer state leaked API key');
    await captureScreenshot(cdp, screenshotPath);
    log(`real Linux UI send ok stats=${sanitize(JSON.stringify(stats), secrets)}`);
  } finally {
    if (cdp?.ws) {
      try { cdp.ws.close(); } catch {}
    }
    if (child) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await sleep(800);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }
}

async function main() {
  if (process.platform !== 'linux') fail('release:linux-real-provider-smoke must run on Linux');
  if (!fs.existsSync(exePath)) fail(`Linux executable missing: ${exePath}`);
  if (!fs.existsSync(sourceConfigPath)) fail(`Real config missing: ${sourceConfigPath}`);
  const { config, provider, model, apiKey } = readConfig(sourceConfigPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-linux-real-'));
  const secrets = [apiKey];
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    fs.writeFileSync(path.join(root, 'agent.md'), 'Linux real-provider smoke root. Do not expose secrets.', 'utf8');
    log(`using provider=${provider.name || '(unnamed)'} base_url=${provider.base_url || ''} model=${model} has_key=${!!apiKey}`);
    await runCliChecks(root, model, secrets);
    await runGuiCheck(root, model, secrets);
    log('PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`[release-linux-real-provider-smoke] FAIL ${error.stack || error.message || error}`);
  process.exit(1);
});
