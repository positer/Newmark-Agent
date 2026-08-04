import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AgentRun, AgentRunStatus } from '../context/domain/types';

export interface AgentRunLimits {
  maxIterations?: number;
  maxRunDurationMs?: number;
  maxConsecutiveModelErrors?: number;
  maxConsecutiveToolErrors?: number;
  maxNoProgressIterations?: number;
  maxCumulativeCostUsd?: number;
}

export const DEFAULT_AGENT_RUN_LIMITS: Required<AgentRunLimits> = {
  maxIterations: 120,
  maxRunDurationMs: 30 * 60 * 1000,
  maxConsecutiveModelErrors: 3,
  maxConsecutiveToolErrors: 3,
  maxNoProgressIterations: 5,
  maxCumulativeCostUsd: Number.POSITIVE_INFINITY,
};

export interface StartAgentRunInput {
  conversationId: string;
  buildBlockId: string;
  agentId: string;
  agentType: 'main' | 'subagent';
  limits?: AgentRunLimits;
  payload?: Record<string, unknown>;
}

export interface LimitCheckResult {
  paused: boolean;
  reason?: string;
  detail?: Record<string, number | string>;
}

/**
 * Persisted Agent Run state machine.
 *
 * Statuses: created -> preparing_context -> waiting_model -> streaming ->
 * waiting_tools -> executing_tools -> verifying -> checkpointing ->
 * waiting_subagents -> paused|completed|failed|cancelled, plus 'recovering'.
 *
 * Every transition is persisted. Lease acquisition prevents double execution.
 */
export class AgentRunService {
  constructor(private readonly root: string) {}

  private runsPath(): string {
    return path.join(this.root, 'agent-runs');
  }

  private runFile(id: string): string {
    return path.join(this.runsPath(), `${id}.json`);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.runsPath(), { recursive: true });
  }

  create(input: StartAgentRunInput): AgentRun {
    this.ensureDir();
    const now = new Date().toISOString();
    const limits: Required<AgentRunLimits> = Object.assign(
      {},
      DEFAULT_AGENT_RUN_LIMITS,
      input.limits,
    );
    const run: AgentRun = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      buildBlockId: input.buildBlockId,
      agentId: input.agentId,
      agentType: input.agentType,
      status: 'created',
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      iteration: 0,
      maxIterations: limits.maxIterations,
      maxRunDurationMs: limits.maxRunDurationMs,
      maxConsecutiveModelErrors: limits.maxConsecutiveModelErrors,
      maxConsecutiveToolErrors: limits.maxConsecutiveToolErrors,
      maxNoProgressIterations: limits.maxNoProgressIterations,
      maxCumulativeCostUsd: limits.maxCumulativeCostUsd,
      costUsd: 0,
      consecutiveModelErrors: 0,
      consecutiveToolErrors: 0,
      noProgressIterations: 0,
      payload: input.payload || {},
    };
    this.write(run);
    return run;
  }

  read(id: string): AgentRun | null {
    const file = this.runFile(id);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as AgentRun;
    } catch {
      return null;
    }
  }

  listByConversation(conversationId: string): AgentRun[] {
    this.ensureDir();
    const out: AgentRun[] = [];
    for (const file of fs.readdirSync(this.runsPath())) {
      if (!file.endsWith('.json')) continue;
      const run = this.read(file.replace(/\.json$/, ''));
      if (run && run.conversationId === conversationId) out.push(run);
    }
    return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /** Active runs (not in a terminal state) for recovery scanning. */
  listActive(): AgentRun[] {
    this.ensureDir();
    const terminal = new Set<AgentRunStatus>(['completed', 'failed', 'cancelled']);
    const out: AgentRun[] = [];
    for (const file of fs.readdirSync(this.runsPath())) {
      if (!file.endsWith('.json')) continue;
      const run = this.read(file.replace(/\.json$/, ''));
      if (run && !terminal.has(run.status)) out.push(run);
    }
    return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /**
   * Acquire the run lease. Returns false when another owner holds a live lease.
   * The lease automatically expires (stale lease takeover).
   */
  acquireLease(id: string, owner: string, leaseDurationMs = 30_000): boolean {
    const run = this.read(id);
    if (!run) return false;
    const now = Date.now();
    const expiresAt = new Date(now + leaseDurationMs).toISOString();
    if (run.leaseOwner && run.leaseOwner !== owner && run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > now) {
      return false;
    }
    const updated: AgentRun = {
      ...run,
      leaseOwner: owner,
      leaseExpiresAt: expiresAt,
      status: run.status === 'created' || run.status === 'recovering' ? 'preparing_context' : run.status,
      updatedAt: new Date().toISOString(),
    };
    this.write(updated);
    return true;
  }

  releaseLease(id: string, owner: string): void {
    const run = this.read(id);
    if (!run || run.leaseOwner !== owner) return;
    this.write({ ...run, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date().toISOString() });
  }

  renewLease(id: string, owner: string, leaseDurationMs = 30_000): boolean {
    const run = this.read(id);
    if (!run || run.leaseOwner !== owner) return false;
    this.write({
      ...run,
      leaseExpiresAt: new Date(Date.now() + leaseDurationMs).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  transition(id: string, next: Partial<AgentRun>): AgentRun | null {
    const run = this.read(id);
    if (!run) return null;
    const updated: AgentRun = { ...run, ...next, updatedAt: new Date().toISOString() };
    this.write(updated);
    return updated;
  }

  recordModelError(id: string): AgentRun | null {
    const run = this.read(id);
    if (!run) return null;
    return this.transition(id, { consecutiveModelErrors: run.consecutiveModelErrors + 1 });
  }

  resetModelErrors(id: string): AgentRun | null {
    return this.transition(id, { consecutiveModelErrors: 0 });
  }

  recordToolError(id: string): AgentRun | null {
    const run = this.read(id);
    if (!run) return null;
    return this.transition(id, { consecutiveToolErrors: run.consecutiveToolErrors + 1 });
  }

  resetToolErrors(id: string): AgentRun | null {
    return this.transition(id, { consecutiveToolErrors: 0 });
  }

  advanceIteration(id: string): AgentRun | null {
    const run = this.read(id);
    if (!run) return null;
    return this.transition(id, { iteration: run.iteration + 1 });
  }

  recordProgress(id: string): AgentRun | null {
    return this.transition(id, { noProgressIterations: 0 });
  }

  recordNoProgress(id: string): AgentRun | null {
    const run = this.read(id);
    if (!run) return null;
    return this.transition(id, { noProgressIterations: run.noProgressIterations + 1 });
  }

  addCost(id: string, usd: number): AgentRun | null {
    const run = this.read(id);
    if (!run) return null;
    return this.transition(id, { costUsd: run.costUsd + Math.max(0, usd) });
  }

  pause(id: string, reason: string): AgentRun | null {
    return this.transition(id, { status: 'paused', pauseReason: reason });
  }

  resume(id: string): AgentRun | null {
    return this.transition(id, { status: 'preparing_context', pauseReason: undefined });
  }

  cancel(id: string): AgentRun | null {
    return this.transition(id, { status: 'cancelled', leaseOwner: null, leaseExpiresAt: null });
  }

  fail(id: string, error?: string): AgentRun | null {
    return this.transition(id, {
      status: 'failed',
      leaseOwner: null,
      leaseExpiresAt: null,
      payload: error ? { ...this.read(id)?.payload, error } : undefined,
    });
  }

  complete(id: string): AgentRun | null {
    return this.transition(id, { status: 'completed', leaseOwner: null, leaseExpiresAt: null });
  }

  markRecovering(id: string): AgentRun | null {
    return this.transition(id, { status: 'recovering' });
  }

  /**
   * Check the run against every configured limit. When any limit is reached the
   * run is marked paused (never faked completed) and the reason is returned.
   */
  checkLimits(id: string): LimitCheckResult {
    const run = this.read(id);
    if (!run) return { paused: false };
    const now = Date.now();
    const startedAt = Date.parse(run.createdAt) || now;
    const elapsed = now - startedAt;

    if (run.iteration >= run.maxIterations) {
      return this.pauseLimit(id, 'max_iterations', { iterations: run.iteration });
    }
    if (elapsed >= run.maxRunDurationMs) {
      return this.pauseLimit(id, 'max_run_duration', { elapsedMs: elapsed });
    }
    if (run.consecutiveModelErrors >= run.maxConsecutiveModelErrors) {
      return this.pauseLimit(id, 'max_consecutive_model_errors', { errors: run.consecutiveModelErrors });
    }
    if (run.consecutiveToolErrors >= run.maxConsecutiveToolErrors) {
      return this.pauseLimit(id, 'max_consecutive_tool_errors', { errors: run.consecutiveToolErrors });
    }
    if (run.noProgressIterations >= run.maxNoProgressIterations) {
      return this.pauseLimit(id, 'max_no_progress', { noProgressIterations: run.noProgressIterations });
    }
    const costCeiling = run.maxCumulativeCostUsd ?? Number.POSITIVE_INFINITY;
    if (run.costUsd >= costCeiling) {
      return this.pauseLimit(id, 'max_cumulative_cost', { costUsd: run.costUsd });
    }
    return { paused: false };
  }

  private pauseLimit(id: string, reason: string, detail: Record<string, number | string>): LimitCheckResult {
    this.pause(id, reason);
    return { paused: true, reason, detail };
  }

  private write(run: AgentRun): void {
    this.ensureDir();
    fs.writeFileSync(this.runFile(run.id), JSON.stringify(run, null, 2), 'utf-8');
  }
}
