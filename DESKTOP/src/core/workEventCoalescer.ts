import type { AgentWorkEvent } from './types';

/**
 * Bounds cross-process traffic for high-rate streaming text without changing
 * durable work-run events. Non-text events always flush pending text first.
 */
export class WorkEventCoalescer {
  private readonly pending = new Map<string, { event: AgentWorkEvent; content: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly emit: (event: AgentWorkEvent) => void, private readonly windowMs = 16) {}

  push(event: AgentWorkEvent): void {
    if (event.type !== 'text') {
      this.flushAll();
      this.emit(event);
      return;
    }
    const key = `${event.workspaceId || ''}::${event.conversationId}::${event.runtimeKey || ''}::${event.runId || ''}`;
    const current = this.pending.get(key);
    if (current) {
      current.content += event.content;
      current.event = event;
      return;
    }
    const entry = {
      event,
      content: event.content,
      timer: setTimeout(() => this.flush(key), this.windowMs),
    };
    this.pending.set(key, entry);
  }

  flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    clearTimeout(entry.timer);
    if (entry.content) this.emit({ ...entry.event, content: entry.content });
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  pendingCount(): number { return this.pending.size; }
}
