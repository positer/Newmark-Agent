export * from './provider-adapter';
export * from './provider-events';
export * from './provider-headers';
export * from './retry-policy';
export { ChatCompletionsAdapter } from './chat-completions.adapter';
export { ResponsesAdapter } from './responses.adapter';

import { ModelProviderAdapter, NormalizedAgentRequest } from './provider-adapter';
import { ChatCompletionsAdapter } from './chat-completions.adapter';
import { ResponsesAdapter } from './responses.adapter';

export function createProviderAdapter(providerId: string, apiMode: 'chat_completions' | 'responses' | 'custom'): ModelProviderAdapter {
  if (apiMode === 'responses') return new ResponsesAdapter(providerId);
  if (apiMode === 'chat_completions') return new ChatCompletionsAdapter(providerId);
  throw new Error(`Unsupported adapter apiMode: ${apiMode}`);
}

export function normalizeAgentRequestForProvider(request: NormalizedAgentRequest, apiMode: 'chat_completions' | 'responses' | 'custom'): NormalizedAgentRequest {
  return { ...request, apiMode };
}
