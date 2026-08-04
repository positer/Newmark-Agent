import { createHash } from 'crypto';

/**
 * Deterministic serialization and hashing for context objects.
 *
 * `stableStringify` sorts object keys recursively and never depends on key
 * insertion order, so the same logical object always produces the same bytes.
 * This is the foundation for stable prefix hashes, tool schema hashes, and the
 * ContextUsageSnapshot contentHash assertion.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(stableSort(value));
}

export function stableSort(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(item => stableSort(item));
  if (typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = stableSort(record[key]);
  return out;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function sha256Bytes(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Layered cache hash record. The stable prefix hash must NOT change when only
 * the dynamic tail (current user input, task state, timestamps) changes.
 */
export interface LayeredHashes {
  generalPromptHash: string;
  responseProtocolHash: string;
  toolDefinitionsHash: string;
  workspaceProfileHash: string;
  stablePrefixHash: string;
  dynamicContextHash: string;
  fullRequestHash: string;
}

export function hashLayered(parts: {
  generalPrompt?: unknown;
  responseProtocol?: unknown;
  toolDefinitions?: unknown;
  workspaceProfile?: unknown;
  stablePrefix?: unknown;
  dynamicContext?: unknown;
  fullRequest?: unknown;
}): LayeredHashes {
  const generalPromptHash = sha256(parts.generalPrompt ?? null);
  const responseProtocolHash = sha256(parts.responseProtocol ?? null);
  const toolDefinitionsHash = sha256(parts.toolDefinitions ?? null);
  const workspaceProfileHash = sha256(parts.workspaceProfile ?? null);
  const stablePrefixHash = sha256([
    generalPromptHash,
    responseProtocolHash,
    toolDefinitionsHash,
    workspaceProfileHash,
    parts.stablePrefix ?? null,
  ]);
  const dynamicContextHash = sha256(parts.dynamicContext ?? null);
  const fullRequestHash = sha256([
    stablePrefixHash,
    dynamicContextHash,
    parts.fullRequest ?? null,
  ]);
  return {
    generalPromptHash,
    responseProtocolHash,
    toolDefinitionsHash,
    workspaceProfileHash,
    stablePrefixHash,
    dynamicContextHash,
    fullRequestHash,
  };
}

export function contentHash(text: string): string {
  return sha256Bytes(String(text || ''));
}
