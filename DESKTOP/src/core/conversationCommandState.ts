import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ConversationCommandState {
  mode?: 'build' | 'plan' | 'chat' | 'goal' | 'flow';
  inputMode?: 'guide' | 'next';
  queuePaused?: boolean;
}

const modes = new Set(['build', 'plan', 'chat', 'goal', 'flow']);

function stateValue(value: unknown): ConversationCommandState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conversation command state');
  const row = value as Record<string, unknown>;
  const result: ConversationCommandState = {};
  if (row.mode !== undefined) {
    if (typeof row.mode !== 'string' || !modes.has(row.mode)) throw new Error('Invalid conversation mode');
    result.mode = row.mode as ConversationCommandState['mode'];
  }
  if (row.inputMode !== undefined) {
    if (row.inputMode !== 'guide' && row.inputMode !== 'next') throw new Error('Invalid conversation input mode');
    result.inputMode = row.inputMode;
  }
  if (row.queuePaused !== undefined) {
    if (typeof row.queuePaused !== 'boolean') throw new Error('Invalid conversation queue pause state');
    result.queuePaused = row.queuePaused;
  }
  return result;
}

/** GUI command owner only; execution and continuation payloads remain owned by their Agent. */
export class ConversationCommandStateStore {
  private readonly file: string;
  private records = new Map<string, ConversationCommandState>();

  constructor(root: string) {
    this.file = path.join(path.resolve(root), 'conversation-command-state.json');
    let source: string;
    try { source = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const saved = JSON.parse(source);
    if (saved?.version !== 1 || !saved.targets || typeof saved.targets !== 'object' || Array.isArray(saved.targets)) {
      throw new Error('Unsupported conversation command state file');
    }
    for (const [key, value] of Object.entries(saved.targets)) this.records.set(this.key(key), stateValue(value));
  }

  get(key: string): ConversationCommandState | undefined {
    const value = this.records.get(this.key(key));
    return value ? { ...value } : undefined;
  }

  set(key: string, patch: ConversationCommandState): ConversationCommandState {
    const target = this.key(key);
    const before = this.records.get(target);
    const after = { ...before, ...stateValue(patch) };
    if (before && before.mode === after.mode && before.inputMode === after.inputMode && before.queuePaused === after.queuePaused) return { ...before };
    const next = new Map(this.records);
    next.set(target, after);
    this.persist(next);
    return { ...after };
  }

  delete(key: string): void {
    const target = this.key(key);
    if (!this.records.has(target)) return;
    const next = new Map(this.records);
    next.delete(target);
    this.persist(next);
  }

  private key(value: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Conversation target key is required');
    return value;
  }

  private persist(next: Map<string, ConversationCommandState>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, targets: Object.fromEntries(next) }) + '\n');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temp, this.file);
      this.records = next;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
