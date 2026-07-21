import { createHash } from 'crypto';

export type AgentKernelDiagnosticEvent =
  | {
      type: 'request_context';
      at: string;
      conversationId: string;
      systemFingerprint: string;
      toolSurfaceFingerprint: string;
      requestFingerprint: string;
      systemChars: number;
      messageCount: number;
      estimatedMessageTokens: number;
      toolCount: number;
      estimatedToolTokens: number;
    }
  | {
      type: 'provider_usage';
      at: string;
      conversationId: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      cacheReadRatio: number;
    };

let diagnosticSink: ((event: AgentKernelDiagnosticEvent) => void) | null = null;

export function setAgentKernelDiagnosticSink(sink: ((event: AgentKernelDiagnosticEvent) => void) | null): void {
  diagnosticSink = sink;
}

export function agentKernelDiagnosticsEnabled(): boolean {
  return process.env.NEWMARK_KERNEL_DIAGNOSTICS === '1';
}

export function emitRequestContextDiagnostic(input: {
  conversationId?: string;
  systemPrompt?: string;
  messages?: unknown[];
  tools?: unknown[];
}): Extract<AgentKernelDiagnosticEvent, { type: 'request_context' }> {
  const systemPrompt = String(input.systemPrompt || '');
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const serializedMessages = stableSerialize(messages);
  const serializedTools = stableSerialize(tools);
  const event: AgentKernelDiagnosticEvent = {
    type: 'request_context',
    at: new Date().toISOString(),
    conversationId: String(input.conversationId || ''),
    systemFingerprint: fingerprint(systemPrompt),
    toolSurfaceFingerprint: fingerprint(serializedTools),
    requestFingerprint: fingerprint(`${systemPrompt}\n${serializedMessages}\n${serializedTools}`),
    systemChars: systemPrompt.length,
    messageCount: messages.length,
    estimatedMessageTokens: estimateTokens(serializedMessages),
    toolCount: tools.length,
    estimatedToolTokens: estimateTokens(serializedTools),
  };
  diagnosticSink?.(event);
  if (agentKernelDiagnosticsEnabled()) console.error(`[NewmarkKernelDiagnostic] ${JSON.stringify(event)}`);
  return event;
}

export function emitProviderUsageDiagnostic(input: {
  conversationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): Extract<AgentKernelDiagnosticEvent, { type: 'provider_usage' }> {
  const inputTokens = boundedCount(input.inputTokens);
  const cacheReadTokens = boundedCount(input.cacheReadTokens);
  const event: AgentKernelDiagnosticEvent = {
    type: 'provider_usage',
    at: new Date().toISOString(),
    conversationId: String(input.conversationId || ''),
    inputTokens,
    outputTokens: boundedCount(input.outputTokens),
    cacheReadTokens,
    cacheWriteTokens: boundedCount(input.cacheWriteTokens),
    cacheReadRatio: inputTokens > 0 ? Math.min(1, cacheReadTokens / inputTokens) : 0,
  };
  diagnosticSink?.(event);
  if (agentKernelDiagnosticsEnabled()) console.error(`[NewmarkKernelDiagnostic] ${JSON.stringify(event)}`);
  return event;
}

export function extractProviderUsage(payload: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const root = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
  const usage = root.usage && typeof root.usage === 'object' ? root.usage as Record<string, any> : root;
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const cacheCreation = usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? inputDetails.cache_write_tokens;
  return {
    input: boundedCount(usage.input_tokens ?? usage.prompt_tokens ?? usage.input),
    output: boundedCount(usage.output_tokens ?? usage.completion_tokens ?? usage.output),
    cacheRead: boundedCount(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? inputDetails.cached_tokens ?? inputDetails.cache_read_tokens),
    cacheWrite: boundedCount(cacheCreation),
  };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 20);
}

function estimateTokens(value: string): number {
  return Math.max(0, Math.ceil(value.length / 4));
}

function boundedCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) || '';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}
