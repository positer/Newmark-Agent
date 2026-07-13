import { AgentWorkEvent } from './types';
import { AgentPromptMessage, ConversationKernelRunOptions, ConversationKernelRunResult, ConversationQueueMode } from './conversationKernel';
import { TerminalTakeoverEvent, TerminalTakeoverOwnerFilter, TerminalTakeoverState } from '../tools/terminalTakeover';

export interface WslAgentWorkspace {
  id?: string;
  name: string;
  path: string;
  isInternal?: boolean;
  kind?: string;
}

export interface WslAgentPromptRequest {
  message: string | AgentPromptMessage;
  conversationId: string;
  options: ConversationKernelRunOptions;
  queueMode: ConversationQueueMode;
  workspace: WslAgentWorkspace | null;
}

export interface WslTerminalRequestBase {
  owner: TerminalTakeoverOwnerFilter;
  persistenceRoot?: string;
}

export interface WslHostToolRequest {
  requestId: string;
  tool: 'computer_use';
  args: Record<string, unknown>;
  context: {
    conversationId: string;
    workspaceId: string;
    actorId: string;
  };
}

export interface WslHostToolResult {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type WslAgentRequest =
  | { id: string; method: 'ping' }
  | { id: string; method: 'prompt'; params: WslAgentPromptRequest }
  | { id: string; method: 'abort'; params: { conversationId: string } }
  | { id: string; method: 'snapshot'; params: { conversationId: string; workspace: WslAgentWorkspace | null } }
  | { id: string; method: 'terminal_state'; params: WslTerminalRequestBase }
  | { id: string; method: 'terminal_write'; params: WslTerminalRequestBase & { sessionId: string; data: string } }
  | { id: string; method: 'terminal_resize'; params: WslTerminalRequestBase & { sessionId: string; cols: number; rows: number } }
  | { id: string; method: 'terminal_stop'; params: WslTerminalRequestBase & { sessionId: string } }
  | { id: string; method: 'terminal_detach'; params: WslTerminalRequestBase & { sessionId: string } }
  | { id: string; method: 'host_tool_result'; params: WslHostToolResult }
  | { id: string; method: 'reset' }
  | { id: string; method: 'shutdown' };

export type WslAgentResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export type WslAgentEventEnvelope =
  | { event: 'work'; data: AgentWorkEvent }
  | { event: 'terminal'; data: TerminalTakeoverEvent }
  | { event: 'host_tool_request'; data: WslHostToolRequest };

export type WslTerminalStateResult = TerminalTakeoverState[];

export interface WslAgentPromptResult extends ConversationKernelRunResult {
  backend: 'wsl';
  distro: string;
}
