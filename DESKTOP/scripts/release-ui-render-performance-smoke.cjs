const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');

function fail(message) { throw new Error(`[release-ui-render-performance-smoke] ${message}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || JSON.stringify(details));
  }
  return result.result?.value;
}

function stopProcessTree(pid) {
  if (pid) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
}

async function removeRootWhenReleased(root) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || attempt === 19) throw error;
      await sleep(250);
    }
  }
}

async function main() {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(exePath)) fail(`missing packaged GUI: ${exePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-ui-render-performance-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: { providers: [], default_model: '', default_intelligence: 'low' },
    general: { language: 'en' },
    workspace: { prompt_mode: 'global_only', auto_create_timestamp_workspace: true },
  }, null, 2), 'utf8');
  const port = Number(process.env.NEWMARK_UI_RENDER_PERF_PORT || '49432');
  let child;
  let cdp;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--allow-multiple-instances', '--no-sandbox', '--root', root], {
      cwd: root, stdio: 'ignore', windowsHide: true,
    });
    const target = await waitForTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    const result = await evaluate(cdp, `(async () => {
      const prompt = document.querySelector('#prompt');
      if (!prompt) throw new Error('missing prompt');
      const animated = Array.from(document.querySelectorAll('.marquee-border, .working-glow')).filter(node => {
        const style = getComputedStyle(node, '::before');
        return style.animationName && style.animationName !== 'none';
      }).length;
      const originalRender = renderConversationWorkRun;
      let renders = 0;
      renderConversationWorkRun = function() { renders += 1; };
      const run = { runId: 'performance-smoke', target: currentConversationTarget(activeConversationId()) };
      let inputEvents = 0;
      let maxInputDelayMs = 0;
      let expectedAt = performance.now() + 10;
      const inputTimer = setInterval(() => {
        const now = performance.now();
        maxInputDelayMs = Math.max(maxInputDelayMs, now - expectedAt);
        expectedAt = now + 10;
        prompt.value += 'x';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        inputEvents += 1;
      }, 10);
      const eventTimer = setInterval(() => scheduleConversationWorkRunRender(run), 2);
      await new Promise(resolve => setTimeout(resolve, 1_050));
      clearInterval(inputTimer);
      clearInterval(eventTimer);
      await new Promise(resolve => setTimeout(resolve, 180));
      renderConversationWorkRun = originalRender;
      return { animated, renders, inputEvents, maxInputDelayMs, minInterval: WORK_RUN_RENDER_MIN_INTERVAL_MS };
    })()`, 30_000);
    if (result.animated === 0) fail(`marquee/working-glow animations must stay active: ${JSON.stringify(result)}`);
    if (result.minInterval !== 100) fail(`unexpected Build render interval: ${JSON.stringify(result)}`);
    if (result.renders > 12) fail(`Build rendering exceeded the 10fps backpressure budget: ${JSON.stringify(result)}`);
    if (result.inputEvents < 80 || result.maxInputDelayMs > 100) fail(`input event loop was starved: ${JSON.stringify(result)}`);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } finally {
    try { cdp?.socket.close(); } catch {}
    stopProcessTree(child?.pid);
    await removeRootWhenReleased(root);
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
