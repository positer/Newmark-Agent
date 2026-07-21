import * as assert from 'assert';
import { Agent as KernelAgent } from '../core/agentKernel/agent';
import { createAssistantMessageEventStream } from '../core/agentKernel/stream-types';
import type { AgentEvent, AssistantMessage, Model } from '../core/agentKernel/types';
import { auditKernelTrajectory, auditWorkRunTrajectory } from '../core/responseTrajectory';
import type { ConversationWorkRun } from '../core/types';

const MODEL: Model = {
  id: 'trajectory-test', name: 'trajectory-test', api: 'test', provider: 'test', baseUrl: '', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256,
};

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], api: 'test', provider: 'test', model: MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}

async function main(): Promise<void> {
  const events: AgentEvent[] = [];
  let providerCalls = 0;
  const kernel = new KernelAgent({
    initialState: {
      model: MODEL,
      tools: [
        { name: 'alpha', label: 'alpha', description: '', parameters: {}, execute: async () => { await delay(40); return { content: [{ type: 'text', text: 'alpha-ok' }] }; } },
        { name: 'beta', label: 'beta', description: '', parameters: {}, execute: async () => { await delay(60); throw new Error('beta-failed'); } },
      ],
    },
    toolExecution: 'parallel',
    shouldStopAfterTurn: ({ message }) => message.role === 'assistant' && !message.content.some(item => item.type === 'toolCall'),
    streamFn: async () => {
      providerCalls += 1;
      const stream = createAssistantMessageEventStream();
      const message = providerCalls === 1
        ? { ...assistant(''), content: [
            { type: 'toolCall', id: 'alpha-call', name: 'alpha', arguments: {} } as const,
            { type: 'toolCall', id: 'beta-call', name: 'beta', arguments: {} } as const,
          ], stopReason: 'toolUse' }
        : assistant('complete');
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message }));
      return stream;
    },
  });
  kernel.subscribe(event => { events.push(event); });
  const startedAt = Date.now();
  await kernel.prompt('run the independent tools');
  const elapsedMs = Date.now() - startedAt;
  const kernelAudit = auditKernelTrajectory(events);
  assert.equal(kernelAudit.complete, true, 'native loop trajectory has one end and a receipt for every tool launch');
  assert.deepEqual({ starts: kernelAudit.toolStarts, ends: kernelAudit.toolEnds, receipts: kernelAudit.toolReceipts, failed: kernelAudit.failedToolReceipts },
    { starts: 2, ends: 2, receipts: 2, failed: 1 }, 'trajectory reports the complete mixed-success tool batch');
  assert.ok(elapsedMs < 90, `parallel batch wall time ${elapsedMs}ms remains below the 100ms sequential sum`);

  const completedRun: ConversationWorkRun = {
    runId: 'completed-run', target: { workspaceId: 'workspace', conversationId: 'conversation' }, runtimeKey: 'runtime',
    status: 'completed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), expanded: true, sequence: 4,
    events: [
      { id: 'final', conversationId: 'conversation', type: 'final_response', content: 'done', mode: 'Build', model: 'model', timestamp: 'now' },
      { id: 'done', conversationId: 'conversation', type: 'done', content: 'done', mode: 'Build', model: 'model', timestamp: 'now', status: 'completed' },
    ],
    guides: [{ clientMessageId: 'guide', target: { workspaceId: 'workspace', conversationId: 'conversation' }, runId: 'completed-run', status: 'applied', createdAt: 'now', updatedAt: 'now' }],
  };
  const completedAudit = auditWorkRunTrajectory(completedRun);
  assert.equal(completedAudit.complete, true, 'completed work run has exactly one terminal event and final response');
  assert.equal(completedAudit.guideStatusCounts.applied, 1, 'work-run audit reports Guide receipt settlement');

  const interruptedAudit = auditWorkRunTrajectory({
    ...completedRun, runId: 'interrupted-run', status: 'interrupted',
    events: [{ id: 'interrupted', conversationId: 'conversation', type: 'status', content: 'Interrupted.', mode: 'Build', model: 'model', timestamp: 'now', status: 'interrupted' }],
    guides: [],
  });
  assert.equal(interruptedAudit.complete, true, 'interrupted work run has one terminal event and no synthesized final response');
  const duplicateFinalAudit = auditWorkRunTrajectory({ ...completedRun, events: [...completedRun.events, completedRun.events[0]] });
  assert.equal(duplicateFinalAudit.complete, false, 'duplicate final responses fail the work-run trajectory contract');
  console.log(JSON.stringify({ ok: true, assertions: 7, elapsedMs, kernelAudit, completedAudit }));
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

main().catch(error => { console.error(error); process.exit(1); });
