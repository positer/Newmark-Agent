import { randomUUID } from 'crypto';
import { WslHostToolRequest } from './wslAgentProtocol';

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
  if (!writer) return Promise.reject(new Error('Windows host tool bridge is unavailable'));
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const requestId = `host-tool-${process.pid}-${randomUUID()}`;
  const request = { requestId, tool, args, context } as WslHostToolRequest;
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
