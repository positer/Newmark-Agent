import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent as KernelAgent } from '../core/agentKernel/agent';
import { createAssistantMessageEventStream } from '../core/agentKernel/stream-types';
import type { AgentMessage, AgentTool, AssistantMessage, Model } from '../core/agentKernel/types';
import { LLMProvider } from '../llm/provider';

type ProviderConfig = {
  id?: string;
  name?: string;
  base_url?: string;
  api_key?: string;
  protocol?: string;
  enabled?: boolean;
  models?: Array<string | { name?: string; enabled?: boolean; max_tokens?: number }>;
};

type ConfigFile = {
  models?: {
    providers?: { value?: ProviderConfig[] } | ProviderConfig[];
    openai_api_mode?: { value?: string } | string;
  };
};

type Timing = { name: string; start: number; end: number };

const TOOL_NAMES = ['parallel_probe_alpha', 'parallel_probe_beta', 'parallel_probe_gamma', 'parallel_probe_delta'];
const TOOL_KIND = String(process.env.NEWMARK_REAL_TOOL_KIND || 'read').trim().toLowerCase();
const TOOL_DELAY_MS = positiveInt(process.env.NEWMARK_REAL_TOOL_DELAY_MS, 800);
const REQUEST_TIMEOUT_MS = positiveInt(process.env.NEWMARK_REAL_TOOL_TIMEOUT_MS, 180000);
const EXPECTED_MARKER = 'NEWMARK_REAL_TOOL_CONCURRENCY_OK';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function valueOf<T>(value: { value?: T } | T | undefined): T | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) && 'value' in value
    ? (value as { value?: T }).value
    : value as T | undefined;
}

function readProvider(): { provider: ProviderConfig; model: string; apiMode: 'chat_stream' | 'chat' | 'responses' } {
  const configPath = process.env.NEWMARK_REAL_TOOL_CONFIG
    || path.join(os.homedir(), '.Newmark', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ConfigFile;
  const providers = valueOf(config.models?.providers) || [];
  const requestedProvider = String(process.env.NEWMARK_REAL_TOOL_PROVIDER || 'APInebula').trim();
  const requestedModel = String(process.env.NEWMARK_REAL_TOOL_MODEL || 'gpt-5.4-mini').trim();
  const provider = providers.find(item => item.enabled !== false
    && (String(item.id || '') === requestedProvider || String(item.name || '') === requestedProvider))
    || providers.find(item => item.enabled !== false && (item.models || []).some(model => {
      const name = typeof model === 'string' ? model : String(model.name || '');
      return name === requestedModel && (typeof model === 'string' || model.enabled !== false);
    }));
  if (!provider) throw new Error(`Configured real provider not found for ${requestedProvider}/${requestedModel}.`);
  if (!provider.api_key || !provider.base_url) throw new Error(`Configured provider ${provider.name || provider.id || requestedProvider} has no usable credential or endpoint.`);
  const configuredModel = (provider.models || []).find(model => {
    const name = typeof model === 'string' ? model : String(model.name || '');
    return name === requestedModel && (typeof model === 'string' || model.enabled !== false);
  });
  if (!configuredModel) throw new Error(`Configured model not found: ${requestedModel}.`);
  const configuredMode = String(process.env.NEWMARK_REAL_TOOL_API_MODE || valueOf(config.models?.openai_api_mode) || 'chat').trim();
  const apiMode = configuredMode === 'responses' || configuredMode === 'chat_stream' ? configuredMode : 'chat';
  return { provider, model: requestedModel, apiMode };
}

function providerMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.map(message => {
    if (message.role === 'user') return { role: 'user', content: message.content };
    if (message.role === 'toolResult') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: message.content.map(item => item.type === 'text' ? item.text : '[image]').join('\n'),
      };
    }
    const toolCalls = message.content
      .filter(item => item.type === 'toolCall')
      .map(item => ({
        id: String((item as { id?: string }).id || ''),
        type: 'function',
        function: {
          name: String((item as { name?: string }).name || ''),
          arguments: JSON.stringify((item as { arguments?: unknown }).arguments || {}),
        },
      }));
    const text = message.content.filter(item => item.type === 'text').map(item => String((item as { text?: string }).text || '')).join('');
    return { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  });
}

function providerTools(tools: Array<Pick<AgentTool, 'name' | 'description' | 'parameters'>>): Array<Record<string, unknown>> {
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function maxOverlap(timings: Timing[]): number {
  const points = timings.flatMap(item => [
    { at: item.start, delta: 1 },
    { at: item.end, delta: -1 },
  ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let max = 0;
  for (const point of points) {
    active += point.delta;
    max = Math.max(max, active);
  }
  return max;
}

async function main(): Promise<void> {
  const selected = readProvider();
  const provider = new LLMProvider(
    String(selected.provider.name || selected.provider.id || 'real-provider'),
    String(selected.provider.base_url),
    String(selected.provider.api_key),
    selected.provider.protocol === 'anthropic' ? 'anthropic' : 'openai',
    selected.apiMode,
    true,
    REQUEST_TIMEOUT_MS,
  );
  const model: Model = {
    id: selected.model,
    name: selected.model,
    api: selected.apiMode,
    provider: String(selected.provider.name || selected.provider.id || 'real-provider'),
    baseUrl: String(selected.provider.base_url),
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 2048,
  };
  const timings: Timing[] = [];
  let active = 0;
  let observedMaxActive = 0;
  let providerTurns = 0;
  const toolBatchSizes: number[] = [];
  const probeNames = TOOL_KIND === 'subagent' ? ['SubAgent'] : TOOL_NAMES;
  const tools: AgentTool[] = probeNames.map(name => ({
    name,
    label: name,
    description: TOOL_KIND === 'subagent'
      ? 'Create one independent SubAgent concurrency probe. Call four times in the same assistant response with unique name and prompt values.'
      : `Independent read-only concurrency probe ${name}. Call exactly once when requested.`,
    parameters: TOOL_KIND === 'subagent'
      ? { type: 'object', properties: { name: { type: 'string' }, prompt: { type: 'string' } }, required: ['name', 'prompt'], additionalProperties: false }
      : { type: 'object', properties: {}, additionalProperties: false },
    concurrencySafe: true,
    executionMode: 'parallel',
    execute: async () => {
      const start = Date.now();
      active += 1;
      observedMaxActive = Math.max(observedMaxActive, active);
      await new Promise(resolve => setTimeout(resolve, TOOL_DELAY_MS));
      active -= 1;
      const end = Date.now();
      const timingName = TOOL_KIND === 'subagent' ? `SubAgent-${timings.length + 1}` : name;
      timings.push({ name: timingName, start, end });
      return { content: [{ type: 'text', text: `${timingName}:ok` }] };
    },
  }));
  const kernel = new KernelAgent({
    initialState: {
      model,
      systemPrompt: [
        'You are executing a deterministic tool-concurrency test.',
        TOOL_KIND === 'subagent'
          ? 'On the first turn, call the SubAgent tool exactly four times in ONE assistant response, using names worker-alpha, worker-beta, worker-gamma, worker-delta and a short unique prompt for each.'
          : `On the first turn, call all four tools (${TOOL_NAMES.join(', ')}) exactly once in ONE assistant response.`,
        'The calls are independent. Do not wait for one tool before issuing another. Do not write explanatory text before the calls.',
        `After all four results are present, reply with exactly ${EXPECTED_MARKER}.`,
      ].join('\n'),
      tools,
    },
    toolExecution: 'parallel',
    shouldStopAfterTurn: ({ message }) => message.role === 'assistant' && !message.content.some(item => item.type === 'toolCall'),
    streamFn: async (_model, context, options) => {
      providerTurns += 1;
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          let text = '';
          const calls: Array<{ type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }> = [];
          for await (const token of provider.chatStreamWithTools(
            selected.model,
            providerMessages(context.messages),
            context.systemPrompt || '',
            0,
            2048,
            providerTools(context.tools || []),
            options?.signal,
            'low',
          )) {
            if (token.type === 'text' && token.text) text += token.text;
            if (token.type === 'tool_call' && token.toolCall) {
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(token.toolCall.arguments || '{}') as Record<string, unknown>; } catch {}
              calls.push({ type: 'toolCall', id: token.toolCall.id, name: token.toolCall.name, arguments: args });
            }
          }
          toolBatchSizes.push(calls.length);
          const content = [...(text ? [{ type: 'text' as const, text }] : []), ...calls];
          const message: AssistantMessage = {
            role: 'assistant', content, api: selected.apiMode, provider: model.provider, model: selected.model,
            usage: emptyUsage(), stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.now(),
          };
          stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (error) {
          const publicMessage = error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-***') : String(error);
          const message: AssistantMessage = {
            role: 'assistant', content: [{ type: 'text', text: `[Error] ${publicMessage}` }], api: selected.apiMode,
            provider: model.provider, model: selected.model, usage: emptyUsage(), stopReason: 'error', errorMessage: publicMessage, timestamp: Date.now(),
          };
          stream.push({ type: 'error', reason: 'error', error: message });
        }
      })();
      return stream;
    },
  });

  const started = Date.now();
  await kernel.prompt('Run the four independent tools now, in one parallel tool-call batch.');
  const elapsedMs = Date.now() - started;
  const executedNames = timings.map(item => item.name).sort();
  const expectedExecutedCount = TOOL_NAMES.length;
  const finalText = kernel.state.messages
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.role === 'assistant' ? message.content : [])
    .filter(item => item.type === 'text')
    .map(item => String((item as { text?: string }).text || ''))
    .join('\n');
  const overlap = Math.max(observedMaxActive, maxOverlap(timings));
  const sanitizedFinalPreview = finalText.replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-***').slice(0, 600);
  const summary = {
    ok: overlap >= TOOL_NAMES.length && toolBatchSizes[0] === TOOL_NAMES.length,
    provider: String(selected.provider.name || selected.provider.id || 'real-provider'),
    model: selected.model,
    apiMode: selected.apiMode,
    toolKind: TOOL_KIND,
    providerTurns,
    toolBatchSizes,
    executedNames,
    delayMs: TOOL_DELAY_MS,
    elapsedMs,
    maxOverlap: overlap,
    markerSeen: finalText.includes(EXPECTED_MARKER),
    finalPreview: sanitizedFinalPreview,
  };
  console.log(JSON.stringify(summary));
  assert.equal(executedNames.length, expectedExecutedCount, 'real model executes every requested probe exactly once');
  assert.equal(toolBatchSizes[0], TOOL_NAMES.length, 'real model emits all four independent calls in the first assistant tool batch');
  assert.equal(overlap, TOOL_NAMES.length, 'all four real-model tool calls overlap in execution');
  assert.ok(finalText.includes(EXPECTED_MARKER), 'real model consumes all receipts and returns the completion marker');
}

void main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message.replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-***'));
  process.exitCode = 1;
});
