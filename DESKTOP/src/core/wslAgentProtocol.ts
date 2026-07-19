import { AgentWorkEvent, ConversationInputEnvelope, GuideReceipt } from './types';
import { AgentPromptMessage, ConversationKernelRunOptions, ConversationKernelRunResult, ConversationQueueMode, ConversationStopResult } from './conversationKernel';
import { ConversationRuntimeTarget } from './conversationTarget';
import { TerminalTakeoverEvent, TerminalTakeoverOwnerFilter, TerminalTakeoverState } from '../tools/terminalTakeover';
import { BrowserUseRequest } from './browserUse';
import { BrowserControlRequest } from './browserControl';
import type { AutoRouteRatingResult, ConversationSnapshot } from './agent';

export interface WslAgentWorkspace {
  id?: string;
  name: string;
  path: string;
  isInternal?: boolean;
  kind?: string;
  conversationStatePrefix?: string;
}

export interface WslAgentPromptRequest {
  message: string | AgentPromptMessage;
  target?: ConversationRuntimeTarget;
  /** @deprecated use target */
  conversationId: string;
  options: ConversationKernelRunOptions;
  queueMode: ConversationQueueMode;
  workspace: WslAgentWorkspace | null;
}

export interface WslTerminalRequestBase {
  owner: TerminalTakeoverOwnerFilter;
  persistenceRoot?: string;
}

export interface WslHostToolContext {
  conversationId: string;
  workspaceId: string;
  actorId: string;
  runtimeKey: string;
  mode?: string;
  /** Trusted runner capability; never sourced from model-authored tool arguments. */
  allowEphemeralVisionImage?: boolean;
}

interface WslHostToolRequestBase {
  requestId: string;
  context: WslHostToolContext;
}

export type WslHostToolRequest =
  | (WslHostToolRequestBase & { tool: 'browser_control'; args: BrowserControlRequest })
  | (WslHostToolRequestBase & { tool: 'computer_use'; args: Record<string, unknown> })
  | (WslHostToolRequestBase & { tool: 'browser_use'; args: BrowserUseRequest })
  | (WslHostToolRequestBase & { tool: 'automation'; args: { tool: string; payload: string } })
  | (WslHostToolRequestBase & { tool: 'terminal_takeover'; args: Record<string, unknown> });

export interface WslHostToolResult {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type WslAgentRequest =
  | { id: string; method: 'ping' }
  | { id: string; method: 'prompt'; params: WslAgentPromptRequest }
  | { id: string; method: 'abort'; params: { conversationId?: string; target?: ConversationRuntimeTarget } }
  | { id: string; method: 'stop'; params: { conversationId?: string; target?: ConversationRuntimeTarget; runId?: string } }
  | { id: string; method: 'snapshot'; params: { conversationId?: string; target?: ConversationRuntimeTarget; workspace?: WslAgentWorkspace | null } }
  | { id: string; method: 'rewind'; params: { target: ConversationRuntimeTarget; messageIndex: number } }
  | { id: string; method: 'guide'; params: { target: ConversationRuntimeTarget; envelope: ConversationInputEnvelope } }
  | { id: string; method: 'checkpoint'; params: { target: ConversationRuntimeTarget } }
  | { id: string; method: 'rate_auto_route'; params: { target: ConversationRuntimeTarget; score: number; routeId?: string } }
  | { id: string; method: 'set_work_run_expanded'; params: { target: ConversationRuntimeTarget; runId: string; expanded: boolean } }
  | { id: string; method: 'update_setting'; params: { section: string; key: string; value: unknown } }
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
  | { event: 'host_tool_request'; data: WslHostToolRequest }
  | { event: 'host_tool_cancel'; data: { requestId: string } };

export type WslTerminalStateResult = TerminalTakeoverState[];

export interface WslAgentPromptResult extends ConversationKernelRunResult {
  backend: 'wsl';
  distro: string;
}

export type WslAgentStopResult = ConversationStopResult & { backend: 'wsl'; distro: string };
export type WslGuideResult = GuideReceipt;
export type WslAutoRouteRatingResult = AutoRouteRatingResult;
export type WslConversationRewindResult = ConversationSnapshot;
