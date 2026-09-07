import assert from 'assert/strict';
import { selectSubagentCommunication as select, SubagentCommunicationSelectionError, SubagentCommunicationErrorCode } from '../core/subagentCommunication';

let passed = 0;
function check(name: string, run: () => void): void {
  run(); passed++; console.log(`PASS ${name}`);
}
function rejects(name: string, code: SubagentCommunicationErrorCode, run: () => unknown): void {
  check(name, () => assert.throws(run, (error: unknown) => error instanceof SubagentCommunicationSelectionError && error.code === code));
}
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: args } });
const payload = '  {"metadata":{"business":1},"system":"linux","analysis":"analysis: intact","requestCache":"business-key","code":"<think>literal</think>"}  ';
const history = [
  { role: 'system', content: 'PRIVATE_SYSTEM' },
  { role: 'user', content: 'Question one', metadata: { secret: 'PRIVATE_METADATA' }, requestCache: 'PRIVATE_CACHE' },
  { role: 'assistant', content: 'Preparing tools', reasoning_content: 'PRIVATE_REASONING', tool_calls: [call('call-a', 'inspect', payload), call('call-b', 'inspect', '{"path":"B"}')] },
  { role: 'tool', tool_call_id: 'call-b', name: 'inspect', content: 'RESULT_B', metadata: 'PRIVATE_TOOL_METADATA' },
  { role: 'tool', tool_call_id: 'call-a', name: 'inspect', content: payload },
  { role: 'user', content: 'PRIVATE_MAILBOX', hidden_user_input: true },
  { role: 'assistant', content: 'Final answer' },
  { role: 'user', content: '   ' },
  { role: 'tool', tool_call_id: 'orphan', content: 'PRIVATE_ORPHAN' },
  { role: 'assistant', content: '', tool_calls: [call('unfinished', 'inspect', 'PRIVATE_UNFINISHED')] },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE_REASONING_PART' }, { type: 'output_text', text: 'Latest visible answer' }] },
];
const before = JSON.stringify(history);
const text = (range: unknown) => select(history, { content: [{ kind: 'text_history', range }] });
const tool = (range: unknown) => select(history, { content: [{ kind: 'tool_history', range }] });

check('default selects only last visible text', () => {
  const result = select(history, {});
  assert.equal(result.body, '[Selected text history: 4-4 of 4]\n4. assistant:\nLatest visible answer');
  assert.deepEqual(result.selection, { source: 'default_history', segments: [{ kind: 'text_history', range: { start: 4, end: 4, total: 4 }, units: 1 }], bodyChars: result.body.length });
});
check('text range numbers filtered user and assistant text only', () => {
  const result = text({ start: 1, end: 3 });
  assert.equal(result.body, '[Selected text history: 1-3 of 4]\n1. user:\nQuestion one\n\n2. assistant:\nPreparing tools\n\n3. assistant:\nFinal answer');
});
check('last text range preserves correct source labels', () => assert.equal(text({ last: 2 }).selection.segments[0].range?.start, 3));
check('all tool units preserve call order when results arrive in reverse order', () => {
  const result = tool({ last: 2 });
  assert.ok(result.body.indexOf('call_id="call-a"') < result.body.indexOf('call_id="call-b"'));
  assert.ok(result.body.includes(`Call arguments:\n${payload}\nTool result:\n${payload}`));
  assert.ok(result.body.includes('Call arguments:\n{"path":"B"}\nTool result:\nRESULT_B'));
  assert.equal(result.selection.segments[0].units, 2);
});
check('tool selection never splits arguments and matching result', () => {
  const result = tool({ start: 2, end: 2 });
  assert.ok(result.body.includes('call-b') && result.body.includes('RESULT_B'));
  assert.ok(!result.body.includes('call-a') && !result.body.includes(payload));
});
check('top-level internal fields, hidden turns, orphan and incomplete pairs are absent', () => {
  const result = select(history, { content: [{ kind: 'text_history', range: { last: 4 } }, { kind: 'tool_history', range: { last: 2 } }] });
  assert.ok(!/PRIVATE_/.test(result.body));
  assert.ok(!/PRIVATE_/.test(JSON.stringify(result.selection)));
});
check('payload business keys and think snippets are exact tool evidence', () => {
  const result = tool({ start: 1, end: 1 });
  assert.equal(result.body.split(payload).length - 1, 2);
});
check('object tool payload serializes every selected business field', () => {
  const object = { metadata: { value: 2 }, system: 'business', analysis: '<think>code</think>', requestCache: { enabled: false } };
  const result = select([{ role: 'assistant', tool_calls: [call('obj', 'tool', object)] }, { role: 'tool', tool_call_id: 'obj', content: object }], { content: [{ kind: 'tool_history', range: { last: 1 } }] });
  assert.equal(result.body.split(JSON.stringify(object)).length - 1, 2);
});
check('summary uses complete logical timeline numbering and sender text', () => {
  const summary = '  analysis: <think>literal business content</think>  ';
  const result = select(history, { content: [{ kind: 'summary', range: { start: 3, end: 4 }, text: summary }] });
  assert.equal(result.body, `[Sender-provided summary; visible history units 3-4 of 6]\n${summary}`);
  assert.deepEqual(result.selection.segments[0], { kind: 'summary', range: { start: 3, end: 4, total: 6 }, units: 2 });
  assert.ok(!result.body.includes(payload));
});
check('multiple selections preserve requested segment order', () => {
  const result = select(history, { content: [{ kind: 'tool_history', range: { last: 1 } }, { kind: 'summary', range: { last: 6 }, text: 'Sender conclusion' }, { kind: 'text_history', range: { start: 1, end: 1 } }] });
  assert.deepEqual(result.selection.segments.map(segment => segment.kind), ['tool_history', 'summary', 'text_history']);
  assert.ok(result.body.indexOf('RESULT_B') < result.body.indexOf('Sender conclusion'));
  assert.ok(result.body.indexOf('Sender conclusion') < result.body.indexOf('Question one'));
});
check('explicit message preserves whitespace, business keys and code snippets', () => {
  const result = select([], { message: payload });
  assert.equal(result.body, payload);
  assert.equal(result.selection.source, 'explicit');
});
check('legacy prompt remains explicit text', () => assert.equal(select([], { prompt: 'legacy' }).body, 'legacy'));
check('identical aliases are unambiguous', () => assert.equal(select([], { prompt: 'same', message: 'same' }).body, 'same'));
check('canonical visible assistant text is not reinterpreted or rewritten', () => assert.ok(select([{ role: 'assistant', content: payload }], {}).body.endsWith(payload)));
check('input text and output text parts are visible, reasoning parts are not', () => {
  const result = select([{ role: 'user', content: [{ type: 'input_text', text: 'A' }, { type: 'reasoning', text: 'secret' }, { type: 'text', text: 'B' }] }], {});
  assert.ok(result.body.endsWith('A\nB'));
  assert.ok(!result.body.includes('secret'));
});
check('sequential reuse of a call id is still paired per occurrence', () => {
  const result = select([{ role: 'assistant', tool_calls: [call('repeat', 'run', 'FIRST')] }, { role: 'tool', tool_call_id: 'repeat', content: 'FIRST_RESULT' }, { role: 'assistant', tool_calls: [call('repeat', 'run', 'SECOND')] }, { role: 'tool', tool_call_id: 'repeat', content: 'SECOND_RESULT' }], { content: [{ kind: 'tool_history', range: { last: 2 } }] });
  assert.ok(result.body.includes('FIRST\nTool result:\nFIRST_RESULT'));
  assert.ok(result.body.includes('SECOND\nTool result:\nSECOND_RESULT'));
});
check('mismatching result name cannot consume a valid pending call', () => {
  const result = select([{ role: 'assistant', tool_calls: [call('id', 'right', 'ARGS')] }, { role: 'tool', tool_call_id: 'id', name: 'wrong', content: 'WRONG_RESULT' }, { role: 'tool', tool_call_id: 'id', name: 'right', content: 'RIGHT_RESULT' }], { content: [{ kind: 'tool_history', range: { last: 1 } }] });
  assert.ok(result.body.includes('RIGHT_RESULT') && !result.body.includes('WRONG_RESULT'));
});
check('selected history remains unmodified', () => assert.equal(JSON.stringify(history), before));

rejects('conflicting aliases rejected', 'ambiguous_content', () => select([], { message: 'a', prompt: 'b' }));
rejects('message and content rejected', 'ambiguous_content', () => select(history, { message: 'a', content: [{ kind: 'text_history', range: { last: 1 } }] }));
rejects('prompt and content rejected', 'ambiguous_content', () => select(history, { prompt: 'a', content: [] }));
for (const value of ['', '  ', null, 17, {}]) rejects(`invalid explicit message ${JSON.stringify(value)}`, 'invalid_content', () => select(history, { message: value }));
for (const value of [[], null, {}, 'text']) rejects(`invalid content ${JSON.stringify(value)}`, 'invalid_content', () => select(history, { content: value }));
for (const kind of ['system', 'tool', 'reasoning', 'message']) rejects(`invalid selector kind ${kind}`, 'invalid_content', () => select(history, { content: [{ kind, range: { last: 1 } }] }));
for (const range of [undefined, {}, { last: 0 }, { last: -1 }, { last: 1.5 }, { last: '1' }, { last: NaN }, { last: Infinity }, { last: 5 }, { last: 1, start: 1, end: 1 }, { start: 1 }, { end: 1 }, { start: 0, end: 1 }, { start: 2, end: 1 }, { start: 1, end: 5 }, { start: 1, end: 1, other: 1 }]) {
  rejects(`invalid text range ${JSON.stringify(range)}`, 'invalid_range', () => text(range));
}
rejects('tool range counts complete pairs only', 'invalid_range', () => tool({ last: 3 }));
rejects('summary range cannot exceed visible timeline', 'invalid_range', () => select(history, { content: [{ kind: 'summary', range: { last: 7 }, text: 'A' }] }));
rejects('summary never implicitly generates text', 'invalid_content', () => select(history, { content: [{ kind: 'summary', range: { last: 1 } }] }));
rejects('summary rejects empty sender text', 'invalid_content', () => select(history, { content: [{ kind: 'summary', range: { last: 1 }, text: '  ' }] }));
rejects('text selector cannot override source with free text', 'invalid_content', () => select(history, { content: [{ kind: 'text_history', range: { last: 1 }, text: 'A' }] }));
rejects('default with no visible text fails explicitly', 'empty_history', () => select([{ role: 'system', content: 'hidden' }, { role: 'user', content: 'hidden', hidden_user_input: true }], {}));
rejects('duplicate pending ids cannot fabricate a pair', 'invalid_range', () => select([{ role: 'assistant', tool_calls: [call('duplicate', 'first', 'A'), call('duplicate', 'second', 'B')] }, { role: 'tool', tool_call_id: 'duplicate', content: 'result' }], { content: [{ kind: 'tool_history', range: { last: 1 } }] }));
rejects('hidden tool result cannot complete a pair', 'invalid_range', () => select([{ role: 'assistant', tool_calls: [call('hidden', 'tool', 'A')] }, { role: 'tool', tool_call_id: 'hidden', content: 'PRIVATE', hidden_user_input: true }], { content: [{ kind: 'tool_history', range: { last: 1 } }] }));
check('exact explicit budget accepted intact', () => assert.equal(select([], { message: 'A'.repeat(30000) }).body.length, 30000));
rejects('oversized explicit body rejected without truncation', 'budget_exceeded', () => select([], { message: 'A'.repeat(30001) }));
rejects('oversized tool pair rejected as a whole', 'budget_exceeded', () => select([{ role: 'assistant', tool_calls: [call('large', 'tool', 'A'.repeat(16000))] }, { role: 'tool', tool_call_id: 'large', content: 'R'.repeat(16000) }], { content: [{ kind: 'tool_history', range: { last: 1 } }] }));
rejects('combined segment budget includes labels and separators', 'budget_exceeded', () => select(history, { content: [{ kind: 'text_history', range: { last: 1 } }, { kind: 'summary', range: { last: 1 }, text: 'S'.repeat(100) }] }, { maxBodyChars: 160 }));
for (const maxBodyChars of [0, -1, 1.5, 30001]) rejects(`invalid body budget ${maxBodyChars}`, 'invalid_content', () => select(history, {}, { maxBodyChars }));
check('large unselected source text does not consume selected budget', () => assert.ok(select([{ role: 'user', content: 'A'.repeat(32000) }, { role: 'assistant', content: 'short' }], {}).body.endsWith('short')));
check('default and summary do not serialize unselected tool payloads', () => {
  const source = [{ role: 'assistant', content: 'Visible', tool_calls: [call('lazy', 'tool', { toJSON: () => { throw new Error('unselected arguments serialized'); } })] }, { role: 'tool', tool_call_id: 'lazy', content: { toJSON: () => { throw new Error('unselected result serialized'); } } }];
  assert.ok(select(source, {}).body.endsWith('Visible'));
  assert.ok(select(source, { content: [{ kind: 'summary', range: { last: 1 }, text: 'Sender summary' }] }).body.endsWith('Sender summary'));
  assert.throws(() => select(source, { content: [{ kind: 'tool_history', range: { last: 1 } }] }), (error: unknown) => error instanceof SubagentCommunicationSelectionError && error.code === 'invalid_content');
});
check('exact source remains unmodified after rejected selections', () => assert.equal(JSON.stringify(history), before));
console.log(`\n${passed} passed, 0 failed`);
