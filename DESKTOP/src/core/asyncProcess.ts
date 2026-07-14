import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface AsyncProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  windowsHide?: boolean;
}

export interface AsyncProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  aborted: boolean;
  timedOut: boolean;
  overflowed: boolean;
}

type StopReason = 'abort' | 'timeout' | 'maxBuffer';

// Tree termination is best-effort background cleanup. In particular, a cold
// taskkill.exe or delayed stdio close on Windows must not hold the worker IPC
// response indefinitely after cancellation has already been requested.
const STOP_SETTLEMENT_WATCHDOG_MS = 500;

function signalMessage(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (reason !== undefined && String(reason)) return String(reason);
  return 'The operation was aborted';
}

function stopProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try { child.kill('SIGKILL'); } catch {}
    return;
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        try { child.kill('SIGKILL'); } catch {}
      });
      killer.unref();
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
  const forceTimer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, 250);
  forceTimer.unref?.();
}

export function runAsyncProcess(command: string, args: string[], options: AsyncProcessOptions = {}): Promise<AsyncProcessResult> {
  const maxBuffer = Number.isFinite(options.maxBuffer) && Number(options.maxBuffer) > 0
    ? Math.floor(Number(options.maxBuffer))
    : 1024 * 1024;
  if (options.signal?.aborted) {
    return Promise.resolve({
      status: null,
      stdout: '',
      stderr: '',
      error: signalMessage(options.signal),
      aborted: true,
      timedOut: false,
      overflowed: false,
    });
  }

  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: options.windowsHide !== false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        status: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
        aborted: false,
        timedOut: false,
        overflowed: false,
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stopReason: StopReason | null = null;
    let spawnError = '';
    let settled = false;
    let exitStatus: number | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let stopSettlementWatchdog: NodeJS.Timeout | null = null;

    const settle = (status: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (stopSettlementWatchdog) clearTimeout(stopSettlementWatchdog);
      options.signal?.removeEventListener('abort', abortListener);
      const error = spawnError
        || (stopReason === 'abort' ? signalMessage(options.signal) : '')
        || (stopReason === 'timeout' ? `Timed out after ${timeoutMs} ms` : '')
        || (stopReason === 'maxBuffer' ? `Output exceeded ${maxBuffer} byte limit` : '');
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error: error || undefined,
        aborted: stopReason === 'abort',
        timedOut: stopReason === 'timeout',
        overflowed: stopReason === 'maxBuffer',
      });
    };

    const requestStop = (reason: StopReason): void => {
      if (stopReason || settled) return;
      stopReason = reason;
      // Arm this before CreateProcess(taskkill.exe): even if launching the
      // helper is cold, the already-expired timer settles on the next event-loop
      // turn. taskkill remains detached from the result and continues cleanup.
      stopSettlementWatchdog = setTimeout(() => settle(exitStatus ?? child.exitCode), STOP_SETTLEMENT_WATCHDOG_MS);
      stopProcessTree(child);
    };

    const append = (chunks: Buffer[], stream: 'stdout' | 'stderr', value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const available = Math.max(0, maxBuffer - used);
      if (available > 0) chunks.push(chunk.subarray(0, available));
      if (stream === 'stdout') stdoutBytes += Math.min(chunk.length, available);
      else stderrBytes += Math.min(chunk.length, available);
      if (chunk.length > available) requestStop('maxBuffer');
    };

    child.stdout?.on('data', chunk => append(stdout, 'stdout', chunk));
    child.stderr?.on('data', chunk => append(stderr, 'stderr', chunk));
    child.once('error', error => { spawnError = error.message; });
    child.once('exit', status => {
      exitStatus = typeof status === 'number' ? status : null;
      if (stopReason) settle(exitStatus);
    });
    child.once('close', status => settle(typeof status === 'number' ? status : exitStatus));

    function abortListener(): void {
      requestStop('abort');
    }
    options.signal?.addEventListener('abort', abortListener, { once: true });
    if (options.signal?.aborted) abortListener();

    const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : 0;
    timeout = timeoutMs > 0
      ? setTimeout(() => {
          requestStop('timeout');
        }, timeoutMs)
      : null;
  });
}

/**
 * Runs a Windows batch launcher without interpolating caller arguments into a cmd command line.
 * Resolves an npm-generated `.cmd` shim to its real Node entrypoint. The model's argv then goes
 * directly through `spawn(node, argv)` and never crosses cmd/PowerShell text parsing.
 */
export async function runAsyncWindowsBatch(command: string, args: string[], options: AsyncProcessOptions = {}): Promise<AsyncProcessResult> {
  if (process.platform !== 'win32') return runAsyncProcess(command, args, options);
  const batchPath = await resolveWindowsLauncher(command);
  const target = batchPath ? await resolveNpmBatchTarget(batchPath) : null;
  if (!target) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: `Safe npm Node entrypoint was not found for ${command}`,
      aborted: false,
      timedOut: false,
      overflowed: false,
    };
  }
  return await runAsyncProcess(target.nodePath, [target.scriptPath, ...args], options);
}

async function accessible(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveWindowsLauncher(command: string): Promise<string> {
  const clean = String(command || '').trim();
  if (!clean) return '';
  if (path.isAbsolute(clean) || /[\\/]/.test(clean)) {
    const absolute = path.resolve(clean);
    return await accessible(absolute) ? absolute : '';
  }
  for (const entry of String(process.env.PATH || '').split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    const candidate = path.join(directory, clean);
    if (await accessible(candidate)) return candidate;
  }
  return '';
}

async function resolveNpmBatchTarget(batchPath: string): Promise<{ nodePath: string; scriptPath: string } | null> {
  let source = '';
  try { source = await fs.readFile(batchPath, 'utf8'); } catch { return null; }
  const directory = path.dirname(batchPath);
  let relativeScript = '';
  const direct = /(?:%~dp0|%dp0%)\\?([^"\r\n]+)"\s+%\*/i.exec(source);
  if (direct) relativeScript = direct[1];
  if (!relativeScript) {
    const finalVariables = /"%[A-Z0-9_]+%"\s+"%([A-Z0-9_]+)%"\s+%\*/i.exec(source);
    const scriptVariable = finalVariables?.[1] || '';
    if (scriptVariable) {
      const escaped = scriptVariable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const assignment = new RegExp(`SET\\s+"?${escaped}=(?:%~dp0|%dp0%)\\\\?([^"\\r\\n]+)`, 'i').exec(source);
      if (assignment) relativeScript = assignment[1];
    }
  }
  if (!relativeScript) return null;
  const scriptPath = path.resolve(directory, relativeScript.replace(/\\/g, path.sep));
  const directoryPrefix = `${path.resolve(directory).toLowerCase()}${path.sep}`;
  if (!scriptPath.toLowerCase().startsWith(directoryPrefix) || !await accessible(scriptPath)) return null;
  const siblingNode = path.join(directory, 'node.exe');
  const nodePath = await accessible(siblingNode)
    ? siblingNode
    : await resolveWindowsLauncher('node.exe') || await resolveWindowsLauncher('node');
  return nodePath ? { nodePath, scriptPath } : null;
}
