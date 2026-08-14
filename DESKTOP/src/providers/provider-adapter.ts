/**
 * Unified provider adapter contract for dev-0.3.0.
 *
 * Chat Completions and Responses are separate adapters. The Context
 * Orchestrator and the agent runtime never branch on provider-specific fields;
 * they only interact with `ModelProviderAdapter`.
 */

export type ApiMode = 'chat_completions' | 'responses' | 'custom';

export interface ModelCapabilities {
  providerId: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
}

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  toolCallId?: string;
  name?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface NormalizedTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface NormalizedAgentRequest {
  providerId: string;
  model: string;
  apiMode: ApiMode;
  systemPrompt: string | null;
  messages: NormalizedMessage[];
  tools: NormalizedTool[];
  temperature: number;
  maxOutputTokens: number;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  apiKey: string;
  baseUrl: string;
  /** 可选的会话标识。仅当目标 provider 显式支持 session_id 语义的上下文缓存
   *  时才由上层填充；adapter 在存在时透传，否则省略该字段（避免严格 API 拒绝未知字段）。 */
  sessionId?: string;
}

export interface TokenEstimate {
  inputTokens: number;
  outputReservedTokens: number;
  toolTokens: number;
  totalTokens: number;
  tokenizerSource: 'estimated' | 'compatible' | 'provider_tokenizer';
}

export interface SerializedProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Minimal transport response contract. The real `Response` satisfies it
 * structurally, and the LLM provider's loopback / node-http fallback paths
 * construct plain objects that also conform (with `body` filled lazily).
 */
export interface TransportResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Injectable HTTP transport. Defaults to global `fetch`; the LLM provider
 * injects a loopback-aware transport with node-http / powershell fallback and
 * its timeout orchestration so adapter `execute` stays transport-agnostic.
 */
export type ProviderTransport = (
  request: SerializedProviderRequest,
  signal: AbortSignal,
) => Promise<TransportResponse>;

export type NormalizedProviderEvent =
  | { type: 'response.started' }
  | { type: 'text.delta'; delta: string }
  | { type: 'reasoning.summary.delta'; delta: string }
  | { type: 'reasoning.summary.done'; summary: string }
  | { type: 'tool_call.started'; id: string; name: string }
  | { type: 'tool_call.arguments.delta'; id: string; delta: string }
  | { type: 'tool_call.completed'; id: string; name: string; arguments: string }
  | { type: 'usage.updated'; usage: ActualApiUsage }
  | { type: 'response.completed' }
  | { type: 'response.failed'; error: string };

export interface ActualApiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface ProviderResponseMetadata {
  requestId?: string;
  traceId?: string;
  rateLimit?: { limit: number; remaining: number; resetAt: string };
  retryAfterSeconds?: number;
  cacheState?: 'hit' | 'miss' | 'unknown';
  providerDiagnostics?: Record<string, string>;
}

export interface ModelProviderAdapter {
  readonly providerId: string;
  readonly apiMode: ApiMode;

  getModelCapabilities(model: string): Promise<ModelCapabilities>;
  estimateRequestTokens(request: NormalizedAgentRequest): Promise<TokenEstimate>;
  serializeRequest(request: NormalizedAgentRequest): Promise<SerializedProviderRequest>;
  execute(
    request: SerializedProviderRequest,
    signal: AbortSignal,
    transport?: ProviderTransport,
  ): AsyncIterable<NormalizedProviderEvent>;
  normalizeUsage(value: unknown): ActualApiUsage | null;
  normalizeHeaders(
    headers: Headers | Record<string, string>,
  ): ProviderResponseMetadata;
}
