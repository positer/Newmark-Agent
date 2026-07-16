const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const expectedVersion = require(path.join(appRoot, 'package.json')).version;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function findUnpackedRoot(extractRoot) {
  const pending = [path.resolve(extractRoot)];
  while (pending.length > 0) {
    const current = pending.shift();
    const executable = path.join(current, 'Newmark Agent.exe');
    const appAsar = path.join(current, 'resources', 'app.asar');
    if (fs.existsSync(executable) && fs.existsSync(appAsar)) return current;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(current, entry.name));
    }
  }
  throw new Error(`Newmark Agent.exe and resources/app.asar were not found together under ${extractRoot}`);
}

function runCliVersion(executable, runtimeRoot) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-release-cli-version-'));
  const stdoutPath = path.join(workDir, 'stdout.txt');
  const stderrPath = path.join(workDir, 'stderr.txt');
  const scriptPath = path.join(workDir, 'run.ps1');
  fs.writeFileSync(scriptPath, [
    '$ErrorActionPreference = "Stop"',
    `$exe = ${psQuote(executable)}`,
    `$stdout = ${psQuote(stdoutPath)}`,
    `$stderr = ${psQuote(stderrPath)}`,
    `$argumentList = @('install-update', '--version', '--root', ${psQuote(runtimeRoot)})`,
    '$p = Start-Process -FilePath $exe -ArgumentList $argumentList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr',
    'exit $p.ExitCode',
  ].join('\r\n'), 'utf8');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: path.dirname(executable),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 90000,
    });
    if (result.error) throw result.error;
    const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8').trim() : '';
    const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8').trim() : '';
    if (result.status !== 0) throw new Error(`packaged CLI exited ${result.status}: ${stderr || stdout || result.stderr || result.stdout}`);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`packaged CLI returned invalid JSON: ${stdout || '<empty>'}`);
    }
    assert(parsed.ok === true, `packaged CLI version result was not ok: ${stdout}`);
    assert(parsed.version === expectedVersion, `packaged CLI version mismatch: expected ${expectedVersion}, got ${parsed.version}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('CDP request timed out')));
    request.on('error', reject);
  });
}

async function waitForFinalTarget(port) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const finalTarget = targets.find(target => target.webSocketDebuggerUrl
        && (target.type === 'page' || target.type === 'webview')
        && String(target.url || '').includes('index.html'));
      if (finalTarget) return finalTarget;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error('timed out waiting for the packaged index.html renderer');
}

function connectWebSocket(url) {
  let WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    try {
      WebSocketImpl = require('undici').WebSocket;
    } catch {}
  }
  if (typeof WebSocketImpl !== 'function') throw new Error('this validation script requires global WebSocket support or undici.WebSocket');
  const socket = new WebSocketImpl(url);
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else callback.resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('failed to connect to packaged Electron CDP'));
  });
  function call(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, 15000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
  }
  return { socket, ready, call };
}

function stopSpawnedProcessTree(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    shell: false,
  });
  if (result.error && result.error.code !== 'ENOENT') throw result.error;
}

async function removeTreeWithRetries(target, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

async function runUiVersion(executable, runtimeRoot, profileRoot) {
  const port = await freeTcpPort();
  let child;
  let cdp;
  try {
    child = spawn(executable, [
      `--remote-debugging-port=${port}`,
      '--no-sandbox',
      '--root', runtimeRoot,
      `--user-data-dir=${profileRoot}`,
    ], {
      cwd: path.dirname(executable),
      stdio: 'ignore',
      windowsHide: true,
    });
    const target = await waitForFinalTarget(port);
    cdp = connectWebSocket(target.webSocketDebuggerUrl);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    const deadline = Date.now() + 30000;
    let snapshot = {};
    while (Date.now() < deadline) {
      const evaluated = await cdp.call('Runtime.evaluate', {
        expression: `(async () => ({
          ready: document.readyState,
          title: document.title,
          bodyLength: (document.body?.textContent || '').length,
          api: typeof window.api === 'object',
          version: typeof window.api?.updateVersion === 'function' ? (await window.api.updateVersion()).version : ''
        }))()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || 'renderer evaluation failed');
      snapshot = evaluated.result?.value || {};
      if ((snapshot.ready === 'complete' || snapshot.ready === 'interactive')
        && snapshot.api === true && snapshot.bodyLength > 100 && snapshot.version === expectedVersion) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(snapshot.ready === 'complete' || snapshot.ready === 'interactive', `packaged UI did not reach a ready document: ${snapshot.ready}`);
    assert(snapshot.api === true, 'packaged UI preload API is unavailable');
    assert(snapshot.bodyLength > 100, `packaged UI body is unexpectedly small: ${snapshot.bodyLength}`);
    assert(snapshot.version === expectedVersion, `packaged UI version mismatch: expected ${expectedVersion}, got ${snapshot.version}`);
  } finally {
    try { cdp?.socket.close(); } catch {}
    stopSpawnedProcessTree(child);
    await new Promise(resolve => setTimeout(resolve, 750));
  }
}

async function smokeWindowsUnpacked(extractRoot, label) {
  assert(process.platform === 'win32', `${label} smoke can only run on Windows`);
  const unpackedRoot = findUnpackedRoot(extractRoot);
  const executable = path.join(unpackedRoot, 'Newmark Agent.exe');
  const appAsar = path.join(unpackedRoot, 'resources', 'app.asar');
  assert(fs.statSync(executable).isFile() && fs.statSync(executable).size > 1000000, `${label} executable is missing or incomplete`);
  assert(fs.statSync(appAsar).isFile() && fs.statSync(appAsar).size > 1000000, `${label} app.asar is missing or incomplete`);
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-release-runtime-'));
  try {
    const runtimeRoot = path.join(isolatedRoot, 'runtime');
    const profileRoot = path.join(isolatedRoot, 'electron-profile');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(profileRoot, { recursive: true });
    runCliVersion(executable, runtimeRoot);
    await runUiVersion(executable, runtimeRoot, profileRoot);
  } finally {
    await removeTreeWithRetries(isolatedRoot);
  }
  return unpackedRoot;
}

module.exports = {
  expectedVersion,
  findUnpackedRoot,
  psQuote,
  smokeWindowsUnpacked,
};
