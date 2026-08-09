import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface ArchivedCompressionEntry {
  id: string;
  at: string;
  summary: string;
  messages: Array<Record<string, unknown>>;
  foldedEntries: number;
  foldedChars: number;
  model: string;
  fallback: boolean;
}

type CompressionArchiveEvent =
  | { version: 1; type: 'fold'; at: string; entry: ArchivedCompressionEntry }
  | { version: 1; type: 'restore'; at: string; id: string };

/**
 * Append-only cold storage for folded context segments evicted from the small
 * in-state hot cache. The archive is never injected into a model request;
 * callers must explicitly search/read/restore one bounded segment.
 */
export class CompressionHistoryArchive {
  constructor(private readonly rootPath: string) {}

  private file(scopeKey: string): string {
    const digest = crypto.createHash('sha256').update(scopeKey).digest('hex');
    return path.join(this.rootPath, '.newmark-context-v2', 'compression-history', `${digest}.jsonl`);
  }

  private append(scopeKey: string, event: CompressionArchiveEvent): void {
    const file = this.file(scopeKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf-8');
  }

  archive(scopeKey: string, entry: ArchivedCompressionEntry): void {
    this.append(scopeKey, {
      version: 1,
      type: 'fold',
      at: new Date().toISOString(),
      entry: { ...entry, messages: entry.messages.map(message => ({ ...message })) },
    });
  }

  markRestored(scopeKey: string, id: string): void {
    this.append(scopeKey, { version: 1, type: 'restore', at: new Date().toISOString(), id });
  }

  /** Replays the append-only ledger and returns only currently restorable entries. */
  activeEntries(scopeKey: string): ArchivedCompressionEntry[] {
    const file = this.file(scopeKey);
    if (!fs.existsSync(file)) return [];
    const active = new Map<string, ArchivedCompressionEntry>();
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Partial<CompressionArchiveEvent> & Record<string, unknown>;
        if (event.version !== 1) continue;
        if (event.type === 'restore') {
          active.delete(String(event.id || ''));
          continue;
        }
        if (event.type !== 'fold' || !event.entry || typeof event.entry !== 'object') continue;
        const candidate = event.entry as unknown as ArchivedCompressionEntry;
        if (!candidate.id || !Array.isArray(candidate.messages) || typeof candidate.summary !== 'string') continue;
        active.set(candidate.id, {
          ...candidate,
          messages: candidate.messages.map(message => ({ ...message })),
          foldedEntries: Math.max(0, Number(candidate.foldedEntries) || candidate.messages.length),
          foldedChars: Math.max(0, Number(candidate.foldedChars) || 0),
          model: String(candidate.model || 'unknown'),
          fallback: Boolean(candidate.fallback),
        });
      } catch {
        // A partial/corrupt line must not hide earlier valid append-only events.
      }
    }
    return [...active.values()];
  }

  /** Includes restored/tombstoned ids so a restart never reuses an archive id. */
  maxNumericId(scopeKey: string): number {
    const file = this.file(scopeKey);
    if (!fs.existsSync(file)) return 0;
    let max = 0;
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const entry = event.entry && typeof event.entry === 'object' ? event.entry as Record<string, unknown> : null;
        const id = String(entry?.id || event.id || '');
        max = Math.max(max, Number(id.replace(/^ctx-cache-/, '')) || 0);
      } catch {
        // Ignore only the malformed line; valid earlier ids remain authoritative.
      }
    }
    return max;
  }
}
