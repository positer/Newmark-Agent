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
console.log(JSON.stringify({ ok: true, assertions: 6 }));
