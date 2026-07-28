const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pty = require('node-pty');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const openSshRoot = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenSSH');
const sshPath = path.join(openSshRoot, 'ssh.exe');
const sshdPath = path.join(openSshRoot, 'sshd.exe');
const sshKeygenPath = path.join(openSshRoot, 'ssh-keygen.exe');
const privateKeyPath = path.join(os.homedir(), '.ssh', 'id_ed25519');
const publicKeyPath = `${privateKeyPath}.pub`;
const keepRoot = process.env.NEWMARK_KEEP_SSH_TUI_STRESS === '1';

function assert(condition, message) {
  if (!condition) throw new Error(`SSH TUI stress failed: ${message}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => process.stdout.write(`[ssh-tui-stress] ${message}\n`);
const psQuote = value => `'${String(value).replace(/'/g, "''")}'`;
const stripAnsi = value => String(value || '')
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '');

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForPort(port, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`temporary sshd exited ${child.exitCode}: ${stderr.value}`);
    const connected = await new Promise(resolve => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.setTimeout(300, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await sleep(100);
  }
  throw new Error(`temporary sshd did not listen on ${port}: ${stderr.value}`);
}

function createRemoteTuiWrapper(base) {
  const packagedExe = String(process.env.NEWMARK_SSH_TUI_EXE || '').trim();
  const wrapperPath = path.join(base, 'remote-tui.cmd');
  const command = packagedExe
    ? `${cmdQuote(path.resolve(packagedExe))} --TUI --demo`
    : `${cmdQuote(process.execPath)} ${cmdQuote(path.join(desktopRoot, 'dist', 'launcher.js'))} --TUI --demo`;
  fs.writeFileSync(wrapperPath, `@echo off\r\n${command}\r\n`, 'utf8');
  return wrapperPath.replace(/\\/g, '/');
}

function sshArgs(port, command) {
  return [
    '-tt',
    '-p', String(port),
    '-i', privateKeyPath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'LogLevel=ERROR',
    `${os.userInfo().username}@127.0.0.1`,
    ...String(command).trim().split(/\s+/),
  ];
}

function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function createSshWrapper(base, port, remoteCommand) {
  const wrapperPath = path.join(base, 'run-ssh-tui.cmd');
  const args = sshArgs(port, remoteCommand).map(cmdQuote).join(' ');
  fs.writeFileSync(wrapperPath, `@echo off\r\n${cmdQuote(sshPath)} ${args}\r\n`, 'utf8');
  return wrapperPath;
}

function runInteractiveSession(wrapperPath) {
  const terminal = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', wrapperPath], {
    name: 'xterm-256color',
    cols: 110,
    rows: 34,
    cwd: repoRoot,
    env: { ...process.env, TERM: 'xterm-256color' },
    useConpty: true,
    useConptyDll: true,
  });
  let output = '';
  let exited = false;
  let exitCode = null;
  terminal.onData(chunk => { output += chunk; });
  const exit = new Promise(resolve => {
    terminal.onExit(event => {
      exited = true;
      exitCode = event.exitCode;
      resolve(event);
    });
  });
  const waitFor = async (pattern, label, timeoutMs = 12_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const plain = stripAnsi(output);
      if (pattern.test(plain)) return plain;
      if (exited) throw new Error(`${label}: SSH PTY exited ${exitCode}; output=${plain.slice(-2500)}`);
      await sleep(80);
    }
    throw new Error(`${label}: timed out; output=${stripAnsi(output).slice(-2500)}`);
  };
  return { terminal, exit, waitFor, output: () => output, exited: () => exited };
}

async function stopSession(session) {
  if (!session.exited?.()) {
    try { session.terminal.write('q'); } catch {}
    await Promise.race([session.exit, sleep(1000)]);
  }
  if (!session.exited?.()) {
    try { session.terminal.write('\u0003'); } catch {}
    await Promise.race([session.exit, sleep(1000)]);
  }
  try { session.terminal.kill(); } catch {}
}

async function exerciseFullTui(wrapperPath) {
  const session = runInteractiveSession(wrapperPath);
  const { terminal, waitFor } = session;
  try {
    await waitFor(/NEWMARK[\s\S]*WORKSPACES/, 'initial full-screen TUI');
    log('initial full-screen TUI');

    terminal.write('\u001b[B');
    terminal.write('\r');
    await waitFor(/Conversations[\s\S]*Plan[\s\S]*Goal[\s\S]*Subagents[\s\S]*Model/, 'expanded workspace tracking menu');
    log('expanded workspace tracking menu');

    terminal.write('\u001b[B');
    terminal.write('\r');
    await waitFor(/Conversations[\s\S]*Select a conversation/, 'Conversation content view');
    log('Conversation content view');

    terminal.write('\r');
    await waitFor(/Type a message[\s\S]*Tab back/, 'Enter directly opens editor');
    terminal.write('ssh draft retained');
    terminal.write('\t');
    await waitFor(/draft preserved/, 'Tab returns to Conversation selection');
    terminal.write('\r');
    await waitFor(/ssh draft retained/, 'draft survives editor return');
    log('editor Enter/Tab/draft retention');

    terminal.write('\u001b[Z');
    await waitFor(/Plan mode/, 'Shift+Tab selects Plan');
    terminal.write('\u001b[Z');
    await waitFor(/Goal mode/, 'Shift+Tab selects Goal');
    terminal.write('\u001b[Z');
    await waitFor(/Flow mode requires a workflow/, 'Flow forces workflow selection');
    terminal.write('\u001b[B');
    terminal.write('\r');
    await waitFor(/Flow mode[\s\S]*conversation-recovery/, 'workflow selection completes');
    log('Shift+Tab and forced Flow selection');

    terminal.write('\t');
    terminal.write('t');
    await waitFor(/(pinned|unpinned)[\s\S]*selection followed/, 'Conversation pin follows reordered id');
    terminal.write('?');
    await waitFor(/Keyboard shortcuts/, 'quick shortcut help');
    terminal.write('?');
    await sleep(150);
    terminal.write('\t');
    await sleep(150);
    terminal.write('t');
    await waitFor(/Light terminal theme/, 'light theme toggle');
    const backgroundCodes = [...session.output().matchAll(/\u001b\[(48;[0-9;]+)m/g)].map(match => match[1]);
    assert(
      backgroundCodes.includes('48;2;240;242;248'),
      `light theme ANSI background was not emitted through SSH; backgrounds=${[...new Set(backgroundCodes)].join(',')}`,
    );
    log('pin, Help, and light theme');

    terminal.resize(140, 40);
    await sleep(250);
    assert(stripAnsi(session.output()).includes('NEWMARK'), 'TUI did not repaint after SSH PTY resize');

    terminal.write('q');
    const event = await Promise.race([
      session.exit,
      sleep(10_000).then(() => ({ exitCode: -999 })),
    ]);
    assert(event.exitCode === 0, `interactive SSH TUI exited ${event.exitCode}`);
    log('interactive session clean exit');
  } finally {
    await stopSession(session);
  }
}

async function runRestartStress(wrapperPath, rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    const session = runInteractiveSession(wrapperPath);
    try {
      await session.waitFor(/NEWMARK[\s\S]*WORKSPACES/, `restart ${index + 1} startup`);
      session.terminal.write('q');
      const event = await Promise.race([
        session.exit,
        sleep(10_000).then(() => ({ exitCode: -999 })),
      ]);
      assert(event.exitCode === 0, `restart ${index + 1} exited ${event.exitCode}`);
      log(`restart ${index + 1}/${rounds}`);
    } finally {
      await stopSession(session);
    }
  }
}

async function main() {
  for (const file of [sshPath, sshdPath, sshKeygenPath, privateKeyPath, publicKeyPath]) {
    assert(fs.existsSync(file), `required SSH asset is missing: ${file}`);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-ssh-tui-stress-'));
  const hostKey = path.join(base, 'ssh_host_ed25519_key');
  const authorizedKeys = path.join(base, 'authorized_keys');
  const configPath = path.join(base, 'sshd_config');
  const pidPath = path.join(base, 'sshd.pid');
  const port = await reservePort();
  const remoteCommand = createRemoteTuiWrapper(base);
  const wrapperPath = createSshWrapper(base, port, remoteCommand);
  const generated = spawnSync(sshKeygenPath, ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey], {
    windowsHide: true,
    encoding: 'utf8',
  });
  assert(generated.status === 0, `host-key generation failed: ${generated.stderr || generated.stdout}`);
  fs.copyFileSync(publicKeyPath, authorizedKeys);
  const slash = value => path.resolve(value).replace(/\\/g, '/');
  fs.writeFileSync(configPath, [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${slash(hostKey)}`,
    `PidFile ${slash(pidPath)}`,
    `AuthorizedKeysFile ${slash(authorizedKeys)}`,
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'StrictModes no',
    'PermitEmptyPasswords no',
    'AllowTcpForwarding no',
    'X11Forwarding no',
    'PermitTunnel no',
    'LogLevel VERBOSE',
  ].join('\n'), 'utf8');

  const stderr = { value: '' };
  const sshd = spawn(sshdPath, ['-D', '-e', '-f', configPath], {
    cwd: base,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  sshd.stderr.setEncoding('utf8');
  sshd.stderr.on('data', chunk => { stderr.value += chunk; });
  try {
    await waitForPort(port, sshd, stderr);
    log(`temporary loopback sshd listening on ${port}`);
    await exerciseFullTui(wrapperPath);
    await runRestartStress(wrapperPath);
    process.stdout.write('SSH TUI stress: real loopback sshd + PTY interaction + resize + light theme + 4 restart rounds passed\n');
  } finally {
    if (sshd.exitCode === null) sshd.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => sshd.once('exit', resolve)),
      sleep(1000),
    ]);
    if (sshd.exitCode === null) sshd.kill('SIGKILL');
    if (sshd.stderr) sshd.stderr.destroy();
    if (!keepRoot) fs.rmSync(base, { recursive: true, force: true });
    else process.stdout.write(`SSH TUI stress root retained: ${base}\n`);
  }
}

void main().then(
  () => process.exit(0),
  error => {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exit(1);
  },
);
