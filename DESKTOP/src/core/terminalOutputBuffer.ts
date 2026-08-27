export const TERMINAL_HISTORY_LIMIT = 256 * 1024;

export interface TerminalOutputBufferOptions {
  flushIntervalMs?: number;
  historyLimit?: number;
}

interface PendingTerminalOutput {
  chunks: string[];
  length: number;
  history: string;
}

export class TerminalOutputBuffer {
  private readonly sessions = new Map<string, PendingTerminalOutput>();
  private timer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;
  private readonly historyLimit: number;

  constructor(
    private readonly send: (sessionId: string, text: string) => void,
    options: TerminalOutputBufferOptions = {},
  ) {
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? 20);
    this.historyLimit = Math.max(1, options.historyLimit ?? TERMINAL_HISTORY_LIMIT);
  }

  push(sessionId: string, text: string): void {
    if (!text) return;
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { chunks: [], length: 0, history: '' };
      this.sessions.set(sessionId, state);
    }
    state.chunks.push(text);
    state.length += text.length;
    this.schedule();
  }

  flush(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state?.length) return;
    const text = state.chunks.length === 1 ? state.chunks[0] : state.chunks.join('');
    state.chunks = [];
    state.length = 0;
    state.history = this.bound(`${state.history}${text}`);
    this.send(sessionId, text);
    this.clearTimerWhenIdle();
  }

  flushAll(): void {
    for (const sessionId of this.sessions.keys()) this.flush(sessionId);
    this.clearTimerWhenIdle(true);
  }

  close(sessionId: string): string {
    this.flush(sessionId);
    const history = this.sessions.get(sessionId)?.history ?? '';
    this.sessions.delete(sessionId);
    this.clearTimerWhenIdle();
    return history;
  }

  history(sessionId: string): string {
    const state = this.sessions.get(sessionId);
    if (!state) return '';
    if (!state.length) return state.history;
    const pending = state.chunks.length === 1 ? state.chunks[0] : state.chunks.join('');
    return this.bound(`${state.history}${pending}`);
  }

  pendingChunkCount(): number {
    let count = 0;
    for (const state of this.sessions.values()) count += state.chunks.length;
    return count;
  }

  hasScheduledFlush(): boolean {
    return this.timer !== null;
  }

  private bound(text: string): string {
    return text.length > this.historyLimit ? text.slice(-this.historyLimit) : text;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushAll();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimerWhenIdle(force = false): void {
    if (!this.timer) return;
    const hasPending = !force && Array.from(this.sessions.values()).some(state => state.length > 0);
    if (hasPending) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
