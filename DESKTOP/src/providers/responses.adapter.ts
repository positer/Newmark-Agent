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
  ProviderSseDecoder,
  defaultProviderTransport,
  providerErrorText,
  providerSemanticErrorText,
  isContentPolicyBlocked,
  normalizeResponsesPayload,
  readProviderStreamChunk,
  assembleCompatibleToolArguments,
} from './provider-events';
import { normalizeProviderHeaders } from './provider-headers';
import { providerEndpoint, providerRequestHeaders } from './provider-request-compat';
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
    };
    // Omit the cap entirely for provider-owned output.
    if (Number.isFinite(request.maxOutputTokens) && request.maxOutputTokens > 0) {
      body.max_output_tokens = request.maxOutputTokens;
    }
    if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort, summary: 'auto' };
    if (request.systemPrompt) body.instructions = request.systemPrompt;
    const tools = this.serializeTools(request.tools);
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    return {
      url: providerEndpoint(request.baseUrl, '/responses'),
      headers: providerRequestHeaders('openai', request.apiKey),
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
      yield* this.emitNonStreaming(json, response.headers);
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'response.failed', error: '[Error] No response body' };
      return;
    }

    const decoder = new TextDecoder();
    const sse = new ProviderSseDecoder();
    const calls = new Map<string, { id: string; name: string; argumentParts: string[]; finalArguments?: string; status?: string }>();
    const callAliases = new Map<string, string>();
    const resolveCall = (payload: Record<string, unknown>, item: Record<string, unknown> = {}) => {
      const aliases: string[] = [];
      const itemId = item.id ?? payload.item_id;
      const callId = item.call_id ?? payload.call_id;
      if (itemId) aliases.push(`item:${itemId}`);
      if (callId) aliases.push(`call:${callId}`);
      if (payload.output_index !== undefined) aliases.push(`index:${payload.output_index}`);
      const key = aliases.map(alias => callAliases.get(alias)).find(value => value !== undefined) ?? `call_${calls.size}`;
      const call = calls.get(key) || { id: String(callId || itemId || ''), name: '', argumentParts: [] };
      if (callId) call.id = String(callId);
      if (item.name || payload.name) call.name = String(item.name || payload.name);
      calls.set(key, call);
      for (const alias of aliases) callAliases.set(alias, key);
      return call;
    };
    const reasoningSummaries = new Map<string, string>();
    let emittedContent = false;
    let completed = false;
    let streamError = '';
    let completedResponse: Record<string, unknown> | undefined;
    let emittedText = '';

    try {
      stream: while (true) {
        const { done, value } = await readProviderStreamChunk(reader, signal);
        if (done) break;
        for (const event of sse.push(decoder.decode(value, { stream: true }))) {
            if (event.data === '[DONE]') continue;
            let payload: Record<string, unknown>;
            try { payload = JSON.parse(event.data) as Record<string, unknown>; } catch { continue; }
            const eventType = String(event.event || payload.type || '');

            if (eventType === 'response.reasoning_summary_text.delta') {
              const key = `${String(payload.item_id || '')}:${String(payload.summary_index || 0)}`;
              const delta = this.extractText(payload.delta);
              if (delta) {
                emittedContent = true;
                reasoningSummaries.set(key, (reasoningSummaries.get(key) || '') + delta);
                yield { type: 'reasoning.summary.delta', delta };
              }
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
                emittedText += delta;
                yield { type: 'text.delta', delta };
              }
              continue;
            }
            if (eventType === 'response.output_item.added') {
              const item = payload.item as Record<string, unknown> | undefined;
              if (item?.type === 'function_call') {
                const call = resolveCall(payload, item);
                if (item.arguments) call.argumentParts.push(String(item.arguments));
                call.status = String(item.status || '');
              }
              continue;
            }
            if (eventType === 'response.function_call_arguments.delta') {
              const call = resolveCall(payload);
              const delta = String(payload.delta || '');
              if (delta) call.argumentParts.push(delta);
              yield { type: 'tool_call.arguments.delta', id: call.id, delta };
              continue;
            }
            if (eventType === 'response.function_call_arguments.done') {
              const call = resolveCall(payload);
              if (payload.name) call.name = String(payload.name);
              if (typeof payload.arguments === 'string') call.finalArguments = payload.arguments;
              continue;
            }
            if (eventType === 'response.output_item.done') {
              const item = payload.item as Record<string, unknown> | undefined;
              if (item?.type === 'function_call') {
                const call = resolveCall(payload, item);
                call.id = String(item.call_id || call.id);
                call.name = String(item.name || call.name);
                if (typeof item.arguments === 'string') call.finalArguments = item.arguments;
                call.status = String(item.status || '');
              }
              continue;
            }
            if (eventType === 'response.completed') {
              completedResponse = normalizeResponsesPayload(payload.response ?? payload);
              streamError = this.completionError(completedResponse, response.headers);
              completed = !streamError;
              const usage = this.normalizeUsage(completedResponse);
              if (usage) yield { type: 'usage.updated', usage };
              break stream;
            }
            if (eventType === 'response.failed' || eventType === 'response.incomplete' || eventType === 'error') {
              const usage = this.normalizeUsage(payload.response ?? payload);
              if (usage) yield { type: 'usage.updated', usage };
              const errorPayload = (payload.error as Record<string, unknown> | undefined) || {};
              const responseObj = payload.response && typeof payload.response === 'object'
                ? (payload.response as Record<string, unknown>).error as Record<string, unknown> | undefined
                : undefined;
              streamError = providerSemanticErrorText(payload.error || responseObj || payload, this.extractText(errorPayload.message)
                || this.extractText(responseObj?.message)
                || this.extractText(payload.message)
                || eventType, response.headers);
              break stream;
            }
        }
      }
      if (completedResponse && completed) {
        const snapshotText = this.extractResponsesText(completedResponse);
        if (snapshotText && snapshotText.startsWith(emittedText) && snapshotText.length > emittedText.length) {
          yield { type: 'text.delta', delta: snapshotText.slice(emittedText.length) };
          emittedText = snapshotText;
          emittedContent = true;
        }
        for (const raw of Array.isArray(completedResponse.output) ? completedResponse.output : []) {
          const item = raw as Record<string, unknown>;
          if (item.type !== 'function_call') continue;
          const call = resolveCall({}, item);
          call.id = String(item.call_id || call.id);
          call.name = String(item.name || call.name);
          if (typeof item.arguments === 'string') call.finalArguments = item.arguments;
          call.status = String(item.status || '');
        }
      }
      if (streamError) {
        yield { type: 'response.failed', error: streamError.startsWith('[LLM Error]') ? streamError : `[LLM Error] ${streamError}` };
      } else if (!completed) {
        yield { type: 'response.failed', error: '[LLM Error] Responses stream ended before response.completed.' };
      } else if (!emittedContent && calls.size === 0) {
        yield { type: 'response.failed', error: '[Error] Provider returned an empty response.' };
      } else {
        // Some compatible Responses providers omit output_item.done but still
        // complete the response. Preserve that valid tool activity and fold
        // cumulative argument snapshots before handing it to the kernel.
        const completeCalls = [...calls.values()].map(call => ({ ...call,
          argumentsJson: call.finalArguments ?? assembleCompatibleToolArguments(call.argumentParts, true) }));
        if (completeCalls.some(call => !call.id || !call.name || call.status === 'incomplete' || !this.validToolArguments(call.argumentsJson))) {
          yield { type: 'response.failed', error: '[LLM Error] Provider returned incomplete or invalid tool-call arguments.' };
          return;
        }
        for (const call of completeCalls) {
          yield { type: 'tool_call.started', id: call.id, name: call.name };
          yield { type: 'tool_call.completed', id: call.id, name: call.name, arguments: call.argumentsJson };
        }
        yield { type: 'response.completed' };
      }
    } finally {
      // Completion and consumer return are terminal even if a gateway keeps
      // the HTTP body open. Release the socket as well as the reader lock.
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
    }
  }

  private async *emitNonStreaming(json: Record<string, unknown>, headers?: Pick<Headers, 'get'>): AsyncIterable<NormalizedProviderEvent> {
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
    const error = this.completionError(json, headers);
    if (error) { yield { type: 'response.failed', error }; return; }
    const completeCalls = (Array.isArray(json.output) ? json.output : []).filter(item => item?.type === 'function_call').map(itemRaw => {
      const item = itemRaw as Record<string, unknown>;
      const id = String(item.call_id || item.id || '');
      const name = String(item.name || '');
      const args = typeof item.arguments === 'string' ? item.arguments : item.arguments ? JSON.stringify(item.arguments) : '';
      return { id, name, args, status: String(item.status || '') };
    });
    if (completeCalls.some(call => !call.id || !call.name || call.status === 'incomplete' || !this.validToolArguments(call.args))) {
      yield { type: 'response.failed', error: '[LLM Error] Provider returned incomplete or invalid tool-call arguments.' };
      return;
    }
    for (const { id, name, args } of completeCalls) {
      emitted = true;
      yield { type: 'tool_call.started', id, name };
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

  private completionError(json: Record<string, unknown>, headers?: Pick<Headers, 'get'>): string {
    const status = String(json.status || '');
    if (!json.error && (!status || status === 'completed')) return '';
    const error = json.error && typeof json.error === 'object' ? json.error as Record<string, unknown> : {};
    const incomplete = json.incomplete_details && typeof json.incomplete_details === 'object' ? json.incomplete_details as Record<string, unknown> : {};
    return providerSemanticErrorText(error, this.extractText(error.message || json.error) || `Responses response was ${status || 'unsuccessful'}${incomplete.reason ? ': ' + String(incomplete.reason) : '.'}`, headers);
  }

  private validToolArguments(value: string): boolean {
    try { const parsed = JSON.parse(value); return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed); }
    catch { return false; }
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
