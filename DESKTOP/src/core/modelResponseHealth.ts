import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { LLMProvider } from '../llm/provider';

export type ResponseFacet = 'text' | 'vision' | 'tools';
export type ModelResponseHealth = Partial<Record<ResponseFacet, { ok: boolean; at: string }>>;
export interface ResponseHealthIdentity { providerId: string; modelId: string; endpoint: string; protocol: string; credential: string }
const facets: ResponseFacet[] = ['text', 'vision', 'tools'];
let lastReceiptStamp = 0;
const cache = new Map<string, { until: number; revision: number; health: ModelResponseHealth }>();
function directory(root: string, identity: ResponseHealthIdentity): string {
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return path.join(root, 'Runtime', 'model-response-health', key);
}
function records(dir: string): Array<{ name: string; health: ModelResponseHealth }> {
  try {
    return fs.readdirSync(dir).filter(name => /^\d{16}-[a-f0-9-]+\.json$/.test(name)).sort().reverse().flatMap(name => {
      try { return [{ name, health: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ModelResponseHealth }]; } catch { return []; }
    });
  } catch { return []; }
}
export function readModelResponseHealth(root: string, identity: ResponseHealthIdentity): ModelResponseHealth {
  const dir = directory(root, identity), saved = cache.get(dir);
  let revision = -1;
  try { revision = fs.statSync(dir).mtimeMs; } catch { /* no observations yet */ }
  if (saved && saved.until > Date.now() && saved.revision === revision) return saved.health;
  const health: ModelResponseHealth = {};
  for (const record of records(dir)) for (const facet of facets) {
    const entry = record.health[facet];
    if (!health[facet] && entry && typeof entry.ok === 'boolean') health[facet] = entry;
  }
  if (cache.size > 512) cache.clear();
  cache.set(dir, { until: Date.now() + 150, revision, health });
  return health;
}
export function recordModelResponseHealth(root: string, identity: ResponseHealthIdentity, updates: Partial<Record<ResponseFacet, boolean>>): void {
  // Immutable, atomic receipts merge independently across GUI/utility/WSL
  // workers. A text result never overwrites a vision/tool result. No secrets,
  // request bodies or server error text enter the observation files.
  const dir = directory(root, identity), now = Date.now(), health: ModelResponseHealth = {};
  for (const facet of facets) if (typeof updates[facet] === 'boolean') health[facet] = { ok: updates[facet]!, at: new Date(now).toISOString() };
  if (!Object.keys(health).length) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const latestStamp = Number(records(dir)[0]?.name.split('-')[0] || 0);
    lastReceiptStamp = Math.max(now * 1000, lastReceiptStamp + 1, latestStamp + 1);
    const file = path.join(dir, `${String(lastReceiptStamp).padStart(16, '0')}-${randomUUID()}.json`);
    fs.writeFileSync(file + '.tmp', JSON.stringify(health));
    fs.renameSync(file + '.tmp', file);
    const counts: Partial<Record<ResponseFacet, number>> = {};
    for (const [index, record] of records(dir).entries()) {
      let keep = index < 4;
      for (const facet of facets) if (record.health[facet]) {
        counts[facet] = (counts[facet] || 0) + 1;
        if (counts[facet]! <= 2) keep = true;
      }
      if (!keep) { try { fs.unlinkSync(path.join(dir, record.name)); } catch { /* another writer may have pruned it */ } }
    }
    cache.delete(dir);
  } catch { /* Diagnostic persistence must never break input or transport. */ }
}
function hasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImage);
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return ['image_url', 'input_image', 'image'].includes(String(entry.type || '')) || hasImage(entry.content);
}
function failedFacet(error: unknown, images: boolean): ResponseFacet {
  const text = String(error).toLowerCase();
  if (/image|vision|multimodal/.test(text) && images) return 'vision';
  if (/tools?\b|tool[_ -]?(call|choice|use)|function[_ -]?call/.test(text)) return 'tools';
  return 'text';
}
export function observeModelResponses(provider: LLMProvider, record: (updates: Partial<Record<ResponseFacet, boolean>>) => void): LLMProvider {
  const report = (updates: Partial<Record<ResponseFacet, boolean>>) => { try { record(updates); } catch { /* observation only */ } };
  const chat = provider.chat.bind(provider);
  provider.chat = async (...args) => {
    const images = hasImage(args[1]);
    try {
      const response = await chat(...args);
      if (response.trim()) report({ text: true, ...(images ? { vision: true } : {}) });
      else report({ text: false });
      return response;
    } catch (error) {
      if (!args[5]?.aborted && (error as Error)?.name !== 'AbortError') report({ [failedFacet(error, images)]: false });
      throw error;
    }
  };
  const stream = provider.chatStreamWithTools.bind(provider);
  provider.chatStreamWithTools = async function* (...args) {
    const images = hasImage(args[1]);
    let meaningful = false, tools = false, failed = false;
    try {
      for await (const token of stream(...args)) {
        if (token.providerError === true) { failed = true; report({ [failedFacet(token.text, images)]: false }); }
        if (token.type === 'text' && token.text?.trim()) meaningful = true;
        if (token.type === 'tool_call') { meaningful = true; tools = true; }
        yield token;
      }
      if (!failed && !args[6]?.aborted) {
        if (meaningful) report({ text: true, ...(images ? { vision: true } : {}), ...(tools || args[5].length ? { tools: true } : {}) });
        else report({ text: false });
      }
    } catch (error) {
      if (!failed && !args[6]?.aborted && (error as Error)?.name !== 'AbortError') report({ [failedFacet(error, images)]: false });
      throw error;
    }
  };
  return provider;
}
