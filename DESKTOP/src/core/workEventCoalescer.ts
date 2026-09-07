import type { AgentWorkEvent } from './types';

/**
 * Bounds cross-process traffic for high-rate response and thought deltas
 * without changing durable work-run events. Lifecycle events flush deltas first.
 */
export class WorkEventCoalescer {
  private readonly pending = new Map<string, { event: AgentWorkEvent; content: string; deltas: NonNullable<AgentWorkEvent['coalescedDeltas']>; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly emit: (event: AgentWorkEvent) => void, private readonly windowMs = 16) {}

  push(event: AgentWorkEvent): void {
    if (event.type !== 'text' && event.type !== 'thought_delta') {
      this.flushAll();
      this.emit(event);
      return;
    }
    const key = `${event.type}::${event.workspaceId || ''}::${event.conversationId}::${event.runtimeKey || ''}::${event.runId || ''}`;
    const current = this.pending.get(key);
    const deltas = event.coalescedDeltas?.length ? event.coalescedDeltas : [{ id: event.id, sequence: event.sequence, content: event.content, timestamp: event.timestamp }];
    if (current) {
      current.content += event.content;
      current.deltas.push(...deltas);
      current.event = event;
      return;
    }
    const entry = {
      event,
      content: event.content,
      deltas: deltas.slice(),
      timer: setTimeout(() => this.flush(key), this.windowMs),
    };
    this.pending.set(key, entry);
  }

  flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    clearTimeout(entry.timer);
    if (entry.content) this.emit({ ...entry.event, content: entry.content, coalescedDeltas: entry.deltas });
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  pendingCount(): number { return this.pending.size; }
}
