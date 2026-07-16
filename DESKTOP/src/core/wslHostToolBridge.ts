import { randomUUID } from 'crypto';
import { WslHostToolRequest } from './wslAgentProtocol';
import { evaluateToolPolicy, ToolPolicyDecision } from './toolPolicy';

const ROOT_AGENT_ACTOR_ID = '00000000-0000-4000-8000-000000000001';

interface PendingHostTool {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
}

const pending = new Map<string, PendingHostTool>();
let writer: ((value: unknown) => void) | null = null;

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : 'Agent run aborted');
  error.name = 'AbortError';
  return error;
}

function cleanupPending(active: PendingHostTool): void {
  clearTimeout(active.timer);
  if (active.abortListener) active.signal?.removeEventListener('abort', active.abortListener);
}

export function configureWslHostToolWriter(next: ((value: unknown) => void) | null): void {
  writer = next;
}

export function requestWindowsHostTool(
  tool: WslHostToolRequest['tool'],
  args: Extract<WslHostToolRequest, { tool: typeof tool }>['args'],
  context: WslHostToolRequest['context'],
  timeoutMs = 30000,
  signal?: AbortSignal,
): Promise<unknown> {
  const request = { requestId: '', tool, args, context } as WslHostToolRequest;
  const policy = evaluateWslHostToolPolicy(request);
  if (!policy.allowed) return Promise.reject(new Error(policy.reason || `Windows host policy blocked ${tool}`));
  if (!writer) return Promise.reject(new Error('Windows host tool bridge is unavailable'));
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const requestId = `host-tool-${process.pid}-${randomUUID()}`;
  request.requestId = requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const active = pending.get(requestId);
      if (!active) return;
      pending.delete(requestId);
      cleanupPending(active);
      try { writer?.({ event: 'host_tool_cancel', data: { requestId } }); } catch {}
      reject(new Error(`Windows host tool timed out: ${tool}`));
    }, timeoutMs);
    const abortListener = signal ? () => {
      const active = pending.get(requestId);
      if (!active) return;
      pending.delete(requestId);
      cleanupPending(active);
      try { writer?.({ event: 'host_tool_cancel', data: { requestId } }); } catch {}
      reject(abortError(signal));
    } : undefined;
    pending.set(requestId, { resolve, reject, timer, signal, abortListener });
    if (abortListener) signal!.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) {
      abortListener?.();
      return;
    }
    writer?.({ event: 'host_tool_request', data: request });
  });
}

function evaluateWslHostToolPolicy(request: WslHostToolRequest): ToolPolicyDecision {
  const rawArgs = request.args as unknown as Record<string, unknown>;
  let name: string = request.tool;
  let args = rawArgs;
  if (request.tool === 'automation') {
    name = String(rawArgs.tool || '');
    try {
      const parsed = JSON.parse(String(rawArgs.payload || '{}'));
      args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      args = {};
    }
  } else if (request.tool === 'browser_control') {
    const action = String(rawArgs.action || '').toLowerCase();
    const mapped: Record<string, string> = {
      open: 'browser_open',
      snapshot: 'browser_snapshot',
      click: 'browser_click',
      type: 'browser_type',
      eval: 'browser_eval',
      back: 'browser_back',
      forward: 'browser_forward',
      reload: 'browser_reload',
      cdp: 'browser_cdp',
    };
    name = String(mapped[action] || 'browser_use');
    args = action === 'use' ? rawArgs : {};
  }
  return evaluateToolPolicy({
    name,
    mode: request.context.mode || 'build',
    isSubagent: request.context.actorId !== ROOT_AGENT_ACTOR_ID,
    args,
  });
}

export function settleWslHostToolResult(result: { requestId: string; ok: boolean; result?: unknown; error?: string }): boolean {
  const active = pending.get(result.requestId);
  if (!active) return false;
  pending.delete(result.requestId);
  cleanupPending(active);
  if (result.ok) active.resolve(result.result);
  else active.reject(new Error(result.error || 'Windows host tool failed'));
  return true;
}

export function rejectPendingWslHostTools(reason: string): void {
  for (const active of pending.values()) {
    cleanupPending(active);
    active.reject(new Error(reason));
  }
  pending.clear();
}
