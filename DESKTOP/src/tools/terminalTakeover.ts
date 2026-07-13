import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';

export type TerminalTakeoverAction = 'start' | 'write' | 'read' | 'resize' | 'stop' | 'list' | 'detach';
export type TerminalTakeoverEventType = 'started' | 'data' | 'resized' | 'stopped' | 'detached';

export const ROOT_TERMINAL_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

export interface TerminalTakeoverOwner {
  backend: string;
  workspaceId: string;
  conversationId: string;
  actorId: string;
}

export type TerminalTakeoverOwnerFilter = Partial<TerminalTakeoverOwner>;

export interface TerminalTakeoverState extends TerminalTakeoverOwner {
  id: string;
  ownerKey: string;
  name: string;
  shell: string;
  cwd: string;
  buffer: string;
  active: boolean;
  cols: number;
  rows: number;
  createdAt: string;
  updatedAt: string;
  detachedAt?: string;
  stoppedAt?: string;
  stopReason?: string;
  exitCode?: number | null;
}

export interface TerminalTakeoverEvent {
  type: TerminalTakeoverEventType;
  session: TerminalTakeoverState;
  data?: string;
}

interface TerminalTakeoverSession extends TerminalTakeoverState {
  pty: TakeoverPty;
  newline: string;
  persistenceRoot: string;
  finished: boolean;
}

interface Disposable {
  dispose(): void;
}

interface TakeoverPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
}

interface WindowsNodePtyInternals {
  _agent?: {
    _conoutSocketWorker?: { dispose(): void };
  };
}

interface PersistedTerminalState {
  version: 1;
  updatedAt: string;
  records: TerminalTakeoverState[];
}

type TerminalTakeoverListener = (event: TerminalTakeoverEvent) => void;

const sessions = new Map<string, TerminalTakeoverSession>();
const listeners = new Set<TerminalTakeoverListener>();
const persistedByRoot = new Map<string, Map<string, TerminalTakeoverState>>();
const maxBuffer = 256 * 1024;
const maxPersistedRecords = 50;
const defaultCols = 120;
const defaultRows = 30;

function isoNow(): string {
  return new Date().toISOString();
}

function canonicalPersistenceRoot(root: string): string {
  const resolved = path.resolve(root || process.cwd());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function portableWorkspacePath(input: string): string {
  const raw = String(input || process.cwd()).trim().replace(/\\/g, '/');
  const wsl = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(raw);
  if (wsl) return `${wsl[1].toLowerCase()}:/${String(wsl[2] || '').replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '');
  const drive = /^([a-zA-Z]):(?:\/(.*))?$/.exec(raw);
  if (drive) return `${drive[1].toLowerCase()}:/${String(drive[2] || '').replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '');
  const resolved = path.resolve(raw).replace(/\\/g, '/').replace(/\/+$/g, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function terminalTakeoverWorkspaceId(workspacePath: string): string {
  return `workspace-${createHash('sha256').update(portableWorkspacePath(workspacePath)).digest('hex').slice(0, 24)}`;
}

function defaultBackend(): string {
  if (process.env.NEWMARK_WSL_DISTRO) return 'wsl';
  return process.platform === 'win32' ? 'windows' : process.platform;
}

export function normalizeTerminalTakeoverOwner(owner: TerminalTakeoverOwnerFilter | undefined, cwd: string): TerminalTakeoverOwner {
  return {
    backend: String(owner?.backend || defaultBackend()).trim().toLowerCase() || defaultBackend(),
    workspaceId: String(owner?.workspaceId || terminalTakeoverWorkspaceId(cwd)).trim() || terminalTakeoverWorkspaceId(cwd),
    conversationId: String(owner?.conversationId || 'default').trim() || 'default',
    actorId: String(owner?.actorId || ROOT_TERMINAL_ACTOR_ID).trim() || ROOT_TERMINAL_ACTOR_ID,
  };
}

export function terminalTakeoverOwnerKey(owner: TerminalTakeoverOwner, name: string): string {
  return [owner.backend, owner.workspaceId, owner.conversationId, owner.actorId, normalizeName(name)]
    .map(value => encodeURIComponent(value))
    .join('|');
}

function matchesOwner(state: TerminalTakeoverState, owner?: TerminalTakeoverOwnerFilter): boolean {
  if (!owner) return true;
  return (!owner.backend || state.backend === owner.backend)
    && (!owner.workspaceId || state.workspaceId === owner.workspaceId)
    && (!owner.conversationId || state.conversationId === owner.conversationId)
    && (!owner.actorId || state.actorId === owner.actorId);
}

function snapshot(session: TerminalTakeoverSession): TerminalTakeoverState {
  return {
    id: session.id,
    ownerKey: session.ownerKey,
    backend: session.backend,
    workspaceId: session.workspaceId,
    conversationId: session.conversationId,
    actorId: session.actorId,
    name: session.name,
    shell: session.shell,
    cwd: session.cwd,
    buffer: session.buffer,
    active: session.active,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    detachedAt: session.detachedAt,
    stoppedAt: session.stoppedAt,
    stopReason: session.stopReason,
    exitCode: session.exitCode,
  };
}

function emit(type: TerminalTakeoverEventType, session: TerminalTakeoverSession, data?: string): void {
  const state = snapshot(session);
  for (const listener of listeners) {
    try {
      listener({ type, session: state, data });
    } catch {
      // Listener failures must not break terminal sessions.
    }
  }
}

function appendBuffer(session: TerminalTakeoverSession, text: string): void {
  session.buffer += text;
  if (session.buffer.length > maxBuffer) session.buffer = session.buffer.slice(-maxBuffer);
  session.updatedAt = isoNow();
}

function normalizeName(name: string): string {
  return (name || 'agent').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agent';
}

function defaultShellId(): string {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function resolveShell(shell: string): { id: string; exe: string; args: string[]; newline: string } {
  const requested = String(shell || defaultShellId()).toLowerCase();
  if (process.platform === 'win32') {
    if (requested === 'cmd') return { id: 'cmd', exe: 'cmd.exe', args: [], newline: '\r' };
    if (requested === 'bash') return { id: 'bash', exe: 'bash.exe', args: [], newline: '\r' };
    if (requested === 'pwsh') return { id: 'pwsh', exe: 'pwsh.exe', args: [], newline: '\r' };
    return { id: 'powershell', exe: 'powershell.exe', args: [], newline: '\r' };
  }
  if (requested === 'sh') return { id: 'sh', exe: '/bin/sh', args: [], newline: '\r' };
  if (requested === 'pwsh') return { id: 'pwsh', exe: 'pwsh', args: [], newline: '\r' };
  return { id: 'bash', exe: process.env.SHELL || '/bin/bash', args: [], newline: '\r' };
}

function clampTerminalDimension(value: unknown, fallback: number, max: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(2, Math.min(max, parsed)) : fallback;
}

function requireNodePty(): typeof import('node-pty') {
  try {
    return require('node-pty') as typeof import('node-pty');
  } catch (error) {
    throw new Error(`node-pty is unavailable for ${process.platform}-${process.arch}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nodePtyHasConptyDll(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const packageJson = require.resolve('node-pty/package.json');
    const packageRoot = path.dirname(packageJson);
    return [
      path.join(packageRoot, 'build', 'Release', 'conpty', 'conpty.dll'),
      path.join(packageRoot, 'build', 'Debug', 'conpty', 'conpty.dll'),
      path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'conpty', 'conpty.dll'),
    ].some(candidate => fs.existsSync(candidate));
  } catch {
    return false;
  }
}

const wslPtyHelper = String.raw`
import base64, errno, fcntl, json, os, selectors, signal, struct, sys, termios

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()

def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

exe = sys.argv[1]
argv = sys.argv[1:]
cols = int(os.environ.get('NEWMARK_PTY_COLS', '120'))
rows = int(os.environ.get('NEWMARK_PTY_ROWS', '30'))
pid, master = os.forkpty()
if pid == 0:
    os.execvpe(exe, argv, os.environ)

resize(master, cols, rows)
os.set_blocking(master, False)
os.set_blocking(sys.stdin.fileno(), False)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ, 'pty')
selector.register(sys.stdin, selectors.EVENT_READ, 'control')
emit({'event': 'ready', 'pid': pid})
control = b''
running = True
while running:
    for key, _ in selector.select(0.1):
        if key.data == 'pty':
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    data = b''
                else:
                    raise
            if data:
                emit({'event': 'data', 'data': base64.b64encode(data).decode('ascii')})
            else:
                running = False
        else:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                running = False
                continue
            control += chunk
            while b'\n' in control:
                line, control = control.split(b'\n', 1)
                if not line:
                    continue
                request = json.loads(line.decode('utf-8'))
                action = request.get('action')
                if action == 'write':
                    os.write(master, base64.b64decode(request.get('data', '')))
                elif action == 'resize':
                    resize(master, int(request['cols']), int(request['rows']))
                elif action == 'kill':
                    try:
                        os.kill(pid, getattr(signal, request.get('signal', 'SIGTERM')))
                    except ProcessLookupError:
                        pass

try:
    _, status = os.waitpid(pid, 0)
    exit_code = os.waitstatus_to_exitcode(status)
except ChildProcessError:
    exit_code = 0
emit({'event': 'exit', 'exitCode': exit_code})
`;

function spawnWslPty(shell: { exe: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv, cols: number, rows: number): TakeoverPty {
  const proc = spawn('python3', ['-u', '-c', wslPtyHelper, shell.exe, ...shell.args], {
    cwd,
    env: { ...env, NEWMARK_PTY_COLS: String(cols), NEWMARK_PTY_ROWS: String(rows) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let currentCols = cols;
  let currentRows = rows;
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  let exited = false;
  let stdoutBuffer = '';
  const emitData = (data: string): void => { for (const listener of dataListeners) listener(data); };
  const emitExit = (exitCode: number | null, signal?: NodeJS.Signals | null): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ exitCode: exitCode ?? 0, signal: signal ? 1 : undefined });
  };
  const handleMessage = (message: Record<string, unknown>): void => {
    if (message.event === 'data') emitData(Buffer.from(String(message.data || ''), 'base64').toString('utf-8'));
    if (message.event === 'exit') emitExit(Number(message.exitCode || 0));
  };
  proc.stdout.on('data', chunk => {
    stdoutBuffer += String(chunk || '');
    while (stdoutBuffer.includes('\n')) {
      const index = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      try { handleMessage(JSON.parse(line) as Record<string, unknown>); } catch {}
    }
  });
  proc.stderr.on('data', chunk => emitData(`\n[terminal_takeover] WSL PTY helper: ${String(chunk || '')}`));
  proc.once('error', error => {
    emitData(`\n[terminal_takeover] WSL PTY helper error: ${error.message}\n`);
    emitExit(1);
  });
  proc.once('exit', emitExit);
  const send = (message: Record<string, unknown>): void => {
    if (!proc.stdin.writable) throw new Error('WSL PTY helper is not writable');
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };
  return {
    get pid() { return proc.pid || 0; },
    get cols() { return currentCols; },
    get rows() { return currentRows; },
    write(data) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
      send({ action: 'write', data: bytes.toString('base64') });
    },
    resize(nextCols, nextRows) {
      currentCols = nextCols;
      currentRows = nextRows;
      send({ action: 'resize', cols: currentCols, rows: currentRows });
    },
    kill(signal) {
      if (proc.killed) return;
      try { send({ action: 'kill', signal: signal || 'SIGTERM' }); } catch {}
      setTimeout(() => { if (!proc.killed) proc.kill(); }, 500).unref();
    },
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
  };
}

function spawnTakeoverPty(shell: { exe: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv, cols: number, rows: number): TakeoverPty {
  if (process.platform !== 'win32' && process.env.NEWMARK_WSL_DISTRO) return spawnWslPty(shell, cwd, env, cols, rows);
  const nodePty = requireNodePty();
  const options: import('node-pty').IPtyForkOptions | import('node-pty').IWindowsPtyForkOptions = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    useConpty: process.platform === 'win32',
    // Prefer the bundled OpenConsole path when its DLL is present; after an
    // Electron ABI rebuild without postinstall assets, fall back to native
    // Windows ConPTY instead of failing terminal startup.
    useConptyDll: nodePtyHasConptyDll(),
  };
  const pty = nodePty.spawn(shell.exe, shell.args, options);
  if (process.platform !== 'win32') return pty;

  // node-pty 1.1.0 can leave the ConPTY DLL output worker alive when no final
  // data packet arrives after exit. Dispose that worker at the PTY boundary.
  const internals = pty as typeof pty & WindowsNodePtyInternals;
  let workerDisposed = false;
  const disposeOutputWorker = (): void => {
    if (workerDisposed) return;
    workerDisposed = true;
    try { internals._agent?._conoutSocketWorker?.dispose(); } catch {}
  };
  const originalKill = pty.kill.bind(pty);
  return {
    get pid() { return pty.pid; },
    get cols() { return pty.cols; },
    get rows() { return pty.rows; },
    write(data) {
      pty.write(Buffer.isBuffer(data) ? data.toString('utf-8') : data);
    },
    resize(nextCols, nextRows) {
      pty.resize(nextCols, nextRows);
    },
    kill(signal) {
      try {
        originalKill(signal);
      } finally {
        setTimeout(disposeOutputWorker, 50).unref();
      }
    },
    onData(listener) {
      return pty.onData(listener);
    },
    onExit(listener) {
      return pty.onExit(event => {
        listener(event);
        disposeOutputWorker();
      });
    },
  };
}

function persistencePath(root: string): string {
  return path.join(root, 'Terminal', 'Takeover.json');
}

function validPersistedRecord(input: unknown): TerminalTakeoverState | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const id = String(raw.id || '').trim();
  const name = normalizeName(String(raw.name || 'agent'));
  if (!id) return null;
  const owner = normalizeTerminalTakeoverOwner({
    backend: String(raw.backend || ''),
    workspaceId: String(raw.workspaceId || ''),
    conversationId: String(raw.conversationId || ''),
    actorId: String(raw.actorId || ''),
  }, String(raw.cwd || process.cwd()));
  const createdAt = String(raw.createdAt || raw.updatedAt || isoNow());
  const updatedAt = String(raw.updatedAt || createdAt);
  return {
    id,
    ownerKey: String(raw.ownerKey || terminalTakeoverOwnerKey(owner, name)),
    ...owner,
    name,
    shell: String(raw.shell || defaultShellId()),
    cwd: String(raw.cwd || process.cwd()),
    buffer: String(raw.buffer || '').slice(-maxBuffer),
    active: false,
    cols: clampTerminalDimension(raw.cols, defaultCols, 500),
    rows: clampTerminalDimension(raw.rows, defaultRows, 200),
    createdAt,
    updatedAt,
    detachedAt: raw.detachedAt ? String(raw.detachedAt) : undefined,
    stoppedAt: String(raw.stoppedAt || updatedAt),
    stopReason: String(raw.stopReason || 'ended'),
    exitCode: raw.exitCode === null || Number.isFinite(Number(raw.exitCode)) ? (raw.exitCode === null ? null : Number(raw.exitCode)) : undefined,
  };
}

function ensurePersistenceLoaded(rootRaw: string): Map<string, TerminalTakeoverState> {
  const root = canonicalPersistenceRoot(rootRaw);
  const loaded = persistedByRoot.get(root);
  if (loaded) return loaded;
  const records = new Map<string, TerminalTakeoverState>();
  try {
    const parsed = JSON.parse(fs.readFileSync(persistencePath(root), 'utf-8')) as Partial<PersistedTerminalState>;
    if (Array.isArray(parsed.records)) {
      for (const input of parsed.records) {
        const record = validPersistedRecord(input);
        if (record) records.set(record.id, record);
      }
    }
  } catch {
    // A missing or damaged history file must not prevent a new terminal session.
  }
  persistedByRoot.set(root, records);
  return records;
}

function persistEndedRecords(rootRaw: string): void {
  const root = canonicalPersistenceRoot(rootRaw);
  const records = Array.from(ensurePersistenceLoaded(root).values())
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, maxPersistedRecords);
  const output: PersistedTerminalState = { version: 1, updatedAt: isoNow(), records };
  const filePath = persistencePath(root);
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(tempPath, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(output, null, 2), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

function rememberEnded(session: TerminalTakeoverSession): void {
  const records = ensurePersistenceLoaded(session.persistenceRoot);
  records.set(session.id, snapshot(session));
  persistEndedRecords(session.persistenceRoot);
}

function finishSession(session: TerminalTakeoverSession, reason: string, exitCode?: number | null): void {
  if (session.finished) return;
  session.finished = true;
  session.active = false;
  session.stopReason = reason;
  session.exitCode = exitCode;
  session.stoppedAt = isoNow();
  appendBuffer(session, `\n[terminal_takeover] stopped reason=${reason}${exitCode === undefined ? '' : ` code=${exitCode ?? 'unknown'}`}\n`);
  try { rememberEnded(session); } catch {}
  emit('stopped', session);
}

function findSession(nameOrId: string, owner?: TerminalTakeoverOwnerFilter): TerminalTakeoverSession | null {
  const raw = String(nameOrId || 'agent');
  for (const session of sessions.values()) {
    if (session.id === raw && matchesOwner(session, owner)) return session;
  }
  const name = normalizeName(raw);
  const candidates = Array.from(sessions.values())
    .filter(session => session.name === name && matchesOwner(session, owner))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return candidates[0] || null;
}

function findState(nameOrId: string, owner: TerminalTakeoverOwnerFilter | undefined, persistenceRoot: string): TerminalTakeoverState | null {
  const session = findSession(nameOrId, owner);
  if (session) return snapshot(session);
  const raw = String(nameOrId || 'agent');
  const name = normalizeName(raw);
  const candidates = Array.from(ensurePersistenceLoaded(persistenceRoot).values())
    .filter(record => (record.id === raw || record.name === name) && matchesOwner(record, owner))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return candidates[0] || null;
}

function startSession(
  nameRaw: string,
  shellRaw: string,
  cwd: string,
  ownerInput: TerminalTakeoverOwnerFilter | undefined,
  persistenceRootRaw: string,
  colsRaw?: number,
  rowsRaw?: number,
): TerminalTakeoverSession {
  const name = normalizeName(nameRaw);
  const owner = normalizeTerminalTakeoverOwner(ownerInput, cwd);
  const ownerKey = terminalTakeoverOwnerKey(owner, name);
  const existing = sessions.get(ownerKey);
  if (existing?.active) return existing;

  const shell = resolveShell(shellRaw);
  const cols = clampTerminalDimension(colsRaw, defaultCols, 500);
  const rows = clampTerminalDimension(rowsRaw, defaultRows, 200);
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    NEWMARK_TERMINAL_TAKEOVER: name,
    NEWMARK_TERMINAL_CONVERSATION_ID: owner.conversationId,
    NEWMARK_TERMINAL_ACTOR_ID: owner.actorId,
  };
  const pty = spawnTakeoverPty(shell, cwd, env, cols, rows);
  const now = isoNow();
  const session: TerminalTakeoverSession = {
    id: randomUUID(),
    ownerKey,
    ...owner,
    name,
    shell: shell.id,
    cwd,
    buffer: '',
    active: true,
    cols,
    rows,
    createdAt: now,
    updatedAt: now,
    pty,
    newline: shell.newline,
    persistenceRoot: canonicalPersistenceRoot(persistenceRootRaw),
    finished: false,
  };
  sessions.set(ownerKey, session);

  pty.onData(text => {
    appendBuffer(session, text);
    emit('data', session, text);
  });
  pty.onExit(event => {
    finishSession(session, 'process-exit', event.exitCode);
    try { rememberEnded(session); } catch {}
  });

  emit('started', session);
  return session;
}

export function onTerminalTakeoverEvent(listener: TerminalTakeoverListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function terminalTakeoverState(owner?: TerminalTakeoverOwnerFilter, persistenceRoot = process.cwd()): TerminalTakeoverState[] {
  const combined = new Map<string, TerminalTakeoverState>();
  for (const record of ensurePersistenceLoaded(persistenceRoot).values()) {
    if (matchesOwner(record, owner)) combined.set(record.id, record);
  }
  for (const session of sessions.values()) {
    if (matchesOwner(session, owner)) combined.set(session.id, snapshot(session));
  }
  return Array.from(combined.values()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function writeTerminalTakeoverSession(
  idOrName: string,
  command: string,
  owner?: TerminalTakeoverOwnerFilter,
): { ok: boolean; error?: string } {
  const session = findSession(idOrName, owner);
  if (!session) return { ok: false, error: 'Session not found for this owner' };
  if (!session.active) return { ok: false, error: 'Session is not active' };
  session.pty.write(command.endsWith('\n') || command.endsWith('\r') ? command : `${command}${session.newline}`);
  session.updatedAt = isoNow();
  return { ok: true };
}

export function resizeTerminalTakeoverSession(
  idOrName: string,
  colsRaw: number,
  rowsRaw: number,
  owner?: TerminalTakeoverOwnerFilter,
): { ok: boolean; error?: string; session?: TerminalTakeoverState } {
  const session = findSession(idOrName, owner);
  if (!session) return { ok: false, error: 'Session not found for this owner' };
  if (!session.active) return { ok: false, error: 'Session is not active' };
  const cols = clampTerminalDimension(colsRaw, session.cols, 500);
  const rows = clampTerminalDimension(rowsRaw, session.rows, 200);
  try {
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    session.updatedAt = isoNow();
    emit('resized', session);
    return { ok: true, session: snapshot(session) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function stopTerminalTakeoverSession(
  idOrName: string,
  owner?: TerminalTakeoverOwnerFilter,
  reason = 'requested',
): { ok: boolean; error?: string; session?: TerminalTakeoverState } {
  const session = findSession(idOrName, owner);
  if (!session) return { ok: false, error: 'Session not found for this owner' };
  if (session.active) {
    try { session.pty.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); } catch {}
    finishSession(session, reason);
  }
  return { ok: true, session: snapshot(session) };
}

export function detachTerminalTakeoverSession(
  idOrName: string,
  owner?: TerminalTakeoverOwnerFilter,
): { ok: boolean; error?: string; session?: TerminalTakeoverState } {
  const session = findSession(idOrName, owner);
  if (!session) return { ok: false, error: 'Session not found for this owner' };
  session.detachedAt = isoNow();
  session.updatedAt = session.detachedAt;
  emit('detached', session);
  return { ok: true, session: snapshot(session) };
}

export function shutdownTerminalTakeoverSessions(reason = 'app-exit'): TerminalTakeoverState[] {
  const stopped: TerminalTakeoverState[] = [];
  for (const session of sessions.values()) {
    if (!session.active) continue;
    try { session.pty.kill(); } catch {}
    finishSession(session, reason);
    stopped.push(snapshot(session));
  }
  return stopped;
}

export function resetTerminalTakeoverForTests(): void {
  shutdownTerminalTakeoverSessions('test-reset');
  sessions.clear();
  listeners.clear();
  persistedByRoot.clear();
}

export function runTerminalTakeover(input: {
  action: TerminalTakeoverAction | string;
  name?: string;
  shell?: string;
  command?: string;
  cwd: string;
  maxChars?: number;
  cols?: number;
  rows?: number;
  owner?: TerminalTakeoverOwnerFilter;
  persistenceRoot?: string;
}): string {
  const action = String(input.action || 'read').toLowerCase() as TerminalTakeoverAction;
  const name = normalizeName(input.name || 'agent');
  const maxChars = Math.min(Math.max(Math.floor(Number(input.maxChars || 12000) || 12000), 1000), 50000);
  const persistenceRoot = input.persistenceRoot || process.cwd();
  const owner = normalizeTerminalTakeoverOwner(input.owner, input.cwd);

  if (action === 'list') {
    const list = terminalTakeoverState(owner, persistenceRoot).map(state => ({
      id: state.id,
      name: state.name,
      backend: state.backend,
      workspaceId: state.workspaceId,
      conversationId: state.conversationId,
      actorId: state.actorId,
      shell: state.shell,
      cwd: state.cwd,
      active: state.active,
      cols: state.cols,
      rows: state.rows,
      updatedAt: state.updatedAt,
    }));
    return JSON.stringify({ ok: true, sessions: list }, null, 2);
  }

  if (action === 'start') {
    const session = startSession(name, input.shell || '', input.cwd, owner, persistenceRoot, input.cols, input.rows);
    return JSON.stringify({ ok: true, takeover: snapshot(session) }, null, 2);
  }

  const state = findState(name, owner, persistenceRoot);
  if (!state) return `[terminal_takeover] Session not found for this owner: ${name}. Use action=start first.`;

  if (action === 'write') {
    const command = String(input.command || '');
    if (!command.trim()) return '[terminal_takeover] command is required for write.';
    const result = writeTerminalTakeoverSession(state.id, command, owner);
    if (!result.ok) return `[terminal_takeover] ${result.error || 'write failed'}: ${state.name}`;
    return `[terminal_takeover] wrote to ${state.name} (${state.id}). Use action=read to inspect output.`;
  }

  if (action === 'read') {
    const latest = findState(state.id, owner, persistenceRoot) || state;
    const tail = latest.buffer.length > maxChars ? latest.buffer.slice(-maxChars) : latest.buffer;
    return JSON.stringify({
      ok: true,
      takeover: { ...latest, buffer: undefined },
      buffer: tail,
      truncated: latest.buffer.length > maxChars,
    }, null, 2);
  }

  if (action === 'resize') {
    const result = resizeTerminalTakeoverSession(state.id, Number(input.cols), Number(input.rows), owner);
    if (!result.ok) return `[terminal_takeover] ${result.error || 'resize failed'}: ${state.name}`;
    return JSON.stringify({ ok: true, takeover: result.session }, null, 2);
  }

  if (action === 'stop') {
    const result = stopTerminalTakeoverSession(state.id, owner);
    if (!result.ok) return `[terminal_takeover] ${result.error || 'stop failed'}: ${state.name}`;
    return `[terminal_takeover] stopped ${state.name} (${state.id}).`;
  }

  if (action === 'detach') {
    const result = detachTerminalTakeoverSession(state.id, owner);
    if (!result.ok) return `[terminal_takeover] ${result.error || 'detach failed'}: ${state.name}`;
    return `[terminal_takeover] detached ${state.name} (${state.id}); the shell remains active.`;
  }

  return `[terminal_takeover] Unknown action: ${input.action}`;
}
