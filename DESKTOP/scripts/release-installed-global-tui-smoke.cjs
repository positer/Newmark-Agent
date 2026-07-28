const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pty = require('node-pty');

const workspace = path.resolve(process.env.NEWMARK_GLOBAL_TUI_WORKSPACE || path.join(__dirname, '..', '..'));
const expectedRoot = path.resolve(process.env.NEWMARK_EXPECT_INSTALL_ROOT || '');
const located = spawnSync('where.exe', ['Newmark'], { encoding: 'utf8', windowsHide: true });
if (located.status !== 0) throw new Error(`global Newmark command was not found: ${located.stderr || located.stdout}`);
const command = String(located.stdout).split(/\r?\n/).map(item => item.trim()).find(item => /\.exe$/i.test(item));
if (!command) throw new Error(`global Newmark.exe was not resolved: ${located.stdout}`);
if (expectedRoot && path.relative(expectedRoot, command).startsWith('..')) {
  throw new Error(`global Newmark resolved outside the MSI installation: ${command}`);
}

const terminal = pty.spawn(command, ['--TUI'], {
  name: 'xterm-256color',
  cols: 110,
  rows: 34,
  cwd: workspace,
  env: { ...process.env, TERM: 'xterm-256color' },
  useConpty: true,
  useConptyDll: true,
});
let output = '';
let exited = false;
terminal.onData(chunk => { output += chunk; });
const exit = new Promise(resolve => terminal.onExit(event => {
  exited = true;
  resolve(event);
}));
const stripAnsi = value => String(value)
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '');

(async () => {
  const expectedWorkspace = path.basename(workspace);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const plain = stripAnsi(output);
    if (plain.includes('NEWMARK') && plain.includes('WORKSPACES') && plain.includes(expectedWorkspace)) break;
    if (exited) throw new Error(`installed TUI exited before startup: ${plain.slice(-2000)}`);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const plain = stripAnsi(output);
  if (!plain.includes('NEWMARK') || !plain.includes('WORKSPACES') || !plain.includes(expectedWorkspace)) {
    throw new Error(`installed TUI did not bind current workspace ${expectedWorkspace}: ${plain.slice(-2000)}`);
  }
  terminal.write('q');
  const event = await Promise.race([
    exit,
    new Promise(resolve => setTimeout(() => resolve({ exitCode: -999 }), 10_000)),
  ]);
  if (event.exitCode !== 0) throw new Error(`installed global TUI exited ${event.exitCode}`);
  process.stdout.write(`Installed global Newmark --TUI smoke passed: ${command} · workspace=${workspace}\n`);
})().then(
  () => process.exit(0),
  error => {
    try { terminal.kill(); } catch {}
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exit(1);
  },
);
