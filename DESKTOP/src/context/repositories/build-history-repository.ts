import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  BuildBlock,
  BuildHistoryEntry,
  BuildHistoryEntryType,
  BuildHistoryImportance,
  BuildHistorySource,
} from '../domain/types';
import { contentHash, sha256Bytes } from '../serializers/deterministic';

export interface BuildHistoryWriteResult {
  applied: boolean;
  reason?: 'applied' | 'duplicate_operation' | 'immutable_conflict';
  entry?: BuildHistoryEntry;
  revision: number;
}

export interface BuildHistoryCheckpoint {
  checkpointId: string;
  buildBlockId: string;
  /** Block revision at which the checkpoint was created. */
  revision: number;
  createdAt: string;
  /** Number of original entries folded into this checkpoint. */
  foldedEntryCount: number;
  summary: string;
  /** Original history is never deleted; the checkpoint stores the compressed view. */
  rawEntryIds: string[];
}

export interface BuildHistoryDelta {
  checkpointId: string | null;
  entries: BuildHistoryEntry[];
}

const MAX_LINE_LENGTH = 4 * 1024 * 1024;

/**
 * Append-only Build History repository.
 *
 * Hard guarantees:
 * - Records are persisted as JSONL. Old `content` is never modified in place.
 * - Re-applying the same `operationId` is a no-op (idempotency).
 * - Invalidated content is expressed through `supersededBy`, never deletion.
 * - Compression uses checkpoint + delta; the original file is retained.
 */
export class BuildHistoryRepository {
  constructor(private readonly root: string) {}

  private blockDir(buildBlockId: string): string {
    return path.join(this.root, 'build-blocks', buildBlockId);
  }

  private historyPath(buildBlockId: string): string {
    return path.join(this.blockDir(buildBlockId), 'history.jsonl');
  }

  private blockPath(buildBlockId: string): string {
    return path.join(this.blockDir(buildBlockId), 'block.json');
  }

  private checkpointPath(buildBlockId: string): string {
    return path.join(this.blockDir(buildBlockId), 'checkpoint.json');
  }

  ensureBlockDir(buildBlockId: string): void {
    fs.mkdirSync(this.blockDir(buildBlockId), { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Build Block
  // -------------------------------------------------------------------------

  saveBlock(block: BuildBlock): void {
    this.ensureBlockDir(block.id);
    fs.writeFileSync(this.blockPath(block.id), JSON.stringify(block, null, 2), 'utf-8');
  }

  readBlock(buildBlockId: string): BuildBlock | null {
    const file = this.blockPath(buildBlockId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as BuildBlock;
    } catch {
      return null;
    }
  }

  listBlocks(conversationId: string): BuildBlock[] {
    const base = path.join(this.root, 'build-blocks');
    if (!fs.existsSync(base)) return [];
    const out: BuildBlock[] = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const block = this.readBlock(entry.name);
      if (block && block.conversationId === conversationId) out.push(block);
    }
    return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /** Create or mutate a block. Each persisted state change increments revision. */
  transitionBlock(
    block: BuildBlock,
    next: Partial<BuildBlock>,
    options?: { expectedRevision?: number; operationId?: string },
  ): { block: BuildBlock; applied: boolean } {
    if (options?.expectedRevision !== undefined && block.revision !== options.expectedRevision) {
      return { block, applied: false };
    }
    if (options?.operationId) {
      const marker = this.appliedOperationMarker(block.id, options.operationId);
      if (marker) return { block, applied: false };
      this.recordAppliedOperation(block.id, options.operationId);
    }
    const updated: BuildBlock = {
      ...block,
      ...next,
      revision: block.revision + 1,
    };
    this.saveBlock(updated);
    return { block: updated, applied: true };
  }

  // -------------------------------------------------------------------------
  // Build History entries (append-only)
  // -------------------------------------------------------------------------

  appendEntry(input: {
    buildBlockId: string;
    type: BuildHistoryEntryType;
    content: string;
    source: BuildHistorySource;
    importance?: BuildHistoryImportance;
    structuredData?: Record<string, unknown>;
    operationId: string;
    toolCallId?: string;
    supersedes?: string;
    revision?: number;
  }): BuildHistoryWriteResult {
    const file = this.historyPath(input.buildBlockId);
    this.ensureBlockDir(input.buildBlockId);

    // Idempotency: if this operationId was already applied, do not re-append.
    const existing = this.findEntryByOperationId(input.buildBlockId, input.operationId);
    if (existing) return { applied: false, reason: 'duplicate_operation', revision: this.readRevision(input.buildBlockId) };

    const revision = input.revision ?? this.nextRevision(input.buildBlockId);
    const entry: BuildHistoryEntry = {
      id: crypto.randomUUID(),
      buildBlockId: input.buildBlockId,
      revision,
      type: input.type,
      content: input.content,
      structuredData: input.structuredData,
      source: input.source,
      importance: input.importance || 'normal',
      createdAt: new Date().toISOString(),
      supersededBy: input.supersedes || null,
      toolCallId: input.toolCallId,
      operationId: input.operationId,
      contentHash: contentHash(input.content),
    };
    this.writeLine(file, entry);
    return { applied: true, reason: 'applied', entry, revision };
  }

  private writeLine(file: string, entry: BuildHistoryEntry): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const json = JSON.stringify(entry);
    if (json.length > MAX_LINE_LENGTH) {
      throw new Error(`Build history entry exceeds ${MAX_LINE_LENGTH} bytes`);
    }
    fs.appendFileSync(file, `${json}\n`, 'utf-8');
  }

  private readLines(file: string): BuildHistoryEntry[] {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw.trim()) return [];
    const out: BuildHistoryEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as BuildHistoryEntry);
      } catch {
        // Never drop history silently: retain as a migration-uncertain record.
        out.push(this.unparsableEntry(line));
      }
    }
    return out;
  }

  private unparsableEntry(line: string): BuildHistoryEntry {
    return {
      id: `unparsable-${sha256Bytes(line).slice(0, 16)}`,
      buildBlockId: '',
      revision: -1,
      type: 'warning',
      content: '[migration_uncertain] Unparsable build history line was retained.',
      source: 'migration',
      importance: 'normal',
      createdAt: new Date().toISOString(),
      supersededBy: null,
      operationId: `unparsable-${sha256Bytes(line).slice(0, 16)}`,
      contentHash: contentHash(line),
      structuredData: { retainedLineLength: line.length },
    };
  }

  readEntries(buildBlockId: string): BuildHistoryEntry[] {
    return this.readLines(this.historyPath(buildBlockId));
  }

  private findEntryByOperationId(buildBlockId: string, operationId: string): BuildHistoryEntry | undefined {
    if (!operationId) return undefined;
    return this.readLines(this.historyPath(buildBlockId)).find(entry => entry.operationId === operationId);
  }

  private readRevision(buildBlockId: string): number {
    return this.nextRevision(buildBlockId) - 1;
  }

  private nextRevision(buildBlockId: string): number {
    const entries = this.readLines(this.historyPath(buildBlockId));
    let max = 0;
    for (const entry of entries) if (entry.revision > max) max = entry.revision;
    return max + 1;
  }

  /** Mark an entry id as superseded (content stays in the file untouched). */
  supersede(buildBlockId: string, entryId: string, byEntryId: string): boolean {
    const entries = this.readEntries(buildBlockId);
    const target = entries.find(entry => entry.id === entryId);
    if (!target || target.supersededBy) return false;
    const superseding = entries.find(entry => entry.id === byEntryId);
    if (!superseding) return false;
    const updated: BuildHistoryEntry = { ...target, supersededBy: byEntryId };
    // In-place edit of the supersede link only; content is untouched. The file
    // itself stays append-only; this rewrite preserves all original records.
    const file = this.historyPath(buildBlockId);
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    const next = lines.map(line => {
      if (!line.trim()) return line;
      try {
        const parsed = JSON.parse(line) as BuildHistoryEntry;
        return parsed.id === entryId ? JSON.stringify(updated) : line;
      } catch {
        return line;
      }
    });
    fs.writeFileSync(file, next.join('\n'), 'utf-8');
    return true;
  }

  // -------------------------------------------------------------------------
  // operationId idempotency journal
  // -------------------------------------------------------------------------

  private appliedOperationJournalPath(buildBlockId: string): string {
    return path.join(this.blockDir(buildBlockId), 'applied-operations.json');
  }

  private appliedOperationMarker(buildBlockId: string, operationId: string): boolean {
    const journal = this.readAppliedOperations(buildBlockId);
    return journal.has(operationId);
  }

  private recordAppliedOperation(buildBlockId: string, operationId: string): void {
    const journal = this.readAppliedOperations(buildBlockId);
    journal.add(operationId);
    this.writeAppliedOperations(buildBlockId, journal);
  }

  private readAppliedOperations(buildBlockId: string): Set<string> {
    const file = this.appliedOperationJournalPath(buildBlockId);
    if (!fs.existsSync(file)) return new Set();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as string[];
      return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
      return new Set();
    }
  }

  private writeAppliedOperations(buildBlockId: string, operations: Set<string>): void {
    fs.writeFileSync(
      this.appliedOperationJournalPath(buildBlockId),
      JSON.stringify([...operations].sort(), null, 2),
      'utf-8',
    );
  }

  // -------------------------------------------------------------------------
  // Checkpoint + delta
  // -------------------------------------------------------------------------

  /**
   * Create a checkpoint: fold all entries up to a point into one summary and
   * record the delta (the checkpoint itself + entries after it). Original
   * history is never deleted.
   */
  checkpoint(buildBlockId: string, options?: { maxEntryCount?: number; keepRecent?: number }): {
    checkpoint: BuildHistoryCheckpoint;
    delta: BuildHistoryDelta;
  } {
    const entries = this.readEntries(buildBlockId);
    const keepRecent = Math.max(1, options?.keepRecent ?? Math.min(12, Math.floor(entries.length / 2)));
    const foldCount = Math.max(0, entries.length - keepRecent);
    const folded = entries.slice(0, foldCount);
    const recent = entries.slice(foldCount);

    const summaryParts = folded.filter(entry => entry.type !== 'tool_observation').map(entry => {
      const label = `${entry.type}${entry.importance === 'high' || entry.importance === 'critical' ? '*' : ''}`;
      const content = entry.content.length > 240 ? `${entry.content.slice(0, 240)}…` : entry.content;
      return `- [${label}] ${content}`;
    });
    const summary = summaryParts.length
      ? `[Build History Checkpoint]\n${summaryParts.join('\n')}`
      : '[Build History Checkpoint] No entries were folded.';

    const checkpoint: BuildHistoryCheckpoint = {
      checkpointId: `checkpoint-${Date.now()}-${sha256Bytes(buildBlockId).slice(0, 8)}`,
      buildBlockId,
      revision: this.readRevision(buildBlockId),
      createdAt: new Date().toISOString(),
      foldedEntryCount: folded.length,
      summary,
      rawEntryIds: folded.map(entry => entry.id),
    };
    fs.writeFileSync(this.checkpointPath(buildBlockId), JSON.stringify(checkpoint, null, 2), 'utf-8');

    return { checkpoint, delta: { checkpointId: checkpoint.checkpointId, entries: recent } };
  }

  readCheckpoint(buildBlockId: string): BuildHistoryCheckpoint | null {
    const file = this.checkpointPath(buildBlockId);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as BuildHistoryCheckpoint;
    } catch {
      return null;
    }
  }

  /** Load checkpoint summary + recent delta entries (the compressible view). */
  readCompressedView(buildBlockId: string): { checkpoint: BuildHistoryCheckpoint | null; delta: BuildHistoryDelta } {
    const checkpoint = this.readCheckpoint(buildBlockId);
    const entries = this.readEntries(buildBlockId);
    const foldedIds = new Set(checkpoint?.rawEntryIds || []);
    const delta = entries.filter(entry => !foldedIds.has(entry.id));
    return { checkpoint, delta: { checkpointId: checkpoint?.checkpointId ?? null, entries: delta } };
  }
}
