import { LLMProvider } from '../llm/provider';
import { Agent } from './agent';
import { ProviderProtocol } from './config';
import { StreamToken } from './types';
import * as fs from 'fs';
import * as path from 'path';
import { terminalTakeoverWorkspaceId } from '../tools/terminalTakeover';
import { evaluateToolPolicy } from './toolPolicy';

type NativeAgentConstructor = new (options?: Record<string, unknown>) => NativeAgentInstance;

interface PublicStreamFilterState {
  insideThink: boolean;
  thinkPending: string;
  hiddenLine: boolean;
  atLineStart: boolean;
  linePrefixPending: string;
}

const publicStreamFilters = new WeakMap<Agent, PublicStreamFilterState>();
const HIDDEN_LINE_PREFIXES = [
  'reasoning:',
  'reasoning：',
  'reasoning_content:',
  'reasoning_content：',
  'thinking:',
  'thinking：',
  'thinking_content:',
  'thinking_content：',
  'thinking_delta:',
  'thinking_delta：',
  'thinking_start:',
  'thinking_start：',
  'thinking_end:',
  'thinking_end：',
  'analysis:',
  'analysis：',
];

function partialMarkerSuffix(value: string, marker: string): string {
  const lower = value.toLowerCase();
  const target = marker.toLowerCase();
  for (let length = Math.min(value.length, marker.length - 1); length > 0; length--) {
    if (lower.slice(-length) === target.slice(0, length)) return value.slice(-length);
  }
  return '';
}

export function filterPublicAssistantDelta(agent: Agent, delta: string): string {
  const state = publicStreamFilters.get(agent) || {
    insideThink: false,
    thinkPending: '',
    hiddenLine: false,
    atLineStart: true,
    linePrefixPending: '',
  };
  let input = state.thinkPending + String(delta || '');
  state.thinkPending = '';
  let withoutThink = '';
  while (input) {
    if (state.insideThink) {
      const closeIndex = input.toLowerCase().indexOf('</think>');
      if (closeIndex < 0) {
        state.thinkPending = partialMarkerSuffix(input, '</think>');
        input = '';
        continue;
      }
      input = input.slice(closeIndex + '</think>'.length);
      state.insideThink = false;
      continue;
    }
    const openIndex = input.toLowerCase().indexOf('<think');
    if (openIndex < 0) {
      const suffix = partialMarkerSuffix(input, '<think');
      withoutThink += input.slice(0, input.length - suffix.length);
      state.thinkPending = suffix;
      input = '';
      continue;
    }
    withoutThink += input.slice(0, openIndex);
    const tagEnd = input.indexOf('>', openIndex);
    if (tagEnd < 0) {
      state.thinkPending = input.slice(openIndex);
      input = '';
      continue;
    }
    state.insideThink = true;
    input = input.slice(tagEnd + 1);
  }

  let visible = '';
  for (const character of withoutThink) {
    if (state.hiddenLine) {
      if (character === '\n') {
        state.hiddenLine = false;
        state.atLineStart = true;
        state.linePrefixPending = '';
      }
      continue;
    }
    if (!state.atLineStart) {
      visible += character;
      if (character === '\n') state.atLineStart = true;
      continue;
    }

    if (character === '\n') {
      visible += state.linePrefixPending + character;
      state.linePrefixPending = '';
      state.atLineStart = true;
      continue;
    }
    state.linePrefixPending += character;
    const candidate = state.linePrefixPending.trimStart().toLowerCase();
    const couldBeHidden = HIDDEN_LINE_PREFIXES.some(prefix => prefix.startsWith(candidate));
    const isHidden = HIDDEN_LINE_PREFIXES.some(prefix => candidate === prefix);
    if (isHidden) {
      state.linePrefixPending = '';
      state.hiddenLine = true;
      state.atLineStart = false;
    } else if (!couldBeHidden) {
      visible += state.linePrefixPending;
      state.linePrefixPending = '';
      state.atLineStart = false;
    }
  }
  publicStreamFilters.set(agent, state);
  // Streaming deltas are positional text fragments. Trimming each fragment
  // corrupts normal prose (for example `Hello` + ` world`). Full-message
  // persistence still uses sanitizeAssistantOutput(), which trims once at the
  // final boundary.
  return agent.sanitizeAssistantStreamingOutput(visible);
}

export function resetPublicAssistantDeltaFilter(agent: Agent): void {
  publicStreamFilters.delete(agent);
}

interface NativeAgentInstance {
  state: {
    systemPrompt: string;
    model: KernelModel;
    tools: KernelTool[];
    messages: KernelMessage[];
  };
  subscribe(listener: (event: KernelAgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  prompt(message: KernelMessage | KernelMessage[]): Promise<void>;
  steer(message: unknown): boolean;
  followUp(message: unknown): boolean;
  abort(): void;
}

interface KernelModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface KernelTextContent {
  type: 'text';
  text: string;
}

interface KernelImageContent {
  type: 'image';
  image?: string;
  imagePath?: string;
  mimeType?: string;
}

interface KernelToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type KernelContent = KernelTextContent | KernelImageContent | KernelToolCall | { type: string; [key: string]: unknown };

type KernelMessage =
  | { role: 'user'; content: string | Array<KernelTextContent | KernelImageContent>; timestamp: number; clientMessageId?: string; runId?: string }
  | { role: 'assistant'; content: KernelContent[]; api: string; provider: string; model: string; usage: KernelUsage; stopReason: string; errorMessage?: string; timestamp: number }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: Array<KernelTextContent | KernelImageContent>; details?: unknown; isError: boolean; timestamp: number };

interface KernelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface KernelTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<KernelTextContent | KernelImageContent>; details: unknown; terminate?: boolean }>;
  executionMode?: 'sequential' | 'parallel';
}

type KernelAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: KernelMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: KernelMessage; toolResults: KernelMessage[] }
  | { type: 'message_start'; message: KernelMessage }
  | { type: 'message_update'; message: KernelMessage; assistantMessageEvent: KernelAssistantMessageEvent }
  | { type: 'message_end'; message: KernelMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean };

type KernelAssistantMessageEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'toolcall_end'; toolCall: KernelToolCall }
  | { type: string; [key: string]: unknown };

interface KernelStreamCompat {
  createAssistantMessageEventStream: () => KernelAssistantMessageEventStream;
}

interface KernelAssistantMessageEventStream extends AsyncIterable<KernelAssistantMessageEvent> {
  push(event: KernelAssistantMessageEvent): void;
}

interface KernelProviderEventStreamEvent {
  type: 'start' | 'text_start' | 'text_delta' | 'text_end' | 'thinking_start' | 'thinking_delta' | 'thinking_end' | 'toolcall_start' | 'toolcall_delta' | 'toolcall_end' | 'done' | 'error';
  [key: string]: unknown;
}

const EMPTY_USAGE: KernelUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export async function runAgentKernel(agent: Agent): Promise<StreamToken[]> {
  const provider = agent.engineModel();
  if (!provider) {
    agent.status = 'error';
    agent.saveWorkspaceConversationState();
    return [{ type: 'text', text: '[Error] No LLM configured. Add provider in Settings > Models.' }];
  }

  const [{ Agent: NativeAgent }, KernelStreamCompat] = await Promise.all([
    import('./agentKernel/index.js') as Promise<{ Agent: NativeAgentConstructor }>,
    import('./agentKernel/stream-types.js') as Promise<KernelStreamCompat>,
  ]);

  const systemPrompt = agent.buildSystemPrompt();
  const { temperature, maxTokens } = provider.intelligenceConfig(agent.intelligence);
  const newmarkTools = agent.subagentToolDefinitions(agent.tools.definitions(agent.mode));
  const kernel = new NativeAgent({
    streamFn: streamWithNewmarkProvider(agent, provider, KernelStreamCompat, newmarkTools),
    toolExecution: 'sequential',
    convertToLlm: (messages: KernelMessage[]) => messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
    transformContext: async (messages: KernelMessage[], signal?: AbortSignal) => transformContext(agent, provider, messages, signal),
    shouldStopAfterTurn: async ({ message }: { message: KernelMessage }) => shouldStopAfterTurn(agent, message),
  });

  kernel.state.systemPrompt = systemPrompt;
  kernel.state.model = toKernelModel(agent);
  kernel.state.tools = toKernelTools(agent, newmarkTools);
  kernel.state.messages = toKernelMessages(agent);
  agent.attachAgentKernelRuntime(kernel);

  const tokens: StreamToken[] = [];
  const runOnce = async (promptMessages: KernelMessage[], appendPromptToAgentHistory: boolean) => {
    let lastAssistant = '';
    const unsubscribe = kernel.subscribe(async event => {
      await handleKernelEvent(agent, event, tokens);
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastAssistant = KernelMessageText(event.message);
      }
    });
    try {
      if (appendPromptToAgentHistory) {
        for (const msg of promptMessages) {
          if (msg.role !== 'user') continue;
          agent.chatMessages.push({ role: 'user', content: KernelMessageText(msg), mode: agent.modeName(), model: agent.model, timestamp: agent.nowLabel() });
          agent.history.push(toHistoryMessage(msg));
        }
        agent.saveWorkspaceConversationState();
      }
      await kernel.prompt(promptMessages);
      return lastAssistant;
    } finally {
      unsubscribe();
    }
  };

  try {
    const modelBeforeKernelRun = agent.model;
    let lastAssistant = await runOnce([], false);
    if (modelBeforeKernelRun && modelBeforeKernelRun !== agent.model && !tokens.some(t => t.text?.includes('[Model fallback]'))) {
      tokens.unshift({ type: 'text', text: `[Model fallback] ${modelBeforeKernelRun} unavailable; switched to ${agent.model}.` });
    }
    if (agent.isLlmErrorText(lastAssistant)) {
      const previous = agent.switchToFallbackModel();
      if (previous) {
        const notice = `[Model fallback] ${previous} unavailable; switched to ${agent.model}.`;
        tokens.push({ type: 'text', text: notice });
        agent.recordWorkStatus(notice);
        kernel.state.model = toKernelModel(agent);
        lastAssistant = await runOnce([], false);
      }
    }
    const maxGoalContinuations = Math.max(0, Math.floor(agent.config.getNum('agent', 'goal_max_continuations') || 0));
    let goalContinuations = 0;
    while (agent.mode === 'goal' && agent.goal && !agent.goal.paused && !agent.goal.checkComplete(lastAssistant)) {
      if (maxGoalContinuations > 0 && goalContinuations >= maxGoalContinuations) {
        const warning = `[Goal paused] Reached automatic continuation limit (${maxGoalContinuations}) without completion.`;
        agent.goal.paused = true;
        tokens.push({ type: 'text', text: `\n${warning}` });
        agent.recordWorkStatus(warning);
        break;
      }
      goalContinuations += 1;
      const goalPrompt = `Continue working toward this goal:\n${agent.goal.objective}\n\nProgress made. What remains?`;
      lastAssistant = await runOnce([{ role: 'user', content: goalPrompt, timestamp: Date.now() }], true);
      if (agent.goal.checkComplete(lastAssistant)) {
        tokens.push({ type: 'text', text: '\n[Goal Complete]' });
        break;
      }
    }
  } finally {
    agent.attachAgentKernelRuntime(null);
  }
  agent.status = 'idle';
  agent.saveWorkspaceConversationState();
  return agent.sanitizeVisibleTokens(tokens);

  function streamWithNewmarkProvider(currentAgent: Agent, currentProvider: LLMProvider, compat: KernelStreamCompat, cachedTools: unknown[]) {
    return async (model: KernelModel, context: { systemPrompt?: string; messages: KernelMessage[]; tools?: KernelTool[] }, options?: { signal?: AbortSignal }) => {
      const stream = compat.createAssistantMessageEventStream();
      void (async () => {
        const partial = assistantMessage(model, [], 'stop');
        stream.push({ type: 'start', partial } as KernelProviderEventStreamEvent);
        let text = '';
        let thinking = '';
        let contentIndex = 0;
        const finalContent: KernelContent[] = [];
        let textStarted = false;
        try {
          const newmarkMessages = fromKernelMessages(context.messages);
          for await (const token of currentProvider.chatStreamWithTools(
            currentAgent.model,
            newmarkMessages,
            context.systemPrompt || '',
            temperature,
            maxTokens,
            cachedTools,
            options?.signal,
          )) {
            if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1') console.error(`[NewmarkKernel] provider-token type=${token.type}`);
            if (options?.signal?.aborted) break;
            if (token.reasoningContent) {
              const delta = token.reasoningContent.slice(thinking.length);
              thinking = token.reasoningContent;
              if (delta) {
                stream.push({ type: 'thinking_delta', contentIndex, delta, partial: assistantMessage(model, thinking ? [{ type: 'text', text }] : [], 'stop') } as KernelProviderEventStreamEvent);
              }
            }
            if (token.type === 'text' && token.text) {
              if (!textStarted) {
                textStarted = true;
                stream.push({ type: 'text_start', contentIndex, partial: assistantMessage(model, [{ type: 'text', text }], 'stop') } as KernelProviderEventStreamEvent);
              }
              text += token.text;
              const partialText = assistantMessage(model, [{ type: 'text', text }], 'stop');
              stream.push({ type: 'text_delta', contentIndex, delta: token.text, partial: partialText } as KernelProviderEventStreamEvent);
            } else if (token.type === 'tool_call' && token.toolCall) {
              if (textStarted) {
                stream.push({ type: 'text_end', contentIndex, content: text, partial: assistantMessage(model, [{ type: 'text', text }], 'stop') } as KernelProviderEventStreamEvent);
                finalContent.push({ type: 'text', text });
                contentIndex++;
                textStarted = false;
              }
              const toolCall: KernelToolCall = {
                type: 'toolCall',
                id: token.toolCall.id || `call_${Date.now()}`,
                name: token.toolCall.name,
                arguments: parseToolArgs(token.toolCall.arguments),
              };
              const contents: KernelContent[] = text ? [{ type: 'text', text }, toolCall] : [toolCall];
              finalContent.push(toolCall);
              stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: assistantMessage(model, contents, 'toolUse') } as KernelProviderEventStreamEvent);
              if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1') console.error('[NewmarkKernel] toolcall-pushed');
              contentIndex++;
            }
          }
          if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1') console.error('[NewmarkKernel] provider-loop-complete');
          if (options?.signal?.aborted) {
            const aborted = assistantMessage(model, text ? [{ type: 'text', text }] : [], 'aborted');
            stream.push({ type: 'done', reason: 'aborted', message: aborted } as KernelProviderEventStreamEvent);
            return;
          }
          if (textStarted) finalContent.push({ type: 'text', text });
          const final = assistantMessage(model, finalContent, finalContent.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop');
          stream.push({ type: 'done', reason: final.stopReason, message: final } as KernelProviderEventStreamEvent);
          if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1') console.error(`[NewmarkKernel] done-pushed reason=${final.stopReason}`);
        } catch (error) {
          if (options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            const aborted = assistantMessage(model, text ? [{ type: 'text', text }] : [], 'aborted');
            stream.push({ type: 'done', reason: 'aborted', message: aborted } as KernelProviderEventStreamEvent);
            return;
          }
          const final = assistantMessage(model, [{ type: 'text', text: `[Error] ${error instanceof Error ? error.message : String(error)}` }], 'error');
          final.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: 'error', reason: 'error', error: final } as KernelProviderEventStreamEvent);
        }
      })();
      return stream;
    };
  }
}

async function transformContext(agent: Agent, provider: LLMProvider, messages: KernelMessage[], signal?: AbortSignal): Promise<KernelMessage[]> {
  if (signal?.aborted) return messages;
  if (!agent.config.getBool('context', 'auto_compress')) return messages;
  const newmarkMessages = fromKernelMessages(messages, false);
  const beforeCompression = JSON.stringify(newmarkMessages);
  await agent.maybeCompress(newmarkMessages, provider, signal);
  if (signal?.aborted) return messages;
  if (JSON.stringify(newmarkMessages) === beforeCompression) return messages;
  return toKernelMessagesFromHistory(newmarkMessages, agent);
}

async function shouldStopAfterTurn(agent: Agent, message: KernelMessage): Promise<boolean> {
  const text = KernelMessageText(message);
  if (message.role === 'assistant' && (message.stopReason === 'error' || agent.isLlmErrorText(text))) {
    const previous = agent.switchToFallbackModel();
    if (previous) {
      agent.recordWorkStatus(`[Model fallback] ${previous} unavailable; switched to ${agent.model}.`);
      return false;
    }
  }
  if (agent.mode === 'goal' && agent.goal && message.role === 'assistant') {
    if (agent.goal.checkComplete(text)) return true;
    if (!agent.goal.paused) {
      // pi handles follow-up queues in the conversation kernel; single process() remains one prompt.
      return true;
    }
  }
  return message.role === 'assistant' && !message.content.some(c => c.type === 'toolCall');
}

async function handleKernelEvent(agent: Agent, event: KernelAgentEvent, tokens: StreamToken[]): Promise<void> {
  switch (event.type) {
    case 'message_start':
      if (event.message.role === 'user') {
        const text = KernelMessageText(event.message);
        if (event.message.clientMessageId) {
          const imageCount = Array.isArray(event.message.content)
            ? event.message.content.filter(item => item.type === 'image').length
            : 0;
          const display = imageCount ? `${text}${text ? '\n\n' : ''}[${imageCount} image attachment${imageCount === 1 ? '' : 's'}]` : text;
          const history = toHistoryMessage(event.message);
          agent.persistGuideMessage(event.message.clientMessageId, display, event.message.runId, history.content);
        }
        agent.notifyAgentKernelUserMessageStart(text, event.message.clientMessageId);
      } else if (event.message.role === 'assistant') {
        resetPublicAssistantDeltaFilter(agent);
      }
      break;
    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        const text = filterPublicAssistantDelta(agent, String(event.assistantMessageEvent.delta || ''));
        if (text) {
          tokens.push({ type: 'text', text });
          agent.emitWorkEvent({ type: 'text', content: text });
        }
      } else if (event.assistantMessageEvent.type === 'thinking_delta') {
        // Hidden reasoning is intentionally not surfaced in the chat transcript.
      } else if (event.assistantMessageEvent.type === 'toolcall_end') {
        const tool = event.assistantMessageEvent.toolCall as KernelToolCall;
        tokens.push({ type: 'tool_call', text: '', toolCall: { id: tool.id, name: tool.name, arguments: JSON.stringify(tool.arguments || {}) } });
      }
      break;
    case 'tool_execution_start': {
      agent.emitWorkEvent({
        type: 'tool_call',
        content: `Calling tool ${event.toolName}`,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1') console.error('[NewmarkKernel] tool-work-event-emitted');
      agent.appendWorkflowMessage(`Calling tool ${event.toolName}`, event.toolName, undefined, false);
      if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1') console.error('[NewmarkKernel] tool-workflow-appended');
      break;
    }
    case 'turn_end':
      break;
    case 'tool_execution_end': {
      const text = toolResultText(event.result);
      if (toolResultTerminates(event.result)) {
        tokens.push({ type: 'text', text });
      }
      agent.emitWorkEvent({
        type: 'tool_result',
        content: `Tool ${event.toolName} completed.`,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      agent.appendWorkflowMessage(`Tool ${event.toolName} completed.`, event.toolName, undefined, false);
      break;
    }
    case 'message_end':
      if (event.message.role === 'assistant') {
        const text = agent.sanitizeAssistantOutput(KernelMessageText(event.message));
        if (text && event.message.stopReason !== 'aborted') {
          agent.chatMessages.push({ role: 'assistant', content: text, mode: agent.modeName(), model: agent.model, timestamp: agent.nowLabel() });
          const historyMessage = toHistoryMessage(event.message);
          // Keep tool-call metadata, but never replay a hidden-reasoning line
          // that was deliberately removed from the public completed message.
          historyMessage.content = text;
          agent.history.push(historyMessage);
          agent.saveWorkspaceConversationState();
        }
        resetPublicAssistantDeltaFilter(agent);
      } else if (event.message.role === 'toolResult') {
        agent.history.push(toHistoryMessage(event.message));
        agent.saveWorkspaceConversationState();
      }
      break;
  }
}

function toKernelModel(agent: Agent): KernelModel {
  const m = agent.config.findModel(agent.model);
  const api = apiForProtocol(m?.provider_protocol || 'openai', agent.config.openAIApiMode());
  return {
    id: agent.model || 'unknown',
    name: m?.display || agent.model || 'unknown',
    api,
    provider: m?.provider || 'newmark',
    baseUrl: m?.provider_url || '',
    reasoning: !!m?.thinking,
    input: m?.vision ? ['text', 'image'] : ['text'],
    cost: {
      input: Number(m?.cost_per_1k_input || 0) * 1000,
      output: Number(m?.cost_per_1k_output || 0) * 1000,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: Number(m?.max_tokens || 0) || 128000,
    maxTokens: 4096,
  };
}

function apiForProtocol(protocol: ProviderProtocol, openAIMode: string): string {
  if (protocol === 'anthropic') return 'anthropic-messages';
  if (protocol === 'github_models') return 'github-models-inference';
  if (openAIMode === 'responses') return 'openai-responses';
  return 'openai-completions';
}

function toKernelTools(agent: Agent, definitions?: unknown[]): KernelTool[] {
  const tools = definitions || agent.subagentToolDefinitions(agent.tools.definitions(agent.mode));
  return tools.map((tool: any): KernelTool => {
    const fn = tool?.function || {};
    return {
      name: String(fn.name || ''),
      label: String(fn.name || ''),
      description: String(fn.description || ''),
      parameters: fn.parameters || { type: 'object', properties: {}, required: [] },
      prepareArguments: parseToolArgs,
      executionMode: 'sequential' as const,
      execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
        if (signal?.aborted) throw abortError();
        const name = String(fn.name || '');
        const args = JSON.stringify(params || {});
        const rawText = await executeNewmarkTool(agent, name, args, signal);
        if (signal?.aborted) throw abortError();
        const visionImagePath = computerUseVisionImagePath(agent, name, rawText);
        const directImage = imageInspectDataUrl(name, rawText);
        const text = sanitizeVisualToolText(name, rawText);
        const content: Array<KernelTextContent | KernelImageContent> = [{ type: 'text', text }];
        if (visionImagePath) content.push({ type: 'image', imagePath: visionImagePath, mimeType: imageMimeForPath(visionImagePath) });
        if (directImage) content.push({ type: 'image', image: directImage, mimeType: 'image/png' });
        const terminate = shouldTerminateAfterToolResult(name);
        return { content, details: { tool: name, ok: !text.startsWith('[Error]'), terminate, visionImagePath: visionImagePath || undefined }, terminate };
      },
    };
  }).filter((tool: KernelTool) => !!tool.name);
}

function abortError(): Error {
  const error = new Error('Agent run aborted');
  error.name = 'AbortError';
  return error;
}

function sanitizeVisualToolText(name: string, text: string): string {
  if (name !== 'computer_use' && name !== 'image_inspect') return text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (name === 'computer_use') delete parsed.vision_image_path;
    if (name === 'image_inspect') delete parsed.image_data_url;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

function imageInspectDataUrl(name: string, text: string): string {
  if (name !== 'image_inspect') return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const dataUrl = String(parsed.image_data_url || '');
    return dataUrl.startsWith('data:image/') ? dataUrl : '';
  } catch {
    return '';
  }
}

function computerUseVisionImagePath(agent: Agent, name: string, text: string): string {
  if (name !== 'computer_use') return '';
  const model = agent.config.findModel(agent.model);
  if (!model?.vision) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.action !== 'observe' && parsed.action !== 'app_observe') return '';
    const screenshotPath = String(parsed.vision_image_path || '');
    if (!screenshotPath) return '';
    return screenshotPath;
  } catch {
    return '';
  }
}

async function executeNewmarkTool(agent: Agent, name: string, args: string, signal?: AbortSignal): Promise<string> {
  const wsDir = agent.workspace.current?.path || agent.rootPath;
  let parsedArgs: Record<string, unknown> = {};
  try { parsedArgs = JSON.parse(args || '{}') as Record<string, unknown>; } catch {}
  const policy = evaluateToolPolicy({ name, mode: agent.mode, isSubagent: agent.isSubagentRuntime, args: parsedArgs });
  if (!policy.allowed) return policy.reason || `[permission] Blocked: ${name}`;
  const checked = async (value: string | Promise<string>): Promise<string> => {
    const result = await value;
    if (signal?.aborted) throw abortError();
    return result;
  };
  if (name === 'task') return (await agent.handleSubagentEnvelope(args)).output;
  if (name === 'subagent_send') return (await agent.handleSubagentContinueEnvelope(args)).output;
  if (name === 'subagent_list') return agent.handleSubagentListEnvelope(args).output;
  if (name === 'subagent_read') return agent.handleSubagentReadEnvelope(args).output;
  if (name === 'subagent_result') return agent.handleSubagentResultEnvelope(args).output;
  if (name === 'subagent_close') return agent.handleSubagentCloseEnvelope(args).output;
  if (name === 'linked_plan') return agent.handleLinkedPlanTool(args);
  if (name === 'question') {
    if (agent.config.getStr('agent', 'option_feedback') === 'fully_autonomous') return '[question] Disabled by fully_autonomous option feedback.';
    agent.handleQuestion(args);
    return '[Options sent]';
  }
  if (name === 'skill_download') {
    const result = await agent.tools.execute(name, args, wsDir, {
      mode: agent.mode,
      workspacePath: wsDir,
      conversationId: agent.activeConversationId || 'default',
      actorId: agent.runtimeActorId,
      workspaceId: terminalTakeoverWorkspaceId(wsDir),
      backend: process.env.NEWMARK_WSL_DISTRO ? 'wsl' : (process.platform === 'win32' ? 'windows' : process.platform),
      signal,
    });
    if (!result.startsWith('[permission]') && !result.startsWith('[tool disabled]') && !result.startsWith('[Subagent sandbox]')) {
      if (signal?.aborted) throw abortError();
      agent.refreshSkills();
    }
    return result;
  }
  if (name === 'image_generate') return await checked(agent.handleImageGeneration(args, signal));
  if (name === 'image_inspect') return await checked(agent.handleImageInspect(args));
  if (name === 'flow_run') return await checked(agent.handleFlowRun(args, signal));
  if (name.startsWith('memory_lab_')) return await checked(agent.handleMemoryLabTool(name, args, signal));
  if (name.startsWith('automation_')) return await checked(agent.handleAutomationTool(name, args, signal));
  const result = await agent.tools.execute(name, args, wsDir, {
    mode: agent.mode,
    workspacePath: wsDir,
    conversationId: agent.activeConversationId || 'default',
    actorId: agent.runtimeActorId,
    workspaceId: terminalTakeoverWorkspaceId(wsDir),
    backend: process.env.NEWMARK_WSL_DISTRO ? 'wsl' : (process.platform === 'win32' ? 'windows' : process.platform),
    allowEphemeralVisionImage: name === 'computer_use' && !!agent.config.findModel(agent.model)?.vision,
    signal,
  });
  if (signal?.aborted) throw abortError();
  trackFileDiff(agent, name, args);
  return result;
}

function shouldTerminateAfterToolResult(name: string): boolean {
  return name === 'flow_run'
    || name.startsWith('automation_')
    || name.startsWith('memory_lab_')
    || name === 'question';
}

function toKernelMessages(agent: Agent): KernelMessage[] {
  return toKernelMessagesFromHistory(agent.history, agent);
}

function toKernelMessagesFromHistory(history: Array<Record<string, unknown>>, agent: Agent): KernelMessage[] {
  return history.flatMap(msg => {
    const role = String(msg.role || '');
    if (role === 'system') {
      return [{
        role: 'user',
        content: `[Preserved context record]\n${String(msg.content || '')}`,
        timestamp: Date.now(),
      } as KernelMessage];
    }
    if (role === 'user') {
      const clientMessageId = typeof msg.client_message_id === 'string' ? String(msg.client_message_id) : undefined;
      const runId = typeof msg.run_id === 'string' ? String(msg.run_id) : undefined;
      const parts = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
      if (!parts.length) return [{ role: 'user', content: String(msg.content || ''), timestamp: Date.now(), clientMessageId, runId } as KernelMessage];
      const content: Array<KernelTextContent | KernelImageContent> = [];
      for (const part of parts) {
        if (part.type === 'text') content.push({ type: 'text', text: String(part.text || '') });
        if (part.type === 'image_url') {
          const image = part.image_url as Record<string, unknown> | undefined;
          const url = image && typeof image === 'object' ? String(image.url || '') : '';
          if (url.startsWith('data:image/')) content.push({ type: 'image', image: url, mimeType: url.slice(5, url.indexOf(';')) || 'image/png' });
        }
      }
      return [{ role: 'user', content, timestamp: Date.now(), clientMessageId, runId } as KernelMessage];
    }
    if (role === 'assistant') {
      const content: KernelContent[] = [];
      const text = String(msg.content || '');
      if (text) content.push({ type: 'text', text });
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const raw of toolCalls) {
        const tc = raw as Record<string, any>;
        const fn = tc.function || {};
        content.push({ type: 'toolCall', id: String(tc.id || `call_${Date.now()}`), name: String(fn.name || ''), arguments: parseToolArgs(fn.arguments) });
      }
      return [assistantMessage(toKernelModel(agent), content, content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop') as KernelMessage];
    }
    if (role === 'tool') {
      const existingParts = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
      const existingText = existingParts
        .filter(part => part?.type === 'text')
        .map(part => String(part.text || ''))
        .join('');
      const content: Array<KernelTextContent | KernelImageContent> = [{ type: 'text', text: existingText || String(msg.content || '') }];
      const imagePath = typeof msg.vision_image_path === 'string' ? String(msg.vision_image_path) : '';
      if (imagePath) content.push({ type: 'image', imagePath, mimeType: imageMimeForPath(imagePath) });
      return [{
        role: 'toolResult',
        toolCallId: String(msg.tool_call_id || ''),
        toolName: String(msg.name || ''),
        content,
        isError: false,
        timestamp: Date.now(),
      } as KernelMessage];
    }
    return [];
  });
}

function fromKernelMessages(messages: KernelMessage[], includeEphemeralImages = true): Array<Record<string, unknown>> {
  return messages.flatMap(message => [toHistoryMessage(message, includeEphemeralImages)]);
}

function toHistoryMessage(message: KernelMessage, includeEphemeralImages = false): Record<string, unknown> {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return {
      role: 'user',
      content: message.content,
      client_message_id: message.clientMessageId,
      run_id: message.runId,
    };
    const content: Array<Record<string, unknown>> = [];
    for (const part of message.content as KernelContent[]) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      if (part.type === 'image' && typeof part.image === 'string' && part.image.startsWith('data:image/')) content.push({ type: 'image_url', image_url: { url: part.image } });
    }
    return { role: 'user', content, client_message_id: message.clientMessageId, run_id: message.runId };
  }
  if (message.role === 'assistant') {
    const text = KernelMessageText(message);
    const toolCalls = message.content.filter((c): c is KernelToolCall => c.type === 'toolCall').map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
    }));
    return toolCalls.length
      ? { role: 'assistant', content: text, tool_calls: toolCalls }
      : { role: 'assistant', content: text };
  }
  const imagePath = message.content.find((c): c is KernelImageContent => c.type === 'image')?.imagePath || '';
  const directImage = message.content.find((c): c is KernelImageContent => c.type === 'image')?.image || '';
  const imagePart = includeEphemeralImages ? imagePathToOpenAIContentPart(imagePath || directImage) : null;
  const text = KernelMessageText(message);
  return {
    role: 'tool',
    tool_call_id: message.toolCallId,
    name: message.toolName,
    content: imagePart ? [{ type: 'text', text }, imagePart] : includeEphemeralImages && directImage && directImage.startsWith('data:image/') ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: directImage } }] : text,
  };
}

function imagePathToOpenAIContentPart(imagePath: string): Record<string, unknown> | null {
  try {
    const url = imagePathToDataUrl(imagePath);
    return url ? { type: 'image_url', image_url: { url } } : null;
  } catch {
    return null;
  }
}

export const agentKernelRunnerInternals = { imagePathToOpenAIContentPart, imageMimeForPath, toKernelMessagesFromHistory };

function imagePathToDataUrl(imagePath: string): string {
  if (!imagePath || !fs.existsSync(imagePath)) return '';
  try {
    const data = fs.readFileSync(imagePath).toString('base64');
    return `data:${imageMimeForPath(imagePath)};base64,${data}`;
  } finally {
    try { fs.unlinkSync(imagePath); } catch {}
  }
}

function imageMimeForPath(imagePath: string): string {
  const ext = path.extname(String(imagePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function assistantMessage(model: KernelModel, content: KernelContent[], stopReason: string): Extract<KernelMessage, { role: 'assistant' }> {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    timestamp: Date.now(),
  };
}

function parseToolArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(args));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function KernelMessageText(message: KernelMessage): string {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content;
    return message.content.filter((c): c is KernelTextContent => c.type === 'text').map(c => c.text || '').join('');
  }
  if (message.role === 'assistant') {
    return message.content.filter((c): c is KernelTextContent => c.type === 'text').map(c => c.text || '').join('');
  }
  return message.content.filter((c): c is KernelTextContent => c.type === 'text').map(c => c.text || '').join('');
}

function toolResultText(result: unknown): string {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content : [];
  return content.map(item => item && typeof item === 'object' ? String((item as Record<string, unknown>).text || '') : '').join('') ||
    JSON.stringify(result || '');
}

function toolResultTerminates(result: unknown): boolean {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (record.terminate === true) return true;
  const details = record.details && typeof record.details === 'object' ? record.details as Record<string, unknown> : {};
  return details.terminate === true;
}

function trackFileDiff(agent: Agent, name: string, args: string): void {
  if (name !== 'edit' && name !== 'write') return;
  try {
    const params = JSON.parse(args);
    const fp = params.path || '';
    if (!fp) return;
    if (name === 'write') {
      agent.fileDiffs.push({ path: fp, oldContent: '', newContent: params.content || '' });
    } else {
      agent.fileDiffs.push({ path: fp, oldContent: params.old_str || '', newContent: params.new_str || '' });
    }
  } catch {
    // Ignore malformed tool args for diff summaries.
  }
}
