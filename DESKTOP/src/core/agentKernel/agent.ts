import { runAgentLoop, runAgentLoopContinue } from './agent-loop';
import {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  ImageContent,
  Model,
  QueueMode,
  StreamFn,
  TextContent,
  ThinkingBudgets,
  Transport,
} from './types';
import { streamSimple } from './stream-types';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL: Model = {
  id: 'unknown',
  name: 'unknown',
  api: 'unknown',
  provider: 'unknown',
  baseUrl: '',
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  constructor(public mode: QueueMode) {}
  enqueue(message: AgentMessage): void { this.messages.push(message); }
  hasItems(): boolean { return this.messages.length > 0; }
  drain(): AgentMessage[] {
    if (this.mode === 'all') {
      const all = this.messages.slice();
      this.messages = [];
      return all;
    }
    const first = this.messages.shift();
    return first ? [first] : [];
  }
  clear(): void { this.messages = []; }
}

type ActiveRun = {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
};

export interface AgentOptions {
  initialState?: Partial<Omit<AgentState, 'pendingToolCalls' | 'isStreaming' | 'streamingMessage' | 'errorMessage'>>;
  convertToLlm?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn?: StreamFn;
  prepareNextTurn?: () => unknown;
  prepareNextTurnWithContext?: (...args: any[]) => unknown;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  sessionId?: string;
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;
  maxRetryDelayMs?: number;
  toolExecution?: 'sequential' | 'parallel';
  shouldStopAfterTurn?: (context: { message: AgentMessage; toolResults: AgentMessage[]; context: { messages: AgentMessage[] }; newMessages: AgentMessage[] }) => Promise<boolean> | boolean;
}

function createState(initial?: AgentOptions['initialState']): AgentState {
  return {
    systemPrompt: initial?.systemPrompt || '',
    model: initial?.model || DEFAULT_MODEL,
    thinkingLevel: initial?.thinkingLevel || 'off',
    tools: initial?.tools?.slice() || [],
    messages: initial?.messages?.slice() || [],
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}

export class Agent {
  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;
  private activeRun?: ActiveRun;
  private _state: AgentState;

  public convertToLlm: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  public streamFn: StreamFn;
  public sessionId?: string;
  public thinkingBudgets?: ThinkingBudgets;
  public transport: Transport;
  public maxRetryDelayMs?: number;
  public toolExecution: 'sequential' | 'parallel';
  public shouldStopAfterTurn?: AgentOptions['shouldStopAfterTurn'];

  constructor(options: AgentOptions = {}) {
    this._state = createState(options.initialState);
    this.convertToLlm = options.convertToLlm || ((messages) => messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'));
    this.transformContext = options.transformContext;
    this.streamFn = options.streamFn || streamSimple;
    this.steeringQueue = new PendingMessageQueue(options.steeringMode || 'one-at-a-time');
    this.followUpQueue = new PendingMessageQueue(options.followUpMode || 'one-at-a-time');
    this.sessionId = options.sessionId;
    this.thinkingBudgets = options.thinkingBudgets;
    this.transport = options.transport || 'auto';
    this.maxRetryDelayMs = options.maxRetryDelayMs;
    this.toolExecution = options.toolExecution || 'parallel';
    this.shouldStopAfterTurn = options.shouldStopAfterTurn;
  }

  get state(): AgentState { return this._state; }

  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  steer(message: AgentMessage): void { this.steeringQueue.enqueue(message); }
  followUp(message: AgentMessage): void { this.followUpQueue.enqueue(message); }
  clearAllQueues(): void { this.steeringQueue.clear(); this.followUpQueue.clear(); }
  hasQueuedMessages(): boolean { return this.steeringQueue.hasItems() || this.followUpQueue.hasItems(); }
  waitForIdle(): Promise<void> { return this.activeRun?.promise || Promise.resolve(); }
  abort(): void { this.activeRun?.abortController.abort(); }

  async prompt(message: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this.activeRun) throw new Error('Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.');
    await this.runWithLifecycle(async signal => {
      await runAgentLoop(this.normalizePromptInput(message, images), this.createLoopConfig(), signal);
    });
  }

  async continue(): Promise<void> {
    if (this.activeRun) throw new Error('Agent is already processing. Wait for completion before continuing.');
    await this.runWithLifecycle(async signal => {
      await runAgentLoopContinue(this.createLoopConfig(), signal);
    });
  }

  private normalizePromptInput(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
    if (Array.isArray(input)) return input;
    if (typeof input !== 'string') return [input];
    const content: Array<TextContent | ImageContent> = [{ type: 'text', text: input }];
    if (images?.length) content.push(...images);
    return [{ role: 'user', content, timestamp: Date.now() }];
  }

  private createLoopConfig() {
    return {
      state: this._state,
      streamFn: this.streamFn,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      emit: (event: AgentEvent) => this.processEvent(event),
      getSteeringMessages: async () => this.steeringQueue.drain(),
      getFollowUpMessages: async () => this.followUpQueue.drain(),
      toolExecution: this.toolExecution,
      shouldStopAfterTurn: this.shouldStopAfterTurn,
    };
  }

  private async runWithLifecycle(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const abortController = new AbortController();
    let resolveRun!: () => void;
    const promise = new Promise<void>(resolve => { resolveRun = resolve; });
    this.activeRun = { promise, resolve: resolveRun, abortController };
    try {
      await run(abortController.signal);
    } finally {
      this.activeRun.resolve();
      this.activeRun = undefined;
    }
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    if (event.type === 'message_end') {
      this._state.messages.push(event.message);
      if (event.message.role === 'assistant') this._state.streamingMessage = undefined;
    } else if (event.type === 'message_update') {
      this._state.streamingMessage = event.message;
    } else if (event.type === 'tool_execution_start') {
      this._state.pendingToolCalls.add(event.toolCallId);
    } else if (event.type === 'tool_execution_end') {
      this._state.pendingToolCalls.delete(event.toolCallId);
    } else if (event.type === 'agent_end') {
      this._state.isStreaming = false;
    } else if (event.type === 'agent_start') {
      this._state.isStreaming = true;
    }
    const signal = this.activeRun?.abortController.signal || new AbortController().signal;
    for (const listener of this.listeners) await listener(event, signal);
  }
}
