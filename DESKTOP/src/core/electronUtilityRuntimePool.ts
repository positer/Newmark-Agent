import { AgentWorkEvent, ConversationInputEnvelope, GuideReceipt } from './types';
import { ConversationRuntimeTarget, NormalizedConversationTarget, normalizeConversationTarget } from './conversationTarget';
import { drainWindowsProcessHelpers, ElectronUtilityAgentClient, UtilityHostToolHandler } from './electronUtilityAgentClient';
import {
  UtilityAgentPromptResult,
  UtilityAutoRouteRatingResult,
  UtilityAgentSnapshotResult,
  UtilityAgentStopResult,
  UtilityPromptRequest,
} from './utilityAgentProtocol';
import { RuntimePoolCapacityError } from './runtimePoolCapacity';

export interface ElectronTargetRuntimeClient {
  subscribe(listener: (event: AgentWorkEvent) => void): () => void;
  setHostToolHandler(handler: UtilityHostToolHandler | null): void;
  prompt(params: UtilityPromptRequest): Promise<UtilityAgentPromptResult>;
  snapshot(): Promise<UtilityAgentSnapshotResult>;
  requestStop(runId?: string): Promise<UtilityAgentStopResult>;
  enqueueGuide(envelope: ConversationInputEnvelope): Promise<GuideReceipt>;
  checkpoint(): Promise<Record<string, unknown>>;
  rateAutoRoute?(score: number, routeId?: string): Promise<UtilityAutoRouteRatingResult>;
  setWorkRunExpanded(runId: string, expanded: boolean): Promise<boolean>;
  updateSetting(section: string, key: string, value: unknown): Promise<void>;
  forceRestart(): Promise<void>;
  forceStop(): Promise<void>;
  stop(): Promise<void>;
  status(): {
    enabled: true;
    connected: boolean;
    pid: number;
    error: string;
    runtimeKey: string;
    quarantined?: boolean;
    generation?: number;
    readyGeneration?: number;
    rootCreationIdentity?: string;
  };
}

export type ElectronTargetRuntimeClientFactory = (target: NormalizedConversationTarget) => ElectronTargetRuntimeClient;
export type ElectronPoolStopResult = UtilityAgentStopResult & { restarted?: boolean };

interface SupervisorStopIntent {
  runId: string;
  generation: number;
  checkpointed: boolean;
  forcePromise: Promise<ElectronPoolStopResult> | null;
}

interface RuntimeEntry {
  target: NormalizedConversationTarget;
  client: ElectronTargetRuntimeClient;
  unsubscribe: () => void;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastSnapshot: UtilityAgentSnapshotResult | null;
  lastRunId: string;
  lastGeneration: number;
  workEvents: AgentWorkEvent[];
  stopIntent: SupervisorStopIntent | null;
  activeOperations: number;
}

export interface ElectronUtilityRuntimePoolOptions {
  idleTtlMs?: number;
  stopRequestTimeoutMs?: number;
  maxResidentRuntimes?: number;
}

/** One real Electron utilityProcess per active ConversationTarget. */
export class ElectronUtilityRuntimePool {
  private entries = new Map<string, RuntimeEntry>();
  private listeners = new Set<(event: AgentWorkEvent) => void>();
  private hostToolHandler: UtilityHostToolHandler | null = null;
  private restarting = new Set<string>();
  private quarantined = new Map<string, string>();
  private disposing = new Set<string>();
  private capacityTail: Promise<void> = Promise.resolve();
  private accessSequence = 0;

  constructor(
    private readonly root: string,
    private readonly hostScript: string,
    private readonly createClient: ElectronTargetRuntimeClientFactory = target => new ElectronUtilityAgentClient(root, hostScript, target),
    private readonly options: ElectronUtilityRuntimePoolOptions = {},
  ) {}

  subscribe(listener: (event: AgentWorkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setHostToolHandler(handler: UtilityHostToolHandler | null): void {
    this.hostToolHandler = handler;
    for (const entry of this.entries.values()) entry.client.setHostToolHandler(handler);
  }

  async prompt(params: UtilityPromptRequest): Promise<UtilityAgentPromptResult> {
    const target = normalizeConversationTarget(params.target);
    const entry = await this.acquire(target);
    // Any new prompt is an intervening instruction and starts a fresh
    // two-click stop sequence.
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

  async snapshot(target: ConversationRuntimeTarget): Promise<UtilityAgentSnapshotResult> {
    const entry = await this.acquire(normalizeConversationTarget(target));
    let scheduleIdle = false;
    try {
      if (entry.stopIntent) return this.supervisorSnapshot(entry);
      const result = await entry.client.snapshot();
      entry.lastSnapshot = result;
      if (result.runtime?.runId) entry.lastRunId = result.runtime.runId;
      if (result.runtime?.generation) entry.lastGeneration = result.runtime.generation;
      scheduleIdle = !result.runtime?.running && !result.runtime?.stopRequested;
      return result;
    } finally {
      this.release(entry, scheduleIdle);
    }
  }

  async requestStop(target: ConversationRuntimeTarget, runId?: string): Promise<ElectronPoolStopResult> {
    const normalized = normalizeConversationTarget(target);
    const entry = this.entries.get(normalized.runtimeKey);
    if (!entry) return { action: 'not_running', runtimeKey: normalized.runtimeKey, checkpointed: false, backend: 'utility', pid: 0 };
    const status = entry.client.status();
    if (status.quarantined) {
      this.rememberClientQuarantine(entry);
      return await this.forceCleanupQuarantinedEntry(entry, String(runId || entry.lastRunId || ''));
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
          backend: 'utility',
          pid: entry.client.status().pid,
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
        entry.client.requestStop(requestedRunId || undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Electron conversation stop acknowledgement timed out')), timeoutMs);
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
      // A sync tool can block the worker event loop indefinitely. Preserve the
      // supervisor-owned stopping intent so the second click can hard-restart
      // without asking that worker again.
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
    // A Guide is an intervening instruction: it cancels the supervisor's
    // second-click force eligibility before delivery to the worker.
    entry.stopIntent = null;
    try {
      return await entry.client.enqueueGuide(envelope);
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
      return await entry.client.checkpoint();
    } finally {
      this.release(entry, true);
    }
  }

  async rateAutoRoute(
    target: ConversationRuntimeTarget,
    score: number,
    routeId = '',
  ): Promise<UtilityAutoRouteRatingResult> {
    const normalized = normalizeConversationTarget(target);
    const entry = await this.acquireExisting(normalized);
    if (!entry || !entry.client.rateAutoRoute) {
      return { ok: false, reason: 'no_active_auto_route' };
    }
    try {
      return await entry.client.rateAutoRoute(score, routeId);
    } finally {
      this.release(entry, true);
    }
  }

  async setWorkRunExpanded(target: ConversationRuntimeTarget, runId: string, expanded: boolean): Promise<boolean> {
    const entry = await this.acquire(normalizeConversationTarget(target));
    try {
      return await entry.client.setWorkRunExpanded(runId, expanded);
    } finally {
      this.release(entry, true);
    }
  }

  async updateSetting(section: string, key: string, value: unknown): Promise<void> {
    await Promise.all(Array.from(this.entries.values()).map(entry => entry.client.updateSetting(section, key, value)));
  }

  status(target: ConversationRuntimeTarget): ReturnType<ElectronTargetRuntimeClient['status']> {
    const normalized = normalizeConversationTarget(target);
    return this.entries.get(normalized.runtimeKey)?.client.status() || {
      enabled: true,
      connected: false,
      pid: 0,
      error: this.quarantined.get(normalized.runtimeKey) || '',
      runtimeKey: normalized.runtimeKey,
      quarantined: this.quarantined.has(normalized.runtimeKey),
    };
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
        const snapshot = await entry.client.snapshot();
        if (snapshot.runtime?.running || snapshot.runtime?.stopRequested) return true;
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
    this.throwStopFailures(results, 'One or more Electron workspace runtimes could not be stopped');
  }

  async stopTarget(target: ConversationRuntimeTarget): Promise<void> {
    const normalized = normalizeConversationTarget(target);
    await this.serializeCapacity(async () => {
      const entry = this.entries.get(normalized.runtimeKey);
      if (entry) await this.stopEntry(entry);
    });
  }

  async stopAll(): Promise<void> {
    const targets = Array.from(this.entries.values(), entry => entry.target);
    const results = await Promise.allSettled(targets.map(target => this.stopTarget(target)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
    try {
      await drainWindowsProcessHelpers(2_000);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (failures.length) {
      throw new AggregateError(failures, 'One or more Electron utility runtimes could not be stopped');
    }
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
    this.rememberClientQuarantine(entry);
    entry.stopIntent = null;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    try {
      try {
        const status = entry.client.status();
        if (status.quarantined && status.connected) {
          await this.forceCleanupQuarantinedEntry(entry, entry.lastRunId);
        } else {
          await entry.client.stop();
        }
      } catch (error) {
        this.rememberClientQuarantine(entry);
        // A failed stop can leave a live child behind. Keep the entry, event
        // subscription and host-tool route for an explicit cleanup retry.
        if (entry.client.status().connected) throw error;
      }
      this.rememberClientQuarantine(entry);
      if (entry.client.status().connected) {
        throw new Error(`Electron utility runtime ${runtimeKey} remained connected after stop`);
      }
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
      const quarantined = this.quarantined.get(target.runtimeKey);
      if (quarantined) {
        throw new Error(`Electron utility runtime is quarantined until the app backend is restarted: ${quarantined}`);
      }
      const existing = this.entries.get(target.runtimeKey);
      if (existing) {
        if (this.rememberClientQuarantine(existing)) {
          throw new Error(`Electron utility runtime is quarantined until the app backend is restarted: ${this.quarantined.get(target.runtimeKey)}`);
        }
        this.touch(existing);
        existing.activeOperations += 1;
        return existing;
      }
      const capacity = this.maxResidentRuntimes();
      if (this.entries.size >= capacity) await this.evictLeastRecentlyUsedIdle();
      if (this.entries.size >= capacity) throw new RuntimePoolCapacityError('utility', capacity);
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
    const quarantined = this.quarantined.get(target.runtimeKey);
    if (quarantined) {
      throw new Error(`Electron utility runtime is quarantined until the app backend is restarted: ${quarantined}`);
    }
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
        const routed = {
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
        || this.disposing.has(runtimeKey)
        || entry.client.status().quarantined) continue;
      const expectedLastUsedAt = entry.lastUsedAt;
      let snapshot: UtilityAgentSnapshotResult;
      try {
        snapshot = await entry.client.snapshot();
      } catch {
        // An unknown state is not proof that a runtime is idle.
        continue;
      }
      if (this.entries.get(runtimeKey) !== entry
        || entry.lastUsedAt !== expectedLastUsedAt
        || entry.activeOperations > 0
        || entry.stopIntent
        || this.restarting.has(runtimeKey)
        || this.disposing.has(runtimeKey)) continue;
      if (snapshot.runtime?.running || snapshot.runtime?.stopRequested) continue;
      await this.stopEntry(entry);
      return;
    }
  }

  private scheduleIdle(entry: RuntimeEntry): void {
    this.touch(entry);
    const ttl = Math.max(10, Number(this.options.idleTtlMs ?? 5 * 60 * 1000));
    const timer = setTimeout(() => {
      void this.evictIfIdle(entry.target.runtimeKey, entry.lastUsedAt);
    }, ttl);
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
      let snapshot: UtilityAgentSnapshotResult;
      try {
        snapshot = await entry.client.snapshot();
      } catch {
        // A dead idle child is still safe to evict; stop() clears local handles.
        if (this.entries.get(runtimeKey) !== entry || entry.lastUsedAt !== expectedLastUsedAt) return;
        await this.stopEntry(entry);
        return;
      }
      if (this.entries.get(runtimeKey) !== entry || entry.lastUsedAt !== expectedLastUsedAt) return;
      if (snapshot.runtime?.running || snapshot.runtime?.stopRequested) {
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

  private gracefulSupervisorResult(entry: RuntimeEntry, intent: SupervisorStopIntent): ElectronPoolStopResult {
    return {
      action: 'graceful',
      runtimeKey: entry.target.runtimeKey,
      runId: intent.runId,
      generation: intent.generation,
      checkpointed: intent.checkpointed,
      backend: 'utility',
      pid: entry.client.status().pid,
    };
  }

  private forceRestartEntry(entry: RuntimeEntry, intent: SupervisorStopIntent): Promise<ElectronPoolStopResult> {
    if (intent.forcePromise) return intent.forcePromise;
    this.restarting.add(entry.target.runtimeKey);
    this.emitSupervisorStatus(entry, 'force_restarting', 'Force restarting this conversation runtime.');
    const promise = (async (): Promise<ElectronPoolStopResult> => {
      try {
        await entry.client.forceRestart();
        const recovered = await entry.client.snapshot();
        if (recovered.target?.runtimeKey !== entry.target.runtimeKey) throw new Error('Electron runtime recovery snapshot target mismatch');
        entry.lastSnapshot = recovered;
        if (entry.stopIntent === intent) entry.stopIntent = null;
        if (!recovered.runtime?.running && !recovered.runtime?.stopRequested) this.scheduleIdle(entry);
        return {
          action: 'force',
          runtimeKey: entry.target.runtimeKey,
          runId: intent.runId,
          generation: intent.generation,
          checkpointed: intent.checkpointed,
          backend: 'utility',
          pid: entry.client.status().pid,
          restarted: true,
        };
      } catch (error) {
        this.rememberClientQuarantine(entry);
        intent.forcePromise = null;
        throw new Error(`Electron conversation runtime restart recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.restarting.delete(entry.target.runtimeKey);
      }
    })();
    intent.forcePromise = promise;
    return promise;
  }

  private async forceCleanupQuarantinedEntry(entry: RuntimeEntry, runId: string): Promise<ElectronPoolStopResult> {
    const status = entry.client.status();
    if (!status.connected) {
      const checkpointed = entry.stopIntent?.checkpointed || false;
      if (entry.stopIntent) entry.stopIntent = null;
      return {
        action: 'force',
        runtimeKey: entry.target.runtimeKey,
        runId,
        generation: entry.lastGeneration,
        checkpointed,
        backend: 'utility',
        pid: 0,
        restarted: false,
      };
    }
    this.restarting.add(entry.target.runtimeKey);
    this.emitSupervisorStatus(entry, 'force_restarting', 'Retrying cleanup of the quarantined conversation runtime.');
    try {
      await entry.client.forceStop();
      this.rememberClientQuarantine(entry);
      if (entry.client.status().connected) {
        throw new Error('Quarantined Electron utility runtime remained connected after cleanup retry');
      }
      const checkpointed = entry.stopIntent?.checkpointed || false;
      entry.stopIntent = null;
      return {
        action: 'force',
        runtimeKey: entry.target.runtimeKey,
        runId,
        generation: entry.lastGeneration,
        checkpointed,
        backend: 'utility',
        pid: 0,
        restarted: false,
      };
    } catch (error) {
      this.rememberClientQuarantine(entry);
      throw new Error(`Electron conversation runtime quarantine cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.restarting.delete(entry.target.runtimeKey);
    }
  }

  private rememberClientQuarantine(entry: RuntimeEntry): boolean {
    const status = entry.client.status();
    if (!status.quarantined) return false;
    this.quarantined.set(
      entry.target.runtimeKey,
      status.error || 'Target utility runtime cleanup could not be proven safe',
    );
    return true;
  }

  private supervisorSnapshot(entry: RuntimeEntry): UtilityAgentSnapshotResult {
    const intent = entry.stopIntent!;
    const cached = entry.lastSnapshot;
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
        workRuns: cached?.runtime?.workRuns || [],
      },
      queued: cached?.queued || { steering: [], followUp: [] },
      workEvents: entry.workEvents.slice(),
    };
  }

  private emitSupervisorStatus(entry: RuntimeEntry, status: 'stopping' | 'force_restarting', content: string): void {
    const event: AgentWorkEvent = {
      id: `utility-supervisor-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
