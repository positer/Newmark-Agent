import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  StructuredPlan,
  StructuredPlanStep,
  StructuredTask,
  PlanStatus,
  PlanStepStatus,
  TaskStatus,
} from '../domain/types';

export type OptimisticWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'version_conflict' | 'not_found'; expectedVersion?: number; actualVersion?: number };

/**
 * Structured Plan + Task repository with `expectedVersion` optimistic
 * concurrency. Version conflicts reject the write; there is never a silent
 * last-write-wins.
 */
export class PlanTaskRepository {
  constructor(private readonly root: string) {}

  private plansPath(conversationId: string): string {
    return path.join(this.root, 'conversations', conversationId, 'plans');
  }

  private tasksPath(conversationId: string): string {
    return path.join(this.root, 'conversations', conversationId, 'tasks');
  }

  private planFile(conversationId: string, planId: string): string {
    return path.join(this.plansPath(conversationId), `${planId}.json`);
  }

  private taskFile(conversationId: string, taskId: string): string {
    return path.join(this.tasksPath(conversationId), `${taskId}.json`);
  }

  private ensureDir(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  private readJson<T>(file: string): T | null {
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  createPlan(input: { conversationId: string; title: string }): StructuredPlan {
    const plan: StructuredPlan = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      title: input.title,
      status: 'draft',
      revision: 1,
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.ensureDir(this.planFile(input.conversationId, plan.id));
    this.writePlan(plan);
    return plan;
  }

  readPlan(conversationId: string, planId: string): StructuredPlan | null {
    return this.readJson<StructuredPlan>(this.planFile(conversationId, planId));
  }

  listPlans(conversationId: string): StructuredPlan[] {
    const dir = this.plansPath(conversationId);
    if (!fs.existsSync(dir)) return [];
    const out: StructuredPlan[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const plan = this.readJson<StructuredPlan>(path.join(dir, file));
      if (plan) out.push(plan);
    }
    return out.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  }

  /** Optimistic write: requires the caller to supply the current revision. */
  updatePlan(conversationId: string, planId: string, expectedVersion: number, mutate: (plan: StructuredPlan) => void): OptimisticWriteResult<StructuredPlan> {
    const plan = this.readPlan(conversationId, planId);
    if (!plan) return { ok: false, reason: 'not_found' };
    if (plan.revision !== expectedVersion) {
      return { ok: false, reason: 'version_conflict', expectedVersion, actualVersion: plan.revision };
    }
    mutate(plan);
    plan.revision += 1;
    plan.updatedAt = new Date().toISOString();
    this.writePlan(plan);
    return { ok: true, value: plan };
  }

  updatePlanStatus(conversationId: string, planId: string, expectedVersion: number, status: PlanStatus): OptimisticWriteResult<StructuredPlan> {
    return this.updatePlan(conversationId, planId, expectedVersion, plan => { plan.status = status; });
  }

  addStep(conversationId: string, planId: string, expectedVersion: number, input: { title: string; detail: string }): OptimisticWriteResult<StructuredPlan> {
    return this.updatePlan(conversationId, planId, expectedVersion, plan => {
      const now = new Date().toISOString();
      const step: StructuredPlanStep = {
        id: crypto.randomUUID(),
        title: input.title,
        detail: input.detail,
        status: 'pending',
        expectedVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      plan.steps.push(step);
    });
  }

  updateStepStatus(conversationId: string, planId: string, expectedVersion: number, stepId: string, status: PlanStepStatus): OptimisticWriteResult<StructuredPlan> {
    return this.updatePlan(conversationId, planId, expectedVersion, plan => {
      const step = plan.steps.find(item => item.id === stepId);
      if (step) {
        step.status = status;
        step.updatedAt = new Date().toISOString();
      }
    });
  }

  private writePlan(plan: StructuredPlan): void {
    this.ensureDir(this.planFile(plan.conversationId, plan.id));
    fs.writeFileSync(this.planFile(plan.conversationId, plan.id), JSON.stringify(plan, null, 2), 'utf-8');
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  createTask(input: { conversationId: string; title: string; detail?: string; buildBlockId?: string }): StructuredTask {
    const now = new Date().toISOString();
    const task: StructuredTask = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      buildBlockId: input.buildBlockId,
      title: input.title,
      detail: input.detail || '',
      status: 'pending',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.ensureDir(this.taskFile(input.conversationId, task.id));
    this.writeTask(task);
    return task;
  }

  readTask(conversationId: string, taskId: string): StructuredTask | null {
    return this.readJson<StructuredTask>(this.taskFile(conversationId, taskId));
  }

  listTasks(conversationId: string, options?: { includeCompleted?: boolean }): StructuredTask[] {
    const dir = this.tasksPath(conversationId);
    if (!fs.existsSync(dir)) return [];
    const includeCompleted = options?.includeCompleted ?? false;
    const out: StructuredTask[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const task = this.readJson<StructuredTask>(path.join(dir, file));
      if (!task) continue;
      if (!includeCompleted && task.status === 'completed') continue;
      if (!includeCompleted && task.status === 'cancelled') continue;
      out.push(task);
    }
    return out.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  }

  updateTask(conversationId: string, taskId: string, expectedVersion: number, mutate: (task: StructuredTask) => void): OptimisticWriteResult<StructuredTask> {
    const task = this.readTask(conversationId, taskId);
    if (!task) return { ok: false, reason: 'not_found' };
    if (task.revision !== expectedVersion) {
      return { ok: false, reason: 'version_conflict', expectedVersion, actualVersion: task.revision };
    }
    mutate(task);
    task.revision += 1;
    task.updatedAt = new Date().toISOString();
    if (task.status === 'completed') task.completedAt = task.completedAt || new Date().toISOString();
    this.writeTask(task);
    return { ok: true, value: task };
  }

  updateTaskStatus(conversationId: string, taskId: string, expectedVersion: number, status: TaskStatus, blockedReason?: string): OptimisticWriteResult<StructuredTask> {
    return this.updateTask(conversationId, taskId, expectedVersion, task => {
      task.status = status;
      if (status === 'blocked') task.blockedReason = blockedReason;
      if (status !== 'blocked') task.blockedReason = undefined;
    });
  }

  private writeTask(task: StructuredTask): void {
    this.ensureDir(this.taskFile(task.conversationId, task.id));
    fs.writeFileSync(this.taskFile(task.conversationId, task.id), JSON.stringify(task, null, 2), 'utf-8');
  }
}
