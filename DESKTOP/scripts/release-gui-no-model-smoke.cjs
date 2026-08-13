const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');

function fail(message) {
  throw new Error(`[release-gui-no-model-smoke] ${message}`);
}

function log(message) {
  process.stdout.write(`[release-gui-no-model-smoke] ${message}\n`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2_000, () => request.destroy(new Error('HTTP timeout')));
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl
        && (item.type === 'page' || item.type === 'webview')
        && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  fail(`timed out waiting for Electron CDP target on port ${port}`);
}

function connectCdp(target) {
  let nextId = 1;
  const pending = new Map();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 20_000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
  return { socket, ready, call };
}

async function evaluate(cdp, expression, timeoutMs = 20_000) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || JSON.stringify(details));
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression);
    if (last) return last;
    await sleep(250);
  }
  fail(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function writeEmptyConfig(root) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: [],
      default_model: '',
      default_intelligence: 'low',
      agent_engine: 'builtin',
      auto_switch: false,
      fallback_on_unavailable: false,
    },
    general: { language: 'en' },
    agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    terminal: { interrupt_timeout_ms: 0 },
    workspace: { prompt_mode: 'global_only', auto_create_timestamp_workspace: true },
  }, null, 2), 'utf8');
}

function stopProcessTree(pid) {
  if (!pid) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
}

function remainingReleaseProcesses() {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq '${exePath.replace(/'/g, "''")}' }).Count`,
  ], { encoding: 'utf8', windowsHide: true });
  return Number(String(result.stdout || '').trim()) || 0;
}

async function main() {
  if (process.platform !== 'win32') {
    log('skipped: Windows packaged GUI smoke only runs on win32');
    return;
  }
  if (!fs.existsSync(exePath)) fail(`missing packaged GUI: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-gui-no-model-'));
  const port = Number(process.env.NEWMARK_GUI_NO_MODEL_PORT || '49391');
  let child;
  let cdp;
  try {
    writeEmptyConfig(root);
    child = spawn(exePath, [
      `--remote-debugging-port=${port}`,
      '--allow-multiple-instances',
      '--disable-gpu',
      '--no-sandbox',
      '--root', root,
    ], { cwd: root, stdio: 'ignore', windowsHide: true });
    const target = await waitForTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');
    await cdp.call('Page.bringToFront');
    await waitFor(cdp, `typeof window.api === 'object' && typeof window.api.getState === 'function' && typeof window.sendMessage === 'function'`, 30_000, 'GUI API');
    await waitFor(cdp, `document.readyState === 'complete' && !!document.querySelector('#prompt')`, 30_000, 'prompt input');

    const initial = await evaluate(cdp, `window.api.getState().then(state => ({
      model: state.model || '',
      providers: state.providers || state.models?.providers || [],
      target: state.target || null,
      running: !!state.running,
      workRuns: Array.isArray(state.workRuns) ? state.workRuns : [],
    }))`);
    if (initial.providers.length !== 0) fail(`empty-provider fixture was not loaded: ${JSON.stringify(initial)}`);

    const invocation = await evaluate(cdp, `(() => {
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('missing #prompt');
      prompt.focus();
      prompt.value = 'BLACKBOX_GUI_NO_MODEL';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      window.__guiNoModelRun = { settled: false, value: null, error: '' };
      window.sendMessage().then(value => {
        window.__guiNoModelRun = { settled: true, value, error: '' };
      }).catch(error => {
        window.__guiNoModelRun = { settled: true, value: null, error: String(error?.stack || error) };
      });
      return true;
    })()`);
    if (invocation !== true) fail(`send invocation did not start: ${JSON.stringify(invocation)}`);

    const settled = await waitFor(cdp, `window.__guiNoModelRun?.settled ? window.__guiNoModelRun : null`, 45_000, 'GUI no-model send settlement');
    const state = await waitFor(cdp, `window.api.getState().then(value => value && value.runtime && !value.runtime.running ? value : null)`, 30_000, 'GUI no-model idle state');
    const renderer = await evaluate(cdp, `(() => ({
      runtime: typeof state === 'object' && state.conversationRuntimeStates
        ? Object.values(state.conversationRuntimeStates).find(item => item && item.target && item.target.conversationId === 'default') || null
        : null,
      running: typeof state === 'object' && state.runningConversations ? Object.keys(state.runningConversations) : [],
    }))()`);
    const visible = await evaluate(cdp, `(() => {
      const body = document.body.innerText || '';
      const notices = Array.from(document.querySelectorAll('.ui-notice, .ui-notice-item, [role="alert"]')).map(node => node.innerText || node.textContent || '').join(' ');
      const messages = Array.from(document.querySelectorAll('#chat-area .chat-msg')).map(node => ({
        className: node.className,
        text: node.innerText || node.textContent || '',
      }));
      const runs = Array.from(document.querySelectorAll('.conversation-work-run')).map(node => node.innerText || node.textContent || '');
      return { body: body.slice(-5000), notices: notices.slice(-2000), messages, runs };
    })()`);

    const runs = Array.isArray(state.workRuns) ? state.workRuns : [];
    const run = runs.at(-1);
    const runEvents = item => Array.isArray(item?.events) ? item.events.map(event => `${event.type}:${event.content || ''}`) : [];
    const serialized = JSON.stringify({ settled, state, renderer, visible });
    log(`observation ${JSON.stringify({
      settled,
      backendRunning: !!state.runtime?.running,
      rendererStatus: renderer.runtime?.status || '',
      runStatus: run?.status || '',
      runEvents: runEvents(run),
      visibleError: /No LLM configured/i.test(serialized),
      visibleMessageCount: visible.messages.length,
      visibleRunCount: visible.runs.length,
    })}`);
    if (settled.error) fail(`renderer send rejected unexpectedly: ${settled.error}`);
    if (settled.value?.status === 'completed') fail(`GUI returned completed status for no-model run: ${JSON.stringify(settled.value)}`);
    if (settled.value?.error && !/No LLM configured/i.test(String(settled.value.error))) fail(`unexpected GUI error: ${JSON.stringify(settled.value)}`);
    if (!run || run.status !== 'error') fail(`no terminal error work run in GUI snapshot: ${JSON.stringify(runs).slice(-4000)}`);
    if (!runs.every(item => !item.events?.some(event => event.type === 'done' || event.type === 'final_response'))) {
      fail(`no-model GUI emitted successful completion/final response: ${JSON.stringify(runs).slice(-6000)}`);
    }
    if (!/No LLM configured/i.test(serialized)) fail(`GUI did not expose the no-model diagnostic: ${serialized.slice(-6000)}`);
    if (state.runtime?.running) fail(`GUI backend remained running after no-model failure: ${JSON.stringify(state.runtime)}`);
    if (renderer.running.length) fail(`GUI renderer retained running conversation after no-model failure: ${JSON.stringify(renderer)}`);
    if (renderer.runtime && renderer.runtime.status !== 'error') fail(`GUI renderer runtime did not settle as error: ${JSON.stringify(renderer)}`);
    if (renderer.runtime && renderer.runtime.status === 'completed') fail(`GUI renderer falsely marked no-model run completed: ${JSON.stringify(renderer)}`);
    log(`GUI_NO_MODEL_BLACKBOX_PASS runId=${run.runId} status=${run.status} rendererStatus=${renderer.runtime?.status || 'missing'} backendRunning=${!!state.runtime?.running}`);
  } finally {
    if (cdp?.socket?.readyState === WebSocket.OPEN) cdp.socket.close();
    stopProcessTree(child?.pid);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && remainingReleaseProcesses() > 0) await sleep(250);
    if (remainingReleaseProcesses() > 0) fail('packaged GUI process remained after no-model smoke');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
});
