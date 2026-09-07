import { randomUUID } from 'crypto';
import { NewmarkToolResult } from './compat';
import type { AgentMode } from './types';

export type SubagentStatus = 'idle' | 'queued' | 'working' | 'completed' | 'closed' | 'error';
export type SubagentMessageKind = 'directive' | 'question' | 'result' | 'handoff';
export const SUBAGENT_RECOVERY_PROMPT = '[Peer runtime recovery] Continue the unfinished work from the persisted working history. Preserve completed tool results and follow the latest instruction; do not repeat completed work.';

export interface SubagentMessage {
  id: string;
  conversationId: string;
  sequence: number;
  fromAgentId: string;
  toAgentId: string;
  kind: SubagentMessageKind;
  body: string;
  wakeup: boolean;
  /** A message accepted by an existing job must survive that job settling. */
  acceptedWhileActive: boolean;
  /** Runtime-consumed control messages never become model continuation input. */
  control?: { action: 'stop'; runId: string; force: boolean };
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
  wakeup: boolean;
  createdAt: string;
  readAt?: string;
  /** Only runtime-generated completion notices carry this provenance. */
  source?: 'automatic-settlement';
  settlementRevision?: number;
}

export interface SubagentSettlementReceipt {
  peerId: string;
  revision: number;
}

export interface SubagentMessageRecord {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  hidden_user_input?: boolean;
  goal_continuation?: boolean;
  client_message_id?: string;
  run_id?: string;
  vision_image_path?: string;
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
  /** Root Build Block that created this peer. Empty only for legacy/direct API records. */
  buildRunId?: string;
  /** Intelligence tier captured at creation so the enforced 4/16 ceiling is auditable. */
  intelligenceTier?: string;
  prompt: string;
  model: string;
  inputMode: string;
  agentMode: AgentMode;
  goalObjective?: string;
  flowName?: string;
  flowPc?: number;
  status: SubagentStatus;
  queueSequence?: number;
  messages: Array<SubagentMessageRecord>;
  result: string | null;
  /** Monotonic per-peer result version, independent of timestamps/content. */
  settlementRevision?: number;
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
  /** Exact queued/in-flight inputs survive a restart between mailbox dispatch and child transcript persistence. */
  jobs?: PendingJob[];
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
    name: string;
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
    latest: Array<Pick<SubagentMessage, 'id' | 'sequence' | 'fromAgentId' | 'toAgentId' | 'kind' | 'body' | 'wakeup' | 'acceptedWhileActive' | 'createdAt' | 'readAt'>>;
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
  inputCommitted?: boolean;
}

function now(): string { return new Date().toISOString(); }

function cloneMailboxMessage(message: SubagentMessage): SubagentMessage {
  return { ...message, ...(message.control ? { control: { ...message.control } } : {}) };
}

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
  return {
    ...record,
    messages: record.messages.map(message => ({
      ...message,
      tool_calls: message.tool_calls?.map(call => ({ ...call, function: { ...call.function } })),
    })),
    metadata: record.metadata ? structuredClone(record.metadata) : undefined,
  };
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
  private activeJobs = new Map<string, PendingJob>();
  private schedulingPaused = false;
  private nextSequence = 1;
  private concurrency: number;
  private executor?: (job: SubagentExecutionJob) => Promise<string>;
  private onChange?: (state: SubagentState) => void;
  private persist?: (state: SubagentState) => void;
  private onMailboxMessage?: (message: SubagentMessage) => boolean;
  private rootInboxListeners = new Set<(message: SubagentRootMessage) => boolean>();
  private bindingOwner?: (message: SubagentRootMessage) => boolean;
  private ownerBindings = new Map<(message: SubagentRootMessage) => boolean, Pick<SubagentManagerOptions, 'executor' | 'onChange' | 'persist' | 'onMailboxMessage' | 'onSettled'>>();
  private onSettled?: (record: SubagentInstance) => void;
  private changedQueued = false;
  private settledWaiters = new Map<string, Array<(record: SubagentInstance | undefined) => void>>();
  public readonly conversationId: string;
  public readonly rootAgentId: string;

  hasRecords(): boolean { return this.subs.size > 0 || this.mailbox.length > 0 || this.rootInbox.length > 0; }

  hasPendingWork(): boolean {
    return this.running.size > 0 || this.pending.length > 0
      || Array.from(this.subs.values()).some(record => record.status === 'queued' || record.status === 'working');
  }

  reset(): void {
    this.subs.clear();
    this.mailbox = [];
    this.rootInbox = [];
    this.pending = [];
    this.running.clear();
    this.activeJobs.clear();
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
    if (options.onRootInboxMessage) {
      this.rootInboxListeners.add(options.onRootInboxMessage);
      this.bindingOwner = options.onRootInboxMessage;
    }
    this.onSettled = options.onSettled;
    this.rememberOwnerBinding();
    const state = options.state;
    this.rootAgentId = String(state?.rootAgentId || options.rootAgentId || randomUUID());
    this.nextSequence = Math.max(1, Number(state?.nextSequence || 1));
    this.schedulingPaused = state?.schedulingPaused === true;
    const savedJobs = new Map((state?.jobs || []).map(job => [job.id, job]));
    for (const raw of state?.records || []) {
      const record = cloneRecord(raw);
      record.messages = record.messages.map(message => message.role === 'user'
        ? { ...message, hidden_user_input: true }
        : message);
      if (record.status === 'working') record.status = 'queued';
      this.subs.set(record.id, record);
      if (record.status === 'queued') {
        const savedJob = savedJobs.get(record.id);
        const sequence = Number(savedJob?.sequence || record.queueSequence || this.nextSequence++);
        this.nextSequence = Math.max(this.nextSequence, sequence + 1);
        record.queueSequence = sequence;
        this.pending.push(savedJob
          ? { ...savedJob, sequence }
          : { id: record.id, prompt: record.messages.filter(message => message.role === 'user').at(-1)?.content || record.prompt, flowName: record.flowName || '', sequence, reason: 'resume' });
      }
    }
    // Historical messages always woke their recipient. Migrate only an absent
    // field; an explicitly stored false must remain passive after a restart.
    this.mailbox = (state?.mailbox || []).map(message => ({ ...cloneMailboxMessage(message),
      wakeup: message.wakeup === undefined ? true : message.wakeup === true,
      acceptedWhileActive: message.acceptedWhileActive === true,
    }));
    this.rootInbox = (state?.rootInbox || []).map(message => ({ ...message,
      wakeup: message.wakeup === undefined ? true : message.wakeup === true,
    }));
    for (const record of this.subs.values()) this.queuePersistedUnread(record);
    this.pending.sort((a, b) => a.sequence - b.sequence);
    queueMicrotask(() => this.pump());
  }

  bind(options: Pick<SubagentManagerOptions, 'concurrency' | 'executor' | 'onChange' | 'persist' | 'onMailboxMessage' | 'onRootInboxMessage' | 'onSettled'>): void {
    if (options.concurrency !== undefined) this.setConcurrencyLimit(options.concurrency);
    if (options.onRootInboxMessage) {
      const listener = options.onRootInboxMessage;
      const previous = this.ownerBindings.get(listener);
      const binding = {
        executor: options.executor || previous?.executor,
        onChange: options.onChange || previous?.onChange,
        persist: options.persist || previous?.persist,
        onMailboxMessage: options.onMailboxMessage || previous?.onMailboxMessage,
        onSettled: options.onSettled || previous?.onSettled,
      };
      this.ownerBindings.delete(listener);
      this.ownerBindings.set(listener, binding);
      // A snapshot/foreground facade must not steal jobs or their settlement
      // callbacks from the owner that is currently executing the queue.
      if (!this.bindingOwner || this.bindingOwner === listener || !this.hasPendingWork()) {
        this.bindingOwner = listener;
        Object.assign(this, binding);
      }
      const added = !this.rootInboxListeners.has(listener);
      this.rootInboxListeners.add(listener);
      if (added) queueMicrotask(() => this.replayRootInbox(listener));
    } else {
      if (options.executor) this.executor = options.executor;
      if (options.onChange) this.onChange = options.onChange;
      if (options.persist) this.persist = options.persist;
      if (options.onMailboxMessage) this.onMailboxMessage = options.onMailboxMessage;
      if (options.onSettled) this.onSettled = options.onSettled;
      this.rememberOwnerBinding();
    }
    this.pump();
  }

  ownsExecutionBinding(listener: (message: SubagentRootMessage) => boolean): boolean {
    return this.bindingOwner === listener;
  }

  private rememberOwnerBinding(): void {
    if (!this.bindingOwner) return;
    this.ownerBindings.delete(this.bindingOwner);
    this.ownerBindings.set(this.bindingOwner, {
      executor: this.executor, onChange: this.onChange, persist: this.persist,
      onMailboxMessage: this.onMailboxMessage, onSettled: this.onSettled,
    });
  }

  removeRootInboxListener(listener: (message: SubagentRootMessage) => boolean): void {
    this.rootInboxListeners.delete(listener);
  }

  /** Detach one facade without clearing a newer owner's callbacks or live jobs. */
  releaseOwnerBinding(listener: (message: SubagentRootMessage) => boolean): boolean {
    if (this.bindingOwner === listener && this.hasPendingWork()) return false;
    this.rootInboxListeners.delete(listener);
    this.ownerBindings.delete(listener);
    if (this.bindingOwner !== listener) return true;
    // A temporary facade may have rebound this shared manager while another
    // idle facade remained usable. Restore that owner instead of stranding
    // its next peer in the durable queue with no executor.
    const previous = Array.from(this.ownerBindings.entries()).at(-1);
    this.bindingOwner = previous?.[0];
    this.executor = previous?.[1].executor;
    this.onChange = previous?.[1].onChange;
    this.persist = previous?.[1].persist;
    this.onMailboxMessage = previous?.[1].onMailboxMessage;
    this.onSettled = previous?.[1].onSettled;
    return true;
  }

  create(name: string, prompt: string, model?: string, inputMode?: string, agentMode: AgentMode = 'build', createdByAgentId = this.rootAgentId, flowName = '', goalObjective = '', flowPc = 0, buildRunId = '', intelligenceTier = ''): string {
    const id = randomUUID();
    const shortId = id.replace(/-/g, '').slice(0, 8);
    const slug = natureSlug(name);
    // The monitoring label is exactly the caller-created human-readable name.
    // UUID-bearing identity stays in id/qualifiedName and is never appended to
    // the right-sidebar title.
    const createdName = String(name || 'SubAgent').replace(/\s+/g, ' ').trim().slice(0, 160) || 'SubAgent';
    const displayName = createdName;
    const qualifiedName = `${slug}--${id}`;
    const stamp = now();
    const record: SubagentInstance = {
      id,
      shortId,
      natureSlug: slug,
      displayName,
      qualifiedName,
      name: createdName,
      conversationId: this.conversationId,
      createdByAgentId,
      buildRunId: String(buildRunId || '').trim() || undefined,
      intelligenceTier: String(intelligenceTier || '').trim() || undefined,
      prompt,
      model: model || 'default',
      inputMode: inputMode || 'guide',
      agentMode,
      goalObjective: goalObjective || undefined,
      flowName: flowName || undefined,
      flowPc: Math.max(0, Math.floor(Number(flowPc) || 0)),
      status: 'queued',
       messages: [{ role: 'system', content: `Peer agent '${slug}' (${id}): ${prompt}` }, { role: 'user', content: prompt, hidden_user_input: true }],
      result: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.subs.set(id, record);
    // Runtimes may hydrate before their executor is bound. Always persist the
    // job in the durable FIFO; pump() starts it now or after a later bind().
    // A "working" record without an executor is a silently lost SubAgent.
    this.enqueue(record, prompt, flowName, 'spawn');
    return id;
  }

  get(id: string): SubagentInstance | undefined {
    if (this.subs.has(id)) return this.subs.get(id);
    const exact = [...this.subs.values()].find(item => item.id === id || item.qualifiedName === id);
    if (exact) return exact;
    // name is now caller-supplied and not identity-bearing, so it is a
    // convenience lookup only; the id/shortId/displayName paths stay exact.
    return [...this.subs.values()].find(item => item.name === id || item.displayName === id || item.shortId === id || item.natureSlug === natureSlug(id));
  }

  send(id: string, prompt: string, wakeup = false): boolean {
    // The compatibility entry point shares the durable mailbox and its
    // single-executor guarantee; a direct enqueue could overlap this peer.
    return this.sendMessage(this.rootAgentId, id, prompt, 'directive', {}, wakeup).ok;
  }

  broadcastStop(fromAgentId: string, runId: string, force = false): { count: number; ids: string[]; peerIds: string[] } {
    // Set the gate before publishing any control receipt, and commit the gate
    // plus the entire batch once. No per-message callback can dispatch work.
    const wasPaused = this.schedulingPaused;
    this.schedulingPaused = true;
    const ids: string[] = [];
    const peerIds: string[] = [];
    const stamp = now();
    const stopRunId = String(runId || '');
    const alreadySent = new Set(this.mailbox.filter(message => message.control?.action === 'stop'
      && message.control.runId === stopRunId && message.control.force === (force === true)).map(message => message.toAgentId));
    for (const record of this.subs.values()) {
      if (record.status === 'closed' || alreadySent.has(record.id)) continue;
      const message: SubagentMessage = {
        id: randomUUID(), conversationId: this.conversationId, sequence: this.nextSequence++,
        fromAgentId, toAgentId: record.id, kind: 'directive',
        body: force ? '[Runtime control] Force stop this conversation work.' : '[Runtime control] Stop this conversation work.',
        wakeup: false, acceptedWhileActive: false,
        control: { action: 'stop', runId: stopRunId, force: force === true },
        createdAt: stamp, readAt: stamp,
      };
      this.mailbox.push(message);
      ids.push(message.id);
      peerIds.push(record.id);
    }
    if (!wasPaused || ids.length) { this.persistNow(); this.changed(); }
    return { count: ids.length, ids, peerIds };
  }

  sendMessage(fromAgentId: string, toAgentId: string, body: string, kind: SubagentMessageKind = 'directive', details: { correlationId?: string; replyTo?: string } = {}, wakeup = false): { ok: boolean; message?: SubagentMessage; error?: string } {
    if (!body.trim()) return { ok: false, error: 'Message body is required.' };
    if (fromAgentId === toAgentId) return { ok: false, error: 'Peer agents cannot message themselves.' };
    const target = this.get(toAgentId);
    if (!target) return { ok: false, error: `Peer agent not found: ${toAgentId}` };
    if (fromAgentId === target.id) return { ok: false, error: 'Peer agents cannot message themselves.' };
    if (target.status === 'closed') return { ok: false, error: `Peer agent is closed: ${target.qualifiedName}` };
    const message: SubagentMessage = {
      id: randomUUID(),
      conversationId: this.conversationId,
      sequence: this.nextSequence++,
      fromAgentId,
      toAgentId: target.id,
      kind,
      body: truncateText(body, 32000),
      wakeup: wakeup === true,
      acceptedWhileActive: target.status === 'working' || target.status === 'queued',
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

  sendRootMessage(fromAgentId: string, body: string, kind: SubagentMessageKind = 'result', settlementRevision?: number, wakeup = false): { ok: boolean; message?: SubagentRootMessage; error?: string } {
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
      wakeup: wakeup === true,
      createdAt: now(),
      ...(kind === 'result' && Number.isSafeInteger(settlementRevision) && Number(settlementRevision) > 0
        ? { source: 'automatic-settlement' as const, settlementRevision }
        : {}),
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

  acknowledgeSettlementResults(receipts: SubagentSettlementReceipt[]): string[] {
    const observed = new Set(receipts.filter(receipt => typeof receipt.peerId === 'string'
      && Number.isSafeInteger(receipt.revision) && receipt.revision > 0)
      .map(receipt => `${receipt.peerId}:${receipt.revision}`));
    const ids: string[] = [];
    const stamp = now();
    let changed = false;
    for (const message of this.rootInbox) {
      if (message.source !== 'automatic-settlement' || message.kind !== 'result'
        || !observed.has(`${message.fromAgentId}:${message.settlementRevision}`)) continue;
      // Include previously acknowledged IDs so cold-restored continuation
      // copies can be retired without changing already-consumed history.
      ids.push(message.id);
      if (!message.readAt) { message.readAt = stamp; changed = true; }
    }
    if (changed) { this.persistNow(); this.changed(); }
    return ids;
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
    return messages.map(cloneMailboxMessage);
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: SubagentInstance | undefined) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(value ? cloneRecord(value) : undefined);
      };
      waiters.push(finish);
      this.settledWaiters.set(record.id, waiters);
      timer = setTimeout(() => {
        const current = this.settledWaiters.get(record.id) || [];
        const remaining = current.filter(waiter => waiter !== finish);
        if (remaining.length) this.settledWaiters.set(record.id, remaining);
        else this.settledWaiters.delete(record.id);
        finish(this.get(record.id));
      }, Math.max(100, timeoutMs));
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
      wakeup: message.wakeup,
      acceptedWhileActive: message.acceptedWhileActive,
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
          name: record.name,
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

  replaceContext(id: string, history: Array<Record<string, unknown>>, compression: SubagentCompressionState | null, inputCommitted = false): void {
    const record = this.get(id);
    if (!record) return;
    record.messages = history.map(message => {
      const stored: SubagentMessageRecord = {
        role: String(message.role || 'system'),
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      };
      // Preserve the metadata the kernel needs to rebuild assistant tool calls
      // and tool-result turns, so a continued peer resumes the same working
      // context instead of replaying from a bare prompt or summary.
      if (message.tool_call_id) stored.tool_call_id = String(message.tool_call_id);
      if (message.name) stored.name = String(message.name);
      if (Array.isArray(message.tool_calls)) stored.tool_calls = structuredClone(message.tool_calls) as SubagentMessageRecord['tool_calls'];
      if (message.hidden_user_input) stored.hidden_user_input = true;
      if (message.goal_continuation) stored.goal_continuation = true;
      if (message.client_message_id) stored.client_message_id = String(message.client_message_id);
      if (message.run_id) stored.run_id = String(message.run_id);
      if (message.vision_image_path) stored.vision_image_path = String(message.vision_image_path);
      return stored;
    });
    record.metadata = {
      ...(record.metadata || {}),
      contextCompression: compression ? { ...compression } : null,
    };
    record.updatedAt = now();
    const activeJob = this.activeJobs.get(record.id);
    if (activeJob && inputCommitted) activeJob.inputCommitted = true;
    this.persistNow();
    this.changed();
  }

  patchMetadata(id: string, patch: Record<string, unknown>): void {
    const record = this.get(id);
    if (!record) return;
    record.metadata = { ...(record.metadata || {}), ...structuredClone(patch) };
    record.updatedAt = now();
    this.persistNow();
    this.changed();
  }

  complete(id: string, result: string): void {
    const record = this.get(id);
    if (!record || record.status === 'closed') return;
    this.pending = this.pending.filter(job => job.id !== record.id);
    record.result = result;
    record.settlementRevision = Math.max(0, Math.floor(Number(record.settlementRevision) || 0)) + 1;
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
    this.pending = this.pending.filter(job => job.id !== record.id);
    record.result = `[Subagent Error] ${error}`;
    record.settlementRevision = Math.max(0, Math.floor(Number(record.settlementRevision) || 0)) + 1;
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

  /**
   * 有界结果 transcript：subagent_result 注入主 Agent 上下文时，不再放大完整
   * 消息历史（含所有中间 tool call/result 洪水）。只保留最近若干条非 tool 消息，
   * 按字符上限截断，杜绝上下文回归。完整历史按需走 subagent_read(max_chars)。
   */
  boundedResultTranscript(idOrName: string): string {
    const record = this.get(idOrName);
    if (!record) return '';
    const MAX_MSG = 8;           // 最近保留的消息条数
    const MAX_CHARS = 8000;      // 总字符上限
    const messages = record.messages
      .filter(message => message.role === 'assistant' || message.role === 'user' || message.role === 'system')
      .slice(-MAX_MSG)
      .map(message => `[${message.role}] ${truncateText(String(message.content || ''), 1200)}`);
    let text = messages.join('\n');
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + `\n[...transcript truncated: ${record.messages.length} total messages, ${record.messages.length - MAX_MSG} older omitted; use subagent_read for full history...]`;
    }
    return text || '(no transcript)';
  }

  listActive(): SubagentInstance[] { return this.listAll().filter(item => item.status !== 'closed'); }
  listAll(): SubagentInstance[] { return [...this.subs.values()].map(cloneRecord); }

  /** Model-facing list: detailed transcripts and request cache remain private. */
  listSummaries(status = '') {
    const counts = new Map<string, { total: number; unread: number }>();
    for (const message of this.mailbox) {
      const count = counts.get(message.toAgentId) || { total: 0, unread: 0 };
      count.total++;
      if (!message.readAt) count.unread++;
      counts.set(message.toAgentId, count);
    }
    return [...this.subs.values()].filter(record => !status || record.status === status).map(record => ({
      id: record.id, shortId: record.shortId, natureSlug: record.natureSlug,
      displayName: record.displayName, qualifiedName: record.qualifiedName, name: record.name,
      conversationId: record.conversationId, createdByAgentId: record.createdByAgentId,
      buildRunId: record.buildRunId, intelligenceTier: record.intelligenceTier,
      prompt: truncateText(record.prompt, 1200), model: record.model, inputMode: record.inputMode,
      agentMode: record.agentMode, mode: record.agentMode, status: record.status, active: record.status !== 'closed',
      goalObjective: record.goalObjective ? truncateText(record.goalObjective, 800) : undefined,
      flowName: record.flowName, flowPc: record.flowPc, queueSequence: record.queueSequence,
      resultAvailable: record.result !== null, resultChars: record.result?.length || 0,
      settlementRevision: record.settlementRevision, messageCount: record.messages.length,
      error: record.error ? truncateText(record.error, 512) : undefined,
      createdAt: record.createdAt, startedAt: record.startedAt, updatedAt: record.updatedAt,
      completedAt: record.completedAt, closedAt: record.closedAt,
      mailbox: counts.get(record.id) || { total: 0, unread: 0 },
    }));
  }

  activeCountForBuild(buildRunId: string): number {
    const target = String(buildRunId || '').trim();
    if (!target) return 0;
    return [...this.subs.values()].filter(record =>
      record.buildRunId === target && (record.status === 'queued' || record.status === 'working'),
    ).length;
  }

  setConcurrencyLimit(value: number): void {
    this.concurrency = Math.max(1, Math.min(16, Math.floor(Number(value) || 4)));
    this.pump();
  }

  concurrencyLimit(): number { return this.concurrency; }

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
      jobs: [
        ...Array.from(this.activeJobs.values(), job => ({
          ...job, reason: 'resume' as const, inputCommitted: false,
          prompt: job.inputCommitted
            ? SUBAGENT_RECOVERY_PROMPT
            : job.prompt,
        })),
        ...this.pending.map(job => ({ ...job })),
      ].sort((a, b) => a.sequence - b.sequence),
      records: this.listAll().map(record => record.status === 'working' ? { ...record, status: 'queued' as const } : record),
      mailbox: this.mailbox.map(cloneMailboxMessage),
      rootInbox: this.rootInbox.map(message => ({ ...message })),
    };
  }

  private enqueue(record: SubagentInstance, prompt: string, flowName: string, reason: PendingJob['reason']): void {
    const existing = this.pending.find(job => job.id === record.id);
    if (existing) {
      if (prompt && !existing.prompt.includes(prompt)) existing.prompt = `${existing.prompt}\n\n${prompt}`;
      record.status = 'queued';
      record.updatedAt = now();
      this.persistNow();
      this.changed();
      this.pump();
      return;
    }
    const sequence = this.nextSequence++;
    record.status = 'queued';
    record.queueSequence = sequence;
    record.updatedAt = now();
    this.pending.push({ id: record.id, prompt, flowName, sequence, reason });
    this.pending.sort((a, b) => a.sequence - b.sequence);
    this.persistNow();
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
    const activating = unread.find(message => message.wakeup || message.acceptedWhileActive);
    if (!activating) return;
    if (record.status === 'queued') {
      const existing = this.pending.find(job => job.id === record.id);
      // The queued job consumes every unread mailbox item in pump(). Keeping
      // the messages unread here is intentional: pre-appending them would
      // deliver the same restored directive twice when pump() consumes them.
      if (existing) return;
      return;
    }
    record.status = 'queued';
    const sequence = Number(record.queueSequence || activating.sequence || this.nextSequence++);
    record.queueSequence = sequence;
    this.pending.push({ id: record.id, prompt: '', flowName: record.flowName || '', sequence, reason: 'mailbox' });
  }

  private enqueueUnreadMailbox(record: SubagentInstance): void {
    if (record.status === 'closed' || record.status === 'queued' || this.running.has(record.id)) return;
    const unread = this.unreadMailbox(record.id);
    if (!unread.some(message => message.wakeup || message.acceptedWhileActive)) return;
    // Store the mailbox once. pump() builds the current batch at dispatch so
    // later arrivals coalesce without duplicating the initial wake message.
    this.enqueue(record, '', record.flowName || '', 'mailbox');
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
      const unread = this.unreadMailbox(record.id);
      const prompt = [job.prompt, unread.length ? this.mailboxPrompt(unread) : ''].filter(Boolean).join('\n\n');
      record.status = 'working';
      record.queueSequence = undefined;
      record.startedAt = record.startedAt || now();
      record.updatedAt = now();
      this.running.add(record.id);
      const activeJob = { ...job, prompt };
      this.activeJobs.set(record.id, activeJob);
      // A read receipt must never reach disk without the precise dispatched
      // input. Cold restore can now recover a job even before child startup.
      if (unread.length) this.markMailboxRead(unread);
      else this.persistNow();
      this.changed();
      let execution: Promise<string>;
      try {
        execution = Promise.resolve(this.executor({ record: cloneRecord(record), prompt, flowName: job.flowName, reason: job.reason }));
      } catch (error) {
        execution = Promise.reject(error);
      }
      void execution
        .then(result => {
          if (this.activeJobs.get(record.id) !== activeJob) return;
          this.complete(record.id, result || '[Subagent] Completed with empty response.');
          this.running.delete(record.id);
          this.activeJobs.delete(record.id);
          this.enqueueUnreadMailbox(record);
          this.pump();
        })
        .catch(error => {
          if (this.activeJobs.get(record.id) !== activeJob) return;
          this.fail(record.id, error instanceof Error ? error.message : String(error));
          this.running.delete(record.id);
          this.activeJobs.delete(record.id);
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
