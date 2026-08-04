/**
 * Retry policy for provider calls. Retries never repeat side effects: the
 * adapter layer is responsible for classifying each failure as retryable or
 * permanent, and the agent runtime only retries when the outcome is known to be
 * an idempotent read-like request or a request that did not execute.
 */

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: 'permanent_error' | 'aborted' | 'rate_limit_exhausted' | 'max_retries' };

export interface RetryPolicyOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export class RetryPolicy {
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: boolean;

  constructor(options: RetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 15_000;
    this.jitter = options.jitter ?? true;
  }

  /** Whether an HTTP status is transient (5xx, 429) and safe to retry. */
  static isTransientStatus(status: number): boolean {
    return status >= 500 || status === 429;
  }

  decide(attempt: number, context: {
    status?: number;
    aborted?: boolean;
    permanent?: boolean;
    retryAfterSeconds?: number;
  }): RetryDecision {
    if (context.aborted) return { retry: false, reason: 'aborted' };
    if (attempt >= this.maxRetries) return { retry: false, reason: 'max_retries' };
    if (context.permanent || (context.status !== undefined && !RetryPolicy.isTransientStatus(context.status))) {
      return { retry: false, reason: 'permanent_error' };
    }
    const base = context.retryAfterSeconds
      ? Math.min(this.maxDelayMs, context.retryAfterSeconds * 1000)
      : Math.min(this.maxDelayMs, this.initialDelayMs * Math.pow(2, attempt));
    const delayMs = this.jitter ? base * (0.5 + Math.random() * 0.5) : base;
    return { retry: true, delayMs: Math.max(0, Math.round(delayMs)) };
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
