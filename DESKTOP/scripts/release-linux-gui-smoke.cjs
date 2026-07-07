const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const releaseRoot = path.join(repoRoot, 'release');
const exePath = process.env.NEWMARK_LINUX_EXE || path.join(releaseRoot, 'linux-unpacked', 'newmark-agent');
const screenshotPath = process.env.NEWMARK_LINUX_GUI_SCREENSHOT || path.join(repoRoot, 'archive', '2026-07-06-linux-wsl-gui-smoke.png');

function log(message) {
  console.log(`[release-linux-gui-smoke] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function main() {
  if (process.platform !== 'linux') fail('release:linux-gui-smoke must run on Linux');
  if (!fs.existsSync(exePath)) fail(`Linux executable missing: ${exePath}`);
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) fail('DISPLAY/WAYLAND_DISPLAY is not set; WSLg or a Linux display server is required');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-linux-gui-'));
  const port = 49300 + Math.floor(Math.random() * 1000);
  let child = null;
  let cdp = null;
  try {
    child = spawn(exePath, [`--remote-debugging-port=${port}`, '--no-sandbox', `--root=${root}`], {
      cwd: path.dirname(exePath),
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
    });
    child.on('exit', code => log(`process exited code=${code}`));

    const target = await waitForTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable').catch(() => undefined);
    await evaluate(cdp, `new Promise(resolve => {
      if (window.api && document.querySelector('#terminal-shell-select')) return resolve(true);
      const start = Date.now();
      const timer = setInterval(() => {
        if ((window.api && document.querySelector('#terminal-shell-select')) || Date.now() - start > 15000) {
          clearInterval(timer);
          resolve(!!window.api);
        }
      }, 250);
    })`, 20000);
    await sleep(1500);

    const snapshot = await evaluate(cdp, `({
      platform: window.state?.platform || '',
      defaultTerminalShell: window.state?.defaultTerminalShell || '',
      runtimeDefaultTerminalShell: window.state?.runtimeDefaultTerminalShell || '',
      terminalShells: window.state?.terminalShells || [],
      selectedShell: document.querySelector('#terminal-shell-select')?.value || '',
      prompt: document.querySelector('#terminal-pane-0 .terminal-prompt')?.textContent || '',
      connected: Array.from(document.querySelectorAll('.terminal-output span')).map(el => el.textContent || '').find(text => text.includes('Terminal connected') || text.includes('终端已连接')) || '',
      title: document.title,
      bodyText: document.body.innerText.slice(0, 1200)
    })`, 20000);

    if (snapshot.platform !== 'linux') fail(`Expected linux renderer platform, got ${snapshot.platform}`);
    if (snapshot.runtimeDefaultTerminalShell !== 'bash') fail(`Expected runtime default bash, got ${snapshot.runtimeDefaultTerminalShell}`);
    if (snapshot.defaultTerminalShell !== 'bash') fail(`Expected configured default bash, got ${snapshot.defaultTerminalShell}`);
    if (snapshot.selectedShell !== 'bash') fail(`Expected selected terminal shell bash, got ${snapshot.selectedShell}`);
    if (!Array.isArray(snapshot.terminalShells) || !snapshot.terminalShells.includes('bash') || snapshot.terminalShells.includes('powershell')) {
      fail(`Unexpected Linux terminal shells: ${JSON.stringify(snapshot.terminalShells)}`);
    }
    if (!String(snapshot.connected).toLowerCase().includes('bash')) {
      fail(`Expected visible terminal connected text to mention bash, got ${snapshot.connected}`);
    }

    await captureScreenshot(cdp, screenshotPath);
    log(`snapshot ${JSON.stringify(snapshot)}`);
    log('PASS');
  } finally {
    if (cdp?.ws) {
      try { cdp.ws.close(); } catch {}
    }
    if (child && !child.killed) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await sleep(800);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`[release-linux-gui-smoke] FAIL ${error.stack || error.message || error}`);
  process.exit(1);
});
