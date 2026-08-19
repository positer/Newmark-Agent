const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { waitForPromotedMainUi } = require('./cdp-main-ui-ready');

const repoRoot = path.resolve(__dirname, '..', '..');
const packageRoot = path.join(repoRoot, 'release', 'win-unpacked');
const cliExe = path.resolve(process.env.NEWMARK_SHARED_ROOT_CLI_EXE || path.join(packageRoot, 'Newmark.exe'));
const guiExe = path.resolve(process.env.NEWMARK_SHARED_ROOT_GUI_EXE || path.join(packageRoot, 'Newmark Agent.exe'));
const installCwd = path.resolve(process.env.NEWMARK_SHARED_ROOT_CWD
  || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Newmark Agent'));

function assert(condition, message) {
  if (!condition) throw new Error(`safe shared-root restart stress failed: ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function removeTreeWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let entries;
    try {
      entries = fs.readdirSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      try {
        fs.rmSync(path.join(target, entry), { recursive: true, force: true });
      } catch (error) {
        lastError = error;
        if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      }
    }
    try {
      fs.rmdirSync(target);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
    await sleep(250 + attempt * 250);
  }
  throw lastError;
}

function stopTree(pid) {
  if (!pid) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
}

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

async function waitForCdpTarget(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(item => item.webSocketDebuggerUrl
        && (item.type === 'page' || item.type === 'webview')
        && String(item.url || '').includes('index.html'));
      if (target) return target;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timed out waiting for GUI CDP target on port ${port}`);
}

function connectCdp(target) {
  const WebSocketImpl = globalThis.WebSocket || require('ws');
  let nextId = 1;
  const pending = new Map();
  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  const ready = new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      clearTimeout(callbacks.timer);
      if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    };
  });
  function call(method, params = {}, timeoutMs = 15_000) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
  }
  return { socket, ready, call };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'CDP evaluation failed');
  }
  return result.result?.value;
}

function pathSnapshot(root) {
  const names = ['config.json', 'conversations', 'Work', 'archive', 'Electron'];
  return new Map(names.map(name => {
    const filePath = path.join(root, name);
    try {
      const stat = fs.statSync(filePath);
      return [filePath, { exists: true, directory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs }];
    } catch {
      return [filePath, { exists: false, directory: false, size: 0, mtimeMs: 0 }];
    }
  }));
}

function assertSnapshotUnchanged(before) {
  for (const [filePath, expected] of before.entries()) {
    let actual;
    try {
      const stat = fs.statSync(filePath);
      actual = { exists: true, directory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      actual = { exists: false, directory: false, size: 0, mtimeMs: 0 };
    }
    assert(JSON.stringify(actual) === JSON.stringify(expected), `protected install path changed: ${filePath}`);
  }
}

function runState(root) {
  const result = spawnSync(cliExe, ['state', '--root', root], {
    cwd: installCwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert(!result.error, `CLI state spawn failed: ${result.error?.message || 'unknown error'}`);
  assert(result.status === 0, `CLI state exit=${result.status}; output=${output.slice(0, 1200)}`);
  const state = JSON.parse(String(result.stdout || '').trim());
  assert(path.resolve(String(state.root || '')).toLowerCase() === path.resolve(root).toLowerCase(),
    `CLI selected an unexpected root: ${JSON.stringify(state)}`);
  return state;
}

async function runTui(root) {
  const terminal = pty.spawn(cliExe, ['--TUI', '--root', root], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: installCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    useConpty: true,
    useConptyDll: true,
  });
  let output = '';
  let exited = false;
  terminal.onData(chunk => { output += chunk; });
  const exit = new Promise(resolve => terminal.onExit(event => { exited = true; resolve(event); }));
  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !/WORKSPACES|Type a message/i.test(output)) await sleep(100);
    assert(/WORKSPACES|Type a message/i.test(output), `TUI did not start; output=${output.slice(-1600)}`);
    terminal.write('\u0003');
    const event = await Promise.race([exit, sleep(15_000).then(() => null)]);
    assert(event && event.exitCode === 0, `TUI did not exit cleanly: ${JSON.stringify(event)}; output=${output.slice(-1600)}`);
  } finally {
    if (!exited) {
      try { terminal.write('\u0003'); } catch {}
      await Promise.race([exit, sleep(1_500)]);
    }
    if (!exited) {
      try { terminal.kill(); } catch {}
    }
  }
}

async function runGui(root, port) {
  const child = spawn(guiExe, [
    `--remote-debugging-port=${port}`,
    '--allow-multiple-instances',
    '--disable-gpu',
    '--no-sandbox',
    '--root', root,
  ], { cwd: installCwd, stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const target = await waitForCdpTarget(port);
    cdp = connectCdp(target);
    await cdp.ready;
    await waitForPromotedMainUi(cdp);
    await cdp.call('Runtime.enable');
    const body = await evaluate(cdp, 'document.body ? document.body.innerText : ""');
    assert(!/EPERM|prewarm failed|unable to read conversation state|startup failed/i.test(String(body || '')),
      `GUI restart exposed a startup error: ${String(body || '').slice(0, 1600)}`);
    return { child, cdp, body: String(body || '') };
  } catch (error) {
    stopTree(child.pid);
    throw error;
  }
}

function assertRegistryDoesNotReferenceInstall(root) {
  const work = path.join(root, 'Work');
  for (const file of ['Local.json', 'External.json', 'State.json']) {
    const candidate = path.join(work, file);
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf8').toLowerCase();
    assert(!text.includes(installCwd.toLowerCase()), `${file} registered the protected installation cwd`);
  }
}

async function main() {
  assert(process.platform === 'win32', 'protected-cwd shared-root gate requires Windows');
  assert(fs.existsSync(cliExe), `missing packaged console executable: ${cliExe}`);
  assert(fs.existsSync(guiExe), `missing packaged GUI executable: ${guiExe}`);
  assert(fs.existsSync(installCwd), `missing real installation cwd: ${installCwd}`);
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-safe-shared-root-'));
  const root = path.join(tempBase, 'Runtime Root With Spaces');
  fs.mkdirSync(root, { recursive: true });
  const protectedBefore = pathSnapshot(installCwd);
  let gui;
  try {
    const state = runState(root);
    await runTui(root);
    assertRegistryDoesNotReferenceInstall(root);

    const firstPort = 49560 + (process.pid % 100);
    gui = await runGui(root, firstPort);
    assert(gui.child.exitCode === null, 'GUI exited during first protected-cwd startup');
    try { gui.cdp.socket.close(); } catch {}
    stopTree(gui.child.pid);
    await sleep(1200);
    gui = null;

    const secondPort = firstPort + 1;
    gui = await runGui(root, secondPort);
    assert(gui.child.exitCode === null, 'GUI exited during shared-root restart');
    assertRegistryDoesNotReferenceInstall(root);
    stopTree(gui.child.pid);
    await sleep(1200);
    assertSnapshotUnchanged(protectedBefore);
    console.log(`SAFE_SHARED_ROOT_RESTART_STRESS_PASS cli=true tui=true gui=true guiRestart=true root=${root} installCwd=${installCwd} installMutablePathsUnchanged=true`);
    void state;
  } finally {
    try { if (gui?.cdp?.socket) gui.cdp.socket.close(); } catch {}
    if (gui?.child && gui.child.exitCode === null) stopTree(gui.child.pid);
    await removeTreeWithRetry(tempBase);
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  },
);
