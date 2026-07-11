import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as readline from 'readline';
import { AgentWorkEvent } from './types';
import { WslAgentPromptRequest, WslAgentPromptResult, WslAgentRequest, WslAgentResponse, WslAgentWorkspace } from './wslAgentProtocol';

type WorkListener = (event: AgentWorkEvent) => void;

export class WslAgentClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null }>();
  private listeners = new Set<WorkListener>();
  private sequence = 0;
  private lastError = '';
  private stderrBuffer = '';
  private remotePid = 0;

  constructor(
    private readonly distro: string,
    private readonly windowsRoot: string,
    private readonly windowsHostScript: string,
  ) {}

  subscribe(listener: WorkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): { enabled: true; connected: boolean; distro: string; pid: number; error: string } {
    return { enabled: true, connected: !!this.child && !this.child.killed, distro: this.distro, pid: this.remotePid, error: this.lastError };
  }

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    const root = this.toWslPath(this.windowsRoot);
    const hostScript = this.toWslPath(this.windowsHostScript);
    const command = `exec node ${shellQuote(hostScript)}`;
    const child = spawn('wsl.exe', ['-d', this.distro, '--', 'env', `NEWMARK_WSL_ROOT=${root}`, `NEWMARK_WSL_DISTRO=${this.distro}`, 'bash', '-lc', command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.lastError = '';
    this.stderrBuffer = '';
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on('line', line => this.handleLine(line));
    child.stderr.on('data', chunk => { this.stderrBuffer = `${this.stderrBuffer}${String(chunk || '')}`.trim().slice(-2000); });
    child.on('exit', code => this.handleExit(code));
    const ping = await this.request('ping', undefined, 15000) as { pid?: number };
    this.remotePid = Number(ping?.pid || 0);
    this.lastError = '';
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try { await this.request('shutdown', undefined, 2000); } catch {}
    if (!child.killed) child.kill();
    this.child = null;
    this.remotePid = 0;
  }

  async prompt(params: WslAgentPromptRequest): Promise<WslAgentPromptResult> {
    await this.start();
    return await this.request('prompt', { ...params, workspace: this.mapWorkspace(params.workspace) }, 0) as WslAgentPromptResult;
  }

  async abort(conversationId: string): Promise<boolean> {
    if (!this.child) return false;
    return !!await this.request('abort', { conversationId }, 5000);
  }

  async snapshot(conversationId: string, workspace: WslAgentWorkspace | null): Promise<Record<string, unknown>> {
    await this.start();
    return await this.request('snapshot', { conversationId, workspace: this.mapWorkspace(workspace) }, 15000) as Record<string, unknown>;
  }

  private mapWorkspace(workspace: WslAgentWorkspace | null): WslAgentWorkspace | null {
    if (!workspace) return null;
    return { ...workspace, path: this.toWslPath(workspace.path) };
  }

  private toWslPath(input: string): string {
    const direct = windowsDrivePathToWsl(input);
    if (direct) return direct;
    const command = `wslpath -a -- ${shellQuote(input)}`;
    const result = spawnSync('wsl.exe', ['-d', this.distro, '--', 'bash', '-lc', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error(`WSL path conversion failed: ${result.stderr || result.error?.message || input}`);
    return result.stdout.trim();
  }

  private request(method: WslAgentRequest['method'], params?: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.child || this.child.killed) return Promise.reject(new Error('WSL Agent backend is not running'));
    const id = `wsl-${process.pid}-${Date.now()}-${++this.sequence}`;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this.pending.delete(id); reject(new Error(`WSL Agent request timed out: ${method}`)); }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private handleLine(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event === 'work' && message.data) {
      for (const listener of this.listeners) listener(message.data as AgentWorkEvent);
      return;
    }
    const response = message as WslAgentResponse;
    const pending = response.id ? this.pending.get(response.id) : undefined;
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  }

  private handleExit(code: number | null): void {
    this.child = null;
    this.remotePid = 0;
    this.lastError = this.stderrBuffer || this.lastError;
    const error = new Error(`WSL Agent backend exited (${code ?? 'unknown'}): ${this.lastError || 'no stderr'}`);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function windowsDrivePathToWsl(input: string): string {
  const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (drivePath) {
    const drive = drivePath[1].toLowerCase();
    const rest = drivePath[2].replace(/\\/g, '/').replace(/^\/+/, '');
    return `/mnt/${drive}/${rest}`;
  }
  if (input.startsWith('/')) return input;
  return '';
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
