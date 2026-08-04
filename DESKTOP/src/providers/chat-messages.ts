export type MessageContentPart = Record<string, unknown>;

export function openAIToolName(value: unknown): string {
  const normalized = String(value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64);
  return normalized || 'newmark_tool';
}

export function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function normalizeOpenAIContent(value: unknown): string | MessageContentPart[] {
  if (!Array.isArray(value)) return stringifyContent(value);
  const parts: MessageContentPart[] = [];
  for (const partRaw of value) {
    const part = partRaw as Record<string, unknown>;
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      parts.push({ type: 'text', text: String(part.text || '') });
    } else if (part.type === 'image_url') {
      parts.push({ type: 'image_url', image_url: part.image_url });
    }
  }
  return parts.length ? parts : '';
}

export function normalizeResponsesContent(value: unknown): string | MessageContentPart[] {
  if (!Array.isArray(value)) return stringifyContent(value);
  const parts: MessageContentPart[] = [];
  for (const partRaw of value) {
    const part = partRaw as Record<string, unknown>;
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      parts.push({ type: 'input_text', text: String(part.text || '') });
    } else if (part.type === 'image_url') {
      const image = part.image_url as Record<string, unknown> | undefined;
      const url = image && typeof image === 'object' ? String(image.url || '') : '';
      if (url) parts.push({ type: 'input_image', image_url: url });
    }
  }
  return parts.length ? parts : '';
}

/**
 * Chat Completions message serializer with history repair. Single shared
 * implementation used by LLMProvider and ChatCompletionsAdapter so the wire
 * body is identical regardless of which path delegates.
 *
 * Accepts both the conversation shape (`tool_call_id`/`call_id`/`tool_calls`
 * with nested `function`) and the normalized adapter shape
 * (`toolCallId`/`toolCalls` with flat `id`/`name`/`arguments`).
 */
export function openAIChatMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const emittedCallIds = new Set<string>();
  const consumedToolResultIndexes = new Set<number>();
  const toolResultsByCallId = new Map<string, Array<{ message: Record<string, unknown>; index: number }>>();
  for (const [index, candidate] of (messages || []).entries()) {
    if (String(candidate?.role || '') !== 'tool') continue;
    const callId = String(candidate.tool_call_id || candidate.call_id || candidate.toolCallId || '');
    if (!callId) continue;
    const entries = toolResultsByCallId.get(callId) || [];
    entries.push({ message: candidate, index });
    toolResultsByCallId.set(callId, entries);
  }
  for (const [index, msg] of (messages || []).entries()) {
    const role = String(msg.role || 'user');
    if (role === 'assistant') {
      const toolCalls: Array<Record<string, unknown>> = [];
      const rawToolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls
        : (Array.isArray(msg.toolCalls) ? msg.toolCalls : []);
      for (const [toolIndex, rawToolCall] of rawToolCalls.entries()) {
        const toolCall = rawToolCall as Record<string, unknown>;
        const fn = toolCall.function && typeof toolCall.function === 'object'
          ? toolCall.function as Record<string, unknown>
          : {};
        const name = openAIToolName(fn.name || toolCall.name);
        const callId = String(toolCall.id || toolCall.call_id || `call_newmark_${index}_${toolIndex}`);
        toolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name,
            arguments: typeof fn.arguments === 'string'
              ? fn.arguments
              : (typeof toolCall.arguments === 'string'
                ? toolCall.arguments
                : JSON.stringify(fn.arguments || toolCall.arguments || {})),
          },
        });
        emittedCallIds.add(callId);
      }
      const assistant: Record<string, unknown> = {
        role: 'assistant',
        content: normalizeOpenAIContent(msg.content),
      };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      out.push(assistant);
      // Chat Completions requires every declared call to be followed by a
      // matching tool message before the next non-tool message. Histories
      // can lose or reorder results during compression, so repair the
      // complete call group at the transport boundary.
      for (const toolCall of toolCalls) {
        const callId = String(toolCall.id || '');
        const fn = toolCall.function && typeof toolCall.function === 'object'
          ? toolCall.function as Record<string, unknown>
          : {};
        const stored = (toolResultsByCallId.get(callId) || [])
          .find(entry => entry.index > index && !consumedToolResultIndexes.has(entry.index));
        if (stored) {
          consumedToolResultIndexes.add(stored.index);
          const result = stored.message;
          out.push({
            role: 'tool',
            tool_call_id: callId,
            name: openAIToolName(result.name || fn.name || toolCall.name),
            content: stringifyContent(result.content),
          });
        } else {
          out.push({
            role: 'tool',
            tool_call_id: callId,
            name: openAIToolName(fn.name || toolCall.name),
            content: '[Newmark] Tool result unavailable; continue without it.',
          });
        }
      }
      continue;
    }
    if (role === 'tool') {
      if (consumedToolResultIndexes.has(index)) continue;
      const callId = String(msg.tool_call_id || msg.call_id || msg.toolCallId || `call_newmark_recovered_${index}`);
      const name = openAIToolName(msg.name);
      // Imported, compressed, and legacy histories may retain a tool result
      // after losing the assistant tool_calls envelope. Chat Completions
      // rejects that orphan result, so reconstruct the minimum valid pair.
      if (!emittedCallIds.has(callId)) {
        out.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: callId, type: 'function', function: { name, arguments: '{}' } }],
        });
        emittedCallIds.add(callId);
      }
      out.push({
        role: 'tool',
        tool_call_id: callId,
        name,
        content: stringifyContent(msg.content),
      });
      continue;
    }
    out.push({
      role: role === 'system' ? 'system' : 'user',
      content: normalizeOpenAIContent(msg.content),
    });
  }
  return out.length ? out : [{ role: 'user', content: '' }];
}
