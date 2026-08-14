export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingBudgets,
  Tool,
  ToolCall as AgentToolCall,
  ToolResultMessage,
  Transport,
} from './stream-types';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from './stream-types';

export type StreamFn = (
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type AgentMessage = Message;
export type AgentTool = Tool & {
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
    content: Array<TextContent | ImageContent>;
    details?: unknown;
    terminate?: boolean;
  }>;
  executionMode?: 'sequential' | 'parallel';
  /**
   * 是否可与兄弟 tool call 并发执行（DSH isConcurrencySafe 语义的静态落地）。
   * 缺省为 false（独占）：有副作用的工具（write/edit/bash/browser_* 等）必须串行，
   * 只有只读工具（read/glob/grep/web_search/pwd 等）显式声明 true 才允许并行。
   * 这是 Newmark 从 DSH 学习的并发安全分级，避免盲目 Promise.all 导致副作用工具竞态。
   */
  concurrencySafe?: boolean;
};

export type QueueMode = 'all' | 'one-at-a-time';

export interface ContextTransformResult {
  messages: AgentMessage[];
  replacementMessages?: AgentMessage[];
}

export type ContextTransformOutput = AgentMessage[] | ContextTransformResult;

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: 'off' | string;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
}

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export interface AgentLoopConfig {
  state: AgentState;
  streamFn: StreamFn;
  convertToLlm: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<ContextTransformOutput>;
  resolveTools?: () => AgentTool[] | Promise<AgentTool[]>;
  emit: (event: AgentEvent) => Promise<void> | void;
  getSteeringMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
  getFollowUpMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
  closeSteeringMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
  closeFollowUpMessages?: () => Promise<AgentMessage[]> | AgentMessage[];
  reopenMessageQueues?: () => void;
  shouldStopAfterTurn?: (context: { message: AgentMessage; toolResults: AgentMessage[]; context: { messages: AgentMessage[] }; newMessages: AgentMessage[] }) => Promise<boolean> | boolean;
  toolExecution?: 'sequential' | 'parallel';
}

export type AgentContext = Context;
export type AgentToolResult = ToolResultMessage;
export type BeforeToolCallContext = unknown;
export type BeforeToolCallResult = unknown;
export type AfterToolCallContext = unknown;
export type AfterToolCallResult = unknown;
export type AgentLoopTurnUpdate = unknown;
export type PrepareNextTurnContext = unknown;
