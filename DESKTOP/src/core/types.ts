export type AgentMode = 'build' | 'plan' | 'goal' | 'flow';
export type InputMode = 'guide' | 'next';
export type AgentStatus = 'idle' | 'working' | 'error' | 'goal_paused';

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
}

export interface AgentWorkEvent {
  id: string;
  conversationId: string;
  type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'status' | 'done' | 'error' | 'queue_update';
  content: string;
  mode: string;
  model: string;
  timestamp: string;
  toolName?: string;
  toolArgs?: string;
  queue?: { steering: string[]; followUp: string[] };
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
