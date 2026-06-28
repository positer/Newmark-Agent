function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

export type SubagentStatus = 'idle' | 'working' | 'completed' | 'closed';

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
    sa.messages.push({ role: 'assistant', content: result });
  }

  fail(id: string, error: string): void {
    this.complete(id, `[Subagent Error] ${error}`);
  }

  markWorking(id: string): void {
    const sa = this.get(id);
    if (sa && sa.status !== 'closed') sa.status = 'working';
  }

  close(id: string): void {
    const sa = this.get(id);
    if (sa) sa.status = 'closed';
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
