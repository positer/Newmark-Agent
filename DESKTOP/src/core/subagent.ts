import { randomUUID } from 'crypto';
import { NewmarkToolResult } from './compat';
import type { AgentMode } from './types';

export type SubagentStatus = 'idle' | 'queued' | 'working' | 'completed' | 'closed' | 'error';
export type SubagentMessageKind = 'directive' | 'question' | 'result' | 'handoff';

export interface SubagentMessage {
  id: string;
  conversationId: string;
  sequence: number;
  fromAgentId: string;
  toAgentId: string;
  kind: SubagentMessageKind;
  body: string;
  correlationId?: string;
  replyTo?: string;
  createdAt: string;
  readAt?: string;
}

export interface SubagentRootMessage {
  id: string;
  conversationId: string;
  sequence: number;
  fromAgentId: string;
  toAgentId: string;
  kind: SubagentMessageKind;
  body: string;
  createdAt: string;
  readAt?: string;
}

export interface SubagentInstance {
  id: string;
  shortId: string;
  natureSlug: string;
  displayName: string;
  qualifiedName: string;
  name: string;
  conversationId: string;
  createdByAgentId: string;
  prompt: string;
  model: string;
  inputMode: string;
  agentMode: AgentMode;
  goalObjective?: string;
  flowName?: string;
  flowPc?: number;
  status: SubagentStatus;
  queueSequence?: number;
  messages: Array<{ role: string; content: string }>;
  result: string | null;
  error?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  closedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentCompressionState {
  at: string;
  originalMessages: number;
  compressedMessages: number;
  originalChars: number;
  compressedChars?: number;
  compressedTokens?: number;
  summary: string;
  model: string;
  fallback: boolean;
}

export interface SubagentState {
  version: 2;
  rootAgentId: string;
  nextSequence: number;
  /** Cooperative root-run stop gate. Pending peers stay durable but cannot start until the next root run resumes scheduling. */
  schedulingPaused?: boolean;
  records: SubagentInstance[];
  mailbox: SubagentMessage[];
  rootInbox: SubagentRootMessage[];
}

export interface NewmarkSubagentRecord extends SubagentInstance {
  active: boolean;
  mode: string;
  mailbox: { unread: number; total: number };
}

export interface SubagentReadSnapshot {
  conversationId: string;
  readerAgentId: string;
  peer: {
    id: string;
    shortId: string;
    natureSlug: string;
    displayName: string;
    qualifiedName: string;
    createdByAgentId: string;
    status: SubagentStatus;
    active: boolean;
    queueSequence?: number;
    queuePosition?: number;
    model: string;
    mode: string;
    inputMode: string;
    prompt: string;
    result: string | null;
    error?: string;
    createdAt: string;
    startedAt?: string;
    updatedAt: string;
    completedAt?: string;
    closedAt?: string;
    contextCompression?: unknown;
  };
  feedback: Array<{ role: string; content: string }>;
  mailbox: {
    inbound: number;
    outbound: number;
    unread: number;
    latest: Array<Pick<SubagentMessage, 'id' | 'sequence' | 'fromAgentId' | 'toAgentId' | 'kind' | 'body' | 'createdAt' | 'readAt'>>;
  };
  truncated: boolean;
}

export interface NewmarkSubagentToolResult extends NewmarkToolResult {
  data?: NewmarkSubagentRecord;
}

export interface SubagentExecutionJob {
  record: SubagentInstance;
  prompt: string;
  flowName: string;
  reason: 'spawn' | 'mailbox' | 'resume';
}

export interface SubagentManagerOptions {
  conversationId?: string;
  rootAgentId?: string;
  concurrency?: number;
  state?: SubagentState;
  executor?: (job: SubagentExecutionJob) => Promise<string>;
  onChange?: (state: SubagentState) => void;
  persist?: (state: SubagentState) => void;
  onMailboxMessage?: (message: SubagentMessage) => boolean;
  onRootInboxMessage?: (message: SubagentRootMessage) => boolean;
  onSettled?: (record: SubagentInstance) => void;
}

interface PendingJob {
  id: string;
  prompt: string;
  flowName: string;
  sequence: number;
  reason: SubagentExecutionJob['reason'];
}

function now(): string { return new Date().toISOString(); }

function natureSlug(value: string): string {
  const normalized = String(value || 'subagent')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'subagent';
}

function cloneRecord(record: SubagentInstance): SubagentInstance {
  return { ...record, messages: record.messages.map(message => ({ ...message })), metadata: record.metadata ? { ...record.metadata } : undefined };
}

function truncateText(value: string, maxChars: number): string {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const tail = Math.max(0, Math.floor(maxChars * 0.35));
  const head = Math.max(0, maxChars - tail - 24);
  return `${text.slice(0, head)}\n[...truncated...]\n${text.slice(-tail)}`;
}

const sharedManagers = new Map<string, SubagentManager>();

/** Conversation-owned flat peer-agent coordinator with durable FIFO scheduling. */
export class SubagentManager {
  private subs = new Map<string, SubagentInstance>();
  private mailbox: SubagentMessage[] = [];
  private rootInbox: SubagentRootMessage[] = [];
  private pending: PendingJob[] = [];
  private running = new Set<string>();
  private schedulingPaused = false;
  private nextSequence = 1;
  private readonly concurrency: number;
  private executor?: (job: SubagentExecutionJob) => Promise<string>;
  private onChange?: (state: SubagentState) => void;
  private persist?: (state: SubagentState) => void;
  private onMailboxMessage?: (message: SubagentMessage) => boolean;
  private rootInboxListeners = new Set<(message: SubagentRootMessage) => boolean>();
  private onSettled?: (record: SubagentInstance) => void;
  private changedQueued = false;
  private settledWaiters = new Map<string, Array<(record: SubagentInstance | undefined) => void>>();
  public readonly conversationId: string;
  public readonly rootAgentId: string;

  hasRecords(): boolean { return this.subs.size > 0 || this.mailbox.length > 0 || this.rootInbox.length > 0; }

  reset(): void {
    this.subs.clear();
    this.mailbox = [];
    this.rootInbox = [];
    this.pending = [];
    this.running.clear();
    this.settledWaiters.clear();
    this.nextSequence = 1;
    this.schedulingPaused = false;
  }

  constructor(options: SubagentManagerOptions = {}) {
    this.conversationId = String(options.conversationId || 'default');
    this.concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency || 4)));
    this.executor = options.executor;
    this.onChange = options.onChange;
    this.persist = options.persist;
    this.onMailboxMessage = options.onMailboxMessage;
    if (options.onRootInboxMessage) this.rootInboxListeners.add(options.onRootInboxMessage);
    this.onSettled = options.onSettled;
    const state = options.state;
    this.rootAgentId = String(state?.rootAgentId || options.rootAgentId || randomUUID());
    this.nextSequence = Math.max(1, Number(state?.nextSequence || 1));
    this.schedulingPaused = state?.schedulingPaused === true;
    for (const raw of state?.records || []) {
      const record = cloneRecord(raw);
      if (record.status === 'working') record.status = 'queued';
      this.subs.set(record.id, record);
      if (record.status === 'queued') {
        const sequence = Number(record.queueSequence || this.nextSequence++);
        record.queueSequence = sequence;
        this.pending.push({ id: record.id, prompt: record.messages.filter(message => message.role === 'user').at(-1)?.content || record.prompt, flowName: record.flowName || '', sequence, reason: 'resume' });
      }
    }
    this.mailbox = (state?.mailbox || []).map(message => ({ ...message }));
    this.rootInbox = (state?.rootInbox || []).map(message => ({ ...message }));
    for (const record of this.subs.values()) this.queuePersistedUnread(record);
    this.pending.sort((a, b) => a.sequence - b.sequence);
    queueMicrotask(() => this.pump());
  }

  bind(options: Pick<SubagentManagerOptions, 'executor' | 'onChange' | 'persist' | 'onMailboxMessage' | 'onRootInboxMessage' | 'onSettled'>): void {
    if (options.executor) this.executor = options.executor;
    if (options.onChange) this.onChange = options.onChange;
    if (options.persist) this.persist = options.persist;
    if (options.onMailboxMessage) this.onMailboxMessage = options.onMailboxMessage;
    if (options.onRootInboxMessage) {
      const listener = options.onRootInboxMessage;
      const added = !this.rootInboxListeners.has(listener);
      this.rootInboxListeners.add(listener);
      if (added) queueMicrotask(() => this.replayRootInbox(listener));
    }
    if (options.onSettled) this.onSettled = options.onSettled;
    this.pump();
  }

  removeRootInboxListener(listener: (message: SubagentRootMessage) => boolean): void {
    this.rootInboxListeners.delete(listener);
  }

  create(name: string, prompt: string, model?: string, inputMode?: string, agentMode: AgentMode = 'build', createdByAgentId = this.rootAgentId, flowName = '', goalObjective = '', flowPc = 0): string {
    const id = randomUUID();
    const shortId = id.replace(/-/g, '').slice(0, 8);
    const slug = natureSlug(name);
    const displayName = `${slug}-${shortId}`;
    const qualifiedName = `${displayName}--${id}`;
    const stamp = now();
    const record: SubagentInstance = {
      id,
      shortId,
      natureSlug: slug,
      displayName,
      qualifiedName,
      name: qualifiedName,
      conversationId: this.conversationId,
      createdByAgentId,
      prompt,
      model: model || 'default',
      inputMode: inputMode || 'guide',
      agentMode,
      goalObjective: goalObjective || undefined,
      flowName: flowName || undefined,
      flowPc: Math.max(0, Math.floor(Number(flowPc) || 0)),
      status: 'queued',
      messages: [{ role: 'system', content: `Peer agent '${qualifiedName}': ${prompt}` }, { role: 'user', content: prompt }],
      result: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.subs.set(id, record);
    if (this.executor) this.enqueue(record, prompt, flowName, 'spawn');
    else {
      record.status = 'working';
      record.startedAt = stamp;
      this.changed();
    }
    return id;
  }

  get(id: string): SubagentInstance | undefined {
    return this.subs.get(id) || [...this.subs.values()].find(item => item.name === id || item.qualifiedName === id || item.displayName === id || item.shortId === id || item.natureSlug === natureSlug(id));
  }

  send(id: string, prompt: string): boolean {
    const target = this.get(id);
    if (!target || target.status === 'closed') return false;
    target.messages.push({ role: 'user', content: prompt });
    target.error = undefined;
    target.completedAt = undefined;
    target.updatedAt = now();
    if (this.executor) this.enqueue(target, prompt, target.flowName || '', 'mailbox');
    else {
      target.status = 'working';
      this.changed();
    }
    return true;
  }

  sendMessage(fromAgentId: string, toAgentId: string, body: string, kind: SubagentMessageKind = 'directive', details: { correlationId?: string; replyTo?: string } = {}): { ok: boolean; message?: SubagentMessage; error?: string } {
    if (!body.trim()) return { ok: false, error: 'Message body is required.' };
    if (fromAgentId === toAgentId) return { ok: false, error: 'Peer agents cannot message themselves.' };
    const target = this.get(toAgentId);
    if (!target) return { ok: false, error: `Peer agent not found: ${toAgentId}` };
    if (target.status === 'closed') return { ok: false, error: `Peer agent is closed: ${target.qualifiedName}` };
    const message: SubagentMessage = {
      id: randomUUID(),
      conversationId: this.conversationId,
      sequence: this.nextSequence++,
      fromAgentId,
      toAgentId: target.id,
      kind,
      body,
      correlationId: details.correlationId,
      replyTo: details.replyTo,
      createdAt: now(),
    };
    this.mailbox.push(message);
    this.persistNow();
    if (target.status === 'working') {
      this.onMailboxMessage?.({ ...message });
    } else if (target.status !== 'queued') {
      this.enqueueUnreadMailbox(target);
    }
    this.changed();
    return { ok: true, message: { ...message } };
  }

  sendRootMessage(fromAgentId: string, body: string, kind: SubagentMessageKind = 'result'): { ok: boolean; message?: SubagentRootMessage; error?: string } {
    if (!body.trim()) return { ok: false, error: 'Message body is required.' };
    if (fromAgentId === this.rootAgentId) return { ok: false, error: 'Root agent cannot message itself.' };
    const message: SubagentRootMessage = {
      id: randomUUID(),
      conversationId: this.conversationId,
      sequence: this.nextSequence++,
      fromAgentId,
      toAgentId: this.rootAgentId,
      kind,
      body: truncateText(body, 32000),
      createdAt: now(),
    };
    this.rootInbox.push(message);
    this.persistNow();
    this.notifyRootInbox(message);
    this.changed();
    return { ok: true, message: { ...message } };
  }

  readRootInbox(): SubagentRootMessage[] {
    return this.rootInbox
      .filter(message => !message.readAt)
      .sort((a, b) => a.sequence - b.sequence)
      .map(message => ({ ...message }));
  }

  acknowledgeRootInbox(messageId: string): boolean {
    const message = this.rootInbox.find(item => item.id === messageId && !item.readAt);
    if (!message) return false;
    message.readAt = now();
    this.persistNow();
    this.changed();
    return true;
  }

  consumeMailbox(agentId: string): SubagentMessage[] {
    const messages = this.mailbox.filter(message => message.toAgentId === agentId && !message.readAt);
    if (messages.length) this.markMailboxRead(messages);
    return messages.map(message => ({ ...message }));
  }

  acknowledgeMailbox(agentId: string, messageId: string): boolean {
    const message = this.mailbox.find(item => item.id === messageId && item.toAgentId === agentId && !item.readAt);
    if (!message) return false;
    this.markMailboxRead([message]);
    return true;
  }

  waitForSettlement(idOrName: string, timeoutMs = 120000): Promise<SubagentInstance | undefined> {
    const record = this.get(idOrName);
    if (!record || !['queued', 'working'].includes(record.status)) return Promise.resolve(record ? cloneRecord(record) : undefined);
    return new Promise(resolve => {
      const waiters = this.settledWaiters.get(record.id) || [];
      let done = false;
      const finish = (value: SubagentInstance | undefined) => {
        if (done) return;
        done = true;
        resolve(value ? cloneRecord(value) : undefined);
      };
      waiters.push(finish);
      this.settledWaiters.set(record.id, waiters);
      setTimeout(() => finish(this.get(record.id)), Math.max(100, timeoutMs));
    });
  }

  read(readerAgentId: string, idOrName: string, maxChars = 16000): { ok: boolean; snapshot?: SubagentReadSnapshot; error?: string } {
    const record = this.get(idOrName);
    if (!record) return { ok: false, error: `Peer agent not found: ${idOrName}` };
    const limit = Math.max(2000, Math.min(32000, Math.floor(Number(maxChars || 16000))));
    const queue = this.pending.slice().sort((a, b) => a.sequence - b.sequence);
    const queueIndex = queue.findIndex(job => job.id === record.id);
    const allMailbox = this.mailbox.filter(message => message.toAgentId === record.id || message.fromAgentId === record.id);
    const visibleMailbox = allMailbox.slice(-20).map(message => ({
      id: message.id,
      sequence: message.sequence,
      fromAgentId: message.fromAgentId,
      toAgentId: message.toAgentId,
      kind: message.kind,
      body: truncateText(message.body, 2000),
      createdAt: message.createdAt,
      readAt: message.readAt,
    }));
    const feedback: Array<{ role: string; content: string }> = [];
    let used = 0;
    let truncated = false;
    for (const message of record.messages.slice().reverse()) {
      const content = truncateText(message.content, 8000);
      const cost = content.length + message.role.length + 16;
      if (used + cost > limit) { truncated = true; break; }
      feedback.unshift({ role: message.role, content });
      used += cost;
    }
    const result = record.result ? truncateText(record.result, Math.max(2000, Math.floor(limit / 2))) : null;
    if (record.result && result !== record.result) truncated = true;
    return {
      ok: true,
      snapshot: {
        conversationId: this.conversationId,
        readerAgentId,
        peer: {
          id: record.id,
          shortId: record.shortId,
          natureSlug: record.natureSlug,
          displayName: record.displayName,
          qualifiedName: record.qualifiedName,
          createdByAgentId: record.createdByAgentId,
          status: record.status,
          active: record.status !== 'closed',
          queueSequence: record.queueSequence,
          queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined,
          model: record.model,
          mode: record.agentMode,
          inputMode: record.inputMode,
          prompt: truncateText(record.prompt, 4000),
          result,
          error: record.error ? truncateText(record.error, 4000) : undefined,
          createdAt: record.createdAt,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
          completedAt: record.completedAt,
          closedAt: record.closedAt,
          contextCompression: record.metadata?.contextCompression,
        },
        feedback,
        mailbox: {
          inbound: allMailbox.filter(message => message.toAgentId === record.id).length,
          outbound: allMailbox.filter(message => message.fromAgentId === record.id).length,
          unread: allMailbox.filter(message => message.toAgentId === record.id && !message.readAt).length,
          latest: visibleMailbox,
        },
        truncated,
      },
    };
  }

  appendAssistant(id: string, content: string): void {
    const record = this.get(id);
    if (record) record.messages.push({ role: 'assistant', content });
  }

  replaceContext(id: string, history: Array<Record<string, unknown>>, compression: SubagentCompressionState | null): void {
    const record = this.get(id);
    if (!record) return;
    record.messages = history.map(message => ({
      role: String(message.role || 'system'),
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
    }));
    record.metadata = {
      ...(record.metadata || {}),
      contextCompression: compression ? { ...compression } : null,
    };
    record.updatedAt = now();
    this.changed();
  }

  complete(id: string, result: string): void {
    const record = this.get(id);
    if (!record || record.status === 'closed') return;
    record.result = result;
    record.status = 'completed';
    record.error = undefined;
    record.completedAt = now();
    record.updatedAt = record.completedAt;
    record.messages.push({ role: 'assistant', content: result });
    this.changed();
    this.enqueueUnreadMailbox(record);
    this.resolveSettledWaiters(record);
    this.onSettled?.(cloneRecord(record));
  }

  fail(id: string, error: string): void {
    const record = this.get(id);
    if (!record || record.status === 'closed') return;
    record.result = `[Subagent Error] ${error}`;
    record.status = 'error';
    record.error = error;
    record.completedAt = now();
    record.updatedAt = record.completedAt;
    record.messages.push({ role: 'assistant', content: record.result });
    this.changed();
    this.enqueueUnreadMailbox(record);
    this.resolveSettledWaiters(record);
    this.onSettled?.(cloneRecord(record));
  }

  markWorking(id: string): void {
    const record = this.get(id);
    if (!record || record.status === 'closed') return;
    record.status = 'working';
    record.startedAt = record.startedAt || now();
    record.updatedAt = now();
    record.error = undefined;
    this.changed();
  }

  close(id: string, actorId = this.rootAgentId): boolean {
    const record = this.get(id);
    if (!record) return false;
    if (actorId !== this.rootAgentId && actorId !== record.id) return false;
    record.status = 'closed';
    record.closedAt = now();
    record.updatedAt = record.closedAt;
    this.pending = this.pending.filter(job => job.id !== record.id);
    this.changed();
    this.resolveSettledWaiters(record);
    return true;
  }

  toRecord(idOrName: string): NewmarkSubagentRecord | undefined {
    const record = this.get(idOrName);
    if (!record) return undefined;
    const messages = this.mailbox.filter(message => message.toAgentId === record.id);
    return {
      ...cloneRecord(record),
      active: record.status !== 'closed',
      mode: record.agentMode,
      mailbox: { total: messages.length, unread: messages.filter(message => !message.readAt).length },
    };
  }

  toToolResult(idOrName: string, output: string, ok = true): NewmarkSubagentToolResult {
    return { ok, output, data: this.toRecord(idOrName), error: ok ? undefined : output, metadata: { kind: 'subagent' } };
  }

  getResult(name: string): string {
    const record = this.get(name);
    if (!record) return '';
    return record.result || record.messages.filter(message => message.role === 'assistant').map(message => message.content).join('\n');
  }

  listActive(): SubagentInstance[] { return this.listAll().filter(item => item.status !== 'closed'); }
  listAll(): SubagentInstance[] { return [...this.subs.values()].map(cloneRecord); }

  pauseScheduling(): void {
    if (this.schedulingPaused) return;
    this.schedulingPaused = true;
    this.persistNow();
    this.changed();
  }

  resumeScheduling(): void {
    if (!this.schedulingPaused) return;
    this.schedulingPaused = false;
    this.persistNow();
    this.changed();
    this.pump();
  }

  isSchedulingPaused(): boolean { return this.schedulingPaused; }

  remove(id: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    this.pending = this.pending.filter(job => job.id !== record.id);
    this.mailbox = this.mailbox.filter(message => message.toAgentId !== record.id && message.fromAgentId !== record.id);
    const removed = this.subs.delete(record.id);
    if (removed) this.changed();
    return removed;
  }

  serialize(): SubagentState {
    return {
      version: 2,
      rootAgentId: this.rootAgentId,
      nextSequence: this.nextSequence,
      schedulingPaused: this.schedulingPaused,
      records: this.listAll().map(record => record.status === 'working' ? { ...record, status: 'queued' as const } : record),
      mailbox: this.mailbox.map(message => ({ ...message })),
      rootInbox: this.rootInbox.map(message => ({ ...message })),
    };
  }

  private enqueue(record: SubagentInstance, prompt: string, flowName: string, reason: PendingJob['reason']): void {
    const sequence = this.nextSequence++;
    record.status = 'queued';
    record.queueSequence = sequence;
    record.updatedAt = now();
    this.pending.push({ id: record.id, prompt, flowName, sequence, reason });
    this.pending.sort((a, b) => a.sequence - b.sequence);
    this.changed();
    this.pump();
  }

  private unreadMailbox(agentId: string): SubagentMessage[] {
    return this.mailbox
      .filter(message => message.toAgentId === agentId && !message.readAt)
      .sort((a, b) => a.sequence - b.sequence);
  }

  private queuePersistedUnread(record: SubagentInstance): void {
    if (record.status === 'closed') return;
    const unread = this.unreadMailbox(record.id);
    if (!unread.length) return;
    if (record.status === 'queued') {
      const existing = this.pending.find(job => job.id === record.id);
      if (existing) {
        existing.prompt = `${existing.prompt}\n\n${this.mailboxPrompt(unread)}`;
      }
      return;
    }
    record.status = 'queued';
    const sequence = Number(record.queueSequence || unread[0].sequence || this.nextSequence++);
    record.queueSequence = sequence;
    this.pending.push({ id: record.id, prompt: this.mailboxPrompt(unread), flowName: record.flowName || '', sequence, reason: 'mailbox' });
  }

  private enqueueUnreadMailbox(record: SubagentInstance): void {
    if (record.status === 'closed' || record.status === 'queued' || this.running.has(record.id)) return;
    const unread = this.unreadMailbox(record.id);
    if (!unread.length) return;
    this.enqueue(record, this.mailboxPrompt(unread), record.flowName || '', 'mailbox');
  }

  private markMailboxRead(messages: SubagentMessage[]): void {
    const stamp = now();
    for (const message of messages) {
      const stored = this.mailbox.find(item => item.id === message.id);
      if (stored && !stored.readAt) stored.readAt = stamp;
    }
    this.persistNow();
    this.changed();
  }

  private persistNow(): void {
    this.persist?.(this.serialize());
  }

  private notifyRootInbox(message: SubagentRootMessage): boolean {
    for (const listener of this.rootInboxListeners) {
      try {
        if (listener({ ...message })) return true;
      } catch { /* ignore listener errors */ }
    }
    return false;
  }

  private replayRootInbox(listener: (message: SubagentRootMessage) => boolean): void {
    for (const message of this.readRootInbox()) {
      try { listener({ ...message }); } catch { /* ignore listener errors */ }
    }
  }

  private resolveSettledWaiters(record: SubagentInstance): void {
    const waiters = this.settledWaiters.get(record.id) || [];
    this.settledWaiters.delete(record.id);
    for (const resolve of waiters) resolve(record);
  }

  private pump(): void {
    if (!this.executor || this.schedulingPaused) return;
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      const record = this.subs.get(job.id);
      if (!record || record.status === 'closed') continue;
      const unread = this.consumeMailbox(record.id);
      const prompt = unread.length ? `${job.prompt}\n\n${this.mailboxPrompt(unread)}` : job.prompt;
      record.status = 'working';
      record.queueSequence = undefined;
      record.startedAt = record.startedAt || now();
      record.updatedAt = now();
      this.running.add(record.id);
      this.changed();
      void this.executor({ record: cloneRecord(record), prompt, flowName: job.flowName, reason: job.reason })
        .then(result => {
          this.complete(record.id, result || '[Subagent] Completed with empty response.');
          this.running.delete(record.id);
          this.enqueueUnreadMailbox(record);
          this.pump();
        })
        .catch(error => {
          this.fail(record.id, error instanceof Error ? error.message : String(error));
          this.running.delete(record.id);
          this.enqueueUnreadMailbox(record);
          this.pump();
        });
    }
  }

  private mailboxPrompt(messages: SubagentMessage[]): string {
    return `[Peer mailbox]\n${messages.map(message => `- ${message.kind} from ${message.fromAgentId}: ${message.body}`).join('\n')}`;
  }

  private changed(): void {
    if (!this.onChange || this.changedQueued) return;
    this.changedQueued = true;
    queueMicrotask(() => {
      this.changedQueued = false;
      this.onChange?.(this.serialize());
    });
  }
}

export function sharedSubagentManager(key: string, options: SubagentManagerOptions): SubagentManager {
  const existing = sharedManagers.get(key);
  if (existing) {
    if (options.state && !existing.hasRecords() && (options.state.records.length > 0 || options.state.mailbox.length > 0 || (options.state.rootInbox || []).length > 0)) {
      const hydrated = new SubagentManager(options);
      sharedManagers.set(key, hydrated);
      return hydrated;
    }
    existing.bind(options);
    return existing;
  }
  const created = new SubagentManager(options);
  sharedManagers.set(key, created);
  return created;
}

export function releaseSharedSubagentManager(key: string): void {
  sharedManagers.delete(key);
}
