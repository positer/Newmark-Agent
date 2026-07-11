import { AgentWorkEvent } from './types';
import { ConversationKernelRunOptions, ConversationKernelRunResult, ConversationQueueMode } from './conversationKernel';

export interface WslAgentWorkspace {
  id?: string;
  name: string;
  path: string;
  isInternal?: boolean;
  kind?: string;
}

export interface WslAgentPromptRequest {
  message: string;
  conversationId: string;
  options: ConversationKernelRunOptions;
  queueMode: ConversationQueueMode;
  workspace: WslAgentWorkspace | null;
}

export type WslAgentRequest =
  | { id: string; method: 'ping' }
  | { id: string; method: 'prompt'; params: WslAgentPromptRequest }
  | { id: string; method: 'abort'; params: { conversationId: string } }
  | { id: string; method: 'snapshot'; params: { conversationId: string; workspace: WslAgentWorkspace | null } }
  | { id: string; method: 'shutdown' };

export type WslAgentResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export interface WslAgentEventEnvelope {
  event: 'work';
  data: AgentWorkEvent;
}

export interface WslAgentPromptResult extends ConversationKernelRunResult {
  backend: 'wsl';
  distro: string;
}
