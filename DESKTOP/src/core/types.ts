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
  goalObjective?: string;
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
  /** Durable user-authored media referenced while the Guide is pending. */
  attachments?: ConversationImageAttachment[];
}

export interface StreamToken {
  type: 'text' | 'tool_call' | 'status' | 'usage';
  text: string;
  toolCall?: { id: string; name: string; arguments: string };
  reasoningContent?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ConversationImageAttachment {
  id: string;
  origin: 'user';
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  byteLength: number;
  width: number;
  height: number;
  sha256: string;
  assetPath: string;
  createdAt: string;
  /** Hydrated only from a validated user submission or its content-addressed asset. */
  dataUrl?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'workflow';
  content: string;
  mode: string;
  model: string;
  timestamp: string;
  clientMessageId?: string;
  runId?: string;
  attachments?: ConversationImageAttachment[];
}

export interface AgentWorkEvent {
  id: string;
  conversationId: string;
  type: 'start' | 'text' | 'response' | 'final_response' | 'tool_call' | 'tool_result' | 'status' | 'done' | 'error' | 'queue_update' | 'guide';
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
  primaryPrompt?: string;
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
