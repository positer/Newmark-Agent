export type WorkspaceSelectionStatus = 'noop' | 'applied' | 'stale' | 'failed' | 'circuit_open';

export interface WorkspaceSelectionResult<TResult> {
  status: WorkspaceSelectionStatus;
  key: string;
  value?: TResult;
  error?: string;
  retryAt?: number;
}

export interface WorkspaceSelectionCoordinatorOptions<TInput, TResult> {
  keyOf(input: TInput): string;
  apply(input: TInput): Promise<TResult>;
  now?: () => number;
  failureThreshold?: number;
  failureWindowMs?: number;
  circuitOpenMs?: number;
}

interface Deferred<TResult> {
  resolve(result: WorkspaceSelectionResult<TResult>): void;
}

interface PendingSelection<TInput, TResult> {
  input: TInput;
  key: string;
  waiters: Deferred<TResult>[];
}

/**
 * Serializes workspace selection without blocking conversation runtimes.
 * Repeated clicks for the same active request share one promise; while a request
 * is active only the newest different target is retained. Repeated failures open
 * a short per-target circuit so one hung backend cannot flood the timeline.
 */
export class WorkspaceSelectionCoordinator<TInput, TResult> {
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly circuitOpenMs: number;
  private currentKey = '';
  private active: { key: string; promise: Promise<WorkspaceSelectionResult<TResult>> } | null = null;
  private pending: PendingSelection<TInput, TResult> | null = null;
  private failures = new Map<string, number[]>();
  private circuitUntil = new Map<string, number>();

  constructor(private readonly options: WorkspaceSelectionCoordinatorOptions<TInput, TResult>) {
    this.now = options.now || Date.now;
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 2));
    this.failureWindowMs = Math.max(1, Math.floor(options.failureWindowMs ?? 10_000));
    this.circuitOpenMs = Math.max(1, Math.floor(options.circuitOpenMs ?? 5_000));
  }

  setCurrent(inputOrKey: TInput | string): void {
    this.currentKey = typeof inputOrKey === 'string' ? inputOrKey : this.options.keyOf(inputOrKey);
  }

  current(): string {
    return this.currentKey;
  }

  select(input: TInput): Promise<WorkspaceSelectionResult<TResult>> {
    const key = this.options.keyOf(input);
    if (!this.active && key === this.currentKey) return Promise.resolve({ status: 'noop', key });

    const openUntil = this.openUntil(key);
    if (openUntil > this.now()) return Promise.resolve({ status: 'circuit_open', key, retryAt: openUntil });

    if (this.active) {
      if (this.active.key === key) {
        // The active request is once again the newest user intent. Any queued
        // different target is now obsolete and must not be applied after the
        // shared active request settles (A -> B -> A).
        if (this.pending && this.pending.key !== key) {
          const stale = { status: 'stale' as const, key: this.pending.key };
          for (const waiter of this.pending.waiters) waiter.resolve(stale);
          this.pending = null;
        }
        return this.active.promise;
      }
      return new Promise(resolve => {
        if (this.pending?.key === key) {
          this.pending.waiters.push({ resolve });
          return;
        }
        if (this.pending) {
          const stale = { status: 'stale' as const, key: this.pending.key };
          for (const waiter of this.pending.waiters) waiter.resolve(stale);
        }
        this.pending = { input, key, waiters: [{ resolve }] };
      });
    }

    return this.start(input, key);
  }

  private start(input: TInput, key: string): Promise<WorkspaceSelectionResult<TResult>> {
    const openUntil = this.openUntil(key);
    if (openUntil > this.now()) return Promise.resolve({ status: 'circuit_open', key, retryAt: openUntil });

    const promise = Promise.resolve()
      .then(() => this.options.apply(input))
      .then(value => {
        this.currentKey = key;
        this.failures.delete(key);
        this.circuitUntil.delete(key);
        return { status: 'applied' as const, key, value };
      })
      .catch(error => {
        this.recordFailure(key);
        return { status: 'failed' as const, key, error: error instanceof Error ? error.message : String(error) };
      });
    this.active = { key, promise };
    void promise.then(() => this.finish(promise));
    return promise;
  }

  private finish(completed: Promise<WorkspaceSelectionResult<TResult>>): void {
    if (this.active?.promise !== completed) return;
    this.active = null;
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (pending.key === this.currentKey) {
      const noop = { status: 'noop' as const, key: pending.key };
      for (const waiter of pending.waiters) waiter.resolve(noop);
      return;
    }
    const next = this.start(pending.input, pending.key);
    void next.then(result => {
      for (const waiter of pending.waiters) waiter.resolve(result);
    });
  }

  private openUntil(key: string): number {
    const until = this.circuitUntil.get(key) || 0;
    if (until && until <= this.now()) this.circuitUntil.delete(key);
    return until;
  }

  private recordFailure(key: string): void {
    const now = this.now();
    const recent = (this.failures.get(key) || []).filter(at => now - at <= this.failureWindowMs);
    recent.push(now);
    this.failures.set(key, recent);
    if (recent.length >= this.failureThreshold) this.circuitUntil.set(key, now + this.circuitOpenMs);
  }
}
