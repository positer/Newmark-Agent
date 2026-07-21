const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const unpackedRoot = path.join(repoRoot, 'release', 'linux-unpacked');
const exePath = process.env.NEWMARK_LINUX_EXE || [
  path.join(unpackedRoot, 'newmark-agent'),
  path.join(unpackedRoot, 'Newmark Agent'),
].find(candidate => fs.existsSync(candidate));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fail(message) { throw new Error(message); }
function log(message) { console.log(`[release-linux-exit-lifecycle-smoke] ${message}`); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function waitForTarget(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  fail(`timed out waiting for Linux renderer on port ${port}`);
}

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 15_000) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function waitForExit(child, timeoutMs = 16_000) {
  if (child.exitCode !== null) return true;
  return await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ]);
}

function processResidue(root) {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
  return String(result.stdout || '').split('\n').filter(line => line.includes(root) && !line.includes('release-linux-exit-lifecycle-smoke'));
}

async function launchAndExit(root, port, label) {
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', `--root=${root}`], {
    cwd: path.dirname(exePath),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  let cdp;
  try {
    const target = await waitForTarget(port);
    cdp = connect(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    const state = await evaluate(cdp, 'window.api.lifecycleState()');
    if (!state?.windowVisible) fail(`${label}: main window was not visible before exit`);
    await evaluate(cdp, 'window.api.exitApplication()').catch(() => undefined);
    if (!await waitForExit(child)) fail(`${label}: main process did not exit within the 12-second shutdown deadline`);
    await sleep(750);
    const residue = processResidue(root);
    if (residue.length) fail(`${label}: Linux process residue remained: ${residue.join(' | ')}`);
    log(`${label} exited cleanly`);
  } finally {
    try { cdp?.ws.close(); } catch {}
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }
}

(async () => {
  if (process.platform !== 'linux') return log('skipped outside Linux');
  if (!exePath || !fs.existsSync(exePath)) fail(`Linux executable missing under ${unpackedRoot}`);
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) fail('Linux display is unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-linux-exit-'));
  try {
    await launchAndExit(root, 49741, 'first launch');
    await launchAndExit(root, 49742, 'same-root relaunch');
    log('PASS: explicit/tray-shared exit leaves no ghost process and releases the single-instance lock');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
