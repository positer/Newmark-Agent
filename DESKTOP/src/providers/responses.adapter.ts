import {
  ActualApiUsage,
  ModelCapabilities,
  ModelProviderAdapter,
  NormalizedAgentRequest,
  NormalizedProviderEvent,
  NormalizedTool,
  ProviderResponseMetadata,
  SerializedProviderRequest,
  TokenEstimate,
} from './provider-adapter';
import {
  estimateRequestTokens,
  normalizeProviderUsage,
  parseProviderSse,
  defaultProviderTransport,
  providerErrorText,
  isContentPolicyBlocked,
  normalizeResponsesPayload,
  readProviderStreamChunk,
} from './provider-events';
import { normalizeProviderHeaders } from './provider-headers';
import { openAIToolName, stringifyContent, normalizeResponsesContent } from './chat-messages';

/**
 * OpenAI Responses adapter. Serializes a normalized request to `/responses`
 * and normalizes the SSE stream (`response.*` events) back into
 * `NormalizedProviderEvent`.
 */
export class ResponsesAdapter implements ModelProviderAdapter {
  readonly providerId: string;
  readonly apiMode = 'responses' as const;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async getModelCapabilities(model: string): Promise<ModelCapabilities> {
    return {
      providerId: this.providerId,
      model,
      contextWindow: 128000,
      maxOutputTokens: 8192,
      reasoning: false,
      input: ['text', 'image'],
      supportsTools: true,
      supportsStructuredOutput: true,
    };
  }

  async estimateRequestTokens(request: NormalizedAgentRequest): Promise<TokenEstimate> {
    return estimateRequestTokens(request);
  }

  async serializeRequest(request: NormalizedAgentRequest): Promise<SerializedProviderRequest> {
    const input: Array<Record<string, unknown>> = [];
    const emittedCallIds = new Set<string>();
    for (const [index, message] of request.messages.entries()) {
      if (message.role === 'tool') {
        const callId = String(message.toolCallId || `call_newmark_recovered_${index}`);
        const name = openAIToolName(message.name || '');
        if (callId && !emittedCallIds.has(callId)) {
          input.push({ type: 'function_call', call_id: callId, name, arguments: '{}' });
          emittedCallIds.add(callId);
        }
        input.push({ type: 'function_call_output', call_id: callId, output: stringifyContent(message.content) });
        continue;
      }
      if (message.role === 'assistant') {
        const content = normalizeResponsesContent(message.content);
        const hasText = (typeof content === 'string' && content.trim()) || (Array.isArray(content) && content.length);
        if (hasText) input.push({ role: 'assistant', content });
        for (const call of message.toolCalls || []) {
          const callId = String(call.id || `call_newmark_${index}_${input.length}`);
          input.push({
            type: 'function_call',
            call_id: callId,
            name: openAIToolName(call.name),
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}),
          });
          emittedCallIds.add(callId);
        }
        continue;
      }
      const normalizedRole = message.role === 'system' ? 'system' : 'user';
      input.push({ role: normalizedRole, content: normalizeResponsesContent(message.content) });
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input: input.length ? input : [{ role: 'user', content: '' }],
      temperature: request.temperature,
      max_output_tokens: request.maxOutputTokens,
    };
    if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort, summary: 'auto' };
    if (request.systemPrompt) body.instructions = request.systemPrompt;
    const tools = this.serializeTools(request.tools);
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    const base = request.baseUrl.replace(/\/+$/, '');
    return {
      url: `${base}/responses`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.apiKey}`,
      },
      body,
    };
  }

  private serializeTools(tools: NormalizedTool[]): Array<Record<string, unknown>> {
    const converted: Array<Record<string, unknown>> = [];
    for (const tool of tools || []) {
      const name = String(tool.function?.name || '').trim();
      if (!name) continue;
      converted.push({
        type: 'function',
        name,
        description: String(tool.function?.description || ''),
        parameters: tool.function?.parameters || { type: 'object', properties: {} },
      });
    }
    return converted;
  }

  async *execute(
    request: SerializedProviderRequest,
    signal: AbortSignal,
    transport = defaultProviderTransport,
  ): AsyncIterable<NormalizedProviderEvent> {
    yield { type: 'response.started' };
    const response = await transport(request, signal);

    if (!response.ok) {
      const err = await response.text();
      yield { type: 'response.failed', error: providerErrorText(response, err) };
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/text\/event-stream/i.test(contentType)) {
      const json = normalizeResponsesPayload(await response.json());
      yield* this.emitNonStreaming(json);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'response.failed', error: '[Error] No response body' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const calls = new Map<string, { id: string; name: string; arguments: string; emitted: boolean }>();
    const reasoningSummaries = new Map<string, string>();
    let emittedContent = false;
    let completed = false;
    let streamError = '';

    try {
      while (true) {
        const { done, value } = await readProviderStreamChunk(reader, signal);
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        const blocks = buffer.split(/\n\n+/);
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          for (const event of parseProviderSse(block + '\n\n')) {
            if (event.data === '[DONE]') continue;
            let payload: Record<string, unknown>;
            try { payload = JSON.parse(event.data) as Record<string, unknown>; } catch { continue; }
            const eventType = String(event.event || payload.type || '');

            if (eventType === 'response.reasoning_summary_text.delta') {
              const key = `${String(payload.item_id || '')}:${String(payload.summary_index || 0)}`;
              const delta = this.extractText(payload.delta);
              if (delta) reasoningSummaries.set(key, (reasoningSummaries.get(key) || '') + delta);
              continue;
            }
            if (eventType === 'response.reasoning_summary_text.done') {
              const key = `${String(payload.item_id || '')}:${String(payload.summary_index || 0)}`;
              const summary = this.extractText(payload.text) || reasoningSummaries.get(key) || '';
              reasoningSummaries.delete(key);
              if (summary) {
                emittedContent = true;
                yield { type: 'reasoning.summary.done', summary };
              }
              continue;
            }
            if (eventType === 'response.output_text.delta') {
              const delta = this.extractText(payload.delta);
              if (delta) {
                emittedContent = true;
                yield { type: 'text.delta', delta };
              }
              continue;
            }
            if (eventType === 'response.output_item.added') {
              const item = payload.item as Record<string, unknown> | undefined;
              if (item?.type === 'function_call') {
                const key = String(item.id || item.call_id || calls.size);
                calls.set(key, {
                  id: String(item.call_id || item.id || key),
                  name: String(item.name || ''),
                  arguments: String(item.arguments || ''),
                  emitted: false,
                });
              }
              continue;
            }
            if (eventType === 'response.function_call_arguments.delta') {
              const key = String(payload.item_id || payload.call_id || payload.output_index || '');
              const call = calls.get(key) || { id: String(payload.call_id || key), name: String(payload.name || ''), arguments: '', emitted: false };
              const delta = String(payload.delta || '');
              call.arguments += delta;
              calls.set(key, call);
              yield { type: 'tool_call.arguments.delta', id: call.id, delta };
              continue;
            }
            if (eventType === 'response.output_item.done') {
              const item = payload.item as Record<string, unknown> | undefined;
              if (item?.type === 'function_call') {
                const key = String(item.id || item.call_id || payload.output_index || '');
                const call = calls.get(key) || {
                  id: String(item.call_id || item.id || key),
                  name: String(item.name || ''),
                  arguments: String(item.arguments || ''),
                  emitted: false,
                };
                call.id = String(item.call_id || call.id);
                call.name = String(item.name || call.name);
                call.arguments = typeof item.arguments === 'string' ? item.arguments : call.arguments;
                if (!call.emitted) {
                  call.emitted = true;
                  yield { type: 'tool_call.started', id: call.id, name: call.name };
                  if (call.arguments && call.arguments !== '{}') {
                    yield { type: 'tool_call.arguments.delta', id: call.id, delta: call.arguments };
                  }
                  yield { type: 'tool_call.completed', id: call.id, name: call.name, arguments: call.arguments };
                }
                calls.set(key, call);
              }
              continue;
            }
            if (eventType === 'response.completed') {
              completed = true;
              const usage = this.normalizeUsage(payload.response ?? payload);
              if (usage) yield { type: 'usage.updated', usage };
              continue;
            }
            if (eventType === 'response.failed' || eventType === 'response.incomplete' || eventType === 'error') {
              const errorPayload = (payload.error as Record<string, unknown> | undefined) || {};
              const responseObj = payload.response && typeof payload.response === 'object'
                ? (payload.response as Record<string, unknown>).error as Record<string, unknown> | undefined
                : undefined;
              streamError = this.extractText(errorPayload.message)
                || this.extractText(responseObj?.message)
                || this.extractText(payload.message)
                || eventType;
            }
          }
        }
      }
      if (streamError) {
        yield { type: 'response.failed', error: `[LLM Error] ${streamError}` };
      } else if (!completed) {
        yield { type: 'response.failed', error: '[LLM Error] Responses stream ended before response.completed.' };
      } else if (!emittedContent && calls.size === 0) {
        yield { type: 'response.failed', error: '[Error] Empty Responses stream.' };
      } else {
        yield { type: 'response.completed' };
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async *emitNonStreaming(json: Record<string, unknown>): AsyncIterable<NormalizedProviderEvent> {
    const usage = this.normalizeUsage(json.usage ?? json.response ?? json);
    if (usage) yield { type: 'usage.updated', usage };
    for (const summary of this.extractResponsesReasoningSummaries(json)) {
      yield { type: 'reasoning.summary.done', summary };
    }
    const text = this.extractResponsesText(json);
    let emitted = false;
    if (text) {
      emitted = true;
      yield { type: 'text.delta', delta: text };
    }
    for (const itemRaw of Array.isArray(json.output) ? json.output : []) {
      const item = itemRaw as Record<string, unknown>;
      if (item.type !== 'function_call') continue;
      emitted = true;
      const id = String(item.call_id || item.id || '');
      const name = String(item.name || '');
      yield { type: 'tool_call.started', id, name };
      const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {});
      if (args && args !== '{}') yield { type: 'tool_call.arguments.delta', id, delta: args };
      yield { type: 'tool_call.completed', id, name, arguments: args };
    }
    if (!emitted && isContentPolicyBlocked(json)) {
      yield { type: 'response.failed', error: '[Error] Content policy refusal (content_filter).' };
      return;
    }
    yield { type: 'response.completed' };
  }

  normalizeUsage(value: unknown): ActualApiUsage | null {
    return normalizeProviderUsage(value);
  }

  normalizeHeaders(headers: Headers | Record<string, string>): ProviderResponseMetadata {
    return normalizeProviderHeaders(headers);
  }

  private extractResponsesText(json: Record<string, unknown>): string {
    const direct = this.extractText(json.output_text);
    if (direct) return direct;
    const chunks: string[] = [];
    const output = Array.isArray(json.output) ? json.output : [];
    for (const itemRaw of output) {
      const item = itemRaw as Record<string, unknown>;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const blockRaw of item.content) {
          const block = blockRaw as Record<string, unknown>;
          if (block.type === 'output_text' || block.type === 'text' || block.type === 'refusal') {
            const text = this.extractText(block.text || block.refusal || block.content);
            if (text) chunks.push(text);
          }
        }
      }
    }
    return chunks.join('') || this.extractChatCompletionText(json);
  }

  private extractChatCompletionText(json: Record<string, unknown>): string {
    const choices = Array.isArray(json.choices) ? json.choices as Array<Record<string, unknown>> : [];
    const choice = choices[0] || {};
    const message = choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {};
    return this.extractText(message.content)
      || this.extractText(message.refusal)
      || this.extractText(choice.text)
      || this.extractText(json.output_text)
      || this.extractText(json.output);
  }

  private extractResponsesReasoningSummaries(json: Record<string, unknown>): string[] {
    const summaries: string[] = [];
    for (const itemRaw of Array.isArray(json.output) ? json.output : []) {
      const item = itemRaw as Record<string, unknown>;
      if (item.type !== 'reasoning') continue;
      for (const partRaw of Array.isArray(item.summary) ? item.summary : []) {
        const part = partRaw as Record<string, unknown>;
        const text = this.extractText(part.text || part.summary_text || part.content);
        if (text && !summaries.includes(text)) summaries.push(text);
      }
    }
    return summaries;
  }

  private extractText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(item => this.extractText(item)).join('');
    if (typeof value !== 'object') return String(value);
    const record = value as Record<string, unknown>;
    if (typeof record.value === 'string') return record.value;
    if (typeof record.text === 'string') return record.text;
    if (record.text && typeof record.text === 'object') return this.extractText(record.text);
    if (typeof record.output_text === 'string') return record.output_text;
    if (typeof record.refusal === 'string') return record.refusal;
    if (record.content !== undefined) return this.extractText(record.content);
    return '';
  }
}
