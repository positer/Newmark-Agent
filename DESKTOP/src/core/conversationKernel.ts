import { Agent, AutoRouteRatingResult } from './agent';
import {
  AgentMode,
  AgentWorkEvent,
  ConversationInputEnvelope,
  ConversationImageAttachment,
  GuideReceipt,
  OptionQuestion,
  StreamToken,
} from './types';
import { AutomationManager } from './automation';
import { randomUUID } from 'crypto';
import {
  ConversationRuntimeTarget,
  NormalizedConversationTarget,
  normalizeConversationTarget,
  safeConversationId,
} from './conversationTarget';

export type ConversationQueueMode = 'steer' | 'followUp';
export interface AgentPromptMessage {
  text: string;
  images?: Array<{ dataUrl: string; name?: string; type?: string }>;
  attachments?: ConversationImageAttachment[];
  clientMessageId?: string;
  runId?: string;
  routePolicy?: {
    mode?: 'quality' | 'balanced' | 'cost' | 'speed';
    maxQualityLoss?: number;
    maxExpectedCostUsd?: number;
    allowPreview?: boolean;
    privacy?: 'default' | 'no_training' | 'zdr';
    dataRegion?: string;
    requiredProtocolParameters?: string[];
    batch?: boolean;
    subset?: Array<{ providerId: string; modelId: string; logicalModelGroupId?: string }>;
  };
}

export interface ConversationKernelRunOptions {
  mode: AgentMode;
  model: string;
  intelligence: string;
  inputMode: 'guide' | 'next';
  engine: string;
}

export interface ConversationKernelRunResult {
  tokens: Array<{ type: string; text: string }>;
  diffs: Array<{ path: string; old: number; new: number; oldContent: string; newContent: string }>;
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
  linkedPlan: ReturnType<Agent['getLinkedPlan']>;
  subagents: Array<NonNullable<ReturnType<Agent['subagents']['toRecord']>>>;
  chatMessages: Agent['chatMessages'];
  historyMessages: number;
  conversationLocked: false;
  queued: { steering: string[]; followUp: string[] };
  target: NormalizedConversationTarget;
  workspaceKey: string;
  runtimeKey: string;
  runId: string;
  generation: number;
  workRuns: Agent['workRuns'];
  routeDecision?: Agent['lastRouteDecision'];
  resolvedDeployment?: ReturnType<Agent['activeDeployment']>;
  autoRouteRatingAvailable?: boolean;
}

export type ConversationTargetInput = string | ConversationRuntimeTarget;

export interface ConversationRuntimeState {
  target: NormalizedConversationTarget;
  workspaceKey: string;
  runtimeKey: string;
  runId: string;
  generation: number;
  running: boolean;
  stopRequested: boolean;
  workRuns: Agent['workRuns'];
}

export type ConversationStopResult =
  | { action: 'not_running'; runtimeKey: string; runId?: string; generation?: number; checkpointed: false }
  | { action: 'stale'; runtimeKey: string; runId: string; generation: number; checkpointed: false }
  | { action: 'graceful'; runtimeKey: string; runId: string; generation: number; checkpointed: boolean }
  | { action: 'force'; runtimeKey: string; runId: string; generation: number; checkpointed: boolean };

export interface ConversationKernelLifecycle {
  createRunner?(target: NormalizedConversationTarget): Agent;
}

interface ConversationRuntime {
  id: string;
  target: NormalizedConversationTarget;
  runtimeKey: string;
  runner: Agent;
  options: ConversationKernelRunOptions;
  activePromise: Promise<ConversationKernelRunResult> | null;
  events: AgentWorkEvent[];
  pendingNextTurn: Array<{ message: string | AgentPromptMessage; queueMode: ConversationQueueMode }>;
  queued: { steering: string[]; followUp: string[] };
  unsubscribe?: () => void;
  unsubscribeRootInboxWake?: () => void;
  runId: string;
  generation: number;
  stopRequestedRunId: string;
  forceStopArmedRunId: string;
  stopCheckpointed: boolean;
  guideAcceptanceClosedRunId: string;
  guideReceipts: Map<string, GuideReceipt>;
  guideEnvelopes: Map<string, ConversationInputEnvelope>;
}

type WorkListener = (event: AgentWorkEvent) => void;

function changedLineCount(value: string): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length;
}

/**
 * Newmark native Agent-kernel-backed conversation manager.
 *
 * Each conversation owns one Newmark Agent facade whose active process() call is
 * executed by the project-internal Agent kernel. Different conversations can run in parallel. While
 * a conversation is running, Guide is delivered as steering and Next is kept as
 * visible follow-up queue; the active promise remains the settlement handle for
 * UI compatibility.
 */
export class ConversationKernel {
  private runtimes = new Map<string, ConversationRuntime>();
  private listeners = new Set<WorkListener>();
  private readonly eventLimit = 500;
  private generations = new Map<string, number>();

  constructor(
    private readonly root: string,
    private readonly host: Agent,
    private readonly automation: AutomationManager | null,
    private readonly lifecycle: ConversationKernelLifecycle = {},
  ) {}

  subscribe(listener: WorkListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isRunning(target: ConversationTargetInput): boolean {
    return !!this.findRuntime(target)?.activePromise;
  }

  isAnyRunning(): boolean {
    for (const runtime of this.runtimes.values()) {
      if (runtime.activePromise) return true;
    }
    return false;
  }

  flushPersistence(): void {
    this.host.flushWorkspaceConversationState();
    for (const runtime of this.runtimes.values()) runtime.runner.flushWorkspaceConversationState();
  }

  queued(target: ConversationTargetInput): { steering: string[]; followUp: string[] } {
    const runtime = this.findRuntime(target);
    const queued = runtime ? this.queueState(runtime).queued : undefined;
    return {
      steering: queued?.steering.slice() || [],
      followUp: queued?.followUp.slice() || [],
    };
  }

  events(target: ConversationTargetInput): AgentWorkEvent[] {
    return this.findRuntime(target)?.events.slice() || [];
  }

  pendingOptions(target: ConversationTargetInput): OptionQuestion[] | undefined {
    const runtime = this.findRuntime(target);
    return runtime ? runtime.runner.pendingOptions.map(question => ({
      ...question,
      options: question.options.map(option => ({ ...option })),
    })) : undefined;
  }

  snapshot(target: ConversationTargetInput): ReturnType<Agent['getConversationSnapshot']> & {
    target: NormalizedConversationTarget;
    queued: { steering: string[]; followUp: string[] };
    workEvents: AgentWorkEvent[];
    runtime: ConversationRuntimeState | null;
    mode: Agent['mode'];
    model: string;
    intelligence: string;
    status: string;
    goal: { objective: string; paused: boolean } | null;
    fileDiffs: Array<{ path: string; oldLength: number; newLength: number }>;
    pendingOptions: OptionQuestion[];
    contextCompression: Agent['lastCompression'];
    contextWindow: ReturnType<Agent['contextWindow']>;
    conversationLocked: false;
    routeDecision: Agent['lastRouteDecision'];
    resolvedDeployment: ReturnType<Agent['activeDeployment']>;
    autoRouteRatingAvailable: boolean;
  } {
    const normalized = this.normalizeTarget(target);
    const runtime = this.findRuntime(normalized);
    const runner = runtime?.runner || this.createRunner(normalized);
    const conversationSnapshot = runner.getConversationSnapshot(normalized.conversationId);
    return {
      ...conversationSnapshot,
      workRuns: this.bindWorkRunsToRuntimeTarget(conversationSnapshot.workRuns, normalized),
      target: normalized,
      queued: this.queued(normalized),
      workEvents: this.events(normalized),
      runtime: this.runtimeState(normalized),
      mode: runner.mode,
      model: runner.model,
      intelligence: runner.intelligence,
      status: runner.status,
      goal: runner.goal ? { objective: runner.goal.objective, paused: runner.goal.paused } : null,
      fileDiffs: runner.fileDiffs.map(diff => ({
        path: diff.path,
        oldLength: diff.oldContent.length,
        newLength: diff.newContent.length,
      })),
      pendingOptions: runner.pendingOptions.map(question => ({
        ...question,
        options: question.options.map(option => ({ ...option })),
      })),
      contextCompression: runner.lastCompression,
      contextWindow: runner.contextWindow(),
      conversationLocked: false,
      routeDecision: runner.lastRouteDecision,
      resolvedDeployment: runner.activeDeployment(),
      autoRouteRatingAvailable: runner.model === 'auto'
        && runner.lastRouteDecision?.requestedSelection.kind === 'auto'
        && !!runner.lastRouteDecision.resolvedDeployment,
    };
  }

  runtimeStates(): ConversationRuntimeState[] {
    return Array.from(this.runtimes.values()).map(runtime => {
      this.ensureRuntimeMetadata(runtime, runtime.target || this.normalizeTarget(runtime.id));
      return this.runtimeState(runtime.target)!;
    });
  }

  enqueueGuide(envelope: ConversationInputEnvelope): GuideReceipt {
    const target = this.normalizeTarget(envelope.target);
    const runtime = this.findRuntime(target);
    const now = new Date().toISOString();
    const clientMessageId = String(envelope.clientMessageId || '').trim().slice(0, 200);
    const requestedRunId = String(envelope.runId || runtime?.runId || '').trim();
    const base: GuideReceipt = {
      clientMessageId,
      target: { workspaceId: target.workspaceId, conversationId: target.conversationId },
      runId: requestedRunId,
      status: 'rejected',
      content: envelope.text,
      createdAt: envelope.createdAt || now,
      updatedAt: now,
    };
    if (!clientMessageId) return { ...base, reason: 'clientMessageId is required' };

    const existing = runtime ? this.guideReceipt(runtime, clientMessageId) : undefined;
    if (existing) return existing;
    if (!runtime?.activePromise || !runtime.runId) {
      return { ...base, reason: 'Target conversation is not running' };
    }
    if (requestedRunId && requestedRunId !== runtime.runId) {
      const rejected = { ...base, runId: runtime.runId, reason: 'Guide runId does not match the active run' };
      runtime.guideReceipts.set(clientMessageId, rejected);
      return runtime.runner.recordGuideReceipt(rejected);
    }

    let safeImages: AgentPromptMessage['images'] = [];
    let safeAttachments: ConversationImageAttachment[] = [];
    try {
      const prepared = runtime.runner.prepareSubmittedConversationImages(envelope.images);
      safeImages = prepared.images;
      safeAttachments = prepared.attachments;
    } catch (error) {
      const rejected = {
        ...base,
        runId: runtime.runId,
        reason: `Attachment rejected: ${error instanceof Error ? error.message : String(error)}`,
      };
      runtime.guideReceipts.set(clientMessageId, rejected);
      return runtime.runner.recordGuideReceipt(rejected);
    }
    const safeEnvelope: ConversationInputEnvelope = { ...envelope, images: safeImages };

    const accepted: GuideReceipt = {
      ...base,
      runId: runtime.runId,
      status: 'accepted',
      reason: undefined,
      attachments: safeAttachments.length ? safeAttachments : undefined,
    };
    runtime.guideEnvelopes.set(clientMessageId, {
      ...safeEnvelope,
      images: safeEnvelope.images?.map(image => ({ ...image })),
    });
    runtime.guideReceipts.set(clientMessageId, accepted);
    runtime.runner.recordGuideReceipt(accepted);
    if (runtime.stopRequestedRunId === runtime.runId) {
      // This is a new instruction, so the previous stop is no longer eligible
      // for a second-click force escalation. The cooperative abort still owns
      // the current process settlement, while the new Guide is durably retained
      // for the next runtime before that settlement can tear the worker down.
      runtime.forceStopArmedRunId = '';
      const deferred: GuideReceipt = {
        ...accepted,
        status: 'deferred',
        updatedAt: new Date().toISOString(),
        reason: 'The conversation is stopping; this Guide is retained for the next continuation.',
      };
      runtime.guideReceipts.set(clientMessageId, deferred);
      if (!runtime.pendingNextTurn.some(item => typeof item.message !== 'string' && item.message.clientMessageId === clientMessageId)) {
        runtime.pendingNextTurn.push({
          message: {
            text: safeEnvelope.text,
            images: safeEnvelope.images?.map(image => ({ ...image })),
            attachments: safeAttachments.map(attachment => ({ ...attachment })),
            clientMessageId,
            runId: runtime.runId,
          },
          queueMode: 'steer',
        });
      }
      runtime.runner.retainConversationContinuations([{
        content: safeEnvelope.text,
        queueMode: 'steer',
        clientMessageId,
        runId: runtime.runId,
        images: safeEnvelope.images?.map(image => ({ ...image })),
        attachments: safeAttachments.map(attachment => ({ ...attachment })),
        createdAt: deferred.createdAt,
      }]);
      this.trackQueuedMessage(runtime, safeEnvelope.text, 'steer');
      runtime.runner.recordGuideReceipt(deferred);
      this.emitQueueUpdate(runtime);
      return deferred;
    }
    if (runtime.guideAcceptanceClosedRunId === runtime.runId) {
      const deferred: GuideReceipt = {
        ...accepted,
        status: 'deferred',
        updatedAt: new Date().toISOString(),
        reason: 'The active run has crossed its finalization barrier; this Guide is retained for the next continuation.',
      };
      runtime.guideReceipts.set(clientMessageId, deferred);
      runtime.runner.recordGuideReceipt(deferred);
      runtime.pendingNextTurn.push({
        message: {
          text: safeEnvelope.text,
          images: safeEnvelope.images,
          attachments: safeAttachments.map(attachment => ({ ...attachment })),
          clientMessageId,
          runId: runtime.runId,
        },
        queueMode: 'steer',
      });
      runtime.runner.retainConversationContinuations([{
        content: safeEnvelope.text,
        queueMode: 'steer',
        clientMessageId,
        runId: runtime.runId,
        images: safeEnvelope.images?.map(image => ({ ...image })),
        attachments: safeAttachments.map(attachment => ({ ...attachment })),
        createdAt: deferred.createdAt,
      }]);
      return deferred;
    }
    const queued = runtime.runner.queueActiveKernelMessage(safeEnvelope.text, 'steer', clientMessageId, runtime.runId, safeEnvelope.images);
    if (queued) return accepted;

    const deferred: GuideReceipt = { ...accepted, status: 'deferred', updatedAt: new Date().toISOString() };
    runtime.guideReceipts.set(clientMessageId, deferred);
    runtime.runner.recordGuideReceipt(deferred);
    runtime.pendingNextTurn.push({
      message: {
        text: safeEnvelope.text,
        images: safeEnvelope.images,
        attachments: safeAttachments.map(attachment => ({ ...attachment })),
        clientMessageId,
        runId: runtime.runId,
      },
      queueMode: 'steer',
    });
    runtime.runner.retainConversationContinuations([{
      content: safeEnvelope.text,
      queueMode: 'steer',
      clientMessageId,
      runId: runtime.runId,
      images: safeEnvelope.images?.map(image => ({ ...image })),
      attachments: safeAttachments.map(attachment => ({ ...attachment })),
      createdAt: deferred.createdAt,
    }]);
    return deferred;
  }

  checkpoint(target: ConversationTargetInput): { runtimeKey: string; runId: string; generation: number; checkpointed: boolean; at: string } {
    const normalized = this.normalizeTarget(target);
    const runtime = this.findRuntime(normalized);
    let checkpointed = false;
    if (runtime) {
      try {
        runtime.runner.saveWorkspaceConversationState();
        checkpointed = true;
      } catch {
        checkpointed = false;
      }
    }
    return {
      runtimeKey: runtime?.runtimeKey || normalized.runtimeKey,
      runId: runtime?.runId || '',
      generation: runtime?.generation || 0,
      checkpointed,
      at: new Date().toISOString(),
    };
  }

  rateAutoRoute(target: ConversationTargetInput, score: number, expectedRouteId = ''): AutoRouteRatingResult {
    const runtime = this.findRuntime(target);
    if (!runtime) return { ok: false, reason: 'no_active_auto_route' };
    return runtime.runner.rateActiveAutoRoute(score, expectedRouteId);
  }

  setWorkRunExpanded(target: ConversationTargetInput, runId: string, expanded: boolean): boolean {
    const normalized = this.normalizeTarget(target);
    const runtime = this.findRuntime(normalized);
    // Completed work runs must remain interactive after their execution
    // runtime has been evicted or after the app restarts. A cold runner loads
    // only the requested target's persisted conversation, writes the display
    // preference, and is intentionally not registered as an active runtime.
    const runner = runtime?.runner || this.createRunner(normalized);
    return runner.setConversationWorkRunExpanded(runId, expanded);
  }

  updateSetting(section: string, key: string, value: unknown): void {
    for (const runtime of this.runtimes.values()) {
      if (section === 'models' && key === 'providers') runtime.runner.updateProviders(value);
      else runtime.runner.config.set(section, key, value);
    }
  }

  runtimeState(target: ConversationTargetInput): ConversationRuntimeState | null {
    const normalized = this.normalizeTarget(target);
    const runtime = this.findRuntime(target);
    if (!runtime) return null;
    this.ensureRuntimeMetadata(runtime, normalized);
    return {
      target: runtime.target,
      workspaceKey: runtime.target.workspaceKey,
      runtimeKey: runtime.runtimeKey,
      runId: runtime.runId,
      generation: runtime.generation,
      running: !!runtime.activePromise,
      stopRequested: !!runtime.runId && runtime.stopRequestedRunId === runtime.runId,
      workRuns: this.bindWorkRunsToRuntimeTarget(
        runtime.runner.getConversationSnapshot(runtime.id).workRuns,
        runtime.target,
      ),
    };
  }

  requestStop(target: ConversationTargetInput, expectedRunId?: string): ConversationStopResult {
    const normalized = this.normalizeTarget(target);
    const runtime = this.findRuntime(target);
    const runtimeKey = runtime?.runtimeKey || normalized.runtimeKey;
    if (runtime && !runtime.activePromise && runtime.runId && runtime.stopRequestedRunId === runtime.runId) {
      this.settleCooperativeStop(runtime, runtime.runId);
    }
    if (!runtime?.activePromise || !runtime.runId) {
      return { action: 'not_running', runtimeKey, runId: runtime?.runId || undefined, generation: runtime?.generation || undefined, checkpointed: false };
    }
    if (expectedRunId && expectedRunId !== runtime.runId) {
      return { action: 'stale', runtimeKey, runId: runtime.runId, generation: runtime.generation, checkpointed: false };
    }
    if (runtime.stopRequestedRunId === runtime.runId && runtime.forceStopArmedRunId === runtime.runId) {
      runtime.runner.emitWorkEvent({
        type: 'status',
        content: 'Force restarting this conversation runtime.',
        status: 'force_restarting',
        runId: runtime.runId,
      });
      this.rejectOutstandingGuides(runtime, 'Conversation was force-stopped before this Guide was applied. Please resend it.');
      runtime.stopCheckpointed = this.checkpoint(runtime.target).checkpointed || runtime.stopCheckpointed;
      runtime.runner.finishConversationWorkRun(runtime.runId, 'force_interrupted');
      return { action: 'force', runtimeKey, runId: runtime.runId, generation: runtime.generation, checkpointed: runtime.stopCheckpointed };
    }

    runtime.stopRequestedRunId = runtime.runId;
    runtime.forceStopArmedRunId = runtime.runId;
    this.retainUnconsumedKernelMessages(runtime);
    this.deferOutstandingGuides(runtime);
    const checkpointed = this.checkpoint(runtime.target).checkpointed;
    runtime.stopCheckpointed = checkpointed;
    runtime.runner.abortActiveKernelRun();
    runtime.runner.emitWorkEvent({
      type: 'status',
      content: 'Stop requested. Saving progress and interrupting this conversation.',
      status: 'stopping',
      runId: runtime.runId,
    });
    this.emitQueueUpdate(runtime);
    return { action: 'graceful', runtimeKey, runId: runtime.runId, generation: runtime.generation, checkpointed };
  }

  abort(target: ConversationTargetInput): boolean {
    const result = this.requestStop(target);
    return result.action === 'graceful' || result.action === 'force';
  }

  rewind(target: ConversationTargetInput, messageIndex: number): ReturnType<Agent['rewindConversation']> {
    const normalized = this.normalizeTarget(target);
    const id = normalized.conversationId;
    if (this.isRunning(normalized)) throw new Error('Cannot edit a message while this conversation is running.');
    const runtime = this.findRuntime(normalized);
    if (runtime?.unsubscribe) runtime.unsubscribe();
    if (runtime?.unsubscribeRootInboxWake) runtime.unsubscribeRootInboxWake();
    if (runtime) this.runtimes.delete(runtime.runtimeKey);
    const runner = runtime?.runner || this.createRunner(normalized);
    return runner.rewindConversation(id, messageIndex);
  }

  async prompt(
    message: string | AgentPromptMessage,
    target: ConversationTargetInput,
    options: ConversationKernelRunOptions,
    queueMode: ConversationQueueMode = 'followUp',
  ): Promise<ConversationKernelRunResult> {
    const normalized = this.normalizeTarget(target);
    const runtime = this.runtime(normalized, options);
    runtime.options = { ...options };
    this.applyOptions(runtime.runner, options);

    if (runtime.activePromise) {
      this.enqueueSameSession(runtime, message, queueMode);
      return runtime.activePromise;
    }

    runtime.generation = (this.generations.get(runtime.runtimeKey) || runtime.generation || 0) + 1;
    this.generations.set(runtime.runtimeKey, runtime.generation);
    runtime.runId = randomUUID();
    runtime.stopRequestedRunId = '';
    runtime.forceStopArmedRunId = '';
    runtime.stopCheckpointed = false;
    runtime.guideAcceptanceClosedRunId = '';
    // Work-run ownership must be bound before beginConversationWorkRun; doing
    // this only inside run() records non-default conversations under whatever
    // conversation the fresh runner happened to load first.
    runtime.runner.setConversation(runtime.id);
    runtime.runner.beginConversationWorkRun(runtime.runId, {
      workspaceId: runtime.target.workspaceId,
      conversationId: runtime.target.conversationId,
    }, undefined, true, runtime.runtimeKey);
    const runId = runtime.runId;
    let activePromise!: Promise<ConversationKernelRunResult>;
    activePromise = (async (): Promise<ConversationKernelRunResult> => {
      let result: ConversationKernelRunResult | null = null;
      let stopped = false;
      try {
        result = await this.run(runtime, message, options);
        stopped = runtime.runId === runId && runtime.stopRequestedRunId === runId;
      } catch (error) {
        if (runtime.runId === runId && runtime.stopRequestedRunId === runId) {
          stopped = true;
        } else {
          runtime.runner.finishConversationWorkRun(runId, 'error');
          throw error;
        }
      } finally {
        if (runtime.runId === runId && runtime.activePromise === activePromise) {
          runtime.activePromise = null;
          if (runtime.stopRequestedRunId === runId) {
            stopped = true;
            this.settleCooperativeStop(runtime, runId);
          }
        }
      }
      if (stopped) {
        const settled = this.result(runtime, []);
        if (result?.tokens) settled.tokens = result.tokens;
        return settled;
      }
      return result!;
    })();
    runtime.activePromise = activePromise;
    return activePromise;
  }

  private settleCooperativeStop(runtime: ConversationRuntime, runId: string): boolean {
    if (runtime.runId !== runId || runtime.stopRequestedRunId !== runId) return false;
    // Clear supervisor-visible stop state before publishing the terminal event,
    // so an interrupted event can never race a snapshot back into `stopping`.
    runtime.stopRequestedRunId = '';
    runtime.forceStopArmedRunId = '';
    runtime.stopCheckpointed = false;
    runtime.guideAcceptanceClosedRunId = '';
    runtime.runner.finishConversationWorkRun(runId, 'interrupted');
    this.mirrorHostIfTargetActive(runtime);
    this.emitQueueUpdate(runtime);
    return true;
  }

  private async run(
    runtime: ConversationRuntime,
    message: string | AgentPromptMessage,
    options: ConversationKernelRunOptions,
  ): Promise<ConversationKernelRunResult> {
    this.applyOptions(runtime.runner, options);
    runtime.runner.setConversation(runtime.id);
    let lastTokens = await this.runSingle(runtime, message);
    if (runtime.stopRequestedRunId === runtime.runId) {
      this.mirrorHostIfTargetActive(runtime);
      return this.result(runtime, lastTokens);
    }
    for (;;) {
      while (runtime.pendingNextTurn.length > 0) {
        if (runtime.stopRequestedRunId === runtime.runId) return this.result(runtime, lastTokens);
        const next = runtime.pendingNextTurn.shift()!;
        lastTokens = await this.runSingle(runtime, next.message, next.queueMode);
      }
      const rootMessage = runtime.runner.subagents.readRootInbox()[0];
      if (!rootMessage) {
        if (!await this.closeGuideAcceptanceAfterFinalDrain(runtime)) continue;

        if (runtime.stopRequestedRunId === runtime.runId) {
          this.mirrorHostIfTargetActive(runtime);
          return this.result(runtime, lastTokens);
        }
        this.clearQueued(runtime);
        const completedRunId = runtime.runId;
        runtime.runner.finishConversationWorkRun(completedRunId, 'completed');

        // A Guide can be submitted synchronously by a consumer of the public
        // completion event. Keep the promise alive for one task boundary and,
        // when that happens, reopen the same persisted work run rather than
        // routing through prompt(), which would allocate a new runId.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (runtime.runId === completedRunId
          && runtime.stopRequestedRunId !== completedRunId
          && runtime.pendingNextTurn.length > 0) {
          runtime.guideAcceptanceClosedRunId = '';
          if (!runtime.runner.resumeConversationWorkRun(completedRunId)) {
            throw new Error(`Unable to resume deferred Guide work run ${completedRunId}`);
          }
          continue;
        }
        break;
      }
      const marker = `[Root subagent inbox id=${rootMessage.id} ${rootMessage.kind} from ${rootMessage.fromAgentId}]`;
      const prompt = `${marker}\n${rootMessage.body}\n\nReview this persisted peer result and summarize or continue the parent task as needed.`;
      if (!runtime.pendingNextTurn.some(item => item.message === prompt)) {
        runtime.pendingNextTurn.push({ message: prompt, queueMode: 'followUp' });
      }
    }
    this.mirrorHostIfTargetActive(runtime);
    return this.result(runtime, lastTokens);
  }

  private async runSingle(runtime: ConversationRuntime, message: string | AgentPromptMessage, continuationMode?: ConversationQueueMode): Promise<StreamToken[]> {
    this.consumeQueuedMessage(runtime, typeof message === 'string' ? message : message.text);
    const timeoutMs = this.processTimeoutMs(runtime);
    if (timeoutMs <= 0) {
      const tokens = await runtime.runner.process(message);
      if (continuationMode) runtime.runner.consumeConversationContinuation({
        content: typeof message === 'string' ? message : message.text,
        queueMode: continuationMode,
        clientMessageId: typeof message === 'string' ? undefined : message.clientMessageId,
      });
      return tokens;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const tokens = await Promise.race([
        runtime.runner.process(message),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Process timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
        }),
      ]);
      if (continuationMode) runtime.runner.consumeConversationContinuation({
        content: typeof message === 'string' ? message : message.text,
        queueMode: continuationMode,
        clientMessageId: typeof message === 'string' ? undefined : message.clientMessageId,
      });
      return tokens;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private processTimeoutMs(runtime: ConversationRuntime): number {
    const raw = runtime.runner.config.getNum('agent', 'process_timeout_ms') || this.host.config.getNum('agent', 'process_timeout_ms');
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.max(1000, Math.floor(raw));
  }

  private runtime(target: NormalizedConversationTarget, options: ConversationKernelRunOptions): ConversationRuntime {
    const existing = this.findRuntime(target);
    if (existing) {
      this.ensureRuntimeMetadata(existing, target);
      return existing;
    }
    const id = target.conversationId;
    const runner = this.createRunner(target);
    runner.setAutomationManager(this.automation);
    this.applyOptions(runner, options);
    const runtime: ConversationRuntime = {
      id,
      target,
      runtimeKey: target.runtimeKey,
      runner,
      options: { ...options },
      activePromise: null,
      events: [],
      pendingNextTurn: [],
      queued: { steering: [], followUp: [] },
      runId: '',
      generation: this.generations.get(target.runtimeKey) || 0,
      stopRequestedRunId: '',
      forceStopArmedRunId: '',
      stopCheckpointed: false,
      guideAcceptanceClosedRunId: '',
      guideReceipts: new Map(),
      guideEnvelopes: new Map(),
    };
    for (const continuation of runner.conversationContinuations()) {
      runtime.pendingNextTurn.push({
        message: continuation.clientMessageId || continuation.images?.length
          ? {
              text: continuation.content,
              images: continuation.images,
              attachments: continuation.attachments,
              clientMessageId: continuation.clientMessageId,
              runId: continuation.runId,
            }
          : continuation.content,
        queueMode: continuation.queueMode,
      });
      this.trackQueuedMessage(runtime, continuation.content, continuation.queueMode);
    }
    runtime.unsubscribe = runner.subscribeWorkEvents(event => {
      const routedEvent: AgentWorkEvent = {
        ...event,
        conversationId: runtime.target.conversationId,
        workspaceId: runtime.target.workspaceId,
        workspaceKey: runtime.target.workspaceKey,
        runtimeKey: runtime.runtimeKey,
        runId: runtime.runId || undefined,
        generation: runtime.generation || undefined,
      };
      runtime.events.push(routedEvent);
      if (runtime.events.length > this.eventLimit) runtime.events = runtime.events.slice(-this.eventLimit);
      for (const listener of this.listeners) listener(routedEvent);
    });
    runner.subscribeAgentKernelUserMessageStart((content, clientMessageId) => {
      this.consumeQueuedMessage(runtime, content);
      if (!clientMessageId) return;
      const receipt = this.guideReceipt(runtime, clientMessageId);
      if (!receipt || receipt.status === 'applied' || receipt.status === 'rejected') return;
      const applied: GuideReceipt = {
        ...receipt,
        status: 'applied',
        updatedAt: new Date().toISOString(),
        appliedAt: new Date().toISOString(),
      };
      runtime.guideReceipts.set(clientMessageId, applied);
      runtime.runner.recordGuideReceipt(applied);
      runtime.guideEnvelopes.delete(clientMessageId);
    });
    runtime.unsubscribeRootInboxWake = runner.subscribeRootInboxWake(message => {
      this.enqueueRootInboxWake(runtime, message);
      return true;
    });
    this.runtimes.set(target.runtimeKey, runtime);
    return runtime;
  }

  private createRunner(target: NormalizedConversationTarget): Agent {
    const runner = this.lifecycle.createRunner?.(target) || new Agent(this.root, { actorId: this.host.runtimeActorId });
    if (target.workspace) {
      runner.workspace.current = {
        id: target.workspace.id,
        name: target.workspace.name,
        path: target.workspace.path,
        isInternal: target.workspace.isInternal,
        hostBinding: '',
        conversationStatePrefix: target.workspace.conversationStatePrefix,
        icon: '',
        kind: target.workspace.kind === 'ssh' ? 'ssh' : 'local',
      };
      runner.config.loadWorkspaceConfig(target.workspace.path);
    } else {
      runner.workspace.current = null;
      runner.config.clearWorkspaceOverrides();
    }
    // snapshot() can create a cold runner before prompt() has established a
    // runtime. The constructor may have loaded another conversation from the
    // globally selected workspace, so binding must be read-only: saving that
    // transitional state here can erase the previous conversation when a new
    // Build is started in a sibling conversation.
    runner.setConversationFromStorage(target.conversationId);
    runner.ensureConversationSnapshot(target.conversationId);
    return runner;
  }

  private enqueueRootInboxWake(runtime: ConversationRuntime, message: string): void {
    queueMicrotask(() => {
      const rootInboxId = message.match(/^\[Root subagent inbox id=([0-9a-f-]{36})\b/i)?.[1];
      if (rootInboxId && !runtime.runner.subagents.readRootInbox().some(item => item.id === rootInboxId)) return;
      if (runtime.activePromise) {
        if (!runtime.pendingNextTurn.some(item => item.message === message)) {
          runtime.pendingNextTurn.push({ message, queueMode: 'followUp' });
        }
        return;
      }
      void this.prompt(message, runtime.target, runtime.options, 'followUp').catch(error => {
        runtime.runner.recordWorkStatus(`Subagent result follow-up failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }

  private applyOptions(agent: Agent, options: ConversationKernelRunOptions): void {
    agent.setMode(options.mode);
    if (options.mode === 'goal' && this.host.goal) {
      agent.updateGoal(this.host.goal.objective);
      if (this.host.goal.paused && agent.goal) agent.goal.paused = true;
    }
    agent.setModel(options.model);
    agent.setIntelligence(options.intelligence);
    agent.inputMode = options.inputMode;
    agent.engine = options.engine;
  }

  private result(runtime: ConversationRuntime, tokens: StreamToken[]): ConversationKernelRunResult {
    this.refreshHostIfActive(runtime.target);
    return {
      tokens: tokens.map(t => ({ type: t.type, text: t.text })),
      diffs: runtime.runner.fileDiffs.map(d => ({
        path: d.path,
        old: changedLineCount(d.oldContent),
        new: changedLineCount(d.newContent),
        oldContent: d.oldContent,
        newContent: d.newContent,
      })),
      mode: runtime.runner.mode,
      model: runtime.runner.model,
      status: runtime.runner.status,
      goal: runtime.runner.goal ? { objective: runtime.runner.goal.objective, paused: runtime.runner.goal.paused } : null,
      options: runtime.runner.pendingOptions,
      contextCompression: runtime.runner.lastCompression,
      contextWindow: runtime.runner.contextWindow(),
      conversationId: runtime.id,
      activeConversationId: this.host.activeConversationId,
      conversations: runtime.runner.listConversationStates(),
      conversationPlan: runtime.runner.getConversationPlan(),
      linkedPlan: runtime.runner.getLinkedPlan(),
      subagents: runtime.runner.subagents.listAll().map(record => runtime.runner.subagents.toRecord(record.id)).filter((record): record is NonNullable<typeof record> => !!record),
      chatMessages: runtime.runner.chatMessages,
      historyMessages: runtime.runner.history.length,
      conversationLocked: false,
      queued: this.queued(runtime.target),
      target: runtime.target,
      workspaceKey: runtime.target.workspaceKey,
      runtimeKey: runtime.runtimeKey,
      runId: runtime.runId,
      generation: runtime.generation,
      workRuns: this.bindWorkRunsToRuntimeTarget(
        runtime.runner.getConversationSnapshot(runtime.id).workRuns,
        runtime.target,
      ),
      routeDecision: runtime.runner.lastRouteDecision,
      resolvedDeployment: runtime.runner.activeDeployment(),
      autoRouteRatingAvailable: runtime.runner.model === 'auto'
        && runtime.runner.lastRouteDecision?.requestedSelection.kind === 'auto'
        && !!runtime.runner.lastRouteDecision.resolvedDeployment,
    };
  }

  /**
   * Treat persisted work-run routing fields as untrusted display data.
   * Old or damaged state can contain another target's identity, so every
   * public kernel boundary returns fresh records bound to its supervisor-owned
   * normalized target without rewriting the runner's durable state.
   */
  private bindWorkRunsToRuntimeTarget(
    workRuns: Agent['workRuns'],
    target: NormalizedConversationTarget,
  ): Agent['workRuns'] {
    const publicTarget = (): { workspaceId: string; conversationId: string } => ({
      workspaceId: target.workspaceId,
      conversationId: target.conversationId,
    });
    const bindGuide = (guide: GuideReceipt): GuideReceipt => ({
      ...guide,
      target: publicTarget(),
    });
    return (workRuns || []).map(run => ({
      ...run,
      target: publicTarget(),
      runtimeKey: target.runtimeKey,
      events: (run.events || []).map(event => ({
        ...event,
        workspaceId: target.workspaceId,
        workspaceKey: target.workspaceKey,
        conversationId: target.conversationId,
        runtimeKey: target.runtimeKey,
        guide: event.guide ? bindGuide(event.guide) : undefined,
      })),
      guides: (run.guides || []).map(bindGuide),
    }));
  }

  private enqueueSameSession(runtime: ConversationRuntime, message: string | AgentPromptMessage, queueMode: ConversationQueueMode): void {
    const isSteer = queueMode === 'steer';
    const text = typeof message === 'string' ? message : message.text;
    const prompt = isSteer ? text : `[Next queued while current turn is running]\n${text}`;
    if (!isSteer) this.trackQueuedMessage(runtime, prompt, queueMode);
    if (runtime.stopRequestedRunId === runtime.runId) {
      runtime.forceStopArmedRunId = '';
      const structured = typeof message === 'string' ? undefined : message;
      const alreadyPending = runtime.pendingNextTurn.some(item => {
        const existingText = typeof item.message === 'string' ? item.message : item.message.text;
        const existingId = typeof item.message === 'string' ? undefined : item.message.clientMessageId;
        return structured?.clientMessageId
          ? existingId === structured.clientMessageId
          : item.queueMode === queueMode && existingText === prompt;
      });
      if (!alreadyPending) runtime.pendingNextTurn.push({
        message: structured
          ? { ...structured, text: prompt, runId: structured.runId || runtime.runId, images: structured.images?.map(image => ({ ...image })) }
          : prompt,
        queueMode,
      });
      runtime.runner.retainConversationContinuations([{
        content: prompt,
        queueMode,
        clientMessageId: structured?.clientMessageId,
        runId: structured?.runId || runtime.runId,
        images: structured?.images?.map(image => ({ ...image })),
      }]);
      runtime.runner.recordWorkStatus(isSteer ? 'Guidance retained while stopping.' : 'Next message retained while stopping.');
      this.emitQueueUpdate(runtime);
      return;
    }
    const queued = runtime.runner.queueActiveKernelMessage(prompt, queueMode);
    if (!queued) runtime.pendingNextTurn.push({ message: prompt, queueMode });
    runtime.runner.recordWorkStatus(isSteer
      ? 'Guidance received.'
      : (queued ? 'Next message queued.' : 'Next message recorded for the next turn.'));
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
      queue: this.queued(runtime.target),
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

  private normalizeTarget(input: ConversationTargetInput): NormalizedConversationTarget {
    if (typeof input !== 'string') {
      const withWorkspace = input.workspace ? input : { ...input, workspace: this.workspaceForId(input.workspaceId) };
      return normalizeConversationTarget(withWorkspace);
    }
    const workspace = this.host.workspace.current;
    return normalizeConversationTarget({
      workspaceId: workspace?.id || workspace?.path || workspace?.name || 'none',
      conversationId: safeConversationId(input),
      workspace: workspace ? {
        id: workspace.id || workspace.path,
        name: workspace.name || workspace.path,
        path: workspace.path,
        isInternal: workspace.isInternal,
        kind: workspace.kind,
      } : null,
    });
  }

  private workspaceForId(workspaceId: string): ConversationRuntimeTarget['workspace'] {
    const clean = String(workspaceId || '').trim();
    const candidates = [this.host.workspace.current, ...this.host.workspace.internal, ...this.host.workspace.external].filter(Boolean);
    const identityMatch = candidates.find(item => item!.id === clean || item!.path === clean);
    const nameMatches = candidates.filter(item => item!.name === clean);
    const workspace = identityMatch || (nameMatches.length === 1 ? nameMatches[0] : null);
    return workspace ? {
      id: workspace.id || workspace.path,
      name: workspace.name || workspace.path,
      path: workspace.path,
      isInternal: workspace.isInternal,
      kind: workspace.kind,
      conversationStatePrefix: workspace.conversationStatePrefix,
    } : null;
  }

  private findRuntime(input: ConversationTargetInput): ConversationRuntime | undefined {
    const normalized = this.normalizeTarget(input);
    const composite = this.runtimes.get(normalized.runtimeKey);
    if (composite) return composite;
    if (typeof input === 'string') return this.runtimes.get(safeConversationId(input));
    return undefined;
  }

  private ensureRuntimeMetadata(runtime: ConversationRuntime, target: NormalizedConversationTarget): void {
    if (!runtime.id) runtime.id = target.conversationId;
    if (!runtime.target) runtime.target = target;
    if (!runtime.runtimeKey) runtime.runtimeKey = target.runtimeKey;
    if (!runtime.runId) runtime.runId = '';
    if (!Number.isFinite(runtime.generation)) runtime.generation = 0;
    if (!runtime.stopRequestedRunId) runtime.stopRequestedRunId = '';
    if (!runtime.forceStopArmedRunId) runtime.forceStopArmedRunId = '';
    if (typeof runtime.stopCheckpointed !== 'boolean') runtime.stopCheckpointed = false;
    if (typeof runtime.guideAcceptanceClosedRunId !== 'string') runtime.guideAcceptanceClosedRunId = '';
    if (!(runtime.guideReceipts instanceof Map)) runtime.guideReceipts = new Map();
    if (!(runtime.guideEnvelopes instanceof Map)) runtime.guideEnvelopes = new Map();
    this.queueState(runtime);
  }

  private deferOutstandingGuides(runtime: ConversationRuntime): void {
    for (const [clientMessageId, receipt] of runtime.guideReceipts) {
      if (receipt.status !== 'accepted' && receipt.status !== 'deferred') continue;
      const envelope = runtime.guideEnvelopes.get(clientMessageId);
      const alreadyPending = runtime.pendingNextTurn.some(item =>
        typeof item.message !== 'string' && item.message.clientMessageId === clientMessageId);
      if (!alreadyPending) {
        runtime.pendingNextTurn.push({
          message: {
            text: envelope?.text || receipt.content || '',
            images: envelope?.images?.map(image => ({ ...image })),
            attachments: receipt.attachments?.map(attachment => ({ ...attachment })),
            clientMessageId,
            runId: receipt.runId,
          },
          queueMode: 'steer',
        });
      }
      runtime.runner.retainConversationContinuations([{
        content: envelope?.text || receipt.content || '',
        queueMode: 'steer',
        clientMessageId,
        runId: receipt.runId,
        images: envelope?.images?.map(image => ({ ...image })),
        attachments: receipt.attachments?.map(attachment => ({ ...attachment })),
      }]);
      const deferred: GuideReceipt = {
        ...receipt,
        status: 'deferred',
        updatedAt: new Date().toISOString(),
        reason: 'Conversation stopped before this Guide was applied; it is retained for the next continuation.',
      };
      runtime.guideReceipts.set(clientMessageId, deferred);
      runtime.runner.recordGuideReceipt(deferred);
    }
  }

  /**
   * Gives IPC/microtask Guide delivery one last turn after the queue first
   * appears empty, then closes acceptance and rechecks synchronously. Once the
   * close flag is set no Guide can be accepted into the finishing run: it is
   * explicitly persisted as a deferred continuation instead.
   */
  private async closeGuideAcceptanceAfterFinalDrain(runtime: ConversationRuntime): Promise<boolean> {
    const runId = runtime.runId;
    await Promise.resolve();
    if (runtime.runId !== runId || runtime.stopRequestedRunId === runId) return true;
    if (runtime.pendingNextTurn.length > 0 || runtime.runner.subagents.readRootInbox().length > 0) return false;
    runtime.guideAcceptanceClosedRunId = runId;
    if (runtime.pendingNextTurn.length > 0 || runtime.runner.subagents.readRootInbox().length > 0) {
      runtime.guideAcceptanceClosedRunId = '';
      return false;
    }
    return true;
  }

  private rejectOutstandingGuides(runtime: ConversationRuntime, reason: string): void {
    const rejectedIds = new Set<string>();
    for (const [clientMessageId, receipt] of runtime.guideReceipts) {
      if (receipt.status !== 'accepted' && receipt.status !== 'deferred') continue;
      rejectedIds.add(clientMessageId);
      const rejected: GuideReceipt = {
        ...receipt,
        status: 'rejected',
        updatedAt: new Date().toISOString(),
        reason,
      };
      runtime.guideReceipts.set(clientMessageId, rejected);
      runtime.guideEnvelopes.delete(clientMessageId);
      runtime.runner.consumeConversationContinuation({ content: receipt.content || '', queueMode: 'steer', clientMessageId });
      runtime.runner.recordGuideReceipt(rejected);
    }
    if (rejectedIds.size) {
      runtime.pendingNextTurn = runtime.pendingNextTurn.filter(item =>
        typeof item.message === 'string' || !item.message.clientMessageId || !rejectedIds.has(item.message.clientMessageId));
    }
  }

  private retainUnconsumedKernelMessages(runtime: ConversationRuntime): void {
    const drained = runtime.runner.drainAllUnconsumedAgentKernelMessages();
    if (!drained.length) return;
    const retained = drained.map(item => ({
      ...item,
      attachments: item.clientMessageId
        ? this.guideReceipt(runtime, item.clientMessageId)?.attachments?.map(attachment => ({ ...attachment }))
        : undefined,
    }));
    runtime.runner.retainConversationContinuations(retained);
    for (const item of retained) {
      const duplicate = runtime.pendingNextTurn.some(existing => {
        const existingText = typeof existing.message === 'string' ? existing.message : existing.message.text;
        const existingId = typeof existing.message === 'string' ? undefined : existing.message.clientMessageId;
        return item.clientMessageId ? existingId === item.clientMessageId : existing.queueMode === item.queueMode && existingText === item.content;
      });
      if (duplicate) continue;
      runtime.pendingNextTurn.push({
        message: item.clientMessageId || item.images?.length || item.attachments?.length
          ? {
              text: item.content,
              images: item.images,
              attachments: item.attachments,
              clientMessageId: item.clientMessageId,
              runId: item.runId,
            }
          : item.content,
        queueMode: item.queueMode,
      });
    }
  }

  private guideReceipt(runtime: ConversationRuntime, clientMessageId: string): GuideReceipt | undefined {
    const cached = runtime.guideReceipts?.get(clientMessageId);
    if (cached) return cached;
    for (const run of runtime.runner.workRuns || []) {
      const receipt = run.guides.find(item => item.clientMessageId === clientMessageId);
      if (receipt) {
        runtime.guideReceipts.set(clientMessageId, receipt);
        return receipt;
      }
    }
    return undefined;
  }

  private hostTarget(conversationId = this.host.activeConversationId || 'default'): NormalizedConversationTarget {
    return this.normalizeTarget(conversationId);
  }

  private targetIsActive(target: NormalizedConversationTarget): boolean {
    const active = this.hostTarget(target.conversationId);
    return active.workspaceKey === target.workspaceKey
      && safeConversationId(this.host.activeConversationId || 'default') === target.conversationId;
  }

  private mirrorHostIfTargetActive(runtime: ConversationRuntime): void {
    if (!this.targetIsActive(runtime.target)) return;
    this.host.mirrorConversationStateFrom(runtime.id, runtime.runner);
    this.refreshHostIfActive(runtime.target);
  }

  private refreshHostIfActive(target: NormalizedConversationTarget): void {
    if (this.targetIsActive(target)) this.host.setConversation(target.conversationId);
  }
}
