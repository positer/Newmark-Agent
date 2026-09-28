/**
 * Workspace conversation state on disk is an **index** document
 * (`conversations/state.json`) plus one heavy payload shard per conversation
 * (`conversations/shards/<key>.<hash>.json`).
 *
 * Product code reads through `Agent.readStoredConversationState`, which
 * hydrates shards lazily. Fixtures, diagnostics and archive tooling that read
 * the raw file need the same view: reading only the index makes every
 * conversation look empty. These helpers are the single shard-aware reader for
 * such callers.
 */
import * as fs from 'fs';
import * as path from 'path';

export type ConversationStateRecord = Record<string, unknown>;

export interface ConversationStateDocument {
  /** Absolute path of the workspace index document. */
  path: string;
  /** Index document exactly as stored (no shard payloads). */
  index: ConversationStateRecord;
  /** Conversation entries merged with their shard payloads. */
  conversations: Record<string, ConversationStateRecord>;
  /** Index document as text (no shard payloads). */
  indexText: string;
  /** Index plus hydrated shard payloads, serialized as one JSON document. */
  hydratedText: string;
}

function parseJson(text: string): ConversationStateRecord {
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as ConversationStateRecord : {};
  } catch {
    return {};
  }
}

/** Read a workspace conversation index and hydrate every conversation shard. */
export function readConversationStateDocument(workspacePath: string): ConversationStateDocument {
  const indexPath = path.join(workspacePath, 'conversations', 'state.json');
  const indexText = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '{}';
  const index = parseJson(indexText);
  const shardDir = path.join(path.dirname(indexPath), 'shards');
  const conversations: Record<string, ConversationStateRecord> = {};
  for (const [key, rawEntry] of Object.entries((index.conversations || {}) as Record<string, ConversationStateRecord>)) {
    const entry = rawEntry || {};
    const shardFile = typeof entry.shard === 'string' && entry.shard ? path.join(shardDir, entry.shard) : '';
    if (shardFile && fs.existsSync(shardFile)) {
      conversations[key] = { ...entry, ...parseJson(fs.readFileSync(shardFile, 'utf-8')) };
      continue;
    }
    conversations[key] = { ...entry };
  }
  return {
    path: indexPath,
    index,
    conversations,
    indexText,
    hydratedText: JSON.stringify({ ...index, conversations }, null, 2),
  };
}

/** Index-only text, for assertions about what the index itself must not contain. */
export function readConversationIndexText(workspacePath: string): string {
  return readConversationStateDocument(workspacePath).indexText;
}
