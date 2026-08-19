const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');

const repoRoot = path.resolve(__dirname, '..', '..');
const exePath = path.resolve(process.env.NEWMARK_SAFE_SHAPE_EXE || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark.exe'));
const guiPath = path.resolve(process.env.NEWMARK_SAFE_SHAPE_GUI || path.join(repoRoot, 'release', 'win-unpacked', 'Newmark Agent.exe'));
const protectedRoot = path.resolve(process.env.NEWMARK_SAFE_SHAPE_ROOT || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Newmark Agent'));
const log = message => process.stdout.write(`[safe-installed-shape] ${message}\n`);

function assert(condition, message) {
  if (!condition) throw new Error(`safe installed-shape stress failed: ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopTree(pid) {
  if (!pid) return;
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
}

function watchedPaths() {
  return ['config.json', 'conversations', 'Work', 'Flow', 'archive', 'Electron']
    .map(name => path.join(protectedRoot, name));
}

function snapshotWatchedPaths() {
  return new Map(watchedPaths().map(filePath => {
    try {
      const stat = fs.statSync(filePath);
      return [filePath, { exists: true, isDirectory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs }];
    } catch {
      return [filePath, { exists: false, isDirectory: false, size: 0, mtimeMs: 0 }];
    }
  }));
}

function assertWatchedPathsUnchanged(before) {
  const after = snapshotWatchedPaths();
  for (const [filePath, expected] of before.entries()) {
    const actual = after.get(filePath);
    assert(actual?.exists === expected.exists, `install mutable path presence changed: ${filePath}`);
    if (expected.exists) {
      assert(actual?.isDirectory === expected.isDirectory && actual?.size === expected.size && actual?.mtimeMs === expected.mtimeMs,
        `install mutable path changed: ${filePath}`);
    }
  }
}

function runState() {
  const result = spawnSync(exePath, ['state', '--root', protectedRoot], {
    cwd: protectedRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert(!result.error, `CLI state spawn failed: ${result.error?.message || 'unknown error'}`);
  assert(result.status === 0, `CLI state exit=${result.status}; stderr=${String(result.stderr || '').slice(0, 600)}`);
  const output = String(result.stdout || '');
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  assert(start >= 0 && end > start, 'CLI state did not return JSON');
  const state = JSON.parse(output.slice(start, end + 1));
  assert(state.root && !path.resolve(String(state.root)).toLowerCase().startsWith(`${protectedRoot.toLowerCase()}\\`),
    `CLI state still resolves mutable root inside install: ${state.root}`);
  return { elapsedMs: 0, root: String(state.root) };
}

async function runTui() {
  log('TUI start');
  const terminal = pty.spawn(exePath, ['--TUI', '--root', protectedRoot], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: protectedRoot,
    env: { ...process.env, TERM: 'xterm-256color' },
    useConpty: true,
    useConptyDll: true,
  });
  let output = '';
  let exitEvent = null;
  terminal.onData(chunk => { output += chunk; });
  const exit = new Promise(resolve => terminal.onExit(event => { exitEvent = event; resolve(event); }));
  const deadline = Date.now() + 45_000;
  try {
    while (Date.now() < deadline) {
      if (/WORKSPACES|Type a message/i.test(output)) break;
      await sleep(100);
    }
    assert(/WORKSPACES|Type a message/i.test(output), `TUI did not start; output=${output.slice(-1200)}`);
    terminal.write('\u0003');
    const event = await Promise.race([exit, sleep(15_000).then(() => null)]);
    assert(event && event.exitCode === 0, `TUI exit=${event ? event.exitCode : 'timeout'}; output=${output.slice(-1200)}`);
    log('TUI clean exit');
  } finally {
    if (!exitEvent) {
      try { terminal.write('\u0003'); } catch {}
      await Promise.race([exit, sleep(1_500)]);
    }
    if (!exitEvent) {
      try { terminal.kill(); } catch {}
    }
  }
}

async function runGui() {
  log('GUI start');
  const child = spawn(guiPath, ['--allow-multiple-instances', '--disable-gpu', '--root', protectedRoot], {
    cwd: protectedRoot,
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    await sleep(4_000);
    assert(child.exitCode === null, `GUI exited during install-shape startup with ${child.exitCode}`);
  } finally {
    stopTree(child.pid);
    if (child.exitCode === null) {
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        sleep(15_000),
      ]);
    }
    log(`GUI cleanup exit=${child.exitCode === null ? 'timeout' : child.exitCode}`);
  }
}

async function main() {
  assert(process.platform === 'win32', 'Windows installed-shape gate requires win32');
  assert(fs.existsSync(exePath), `missing CLI/TUI executable: ${exePath}`);
  assert(fs.existsSync(guiPath), `missing GUI executable: ${guiPath}`);
  const before = snapshotWatchedPaths();
  const stateStarted = Date.now();
  const state = runState();
  state.elapsedMs = Date.now() - stateStarted;
  log(`CLI state root redirected in ${state.elapsedMs}ms`);
  assertWatchedPathsUnchanged(before);
  await runTui();
  assertWatchedPathsUnchanged(before);
  await runGui();
  assertWatchedPathsUnchanged(before);
  console.log(`SAFE_INSTALLED_SHAPE_STRESS_PASS cli=true tui=true gui=true rootRedirected=${state.root} stateMs=${state.elapsedMs} installMutablePathsUnchanged=true`);
}

main().then(
  () => process.exit(0),
  error => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  },
);
