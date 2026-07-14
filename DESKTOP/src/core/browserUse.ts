import { randomUUID } from 'crypto';
import { BrowserControl } from './browserControl';

/**
 * Native Newmark Browser-Use protocol.
 *
 * Design references (concepts only; no page-agent runtime or source is included):
 * - Alibaba page-agent separates page observation from index-based actions:
 *   https://github.com/alibaba/page-agent/blob/fa4664dfa5379e6e91deaf85bc1db2ae14d8e1d7/packages/page-controller/src/PageController.ts
 * - It keeps the DOM selector map private and returns action outcomes:
 *   https://github.com/alibaba/page-agent/blob/fa4664dfa5379e6e91deaf85bc1db2ae14d8e1d7/packages/page-controller/src/actions.ts
 * - It observes again before each decision and records tool execution results:
 *   https://github.com/alibaba/page-agent/blob/fa4664dfa5379e6e91deaf85bc1db2ae14d8e1d7/packages/core/src/PageAgentCore.ts
 *
 * Newmark's implementation is intentionally host-driven and model-independent. The Electron
 * main process owns the page adapter; workers receive only opaque refs and public receipts.
 */

export type BrowserUseAction =
  | 'observe'
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'key'
  | 'navigate'
  | 'wait'
  | 'extract';

const PUBLIC_BROWSER_USE_ATTRIBUTES = new Set(['href', 'src', 'alt', 'title', 'role']);
const PUBLIC_BROWSER_USE_ARIA_ATTRIBUTES = new Set([
  'aria-atomic', 'aria-autocomplete', 'aria-busy', 'aria-checked', 'aria-colcount',
  'aria-colindex', 'aria-colspan', 'aria-current', 'aria-description', 'aria-disabled',
  'aria-expanded', 'aria-haspopup', 'aria-hidden', 'aria-invalid', 'aria-keyshortcuts',
  'aria-label', 'aria-level', 'aria-live', 'aria-modal', 'aria-multiline',
  'aria-multiselectable', 'aria-orientation', 'aria-placeholder', 'aria-posinset',
  'aria-pressed', 'aria-readonly', 'aria-relevant', 'aria-required', 'aria-roledescription',
  'aria-rowcount', 'aria-rowindex', 'aria-rowspan', 'aria-selected', 'aria-setsize',
  'aria-sort', 'aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext',
]);

/** Only attributes intended for visible/accessibility presentation may cross the Browser-Use boundary. */
export function isPublicBrowserUseAttribute(input: string): boolean {
  const attribute = String(input || '').trim().toLowerCase();
  return PUBLIC_BROWSER_USE_ATTRIBUTES.has(attribute) || PUBLIC_BROWSER_USE_ARIA_ATTRIBUTES.has(attribute);
}

export interface BrowserUseScope {
  owner: string;
  runtimeKey: string;
}

export interface BrowserUseRequest extends BrowserUseScope {
  action: BrowserUseAction;
  /** Caller-generated idempotency key. A repeated id returns the original receipt. */
  actionId?: string;
  /** Required for every page action except observe and navigate. */
  pageGeneration?: number;
  /** Capability id returned by observe. Required with pageGeneration. */
  observationId?: string;
  ref?: string;
  text?: string;
  value?: string;
  key?: string;
  url?: string;
  deltaX?: number;
  deltaY?: number;
  durationMs?: number;
  maxChars?: number;
  maxRefs?: number;
  attribute?: string;
}

export interface BrowserUseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserUseViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  pageWidth: number;
  pageHeight: number;
}

/** Internal adapter record. `token` is never returned to a model or renderer. */
export interface BrowserUseAdapterElement {
  token: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  disabled?: boolean;
  editable?: boolean;
  selected?: boolean;
  options?: string[];
  rect?: BrowserUseRect;
}

export interface BrowserUseRef {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  disabled?: boolean;
  editable?: boolean;
  selected?: boolean;
  options?: string[];
  rect?: BrowserUseRect;
}

export interface BrowserUseAdapterObservation {
  /** Opaque document identity supplied and rechecked by the page adapter. */
  pageToken: string;
  url: string;
  title: string;
  viewport?: BrowserUseViewport;
  text?: string;
  elements: BrowserUseAdapterElement[];
}

export interface BrowserUseObservation {
  url: string;
  title: string;
  viewport?: BrowserUseViewport;
  text: string;
  refs: BrowserUseRef[];
  truncated: boolean;
}

export interface BrowserUseAdapterActionRequest {
  action: Exclude<BrowserUseAction, 'observe'>;
  expectedPageToken: string;
  element?: BrowserUseAdapterElement;
  text?: string;
  value?: string;
  key?: string;
  url?: string;
  deltaX?: number;
  deltaY?: number;
  durationMs?: number;
  maxChars?: number;
  attribute?: string;
}

export interface BrowserUseEffects {
  pageChanged?: boolean;
  popupBlocked?: boolean;
  downloadBlocked?: boolean;
  navigationBlocked?: boolean;
}

export interface BrowserUseAdapterActionResult {
  ok: boolean;
  pageToken?: string;
  pageChanged?: boolean;
  url?: string;
  title?: string;
  data?: unknown;
  code?: string;
  error?: string;
  retryable?: boolean;
  effects?: BrowserUseEffects;
}

export interface BrowserUsePageAdapter {
  observe(scope: BrowserUseScope, options: { maxChars: number; maxRefs: number }, signal?: AbortSignal): Promise<BrowserUseAdapterObservation>;
  act(scope: BrowserUseScope, request: BrowserUseAdapterActionRequest, signal?: AbortSignal): Promise<BrowserUseAdapterActionResult>;
}

export interface BrowserUseReceipt extends BrowserUseScope {
  ok: boolean;
  action: BrowserUseAction;
  actionId: string;
  sequence: number;
  pageGeneration: number;
  observationId?: string;
  ref?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  url?: string;
  title?: string;
  observation?: BrowserUseObservation;
  data?: unknown;
  effects?: BrowserUseEffects;
  code?: string;
  error?: string;
  retryable?: boolean;
  nextAction?: 'observe' | 'retry' | 'request_permission';
}

export interface BrowserUseBackend {
  run(request: BrowserUseRequest, signal?: AbortSignal): Promise<BrowserUseReceipt>;
}

interface BrowserUseSession {
  generation: number;
  observationId: string;
  pageToken: string;
  sequence: number;
  refs: Map<string, BrowserUseAdapterElement>;
  receipts: Map<string, BrowserUseReceipt>;
  inflight: Map<string, Promise<BrowserUseReceipt>>;
  tail: Promise<void>;
  abortController: AbortController;
}

interface BrowserUseEngineOptions {
  now?: () => number;
  id?: () => string;
  maxCachedReceipts?: number;
}

const ACTIONS = new Set<BrowserUseAction>([
  'observe', 'click', 'type', 'select', 'scroll', 'key', 'navigate', 'wait', 'extract',
]);
const HIDDEN_KEYS = new Set([
  'reasoning', 'reasoning_content', 'thinking', 'thinking_delta', 'chain_of_thought', 'hidden_reasoning',
  'selector', 'token', 'backendnodeid', 'backend_node_id', 'nodeid', 'node_id', 'objectid', 'object_id',
  'remoteobjectid', 'frameid', 'frame_id', 'loaderid', 'loader_id',
]);

function cleanScopePart(value: unknown): string {
  const text = String(value || '').trim();
  if (!text || text.length > 512 || hasControlCharacter(text)) return '';
  return text;
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function scopeKey(scope: BrowserUseScope): string {
  return `${scope.runtimeKey}\u0000${scope.owner}`;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason || 'Browser-Use action aborted'));
}

function throwIfBrowserUseAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function mergeAbortSignals(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; dispose(): void } {
  if (!secondary || primary === secondary) return { signal: primary, dispose() {} };
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onPrimaryAbort = () => abortFrom(primary);
  const onSecondaryAbort = () => abortFrom(secondary);
  primary.addEventListener('abort', onPrimaryAbort, { once: true });
  secondary.addEventListener('abort', onSecondaryAbort, { once: true });
  if (primary.aborted) abortFrom(primary);
  else if (secondary.aborted) abortFrom(secondary);
  return {
    signal: controller.signal,
    dispose() {
      primary.removeEventListener('abort', onPrimaryAbort);
      secondary.removeEventListener('abort', onSecondaryAbort);
    },
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function finiteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function publicString(value: unknown, maxChars: number): string {
  return String(value || '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .split(String.fromCharCode(0)).join('')
    .slice(0, maxChars);
}

export function sanitizeBrowserUsePublicData(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return publicString(value, 20_000);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeBrowserUsePublicData(item, depth + 1, seen));
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (HIDDEN_KEYS.has(key.toLowerCase())) continue;
    output[key] = sanitizeBrowserUsePublicData(item, depth + 1, seen);
  }
  return output;
}

export function normalizeBrowserUseUrl(raw: unknown): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (trimmed === 'about:blank') return trimmed;
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (url.username || url.password) return '';
    if (!['http:', 'https:'].includes(url.protocol.toLowerCase())) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Rebind an untrusted protocol payload to a host-owned runtime and actor.
 * `owner` and `runtimeKey` from the payload are deliberately ignored, so neither a
 * model argument nor a compromised renderer can move a capability to another target.
 */
export function bindBrowserUseRequest(
  input: unknown,
  context: { runtimeKey: string; actorId: string },
): BrowserUseRequest {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const runtimeKey = cleanScopePart(context.runtimeKey);
  const actorId = cleanScopePart(context.actorId).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160);
  const request: BrowserUseRequest = {
    owner: runtimeKey && actorId ? `browser-use:${runtimeKey}:actor:${actorId}` : '',
    runtimeKey,
    action: String(raw.action || '').trim().toLowerCase() as BrowserUseAction,
  };
  if (raw.actionId !== undefined || raw.action_id !== undefined) request.actionId = String(raw.actionId ?? raw.action_id ?? '');
  if (raw.pageGeneration !== undefined || raw.page_generation !== undefined) request.pageGeneration = Number(raw.pageGeneration ?? raw.page_generation);
  if (raw.observationId !== undefined || raw.observation_id !== undefined) request.observationId = String(raw.observationId ?? raw.observation_id ?? '');
  if (raw.ref !== undefined) request.ref = String(raw.ref);
  if (raw.text !== undefined) request.text = String(raw.text);
  if (raw.value !== undefined) request.value = String(raw.value);
  if (raw.key !== undefined) request.key = String(raw.key);
  if (raw.url !== undefined) request.url = String(raw.url);
  if (raw.deltaX !== undefined || raw.delta_x !== undefined) request.deltaX = Number(raw.deltaX ?? raw.delta_x);
  if (raw.deltaY !== undefined || raw.delta_y !== undefined) request.deltaY = Number(raw.deltaY ?? raw.delta_y);
  if (raw.durationMs !== undefined || raw.duration_ms !== undefined) request.durationMs = Number(raw.durationMs ?? raw.duration_ms);
  if (raw.maxChars !== undefined || raw.max_chars !== undefined) request.maxChars = Number(raw.maxChars ?? raw.max_chars);
  if (raw.maxRefs !== undefined || raw.max_refs !== undefined) request.maxRefs = Number(raw.maxRefs ?? raw.max_refs);
  if (raw.attribute !== undefined) request.attribute = String(raw.attribute);
  return request;
}

function publicElement(element: BrowserUseAdapterElement, ref: string): BrowserUseRef {
  const role = publicString(element.role, 80) || undefined;
  const name = publicString(element.name, 300) || undefined;
  const text = publicString(element.text, 500) || undefined;
  const options = Array.isArray(element.options)
    ? element.options.slice(0, 100).map(option => publicString(option, 300))
    : undefined;
  const rect = element.rect ? {
    x: finiteNumber(element.rect.x),
    y: finiteNumber(element.rect.y),
    width: Math.max(0, finiteNumber(element.rect.width)),
    height: Math.max(0, finiteNumber(element.rect.height)),
  } : undefined;
  return {
    ref,
    tag: publicString(element.tag, 40).toLowerCase() || 'element',
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(text ? { text } : {}),
    ...(element.disabled === true ? { disabled: true } : {}),
    ...(element.editable === true ? { editable: true } : {}),
    ...(typeof element.selected === 'boolean' ? { selected: element.selected } : {}),
    ...(options ? { options } : {}),
    ...(rect ? { rect } : {}),
  };
}

function recoveryFor(code: string): Pick<BrowserUseReceipt, 'retryable' | 'nextAction'> {
  if (['observation_required', 'stale_generation', 'stale_observation', 'stale_page', 'ref_not_found'].includes(code)) {
    return { retryable: true, nextAction: 'observe' };
  }
  if (code === 'permission_required') return { retryable: false, nextAction: 'request_permission' };
  return {};
}

export class BrowserUseEngine implements BrowserUseBackend {
  private readonly sessions = new Map<string, BrowserUseSession>();
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly maxCachedReceipts: number;

  constructor(private readonly adapter: BrowserUsePageAdapter, options: BrowserUseEngineOptions = {}) {
    this.now = options.now || Date.now;
    this.id = options.id || randomUUID;
    this.maxCachedReceipts = boundedInteger(options.maxCachedReceipts, 128, 8, 1024);
  }

  clear(scope?: BrowserUseScope): void {
    if (!scope) {
      for (const session of this.sessions.values()) {
        session.abortController.abort(new Error('Browser-Use engine cleared'));
      }
      this.sessions.clear();
      return;
    }
    const key = scopeKey(scope);
    this.sessions.get(key)?.abortController.abort(new Error('Browser-Use scope cleared'));
    this.sessions.delete(key);
  }

  clearRuntime(runtimeKey: string): void {
    const trustedRuntimeKey = cleanScopePart(runtimeKey);
    if (!trustedRuntimeKey) return;
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(`${trustedRuntimeKey}\u0000`)) continue;
      session.abortController.abort(new Error(`Browser-Use runtime stopped: ${trustedRuntimeKey}`));
      session.inflight.clear();
      this.sessions.delete(key);
    }
  }

  async run(input: BrowserUseRequest, signal?: AbortSignal): Promise<BrowserUseReceipt> {
    throwIfBrowserUseAborted(signal);
    const owner = cleanScopePart(input?.owner);
    const runtimeKey = cleanScopePart(input?.runtimeKey);
    const rawAction = String(input?.action || '').trim().toLowerCase();
    const action = (ACTIONS.has(rawAction as BrowserUseAction) ? rawAction : 'observe') as BrowserUseAction;
    const actionId = cleanScopePart(input?.actionId) || `browser-use-${this.id()}`;
    const normalized = { ...input, owner, runtimeKey, action, actionId };
    if (!owner || !runtimeKey || !ACTIONS.has(rawAction as BrowserUseAction)) return await this.runNow(normalized, signal);

    const session = this.ensureSession({ owner, runtimeKey });
    const cached = session.receipts.get(actionId);
    if (cached) return cached;
    const inflight = session.inflight.get(actionId);
    if (inflight) return await inflight;

    const linked = mergeAbortSignals(session.abortController.signal, signal);
    const task = session.tail.then(async () => {
      throwIfBrowserUseAborted(linked.signal);
      return await this.runNow(normalized, linked.signal);
    });
    session.inflight.set(actionId, task);
    session.tail = task.then(() => undefined, () => undefined);
    try {
      return await task;
    } finally {
      linked.dispose();
      if (session.inflight.get(actionId) === task) session.inflight.delete(actionId);
    }
  }

  private async runNow(input: BrowserUseRequest, signal?: AbortSignal): Promise<BrowserUseReceipt> {
    throwIfBrowserUseAborted(signal);
    const owner = cleanScopePart(input?.owner);
    const runtimeKey = cleanScopePart(input?.runtimeKey);
    const rawAction = String(input?.action || '').trim().toLowerCase();
    const action = (ACTIONS.has(rawAction as BrowserUseAction) ? rawAction : 'observe') as BrowserUseAction;
    const actionId = cleanScopePart(input?.actionId) || `browser-use-${this.id()}`;
    const startedAt = this.now();

    if (!owner || !runtimeKey) {
      return this.standaloneFailure({ owner, runtimeKey, action, actionId, startedAt }, 'invalid_scope', 'Browser-Use requires a non-empty owner and runtimeKey.');
    }
    if (!ACTIONS.has(rawAction as BrowserUseAction)) {
      return this.standaloneFailure({ owner, runtimeKey, action, actionId, startedAt }, 'invalid_request', `Unsupported Browser-Use action: ${rawAction || '(missing)'}`);
    }

    const scope = { owner, runtimeKey };
    const session = this.ensureSession(scope);
    const cached = session.receipts.get(actionId);
    if (cached) return cached;
    const sequence = ++session.sequence;

    if (action === 'observe') {
      try {
        const maxChars = boundedInteger(input.maxChars, 12_000, 500, 50_000);
        const maxRefs = boundedInteger(input.maxRefs, 160, 1, 300);
        const raw = await this.adapter.observe(scope, { maxChars, maxRefs }, signal);
        throwIfBrowserUseAborted(signal);
        if (!raw || !cleanScopePart(raw.pageToken)) {
          return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'observe_failed', 'Page adapter returned no document identity.'));
        }
        session.generation += 1;
        session.observationId = `observation-${session.generation}-${this.id()}`;
        session.pageToken = cleanScopePart(raw.pageToken);
        session.refs.clear();
        const elements = Array.isArray(raw.elements) ? raw.elements.slice(0, maxRefs) : [];
        const refs: BrowserUseRef[] = [];
        for (const element of elements) {
          const token = cleanScopePart(element?.token);
          if (!token) continue;
          const ref = `r${refs.length + 1}`;
          const internal: BrowserUseAdapterElement = { ...element, token };
          session.refs.set(ref, internal);
          refs.push(publicElement(internal, ref));
        }
        const observation: BrowserUseObservation = {
          url: publicString(raw.url, 4000),
          title: publicString(raw.title, 1000),
          viewport: raw.viewport ? sanitizeBrowserUsePublicData(raw.viewport) as BrowserUseViewport : undefined,
          text: publicString(raw.text, maxChars),
          refs,
          truncated: (Array.isArray(raw.elements) && raw.elements.length > elements.length) || String(raw.text || '').length > maxChars,
        };
        return this.cache(session, this.success(scope, action, actionId, sequence, session.generation, startedAt, {
          observationId: session.observationId,
          url: observation.url,
          title: observation.title,
          observation,
        }));
      } catch (error) {
        throwIfBrowserUseAborted(signal);
        return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'observe_failed', error instanceof Error ? error.message : String(error), true, 'retry'));
      }
    }

    if (action === 'navigate') {
      const url = normalizeBrowserUseUrl(input.url);
      if (!url) {
        return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'unsafe_navigation', 'Browser-Use navigation only accepts safe HTTP, HTTPS, or about:blank URLs without embedded credentials.'));
      }
      return await this.executeAdapter(scope, session, { action, expectedPageToken: session.pageToken, url }, input, actionId, sequence, startedAt, signal);
    }

    if (!session.observationId) {
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'observation_required', 'Observe the current page before acting on it.', true, 'observe'));
    }
    const generation = Number(input.pageGeneration);
    if (!Number.isInteger(generation) || generation !== session.generation) {
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'stale_generation', `Expected pageGeneration ${session.generation}; received ${String(input.pageGeneration)}. Observe again before acting.`, true, 'observe'));
    }
    if (String(input.observationId || '') !== session.observationId) {
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'stale_observation', 'The observation capability is missing or stale. Observe again before acting.', true, 'observe'));
    }

    const needsRef = action === 'click' || action === 'type' || action === 'select';
    const ref = String(input.ref || '').trim();
    const element = ref ? session.refs.get(ref) : undefined;
    if (needsRef && !ref) {
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_request', `${action} requires a ref from the latest observation.`));
    }
    if (ref && !element) {
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'ref_not_found', `Unknown ref ${ref}. Observe again before acting.`, true, 'observe'));
    }
    if (element?.disabled && (action === 'click' || action === 'type' || action === 'select')) {
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_ref_role', `Ref ${ref} is disabled.`));
    }
    if (action === 'type' && !element?.editable) {
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_ref_role', `Ref ${ref} is not editable.`));
    }
    if (action === 'select' && element?.tag.toLowerCase() !== 'select') {
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_ref_role', `Ref ${ref} is not a native select element.`));
    }

    const adapterRequest: BrowserUseAdapterActionRequest = {
      action,
      expectedPageToken: session.pageToken,
      ...(element ? { element } : {}),
    };
    if (action === 'type') {
      const text = String(input.text ?? '');
      if (text.length > 50_000) return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_request', 'Type text exceeds 50000 characters.'));
      adapterRequest.text = text;
    } else if (action === 'select') {
      const value = String(input.value ?? '').trim();
      if (!value || value.length > 2000) return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_request', 'Select requires a value up to 2000 characters.'));
      adapterRequest.value = value;
    } else if (action === 'scroll') {
      const deltaX = finiteNumber(input.deltaX);
      const deltaY = finiteNumber(input.deltaY);
      if ((!deltaX && !deltaY) || Math.abs(deltaX) > 10_000 || Math.abs(deltaY) > 10_000) {
        return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_request', 'Scroll requires a non-zero delta within ±10000 pixels.'));
      }
      adapterRequest.deltaX = deltaX;
      adapterRequest.deltaY = deltaY;
    } else if (action === 'key') {
      const key = String(input.key || '').trim();
      if (!key || key.length > 64 || hasControlCharacter(key)) {
        return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_request', 'Key requires a bounded printable key or chord.'));
      }
      adapterRequest.key = key;
    } else if (action === 'wait') {
      const durationMs = Number(input.durationMs);
      if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10_000) {
        return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_request', 'Wait duration must be between 0 and 10000 milliseconds.'));
      }
      adapterRequest.durationMs = Math.floor(durationMs);
    } else if (action === 'extract') {
      adapterRequest.maxChars = boundedInteger(input.maxChars, 12_000, 200, 50_000);
      if (input.attribute !== undefined) {
        const attribute = String(input.attribute || '').trim().toLowerCase();
        if (!isPublicBrowserUseAttribute(attribute)) {
          return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'invalid_request', 'Extract only allows public href, src, alt, title, role, and safe aria attributes.'));
        }
        adapterRequest.attribute = attribute;
      }
    }
    return await this.executeAdapter(scope, session, adapterRequest, input, actionId, sequence, startedAt, signal);
  }

  private async executeAdapter(
    scope: BrowserUseScope,
    session: BrowserUseSession,
    adapterRequest: BrowserUseAdapterActionRequest,
    input: BrowserUseRequest,
    actionId: string,
    sequence: number,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<BrowserUseReceipt> {
    const action = adapterRequest.action;
    try {
      throwIfBrowserUseAborted(signal);
      const result = await this.adapter.act(scope, adapterRequest, signal);
      throwIfBrowserUseAborted(signal);
      const changed = result.pageChanged === true || (!!result.pageToken && !!session.pageToken && result.pageToken !== session.pageToken);
      if (changed) {
        session.generation += 1;
        session.observationId = '';
        session.refs.clear();
      }
      if (result.pageToken) session.pageToken = cleanScopePart(result.pageToken);
      const effects = sanitizeBrowserUsePublicData({ ...result.effects, ...(changed ? { pageChanged: true } : {}) }) as BrowserUseEffects;
      if (!result.ok) {
        const code = publicString(result.code, 120) || 'action_failed';
        const recovery = recoveryFor(code);
        return this.cache(session, this.failure(
          scope,
          action,
          actionId,
          sequence,
          session.generation,
          startedAt,
          code,
          publicString(result.error, 4000) || `${action} failed.`,
          result.retryable ?? recovery.retryable,
          recovery.nextAction,
          {
            ...(input.ref ? { ref: String(input.ref) } : {}),
            ...(result.url ? { url: publicString(result.url, 4000) } : {}),
            ...(result.title ? { title: publicString(result.title, 1000) } : {}),
            ...(Object.keys(effects || {}).length ? { effects } : {}),
          },
        ));
      }
      return this.cache(session, this.success(scope, action, actionId, sequence, session.generation, startedAt, {
        ...(input.ref ? { ref: String(input.ref) } : {}),
        ...(session.observationId ? { observationId: session.observationId } : {}),
        ...(result.url ? { url: publicString(result.url, 4000) } : {}),
        ...(result.title ? { title: publicString(result.title, 1000) } : {}),
        ...(result.data !== undefined ? { data: sanitizeBrowserUsePublicData(result.data) } : {}),
        ...(Object.keys(effects || {}).length ? { effects } : {}),
      }));
    } catch (error) {
      throwIfBrowserUseAborted(signal);
      return this.cache(session, this.failure(scope, action, actionId, sequence, session.generation, startedAt, 'adapter_error', error instanceof Error ? error.message : String(error), false, undefined, input.ref ? { ref: String(input.ref) } : undefined));
    }
  }

  private ensureSession(scope: BrowserUseScope): BrowserUseSession {
    const key = scopeKey(scope);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        generation: 0,
        observationId: '',
        pageToken: '',
        sequence: 0,
        refs: new Map(),
        receipts: new Map(),
        inflight: new Map(),
        tail: Promise.resolve(),
        abortController: new AbortController(),
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  private cache(session: BrowserUseSession, receipt: BrowserUseReceipt): BrowserUseReceipt {
    session.receipts.set(receipt.actionId, receipt);
    while (session.receipts.size > this.maxCachedReceipts) {
      const oldest = session.receipts.keys().next().value as string | undefined;
      if (!oldest) break;
      session.receipts.delete(oldest);
    }
    return receipt;
  }

  private success(
    scope: BrowserUseScope,
    action: BrowserUseAction,
    actionId: string,
    sequence: number,
    pageGeneration: number,
    startedAt: number,
    extra: Partial<BrowserUseReceipt> = {},
  ): BrowserUseReceipt {
    const finishedAt = this.now();
    return { ok: true, action, actionId, ...scope, sequence, pageGeneration, startedAt, finishedAt, durationMs: Math.max(0, finishedAt - startedAt), ...extra };
  }

  private failure(
    scope: BrowserUseScope,
    action: BrowserUseAction,
    actionId: string,
    sequence: number,
    pageGeneration: number,
    startedAt: number,
    code: string,
    error: string,
    retryable?: boolean,
    nextAction?: BrowserUseReceipt['nextAction'],
    extra: Partial<BrowserUseReceipt> = {},
  ): BrowserUseReceipt {
    const finishedAt = this.now();
    return {
      ok: false,
      action,
      actionId,
      ...scope,
      sequence,
      pageGeneration,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      code,
      error: publicString(error, 4000),
      ...(retryable !== undefined ? { retryable } : {}),
      ...(nextAction ? { nextAction } : {}),
      ...extra,
    };
  }

  private standaloneFailure(
    base: BrowserUseScope & { action: BrowserUseAction; actionId: string; startedAt: number },
    code: string,
    error: string,
  ): BrowserUseReceipt {
    return this.failure(base, base.action, base.actionId, 0, 0, base.startedAt, code, error);
  }
}

/** Process-local bridge. Electron main installs the real engine; workers install a target-bound host RPC. */
export class BrowserUse {
  private static backend: BrowserUseBackend | null = null;

  static setBackend(backend: BrowserUseBackend | null): void {
    this.backend = backend;
  }

  static hasBackend(): boolean {
    return this.backend !== null;
  }

  static async run(request: BrowserUseRequest, signal?: AbortSignal): Promise<BrowserUseReceipt> {
    throwIfBrowserUseAborted(signal);
    if (this.backend) {
      try {
        const receipt = await this.backend.run(request, signal);
        throwIfBrowserUseAborted(signal);
        return receipt;
      } catch (error) {
        throwIfBrowserUseAborted(signal);
        return this.unavailable(request, 'backend_error', error instanceof Error ? error.message : String(error));
      }
    }
    // Isolated conversation workers already have a target-bound BrowserControl host RPC. Reuse
    // that narrow bridge instead of exposing Electron or arbitrary JavaScript inside the worker.
    const bridged = await BrowserControl.run({ action: 'use', browserUse: request });
    throwIfBrowserUseAborted(signal);
    if (bridged.ok && bridged.data && typeof bridged.data === 'object') {
      const receipt = bridged.data as BrowserUseReceipt;
      if (receipt.action && receipt.actionId && receipt.owner === request.owner && receipt.runtimeKey === request.runtimeKey) return receipt;
    }
    return this.unavailable(request, bridged.error ? 'backend_error' : 'backend_unavailable', bridged.error || 'Browser-Use backend is not connected. Start Newmark Desktop to use the built-in browser.');
  }

  private static unavailable(request: BrowserUseRequest, code: string, error: string): BrowserUseReceipt {
    const now = Date.now();
    return {
      ok: false,
      action: ACTIONS.has(request?.action) ? request.action : 'observe',
      actionId: cleanScopePart(request?.actionId) || `browser-use-${randomUUID()}`,
      owner: cleanScopePart(request?.owner),
      runtimeKey: cleanScopePart(request?.runtimeKey),
      sequence: 0,
      pageGeneration: Number.isInteger(request?.pageGeneration) ? Number(request.pageGeneration) : 0,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      code,
      error: publicString(error, 4000),
    };
  }
}
