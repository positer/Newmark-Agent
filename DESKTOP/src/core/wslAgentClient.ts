import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'child_process';
import * as readline from 'readline';
import { AgentWorkEvent } from './types';
import { TerminalTakeoverEvent, TerminalTakeoverOwnerFilter, TerminalTakeoverState } from '../tools/terminalTakeover';
import {
  WslAgentPromptRequest,
  WslAgentPromptResult,
  WslAgentRequest,
  WslAgentResponse,
  WslAgentWorkspace,
  WslHostToolRequest,
  WslHostToolResult,
} from './wslAgentProtocol';

type WorkListener = (event: AgentWorkEvent) => void;
type TerminalListener = (event: TerminalTakeoverEvent) => void;
type HostToolHandler = (request: WslHostToolRequest) => Promise<unknown>;

export class WslAgentClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null }>();
  private listeners = new Set<WorkListener>();
  private terminalListeners = new Set<TerminalListener>();
  private hostToolHandler: HostToolHandler | null = null;
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

  subscribeTerminal(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  setHostToolHandler(handler: HostToolHandler | null): void {
    this.hostToolHandler = handler;
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

  shutdownNow(): void {
    const child = this.child;
    if (!child) return;
    const id = `wsl-${process.pid}-${Date.now()}-${++this.sequence}`;
    try { child.stdin.write(`${JSON.stringify({ id, method: 'shutdown' })}\n`); } catch {}
    try { child.stdin.end(); } catch {}
    try { if (!child.killed) child.kill(); } catch {}
    this.child = null;
    this.remotePid = 0;
    const error = new Error('WSL Agent backend shut down with the desktop application');
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async resetAgent(): Promise<void> {
    if (!this.child || this.child.killed) return;
    await this.request('reset', undefined, 15000);
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

  async terminalState(owner: TerminalTakeoverOwnerFilter, persistenceRoot?: string): Promise<TerminalTakeoverState[]> {
    await this.start();
    return await this.request('terminal_state', { owner, persistenceRoot: persistenceRoot ? this.toWslPath(persistenceRoot) : undefined }, 15000) as TerminalTakeoverState[];
  }

  async terminalWrite(owner: TerminalTakeoverOwnerFilter, sessionId: string, data: string, persistenceRoot?: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return await this.request('terminal_write', { owner, sessionId, data, persistenceRoot: persistenceRoot ? this.toWslPath(persistenceRoot) : undefined }, 15000) as { ok: boolean; error?: string };
  }

  async terminalResize(owner: TerminalTakeoverOwnerFilter, sessionId: string, cols: number, rows: number, persistenceRoot?: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return await this.request('terminal_resize', { owner, sessionId, cols, rows, persistenceRoot: persistenceRoot ? this.toWslPath(persistenceRoot) : undefined }, 15000) as { ok: boolean; error?: string };
  }

  async terminalStop(owner: TerminalTakeoverOwnerFilter, sessionId: string, persistenceRoot?: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return await this.request('terminal_stop', { owner, sessionId, persistenceRoot: persistenceRoot ? this.toWslPath(persistenceRoot) : undefined }, 15000) as { ok: boolean; error?: string };
  }

  async terminalDetach(owner: TerminalTakeoverOwnerFilter, sessionId: string, persistenceRoot?: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return await this.request('terminal_detach', { owner, sessionId, persistenceRoot: persistenceRoot ? this.toWslPath(persistenceRoot) : undefined }, 15000) as { ok: boolean; error?: string };
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
    if (message.event === 'terminal' && message.data) {
      for (const listener of this.terminalListeners) listener(message.data as TerminalTakeoverEvent);
      return;
    }
    if (message.event === 'host_tool_request' && message.data) {
      void this.handleHostToolRequest(message.data as WslHostToolRequest);
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

  private async handleHostToolRequest(request: WslHostToolRequest): Promise<void> {
    let result: WslHostToolResult;
    if (!this.hostToolHandler) {
      result = { requestId: request.requestId, ok: false, error: 'No Windows host tool handler is registered' };
    } else if (request.tool !== 'computer_use') {
      result = { requestId: request.requestId, ok: false, error: `WSL host tool is not allowed: ${String(request.tool)}` };
    } else {
      try {
        result = { requestId: request.requestId, ok: true, result: await this.hostToolHandler(request) };
      } catch (error) {
        result = { requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      await this.request('host_tool_result', result, 5000);
    } catch {
      // The remote process may have exited while a native host tool was running.
    }
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
