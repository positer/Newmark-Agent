import * as fs from 'fs';
import * as path from 'path';
import {
  detachTerminalTakeoverSession,
  onTerminalTakeoverEvent,
  resizeTerminalTakeoverSession,
  resetTerminalTakeoverForTests,
  ROOT_TERMINAL_ACTOR_ID,
  runTerminalTakeover,
  shutdownTerminalTakeoverSessions,
  terminalTakeoverState,
  terminalTakeoverWorkspaceId,
  writeTerminalTakeoverSession,
} from '../tools/terminalTakeover';

const testRoot = path.join(process.cwd(), 'test-tmp-terminal-takeover');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function parsed(value: string): any {
  return JSON.parse(value);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for terminal output');
}

async function main(): Promise<void> {
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.mkdirSync(testRoot, { recursive: true });
  const cwd = process.cwd();
  const workspaceId = terminalTakeoverWorkspaceId(cwd);
  assert(terminalTakeoverWorkspaceId('C:\\Users\\Example\\Repo') === terminalTakeoverWorkspaceId('/mnt/c/Users/Example/Repo'), 'Windows and WSL workspace paths share one stable id');
  const baseOwner = { backend: process.platform === 'win32' ? 'windows' : process.platform, workspaceId, conversationId: 'alpha' };
  const ownerA = { ...baseOwner, actorId: ROOT_TERMINAL_ACTOR_ID };
  const ownerB = { ...baseOwner, actorId: '11111111-1111-4111-8111-111111111111' };
  const events: string[] = [];
  const unsubscribe = onTerminalTakeoverEvent(event => events.push(`${event.type}:${event.session.actorId}:${event.session.name}`));
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const commandA = process.platform === 'win32' ? 'Write-Output actor-a' : 'printf "actor-a\\n"';
  const commandB = process.platform === 'win32' ? 'Write-Output actor-b' : 'printf "actor-b\\n"';
  const ttyCommand = process.platform === 'win32'
    ? 'Write-Output "TTY_MARKER:$(([Console]::IsInputRedirected).ToString().ToLowerInvariant()):$([Console]::WindowWidth):$([Console]::WindowHeight)"'
    : 'printf "TTY_MARKER:%s:%s:%s\\n" "$(test -t 0 && echo false || echo true)" "$(tput cols)" "$(tput lines)"';
  const interactiveSet = process.platform === 'win32' ? '$env:NEWMARK_PTY_STATE="same-session"' : 'export NEWMARK_PTY_STATE=same-session';
  const interactiveRead = process.platform === 'win32' ? 'Write-Output "PTY_STATE:$env:NEWMARK_PTY_STATE"' : 'printf "PTY_STATE:%s\\n" "$NEWMARK_PTY_STATE"';

  const startA = parsed(runTerminalTakeover({ action: 'start', name: 'shared', shell, cwd, owner: ownerA, persistenceRoot: testRoot, cols: 91, rows: 27 }));
  const startB = parsed(runTerminalTakeover({ action: 'start', name: 'shared', shell, cwd, owner: ownerB, persistenceRoot: testRoot }));
  assert(startA.takeover.id !== startB.takeover.id, 'same terminal name must isolate actors');
  assert(startA.takeover.id.length === 36 && startB.takeover.id.length === 36, 'terminal session ids must be full UUIDs');
  assert(startA.takeover.cols === 91 && startA.takeover.rows === 27, 'terminal start must preserve requested PTY geometry');
  assert(terminalTakeoverState(baseOwner, testRoot).filter(item => item.active).length === 2, 'conversation filter must see both actor sessions');
  assert(terminalTakeoverState(ownerA, testRoot).filter(item => item.active).length === 1, 'actor filter must isolate one session');

  assert(writeTerminalTakeoverSession(startA.takeover.id, commandA, ownerA).ok, 'owner A writes its terminal');
  assert(writeTerminalTakeoverSession(startB.takeover.id, commandB, ownerB).ok, 'owner B writes its terminal');
  assert(writeTerminalTakeoverSession(startA.takeover.id, ttyCommand, ownerA).ok, 'owner A probes the real PTY');
  assert(writeTerminalTakeoverSession(startA.takeover.id, interactiveSet, ownerA).ok, 'owner A sets state in the persistent PTY shell');
  assert(writeTerminalTakeoverSession(startA.takeover.id, interactiveRead, ownerA).ok, 'owner A reads state from the same PTY shell');
  assert(!writeTerminalTakeoverSession(startA.takeover.id, commandB, ownerB).ok, 'owner B cannot write owner A terminal');
  await waitFor(() => {
    const a = parsed(runTerminalTakeover({ action: 'read', name: 'shared', cwd, owner: ownerA, persistenceRoot: testRoot }));
    const b = parsed(runTerminalTakeover({ action: 'read', name: 'shared', cwd, owner: ownerB, persistenceRoot: testRoot }));
    return String(a.buffer).includes('actor-a')
      && String(a.buffer).includes('TTY_MARKER:false:91:27')
      && String(a.buffer).includes('PTY_STATE:same-session')
      && String(b.buffer).includes('actor-b');
  });

  const resized = resizeTerminalTakeoverSession(startA.takeover.id, 111, 35, ownerA);
  assert(resized.ok && resized.session?.cols === 111 && resized.session?.rows === 35, 'PTY resize updates the owner-scoped session');
  assert(events.some(event => event.startsWith('resized:')), 'PTY resize emits an event');
  assert(writeTerminalTakeoverSession(startA.takeover.id, ttyCommand, ownerA).ok, 'owner A probes resized PTY geometry');
  await waitFor(() => {
    const state = parsed(runTerminalTakeover({ action: 'read', name: 'shared', cwd, owner: ownerA, persistenceRoot: testRoot }));
    return String(state.buffer).includes('TTY_MARKER:false:111:35');
  });

  const stopCommand = process.platform === 'win32' ? 'exit' : 'exit';
  assert(writeTerminalTakeoverSession(startB.takeover.id, stopCommand, ownerB).ok, 'owner B exits its PTY cleanly');
  await waitFor(() => !terminalTakeoverState(ownerB, testRoot).find(item => item.id === startB.takeover.id)?.active);

  const detached = detachTerminalTakeoverSession(startA.takeover.id, ownerA);
  assert(detached.ok && detached.session?.active, 'detach keeps the shell active');
  assert(events.some(event => event.startsWith('detached:')), 'detach emits an event');
  const ended = shutdownTerminalTakeoverSessions('app-exit');
  assert(ended.length === 1 && ended.every(item => !item.active && item.stopReason === 'app-exit'), 'app exit terminates all remaining active terminals');
  assert(events.filter(event => event.startsWith('stopped:')).length === 2, 'app exit emits one stopped event per terminal');

  resetTerminalTakeoverForTests();
  const restored = terminalTakeoverState(baseOwner, testRoot);
  assert(restored.length === 2 && restored.every(item => !item.active), 'restart restores ended records without live shells');
  assert(restored.every(item => item.buffer.length <= 256 * 1024), 'persisted output tail remains bounded');
  const persistedPath = path.join(testRoot, 'Terminal', 'Takeover.json');
  assert(fs.existsSync(persistedPath) && JSON.parse(fs.readFileSync(persistedPath, 'utf-8')).version === 1, 'ended records persist atomically in versioned state');

  unsubscribe();
  resetTerminalTakeoverForTests();
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log('terminal takeover verification passed');

  // Electron keeps its app lifecycle alive after a standalone main-process
  // verification script; Node resolves this import to a package path string.
  const electron = require('electron') as { app?: { quit(): void } } | string;
  if (typeof electron !== 'string') electron.app?.quit();
}

main().catch(error => {
  try { resetTerminalTakeoverForTests(); } catch {}
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
});
