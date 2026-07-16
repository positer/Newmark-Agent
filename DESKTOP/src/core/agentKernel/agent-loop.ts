import {
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
} from './types';

type MutableContext = { systemPrompt?: string; messages: AgentMessage[]; tools?: AgentTool[] };

export async function runAgentLoop(prompts: AgentMessage[], config: AgentLoopConfig, signal?: AbortSignal): Promise<AgentMessage[]> {
  throwIfAborted(signal);
  const newMessages: AgentMessage[] = [];
  const context: MutableContext = {
    systemPrompt: config.state.systemPrompt,
    messages: config.state.messages.slice(),
    tools: config.state.tools.slice(),
  };
  await emit(config, { type: 'agent_start' });
  await emit(config, { type: 'turn_start' });
  for (const prompt of prompts) {
    throwIfAborted(signal);
    await emit(config, { type: 'message_start', message: prompt });
    await emit(config, { type: 'message_end', message: prompt });
    context.messages.push(prompt);
    newMessages.push(prompt);
  }
  await runLoop(context, newMessages, config, signal, false);
  return newMessages;
}

export async function runAgentLoopContinue(config: AgentLoopConfig, signal?: AbortSignal): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [];
  const context: MutableContext = {
    systemPrompt: config.state.systemPrompt,
    messages: config.state.messages.slice(),
    tools: config.state.tools.slice(),
  };
  if (context.messages.length === 0) throw new Error('Cannot continue: no messages in context');
  if (context.messages[context.messages.length - 1].role === 'assistant') throw new Error('Cannot continue from message role: assistant');
  await emit(config, { type: 'agent_start' });
  await emit(config, { type: 'turn_start' });
  await runLoop(context, newMessages, config, signal, true);
  return newMessages;
}

async function runLoop(
  context: MutableContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal?: AbortSignal,
  drainBeforeFirstTurn = false,
): Promise<void> {
  let firstTurnAfterPrompt = true;
  // A Guide accepted during the prompt/runner attachment window must not be
  // merged into the provider request that is already starting. The prompt
  // path consumes it at the first safe boundary; continue() has no fresh
  // prompt, so its pre-existing queue remains the context for its first turn.
  let pendingMessages = drainBeforeFirstTurn ? await drain(config.getSteeringMessages) : [];
  while (true) {
    throwIfAborted(signal);
    let hasMoreToolCalls = true;
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      throwIfAborted(signal);
      if (!firstTurnAfterPrompt) await emit(config, { type: 'turn_start' });
      firstTurnAfterPrompt = false;

      for (const message of pendingMessages) {
        await emit(config, { type: 'message_start', message });
        await emit(config, { type: 'message_end', message });
        context.messages.push(message);
        newMessages.push(message);
      }
      pendingMessages = [];

      if (config.resolveTools) context.tools = (await config.resolveTools()).slice();
      const assistant = await streamAssistantResponse(context, config, signal);
      context.messages.push(assistant);
      newMessages.push(assistant);

      if (assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
        await emit(config, { type: 'turn_end', message: assistant, toolResults: [] });
        await emit(config, { type: 'agent_end', messages: newMessages });
        return;
      }

      const toolCalls = assistant.content.filter((content): content is AgentToolCall => content.type === 'toolCall');
      const toolResults = toolCalls.length ? await executeToolCalls(toolCalls, context, config, signal) : [];
      hasMoreToolCalls = toolResults.some(result => result.role === 'toolResult' && result.details && typeof result.details === 'object' && (result.details as Record<string, unknown>).terminate === true) ? false : toolResults.length > 0;
      for (const result of toolResults) {
        await emit(config, { type: 'message_start', message: result });
        context.messages.push(result);
        newMessages.push(result);
        await emit(config, { type: 'message_end', message: result });
      }
      await emit(config, { type: 'turn_end', message: assistant, toolResults });

      // Steering is a user-visible part of the active turn. Always consume it
      // at the safe boundary before a provider/tool turn is allowed to stop.
      pendingMessages = await drain(config.getSteeringMessages);
      if (pendingMessages.length) {
        hasMoreToolCalls = true;
        continue;
      }

      if (config.shouldStopAfterTurn) {
        const shouldStop = await config.shouldStopAfterTurn({ message: assistant, toolResults, context, newMessages });
        if (!shouldStop) {
          hasMoreToolCalls = true;
          continue;
        }
        pendingMessages = await closeAndDrain(config.closeSteeringMessages, config.getSteeringMessages);
        if (!pendingMessages.length) pendingMessages = await closeAndDrain(config.closeFollowUpMessages, config.getFollowUpMessages);
        if (pendingMessages.length) {
          config.reopenMessageQueues?.();
          hasMoreToolCalls = true;
          continue;
        }
        await emit(config, { type: 'agent_end', messages: newMessages });
        return;
      }
    }

    const followUps = await drain(config.getFollowUpMessages);
    if (followUps.length) {
      pendingMessages = followUps;
      continue;
    }
    pendingMessages = await closeAndDrain(config.closeSteeringMessages, config.getSteeringMessages);
    if (!pendingMessages.length) pendingMessages = await closeAndDrain(config.closeFollowUpMessages, config.getFollowUpMessages);
    if (pendingMessages.length) {
      config.reopenMessageQueues?.();
      continue;
    }
    break;
  }
  await emit(config, { type: 'agent_end', messages: newMessages });
}

async function streamAssistantResponse(context: MutableContext, config: AgentLoopConfig, signal?: AbortSignal): Promise<AssistantMessage> {
  throwIfAborted(signal);
  const llmMessages = await config.convertToLlm(context.messages);
  const transformed = config.transformContext ? await config.transformContext(llmMessages, signal) : llmMessages;
  const stream = await config.streamFn(config.state.model, {
    systemPrompt: context.systemPrompt,
    messages: transformed,
    tools: context.tools,
  }, { signal });
  let final: AssistantMessage | null = null;
  let current: AssistantMessage = assistantMessage(config);
  await emit(config, { type: 'message_start', message: current });
  for await (const event of stream) {
    throwIfAborted(signal);
    if (event.type === 'done') {
      final = event.message;
      current = final;
    } else if (event.type === 'error') {
      final = event.error;
      current = final;
    } else if ('partial' in event) {
      current = event.partial;
      if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1' && event.type === 'toolcall_end') console.error('[NewmarkKernel] toolcall-consumed');
      await emit(config, { type: 'message_update', message: current, assistantMessageEvent: event });
    }
  }
  final = final || current;
  await emit(config, { type: 'message_end', message: final });
  return final;
}

async function executeToolCalls(toolCalls: AgentToolCall[], context: MutableContext, config: AgentLoopConfig, signal?: AbortSignal): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];
  const tools = context.tools || [];
  for (const call of toolCalls) {
    throwIfAborted(signal);
    const tool = tools.find(candidate => candidate.name === call.name);
    if (!tool) {
      results.push(toolResult(call, `Tool "${call.name}" not found`, true));
      continue;
    }
    const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
    if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1') console.error(`[NewmarkKernel] tool-execution-start name=${call.name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'tool'}`);
    await emit(config, { type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args });
    if (process.env.NEWMARK_PROVIDER_DIAGNOSTICS === '1') console.error('[NewmarkKernel] tool-execution-event-complete');
    try {
      const result = await tool.execute(call.id, args, signal);
      throwIfAborted(signal);
      const message = toolResult(call, result.content, false, result.details, result.terminate);
      results.push(message);
      await emit(config, { type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content: result.content, details: result.details, terminate: result.terminate }, isError: false });
    } catch (error) {
      const message = toolResult(call, error instanceof Error ? error.message : String(error), true);
      results.push(message);
      await emit(config, { type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content: message.content }, isError: true });
    }
  }
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
  const error = new Error('Agent run aborted');
  error.name = 'AbortError';
  throw error;
}

function toolResult(call: AgentToolCall, content: string | Array<TextContent | { type: 'image'; image?: string; imagePath?: string; mimeType?: string }>, isError: boolean, details?: unknown, terminate?: boolean): ToolResultMessage {
  const mergedDetails = terminate ? { ...(details && typeof details === 'object' ? details as Record<string, unknown> : {}), terminate } : details;
  const normalizedContent: Array<TextContent | ImageContent> = [];
  if (typeof content === 'string') {
    normalizedContent.push({ type: 'text', text: content });
  } else {
    for (const item of content) {
      if (item.type === 'image') {
        const imageValue = item.image && String(item.image).trim() ? item.image : item.imagePath;
        normalizedContent.push({ type: 'image', image: String(item.image || ''), imagePath: String(item.imagePath || imageValue || ''), mimeType: item.mimeType } as ImageContent & { imagePath?: string });
      } else {
        normalizedContent.push(item);
      }
    }
  }
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: normalizedContent,
    details: mergedDetails,
    isError,
    timestamp: Date.now(),
  };
}

function assistantMessage(config: AgentLoopConfig): AssistantMessage {
  const model = config.state.model;
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function drain(fn?: () => Promise<AgentMessage[]> | AgentMessage[]): Promise<AgentMessage[]> {
  if (!fn) return [];
  const value = await fn();
  return Array.isArray(value) ? value : [];
}

async function closeAndDrain(
  close?: () => Promise<AgentMessage[]> | AgentMessage[],
  fallback?: () => Promise<AgentMessage[]> | AgentMessage[],
): Promise<AgentMessage[]> {
  return drain(close || fallback);
}

async function emit(config: AgentLoopConfig, event: AgentEvent): Promise<void> {
  await config.emit(event);
}
