import { ActualApiUsage, NormalizedAgentRequest, SerializedProviderRequest, TransportResponse } from './provider-adapter';
import { Agent, Dispatcher } from 'undici';
import { normalizeProviderHeaders } from './provider-headers';

/**
 * Shared SSE parsing and usage normalization used by both adapters.
 */

let defaultProviderDispatcher: unknown = null;
const directProviderStreamDispatcher = new Agent();
const providerStreamDispatchers = new WeakMap<Dispatcher, Dispatcher>();

class StreamingProviderDispatcher extends Dispatcher {
  constructor(private readonly delegate: Dispatcher) { super(); }
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    // The application already owns cancellation. Undici otherwise adds its
    // own 300s headers/body deadline, including during valid long reasoning
    // and non-streaming JSON model responses (for example generated titles).
    // Keep connection establishment and all non-LLM requests unchanged.
    return this.delegate.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
  }
}

export function providerStreamingDispatcher(dispatcher?: unknown): Dispatcher {
  const delegate = (dispatcher || directProviderStreamDispatcher) as Dispatcher;
  let streaming = providerStreamDispatchers.get(delegate);
  if (!streaming) {
    streaming = new StreamingProviderDispatcher(delegate);
    providerStreamDispatchers.set(delegate, streaming);
  }
  return streaming;
}

/** dev-0.5.14: let non-LLMProvider adapter fallbacks also honor the configured proxy. */
export function setDefaultProviderDispatcher(dispatcher: unknown): void {
  defaultProviderDispatcher = dispatcher || null;
}

/**
 * Default HTTP transport used by adapter `execute` when the LLM provider does
 * not inject a loopback / fallback-aware transport.
 */
export function defaultProviderTransport(
  request: SerializedProviderRequest,
  signal: AbortSignal,
): Promise<TransportResponse> {
  const init: RequestInit = {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal,
  };
  // This transport is exclusively for model POSTs, regardless of whether the
  // provider returns SSE or a complete JSON body. It never serves model GETs.
  const dispatcher = providerStreamingDispatcher(defaultProviderDispatcher);
  if (dispatcher) {
    (init as RequestInit & { dispatcher: unknown }).dispatcher = dispatcher;
  }
  return fetch(request.url, init);
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

/** Incremental SSE framing: CRLF can straddle any transport chunk boundary. */
export class ProviderSseDecoder {
  private line = '';
  private skipLf = false;
  private event: string | undefined;
  private data: string[] = [];

  push(text: string): Array<{ event?: string; data: string }> {
    const events: Array<{ event?: string; data: string }> = [];
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (this.skipLf) {
        this.skipLf = false;
        if (char === '\n') { start = i + 1; continue; }
      }
      if (char !== '\r' && char !== '\n') continue;
      const line = this.line + text.slice(start, i);
      this.line = '';
      start = i + 1;
      this.skipLf = char === '\r';
      if (!line) {
        if (this.data.length) events.push({ event: this.event, data: this.data.join('\n') });
        this.event = undefined;
        this.data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        // SSE removes only the optional single ASCII space after the colon.
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    this.line += text.slice(start);
    return events;
  }
}

/**
 * Compatible gateways may stream function arguments as JSON deltas or repeat
 * a cumulative snapshot on every SSE frame. Keep the normal incremental form
 * when it parses, then fall back to snapshot folding. Returning malformed
 * concatenated snapshots would erase the model's correction at tool parsing.
 */
export function assembleCompatibleToolArguments(parts: string[], strictFinal = false): string {
  const nonEmpty = (parts || []).map(String).filter(part => part && (strictFinal || part !== 'null'));
  if (!nonEmpty.length) return strictFinal ? '' : '{}';
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
    else if (compatible.startsWith(incoming)) {
      if (strictFinal && isJsonObject(compatible) && !isJsonObject(incoming)) compatible = incoming;
      else continue;
    }
    else compatible += incoming;
  }
  if (isJsonObject(compatible)) return compatible;
  // At execution time an earlier valid snapshot cannot repair a newer,
  // truncated correction. Only the final snapshot may replace bad assembly.
  if (strictFinal) return isJsonObject(nonEmpty[nonEmpty.length - 1]) ? nonEmpty[nonEmpty.length - 1] : compatible;
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

function reportedUsageValue(...values: unknown[]): { value: number; reported: boolean } {
  for (const value of values) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return { value: Math.floor(number), reported: true };
  }
  return { value: 0, reported: false };
}

export interface UsageNormalizationOptions {
  /** Only the actual native protocol can change the meaning of input_tokens. */
  protocol?: 'openai' | 'anthropic' | 'github_models';
}

/**
 * Normalize the many provider usage shapes into ActualApiUsage.
 * Handles Chat Completions `usage`, Responses `response.usage`, and
 * Anthropic-style `usage` objects.
 */
export function normalizeProviderUsage(value: unknown, options: UsageNormalizationOptions = {}): ActualApiUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  // Nested response usage (Responses API: usage inside response).
  if (raw.response && typeof raw.response === 'object' && !Array.isArray(raw.response)) {
    return normalizeProviderUsage(raw.response, options);
  }

  // Top-level `usage` wrapper (Responses `response.completed` items carry
  // `{ response: { usage } }`, which strips down to `{ usage }`).
  if (raw.usage && typeof raw.usage === 'object' && !Array.isArray(raw.usage)) {
    return normalizeProviderUsage(raw.usage, options);
  }

  const input = reportedUsageValue(raw.input_tokens, raw.prompt_tokens, raw.input);
  const output = reportedUsageValue(raw.output_tokens, raw.completion_tokens, raw.output);

  // Responses uses input_tokens_details; Chat uses prompt_tokens_details.
  // Keep compatible top-level and legacy aliases without confusing reads
  // with writes. An explicit zero is authoritative, not a missing value.
  const details = [raw.input_tokens_details, raw.prompt_tokens_details, raw.token_details]
    .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value));
  const detailValues = (...keys: string[]): unknown[] => details.flatMap(value => keys.map(key => value[key]));
  const cacheRead = reportedUsageValue(raw.cached_tokens, raw.cache_read_input_tokens, raw.cached_input_tokens,
    ...detailValues('cached_tokens', 'cache_read_tokens'), raw.prompt_cache_hit_tokens);
  const cacheWrite = reportedUsageValue(raw.cache_creation_input_tokens, raw.cache_write_input_tokens, raw.cache_creation_tokens,
    ...detailValues('cache_write_tokens', 'cache_creation'));
  const total = reportedUsageValue(raw.total_tokens);
  const reported = { input: input.reported, output: output.reported, cacheRead: cacheRead.reported, cacheWrite: cacheWrite.reported };
  if (!Object.values(reported).some(Boolean) && !total.reported) return null;
  // Native Anthropic input_tokens excludes both cache reads and writes. OpenAI
  // compatible aliases alone never select this protocol-specific convention.
  const inputTokens = input.value + (options.protocol === 'anthropic' ? cacheRead.value + cacheWrite.value : 0);
  const outputTokens = output.value;
  const cacheReadTokens = cacheRead.value;
  const cacheWriteTokens = cacheWrite.value;
  const totalTokens = total.reported ? total.value : inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    reported,
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

/** Keep semantic provider errors classifiable even when the HTTP status is 200. */
export function providerSemanticErrorText(value: unknown, fallback: string, headers?: Pick<Headers, 'get'>): string {
  const seconds = headers ? normalizeProviderHeaders(headers).retryAfterSeconds : undefined;
  const prefix = `[LLM Error]${seconds === undefined ? '' : ` Retry-After: ${seconds}s`} `;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix + fallback;
  const error = value as Record<string, unknown>;
  const detail: Record<string, string> = { message: typeof error.message === 'string' ? error.message : fallback };
  for (const key of ['code', 'type']) {
    const entry = error[key];
    if (typeof entry === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(entry)) detail[key] = entry;
  }
  return prefix + (detail.code || detail.type ? JSON.stringify({ error: detail }) : detail.message);
}

/** Format a non-OK response, retaining the server's retry delay. */
export function providerErrorText(
  response: { status: number; headers?: { get(name: string): string | null } },
  body: string,
): string {
  const seconds = response.headers ? normalizeProviderHeaders(response.headers).retryAfterSeconds : undefined;
  const retryAfter = seconds === undefined ? '' : ` Retry-After: ${seconds}s`;
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
