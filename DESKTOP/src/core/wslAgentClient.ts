import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as readline from 'readline';
import { AgentWorkEvent, ConversationInputEnvelope, GuideReceipt } from './types';
import { TerminalTakeoverEvent, TerminalTakeoverOwnerFilter, TerminalTakeoverState } from '../tools/terminalTakeover';
import {
  WslAgentPromptRequest,
  WslAgentPromptResult,
  WslAutoRouteRatingResult,
  WslAgentRequest,
  WslAgentResponse,
  WslAgentWorkspace,
  WslAgentStopResult,
  WslConversationRewindResult,
  WslHostToolRequest,
  WslHostToolResult,
} from './wslAgentProtocol';
import { ConversationRuntimeTarget, NormalizedConversationTarget, normalizeConversationTarget } from './conversationTarget';
import { AsyncProcessResult, runAsyncProcess } from './asyncProcess';

type WorkListener = (event: AgentWorkEvent) => void;
type TerminalListener = (event: TerminalTakeoverEvent) => void;
export type WslHostToolHandler = ((request: WslHostToolRequest, signal?: AbortSignal) => Promise<unknown>) & {
  cancelTarget?(runtimeKey: string): void;
};

export type WslCommandResult = AsyncProcessResult;

export interface WslCommandRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type WslCommandRunner = (args: string[], options: WslCommandRunOptions) => Promise<WslCommandResult>;

export interface WslRuntimeIdentity {
  pid: number;
  pgid: number;
  sessionId: number;
}

const defaultWslCommandRunner: WslCommandRunner = async (args, options) => await new Promise<WslCommandResult>(resolve => {
  let settled = false;
  const finish = (result: WslCommandResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimeout);
    options.signal?.removeEventListener('abort', abortListener);
    resolve(result);
  };
  const abortListener = (): void => finish({
    status: null,
    stdout: '',
    stderr: '',
    error: options.signal?.reason instanceof Error ? options.signal.reason.message : 'WSL helper aborted',
    aborted: true,
    timedOut: false,
    overflowed: false,
  });
  const hardTimeout = setTimeout(() => finish({
    status: null,
    stdout: '',
    stderr: '',
    error: `WSL helper did not exit after ${options.timeoutMs} ms`,
    aborted: false,
    timedOut: true,
    overflowed: false,
  }), options.timeoutMs + 200);
  options.signal?.addEventListener('abort', abortListener, { once: true });
  void runAsyncProcess('wsl.exe', args, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  }).then(finish);
});

/**
 * Kills one previously verified WSL session/process group and proves that the
 * group no longer exists before its caller may launch a replacement. The bash
 * helper has its own bounded poll loop; the Windows child runner adds a second
 * timeout/cancellation boundary so Electron's event loop is never blocked.
 */
export async function terminateWslRuntimeProcessGroup(
  distro: string,
  identityInput: WslRuntimeIdentity,
  runner: WslCommandRunner = defaultWslCommandRunner,
  signal?: AbortSignal,
): Promise<void> {
  const identity = normalizeRuntimeIdentity(identityInput);
  if (!identity || identity.pid !== identity.pgid || identity.pgid !== identity.sessionId) {
    throw new Error(`WSL runtime process group termination refused: unverified pid/pgid/session identity`);
  }
  const target = identity.pgid;
  const command = [
    `if kill -0 -- "-${target}" 2>/dev/null; then kill -KILL -- "-${target}" 2>/dev/null || { echo 'runtime process group kill failed' >&2; exit 71; }; fi`,
    `for attempt in {1..24}; do if ! kill -0 -- "-${target}" 2>/dev/null; then printf 'terminated:%s\\n' "${target}"; exit 0; fi; sleep 0.05; done`,
    `echo 'runtime process group is still alive' >&2`,
    `exit 72`,
  ].join('; ');
  // The Linux poll itself is bounded to about 1.2 s, but starting a second
  // wsl.exe/bash helper and reaping it can exceed two seconds under Windows
  // load even while the distribution is already warm. Keep this well below
  // the 30 s cold-start budget while leaving enough room to verify teardown.
  const result = await runner(['-d', distro, '--', 'bash', '-lc', command], { timeoutMs: 5_500, signal });
  if (result.status !== 0 || result.error || result.timedOut || result.aborted || result.overflowed) {
    const detail = String(result.stderr || result.error || `exit ${String(result.status)}`).trim().slice(-500);
    throw new Error(`WSL runtime process group termination failed for pgid ${target}: ${detail || 'unknown helper failure'}`);
  }
}

export class WslAgentClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null }>();
  private listeners = new Set<WorkListener>();
  private terminalListeners = new Set<TerminalListener>();
  private hostToolHandler: WslHostToolHandler | null = null;
  private hostToolRuns = new Map<string, { generation: number; controller: AbortController }>();
  private childGeneration = 0;
  private sequence = 0;
  private lastError = '';
  private stderrBuffer = '';
  private remotePid = 0;
  private remotePgid = 0;
  private remoteSessionId = 0;

  constructor(
    private readonly distro: string,
    private readonly windowsRoot: string,
    private readonly windowsHostScript: string,
    private readonly runtimeTarget: NormalizedConversationTarget | null = null,
    private readonly commandRunner: WslCommandRunner = defaultWslCommandRunner,
  ) {}

  subscribe(listener: WorkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTerminal(listener: TerminalListener): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  setHostToolHandler(handler: WslHostToolHandler | null): void {
    this.hostToolHandler = handler;
  }

  status(): { enabled: true; connected: boolean; distro: string; pid: number; pgid: number; sessionId: number; error: string } {
    return {
      enabled: true,
      connected: !!this.child && !this.child.killed,
      distro: this.distro,
      pid: this.remotePid,
      pgid: this.remotePgid,
      sessionId: this.remoteSessionId,
      error: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    const root = await this.toWslPath(this.windowsRoot);
    const hostScript = await this.toWslPath(this.windowsHostScript);
    const command = `command -v setsid >/dev/null 2>&1 || { echo 'setsid is required for isolated Newmark WSL runtimes' >&2; exit 127; }; exec setsid --wait node ${shellQuote(hostScript)}`;
    const runtimeEnv = this.runtimeTarget ? [
      `NEWMARK_RUNTIME_KEY=${this.runtimeTarget.runtimeKey}`,
      `NEWMARK_WORKSPACE_ID=${this.runtimeTarget.workspaceId}`,
      `NEWMARK_CONVERSATION_ID=${this.runtimeTarget.conversationId}`,
    ] : [];
    const child = spawn('wsl.exe', ['-d', this.distro, '--', 'env', `NEWMARK_WSL_ROOT=${root}`, `NEWMARK_WSL_DISTRO=${this.distro}`, 'NEWMARK_ISOLATED_RUNTIME=1', ...runtimeEnv, 'bash', '-lc', command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    const generation = ++this.childGeneration;
    this.lastError = '';
    this.stderrBuffer = '';
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on('line', line => this.handleLine(child, generation, line));
    child.stderr.on('data', chunk => {
      if (this.child === child && this.childGeneration === generation) {
        this.stderrBuffer = `${this.stderrBuffer}${String(chunk || '')}`.trim().slice(-2000);
      }
    });
    child.on('exit', code => this.handleExit(child, code));
    const ping = await this.request('ping', undefined, 30_000) as Partial<WslRuntimeIdentity>;
    const identity = normalizeRuntimeIdentity(ping);
    if (!identity || identity.pid !== identity.pgid || identity.pgid !== identity.sessionId) {
      const error = new Error(`WSL runtime isolation identity invalid: pid=${String(ping?.pid || 0)} pgid=${String(ping?.pgid || 0)} session=${String(ping?.sessionId || 0)}`);
      try { if (!child.killed) child.kill(); } catch {}
      this.detachChild(child, error);
      this.lastError = error.message;
      throw error;
    }
    if (this.child !== child || this.childGeneration !== generation) throw new Error('WSL runtime startup identity belonged to a stale generation');
    this.remotePid = identity.pid;
    this.remotePgid = identity.pgid;
    this.remoteSessionId = identity.sessionId;
    this.lastError = '';
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const generation = this.childGeneration;
    const identity = { pid: this.remotePid, pgid: this.remotePgid, sessionId: this.remoteSessionId };
    try { await this.request('shutdown', undefined, 250); } catch {}
    try {
      await terminateWslRuntimeProcessGroup(this.distro, identity, this.commandRunner);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    if (this.childGeneration !== generation) return;
    try { if (!child.killed) child.kill(); } catch {}
    if (this.child === child) this.detachChild(child, new Error('WSL Agent backend stopped'));
  }

  async shutdownNow(): Promise<void> {
    await this.stop();
  }

  async resetAgent(): Promise<void> {
    if (!this.child || this.child.killed) return;
    await this.request('reset', undefined, 15000);
  }

  async prompt(params: WslAgentPromptRequest): Promise<WslAgentPromptResult> {
    await this.start();
    const target = params.target
      ? await this.mapTarget(params.target)
      : await this.mapTarget(this.targetFromLegacy(params.conversationId, params.workspace));
    return await this.request('prompt', { ...params, target, workspace: undefined }, 0) as WslAgentPromptResult;
  }

  async abort(conversationId: string): Promise<boolean> {
    if (!this.child) return false;
    return !!await this.request('abort', { conversationId }, 5000);
  }

  async requestStop(target: ConversationRuntimeTarget, runId?: string): Promise<WslAgentStopResult> {
    if (!this.child) {
      const normalized = normalizeConversationTarget(target);
      return { action: 'not_running', runtimeKey: normalized.runtimeKey, checkpointed: false, backend: 'wsl', distro: this.distro };
    }
    return await this.request('stop', { target: await this.mapTarget(target), runId }, 5000) as WslAgentStopResult;
  }

  async snapshot(conversationId: string, workspace: WslAgentWorkspace | null): Promise<Record<string, unknown>> {
    await this.start();
    const target = await this.mapTarget(this.targetFromLegacy(conversationId, workspace));
    return await this.request('snapshot', { target }, 15000) as Record<string, unknown>;
  }

  async snapshotTarget(target: ConversationRuntimeTarget): Promise<Record<string, unknown>> {
    await this.start();
    return await this.request('snapshot', { target: await this.mapTarget(target) }, 15000) as Record<string, unknown>;
  }

  async rewind(target: ConversationRuntimeTarget, messageIndex: number): Promise<WslConversationRewindResult> {
    await this.start();
    return await this.request('rewind', {
      target: await this.mapTarget(target),
      messageIndex: Math.floor(Number(messageIndex)),
    }, 15_000) as WslConversationRewindResult;
  }

  async enqueueGuide(target: ConversationRuntimeTarget, envelope: ConversationInputEnvelope): Promise<GuideReceipt> {
    await this.start();
    return await this.request('guide', { target: await this.mapTarget(target), envelope }, 5_000) as GuideReceipt;
  }

  async checkpoint(target: ConversationRuntimeTarget): Promise<Record<string, unknown>> {
    await this.start();
    return await this.request('checkpoint', { target: await this.mapTarget(target) }, 5_000) as Record<string, unknown>;
  }

  async rateAutoRoute(
    target: ConversationRuntimeTarget,
    score: number,
    routeId = '',
  ): Promise<WslAutoRouteRatingResult> {
    await this.start();
    return await this.request('rate_auto_route', {
      target: await this.mapTarget(target),
      score,
      routeId: String(routeId || ''),
    }, 5_000) as WslAutoRouteRatingResult;
  }

  async setWorkRunExpanded(target: ConversationRuntimeTarget, runId: string, expanded: boolean): Promise<boolean> {
    await this.start();
    return !!await this.request('set_work_run_expanded', { target: await this.mapTarget(target), runId, expanded }, 5_000);
  }

  async updateSetting(section: string, key: string, value: unknown): Promise<void> {
    if (!this.child || this.child.killed) return;
    await this.request('update_setting', { section, key, value }, 5_000);
  }

  async forceStopRuntimeGroup(signal?: AbortSignal): Promise<'terminated' | 'stale'> {
    const child = this.child;
    const generation = this.childGeneration;
    const identity: WslRuntimeIdentity = {
      pid: this.remotePid,
      pgid: this.remotePgid,
      sessionId: this.remoteSessionId,
    };
    if (!child || child.killed) throw new Error('WSL runtime process group termination failed: runtime launcher is not connected');
    if (!normalizeRuntimeIdentity(identity)) throw new Error('WSL runtime process group termination failed: runtime identity was not recorded');
    for (const [requestId, run] of this.hostToolRuns) {
      if (run.generation !== generation) continue;
      run.controller.abort(new Error('WSL conversation runtime force-restarted'));
      this.hostToolRuns.delete(requestId);
    }
    if (this.runtimeTarget) this.hostToolHandler?.cancelTarget?.(this.runtimeTarget.runtimeKey);
    try {
      await terminateWslRuntimeProcessGroup(this.distro, identity, this.commandRunner, signal);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    if (this.childGeneration !== generation) return 'stale';
    try { if (child && !child.killed) child.kill(); } catch {}
    const error = new Error('WSL conversation runtime was force-restarted');
    if (this.child === child) this.detachChild(child, error);
    return 'terminated';
  }

  async forceRestartRuntimeGroup(signal?: AbortSignal): Promise<void> {
    const outcome = await this.forceStopRuntimeGroup(signal);
    if (outcome === 'stale') return;
    await this.start();
  }

  async terminalState(owner: TerminalTakeoverOwnerFilter, persistenceRoot?: string): Promise<TerminalTakeoverState[]> {
    await this.start();
    return await this.request('terminal_state', { owner, persistenceRoot: persistenceRoot ? await this.toWslPath(persistenceRoot) : undefined }, 15000) as TerminalTakeoverState[];
  }

  async terminalWrite(owner: TerminalTakeoverOwnerFilter, sessionId: string, data: string, persistenceRoot?: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return await this.request('terminal_write', { owner, sessionId, data, persistenceRoot: persistenceRoot ? await this.toWslPath(persistenceRoot) : undefined }, 15000) as { ok: boolean; error?: string };
  }

  async terminalResize(owner: TerminalTakeoverOwnerFilter, sessionId: string, cols: number, rows: number, persistenceRoot?: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return await this.request('terminal_resize', { owner, sessionId, cols, rows, persistenceRoot: persistenceRoot ? await this.toWslPath(persistenceRoot) : undefined }, 15000) as { ok: boolean; error?: string };
  }

  async terminalStop(owner: TerminalTakeoverOwnerFilter, sessionId: string, persistenceRoot?: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return await this.request('terminal_stop', { owner, sessionId, persistenceRoot: persistenceRoot ? await this.toWslPath(persistenceRoot) : undefined }, 15000) as { ok: boolean; error?: string };
  }

  async terminalDetach(owner: TerminalTakeoverOwnerFilter, sessionId: string, persistenceRoot?: string): Promise<{ ok: boolean; error?: string }> {
    await this.start();
    return await this.request('terminal_detach', { owner, sessionId, persistenceRoot: persistenceRoot ? await this.toWslPath(persistenceRoot) : undefined }, 15000) as { ok: boolean; error?: string };
  }

  private targetFromLegacy(conversationId: string, workspace: WslAgentWorkspace | null): ConversationRuntimeTarget {
    return {
      workspaceId: String(workspace?.id || workspace?.name || workspace?.path || 'none'),
      conversationId: String(conversationId || 'default'),
      workspace: workspace ? {
        id: String(workspace.id || workspace.name || workspace.path),
        name: workspace.name,
        path: workspace.path,
        isInternal: !!workspace.isInternal,
        kind: workspace.kind,
      } : null,
    };
  }

  private async mapTarget(target: ConversationRuntimeTarget): Promise<ConversationRuntimeTarget> {
    const normalized = normalizeConversationTarget(target);
    return normalizeConversationTarget({
      ...normalized,
      workspace: normalized.workspace ? { ...normalized.workspace, path: await this.toWslPath(normalized.workspace.path) } : null,
      workspaceKey: normalized.workspaceKey,
      runtimeKey: normalized.runtimeKey,
    });
  }

  private async toWslPath(input: string): Promise<string> {
    const direct = windowsDrivePathToWsl(input);
    if (direct) return direct;
    const command = `wslpath -a -- ${shellQuote(input)}`;
    const result = await this.commandRunner(['-d', this.distro, '--', 'bash', '-lc', command], { timeoutMs: 10_000 });
    if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error(`WSL path conversion failed: ${result.stderr || result.error || input}`);
    return result.stdout.trim();
  }

  private request(method: WslAgentRequest['method'], params?: unknown, timeoutMs = 30000): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error('WSL Agent backend is not running'));
    const id = `wsl-${process.pid}-${Date.now()}-${++this.sequence}`;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this.pending.delete(id); reject(new Error(`WSL Agent request timed out: ${method}`)); }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleLine(child: ChildProcessWithoutNullStreams, generation: number, line: string): void {
    if (this.child !== child || this.childGeneration !== generation) return;
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
      void this.handleHostToolRequest(child, generation, message.data as WslHostToolRequest);
      return;
    }
    if (message.event === 'host_tool_cancel' && message.data) {
      const requestId = String((message.data as Record<string, unknown>).requestId || '');
      const run = this.hostToolRuns.get(requestId);
      if (run?.generation === generation) {
        run.controller.abort(new Error('WSL host tool cancelled by Agent run'));
        this.hostToolRuns.delete(requestId);
        if (this.runtimeTarget) this.hostToolHandler?.cancelTarget?.(this.runtimeTarget.runtimeKey);
      }
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

  private async handleHostToolRequest(child: ChildProcessWithoutNullStreams, generation: number, request: WslHostToolRequest): Promise<void> {
    let result: WslHostToolResult;
    const controller = new AbortController();
    this.hostToolRuns.set(request.requestId, { generation, controller });
    const trustedTarget = this.runtimeTarget;
    if (!trustedTarget || request?.context?.runtimeKey !== trustedTarget.runtimeKey) {
      result = { requestId: request.requestId, ok: false, error: 'WSL host tool target mismatch' };
    } else if (!this.hostToolHandler) {
      result = { requestId: request.requestId, ok: false, error: 'No Windows host tool handler is registered' };
    } else if (!['browser_control', 'computer_use', 'browser_use', 'automation', 'terminal_takeover'].includes(request.tool)) {
      result = { requestId: request.requestId, ok: false, error: `WSL host tool is not allowed: ${String(request.tool)}` };
    } else {
      const trustedRequest = {
        ...request,
        context: {
          ...request.context,
          workspaceId: trustedTarget.workspaceId,
          conversationId: trustedTarget.conversationId,
          runtimeKey: trustedTarget.runtimeKey,
        },
      } as WslHostToolRequest;
      try {
        result = { requestId: request.requestId, ok: true, result: await this.hostToolHandler(trustedRequest, controller.signal) };
      } catch (error) {
        result = { requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.hostToolRuns.delete(request.requestId);
    if (controller.signal.aborted || this.child !== child || this.childGeneration !== generation || child.killed) return;
    const id = `wsl-host-result-${process.pid}-${Date.now()}-${++this.sequence}`;
    try { child.stdin.write(`${JSON.stringify({ id, method: 'host_tool_result', params: result })}\n`); } catch {}
  }

  private handleExit(exitedChild: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== exitedChild) return;
    this.lastError = this.stderrBuffer || this.lastError;
    const error = new Error(`WSL Agent backend exited (${code ?? 'unknown'}): ${this.lastError || 'no stderr'}`);
    this.detachChild(exitedChild, error);
  }

  private detachChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.remotePid = 0;
    this.remotePgid = 0;
    this.remoteSessionId = 0;
    const generation = this.childGeneration;
    for (const [requestId, run] of this.hostToolRuns) {
      if (run.generation !== generation) continue;
      run.controller.abort(error);
      this.hostToolRuns.delete(requestId);
    }
    if (this.runtimeTarget) this.hostToolHandler?.cancelTarget?.(this.runtimeTarget.runtimeKey);
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

function normalizeRuntimeIdentity(input: Partial<WslRuntimeIdentity> | null | undefined): WslRuntimeIdentity | null {
  const pid = Number(input?.pid || 0);
  const pgid = Number(input?.pgid || 0);
  const sessionId = Number(input?.sessionId || 0);
  if (![pid, pgid, sessionId].every(value => Number.isSafeInteger(value) && value > 1)) return null;
  return { pid, pgid, sessionId };
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
