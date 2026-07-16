import { AgentWorkEvent, ConversationInputEnvelope, GuideReceipt } from './types';
import { ConversationRuntimeTarget, NormalizedConversationTarget, conversationRuntimeKey, normalizeConversationTarget } from './conversationTarget';
import { WslAgentClient, WslHostToolHandler } from './wslAgentClient';
import {
  WslAgentPromptRequest,
  WslAgentPromptResult,
  WslAutoRouteRatingResult,
  WslAgentStopResult,
  WslConversationRewindResult,
} from './wslAgentProtocol';
import { RuntimePoolCapacityError } from './runtimePoolCapacity';

export interface WslTargetRuntimeClient {
  subscribe(listener: (event: AgentWorkEvent) => void): () => void;
  setHostToolHandler(handler: WslHostToolHandler | null): void;
  prompt(params: WslAgentPromptRequest): Promise<WslAgentPromptResult>;
  snapshotTarget(target: ConversationRuntimeTarget): Promise<Record<string, unknown>>;
  rewind(target: ConversationRuntimeTarget, messageIndex: number): Promise<WslConversationRewindResult>;
  requestStop(target: ConversationRuntimeTarget, runId?: string): Promise<WslAgentStopResult>;
  enqueueGuide(target: ConversationRuntimeTarget, envelope: ConversationInputEnvelope): Promise<GuideReceipt>;
  checkpoint(target: ConversationRuntimeTarget): Promise<Record<string, unknown>>;
  rateAutoRoute?(target: ConversationRuntimeTarget, score: number, routeId?: string): Promise<WslAutoRouteRatingResult>;
  setWorkRunExpanded(target: ConversationRuntimeTarget, runId: string, expanded: boolean): Promise<boolean>;
  updateSetting(section: string, key: string, value: unknown): Promise<void>;
  forceRestartRuntimeGroup(): Promise<void>;
  stop(): Promise<void>;
  status(): { enabled: true; connected: boolean; distro: string; pid: number; error: string };
}

export type WslTargetRuntimeClientFactory = (target: NormalizedConversationTarget) => WslTargetRuntimeClient;
export type WslPoolStopResult = WslAgentStopResult & { restarted?: boolean };

interface SupervisorStopIntent {
  runId: string;
  generation: number;
  checkpointed: boolean;
  forcePromise: Promise<WslPoolStopResult> | null;
}

interface RuntimeEntry {
  target: NormalizedConversationTarget;
  client: WslTargetRuntimeClient;
  unsubscribe: () => void;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastSnapshot: Record<string, unknown> | null;
  lastRunId: string;
  lastGeneration: number;
  workEvents: AgentWorkEvent[];
  stopIntent: SupervisorStopIntent | null;
  activeOperations: number;
}

export interface WslAgentRuntimePoolOptions {
  idleTtlMs?: number;
  stopRequestTimeoutMs?: number;
  maxResidentRuntimes?: number;
}

/**
 * Owns one WSL host/process group per active workspace+conversation target.
 * This boundary is required for a real second-click hard stop: killing an
 * in-process promise or a shared WSL host cannot guarantee isolation.
 */
export class WslAgentRuntimePool {
  private entries = new Map<string, RuntimeEntry>();
  private listeners = new Set<(event: AgentWorkEvent) => void>();
  private hostToolHandler: WslHostToolHandler | null = null;
  private restarting = new Set<string>();
  private disposing = new Set<string>();
  private capacityTail: Promise<void> = Promise.resolve();
  private accessSequence = 0;

  constructor(
    private readonly distro: string,
    private readonly windowsRoot: string,
    private readonly windowsHostScript: string,
    private readonly createClient: WslTargetRuntimeClientFactory = (target) => new WslAgentClient(distro, windowsRoot, windowsHostScript, target),
    private readonly options: WslAgentRuntimePoolOptions = {},
  ) {}

  subscribe(listener: (event: AgentWorkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setHostToolHandler(handler: WslHostToolHandler | null): void {
    this.hostToolHandler = handler;
    for (const entry of this.entries.values()) entry.client.setHostToolHandler(handler);
  }

  async prompt(params: WslAgentPromptRequest): Promise<WslAgentPromptResult> {
    const target = this.normalizeRequestTarget(params);
    const entry = await this.acquire(target);
    entry.stopIntent = null;
    try {
      const result = await entry.client.prompt({ ...params, target });
      entry.lastRunId = result.runId || entry.lastRunId;
      entry.lastGeneration = Number(result.generation || entry.lastGeneration || 0);
      return result;
    } finally {
      this.release(entry, true);
    }
  }

  async snapshot(target: ConversationRuntimeTarget): Promise<Record<string, unknown>> {
    const normalized = normalizeConversationTarget(target);
    const entry = await this.acquire(normalized);
    let scheduleIdle = false;
    try {
      if (entry.stopIntent) return this.supervisorSnapshot(entry);
      const result = await entry.client.snapshotTarget(normalized);
      entry.lastSnapshot = result;
      const runtime = result.runtime as { running?: boolean; stopRequested?: boolean } | null | undefined;
      const runtimeIdentity = result.runtime as { runId?: string; generation?: number } | null | undefined;
      if (runtimeIdentity?.runId) entry.lastRunId = runtimeIdentity.runId;
      if (runtimeIdentity?.generation) entry.lastGeneration = runtimeIdentity.generation;
      scheduleIdle = !runtime?.running && !runtime?.stopRequested;
      return result;
    } finally {
      this.release(entry, scheduleIdle);
    }
  }

  async rewind(target: ConversationRuntimeTarget, messageIndex: number): Promise<WslConversationRewindResult> {
    const normalized = normalizeConversationTarget(target);
    const entry = await this.acquire(normalized);
    try {
      if (entry.stopIntent) throw new Error('Cannot edit a message while this conversation is stopping.');
      const result = await entry.client.rewind(normalized, messageIndex);
      entry.lastSnapshot = null;
      entry.workEvents = [];
      entry.lastRunId = '';
      entry.stopIntent = null;
      return result;
    } finally {
      this.release(entry, true);
    }
  }

  async requestStop(target: ConversationRuntimeTarget, runId?: string): Promise<WslPoolStopResult> {
    const normalized = normalizeConversationTarget(target);
    const entry = this.entries.get(normalized.runtimeKey);
    if (!entry) {
      return { action: 'not_running', runtimeKey: normalized.runtimeKey, checkpointed: false, backend: 'wsl', distro: this.distro };
    }
    const requestedRunId = String(runId || entry.lastRunId || '');
    const existing = entry.stopIntent;
    if (existing) {
      if (requestedRunId && existing.runId && requestedRunId !== existing.runId) {
        return {
          action: 'stale',
          runtimeKey: normalized.runtimeKey,
          runId: existing.runId,
          generation: existing.generation,
          checkpointed: false,
          backend: 'wsl',
          distro: this.distro,
        };
      }
      return await this.forceRestartEntry(entry, existing);
    }

    const intent: SupervisorStopIntent = {
      runId: requestedRunId,
      generation: entry.lastGeneration,
      checkpointed: false,
      forcePromise: null,
    };
    entry.stopIntent = intent;
    this.emitSupervisorStatus(entry, 'stopping', 'Stopping conversation runtime. Press stop again to force restart it.');
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutMs = Math.max(10, Number(this.options.stopRequestTimeoutMs ?? 5_250));
      const result = await Promise.race([
        entry.client.requestStop(normalized, requestedRunId || undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('WSL conversation stop acknowledgement timed out')), timeoutMs);
        }),
      ]);
      if (intent.forcePromise) return await intent.forcePromise;
      if (result.action === 'force') {
        intent.runId = result.runId || intent.runId;
        intent.generation = result.generation || intent.generation;
        intent.checkpointed = result.checkpointed || intent.checkpointed;
        return await this.forceRestartEntry(entry, intent);
      }
      if (result.action === 'graceful') {
        intent.runId = result.runId || intent.runId;
        intent.generation = result.generation || intent.generation;
        intent.checkpointed = result.checkpointed || intent.checkpointed;
      } else if (entry.stopIntent === intent) {
        entry.stopIntent = null;
      }
      return result;
    } catch {
      if (intent.forcePromise) return await intent.forcePromise;
      return this.gracefulSupervisorResult(entry, intent);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async enqueueGuide(envelope: ConversationInputEnvelope): Promise<GuideReceipt> {
    const entry = await this.acquireExisting(envelope.target);
    if (!entry) {
      const now = new Date().toISOString();
      return {
        clientMessageId: envelope.clientMessageId,
        target: envelope.target,
        runId: envelope.runId || '',
        status: 'rejected',
        content: envelope.text,
        createdAt: envelope.createdAt || now,
        updatedAt: now,
        reason: 'Target conversation is not running',
      };
    }
    entry.stopIntent = null;
    try {
      return await entry.client.enqueueGuide(entry.target, envelope);
    } finally {
      this.release(entry, true);
    }
  }

  async checkpoint(target: ConversationRuntimeTarget): Promise<Record<string, unknown>> {
    const normalized = normalizeConversationTarget(target);
    const entry = await this.acquireExisting(normalized);
    if (!entry) {
      return {
        runtimeKey: normalized.runtimeKey,
        runId: '',
        generation: 0,
        checkpointed: false,
        at: new Date().toISOString(),
      };
    }
    try {
      return await entry.client.checkpoint(normalized);
    } finally {
      this.release(entry, true);
    }
  }

  async rateAutoRoute(
    target: ConversationRuntimeTarget,
    score: number,
    routeId = '',
  ): Promise<WslAutoRouteRatingResult> {
    const normalized = normalizeConversationTarget(target);
    const entry = await this.acquireExisting(normalized);
    if (!entry || !entry.client.rateAutoRoute) {
      return { ok: false, reason: 'no_active_auto_route' };
    }
    try {
      return await entry.client.rateAutoRoute(normalized, score, routeId);
    } finally {
      this.release(entry, true);
    }
  }

  async setWorkRunExpanded(target: ConversationRuntimeTarget, runId: string, expanded: boolean): Promise<boolean> {
    const normalized = normalizeConversationTarget(target);
    const entry = await this.acquire(normalized);
    try {
      return await entry.client.setWorkRunExpanded(normalized, runId, expanded);
    } finally {
      this.release(entry, true);
    }
  }

  async updateSetting(section: string, key: string, value: unknown): Promise<void> {
    await Promise.all(Array.from(this.entries.values()).map(entry => entry.client.updateSetting(section, key, value)));
  }

  status(target: ConversationRuntimeTarget): ReturnType<WslTargetRuntimeClient['status']> & { runtimeKey: string } {
    const normalized = normalizeConversationTarget(target);
    const entry = this.entries.get(normalized.runtimeKey);
    const status = entry?.client.status() || { enabled: true as const, connected: false, distro: this.distro, pid: 0, error: '' };
    return { ...status, runtimeKey: normalized.runtimeKey };
  }

  runtimeKeys(): string[] {
    return Array.from(this.entries.keys());
  }

  isRestarting(target: ConversationRuntimeTarget): boolean {
    return this.restarting.has(normalizeConversationTarget(target).runtimeKey);
  }

  isStopping(target: ConversationRuntimeTarget): boolean {
    const runtimeKey = normalizeConversationTarget(target).runtimeKey;
    return this.disposing.has(runtimeKey) || !!this.entries.get(runtimeKey)?.stopIntent;
  }

  async hasActiveWorkspace(target: ConversationRuntimeTarget): Promise<boolean> {
    const workspaceKey = normalizeConversationTarget(target).workspaceKey;
    for (const entry of this.entries.values()) {
      if (entry.target.workspaceKey !== workspaceKey) continue;
      if (this.restarting.has(entry.target.runtimeKey) || entry.stopIntent) return true;
      try {
        const snapshot = await entry.client.snapshotTarget(entry.target);
        const runtime = snapshot.runtime as { running?: boolean; stopRequested?: boolean } | null | undefined;
        if (runtime?.running || runtime?.stopRequested) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  async stopWorkspace(target: ConversationRuntimeTarget): Promise<void> {
    const workspaceKey = normalizeConversationTarget(target).workspaceKey;
    const entries = Array.from(this.entries.values()).filter(entry => entry.target.workspaceKey === workspaceKey);
    const results = await Promise.allSettled(entries.map(entry => this.stopTarget(entry.target)));
    this.throwStopFailures(results, 'One or more WSL workspace runtimes could not be stopped');
  }

  async stopTarget(target: ConversationRuntimeTarget): Promise<void> {
    const key = conversationRuntimeKey(target);
    await this.serializeCapacity(async () => {
      const entry = this.entries.get(key);
      if (entry) await this.stopEntry(entry);
    });
  }

  async stopAll(): Promise<void> {
    const targets = Array.from(this.entries.values(), entry => entry.target);
    const results = await Promise.allSettled(targets.map(target => this.stopTarget(target)));
    this.throwStopFailures(results, 'One or more WSL runtimes could not be stopped');
  }

  private throwStopFailures(results: PromiseSettledResult<void>[], message: string): void {
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    if (failures.length) throw new AggregateError(failures, message);
  }

  private async stopEntry(entry: RuntimeEntry): Promise<void> {
    const runtimeKey = entry.target.runtimeKey;
    this.disposing.add(runtimeKey);
    entry.stopIntent = null;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    try {
      await entry.client.stop();
      if (this.entries.get(runtimeKey) === entry) {
        this.entries.delete(runtimeKey);
        entry.unsubscribe();
        entry.client.setHostToolHandler(null);
      }
    } finally {
      this.disposing.delete(runtimeKey);
    }
  }

  private async acquire(target: NormalizedConversationTarget): Promise<RuntimeEntry> {
    return await this.serializeCapacity(async () => {
      const existing = this.entries.get(target.runtimeKey);
      if (existing) {
        this.touch(existing);
        existing.activeOperations += 1;
        return existing;
      }
      const capacity = this.maxResidentRuntimes();
      if (this.entries.size >= capacity) await this.evictLeastRecentlyUsedIdle();
      if (this.entries.size >= capacity) throw new RuntimePoolCapacityError('wsl', capacity);
      return this.createEntry(target);
    });
  }

  private async acquireExisting(target: { workspaceId: string; conversationId: string }): Promise<RuntimeEntry | undefined> {
    return await this.serializeCapacity(async () => {
      const entry = this.findEntry(target);
      if (!entry || this.disposing.has(entry.target.runtimeKey)) return undefined;
      this.touch(entry);
      entry.activeOperations += 1;
      return entry;
    });
  }

  private createEntry(target: NormalizedConversationTarget): RuntimeEntry {
    const client = this.createClient(target);
    client.setHostToolHandler(this.hostToolHandler);
    const entry: RuntimeEntry = {
      target,
      client,
      lastUsedAt: this.nextAccessSequence(),
      idleTimer: null,
      lastSnapshot: null,
      lastRunId: '',
      lastGeneration: 0,
      workEvents: [],
      stopIntent: null,
      activeOperations: 1,
      unsubscribe: client.subscribe(event => {
        if (event.runId) entry.lastRunId = event.runId;
        if (event.generation) entry.lastGeneration = event.generation;
        if (entry.stopIntent
          && (!entry.stopIntent.runId || !event.runId || entry.stopIntent.runId === event.runId)
          && ['completed', 'interrupted', 'force_interrupted', 'error'].includes(String(event.status || ''))) {
          entry.stopIntent = null;
        }
        const routed: AgentWorkEvent = {
          ...event,
          conversationId: target.conversationId,
          workspaceId: target.workspaceId,
          workspaceKey: target.workspaceKey,
          runtimeKey: target.runtimeKey,
        };
        entry.workEvents.push(routed);
        if (entry.workEvents.length > 500) entry.workEvents = entry.workEvents.slice(-500);
        for (const listener of this.listeners) listener(routed);
      }),
    };
    this.entries.set(target.runtimeKey, entry);
    return entry;
  }

  private touch(entry: RuntimeEntry): void {
    entry.lastUsedAt = this.nextAccessSequence();
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  private release(entry: RuntimeEntry, shouldScheduleIdle: boolean): void {
    entry.activeOperations = Math.max(0, entry.activeOperations - 1);
    if (this.entries.get(entry.target.runtimeKey) !== entry) return;
    if (shouldScheduleIdle) this.scheduleIdle(entry);
  }

  private nextAccessSequence(): number {
    this.accessSequence += 1;
    return this.accessSequence;
  }

  private maxResidentRuntimes(): number {
    const configured = Number(this.options.maxResidentRuntimes ?? 2);
    return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 2;
  }

  private async serializeCapacity<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.capacityTail;
    let release!: () => void;
    this.capacityTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async evictLeastRecentlyUsedIdle(): Promise<void> {
    const candidates = Array.from(this.entries.values()).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of candidates) {
      const runtimeKey = entry.target.runtimeKey;
      if (entry.activeOperations > 0
        || entry.stopIntent
        || this.restarting.has(runtimeKey)
        || this.disposing.has(runtimeKey)) continue;
      const expectedLastUsedAt = entry.lastUsedAt;
      let snapshot: Record<string, unknown>;
      try {
        snapshot = await entry.client.snapshotTarget(entry.target);
      } catch {
        // An unknown state is not proof that a runtime is idle.
        continue;
      }
      const runtime = snapshot.runtime as { running?: boolean; stopRequested?: boolean } | null | undefined;
      if (this.entries.get(runtimeKey) !== entry
        || entry.lastUsedAt !== expectedLastUsedAt
        || entry.activeOperations > 0
        || entry.stopIntent
        || this.restarting.has(runtimeKey)
        || this.disposing.has(runtimeKey)) continue;
      if (runtime?.running || runtime?.stopRequested) continue;
      await this.stopEntry(entry);
      return;
    }
  }

  private scheduleIdle(entry: RuntimeEntry): void {
    this.touch(entry);
    const ttl = Math.max(10, Number(this.options.idleTtlMs ?? 5 * 60 * 1000));
    const timer = setTimeout(() => { void this.evictIfIdle(entry.target.runtimeKey, entry.lastUsedAt); }, ttl);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  private async evictIfIdle(runtimeKey: string, expectedLastUsedAt: number): Promise<void> {
    await this.serializeCapacity(async () => {
      const entry = this.entries.get(runtimeKey);
      if (!entry || entry.lastUsedAt !== expectedLastUsedAt) return;
      if (entry.activeOperations > 0 || entry.stopIntent || this.restarting.has(runtimeKey) || this.disposing.has(runtimeKey)) {
        this.scheduleIdle(entry);
        return;
      }
      let snapshot: Record<string, unknown>;
      try {
        snapshot = await entry.client.snapshotTarget(entry.target);
      } catch {
        if (this.entries.get(runtimeKey) !== entry || entry.lastUsedAt !== expectedLastUsedAt) return;
        await this.stopEntry(entry);
        return;
      }
      if (this.entries.get(runtimeKey) !== entry || entry.lastUsedAt !== expectedLastUsedAt) return;
      const runtime = snapshot.runtime as { running?: boolean; stopRequested?: boolean } | null | undefined;
      if (runtime?.running || runtime?.stopRequested) {
        this.scheduleIdle(entry);
        return;
      }
      await this.stopEntry(entry);
    });
  }

  private findEntry(target: { workspaceId: string; conversationId: string }): RuntimeEntry | undefined {
    const direct = this.entries.get(normalizeConversationTarget(target).runtimeKey);
    if (direct) return direct;
    return Array.from(this.entries.values()).find(entry =>
      entry.target.workspaceId === target.workspaceId
      && entry.target.conversationId === target.conversationId);
  }

  private normalizeRequestTarget(params: WslAgentPromptRequest): NormalizedConversationTarget {
    if (params.target) return normalizeConversationTarget(params.target);
    const workspace = params.workspace || null;
    return normalizeConversationTarget({
      workspaceId: String(workspace?.id || workspace?.name || workspace?.path || 'none'),
      conversationId: params.conversationId || 'default',
      workspace: workspace ? {
        id: String(workspace.id || workspace.name || workspace.path),
        name: workspace.name,
        path: workspace.path,
        isInternal: !!workspace.isInternal,
        kind: workspace.kind,
      } : null,
    });
  }

  private gracefulSupervisorResult(entry: RuntimeEntry, intent: SupervisorStopIntent): WslPoolStopResult {
    return {
      action: 'graceful',
      runtimeKey: entry.target.runtimeKey,
      runId: intent.runId,
      generation: intent.generation,
      checkpointed: intent.checkpointed,
      backend: 'wsl',
      distro: this.distro,
    };
  }

  private forceRestartEntry(entry: RuntimeEntry, intent: SupervisorStopIntent): Promise<WslPoolStopResult> {
    if (intent.forcePromise) return intent.forcePromise;
    this.restarting.add(entry.target.runtimeKey);
    this.emitSupervisorStatus(entry, 'force_restarting', 'Force restarting this conversation runtime.');
    const promise = (async (): Promise<WslPoolStopResult> => {
      try {
        await entry.client.forceRestartRuntimeGroup();
        const recovered = await entry.client.snapshotTarget(entry.target);
        const recoveredTarget = recovered.target as { runtimeKey?: string } | undefined;
        if (recoveredTarget?.runtimeKey !== entry.target.runtimeKey) throw new Error('WSL runtime recovery snapshot target mismatch');
        entry.lastSnapshot = recovered;
        if (entry.stopIntent === intent) entry.stopIntent = null;
        const runtime = recovered.runtime as { running?: boolean; stopRequested?: boolean } | null | undefined;
        if (!runtime?.running && !runtime?.stopRequested) this.scheduleIdle(entry);
        return {
          action: 'force',
          runtimeKey: entry.target.runtimeKey,
          runId: intent.runId,
          generation: intent.generation,
          checkpointed: intent.checkpointed,
          backend: 'wsl',
          distro: this.distro,
          restarted: true,
        };
      } catch (error) {
        intent.forcePromise = null;
        throw new Error(`WSL conversation runtime restart recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.restarting.delete(entry.target.runtimeKey);
      }
    })();
    intent.forcePromise = promise;
    return promise;
  }

  private supervisorSnapshot(entry: RuntimeEntry): Record<string, unknown> {
    const intent = entry.stopIntent!;
    const cached = entry.lastSnapshot || {};
    const cachedRuntime = cached.runtime as { workRuns?: unknown[] } | null | undefined;
    const cachedQueued = cached.queued as { steering?: string[]; followUp?: string[] } | undefined;
    return {
      ...cached,
      target: entry.target,
      runtime: {
        target: entry.target,
        workspaceKey: entry.target.workspaceKey,
        runtimeKey: entry.target.runtimeKey,
        runId: intent.runId,
        generation: intent.generation,
        running: true,
        stopRequested: true,
        workRuns: cachedRuntime?.workRuns || [],
      },
      queued: cachedQueued || { steering: [], followUp: [] },
      workEvents: entry.workEvents.slice(),
    };
  }

  private emitSupervisorStatus(entry: RuntimeEntry, status: 'stopping' | 'force_restarting', content: string): void {
    const event: AgentWorkEvent = {
      id: `wsl-supervisor-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      conversationId: entry.target.conversationId,
      type: 'status',
      content,
      mode: 'build',
      model: '',
      timestamp: new Date().toISOString(),
      workspaceId: entry.target.workspaceId,
      workspaceKey: entry.target.workspaceKey,
      runtimeKey: entry.target.runtimeKey,
      runId: entry.stopIntent?.runId || entry.lastRunId,
      generation: entry.stopIntent?.generation || entry.lastGeneration,
      status,
    };
    entry.workEvents.push(event);
    if (entry.workEvents.length > 500) entry.workEvents = entry.workEvents.slice(-500);
    for (const listener of this.listeners) listener(event);
  }
}
