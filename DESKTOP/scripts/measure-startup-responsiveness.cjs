const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const desktop = path.resolve(__dirname, '..');
const electron = path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-startup-responsive-'));
const lifecycle = path.join(fixture, '.newmark-runtime');
const port = Number(process.env.NEWMARK_STARTUP_MEASURE_PORT || 49481);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function targets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json/list`, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function responding(pid) {
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if(!$p){'missing'}elseif($p.Responding){'true'}else{'false'}`],
  { encoding: 'utf8', windowsHide: true });
  return String(probe.stdout || '').trim();
}

function connect(target) {
  const pending = new Map();
  let nextId = 1;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, call };
}

(async () => {
  fs.mkdirSync(lifecycle, { recursive: true });
  for (let index = 0; index < 1000; index += 1) {
    fs.writeFileSync(path.join(lifecycle, `lifecycle-main-clean-${index}.json`), JSON.stringify({
      role: 'main', ownerId: `clean-${index}`, pid: 0, active: false,
    }));
  }
  const startedAt = Date.now();
  const child = spawn(electron, ['dist/main.js', '--gui', '--allow-multiple-instances',
    `--remote-debugging-port=${port}`, '--no-sandbox', '--root', fixture], {
    cwd: desktop, stdio: 'ignore', windowsHide: true,
  });
  let startupShellMs = null;
  let indexNavigationMs = null;
  let interactiveMs = null;
  let mainTarget = null;
  let nonRespondingSamples = 0;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && indexNavigationMs === null) {
      if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}`);
      if (responding(child.pid) === 'false') nonRespondingSamples += 1;
      try {
        for (const target of await targets()) {
          const url = String(target.url || '');
          if (startupShellMs === null && url.includes('startup.html')) startupShellMs = Date.now() - startedAt;
          if (url.includes('index.html')) {
            indexNavigationMs = Date.now() - startedAt;
            mainTarget = target;
          }
        }
      } catch {}
      await sleep(100);
    }
    if (indexNavigationMs === null) throw new Error('Timed out waiting for index.html');
    const cdp = connect(mainTarget);
    const responsivenessSampler = setInterval(() => {
      if (responding(child.pid) === 'false') nonRespondingSamples += 1;
    }, 100);
    try {
      await cdp.ready;
      await waitForPromotedMainUi(cdp, { timeoutMs: 30_000, pollMs: 100 });
      interactiveMs = Date.now() - startedAt;
    } finally {
      clearInterval(responsivenessSampler);
    }
    cdp.ws.close();
    const remaining = fs.readdirSync(lifecycle).filter(file => file.startsWith('lifecycle-main')).length;
    console.log(JSON.stringify({ startupShellMs, indexNavigationMs, interactiveMs, nonRespondingSamples,
      processResponding: responding(child.pid), remainingLifecycleMarkers: remaining }, null, 2));
  } finally {
    child.kill();
    await sleep(500);
    const resolvedFixture = path.resolve(fixture);
    if (!resolvedFixture.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Refusing fixture cleanup outside temp');
    fs.rmSync(resolvedFixture, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
