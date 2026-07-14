import { randomUUID } from 'crypto';
import {
  UtilityHostToolContext,
  UtilityHostToolRequest,
  UtilityHostToolResult,
  UtilityHostToolTarget,
} from './utilityAgentProtocol';

type UtilityHostToolName = UtilityHostToolRequest['tool'];
type RequestArgs<T extends UtilityHostToolName> = Extract<UtilityHostToolRequest, { tool: T }>['args'];
type SendRequest = (request: UtilityHostToolRequest) => void;
type SendCancel = (requestId: string) => void;

let sender: SendRequest | null = null;
let cancelSender: SendCancel | null = null;
let targetProvider: (() => UtilityHostToolTarget | null) | null = null;
const pending = new Map<string, {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
}>();

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : 'Agent run aborted');
  error.name = 'AbortError';
  return error;
}

function cleanupPending(entry: { timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abortListener?: () => void }): void {
  clearTimeout(entry.timer);
  if (entry.abortListener) entry.signal?.removeEventListener('abort', entry.abortListener);
}

export function configureUtilityHostToolBridge(
  nextSender: SendRequest | null,
  nextTargetProvider: (() => UtilityHostToolTarget | null) | null = null,
  nextCancelSender: SendCancel | null = null,
): void {
  sender = nextSender;
  cancelSender = nextCancelSender;
  targetProvider = nextTargetProvider;
  if (!nextSender) rejectPendingUtilityHostTools('Electron utility host tool bridge disconnected');
}

export function requestUtilityHostTool<T extends UtilityHostToolName>(
  tool: T,
  args: RequestArgs<T>,
  context?: UtilityHostToolContext,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<unknown> {
  const target = targetProvider?.() || null;
  if (!sender || !target) return Promise.reject(new Error(`Electron host tool bridge is unavailable for ${tool}`));
  if (tool !== 'browser_control' && !context) {
    return Promise.reject(new Error(`Electron host tool context is required for ${tool}`));
  }
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const requestId = `utility-host-tool-${process.pid}-${randomUUID()}`;
  const trustedContext = context ? {
    ...context,
    conversationId: target.conversationId,
    workspaceId: target.workspaceId,
    workspacePath: target.workspacePath,
    runtimeKey: target.runtimeKey,
  } : undefined;
  const request = (tool === 'browser_control'
    ? { requestId, tool, args, target }
    : { requestId, tool, args, context: trustedContext, target }) as UtilityHostToolRequest;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const active = pending.get(requestId);
      if (!active) return;
      pending.delete(requestId);
      cleanupPending(active);
      try { cancelSender?.(requestId); } catch {}
      reject(new Error(`Electron ${tool} host RPC timed out`));
    }, Math.max(1_000, timeoutMs));
    const abortListener = signal ? () => {
      const active = pending.get(requestId);
      if (!active) return;
      pending.delete(requestId);
      cleanupPending(active);
      try { cancelSender?.(requestId); } catch {}
      reject(abortError(signal));
    } : undefined;
    pending.set(requestId, { resolve, reject, timer, signal, abortListener });
    if (abortListener) signal!.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) {
      abortListener?.();
      return;
    }
    try {
      sender!(request);
    } catch (error) {
      pending.delete(requestId);
      const active = { timer, signal, abortListener };
      cleanupPending(active);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function settleUtilityHostToolResult(result: UtilityHostToolResult): boolean {
  const entry = pending.get(result.requestId);
  if (!entry) return false;
  pending.delete(result.requestId);
  cleanupPending(entry);
  if (result.ok) entry.resolve(result.result);
  else entry.reject(new Error(result.error || 'Electron host tool failed'));
  return true;
}

export function rejectPendingUtilityHostTools(reason: string): void {
  const error = new Error(reason);
  for (const entry of pending.values()) {
    cleanupPending(entry);
    entry.reject(error);
  }
  pending.clear();
}
