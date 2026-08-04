import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ToolResultLifecycle, ToolResultRecord } from '../domain/types';
import { contentHash } from '../serializers/deterministic';

export interface ToolResultInput {
  callId: string;
  toolId: string;
  capabilityId?: string;
  buildBlockId?: string;
  conversationId: string;
  lifecycle: ToolResultLifecycle;
  status: 'ok' | 'error' | 'unknown';
  summary: string;
  rawOutput?: string;
  operationId: string;
  maxSummaryChars?: number;
  /** Maximum raw bytes before the result is written to an artifact file. */
  maxInlineBytes?: number;
}

export interface ToolResultOutcome {
  record: ToolResultRecord;
  artifactWritten: boolean;
  /** True when the summary was truncated and the caller should rely on the artifact reference. */
  truncated: boolean;
}

const DEFAULT_MAX_SUMMARY_CHARS = 2_000;
const DEFAULT_MAX_INLINE_BYTES = 8_000;

/**
 * Tool Result lifecycle management.
 *
 * Lifecycle:
 * - ephemeral: kept in the record (and returned inline).
 * - build_scoped: kept for the build block; large output written to an artifact.
 * - conversation_scoped: retained on disk for the conversation.
 * - persistent_reference: raw output never kept; only summary + artifact refs.
 */
export class ToolResultService {
  constructor(private readonly root: string) {}

  private artifactDir(conversationId: string, buildBlockId: string | undefined): string {
    return path.join(this.root, 'tool-results', conversationId, buildBlockId || '_no-block');
  }

  private indexPath(conversationId: string): string {
    return path.join(this.root, 'tool-results', conversationId, 'index.json');
  }

  store(input: ToolResultInput): ToolResultOutcome {
    const maxSummary = input.maxSummaryChars || DEFAULT_MAX_SUMMARY_CHARS;
    const maxInline = input.maxInlineBytes || DEFAULT_MAX_INLINE_BYTES;
    const raw = input.rawOutput || '';
    const summary = input.summary && input.summary.length <= maxSummary
      ? input.summary
      : (input.summary || raw).slice(0, maxSummary);

    let artifactPaths: string[] = [];
    let artifactWritten = false;
    let truncated = raw.length > maxSummary;

    // Large outputs are spilled to an artifact file regardless of lifecycle;
    // the context only carries the summary + reference.
    if (raw.length > maxInline && input.lifecycle !== 'ephemeral') {
      const dir = this.artifactDir(input.conversationId, input.buildBlockId);
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${input.callId.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`;
      const file = path.join(dir, fileName);
      fs.writeFileSync(file, raw, 'utf-8');
      artifactPaths = [file];
      artifactWritten = true;
      truncated = true;
    }

    const record: ToolResultRecord = {
      id: crypto.randomUUID(),
      callId: input.callId,
      toolId: input.toolId,
      capabilityId: input.capabilityId,
      buildBlockId: input.buildBlockId,
      conversationId: input.conversationId,
      lifecycle: input.lifecycle,
      status: input.status,
      summary,
      artifactPaths,
      contentHash: contentHash(raw),
      operationId: input.operationId,
      createdAt: new Date().toISOString(),
      rawOutput: input.lifecycle === 'ephemeral' ? raw : undefined,
    };

    this.appendToIndex(input.conversationId, record);
    return { record, artifactWritten, truncated };
  }

  private appendToIndex(conversationId: string, record: ToolResultRecord): void {
    const file = this.indexPath(conversationId);
    const records = this.readIndex(conversationId);
    records.push(record);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records, null, 2), 'utf-8');
  }

  readIndex(conversationId: string): ToolResultRecord[] {
    const file = this.indexPath(conversationId);
    if (!fs.existsSync(file)) return [];
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as ToolResultRecord[];
    } catch {
      return [];
    }
  }

  find(conversationId: string, callId: string): ToolResultRecord | undefined {
    return this.readIndex(conversationId).find(record => record.callId === callId);
  }

  /** Build a compact context block from the active (non-expired) results. */
  buildContextBlock(conversationId: string, options?: { maxResults?: number }): string {
    const records = this.readIndex(conversationId);
    const max = Math.max(1, options?.maxResults ?? 12);
    const active = records.slice(-max);
    if (!active.length) return '';
    return [
      '## Current Tool Results',
      ...active.map(record => {
        const refs = record.artifactPaths.length ? ` artifactRefs=[${record.artifactPaths.map(p => path.basename(p)).join(',')}]` : '';
        return `- tool=${record.toolId} status=${record.status} lifecycle=${record.lifecycle}${refs}\n  ${record.summary}`;
      }),
    ].join('\n');
  }
}
