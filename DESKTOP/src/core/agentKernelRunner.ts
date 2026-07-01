import { LLMProvider } from '../llm/provider';
import { Agent } from './agent';
import { ModelConfig, ProviderProtocol } from './config';
import { StreamToken } from './types';

type NativeAgentConstructor = new (options?: Record<string, unknown>) => NativeAgentInstance;

interface NativeAgentInstance {
  state: {
    systemPrompt: string;
    model: KernelModel;
    tools: KernelTool[];
    messages: KernelMessage[];
  };
  subscribe(listener: (event: KernelAgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;
  prompt(message: KernelMessage | KernelMessage[]): Promise<void>;
  steer(message: unknown): void;
  followUp(message: unknown): void;
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

interface KernelToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type KernelContent = KernelTextContent | KernelToolCall | { type: string; [key: string]: unknown };

type KernelMessage =
  | { role: 'user'; content: string | KernelTextContent[]; timestamp: number }
  | { role: 'assistant'; content: KernelContent[]; api: string; provider: string; model: string; usage: KernelUsage; stopReason: string; errorMessage?: string; timestamp: number }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: KernelTextContent[]; details?: unknown; isError: boolean; timestamp: number };

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
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: KernelTextContent[]; details: unknown; terminate?: boolean }>;
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
  const kernel = new NativeAgent({
    streamFn: streamWithNewmarkProvider(agent, provider, KernelStreamCompat),
    toolExecution: 'sequential',
    convertToLlm: (messages: KernelMessage[]) => messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'),
    transformContext: async (messages: KernelMessage[]) => transformContext(agent, provider, messages),
    shouldStopAfterTurn: async ({ message }: { message: KernelMessage }) => shouldStopAfterTurn(agent, message),
  });

  kernel.state.systemPrompt = systemPrompt;
  kernel.state.model = toKernelModel(agent);
  kernel.state.tools = toKernelTools(agent);
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
    while (agent.mode === 'goal' && agent.goal && !agent.goal.paused && !agent.goal.checkComplete(lastAssistant)) {
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

  function streamWithNewmarkProvider(currentAgent: Agent, currentProvider: LLMProvider, compat: KernelStreamCompat) {
    return async (model: KernelModel, context: { systemPrompt?: string; messages: KernelMessage[]; tools?: KernelTool[] }) => {
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
          const tools = currentAgent.tools.definitions(currentAgent.mode);
          currentAgent.recordWorkStatus('Preparing model request and available tools.');
          for await (const token of currentProvider.chatStreamWithTools(
            currentAgent.model,
            newmarkMessages,
            context.systemPrompt || '',
            temperature,
            maxTokens,
            tools,
          )) {
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
              contentIndex++;
            }
          }
          if (textStarted) finalContent.push({ type: 'text', text });
          const final = assistantMessage(model, finalContent, finalContent.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop');
          stream.push({ type: 'done', reason: final.stopReason, message: final } as KernelProviderEventStreamEvent);
        } catch (error) {
          const final = assistantMessage(model, [{ type: 'text', text: `[Error] ${error instanceof Error ? error.message : String(error)}` }], 'error');
          final.errorMessage = error instanceof Error ? error.message : String(error);
          stream.push({ type: 'error', reason: 'error', error: final } as KernelProviderEventStreamEvent);
        }
      })();
      return stream;
    };
  }
}

async function transformContext(agent: Agent, provider: LLMProvider, messages: KernelMessage[]): Promise<KernelMessage[]> {
  const newmarkMessages = fromKernelMessages(messages);
  await agent.maybeCompress(newmarkMessages, provider);
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
      if (event.message.role === 'user') agent.notifyAgentKernelUserMessageStart(KernelMessageText(event.message));
      break;
    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        const text = String(event.assistantMessageEvent.delta || '');
        if (text) {
          tokens.push({ type: 'text', text });
          agent.emitWorkEvent({ type: 'text', content: text });
        }
      } else if (event.assistantMessageEvent.type === 'thinking_delta') {
        agent.recordWorkStatus('Model reasoning is in progress.');
      } else if (event.assistantMessageEvent.type === 'toolcall_end') {
        const tool = event.assistantMessageEvent.toolCall as KernelToolCall;
        tokens.push({ type: 'tool_call', text: '', toolCall: { id: tool.id, name: tool.name, arguments: JSON.stringify(tool.arguments || {}) } });
      }
      break;
    case 'tool_execution_start': {
      const args = JSON.stringify(event.args || {});
      agent.emitWorkEvent({
        type: 'tool_call',
        content: `Calling tool ${event.toolName}`,
        toolName: event.toolName,
        toolArgs: agent.visibleToolArgs(args),
      });
      agent.appendWorkflowMessage(`Calling tool ${event.toolName}`, event.toolName, agent.visibleToolArgs(args));
      break;
    }
    case 'turn_end':
      if (event.toolResults.length > 0) {
        agent.recordWorkStatus(`Executing ${event.toolResults.length} tool call${event.toolResults.length === 1 ? '' : 's'}.`);
      }
      break;
    case 'tool_execution_end': {
      const text = toolResultText(event.result);
      tokens.push({ type: 'text', text });
      agent.recordToolResult(event.toolName, text);
      break;
    }
    case 'message_end':
      if (event.message.role === 'assistant') {
        const text = agent.sanitizeAssistantOutput(KernelMessageText(event.message));
        if (text) {
          agent.chatMessages.push({ role: 'assistant', content: text, mode: agent.modeName(), model: agent.model, timestamp: agent.nowLabel() });
          agent.history.push(toHistoryMessage(event.message));
          agent.saveWorkspaceConversationState();
        }
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
  if (openAIMode === 'responses') return 'openai-responses';
  return 'openai-completions';
}

function toKernelTools(agent: Agent): KernelTool[] {
  return agent.subagentToolDefinitions(agent.tools.definitions(agent.mode)).map((tool: any): KernelTool => {
    const fn = tool?.function || {};
    return {
      name: String(fn.name || ''),
      label: String(fn.name || ''),
      description: String(fn.description || ''),
      parameters: fn.parameters || { type: 'object', properties: {}, required: [] },
      prepareArguments: parseToolArgs,
      executionMode: 'sequential' as const,
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const name = String(fn.name || '');
        const args = JSON.stringify(params || {});
        const text = await executeNewmarkTool(agent, name, args);
        const content: KernelTextContent[] = [{ type: 'text', text }];
        return { content, details: { tool: name, ok: !text.startsWith('[Error]') } };
      },
    };
  }).filter((tool: KernelTool) => !!tool.name);
}

async function executeNewmarkTool(agent: Agent, name: string, args: string): Promise<string> {
  const wsDir = agent.workspace.current?.path || agent.rootPath;
  if (agent.isSubagentRuntime && agent.isSubagentBlockedTool(name)) {
    return `[Subagent sandbox] Tool '${name}' is disabled for subagents.`;
  }
  if (name === 'task') return (await agent.handleSubagentEnvelope(args)).output;
  if (name === 'subagent_send') return (await agent.handleSubagentContinueEnvelope(args)).output;
  if (name === 'subagent_result') return agent.handleSubagentResultEnvelope(args).output;
  if (name === 'subagent_close') return agent.handleSubagentCloseEnvelope(args).output;
  if (name === 'question') {
    if (agent.config.getStr('agent', 'option_feedback') === 'fully_autonomous') return '[question] Disabled by fully_autonomous option feedback.';
    agent.handleQuestion(args);
    return '[Options sent]';
  }
  if (name === 'skill_download') {
    const result = await agent.tools.execute(name, args, wsDir, { mode: agent.mode, workspacePath: wsDir });
    await agent.handleSkillDownload(args);
    return result;
  }
  if (name === 'flow_run') return agent.handleFlowRun(args);
  if (name.startsWith('memory_lab_')) return agent.handleMemoryLabTool(name, args);
  if (name.startsWith('automation_')) return agent.handleAutomationTool(name, args);
  const result = await agent.tools.execute(name, args, wsDir, { mode: agent.mode, workspacePath: wsDir });
  trackFileDiff(agent, name, args);
  return result;
}

function toKernelMessages(agent: Agent): KernelMessage[] {
  return toKernelMessagesFromHistory(agent.history, agent);
}

function toKernelMessagesFromHistory(history: Array<Record<string, unknown>>, agent: Agent): KernelMessage[] {
  return history.flatMap(msg => {
    const role = String(msg.role || '');
    if (role === 'user') return [{ role: 'user', content: String(msg.content || ''), timestamp: Date.now() } as KernelMessage];
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
      return [{
        role: 'toolResult',
        toolCallId: String(msg.tool_call_id || ''),
        toolName: String(msg.name || ''),
        content: [{ type: 'text', text: String(msg.content || '') }],
        isError: false,
        timestamp: Date.now(),
      } as KernelMessage];
    }
    return [];
  });
}

function fromKernelMessages(messages: KernelMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap(message => [toHistoryMessage(message)]);
}

function toHistoryMessage(message: KernelMessage): Record<string, unknown> {
  if (message.role === 'user') return { role: 'user', content: typeof message.content === 'string' ? message.content : KernelMessageText(message) };
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
  return {
    role: 'tool',
    tool_call_id: message.toolCallId,
    name: message.toolName,
    content: KernelMessageText(message),
  };
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
    return message.content.map(c => c.text || '').join('');
  }
  if (message.role === 'assistant') {
    return message.content.filter((c): c is KernelTextContent => c.type === 'text').map(c => c.text || '').join('');
  }
  return message.content.map(c => c.text || '').join('');
}

function toolResultText(result: unknown): string {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content : [];
  return content.map(item => item && typeof item === 'object' ? String((item as Record<string, unknown>).text || '') : '').join('') ||
    JSON.stringify(result || '');
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
