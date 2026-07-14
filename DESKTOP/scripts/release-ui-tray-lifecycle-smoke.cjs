const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = process.env.NEWMARK_TEST_EXE
  ? path.resolve(process.env.NEWMARK_TEST_EXE)
  : path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fail(message) { throw new Error(message); }
function log(message) { console.log(`[release-ui-tray-lifecycle-smoke] ${message}`); }

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
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(300);
  }
  fail('timed out waiting for packaged renderer');
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
  function call(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
    });
  }
  return { ws, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

function prepareRoot(closeBehavior, minimizeToTray) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'NewmarkTrayLifecycle-'));
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'DESKTOP', 'config.example.json'), 'utf8'));
  config.general = config.general || {};
  config.ui = config.ui || {};
  config.general.close_behavior = { value: closeBehavior };
  config.ui.minimize_to_tray = { value: minimizeToTray };
  fs.writeFileSync(path.join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return true;
  return await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function launch(root, port) {
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', '--root', root], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const target = await waitForTarget(port);
  const cdp = connect(target);
  await cdp.ready;
    await waitForPromotedMainUi(cdp);
  await cdp.call('Runtime.enable');
  return { child, cdp };
}

function cleanReleaseProcesses() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process | Where-Object { $_.Path -like '*Newmark Agent*release*' } | Stop-Process -Force"], {
    windowsHide: true,
  });
}

(async () => {
  if (process.platform !== 'win32') return log('skipped outside Windows');
  if (!fs.existsSync(exePath)) fail(`missing packaged executable: ${exePath}`);
  cleanReleaseProcesses();

  const minimizeRoot = prepareRoot('exit', true);
  const closeRoot = prepareRoot('exit', true);
  let first;
  let second;
  try {
    first = await launch(minimizeRoot, 49371);
    const opened = await evaluate(first.cdp, 'window.api.lifecycleState()');
    if (!opened.trayActive || !opened.windowVisible) fail(`tray is not persistent while open: ${JSON.stringify(opened)}`);
    await evaluate(first.cdp, 'window.api.minimize()');
    await sleep(500);
    const minimized = await evaluate(first.cdp, 'window.api.lifecycleState()');
    if (!minimized.trayActive || minimized.windowVisible || first.child.exitCode !== null) {
      fail(`minimize-to-tray lifecycle failed: ${JSON.stringify(minimized)}`);
    }
    log('open and minimize-to-tray lifecycle passed');
    first.cdp.ws.close();
    first.child.kill();
    await waitForExit(first.child, 5000);

    second = await launch(closeRoot, 49372);
    const beforeClose = await evaluate(second.cdp, 'window.api.lifecycleState()');
    if (!beforeClose.trayActive || !beforeClose.windowVisible) fail(`direct-close precondition failed: ${JSON.stringify(beforeClose)}`);
    await evaluate(second.cdp, 'window.api.close()').catch(() => undefined);
    if (!await waitForExit(second.child)) fail('direct close left the packaged process or tray running');
    log('direct-close lifecycle passed without process residue');
  } finally {
    try { first?.cdp.ws.close(); } catch {}
    try { second?.cdp.ws.close(); } catch {}
    try { if (first?.child.exitCode === null) first.child.kill(); } catch {}
    try { if (second?.child.exitCode === null) second.child.kill(); } catch {}
    cleanReleaseProcesses();
    fs.rmSync(minimizeRoot, { recursive: true, force: true });
    fs.rmSync(closeRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  cleanReleaseProcesses();
  process.exit(1);
});
