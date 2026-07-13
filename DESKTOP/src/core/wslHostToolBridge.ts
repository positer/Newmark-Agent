import { randomUUID } from 'crypto';
import { WslHostToolRequest } from './wslAgentProtocol';

interface PendingHostTool {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingHostTool>();
let writer: ((value: unknown) => void) | null = null;

export function configureWslHostToolWriter(next: ((value: unknown) => void) | null): void {
  writer = next;
}

export function requestWindowsHostTool(
  tool: WslHostToolRequest['tool'],
  args: Record<string, unknown>,
  context: WslHostToolRequest['context'],
  timeoutMs = 30000,
): Promise<unknown> {
  if (!writer) return Promise.reject(new Error('Windows host tool bridge is unavailable'));
  const requestId = `host-tool-${process.pid}-${randomUUID()}`;
  const request: WslHostToolRequest = { requestId, tool, args, context };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Windows host tool timed out: ${tool}`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    writer?.({ event: 'host_tool_request', data: request });
  });
}

export function settleWslHostToolResult(result: { requestId: string; ok: boolean; result?: unknown; error?: string }): boolean {
  const active = pending.get(result.requestId);
  if (!active) return false;
  pending.delete(result.requestId);
  clearTimeout(active.timer);
  if (result.ok) active.resolve(result.result);
  else active.reject(new Error(result.error || 'Windows host tool failed'));
  return true;
}

export function rejectPendingWslHostTools(reason: string): void {
  for (const active of pending.values()) {
    clearTimeout(active.timer);
    active.reject(new Error(reason));
  }
  pending.clear();
}
