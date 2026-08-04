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
import { estimateRequestTokens, normalizeProviderUsage, defaultProviderTransport, providerAbortError, providerErrorText, isContentPolicyBlocked } from './provider-events';
import { normalizeProviderHeaders } from './provider-headers';
import { openAIToolName, openAIChatMessages } from './chat-messages';

const CHAT_SYSTEM_ROLE = 'system';

/**
 * OpenAI-compatible Chat Completions adapter. Serializes a normalized request
 * to `/chat/completions` and normalizes the SSE stream back into
 * `NormalizedProviderEvent`.
 */
export class ChatCompletionsAdapter implements ModelProviderAdapter {
  readonly providerId: string;
  readonly apiMode = 'chat_completions' as const;

  constructor(providerId: string) {
    this.providerId = providerId;
  }

  async getModelCapabilities(model: string): Promise<ModelCapabilities> {
    // Capability probing is handled by the validation service; the adapter
    // returns the static contract.
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
    const messages: Array<Record<string, unknown>> = [
      ...(request.systemPrompt ? [{ role: CHAT_SYSTEM_ROLE, content: request.systemPrompt }] : []),
      ...openAIChatMessages(request.messages as unknown as Array<Record<string, unknown>>),
    ];

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      tools: this.serializeTools(request.tools),
      tool_choice: 'auto',
    };
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;

    const base = request.baseUrl.replace(/\/+$/, '');
    return {
      url: `${base}/chat/completions`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.apiKey}`,
      },
      body,
    };
  }

  private serializeTools(tools: NormalizedTool[]): unknown[] {
    return tools
      .map(tool => ({
        type: 'function',
        function: {
          name: openAIToolName(tool.function.name),
          description: tool.function.description,
          parameters: tool.function.parameters || { type: 'object', properties: {}, required: [] },
        },
      }));
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
      const json = await response.json() as Record<string, unknown>;
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
    let currentToolCall: { id: string; name: string; arguments: string } | null = null;
    let contentPolicyBlocked = false;
    let emittedContent = false;
    let emittedTool = false;
    try {
      while (true) {
        if (signal.aborted) throw providerAbortError(signal);
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) =>
          setTimeout(() => reject(new Error('Stream read timeout')), 30000)
        );
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          let json: Record<string, unknown>;
          try { json = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          if (json.usage) {
            const usage = this.normalizeUsage(json.usage);
            if (usage) yield { type: 'usage.updated', usage };
          }
          if (isContentPolicyBlocked(json)) contentPolicyBlocked = true;
          const choices = Array.isArray(json.choices) ? json.choices : [];
          const delta = (choices[0] as Record<string, unknown> | undefined)?.delta as Record<string, unknown> | undefined;
          if (!delta) continue;
          if (delta.reasoning_content) {
            const reasoning = this.extractText(delta.reasoning_content);
            if (reasoning) yield { type: 'reasoning.summary.delta', delta: reasoning };
          }
          const textDelta = this.extractText(delta.content);
          if (textDelta) {
            emittedContent = true;
            yield { type: 'text.delta', delta: textDelta };
          }
          const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          for (const raw of toolCalls) {
            const tc = raw as Record<string, unknown>;
            const fn = tc.function && typeof tc.function === 'object' ? tc.function as Record<string, unknown> : {};
            if (tc.id) {
              if (currentToolCall) {
                emittedTool = true;
                yield { type: 'tool_call.completed', id: currentToolCall.id, name: currentToolCall.name, arguments: currentToolCall.arguments };
              }
              currentToolCall = {
                id: String(tc.id || ''),
                name: openAIToolName(String(fn.name || '')),
                arguments: String(fn.arguments || ''),
              };
              yield { type: 'tool_call.started', id: currentToolCall.id, name: currentToolCall.name };
            } else if (fn.arguments && currentToolCall) {
              currentToolCall.arguments += String(fn.arguments);
              yield { type: 'tool_call.arguments.delta', id: currentToolCall.id, delta: String(fn.arguments) };
            }
          }
        }
      }
      if (currentToolCall && currentToolCall.arguments) {
        emittedTool = true;
        yield { type: 'tool_call.completed', id: currentToolCall.id, name: currentToolCall.name, arguments: currentToolCall.arguments };
      } else if (!emittedContent && !emittedTool && contentPolicyBlocked) {
        yield { type: 'response.failed', error: '[Error] Content policy refusal (content_filter).' };
        return;
      }
      yield { type: 'response.completed' };
    } finally {
      reader.releaseLock();
    }
  }

  private async *emitNonStreaming(json: Record<string, unknown>): AsyncIterable<NormalizedProviderEvent> {
    const usage = this.normalizeUsage(json.usage);
    if (usage) yield { type: 'usage.updated', usage };
    const choices = Array.isArray(json.choices) ? json.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const message = choice?.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : {};
    const reasoning = this.extractText(message.reasoning_content);
    if (reasoning) yield { type: 'reasoning.summary.delta', delta: reasoning };
    const text = this.extractText(message.content) || this.extractText(choice?.text);
    if (text) yield { type: 'text.delta', delta: text };
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const raw of toolCalls) {
      const tc = raw as Record<string, unknown>;
      const fn = tc.function && typeof tc.function === 'object' ? tc.function as Record<string, unknown> : {};
      const id = String(tc.id || '');
      const name = openAIToolName(String(fn.name || ''));
      yield { type: 'tool_call.started', id, name };
      const args = String(fn.arguments || '{}');
      if (args && args !== '{}') yield { type: 'tool_call.arguments.delta', id, delta: args };
      yield { type: 'tool_call.completed', id, name, arguments: args };
    }
    if (!text && toolCalls.length === 0 && isContentPolicyBlocked(json)) {
      yield { type: 'response.failed', error: '[Error] Content policy refusal (content_filter).' };
      return;
    }
    yield { type: 'response.completed' };
  }

  normalizeUsage(value: unknown): ActualApiUsage | null {
    const normalized = normalizeProviderUsage(value);
    if (!normalized) return null;
    return normalized;
  }

  normalizeHeaders(headers: Headers | Record<string, string>): ProviderResponseMetadata {
    return normalizeProviderHeaders(headers);
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
