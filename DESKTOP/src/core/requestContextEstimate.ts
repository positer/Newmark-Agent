/** A local estimate of the actual submitted prompt, never a billing/tokenizer claim. */
export interface RequestContextEstimate {
  requestId: string;
  runId: string;
  /** Immutable runtime branch that owned this model request. */
  branchId: string;
  /** Content hash of the actual submitted system/messages/tools payload. */
  contextHash: string;
  model: string;
  at: string;
  estimatedTokens: number;
  longHistoryTokens: number;
  buildBlockTokens: number;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  hasImages: boolean;
  messageCount: number;
  inputTokens?: number;
  cacheReadTokens?: number;
}

function textTokens(text: string): number {
  const nonAscii = text.length - text.replace(/[\u0080-\uFFFF]/g, '').length;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii);
}

export function estimateSubmittedContext(
  messages: Array<Record<string, unknown>>,
  systemPrompt: string,
  tools: unknown[],
  buildBlockStart: number,
): Omit<RequestContextEstimate, 'requestId' | 'runId' | 'model' | 'at' | 'branchId' | 'contextHash'> {
  let longHistoryTokens = 0;
  let buildBlockTokens = 0;
  let hasImages = false;
  const boundary = Math.max(0, Math.min(messages.length, buildBlockStart));
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    let content = '';
    if (typeof message.content === 'string') content = message.content;
    else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!item || typeof item !== 'object') continue;
        const part = item as Record<string, unknown>;
        if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
          // Image tokens depend on provider/model/resolution. Base64 size is
          // not token usage; expose incomplete local estimation explicitly.
          hasImages = true;
        } else if (typeof part.text === 'string') content += part.text;
        else content += JSON.stringify(part);
      }
    } else if (message.content) content = JSON.stringify(message.content);
    const calls = Array.isArray(message.tool_calls) ? JSON.stringify(message.tool_calls) : '';
    const count = 6 + textTokens(content) + textTokens(calls)
      + (calls ? Math.ceil(calls.length / 6) : 0)
      + textTokens(String(message.name || '') + String(message.tool_call_id || ''));
    if (index < boundary) longHistoryTokens += count;
    else buildBlockTokens += count;
  }
  const systemPromptTokens = systemPrompt ? 6 + textTokens(systemPrompt) : 0;
  const toolText = tools.length ? JSON.stringify(tools) : '';
  const toolSchemaTokens = toolText ? textTokens(toolText) + Math.ceil(toolText.length / 6) : 0;
  return {
    estimatedTokens: longHistoryTokens + buildBlockTokens + systemPromptTokens + toolSchemaTokens,
    longHistoryTokens, buildBlockTokens, systemPromptTokens, toolSchemaTokens,
    hasImages, messageCount: messages.length,
  };
}
