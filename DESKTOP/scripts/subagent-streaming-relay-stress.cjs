// End-to-end stress test for the subagent live-streaming relay pipeline.
// Verifies: child work events reach parent peer subscribers with actorId,
// runtime identity stripped, and never pollute the parent's own work stream.
'use strict';
const fs = require('fs');
const path = require('path');
const { Agent } = require('../dist/core/agent.js');
const { ConversationKernel } = require('../dist/core/conversationKernel.js');

const TEST_ROOT = path.join(__dirname, '.subagent-streaming-stress');

class FakeProvider {
  constructor(responses) { this.responses = responses; this.calls = 0; }
  intelligenceConfig() { return { temperature: 0, maxTokens: 256 }; }
  async *chatStreamWithTools() {
    const response = this.responses[Math.min(this.calls, this.responses.length - 1)] || '';
    this.calls++;
    for (const chunk of String(response).split(' ')) {
      yield { type: 'text', text: chunk + ' ' };
    }
  }
  async chat() { return this.responses[0] || ''; }
}

function fail(message) { console.error(`FAIL: ${message}`); process.exitCode = 1; }
function ok(message) { console.log(`ok: ${message}`); }

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const agent = new Agent(TEST_ROOT);
  agent.subagents.reset();
  const provider = new FakeProvider(['streaming peer reply with several chunks']);
  agent.engineModel = () => provider;
  agent.setModel('test-model');

  const ownEvents = [];
  const peerEvents = [];
  agent.subscribeWorkEvents(event => ownEvents.push(event));
  agent.subscribePeerWorkEvents(event => peerEvents.push(event));

  // Sequential single-child run first.
  const result = await agent.handleSubagent(JSON.stringify({ name: 'stream-worker', prompt: 'Reply with streaming chunks', model: 'test-model', input_mode: 'next', mode: 'build' }));
  if (!result.includes('streaming peer reply')) fail(`child result missing: ${result}`);
  const child = agent.subagents.get('stream-worker');
  if (!child) fail('child record missing');
  const childId = child.id;

  if (!peerEvents.length) fail('no peer events relayed');
  if (!peerEvents.every(event => event.actorId === childId)) fail(`peer events mis-attributed: ${peerEvents.map(e => e.actorId).join(',')}`);
  if (peerEvents.some(event => event.runtimeKey || event.workspaceKey)) fail('peer events leaked runtime identity');
  if (ownEvents.some(event => event.actorId)) fail('parent own stream polluted with actorId');
  const types = [...new Set(peerEvents.map(event => event.type))];
  for (const required of ['start', 'text', 'done']) {
    if (!types.includes(required)) fail(`peer stream missing ${required} event, got: ${types.join(',')}`);
  }
  const textChunks = peerEvents.filter(event => event.type === 'text').map(event => event.content).join('');
  if (!textChunks.includes('streaming peer reply')) fail(`streamed text incomplete: ${textChunks}`);
  ok(`single child relay: ${peerEvents.length} events, types=${types.join(',')}, text=${textChunks.trim()}`);

  // Parallel stress: 8 concurrent children, all events must map to the right actorId.
  peerEvents.length = 0;
  const names = Array.from({ length: 8 }, (_, i) => `parallel-worker-${i}`);
  await Promise.all(names.map(name => agent.handleSubagent(JSON.stringify({ name, prompt: `Reply for ${name}`, model: 'test-model', input_mode: 'next', mode: 'build' }))));
  const validIds = new Set(names.map(name => agent.subagents.get(name)?.id));
  if (peerEvents.length < names.length * 3) fail(`parallel relay starved: ${peerEvents.length} events for 8 children`);
  for (const event of peerEvents) {
    if (!validIds.has(event.actorId)) fail(`parallel event attributed to unknown actor: ${event.actorId}`);
  }
  const perChild = {};
  for (const event of peerEvents) perChild[event.actorId] = (perChild[event.actorId] || 0) + 1;
  for (const id of validIds) {
    if (!(perChild[id] >= 3)) fail(`child ${id} relayed only ${perChild[id] || 0} events`);
  }
  ok(`parallel relay: ${peerEvents.length} events across ${validIds.size} children (${Object.values(perChild).join('/')})`);

  // Subscription cleanup must stop delivery.
  const probeEvents = [];
  const unsubscribe = agent.subscribePeerWorkEvents(event => probeEvents.push(event));
  unsubscribe();
  agent.emitPeerWorkEvent('manual-probe', { id: 'x', conversationId: 'default', type: 'status', content: 'probe', mode: 'build', model: 'm', timestamp: 't' });
  if (probeEvents.length !== 0) fail('unsubscribed peer listener still received events');

  // Conversation kernel broadcast path: peer events reach listeners (renderer
  // broadcast) without being persisted into the conversation runtime.events.
  const kernel = new ConversationKernel(TEST_ROOT, agent, null);
  const kernelEvents = [];
  kernel.subscribe(event => kernelEvents.push(event));
  const kernelOptions = { mode: 'build', model: 'test-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' };
  const runtime = kernel.runtime(kernel.normalizeTarget({ conversationId: 'default' }), kernelOptions);
  const persistedBefore = runtime.events.length;
  runtime.runner.emitPeerWorkEvent('actor-probe', { id: 'p1', conversationId: 'default', type: 'text', content: 'probe text', mode: 'build', model: 'test-model', timestamp: 't' });
  if (kernelEvents.length !== 1 || kernelEvents[0].actorId !== 'actor-probe' || kernelEvents[0].content !== 'probe text') fail(`kernel peer broadcast wrong: ${JSON.stringify(kernelEvents)}`);
  if (runtime.events.length !== persistedBefore) fail('kernel persisted a peer event into conversation runtime.events');
  runtime.unsubscribePeer();
  runtime.runner.emitPeerWorkEvent('actor-probe', { id: 'p2', conversationId: 'default', type: 'text', content: 'after cleanup', mode: 'build', model: 'test-model', timestamp: 't' });
  if (kernelEvents.length !== 1) fail('kernel peer listener still live after unsubscribePeer');
  ok('kernel broadcast: peer events forwarded without persistence, cleanup honored');

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  if (process.exitCode) { console.error('subagent streaming relay stress FAILED'); process.exit(process.exitCode); }
  console.log('subagent streaming relay stress: all checks passed');
}

main().catch(error => { console.error(error); process.exit(1); });
