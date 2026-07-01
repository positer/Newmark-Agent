import { Agent } from './agent';
import { AgentMode, AgentWorkEvent, OptionQuestion, StreamToken } from './types';
import { AutomationManager } from './automation';

export type ConversationQueueMode = 'steer' | 'followUp';

export interface ConversationKernelRunOptions {
  mode: AgentMode;
  model: string;
  intelligence: string;
  inputMode: 'guide' | 'next';
  engine: string;
}

export interface ConversationKernelRunResult {
  tokens: Array<{ type: string; text: string }>;
  diffs: Array<{ path: string; old: number; new: number }>;
  mode: AgentMode;
  model: string;
  status: string;
  goal: { objective: string; paused: boolean } | null;
  options: OptionQuestion[];
  contextCompression: Agent['lastCompression'];
  contextWindow: ReturnType<Agent['contextWindow']>;
  conversationId: string;
  activeConversationId: string;
  conversations: ReturnType<Agent['listConversationStates']>;
  conversationPlan: ReturnType<Agent['getConversationPlan']>;
  chatMessages: Agent['chatMessages'];
  historyMessages: number;
  conversationLocked: false;
  queued: { steering: string[]; followUp: string[] };
}

interface ConversationRuntime {
  id: string;
  runner: Agent;
  activePromise: Promise<ConversationKernelRunResult> | null;
  events: AgentWorkEvent[];
  pendingNextTurn: Array<{ message: string; queueMode: ConversationQueueMode }>;
  queued: { steering: string[]; followUp: string[] };
  unsubscribe?: () => void;
}

type WorkListener = (event: AgentWorkEvent) => void;

/**
 * Newmark native Agent-kernel-backed conversation manager.
 *
 * Each conversation owns one Newmark Agent facade whose active process() call is
 * executed by the project-internal Agent kernel. Different conversations can run in parallel. While
 * a conversation is running, Guide/Next are accepted as queued same-session
 * messages; the active promise remains the settlement handle for UI compatibility.
 */
export class ConversationKernel {
  private runtimes = new Map<string, ConversationRuntime>();
  private listeners = new Set<WorkListener>();
  private readonly eventLimit = 500;

  constructor(
    private readonly root: string,
    private readonly host: Agent,
    private readonly automation: AutomationManager | null,
  ) {}

  subscribe(listener: WorkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(conversationId: string): boolean {
    return !!this.runtimes.get(this.safeId(conversationId))?.activePromise;
  }

  isAnyRunning(): boolean {
    for (const runtime of this.runtimes.values()) {
      if (runtime.activePromise) return true;
    }
    return false;
  }

  queued(conversationId: string): { steering: string[]; followUp: string[] } {
    const runtime = this.runtimes.get(this.safeId(conversationId));
    const queued = runtime ? this.queueState(runtime).queued : undefined;
    return {
      steering: queued?.steering.slice() || [],
      followUp: queued?.followUp.slice() || [],
    };
  }

  events(conversationId: string): AgentWorkEvent[] {
    return this.runtimes.get(this.safeId(conversationId))?.events.slice() || [];
  }

  async prompt(
    message: string,
    conversationId: string,
    options: ConversationKernelRunOptions,
    queueMode: ConversationQueueMode = 'followUp',
  ): Promise<ConversationKernelRunResult> {
    const id = this.safeId(conversationId);
    const runtime = this.runtime(id, options);
    this.applyOptions(runtime.runner, options);

    if (runtime.activePromise) {
      this.enqueueSameSession(runtime, message, queueMode);
      return runtime.activePromise;
    }

    runtime.activePromise = this.run(runtime, message, options).finally(() => {
      runtime.activePromise = null;
    });
    return runtime.activePromise;
  }

  private async run(
    runtime: ConversationRuntime,
    message: string,
    options: ConversationKernelRunOptions,
  ): Promise<ConversationKernelRunResult> {
    this.applyOptions(runtime.runner, options);
    runtime.runner.setConversation(runtime.id);
    let lastTokens = await this.runSingle(runtime, message);
    while (runtime.pendingNextTurn.length > 0) {
      const next = runtime.pendingNextTurn.shift()!;
      lastTokens = await this.runSingle(runtime, next.message);
    }
    this.clearQueued(runtime);
    this.host.mirrorConversationStateFrom(runtime.id, runtime.runner);
    this.refreshHostIfActive(runtime.id);
    return this.result(runtime, lastTokens);
  }

  private async runSingle(runtime: ConversationRuntime, message: string): Promise<StreamToken[]> {
    this.consumeQueuedMessage(runtime, message);
    return Promise.race([
      runtime.runner.process(message),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Process timeout (300s)')), 300000)),
    ]);
  }

  private runtime(id: string, options: ConversationKernelRunOptions): ConversationRuntime {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const runner = new Agent(this.root);
    runner.setAutomationManager(this.automation);
    if (this.host.workspace.current) {
      runner.workspace.current = { ...this.host.workspace.current };
      runner.config.loadWorkspaceConfig(this.host.workspace.current.path);
    }
    this.applyOptions(runner, options);
    runner.setConversation(id);
    const runtime: ConversationRuntime = {
      id,
      runner,
      activePromise: null,
      events: [],
      pendingNextTurn: [],
      queued: { steering: [], followUp: [] },
    };
    runtime.unsubscribe = runner.subscribeWorkEvents(event => {
      runtime.events.push(event);
      if (runtime.events.length > this.eventLimit) runtime.events = runtime.events.slice(-this.eventLimit);
      for (const listener of this.listeners) listener(event);
    });
    runner.subscribeAgentKernelUserMessageStart(content => {
      this.consumeQueuedMessage(runtime, content);
    });
    this.runtimes.set(id, runtime);
    return runtime;
  }

  private applyOptions(agent: Agent, options: ConversationKernelRunOptions): void {
    agent.setMode(options.mode);
    agent.setModel(options.model);
    agent.setIntelligence(options.intelligence);
    agent.inputMode = options.inputMode;
    agent.engine = options.engine;
  }

  private result(runtime: ConversationRuntime, tokens: StreamToken[]): ConversationKernelRunResult {
    this.refreshHostIfActive(runtime.id);
    return {
      tokens: tokens.map(t => ({ type: t.type, text: t.text })),
      diffs: runtime.runner.fileDiffs.map(d => ({ path: d.path, old: d.oldContent.length, new: d.newContent.length })),
      mode: runtime.runner.mode,
      model: runtime.runner.model,
      status: runtime.runner.status,
      goal: runtime.runner.goal ? { objective: runtime.runner.goal.objective, paused: runtime.runner.goal.paused } : null,
      options: runtime.runner.pendingOptions,
      contextCompression: runtime.runner.lastCompression,
      contextWindow: runtime.runner.contextWindow(),
      conversationId: runtime.id,
      activeConversationId: this.host.activeConversationId,
      conversations: this.host.listConversationStates(),
      conversationPlan: runtime.runner.getConversationPlan(),
      chatMessages: runtime.runner.chatMessages,
      historyMessages: runtime.runner.history.length,
      conversationLocked: false,
      queued: this.queued(runtime.id),
    };
  }

  private enqueueSameSession(runtime: ConversationRuntime, message: string, queueMode: ConversationQueueMode): void {
    const kind = queueMode === 'steer' ? 'Guide' : 'Next';
    const prompt = `[${kind} queued while the Agent was working]\n${message}`;
    this.trackQueuedMessage(runtime, prompt, queueMode);
    const queued = runtime.runner.queueActiveKernelMessage(prompt, queueMode);
    if (!queued) runtime.pendingNextTurn.push({ message: prompt, queueMode });
    runtime.runner.recordWorkStatus(`[Queue] ${kind} message ${queued ? 'queued in active Agent kernel' : 'recorded for the next turn'}.`);
    this.emitQueueUpdate(runtime);
  }

  private trackQueuedMessage(runtime: ConversationRuntime, message: string, queueMode: ConversationQueueMode): void {
    this.queueState(runtime);
    const list = queueMode === 'steer' ? runtime.queued.steering : runtime.queued.followUp;
    list.push(message);
  }

  private consumeQueuedMessage(runtime: ConversationRuntime, message: string): void {
    this.queueState(runtime);
    let changed = false;
    for (const key of ['steering', 'followUp'] as const) {
      const index = runtime.queued[key].indexOf(message);
      if (index >= 0) {
        runtime.queued[key].splice(index, 1);
        changed = true;
      }
    }
    if (changed) this.emitQueueUpdate(runtime);
  }

  private emitQueueUpdate(runtime: ConversationRuntime): void {
    this.queueState(runtime);
    runtime.runner.emitWorkEvent({
      type: 'queue_update',
      content: 'Conversation queue updated.',
      conversationId: runtime.id,
      queue: this.queued(runtime.id),
    });
  }

  private clearQueued(runtime: ConversationRuntime): void {
    this.queueState(runtime);
    if (!runtime.queued.steering.length && !runtime.queued.followUp.length) return;
    runtime.queued.steering = [];
    runtime.queued.followUp = [];
    this.emitQueueUpdate(runtime);
  }

  private queueState(runtime: ConversationRuntime): ConversationRuntime {
    if (!runtime.queued) runtime.queued = { steering: [], followUp: [] };
    if (!Array.isArray(runtime.queued.steering)) runtime.queued.steering = [];
    if (!Array.isArray(runtime.queued.followUp)) runtime.queued.followUp = [];
    return runtime;
  }

  private refreshHostIfActive(id: string): void {
    if ((this.host.activeConversationId || 'default') === id) this.host.setConversation(id);
  }

  private safeId(id: string): string {
    return String(id || 'default').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'default';
  }
}
