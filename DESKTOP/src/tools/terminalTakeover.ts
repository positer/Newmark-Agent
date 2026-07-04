import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as os from 'os';

export type TerminalTakeoverAction = 'start' | 'write' | 'read' | 'stop' | 'list';

export interface TerminalTakeoverState {
  id: string;
  name: string;
  shell: string;
  cwd: string;
  buffer: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TerminalTakeoverSession extends TerminalTakeoverState {
  proc: ChildProcess;
}

type TerminalTakeoverListener = (event: { type: 'started' | 'data' | 'stopped'; session: TerminalTakeoverState; data?: string }) => void;

const sessions = new Map<string, TerminalTakeoverSession>();
const listeners = new Set<TerminalTakeoverListener>();
const maxBuffer = 256 * 1024;

const shellMap: Record<string, string> = {
  powershell: 'powershell.exe',
  pwsh: 'pwsh.exe',
  cmd: 'cmd.exe',
  bash: process.platform === 'win32' ? 'bash.exe' : '/bin/bash',
  sh: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
};

function snapshot(session: TerminalTakeoverSession): TerminalTakeoverState {
  return {
    id: session.id,
    name: session.name,
    shell: session.shell,
    cwd: session.cwd,
    buffer: session.buffer,
    active: session.active,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function emit(type: 'started' | 'data' | 'stopped', session: TerminalTakeoverSession, data?: string): void {
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
  session.updatedAt = new Date().toISOString();
}

function normalizeName(name: string): string {
  return (name || 'agent').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agent';
}

function resolveShell(shell: string): { id: string; exe: string } {
  const id = (shell || (process.platform === 'win32' ? 'powershell' : 'bash')).toLowerCase();
  const fallback = process.platform === 'win32' ? 'powershell.exe' : (os.userInfo().shell || '/bin/sh');
  return { id, exe: shellMap[id] || fallback };
}

function findSession(nameOrId: string): TerminalTakeoverSession | null {
  const key = normalizeName(nameOrId || 'agent');
  return sessions.get(key) || Array.from(sessions.values()).find(s => s.id === nameOrId || s.name === key) || null;
}

function startSession(nameRaw: string, shellRaw: string, cwd: string): TerminalTakeoverSession {
  const name = normalizeName(nameRaw);
  const existing = sessions.get(name);
  if (existing && existing.active) return existing;

  const shell = resolveShell(shellRaw);
  const proc = spawn(shell.exe, [], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', NEWMARK_TERMINAL_TAKEOVER: name },
    windowsHide: true,
  });
  const now = new Date().toISOString();
  const session: TerminalTakeoverSession = {
    id: randomUUID().slice(0, 8),
    name,
    shell: shell.id,
    cwd,
    buffer: '',
    active: true,
    createdAt: now,
    updatedAt: now,
    proc,
  };
  sessions.set(name, session);

  proc.stdout?.on('data', chunk => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    appendBuffer(session, text);
    emit('data', session, text);
  });
  proc.stderr?.on('data', chunk => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    appendBuffer(session, text);
    emit('data', session, text);
  });
  proc.on('exit', code => {
    session.active = false;
    appendBuffer(session, `\n[terminal_takeover] exited code=${code ?? 'unknown'}\n`);
    emit('stopped', session);
  });

  proc.stdin?.write('\r\n');
  emit('started', session);
  return session;
}

export function onTerminalTakeoverEvent(listener: TerminalTakeoverListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function terminalTakeoverState(): TerminalTakeoverState[] {
  return Array.from(sessions.values()).map(snapshot);
}

export function writeTerminalTakeoverSession(idOrName: string, command: string): { ok: boolean; error?: string } {
  const session = findSession(idOrName);
  if (!session) return { ok: false, error: 'Session not found' };
  if (!session.active || !session.proc.stdin) return { ok: false, error: 'Session is not active' };
  session.proc.stdin.write(command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r\n`);
  session.updatedAt = new Date().toISOString();
  return { ok: true };
}

export function runTerminalTakeover(input: {
  action: TerminalTakeoverAction | string;
  name?: string;
  shell?: string;
  command?: string;
  cwd: string;
  maxChars?: number;
}): string {
  const action = String(input.action || 'read').toLowerCase() as TerminalTakeoverAction;
  const name = normalizeName(input.name || 'agent');
  const maxChars = Math.min(Math.max(Math.floor(Number(input.maxChars || 12000) || 12000), 1000), 50000);

  if (action === 'list') {
    const list = terminalTakeoverState().map(s => ({ id: s.id, name: s.name, shell: s.shell, cwd: s.cwd, active: s.active, updatedAt: s.updatedAt }));
    return JSON.stringify({ ok: true, sessions: list }, null, 2);
  }

  if (action === 'start') {
    const session = startSession(name, input.shell || '', input.cwd);
    return JSON.stringify({ ok: true, takeover: { id: session.id, name: session.name, shell: session.shell, cwd: session.cwd, active: session.active } }, null, 2);
  }

  const session = findSession(name);
  if (!session) return `[terminal_takeover] Session not found: ${name}. Use action=start first.`;

  if (action === 'write') {
    const command = String(input.command || '');
    if (!command.trim()) return '[terminal_takeover] command is required for write.';
    const result = writeTerminalTakeoverSession(session.name, command);
    if (!result.ok) return `[terminal_takeover] ${result.error || 'write failed'}: ${session.name}`;
    return `[terminal_takeover] wrote to ${session.name} (${session.id}). Use action=read to inspect output.`;
  }

  if (action === 'read') {
    const tail = session.buffer.length > maxChars ? session.buffer.slice(-maxChars) : session.buffer;
    return JSON.stringify({
      ok: true,
      takeover: { id: session.id, name: session.name, shell: session.shell, cwd: session.cwd, active: session.active, updatedAt: session.updatedAt },
      buffer: tail,
      truncated: session.buffer.length > maxChars,
    }, null, 2);
  }

  if (action === 'stop') {
    if (session.active) session.proc.kill('SIGINT');
    session.active = false;
    emit('stopped', session);
    return `[terminal_takeover] stopped ${session.name} (${session.id}).`;
  }

  return `[terminal_takeover] Unknown action: ${input.action}`;
}
