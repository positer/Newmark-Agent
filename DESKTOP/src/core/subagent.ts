function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

import { NewmarkToolResult } from './compat';

export type SubagentStatus = 'idle' | 'working' | 'completed' | 'closed' | 'error';

export interface SubagentInstance {
  id: string;
  name: string;
  prompt: string;
  model: string;
  inputMode: string;
  agentMode: string;
  status: SubagentStatus;
  messages: Array<{ role: string; content: string }>;
  result: string | null;
  error?: string;
  startedAt: string;
  completedAt?: string;
  closedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface NewmarkSubagentRecord {
  id: string;
  name: string;
  status: SubagentStatus;
  active: boolean;
  model: string;
  mode: string;
  inputMode: string;
  prompt: string;
  result: string | null;
  messages: Array<{ role: string; content: string }>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  closedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface NewmarkSubagentToolResult extends NewmarkToolResult {
  data?: NewmarkSubagentRecord;
}

export class SubagentManager {
  private subs: Map<string, SubagentInstance> = new Map();

  create(
    name: string,
    prompt: string,
    model?: string,
    inputMode?: string,
    agentMode?: string
  ): string {
    const sa: SubagentInstance = {
      id: generateId(),
      name,
      prompt,
      model: model || 'default',
      inputMode: inputMode || 'guide',
      agentMode: agentMode || 'build',
      status: 'working',
      messages: [
        { role: 'system', content: `Subagent '${name}': ${prompt}` },
        { role: 'user', content: prompt },
      ],
      result: null,
      startedAt: new Date().toISOString(),
    };
    this.subs.set(sa.id, sa);
    return sa.id;
  }

  get(id: string): SubagentInstance | undefined {
    return this.subs.get(id) || [...this.subs.values()].find(s => s.name === id);
  }

  send(id: string, prompt: string): boolean {
    const sa = this.get(id);
    if (!sa || sa.status === 'closed') return false;
    sa.status = 'working';
    sa.error = undefined;
    sa.completedAt = undefined;
    sa.messages.push({ role: 'user', content: prompt });
    return true;
  }

  appendAssistant(id: string, content: string): void {
    const sa = this.get(id);
    if (sa) sa.messages.push({ role: 'assistant', content });
  }

  complete(id: string, result: string): void {
    const sa = this.get(id);
    if (!sa || sa.status === 'closed') return;
    sa.result = result;
    sa.status = 'completed';
    sa.error = undefined;
    sa.completedAt = new Date().toISOString();
    sa.messages.push({ role: 'assistant', content: result });
  }

  fail(id: string, error: string): void {
    const sa = this.get(id);
    if (!sa || sa.status === 'closed') return;
    sa.result = `[Subagent Error] ${error}`;
    sa.status = 'error';
    sa.error = error;
    sa.completedAt = new Date().toISOString();
    sa.messages.push({ role: 'assistant', content: sa.result });
  }

  markWorking(id: string): void {
    const sa = this.get(id);
    if (sa && sa.status !== 'closed') {
      sa.status = 'working';
      sa.error = undefined;
    }
  }

  close(id: string): void {
    const sa = this.get(id);
    if (sa) {
      sa.status = 'closed';
      sa.closedAt = new Date().toISOString();
    }
  }

  toRecord(idOrName: string): NewmarkSubagentRecord | undefined {
    const sa = this.get(idOrName);
    if (!sa) return undefined;
    return {
      id: sa.id,
      name: sa.name,
      status: sa.status,
      active: sa.status !== 'closed',
      model: sa.model,
      mode: sa.agentMode,
      inputMode: sa.inputMode,
      prompt: sa.prompt,
      result: sa.result,
      messages: sa.messages.slice(),
      error: sa.error,
      startedAt: sa.startedAt,
      completedAt: sa.completedAt,
      closedAt: sa.closedAt,
      metadata: sa.metadata,
    };
  }

  toToolResult(idOrName: string, output: string, ok = true): NewmarkSubagentToolResult {
    const record = this.toRecord(idOrName);
    return {
      ok,
      output,
      data: record,
      error: ok ? undefined : output,
      metadata: { kind: 'subagent' },
    };
  }

  getResult(name: string): string {
    const sa = [...this.subs.values()].find(s => s.name === name || s.id === name);
    if (!sa) return '';
    return sa.result || sa.messages
      .filter(m => m.role === 'assistant')
      .map(m => m.content)
      .join('\n');
  }

  listActive(): SubagentInstance[] {
    return [...this.subs.values()].filter(s => s.status !== 'closed');
  }

  listAll(): SubagentInstance[] {
    return [...this.subs.values()];
  }

  remove(id: string): boolean {
    const sa = this.get(id);
    if (sa) {
      this.subs.delete(sa.id);
      return true;
    }
    return false;
  }
}
