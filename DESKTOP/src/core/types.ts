export type AgentMode = 'build' | 'plan' | 'goal' | 'flow';
export type InputMode = 'guide' | 'next';
export type AgentStatus = 'idle' | 'working' | 'error' | 'goal_paused';

/** Public routing identity used by renderer/main/runtime envelopes. */
export interface ConversationTarget {
  workspaceId: string;
  conversationId: string;
}

export type ConversationInputDeliveryMode = 'turn' | 'steer' | 'followUp';
export type GuideReceiptStatus = 'accepted' | 'applied' | 'deferred' | 'rejected';
export type ConversationWorkRunStatus = 'running' | 'completed' | 'interrupted' | 'force_interrupted' | 'error';

export interface ConversationInputEnvelope {
  clientMessageId: string;
  target: ConversationTarget;
  runId?: string;
  deliveryMode: ConversationInputDeliveryMode;
  text: string;
  images?: Array<{ dataUrl: string; name?: string; type?: string }>;
  createdAt: string;
}

export interface GuideReceipt {
  clientMessageId: string;
  target: ConversationTarget;
  runId: string;
  status: GuideReceiptStatus;
  content?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  reason?: string;
}

export interface StreamToken {
  type: 'text' | 'tool_call' | 'status';
  text: string;
  toolCall?: { id: string; name: string; arguments: string };
  reasoningContent?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'workflow';
  content: string;
  mode: string;
  model: string;
  timestamp: string;
  clientMessageId?: string;
  runId?: string;
}

export interface AgentWorkEvent {
  id: string;
  conversationId: string;
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'status' | 'done' | 'error' | 'queue_update' | 'guide';
  content: string;
  mode: string;
  model: string;
  timestamp: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
  queue?: { steering: string[]; followUp: string[] };
  workspaceId?: string;
  workspaceKey?: string;
  runtimeKey?: string;
  runId?: string;
  generation?: number;
  sequence?: number;
  status?: GuideReceiptStatus | ConversationWorkRunStatus | 'stopping' | 'force_restarting';
  guide?: GuideReceipt;
}

export interface ConversationWorkRun {
  runId: string;
  target: ConversationTarget;
  runtimeKey: string;
  status: ConversationWorkRunStatus;
  startedAt: string;
  endedAt?: string;
  expanded: boolean;
  sequence: number;
  events: AgentWorkEvent[];
  guides: GuideReceipt[];
}

export interface GoalState {
  objective: string;
  changes: Array<{ old: string; new: string }>;
  goalRounds: number;
  verified: boolean;
  paused: boolean;
  update(newObj: string): void;
  history(): string;
  checkComplete(response: string): boolean;
}

export interface GoalItem {
  text: string;
  done: boolean;
}

export interface OptionQuestion {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiple: boolean;
}

export interface FileDiff {
  path: string;
  oldContent: string;
  newContent: string;
}
