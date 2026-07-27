import * as path from 'path';
import { createRequire } from 'module';
import type { Bash as BashInstance } from 'just-bash';
import { runAsyncProcess } from './asyncProcess';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const interpreterBuiltins = new Set([
  '.', '[', 'alias', 'break', 'builtin', 'cd', 'command', 'continue', 'declare',
  'echo', 'eval', 'exec', 'export', 'false', 'getopts', 'hash', 'help', 'history',
  'jobs', 'kill', 'local', 'mapfile', 'printf', 'pwd', 'read', 'readarray',
  'readonly', 'return', 'set', 'shift', 'source', 'test', 'times', 'trap', 'true',
  'type', 'typeset', 'umask', 'unalias', 'unset', 'wait',
]);
type JustBashModule = typeof import('just-bash');
let justBashModule: JustBashModule | null | undefined;

function loadJustBash(): JustBashModule | null {
  if (justBashModule !== undefined) return justBashModule;
  try {
    // Keep just-bash out of single-file WSL/utility bundles. The desktop app
    // resolves the installed package; isolated hosts retain host-shell fallback.
    const runtimeRequire = createRequire(__filename);
    justBashModule = runtimeRequire('just-bash') as JustBashModule;
  } catch {
    justBashModule = null;
  }
  return justBashModule;
}

export interface NativeBashPlan {
  engine: 'native' | 'host';
  commands: string[];
  unsupportedCommands: string[];
}

export interface WorkspaceShellResult {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  engine: 'native-bash' | 'host-shell';
  error?: string;
  timedOut?: boolean;
  aborted?: boolean;
  cwd?: string;
}

export interface WorkspaceBashOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  allowHostFallback?: boolean;
}

function collectCommands(script: string): string[] {
  const justBash = loadJustBash();
  if (!justBash) throw new Error('Native Bash runtime unavailable');
  const pipeline = new justBash.BashTransformPipeline().use(new justBash.CommandCollectorPlugin());
  const result = pipeline.transform(script);
  const commands = result.metadata?.commands;
  return Array.isArray(commands) ? commands.map(command => String(command)) : [];
}

export function planNativeBash(script: string): NativeBashPlan {
  try {
    const justBash = loadJustBash();
    if (!justBash) return { engine: 'host', commands: [], unsupportedCommands: ['native-runtime'] };
    const nativeCommands = new Set([...justBash.getCommandNames(), ...interpreterBuiltins]);
    const commands = collectCommands(script);
    const unsupportedCommands = [...new Set(commands.filter(command => !nativeCommands.has(command)))];
    return {
      engine: unsupportedCommands.length === 0 ? 'native' : 'host',
      commands,
      unsupportedCommands,
    };
  } catch {
    // Let the native parser produce the useful syntax error for malformed Bash.
    return { engine: 'native', commands: [], unsupportedCommands: [] };
  }
}

function normalizedTimeout(timeoutMs?: number): number {
  const parsed = Number(timeoutMs);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

function virtualCwd(workspaceRoot: string, requestedCwd?: string): string {
  if (!requestedCwd) return '/';
  const root = path.resolve(workspaceRoot);
  const cwd = path.resolve(requestedCwd);
  const relative = path.relative(root, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '/';
  return relative ? `/${relative.split(path.sep).join('/')}` : '/';
}

function combineAbortSignals(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error(`Bash timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function createBash(workspaceRoot: string, timeoutMs: number): BashInstance {
  const justBash = loadJustBash();
  if (!justBash) throw new Error('Native Bash runtime unavailable');
  const fs = new justBash.ReadWriteFs({
    root: path.resolve(workspaceRoot),
    maxFileReadSize: MAX_OUTPUT_BYTES * 8,
    allowSymlinks: false,
  });
  return new justBash.Bash({
    fs,
    cwd: '/',
    env: {
      HOME: '/',
      PWD: '/',
      TERM: 'xterm-256color',
      LANG: process.env.LANG || 'C.UTF-8',
    },
    executionLimits: {
      maxExecutionTimeMs: timeoutMs,
      maxOutputSize: MAX_OUTPUT_BYTES,
      maxSourceBytes: 4 * 1024 * 1024,
    },
  });
}

async function executeNative(
  bash: BashInstance,
  script: string,
  cwd: string,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<WorkspaceShellResult> {
  const abort = combineAbortSignals(parentSignal, timeoutMs);
  try {
    const result = await bash.exec(script, { cwd, signal: abort.signal });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const timedOut = abort.timedOut();
    const aborted = abort.signal.aborted && !timedOut;
    return {
      output,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode,
      engine: 'native-bash',
      error: timedOut
        ? `Bash timed out after ${timeoutMs}ms`
        : aborted
          ? 'Bash execution was aborted'
          : result.exitCode === 0 ? undefined : (result.stderr.trim() || `Bash exited ${result.exitCode}`),
      timedOut,
      aborted,
      cwd: result.env?.PWD || cwd,
    };
  } catch (error) {
    const timedOut = abort.timedOut();
    const aborted = abort.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    return {
      output: '',
      stdout: '',
      stderr: '',
      exitCode: timedOut ? 124 : aborted ? 130 : 1,
      engine: 'native-bash',
      error: timedOut ? `Bash timed out after ${timeoutMs}ms` : message,
      timedOut,
      aborted: aborted && !timedOut,
      cwd,
    };
  } finally {
    abort.dispose();
  }
}

async function executeHostShell(
  script: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WorkspaceShellResult> {
  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', script]
    : ['-lc', script];
  const result = await runAsyncProcess(command, args, {
    cwd,
    timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    signal,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    output,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? (result.error ? 1 : 0),
    engine: 'host-shell',
    error: result.error || undefined,
    timedOut: result.timedOut,
    aborted: result.aborted,
  };
}

export async function executeWorkspaceBash(
  script: string,
  workspaceRoot: string,
  options: WorkspaceBashOptions = {},
): Promise<WorkspaceShellResult> {
  const timeoutMs = normalizedTimeout(options.timeoutMs);
  const plan = planNativeBash(script);
  if (plan.engine === 'host' && options.allowHostFallback !== false) {
    return executeHostShell(script, options.cwd || workspaceRoot, timeoutMs, options.signal);
  }
  const cwd = virtualCwd(workspaceRoot, options.cwd);
  return executeNative(createBash(workspaceRoot, timeoutMs), script, cwd, timeoutMs, options.signal);
}

export class NativeBashSession {
  private readonly bash: BashInstance;
  private cwd = '/';
  private activeController: AbortController | null = null;

  constructor(private readonly workspaceRoot: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.bash = createBash(workspaceRoot, normalizedTimeout(timeoutMs));
  }

  async execute(script: string): Promise<WorkspaceShellResult> {
    const plan = planNativeBash(script);
    if (plan.engine === 'host') {
      return {
        output: '', stdout: '', stderr: '', exitCode: 127, engine: 'native-bash', cwd: this.cwd,
        error: `Unsupported native Bash command: ${plan.unsupportedCommands.join(', ')}. Use PowerShell/CMD or the Agent bash tool for host-command fallback.`,
      };
    }
    this.activeController = new AbortController();
    try {
      const result = await executeNative(this.bash, script, this.cwd, normalizedTimeout(this.timeoutMs), this.activeController.signal);
      if (result.cwd) this.cwd = result.cwd;
      return result;
    } finally {
      this.activeController = null;
    }
  }

  interrupt(): void {
    this.activeController?.abort(new Error('Interrupted'));
  }

  getCwd(): string {
    return this.cwd;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
}
