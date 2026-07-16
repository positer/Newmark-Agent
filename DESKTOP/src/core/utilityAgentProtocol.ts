import { BrowserControlRequest, BrowserControlResult } from './browserControl';
import { BrowserUseRequest } from './browserUse';
import {
  AgentPromptMessage,
  ConversationKernelRunOptions,
  ConversationKernelRunResult,
  ConversationQueueMode,
  ConversationRuntimeState,
  ConversationStopResult,
} from './conversationKernel';
import { ConversationRuntimeTarget, NormalizedConversationTarget } from './conversationTarget';
import { AgentWorkEvent, ConversationInputEnvelope, GuideReceipt } from './types';
import type { AutoRouteRatingResult, ConversationSnapshot } from './agent';

export interface UtilityPromptRequest {
  message: string | AgentPromptMessage;
  target: ConversationRuntimeTarget;
  options: ConversationKernelRunOptions;
  queueMode: ConversationQueueMode;
}

export interface UtilityHostToolTarget {
  workspaceId: string;
  conversationId: string;
  runtimeKey: string;
  workspaceKey: string;
  workspacePath: string;
}

export interface UtilityHostToolContext {
  conversationId: string;
  workspaceId: string;
  actorId: string;
  workspacePath: string;
  backend: string;
  mode: string;
  runtimeKey?: string;
}

interface UtilityHostToolRequestBase {
  requestId: string;
  target: UtilityHostToolTarget;
}

/** Desktop-owned capabilities that an isolated utility runtime may invoke. */
export type UtilityHostToolRequest =
  | (UtilityHostToolRequestBase & { tool: 'browser_control'; args: BrowserControlRequest })
  | (UtilityHostToolRequestBase & { tool: 'browser_use'; args: BrowserUseRequest; context: UtilityHostToolContext })
  | (UtilityHostToolRequestBase & { tool: 'computer_use'; args: Record<string, unknown>; context: UtilityHostToolContext })
  | (UtilityHostToolRequestBase & { tool: 'automation'; args: { tool: string; payload: string }; context: UtilityHostToolContext })
  | (UtilityHostToolRequestBase & { tool: 'terminal_takeover'; args: Record<string, unknown>; context: UtilityHostToolContext });

export interface UtilityHostToolResult {
  requestId: string;
  ok: boolean;
  result?: BrowserControlResult | string | Record<string, unknown> | unknown;
  error?: string;
}

export type UtilityAgentRequest =
  | { id: string; method: 'ping' }
  | { id: string; method: 'prompt'; params: UtilityPromptRequest }
  | { id: string; method: 'snapshot'; params: { target: ConversationRuntimeTarget } }
  | { id: string; method: 'rewind'; params: { target: ConversationRuntimeTarget; messageIndex: number } }
  | { id: string; method: 'stop'; params: { target: ConversationRuntimeTarget; runId?: string } }
  | { id: string; method: 'guide'; params: { target: ConversationRuntimeTarget; envelope: ConversationInputEnvelope } }
  | { id: string; method: 'checkpoint'; params: { target: ConversationRuntimeTarget } }
  | { id: string; method: 'rate_auto_route'; params: { target: ConversationRuntimeTarget; score: number; routeId?: string } }
  | { id: string; method: 'set_work_run_expanded'; params: { target: ConversationRuntimeTarget; runId: string; expanded: boolean } }
  | { id: string; method: 'update_setting'; params: { section: string; key: string; value: unknown } }
  | { id: string; method: 'host_tool_result'; params: UtilityHostToolResult }
  | { id: string; method: 'shutdown' };

export type UtilityAgentResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export type UtilityAgentEventEnvelope =
  | { event: 'work'; data: AgentWorkEvent }
  | { event: 'host_tool_request'; data: UtilityHostToolRequest }
  | { event: 'host_tool_cancel'; data: { requestId: string } };

export interface UtilityAgentPromptResult extends ConversationKernelRunResult {
  backend: 'utility';
  pid: number;
}

export type UtilityAgentStopResult = ConversationStopResult & { backend: 'utility'; pid: number };

export interface UtilityAgentSnapshotResult {
  target: NormalizedConversationTarget;
  runtime: ConversationRuntimeState | null;
  queued: { steering: string[]; followUp: string[] };
  workEvents: AgentWorkEvent[];
  [key: string]: unknown;
}

export type UtilityGuideResult = GuideReceipt;
export type UtilityAutoRouteRatingResult = AutoRouteRatingResult;
export type UtilityConversationRewindResult = ConversationSnapshot;
