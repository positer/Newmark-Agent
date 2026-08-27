import { NormalizedAgentRequest, SerializedProviderRequest, TransportResponse } from './provider-adapter';

/**
 * Shared SSE parsing and usage normalization used by both adapters.
 */

/**
 * Default HTTP transport used by adapter `execute` when the LLM provider does
 * not inject a loopback / fallback-aware transport.
 */
export function defaultProviderTransport(
  request: SerializedProviderRequest,
  signal: AbortSignal,
): Promise<TransportResponse> {
  return fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  });
}

/**
 * Abort error with the same name/reason semantics the LLM provider relies on
 * (`name === 'AbortError'`, preserves the abort reason when present).
 */
export function providerAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error(reason ? String(reason) : 'LLM request aborted');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

export function providerStreamTimeoutError(timeoutMs: number): Error {
  const error = new Error('Stream read timeout');
  error.name = 'TimeoutError';
  error.message = `Stream read timeout after ${timeoutMs}ms`;
  return error;
}

/**
 * Read one SSE chunk with both user cancellation and an inactivity deadline.
 * Cancelling the reader is important: rejecting the race alone leaves the
 * provider socket alive and lets later requests accumulate behind it.
 *
 * timeoutMs defaults to 0 (no stream idle deadline), matching the request-
 * level DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 0 and the Android client's
 * readTimeout(0) / SSE_IDLE_TIMEOUT_MS = 0L. A caller that still wants an
 * inactivity cap passes an explicit positive value (the recovery verify
 * passes 50ms to prove reader cancellation).
 */
export async function readProviderStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMs = 0,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw providerAbortError(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(providerAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // timeoutMs <= 0 means no inactivity deadline (unlimited). setTimeout with
  // 0 would fire on the next tick, so we only arm the timer for positive
  // values and race a never-settling promise otherwise.
  const timeoutPromise: Promise<never> = timeoutMs > 0
    ? new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(providerStreamTimeoutError(timeoutMs)), timeoutMs);
      })
    : new Promise<never>(() => undefined);
  try {
    return await Promise.race([reader.read(), abortPromise, timeoutPromise]);
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      try { await reader.cancel(error); } catch {}
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function parseProviderSse(raw: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  for (const block of String(raw || '').replace(/\r\n/g, '\n').split(/\n\n+/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return events;
}

/**
 * Compatible gateways may stream function arguments as JSON deltas or repeat
 * a cumulative snapshot on every SSE frame. Keep the normal incremental form
 * when it parses, then fall back to snapshot folding. Returning malformed
 * concatenated snapshots would erase the model's correction at tool parsing.
 */
export function assembleCompatibleToolArguments(parts: string[]): string {
  const nonEmpty = (parts || []).map(String).filter(part => part && part !== 'null');
  if (!nonEmpty.length) return '{}';
  const isJsonObject = (value: string): boolean => {
    try {
      const parsed = JSON.parse(value);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  };
  const incremental = nonEmpty.join('');
  if (isJsonObject(incremental)) return incremental;
  let compatible = '';
  for (const incoming of nonEmpty) {
    if (!compatible) compatible = incoming;
    else if (incoming === compatible) continue;
    else if (incoming.startsWith(compatible)) compatible = incoming;
    else if (compatible.startsWith(incoming)) continue;
    else compatible += incoming;
  }
  if (isJsonObject(compatible)) return compatible;
  return [...nonEmpty].reverse().find(isJsonObject) || compatible;
}

/**
 * Detect content-policy refusals across the provider failure shapes.
 * Mirrors `LLMProvider.contentPolicyBlocked` semantics exactly so the
 * adapters and the bridge report identical `[Error] Content policy refusal`
 * failures:
 * - Chat Completions `choices[0].finish_reason === 'content_filter'`
 * - Responses `incomplete_details.reason` containing `content_filter`
 * - error.code/type matching content_filter / safety / moderation
 * - `content_filter_results` / `prompt_filter_results` with `"filtered": true`
 */
export function isContentPolicyBlocked(json: Record<string, unknown>): boolean {
  const choices = Array.isArray(json.choices) ? json.choices as Array<Record<string, unknown>> : [];
  const choice = choices[0] || {};
  if (String(choice.finish_reason || '').toLowerCase() === 'content_filter') return true;
  const incomplete = json.incomplete_details && typeof json.incomplete_details === 'object'
    ? json.incomplete_details as Record<string, unknown>
    : {};
  if (String(incomplete.reason || '').toLowerCase().includes('content_filter')) return true;
  const error = json.error && typeof json.error === 'object' ? json.error as Record<string, unknown> : {};
  if (/content[_ -]?filter|safety|moderation/i.test(String(error.code || error.type || ''))) return true;
  const filterEvidence = JSON.stringify(choice.content_filter_results || json.prompt_filter_results || {});
  return /"filtered"\s*:\s*true/i.test(filterEvidence);
}

function extractUsageValue(value: unknown): number {
  return Math.max(0, Number(value) || 0);
}

/**
 * Normalize the many provider usage shapes into ActualApiUsage.
 * Handles Chat Completions `usage`, Responses `response.usage`, and
 * Anthropic-style `usage` objects.
 */
export function normalizeProviderUsage(value: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  // Nested response usage (Responses API: usage inside response).
  if (raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response)) {
    return normalizeProviderUsage(raw.response);
  }

  // Top-level `usage` wrapper (Responses `response.completed` items carry
  // `{ response: { usage } }`, which strips down to `{ usage }`).
  if (raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)) {
    return normalizeProviderUsage(raw.usage);
  }

  const inputTokens =
    extractUsageValue(raw.input_tokens) ||
    extractUsageValue(raw.prompt_tokens) ||
    extractUsageValue(raw.input) ||
    0;
  const outputTokens =
    extractUsageValue(raw.output_tokens) ||
    extractUsageValue(raw.completion_tokens) ||
    extractUsageValue(raw.output) ||
    0;

  // token_details (Responses) / prompt_tokens_details (Chat).
  const details = raw.token_details ?? raw.prompt_tokens_details ?? {};
  const detailsObj = details && typeof details === 'object' && !Array.isArray(details) ? details as Record<string, unknown> : {};
  const cachedTokens = raw.cached_tokens ?? detailsObj.cached_tokens ?? 0;
  const cacheReadTokens = extractUsageValue(cachedTokens);

  const cacheCreationTokens =
    raw.cache_creation_tokens ?? raw.cache_read_input_tokens ?? detailsObj.cache_creation ?? 0;
  const cacheWriteTokens = extractUsageValue(cacheCreationTokens);

  const totalTokens = extractUsageValue(raw.total_tokens) || inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

const CHARACTERS_PER_TOKEN = 4;

export function estimateRequestTokens(request: NormalizedAgentRequest): {
  inputTokens: number;
  outputReservedTokens: number;
  toolTokens: number;
  totalTokens: number;
  tokenizerSource: 'estimated' | 'compatible' | 'provider_tokenizer';
} {
  let chars = 0;
  if (request.systemPrompt) chars += request.systemPrompt.length;
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      chars += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') chars += part.text.length;
      }
    }
    if (message.toolCalls) {
      for (const call of message.toolCalls) chars += (call.name + call.arguments).length;
    }
  }
  const toolTokens = Math.ceil(JSON.stringify(request.tools || []).length / CHARACTERS_PER_TOKEN);
  const inputTokens = Math.ceil(chars / CHARACTERS_PER_TOKEN) + toolTokens;
  const outputReservedTokens = Math.max(1024, request.maxOutputTokens);
  return {
    inputTokens,
    outputReservedTokens,
    toolTokens,
    totalTokens: inputTokens + outputReservedTokens,
    tokenizerSource: 'estimated',
  };
}

/**
 * Format a non-OK provider response into the exact error string the LLM
 * provider produces (`[LLM Error: <status>][ Retry-After: <n>s] <body>`).
 * Mirrors `LLMProvider.llmErrorText`.
 */
export function providerErrorText(
  response: { status: number; headers?: { get(name: string): string | null } },
  body: string,
): string {
  const rawRetryAfter = response.headers?.get('retry-after')?.trim() || '';
  let retryAfter = '';
  if (/^\d+(?:\.\d+)?$/.test(rawRetryAfter)) {
    retryAfter = ` Retry-After: ${rawRetryAfter}s`;
  } else if (rawRetryAfter) {
    const retryAt = Date.parse(rawRetryAfter);
    if (Number.isFinite(retryAt)) retryAfter = ` Retry-After: ${Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))}s`;
  }
  return `[LLM Error: ${response.status}]${retryAfter} ${body}`;
}

/**
 * Some OpenAI-compatible gateways wrap the standard Responses object in a
 * single-element array. Normalize that transport quirk once so plain chat
 * and tool-stream consumers share the same response shape.
 */
export function normalizeResponsesPayload(payload: unknown): Record<string, unknown> {
  let current = payload;
  while (Array.isArray(current) && current.length === 1) current = current[0];
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
}
