import assert from 'node:assert/strict';
import { WorkEventCoalescer } from '../core/workEventCoalescer';
import type { AgentWorkEvent } from '../core/types';

const base: AgentWorkEvent = {
  id: '1', conversationId: 'c', type: 'text', content: '', mode: 'build', model: 'mock', timestamp: 't',
  workspaceId: 'w', runtimeKey: 'w::c', runId: 'r', sequence: 1,
};

const received: AgentWorkEvent[] = [];
const coalescer = new WorkEventCoalescer(event => received.push(event), 50);
coalescer.push({ ...base, id: '1', content: 'a', sequence: 1 });
coalescer.push({ ...base, id: '2', content: 'b', sequence: 2 });
assert.equal(received.length, 0, 'text deltas stay inside the coalescing window');
coalescer.push({ ...base, type: 'tool_call', content: 'tool', id: '3', sequence: 3 });
assert.deepEqual(received.map(event => [event.type, event.content]), [['text', 'ab'], ['tool_call', 'tool']]);
coalescer.push({ ...base, id: '4', content: 'c', sequence: 4 });
coalescer.flushAll();
assert.equal(received.at(-1)?.content, 'c');
assert.equal(coalescer.pendingCount(), 0);
coalescer.push({ ...base, type: 'thought_delta', id: '5', content: 'plan ', sequence: 5 });
coalescer.push({ ...base, type: 'thought_delta', id: '6', content: 'step', sequence: 6 });
coalescer.flushAll();
assert.deepEqual(received.at(-1) && [received.at(-1)!.type, received.at(-1)!.content], ['thought_delta', 'plan step']);
assert.deepEqual(received[0].coalescedDeltas?.map(delta => [delta.id, delta.sequence, delta.content]), [['1', 1, 'a'], ['2', 2, 'b']], 'batch retains every original delta identity and boundary');
assert.deepEqual(received.at(-1)?.coalescedDeltas?.map(delta => delta.id), ['5', '6'], 'thought batches retain original identities too');
const forwarded: AgentWorkEvent[] = [];
const forwarding = new WorkEventCoalescer(event => forwarded.push(event), 16);
forwarding.push(JSON.parse(JSON.stringify(received[0])));
forwarding.push({ ...base, id: '7', content: 'c', sequence: 7 });
forwarding.push({ ...base, workspaceId: 'another-workspace', id: '8', content: 'other', sequence: 8 });
forwarding.flushAll();
assert.deepEqual(forwarded[0].coalescedDeltas?.map(delta => delta.id), ['1', '2', '7'], 'a structured-clone/JSON forwarded batch flattens without discarding identities');
assert.equal(forwarded[0].content, 'abc');
assert.equal(forwarded[1].content, 'other', 'different runtime targets never share a batch');
assert.deepEqual(forwarded[1].coalescedDeltas?.map(delta => delta.id), ['8']);
assert.equal(forwarding.pendingCount(), 0);
console.log(JSON.stringify({ ok: true, assertions: 14 }));
