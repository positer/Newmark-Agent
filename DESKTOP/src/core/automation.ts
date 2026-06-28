import { ConfigManager } from './config';

export type AutomationCondition = 'once' | 'loop' | 'schedule';
export type AutomationStatus = 'idle' | 'scheduled' | 'running' | 'completed' | 'paused' | 'error';

export interface AutomationSchedule {
  id: string;
  prompt: string;
  model: string;
  condition: AutomationCondition;
  intervalSec: number;
  startAt: string;
  endAt: string;
  active: boolean;
  createdAt: string;
  nextRunAt: string;
  lastRunAt: string;
  runCount: number;
  status: AutomationStatus;
  lastResult: string;
  lastError: string;
}

export type AutomationRunner = (prompt: string, model: string, item: AutomationSchedule) => Promise<string>;
export type AutomationChangeListener = (items: AutomationSchedule[]) => void;

function makeId(): string {
  return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isoFromLocal(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export class AutomationManager {
  private timer: NodeJS.Timeout | null = null;
  private runningIds = new Set<string>();
  private listeners: AutomationChangeListener[] = [];

  constructor(
    private config: ConfigManager,
    private runner: AutomationRunner,
    private tickMs = 1000
  ) {}

  list(): AutomationSchedule[] {
    return [...(this.config.get<AutomationSchedule[]>('automation', 'schedules') || [])];
  }

  onChange(listener: AutomationChangeListener): void {
    this.listeners.push(listener);
  }

  create(input: {
    prompt: string;
    model?: string;
    condition?: AutomationCondition;
    intervalSec?: number;
    startAt?: string;
    endAt?: string;
    active?: boolean;
  }): AutomationSchedule {
    const now = new Date();
    const startAt = isoFromLocal(input.startAt || '');
    const condition = input.condition || 'once';
    const item: AutomationSchedule = {
      id: makeId(),
      prompt: input.prompt.trim(),
      model: input.model || '',
      condition,
      intervalSec: Math.max(0, Number(input.intervalSec || 0)),
      startAt,
      endAt: isoFromLocal(input.endAt || ''),
      active: input.active !== false,
      createdAt: now.toISOString(),
      nextRunAt: startAt || now.toISOString(),
      lastRunAt: '',
      runCount: 0,
      status: input.active === false ? 'paused' : 'scheduled',
      lastResult: '',
      lastError: '',
    };
    this.save([...this.list(), item]);
    return item;
  }

  toggle(id: string): AutomationSchedule | null {
    const items = this.list();
    const item = items.find(x => x.id === id);
    if (!item) return null;
    item.active = !item.active;
    item.status = item.active ? 'scheduled' : 'paused';
    if (item.active && !item.nextRunAt) item.nextRunAt = new Date().toISOString();
    this.save(items);
    return item;
  }

  delete(id: string): boolean {
    const before = this.list();
    const after = before.filter(x => x.id !== id);
    this.save(after);
    return after.length !== before.length;
  }

  update(id: string, patch: Partial<AutomationSchedule>): AutomationSchedule | null {
    const items = this.list();
    const item = items.find(x => x.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save(items);
    return item;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    for (const item of this.list()) {
      if (!this.shouldRun(item, now)) continue;
      await this.run(item.id, now);
    }
  }

  private shouldRun(item: AutomationSchedule, now: Date): boolean {
    if (!item.active || this.runningIds.has(item.id)) return false;
    if (item.status === 'completed' && item.condition === 'once') return false;
    if (item.endAt && now.getTime() > new Date(item.endAt).getTime()) return false;
    const next = item.nextRunAt ? new Date(item.nextRunAt).getTime() : now.getTime();
    return now.getTime() >= next;
  }

  private async run(id: string, now: Date): Promise<void> {
    const item = this.list().find(x => x.id === id);
    if (!item) return;
    this.runningIds.add(id);
    this.update(id, { status: 'running', lastError: '' });
    try {
      const result = await this.runner(item.prompt, item.model, item);
      const after = this.list().find(x => x.id === id);
      if (!after) return;
      const nextPatch = this.nextPatch(after, now);
      this.update(id, {
        ...nextPatch,
        lastRunAt: now.toISOString(),
        runCount: after.runCount + 1,
        lastResult: result,
        lastError: '',
      });
    } catch (e) {
      this.update(id, {
        status: 'error',
        lastError: e instanceof Error ? e.message : String(e),
        active: false,
      });
    } finally {
      this.runningIds.delete(id);
    }
  }

  private nextPatch(item: AutomationSchedule, now: Date): Partial<AutomationSchedule> {
    if (item.condition === 'once') {
      return { active: false, status: 'completed', nextRunAt: '' };
    }
    if (item.condition === 'loop') {
      const seconds = Math.max(1, item.intervalSec || 60);
      return {
        active: true,
        status: 'scheduled',
        nextRunAt: new Date(now.getTime() + seconds * 1000).toISOString(),
      };
    }
    const seconds = Math.max(1, item.intervalSec || 60);
    const next = new Date(now.getTime() + seconds * 1000);
    if (item.endAt && next.getTime() > new Date(item.endAt).getTime()) {
      return { active: false, status: 'completed', nextRunAt: '' };
    }
    return { active: true, status: 'scheduled', nextRunAt: next.toISOString() };
  }

  private save(items: AutomationSchedule[]): void {
    this.config.set('automation', 'schedules', items);
    this.config.save();
    for (const listener of this.listeners) {
      try { listener(items); } catch { /* keep scheduler save robust */ }
    }
  }
}
