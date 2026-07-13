import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from '../core/agent';
import { ConversationKernel } from '../core/conversationKernel';
import { agentKernelRunnerInternals } from '../core/agentKernelRunner';
import { SubagentManager, SubagentState } from '../core/subagent';
import { evaluateToolPolicy } from '../core/toolPolicy';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function main(): Promise<void> {
  const releases = new Map<string, () => void>();
  const starts: string[] = [];
  const manager = new SubagentManager({
    conversationId: 'parallel-test',
    executor: async job => {
      starts.push(job.record.id);
      await new Promise<void>(resolve => releases.set(job.record.id, resolve));
      return `done:${job.record.natureSlug}`;
    },
  });

  const ids = Array.from({ length: 5 }, (_, index) => manager.create(`Review ${index + 1}`, `Prompt ${index + 1}`));
  await tick();
  assert.strictEqual(manager.listAll().filter(item => item.status === 'working').length, 4);
  assert.strictEqual(manager.get(ids[4])?.status, 'queued');
  assert.match(manager.get(ids[0])?.name || '', /^review-1-[0-9a-f]{8}--[0-9a-f-]{36}$/);
  releases.get(ids[0])?.();
  await tick();
  await tick();
  assert.strictEqual(starts[4], ids[4]);
  assert.strictEqual(manager.get(ids[4])?.status, 'working');

  const first = manager.get(ids[0]);
  assert.ok(first);
  assert.strictEqual(manager.sendMessage(first!.id, first!.id, 'self send').ok, false);
  assert.strictEqual(manager.sendMessage(manager.rootAgentId, first!.id, 'continue').ok, true);
  manager.close(first!.id, manager.rootAgentId);
  assert.strictEqual(manager.sendMessage(manager.rootAgentId, first!.id, 'closed').ok, false);

  const runningRead = manager.read(manager.rootAgentId, ids[1], 4000);
  assert.strictEqual(runningRead.ok, true);
  assert.strictEqual(runningRead.snapshot?.peer.status, 'working');
  assert.ok(runningRead.snapshot?.feedback.some(message => message.content.includes('Prompt 2')));

  const mailboxOrder: string[] = [];
  const wakeReleases = new Map<number, () => void>();
  let wakeRun = 0;
  const wakeManager = new SubagentManager({
    conversationId: 'mailbox-test',
    concurrency: 1,
    executor: async job => {
      wakeRun++;
      mailboxOrder.push(job.prompt);
      await new Promise<void>(resolve => wakeReleases.set(wakeRun, resolve));
      if (wakeRun === 3) throw new Error('planned peer error');
      return `wake-done-${wakeRun}`;
    },
  });
  const wakeId = wakeManager.create('mailbox-peer', 'initial');
  await tick();
  assert.strictEqual(wakeManager.sendMessage(wakeManager.rootAgentId, wakeId, 'mail-one').ok, true);
  assert.strictEqual(wakeManager.sendMessage(wakeManager.rootAgentId, wakeId, 'mail-two').ok, true);
  const pendingRead = wakeManager.read(wakeManager.rootAgentId, wakeId);
  assert.strictEqual(pendingRead.snapshot?.mailbox.unread, 2);
  wakeReleases.get(1)?.();
  await tick();
  await tick();
  assert.ok(mailboxOrder[1].indexOf('mail-one') < mailboxOrder[1].indexOf('mail-two'));
  wakeReleases.get(2)?.();
  await tick();
  await tick();
  assert.strictEqual(wakeManager.get(wakeId)?.status, 'completed');
  assert.strictEqual(wakeManager.read(wakeId, wakeId).ok, true, 'peer may read another/current conversation record through shared coordinator API');
  assert.strictEqual(wakeManager.sendMessage('peer-sender', wakeId, 'reactivate-after-complete').ok, true);
  await tick();
  assert.ok(['queued', 'working'].includes(wakeManager.get(wakeId)?.status || ''));
  wakeReleases.get(3)?.();
  await tick();
  await tick();
  assert.strictEqual(wakeManager.get(wakeId)?.status, 'error');
  assert.strictEqual(wakeManager.sendMessage('peer-sender', wakeId, 'reactivate-after-error').ok, true);
  await tick();
  assert.ok(['queued', 'working'].includes(wakeManager.get(wakeId)?.status || ''));
  const peerTargetId = wakeManager.create('peer-target', 'peer target prompt');
  assert.strictEqual(wakeManager.read(wakeId, peerTargetId).ok, true);
  const peerDelivery = wakeManager.sendMessage(wakeId, peerTargetId, 'peer-to-peer-directive', 'handoff');
  assert.strictEqual(peerDelivery.ok, true);
  assert.ok(wakeManager.read(wakeId, peerTargetId).snapshot?.mailbox.latest.some(message => message.body === 'peer-to-peer-directive'));
  wakeManager.close(peerTargetId, wakeManager.rootAgentId);
  const creatorId = wakeManager.create('creator-peer', 'creator prompt');
  const childOfPeer = wakeManager.create('child-peer', 'child prompt', undefined, undefined, 'build', creatorId);
  assert.strictEqual(wakeManager.get(childOfPeer)?.createdByAgentId, creatorId);
  wakeManager.close(childOfPeer, wakeManager.rootAgentId);
  const restartState = wakeManager.serialize();
  const restartManager = new SubagentManager({ conversationId: 'mailbox-test', state: restartState });
  const restartRead = restartManager.read(restartManager.rootAgentId, wakeId);
  assert.strictEqual(restartRead.ok, true);
  assert.ok(['queued', 'working'].includes(restartRead.snapshot?.peer.status || ''));
  assert.ok(restartRead.snapshot?.feedback.some(message => message.content.includes('reactivate-after-error')) || restartRead.snapshot?.mailbox.inbound);
  wakeManager.close(wakeId, wakeManager.rootAgentId);
  assert.strictEqual(wakeManager.sendMessage('peer-sender', wakeId, 'closed-reject').ok, false);

  const serialized = manager.serialize();
  const restored = new SubagentManager({ conversationId: 'parallel-test', state: serialized });
  assert.strictEqual(restored.rootAgentId, manager.rootAgentId);
  assert.ok(restored.listAll().every(item => item.status !== 'working'));

  const persistedRootStates: SubagentState[] = [];
  const rootWakeMessages: string[] = [];
  const rootInboxManager = new SubagentManager({
    conversationId: 'root-inbox-test',
    persist: state => persistedRootStates.push(state),
    onRootInboxMessage: message => {
      rootWakeMessages.push(message.body);
      return false;
    },
  });
  const rootDelivery = rootInboxManager.sendRootMessage('peer-result-source', 'peer result for root', 'result');
  assert.strictEqual(rootDelivery.ok, true);
  assert.strictEqual(rootInboxManager.readRootInbox().length, 1);
  assert.strictEqual(persistedRootStates.at(-1)?.rootInbox.length, 1, 'root inbox persists before wake acknowledgement');
  assert.deepStrictEqual(rootWakeMessages, ['peer result for root']);
  const secondRootListener: string[] = [];
  rootInboxManager.bind({
    onRootInboxMessage: message => {
      secondRootListener.push(message.body);
      return false;
    },
  });
  await tick();
  assert.deepStrictEqual(secondRootListener, ['peer result for root'], 'multiple root runtimes can observe the same persisted inbox without replacing each other');
  const restoredRootWake: string[] = [];
  const restoredRootInbox = new SubagentManager({
    conversationId: 'root-inbox-test',
    state: rootInboxManager.serialize(),
  });
  restoredRootInbox.bind({
    onRootInboxMessage: message => {
      restoredRootWake.push(message.body);
      return false;
    },
  });
  await tick();
  assert.deepStrictEqual(restoredRootWake, ['peer result for root'], 'unread root inbox replays after restart');
  assert.strictEqual(restoredRootInbox.acknowledgeRootInbox(rootDelivery.message!.id), true);
  assert.strictEqual(restoredRootInbox.readRootInbox().length, 0);

  const rootAgent = new Agent(path.join(process.cwd(), 'test-tmp-dev008-root-inbox'), { agentOnly: true });
  (rootAgent.subagents as unknown as { bind(options: Record<string, unknown>): void }).bind({
    onRootInboxMessage: (message: { id: string; body: string; kind: string; fromAgentId: string }) =>
      (rootAgent as unknown as { deliverRootInboxMessage(value: typeof message): boolean }).deliverRootInboxMessage(message),
  });
  const rootSteering: string[] = [];
  const rootFollowUps: string[] = [];
  rootAgent.attachAgentKernelRuntime({
    steer: message => rootSteering.push(String((message as { content?: string }).content || '')),
    followUp: message => rootFollowUps.push(String((message as { content?: string }).content || '')),
  });
  const rootMessage = rootAgent.subagents.sendRootMessage('peer-running-source', 'running root receives safely', 'result');
  assert.strictEqual(rootSteering.length, 0, 'running root does not inject peer results as same-turn steering');
  assert.ok(rootFollowUps.some(message => message.includes(rootMessage.message!.id) && message.includes('running root receives safely')), 'running root queues peer results as a safe follow-up turn');
  assert.strictEqual(rootAgent.subagents.readRootInbox().length, 1);
  rootAgent.notifyAgentKernelUserMessageStart(rootFollowUps[0]);
  assert.strictEqual(rootAgent.subagents.readRootInbox().length, 0, 'root inbox acknowledges only at model message boundary');
  fs.rmSync(path.join(process.cwd(), 'test-tmp-dev008-root-inbox'), { recursive: true, force: true });

  const routedRoot = new Agent(path.join(process.cwd(), 'test-tmp-dev008-root-route'), { agentOnly: true });
  const routedWake: string[] = [];
  const routedKernelFollowUps: string[] = [];
  routedRoot.subscribeRootInboxWake(message => { routedWake.push(message); return true; });
  routedRoot.attachAgentKernelRuntime({ steer: () => {}, followUp: message => routedKernelFollowUps.push(String((message as { content?: string }).content || '')) });
  (routedRoot.subagents as unknown as { bind(options: Record<string, unknown>): void }).bind({
    onRootInboxMessage: (message: { id: string; body: string; kind: string; fromAgentId: string }) =>
      (routedRoot as unknown as { deliverRootInboxMessage(value: typeof message): boolean }).deliverRootInboxMessage(message),
  });
  routedRoot.subagents.sendRootMessage('peer-routed-source', 'route exactly once', 'result');
  assert.strictEqual(routedWake.length, 1, 'conversation-owned root wake listener receives a peer result exactly once');
  assert.strictEqual(routedKernelFollowUps.length, 0, 'root wake routing does not also enqueue a duplicate direct kernel follow-up');
  fs.rmSync(path.join(process.cwd(), 'test-tmp-dev008-root-route'), { recursive: true, force: true });

  class RootWakeProbeAgent extends Agent {
    public processCalls: string[] = [];
    override setConversation(id: string): string { this.activeConversationId = id; return id; }
    override async process(input: string): Promise<Array<{ type: 'text'; text: string }>> {
      this.processCalls.push(input);
      this.notifyAgentKernelUserMessageStart(input);
      return [{ type: 'text', text: 'root follow-up complete' }];
    }
  }
  const kernelRoot = path.join(process.cwd(), 'test-tmp-dev008-root-wake');
  fs.rmSync(kernelRoot, { recursive: true, force: true });
  const kernelHost = new Agent(kernelRoot, { agentOnly: true });
  const kernel = new ConversationKernel(kernelRoot, kernelHost, null);
  const wakeProbe = new RootWakeProbeAgent(kernelRoot, { agentOnly: true });
  const wakeRuntime = {
    id: 'root-wake-conversation',
    runner: wakeProbe,
    options: { mode: 'build', model: 'default', intelligence: 'medium', inputMode: 'guide', engine: 'builtin' },
    activePromise: null,
    events: [],
    pendingNextTurn: [],
    queued: { steering: [], followUp: [] },
  };
  wakeProbe.subscribeRootInboxWake(message => (kernel as unknown as { enqueueRootInboxWake(runtime: typeof wakeRuntime, prompt: string): void }).enqueueRootInboxWake(wakeRuntime, message));
  (kernel as unknown as { runtimes: Map<string, typeof wakeRuntime> }).runtimes.set(wakeRuntime.id, wakeRuntime);
  (wakeProbe.subagents as unknown as { bind(options: Record<string, unknown>): void }).bind({
    onRootInboxMessage: (message: { id: string; body: string; kind: string; fromAgentId: string }) =>
      (wakeProbe as unknown as { deliverRootInboxMessage(value: typeof message): boolean }).deliverRootInboxMessage(message),
  });
  const idleWake = wakeProbe.subagents.sendRootMessage('idle-peer-source', 'idle root summary result', 'result');
  await tick();
  await tick();
  assert.ok(wakeProbe.processCalls.some(call => call.includes(idleWake.message!.id) && call.includes('idle root summary result')), 'idle root queues an automatic follow-up turn');
  assert.strictEqual(wakeProbe.subagents.readRootInbox().length, 0);

  const activeWakeRuntime = {
    ...wakeRuntime,
    id: 'root-active-wake-conversation',
    activePromise: Promise.resolve({} as never),
    pendingNextTurn: [] as Array<{ message: string; queueMode: 'steer' | 'followUp' }>,
  };
  (kernel as unknown as { enqueueRootInboxWake(runtime: typeof activeWakeRuntime, prompt: string): void }).enqueueRootInboxWake(activeWakeRuntime, 'active peer result prompt');
  await tick();
  assert.deepStrictEqual(activeWakeRuntime.pendingNextTurn, [{ message: 'active peer result prompt', queueMode: 'followUp' }], 'active root result wake is appended once to the conversation-owned next-turn queue');
  fs.rmSync(kernelRoot, { recursive: true, force: true });

  assert.strictEqual(evaluateToolPolicy({ name: 'write', mode: 'plan' }).allowed, false);
  assert.strictEqual(evaluateToolPolicy({ name: 'task', mode: 'plan', isSubagent: true }).allowed, true);
  assert.strictEqual(evaluateToolPolicy({ name: 'skill_download', mode: 'plan' }).allowed, false);
  assert.strictEqual(evaluateToolPolicy({ name: 'computer_use', mode: 'plan', args: { action: 'observe' } }).allowed, true);
  assert.strictEqual(evaluateToolPolicy({ name: 'computer_use', mode: 'plan', args: { action: 'click' } }).allowed, false);

  const root = path.join(process.cwd(), 'test-tmp-dev008-linked-plan');
  fs.rmSync(root, { recursive: true, force: true });
  const agent = new Agent(root);
  const initial = agent.getLinkedPlan();
  assert.strictEqual(initial.revision, 0);
  const updated = agent.updateLinkedPlan('# Linked plan\n\n- [ ] Verify', 0, 'test-agent');
  assert.strictEqual(updated.revision, 1);
  assert.throws(() => agent.updateLinkedPlan('# stale', 0, 'test-agent'), /revision conflict/i);
  const reloaded = new Agent(root);
  assert.strictEqual(reloaded.getLinkedPlan().markdown, '# Linked plan\n\n- [ ] Verify');
  fs.rmSync(root, { recursive: true, force: true });

  const compressionManager = new SubagentManager({ conversationId: 'compression-test' });
  const compressionPeer = compressionManager.create('compress-peer', 'retain the delegated objective');
  const compressedHistory = [
    { role: 'user', content: 'retain the delegated objective' },
    { role: 'system', content: '[Context Compression Fallback]\n\nPreserved delegated state.' },
    { role: 'user', content: 'latest mailbox directive' },
  ];
  compressionManager.replaceContext(compressionPeer, compressedHistory, {
    at: new Date().toISOString(),
    originalMessages: 40,
    compressedMessages: 3,
    originalChars: 90000,
    summary: 'Preserved delegated state.',
    model: 'local-fallback',
    fallback: true,
  });
  const compressedRecord = compressionManager.get(compressionPeer)!;
  assert.deepStrictEqual(compressedRecord.messages, compressedHistory, 'subagent context compression replaces the persisted peer transcript');
  assert.strictEqual((compressedRecord.metadata?.contextCompression as { originalMessages?: number })?.originalMessages, 40, 'subagent compression metadata persists with the peer');
  const restoredCompression = new SubagentManager({ conversationId: 'compression-test', state: compressionManager.serialize() });
  assert.ok(restoredCompression.read(restoredCompression.rootAgentId, compressionPeer).snapshot?.feedback.some(message => message.content.includes('Context Compression')), 'subagent_read exposes the compressed persisted context after restart');

  const compressionRoot = path.join(process.cwd(), 'test-tmp-dev008-peer-compression');
  fs.rmSync(compressionRoot, { recursive: true, force: true });
  const compressionAgent = new Agent(compressionRoot, {
    subagent: true,
    subagentName: 'compression-peer',
    subagentPrompt: 'retain the delegated objective',
    actorId: compressionPeer,
    conversationId: 'compression-test',
  });
  compressionAgent.config.set('context', 'auto_compress', true);
  compressionAgent.config.set('context', 'compress_threshold_chars', 1000);
  compressionAgent.config.set('context', 'keep_recent_messages', 4);
  compressionAgent.history = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index}:` + (index % 2 === 0 ? 'u' : 'a').repeat(600),
  }));
  let persistedPeerContext: { history: Array<Record<string, unknown>>; compression: Agent['lastCompression'] } | null = null;
  (compressionAgent as unknown as {
    subagentContextPersist: (history: Array<Record<string, unknown>>, compression: Agent['lastCompression']) => void;
  }).subagentContextPersist = (history, compression) => { persistedPeerContext = { history, compression }; };
  const provider = {
    async chat(): Promise<string> {
      return '## Preserved State\nRetain the delegated objective and completed evidence.\n\n## Pending Work\nContinue from the latest mailbox directive.';
    },
  };
  await compressionAgent.maybeCompress(
    compressionAgent.history.map(message => ({ ...message })),
    provider as never,
  );
  const persisted = persistedPeerContext as { history: Array<Record<string, unknown>>; compression: Agent['lastCompression'] } | null;
  assert.ok(persisted?.compression && persisted.history.some((message: Record<string, unknown>) => String(message.content || '').includes('Context Compression ')), 'a real subagent compression persists summary metadata and compacted history');
  assert.ok(persisted, 'subagent compression invokes its persistence callback');
  const restoredKernelContext = agentKernelRunnerInternals.toKernelMessagesFromHistory(persisted!.history, compressionAgent);
  assert.ok(restoredKernelContext.some(message => message.role === 'user' && String(message.content || '').includes('Preserved context record') && String(message.content || '').includes('Context Compression ')), 'a restarted subagent sends its persisted compression summary back to the model context');
  fs.rmSync(compressionRoot, { recursive: true, force: true });

  for (const release of releases.values()) release();
  for (const release of wakeReleases.values()) release();
  await tick();
  console.log('dev-0.0.8 subagent, policy, and linked-plan checks passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
