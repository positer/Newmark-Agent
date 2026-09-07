/** Sender-owned, explicit content selection for peer communication.
 * Selection never calls a model, mutates history, or serializes runtime state.
 */
export type SubagentCommunicationContentKind = 'summary' | 'text_history' | 'tool_history';
export interface SubagentCommunicationHistoryMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
  hidden_user_input?: unknown;
}
export interface SubagentCommunicationParams {
  message?: unknown;
  prompt?: unknown;
  content?: unknown;
}
export interface SubagentCommunicationRange { start: number; end: number; total: number }
export interface SubagentCommunicationSelection {
  body: string;
  selection: {
    source: 'explicit' | 'default_history' | 'content';
    segments: Array<{ kind: 'message' | SubagentCommunicationContentKind; range?: SubagentCommunicationRange; units: number }>;
    bodyChars: number;
  };
}
export type SubagentCommunicationErrorCode = 'ambiguous_content' | 'invalid_content' | 'invalid_range' | 'empty_history' | 'budget_exceeded';
export class SubagentCommunicationSelectionError extends Error {
  constructor(public readonly code: SubagentCommunicationErrorCode, message: string) {
    super(message);
    this.name = 'SubagentCommunicationSelectionError';
  }
}

type TextUnit = { role: 'user' | 'assistant'; text: string; sourceIndex: number };
type ToolUnit = { id: string; name: string; arguments: unknown; result: unknown; sourceIndex: number; callIndex: number };
const MAX_BODY_CHARS = 30000;
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(code: SubagentCommunicationErrorCode, message: string): never { throw new SubagentCommunicationSelectionError(code, message); }

function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => record(part) && ['text', 'input_text', 'output_text'].includes(String(part.type)))
    .map(part => typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, unknown>).text as string : '').join('\n');
}
function toolPayload(value: unknown): string {
  // Only the selected message.content / function.arguments enter this path.
  // Business fields and code snippets inside a tool payload are evidence, not
  // message-level private metadata, and must never be rewritten or filtered.
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value) ?? ''; }
  catch { return fail('invalid_content', 'Selected tool payload is not serializable; provide an explicit summary instead.'); }
}

function units(history: readonly SubagentCommunicationHistoryMessage[]): { texts: TextUnit[]; tools: ToolUnit[]; timeline: Array<TextUnit | ToolUnit> } {
  const texts: TextUnit[] = [], tools: ToolUnit[] = [];
  const pending = new Map<string, Omit<ToolUnit, 'result'>>();
  const ambiguous = new Set<string>();
  history.forEach((message, sourceIndex) => {
    if (!message || message.hidden_user_input === true) return;
    if (message.role === 'user' || message.role === 'assistant') {
      const text = messageText(message.content);
      if (text.trim()) texts.push({ role: message.role, text, sourceIndex });
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const [callIndex, call] of message.tool_calls.entries()) {
        if (!record(call) || !record(call.function)) continue;
        const id = typeof call.id === 'string' ? call.id : '';
        const name = typeof call.function.name === 'string' ? call.function.name : '';
        if (!id.trim() || !name.trim()) continue;
        if (pending.has(id) || ambiguous.has(id)) { pending.delete(id); ambiguous.add(id); continue; }
        pending.set(id, { id, name, arguments: call.function.arguments, sourceIndex, callIndex });
      }
    } else if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      const call = pending.get(message.tool_call_id);
      if (!call || (typeof message.name === 'string' && message.name.trim() && message.name !== call.name)) return;
      tools.push({ ...call, result: message.content });
      pending.delete(message.tool_call_id);
    }
  });
  tools.sort((a, b) => a.sourceIndex - b.sourceIndex || a.callIndex - b.callIndex);
  const timeline: Array<TextUnit | ToolUnit> = [...texts, ...tools];
  timeline.sort((a, b) => a.sourceIndex - b.sourceIndex || ('text' in a ? -1 : 'text' in b ? 1 : a.callIndex - b.callIndex));
  return { texts, tools, timeline };
}

function resolveRange(value: unknown, total: number, kind: string): SubagentCommunicationRange {
  if (!record(value)) return fail('invalid_range', `${kind} requires range: {last:N} or {start:N,end:N}.`);
  const hasLast = own(value, 'last'), hasStart = own(value, 'start'), hasEnd = own(value, 'end');
  if (Object.keys(value).some(key => !['last', 'start', 'end'].includes(key)) || (hasLast && (hasStart || hasEnd)) || (!hasLast && (!hasStart || !hasEnd))) {
    return fail('invalid_range', `${kind} range must use last alone or both start/end; ranges are 1-based and inclusive.`);
  }
  const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
  if (hasLast) {
    if (!integer(value.last) || value.last > total) return fail('invalid_range', `${kind} range.last must be between 1 and ${total}; no selected units are silently omitted.`);
    return { start: total - value.last + 1, end: total, total };
  }
  if (!integer(value.start) || !integer(value.end) || value.start > value.end || value.end > total) {
    return fail('invalid_range', `${kind} range must satisfy 1 <= start <= end <= ${total}.`);
  }
  return { start: value.start, end: value.end, total };
}
function rangeLabel(range: SubagentCommunicationRange): string { return `${range.start}-${range.end} of ${range.total}`; }
function textSection(selected: TextUnit[], range: SubagentCommunicationRange): string {
  return `[Selected text history: ${rangeLabel(range)}]\n${selected.map((unit, index) => `${range.start + index}. ${unit.role}:\n${unit.text}`).join('\n\n')}`;
}
function toolSection(selected: ToolUnit[], range: SubagentCommunicationRange): string {
  return `[Selected tool history: ${rangeLabel(range)}; complete call/result pairs]\n${selected.map((unit, index) =>
    `${range.start + index}. ${JSON.stringify(unit.name)} call_id=${JSON.stringify(unit.id)}\nCall arguments:\n${toolPayload(unit.arguments) || '(empty)'}\nTool result:\n${toolPayload(unit.result) || '(empty public result)'}`).join('\n\n')}`;
}

export function selectSubagentCommunication(
  history: readonly SubagentCommunicationHistoryMessage[],
  params: SubagentCommunicationParams,
  options: { maxBodyChars?: number } = {},
): SubagentCommunicationSelection {
  const limit = options.maxBodyChars ?? MAX_BODY_CHARS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BODY_CHARS) return fail('invalid_content', 'maxBodyChars must be an integer between 1 and 30000.');
  if (!record(params)) return fail('invalid_content', 'Communication parameters must be an object.');
  const hasMessage = own(params, 'message'), hasPrompt = own(params, 'prompt'), hasContent = own(params, 'content');
  if ((hasMessage || hasPrompt) && hasContent) return fail('ambiguous_content', 'Use explicit message/prompt or content selections, not both.');
  if (hasMessage && hasPrompt && params.message !== params.prompt) return fail('ambiguous_content', 'message and prompt contain conflicting explicit text.');
  const segments: SubagentCommunicationSelection['selection']['segments'] = [];
  let body = '';
  const append = (section: string): void => {
    const next = body ? `${body}\n\n${section}` : section;
    if (next.length > limit) fail('budget_exceeded', `Selected communication exceeds the ${limit}-character budget. Select a smaller range or provide a shorter summary; no selected text or tool pair was truncated.`);
    body = next;
  };
  if (hasMessage || hasPrompt) {
    const explicit = hasMessage ? params.message : params.prompt;
    if (typeof explicit !== 'string' || !explicit.trim()) return fail('invalid_content', 'Explicit message/prompt must be non-empty text.');
    append(explicit);
    segments.push({ kind: 'message', units: 1 });
    return { body, selection: { source: 'explicit', segments, bodyChars: body.length } };
  }
  const available = units(history);
  if (!hasContent) {
    if (!available.texts.length) return fail('empty_history', 'No visible text history is available. Supply an explicit message or a scoped content selection.');
    const range = resolveRange({ last: 1 }, available.texts.length, 'text_history');
    append(textSection(available.texts.slice(-1), range));
    segments.push({ kind: 'text_history', range, units: 1 });
    return { body, selection: { source: 'default_history', segments, bodyChars: body.length } };
  }
  if (!Array.isArray(params.content) || !params.content.length) return fail('invalid_content', 'content must contain at least one scoped selection.');
  for (const part of params.content) {
    if (!record(part) || !['summary', 'text_history', 'tool_history'].includes(String(part.kind))) return fail('invalid_content', 'content kind must be summary, text_history, or tool_history.');
    const kind = part.kind as SubagentCommunicationContentKind;
    const total = kind === 'text_history' ? available.texts.length : kind === 'tool_history' ? available.tools.length : available.timeline.length;
    const range = resolveRange(part.range, total, kind);
    if (kind === 'summary') {
      if (typeof part.text !== 'string' || !part.text.trim()) return fail('invalid_content', 'summary requires non-empty sender-provided text; the tool does not generate a summary.');
      append(`[Sender-provided summary; visible history units ${rangeLabel(range)}]\n${part.text}`);
    } else {
      if (own(part, 'text')) return fail('invalid_content', `${kind} selects source history; use summary for sender-provided text.`);
      append(kind === 'text_history'
        ? textSection(available.texts.slice(range.start - 1, range.end), range)
        : toolSection(available.tools.slice(range.start - 1, range.end), range));
    }
    segments.push({ kind, range, units: range.end - range.start + 1 });
  }
  return { body, selection: { source: 'content', segments, bodyChars: body.length } };
}
