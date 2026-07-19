import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Agent as KernelAgent } from '../core/agentKernel/agent';
import { createAssistantMessageEventStream } from '../core/agentKernel/stream-types';
import type { AgentMessage, AssistantMessage, Model } from '../core/agentKernel/types';
import { Agent } from '../core/agent';
import { ConversationKernel, type AgentPromptMessage } from '../core/conversationKernel';
import { filterPublicAssistantDelta, resetPublicAssistantDeltaFilter } from '../core/agentKernelRunner';
import type { AgentWorkEvent, ConversationTarget, GuideReceipt, StreamToken } from '../core/types';

const VALID_GUIDE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL: Model = {
  id: 'guide-test',
  name: 'guide-test',
  api: 'test',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function verifySteeringWinsTheFinalBoundary(): Promise<void> {
  let providerCalls = 0;
  const userStarts: Array<{ text: string; clientMessageId?: string }> = [];
  const kernel = new KernelAgent({
    initialState: { model: MODEL },
    shouldStopAfterTurn: () => true,
    streamFn: async () => {
      providerCalls += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: assistant(`reply-${providerCalls}`) }));
      return stream;
    },
  });
  kernel.subscribe(event => {
    if (event.type === 'message_start' && event.message.role === 'user') {
      userStarts.push({
        text: typeof event.message.content === 'string'
          ? event.message.content
          : event.message.content.map(item => item.type === 'text' ? item.text : '').join(''),
        clientMessageId: event.message.clientMessageId,
      });
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && providerCalls === 1) {
      assert.equal(kernel.steer({
        role: 'user',
        content: 'guide-at-final-boundary',
        clientMessageId: 'guide-boundary-1',
        timestamp: Date.now(),
      }), true, 'the steering gate stays open until the loop has drained the final boundary');
    }
  });

  await kernel.prompt('original prompt');
  assert.equal(providerCalls, 2, 'Guide received at the final assistant boundary starts one continuation before stop');
  assert.deepEqual(userStarts.map(item => item.clientMessageId).filter(Boolean), ['guide-boundary-1']);
  assert.equal(kernel.steer({ role: 'user', content: 'too late', clientMessageId: 'late', timestamp: Date.now() }), false,
    'after agent_end the closed steering gate rejects late input so the conversation layer can defer it');
}

async function verifySteeringCanArriveBeforeTheFirstProviderTurn(): Promise<void> {
  let providerCalls = 0;
  const providerContexts: AgentMessage[][] = [];
  const kernel = new KernelAgent({
    initialState: { model: MODEL },
    shouldStopAfterTurn: () => true,
    streamFn: async (_model, context) => {
      providerCalls += 1;
      providerContexts.push(context.messages.slice());
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: assistant(`pre-attach-${providerCalls}`) }));
      return stream;
    },
  });
  assert.equal(kernel.steer({
    role: 'user',
    content: 'guide-before-first-prompt',
    clientMessageId: 'guide-before-first-prompt',
    timestamp: Date.now(),
  }), true, 'a newly-created kernel accepts Guide queued while the runner is attaching');
  await kernel.prompt('original prompt');
  assert.equal(providerCalls, 2);
  const contextText = (messages: AgentMessage[]) => messages.map(message => typeof message.content === 'string'
    ? message.content
    : message.content.map(item => item.type === 'text' ? item.text : '').join(' ')).join('\n');
  assert.doesNotMatch(contextText(providerContexts[0]), /guide-before-first-prompt/,
    'attachment-window Guide does not alter the already-starting provider request');
  assert.match(contextText(providerContexts[1]), /guide-before-first-prompt/,
    'attachment-window Guide is applied in the next provider request after the first safe boundary');

  let continueContext: AgentMessage[] = [];
  const continuing = new KernelAgent({
    initialState: {
      model: MODEL,
      messages: [{ role: 'user', content: 'existing context', timestamp: Date.now() }],
    },
    shouldStopAfterTurn: () => true,
    streamFn: async (_model, context) => {
      continueContext = context.messages.slice();
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: assistant('continued') }));
      return stream;
    },
  });
  assert.equal(continuing.steer({ role: 'user', content: 'continue-steering', timestamp: Date.now() }), true);
  await continuing.continue();
  assert.match(contextText(continueContext), /continue-steering/,
    'continue() still consumes its pre-existing steering queue before the provider turn');
}

async function verifyParallelToolBatchBarrier(): Promise<void> {
  const events: string[] = [];
  let providerCalls = 0;
  const toolCall = (id: string, name: string): any => ({ type: 'toolCall', id, name, arguments: {} });
  const kernel = new KernelAgent({
    initialState: {
      model: MODEL,
      tools: [
        { name: 'fast', label: 'fast', description: '', parameters: {}, execute: async () => { events.push('fast-start'); await new Promise(resolve => setTimeout(resolve, 15)); events.push('fast-end'); return { content: [{ type: 'text', text: 'fast-ok' }] }; } },
        { name: 'slow', label: 'slow', description: '', parameters: {}, execute: async () => { events.push('slow-start'); await new Promise(resolve => setTimeout(resolve, 45)); events.push('slow-end'); throw new Error('slow-failed'); } },
      ],
    },
    toolExecution: 'parallel',
    shouldStopAfterTurn: ({ message }) => message.role === 'assistant' && !message.content.some(item => item.type === 'toolCall'),
    streamFn: async (_model, context) => {
      providerCalls += 1;
      if (providerCalls === 2) {
        assert.deepEqual(events, ['fast-start', 'slow-start', 'fast-end', 'slow-end'], 'the next provider step starts only after the complete concurrent batch settles');
        const receipts = context.messages.filter(message => message.role === 'toolResult');
        assert.equal(receipts.length, 2, 'the batch barrier exposes all success/failure receipts together');
        assert.equal(receipts.filter(message => message.role === 'toolResult' && message.isError).length, 1, 'one failed concurrent call remains a failure receipt instead of rejecting the whole batch');
      }
      const stream = createAssistantMessageEventStream();
      const message = providerCalls === 1
        ? { ...assistant(''), content: [toolCall('fast-call', 'fast'), toolCall('slow-call', 'slow')], stopReason: 'toolUse' }
        : assistant('parallel-complete');
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message }));
      return stream;
    },
  });
  await kernel.prompt('run tools concurrently');
  assert.equal(providerCalls, 2);
}

async function verifyCompressionReplacesLiveToolTurnContext(): Promise<void> {
  const oldPrefix = `OLD_CONTEXT_PREFIX_${'x'.repeat(4000)}`;
  const transientContinuation = 'TRANSIENT_COMPRESSION_CONTINUATION';
  let compressionCount = 0;
  let providerCalls = 0;
  const providerContexts: AgentMessage[][] = [];
  const kernel = new KernelAgent({
    initialState: {
      model: MODEL,
      messages: [{ role: 'user', content: oldPrefix, timestamp: Date.now() }],
      tools: [{
        name: 'step',
        label: 'step',
        description: '',
        parameters: {},
        execute: async () => ({ content: [{ type: 'text', text: 'step-ok' }] }),
      }],
    },
    transformContext: async messages => {
      const text = JSON.stringify(messages);
      if (!text.includes('OLD_CONTEXT_PREFIX')) return messages;
      compressionCount += 1;
      const replacementMessages: AgentMessage[] = [{ role: 'user', content: 'COMPRESSED_CONTEXT', timestamp: Date.now() }];
      return {
        messages: [...replacementMessages, { role: 'user', content: transientContinuation, timestamp: Date.now() }],
        replacementMessages,
      };
    },
    streamFn: async (_model, context) => {
      providerCalls += 1;
      providerContexts.push(context.messages.slice());
      const stream = createAssistantMessageEventStream();
      const message = providerCalls === 1
        ? { ...assistant(''), content: [{ type: 'toolCall', id: 'step-call', name: 'step', arguments: {} } as any], stopReason: 'toolUse' as const }
        : assistant('done after compression');
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason, message }));
      return stream;
    },
  });

  await kernel.prompt('current task');
  assert.equal(providerCalls, 2, 'the tool receipt starts one provider continuation');
  assert.equal(compressionCount, 1, 'one stale source context is compressed exactly once across tool subturns');
  assert.match(JSON.stringify(providerContexts[0]), /TRANSIENT_COMPRESSION_CONTINUATION/,
    'the immediate post-compression request receives the one-time continuation prompt');
  assert.doesNotMatch(JSON.stringify(providerContexts[1]), /OLD_CONTEXT_PREFIX|TRANSIENT_COMPRESSION_CONTINUATION/,
    'later tool subturns use the durable compressed context without the stale prefix or transient prompt');
  assert.match(JSON.stringify(providerContexts[1]), /COMPRESSED_CONTEXT|step-ok/,
    'the durable replacement continues with new assistant and tool messages appended');
  assert.doesNotMatch(JSON.stringify(kernel.state.messages), /OLD_CONTEXT_PREFIX|TRANSIENT_COMPRESSION_CONTINUATION/,
    'kernel state persists only the durable compressed context for later runs');
}

class ClosedGateRunner extends Agent {
  readonly enteredFirstProcess: Promise<void>;
  private signalEntered!: () => void;
  private releaseFirst!: () => void;
  private readonly firstRelease: Promise<void>;
  private gateClosed = false;
  readonly inputs: Array<string | AgentPromptMessage> = [];

  constructor(root: string) {
    super(root, { agentOnly: true });
    this.enteredFirstProcess = new Promise(resolve => { this.signalEntered = resolve; });
    this.firstRelease = new Promise(resolve => { this.releaseFirst = resolve; });
  }

  release(): void { this.releaseFirst(); }

  override queueActiveKernelMessage(
    content: string,
    queueMode: 'steer' | 'followUp',
    clientMessageId?: string,
    runId?: string,
    images?: Array<{ dataUrl: string; name?: string; type?: string }>,
  ): boolean {
    if (this.gateClosed) return false;
    return super.queueActiveKernelMessage(content, queueMode, clientMessageId, runId, images);
  }

  override async process(input: string | AgentPromptMessage): Promise<StreamToken[]> {
    this.inputs.push(input);
    if (typeof input !== 'string' && input.clientMessageId) {
      this.persistGuideMessage(input.clientMessageId, input.text, input.runId);
      this.notifyAgentKernelUserMessageStart(input.text, input.clientMessageId);
    }
    if (this.inputs.length === 1) {
      this.gateClosed = true;
      this.signalEntered();
      await this.firstRelease;
    }
    return [{ type: 'text', text: `reply-${this.inputs.length}` }];
  }
}

async function verifyTaskBoundaryGuideIsDeferredAndContinued(): Promise<void> {
  const root = path.join(process.cwd(), 'test-tmp-guide-deferred');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  let runner: ClosedGateRunner | undefined;
  try {
    const { target, workspace } = workspaceFixture(root);
    const host = new Agent(root, { agentOnly: true });
    host.workspace.current = workspace;
    host.setConversation('default');
    runner = new ClosedGateRunner(root);
    runner.workspace.current = workspace;
    runner.setConversation('default');
    const conversations = new ConversationKernel(root, host, null, { createRunner: () => runner! });
    const running = conversations.prompt('original prompt', target, {
      mode: 'build',
      model: runner.model,
      intelligence: runner.intelligence,
      inputMode: 'guide',
      engine: runner.engine,
    });
    await runner.enteredFirstProcess;
    const runtime = conversations.runtimeState(target);
    assert.ok(runtime?.runId);

    const deferred = await new Promise<GuideReceipt>(resolve => {
      setImmediate(() => resolve(conversations.enqueueGuide({
        clientMessageId: 'guide-after-close-task',
        target,
        runId: runtime!.runId,
        deliveryMode: 'steer',
        text: 'arrived after the worker queue closed',
        createdAt: '2026-07-13T00:04:00.000Z',
      })));
    });
    assert.equal(deferred.status, 'deferred', 'a later IPC task arriving after queue close is retained as deferred');
    runner.release();
    const result = await running;
    assert.equal(runner.inputs.length, 2, 'deferred Guide immediately continues the same logical work run');
    assert.equal(typeof runner.inputs[1] === 'string' ? undefined : runner.inputs[1].clientMessageId, 'guide-after-close-task');
    assert.equal(result.runId, runtime!.runId, 'deferred continuation does not allocate a new runId');
    assert.equal(result.workRuns.find(run => run.runId === runtime!.runId)?.guides[0]?.status, 'applied');
    assert.equal(result.chatMessages.filter(message => message.clientMessageId === 'guide-after-close-task').length, 1);
    assert.equal(runner.history.filter(message => String(message.client_message_id || '') === 'guide-after-close-task').length, 1);
  } finally {
    runner?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

class FinalizeBarrierRunner extends Agent {
  readonly inputs: Array<string | AgentPromptMessage> = [];
  injectGuide: (() => void) | null = null;

  override queueActiveKernelMessage(): boolean {
    return false;
  }

  override async process(input: string | AgentPromptMessage): Promise<StreamToken[]> {
    this.inputs.push(input);
    if (typeof input !== 'string' && input.clientMessageId) {
      this.persistGuideMessage(input.clientMessageId, input.text, input.runId);
      this.notifyAgentKernelUserMessageStart(input.text, input.clientMessageId);
    }
    if (this.inputs.length === 1) {
      // The first microtask lets ConversationKernel resume from runSingle and
      // observe an empty pending queue; the second lands inside its final-drain
      // barrier, immediately before acceptance is atomically closed.
      queueMicrotask(() => queueMicrotask(() => this.injectGuide?.()));
    }
    return [{ type: 'text', text: `reply-${this.inputs.length}` }];
  }
}

async function verifyGuideInPendingEmptyFinalizeWindowIsApplied(): Promise<void> {
  const root = path.join(process.cwd(), 'test-tmp-guide-finalize-barrier');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const { target, workspace } = workspaceFixture(root);
    const host = new Agent(root, { agentOnly: true });
    host.workspace.current = workspace;
    host.setConversation('default');
    const runner = new FinalizeBarrierRunner(root, { agentOnly: true });
    runner.workspace.current = workspace;
    runner.setConversation('default');
    const conversations = new ConversationKernel(root, host, null, { createRunner: () => runner });
    let injected: GuideReceipt | null = null;
    runner.injectGuide = () => {
      const state = conversations.runtimeState(target);
      assert.ok(state?.runId);
      injected = conversations.enqueueGuide({
        clientMessageId: 'guide-pending-empty-finalize-window',
        target,
        runId: state!.runId,
        deliveryMode: 'steer',
        text: 'arrived after pending became empty but before finish',
        createdAt: '2026-07-13T00:05:00.000Z',
      });
    };

    const result = await conversations.prompt('original prompt', target, {
      mode: 'build',
      model: runner.model,
      intelligence: runner.intelligence,
      inputMode: 'guide',
      engine: runner.engine,
    });
    assert.equal((injected as GuideReceipt | null)?.status, 'deferred', 'closed worker steering is explicitly retained at the final drain boundary');
    assert.equal(runner.inputs.length, 2, 'finalize barrier reopens the same run and drains the Guide');
    assert.equal(typeof runner.inputs[1] === 'string' ? undefined : runner.inputs[1].clientMessageId,
      'guide-pending-empty-finalize-window');
    const stored = result.workRuns.find(run => run.runId === result.runId)?.guides
      .find(item => item.clientMessageId === 'guide-pending-empty-finalize-window');
    assert.equal(stored?.status, 'applied', 'the precisely injected Guide is applied before the logical run finishes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function verifyGuideFromCompletionEventAutoContinues(): Promise<void> {
  const root = path.join(process.cwd(), 'test-tmp-guide-completion-event');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const { target, workspace } = workspaceFixture(root);
    const host = new Agent(root, { agentOnly: true });
    host.workspace.current = workspace;
    host.setConversation('default');
    const runner = new FinalizeBarrierRunner(root, { agentOnly: true });
    runner.workspace.current = workspace;
    runner.setConversation('default');
    const conversations = new ConversationKernel(root, host, null, { createRunner: () => runner });
    let completionReceipt: GuideReceipt | null = null;
    conversations.subscribe(event => {
      if (completionReceipt || event.type !== 'done' || event.status !== 'completed') return;
      const runtime = conversations.runtimeState(target);
      completionReceipt = conversations.enqueueGuide({
        clientMessageId: 'guide-from-completion-event',
        target,
        runId: runtime?.runId,
        deliveryMode: 'steer',
        text: 'continue immediately after public completion',
        createdAt: '2026-07-13T00:06:00.000Z',
      });
    });
    const result = await conversations.prompt('original prompt', target, {
      mode: 'build', model: runner.model, intelligence: runner.intelligence, inputMode: 'guide', engine: runner.engine,
    });
    assert.ok(completionReceipt);
    assert.equal((completionReceipt as GuideReceipt).status, 'deferred', 'a Guide injected by the completion event is explicitly deferred after gate close');
    assert.equal(runner.inputs.length, 2, 'the deferred completion-window Guide automatically starts its continuation');
    assert.equal(result.workRuns.length, 1, 'completion-window continuation must not allocate a second work run');
    assert.equal(result.workRuns[0]?.runId, result.runId, 'the continued work run retains the original runId');
    const stored = result.workRuns[0]?.guides.find(item => item.clientMessageId === 'guide-from-completion-event');
    assert.equal(stored?.status, 'applied');
    assert.equal(stored?.runId, result.runId, 'Guide receipt remains owned by the original work run');
    const guideEvents = conversations.events(target).filter(event => event.guide?.clientMessageId === 'guide-from-completion-event');
    assert.ok(guideEvents.length >= 2, 'deferred and applied Guide events are both observable');
    assert.ok(guideEvents.every(event => event.runId === result.runId && event.guide?.runId === result.runId),
      'live Guide events and their receipts retain the original runId');
    assert.equal(conversations.snapshot(target).continuations.length, 0, 'applied automatic continuation is removed from durable queue');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

class ReloadedImageGuideRunner extends Agent {
  readonly guideInputs: AgentPromptMessage[] = [];

  override async process(input: string | AgentPromptMessage): Promise<StreamToken[]> {
    if (typeof input !== 'string' && input.clientMessageId) {
      this.guideInputs.push(input);
      const prepared = this.prepareSubmittedConversationImages(input.images);
      const displayText = `${input.text}${input.text ? '\n\n' : ''}[${prepared.images.length} image attachment${prepared.images.length === 1 ? '' : 's'}]`;
      const historyContent = [
        { type: 'text', text: input.text },
        ...prepared.images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
      ];
      this.persistGuideMessage(input.clientMessageId, displayText, input.runId, historyContent, prepared.attachments);
      this.notifyAgentKernelUserMessageStart(input.text, input.clientMessageId);
    }
    return [{ type: 'text', text: 'reloaded-reply' }];
  }
}

async function verifyImageOnlyDeferredGuideSurvivesCheckpointReloadExactlyOnce(): Promise<void> {
  const root = path.join(process.cwd(), 'test-tmp-guide-image-only-reload');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  let blockedRunner: ClosedGateRunner | undefined;
  try {
    const { target, workspace } = workspaceFixture(root);
    const host = new Agent(root, { agentOnly: true });
    host.workspace.current = workspace;
    host.setConversation('default');
    blockedRunner = new ClosedGateRunner(root);
    blockedRunner.workspace.current = workspace;
    blockedRunner.setConversation('default');
    const firstKernel = new ConversationKernel(root, host, null, { createRunner: () => blockedRunner! });
    const firstRun = firstKernel.prompt('original prompt', target, {
      mode: 'build', model: blockedRunner.model, intelligence: blockedRunner.intelligence, inputMode: 'guide', engine: blockedRunner.engine,
    });
    await blockedRunner.enteredFirstProcess;
    const runtime = firstKernel.runtimeState(target);
    assert.ok(runtime?.runId);

    const deferred = firstKernel.enqueueGuide({
      clientMessageId: 'guide-image-only-reload',
      target,
      runId: runtime!.runId,
      deliveryMode: 'steer',
      text: '',
      images: [{ dataUrl: VALID_GUIDE_PNG, name: 'image-only.png', type: 'image/png' }],
      createdAt: '2026-07-15T00:10:00.000Z',
    }) as GuideReceipt & { attachments?: Array<{ id: string; dataUrl?: string }> };
    assert.equal(deferred.status, 'deferred', 'an image-only Guide is deferred after the active worker steering gate closes');
    assert.equal(deferred.attachments?.length, 1, 'accepted/deferred receipt owns a durable attachment reference before chat insertion');
    assert.match(String(deferred.attachments?.[0]?.id || ''), /^user-image-[a-f0-9]{64}$/);

    const stopped = firstKernel.requestStop(target, runtime!.runId);
    assert.equal(stopped.action, 'graceful');
    assert.equal(stopped.checkpointed, true, 'first stop checkpoints the deferred image-only Guide');
    assert.equal(firstKernel.snapshot(target).continuations.length, 1,
      'checkpoint retains an image-only continuation even though its text is empty');
    const checkpointState = fs.readFileSync(path.join(workspace!.path, 'conversations', 'state.json'), 'utf8');
    assert.match(checkpointState, /user-image-[a-f0-9]{64}/,
      'checkpoint stores a stable attachment reference for the deferred Guide');
    assert.doesNotMatch(checkpointState, /data:image\/(?:png|jpe?g);base64,/i,
      'accepted/deferred receipt and continuation metadata do not duplicate content-addressed image bytes in state.json');
    blockedRunner.release();
    await firstRun;

    const reloadedRunner = new ReloadedImageGuideRunner(root, { agentOnly: true });
    const reloadedHost = new Agent(root, { agentOnly: true });
    reloadedHost.workspace.current = workspace;
    reloadedHost.setConversation('default');
    const reloadedKernel = new ConversationKernel(root, reloadedHost, null, { createRunner: () => reloadedRunner });
    const reloadedResult = await reloadedKernel.prompt('resume checkpoint', target, {
      mode: 'build', model: reloadedRunner.model, intelligence: reloadedRunner.intelligence, inputMode: 'guide', engine: reloadedRunner.engine,
    });
    assert.equal(reloadedRunner.guideInputs.length, 1, 'reload applies the retained image-only Guide once');
    assert.equal(reloadedRunner.guideInputs[0].clientMessageId, 'guide-image-only-reload');
    assert.equal(reloadedRunner.guideInputs[0].images?.length, 1);
    assert.equal(reloadedResult.chatMessages.filter(message => message.clientMessageId === 'guide-image-only-reload').length, 1,
      'image-only Guide creates one durable chat row');
    assert.equal(reloadedRunner.history.filter(message => String(message.client_message_id || '') === 'guide-image-only-reload').length, 1,
      'image-only Guide creates one model-history row');
    const appliedReceipt = reloadedResult.workRuns.flatMap(run => run.guides)
      .find(item => item.clientMessageId === 'guide-image-only-reload') as GuideReceipt & { attachments?: Array<{ id: string; dataUrl?: string }> } | undefined;
    assert.equal(appliedReceipt?.status, 'applied', 'empty natural-language content does not prevent the image-only Guide receipt from becoming applied');
    assert.equal(appliedReceipt?.attachments?.[0]?.id, deferred.attachments?.[0]?.id,
      'the applied receipt preserves the same content-addressed attachment identity');
    assert.ok(String(appliedReceipt?.attachments?.[0]?.dataUrl || '').startsWith('data:image/png;base64,'),
      'snapshot hydration restores the durable receipt attachment for the UI');
    assert.equal(reloadedKernel.snapshot(target).continuations.length, 0, 'successful application consumes the durable continuation');

    const secondRunner = new ReloadedImageGuideRunner(root, { agentOnly: true });
    const secondHost = new Agent(root, { agentOnly: true });
    secondHost.workspace.current = workspace;
    secondHost.setConversation('default');
    const secondKernel = new ConversationKernel(root, secondHost, null, { createRunner: () => secondRunner });
    const secondResult = await secondKernel.prompt('second reload', target, {
      mode: 'build', model: secondRunner.model, intelligence: secondRunner.intelligence, inputMode: 'guide', engine: secondRunner.engine,
    });
    assert.equal(secondRunner.guideInputs.length, 0, 'a consumed image-only continuation is not replayed after another reload');
    assert.equal(secondResult.chatMessages.filter(message => message.clientMessageId === 'guide-image-only-reload').length, 1);
    assert.equal(secondRunner.history.filter(message => String(message.client_message_id || '') === 'guide-image-only-reload').length, 1);
  } finally {
    blockedRunner?.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function workspaceFixture(root: string): { target: ConversationTarget; workspace: Agent['workspace']['current'] } {
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspacePath, 'conversations'), { recursive: true });
  return {
    target: { workspaceId: 'workspace-guide-test', conversationId: 'default' },
    workspace: {
      name: 'workspace-guide-test',
      path: workspacePath,
      isInternal: false,
      hostBinding: '',
      icon: '',
      kind: 'local',
    },
  };
}

function receipt(target: ConversationTarget, status: GuideReceipt['status']): GuideReceipt {
  return {
    clientMessageId: 'guide-exactly-once',
    target,
    runId: 'run-guide-test',
    status,
    content: 'same guide text',
    createdAt: '2026-07-13T00:00:01.000Z',
    updatedAt: status === 'accepted' ? '2026-07-13T00:00:01.000Z' : '2026-07-13T00:00:02.000Z',
  };
}

function verifyExactlyOnceAndV3Persistence(): void {
  const root = path.join(process.cwd(), 'test-tmp-guide-work-run');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const { target, workspace } = workspaceFixture(root);
    const agent = new Agent(root, { agentOnly: true });
    agent.workspace.current = workspace;
    agent.setConversation('default');
    let routedGuide: unknown;
    agent.attachAgentKernelRuntime({ steer: message => { routedGuide = message; return true; }, followUp: () => true });
    assert.equal(agent.queueActiveKernelMessage('visual guide', 'steer', 'visual-guide-id', 'run-guide-test', [{
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=',
      name: 'guide.png',
      type: 'image/png',
    }]), true);
    const routedContent = (routedGuide as { content?: unknown })?.content;
    assert.ok(Array.isArray(routedContent) && routedContent.some(item => (item as { type?: string }).type === 'image'),
      'active Guide preserves structured image attachments');
    agent.attachAgentKernelRuntime(null);
    agent.beginConversationWorkRun('run-guide-test', target, '2026-07-13T00:00:00.000Z');

    assert.equal(agent.persistGuideMessage('guide-exactly-once', 'same guide text'), true);
    assert.equal(agent.persistGuideMessage('guide-exactly-once', 'same guide text'), false,
      'replaying one clientMessageId does not duplicate chat/history');
    assert.equal(agent.persistGuideMessage('guide-same-text-new-id', 'same guide text'), true,
      'the same text under a different ID is a distinct Guide');
    assert.equal(agent.persistGuideMessage('guide-repair-history', 'repair missing history'), true);
    agent.history = agent.history.filter(message => String(message.client_message_id || '') !== 'guide-repair-history');
    assert.equal(agent.persistGuideMessage('guide-repair-history', 'repair missing history'), true,
      'replay repairs a missing history side without duplicating its chat row');
    assert.equal(agent.chatMessages.filter(message => message.clientMessageId === 'guide-repair-history').length, 1);
    assert.equal(agent.history.filter(message => String(message.client_message_id || '') === 'guide-repair-history').length, 1);
    assert.equal(agent.persistGuideMessage('guide-repair-chat', 'repair missing chat'), true);
    agent.chatMessages = agent.chatMessages.filter(message => message.clientMessageId !== 'guide-repair-chat');
    assert.equal(agent.persistGuideMessage('guide-repair-chat', 'repair missing chat'), true,
      'replay repairs a missing chat side without duplicating its model-history row');
    assert.equal(agent.chatMessages.filter(message => message.clientMessageId === 'guide-repair-chat').length, 1);
    assert.equal(agent.history.filter(message => String(message.client_message_id || '') === 'guide-repair-chat').length, 1);

    agent.recordGuideReceipt(receipt(target, 'accepted'));
    agent.recordGuideReceipt(receipt(target, 'applied'));
    assert.equal(agent.setConversationWorkRunExpanded('run-guide-test', false), true,
      'a running work run accepts a persisted collapse preference');
    assert.equal(agent.workRuns[0].expanded, false,
      'the running work run remains collapsed until the user expands it');
    assert.equal(agent.setConversationWorkRunExpanded('run-guide-test', true), true,
      'a running work run can be expanded again');
    agent.emitWorkEvent({ type: 'status', content: '<think>hidden chain</think>Public progress\nreasoning_content: must-not-persist' });
    agent.emitWorkEvent({ type: 'thinking_delta', content: 'hidden delta must-not-persist' } as never);
    agent.emitWorkEvent({ type: 'status', content: 'Public progress only.' });
    agent.emitWorkEvent({ type: 'done', content: 'Response complete.', timestamp: '2026-07-13T00:01:05.000Z' });
    assert.equal(agent.workRuns[0].expanded, true,
      'a completed work run remains expanded so its public transcript stays visible');
    assert.equal(agent.setConversationWorkRunExpanded('run-guide-test', false), true,
      'a completed work run can still be folded manually');
    assert.equal(agent.setConversationWorkRunExpanded('run-guide-test', true), true,
      'a manually folded completed work run can be expanded again');
    agent.workRuns[0].events.push({
      id: 'legacy-hidden-reasoning-event',
      conversationId: 'default',
      type: 'reasoning_content',
      content: 'legacy hidden must-not-persist',
      mode: 'build',
      model: 'guide-test',
      timestamp: '00:01:06',
    } as unknown as AgentWorkEvent);
    agent.workRuns[0].events.push({
      id: 'legacy-think-tag-event',
      conversationId: 'default',
      type: 'status',
      content: '<think>legacy hidden must-not-persist</think>public tail',
      mode: 'build',
      model: 'guide-test',
      timestamp: '00:01:07',
    } as AgentWorkEvent);
    agent.workRuns[0].events.push({
      id: 'legacy-tool-call-with-private-arguments',
      conversationId: 'default',
      type: 'tool_call',
      content: 'Calling tool example_tool with PRIVATE_COMMAND_BODY',
      toolName: 'example_tool',
      toolCallId: 'private-call-id',
      toolArgs: '{"command":"PRIVATE_COMMAND_BODY","path":"PRIVATE_PATH"}',
      mode: 'build',
      model: 'guide-test',
      timestamp: '00:01:08',
    } as AgentWorkEvent);
    agent.workRuns[0].events.push({
      id: 'legacy-tool-result-with-private-output',
      conversationId: 'default',
      type: 'tool_result',
      content: 'PRIVATE_TOOL_RESULT_BODY',
      toolName: 'example_tool',
      toolCallId: 'private-call-id',
      mode: 'build',
      model: 'guide-test',
      timestamp: '00:01:09',
    } as AgentWorkEvent);

    agent.beginConversationWorkRun('run-interrupted-test', target, '2026-07-13T00:02:00.000Z');
    agent.finishConversationWorkRun('run-interrupted-test', 'interrupted', '2026-07-13T00:02:03.000Z');
    agent.finishConversationWorkRun('run-interrupted-test', 'force_interrupted', '2026-07-13T00:02:04.000Z');

    agent.beginConversationWorkRun('run-managed-continuation', target, '2026-07-13T00:03:00.000Z', true);
    agent.emitWorkEvent({ type: 'done', content: 'Provider turn boundary.', timestamp: '2026-07-13T00:03:02.000Z' });
    assert.equal(agent.workRuns.find(run => run.runId === 'run-managed-continuation')?.status, 'running',
      'a managed logical run stays open across provider-turn continuations');
    agent.finishConversationWorkRun('run-managed-continuation', 'completed', '2026-07-13T00:03:05.000Z');

    const statePath = path.join(workspace!.path, 'conversations', 'state.json');
    const raw = fs.readFileSync(statePath, 'utf-8');
    const stored = JSON.parse(raw) as {
      version: number;
      conversations: Record<string, { workRuns?: Array<Record<string, unknown>> }>;
    };
    assert.equal(stored.version, 3);
    assert.ok(!/<think>|thinking_delta|reasoning(?:_content)?|hidden delta|legacy hidden/i.test(raw),
      'hidden reasoning event types and marked content never enter state.json');
    assert.match(raw, /PRIVATE_COMMAND_BODY/, 'sanitized command arguments persist for the owning Build activity expansion');
    assert.match(raw, /PRIVATE_PATH/, 'sanitized path arguments persist for the owning Build activity expansion');
    assert.doesNotMatch(raw, /PRIVATE_TOOL_RESULT_BODY|private-call-id/,
      'legacy and current work runs never retain raw result bodies or private call IDs');
    assert.match(raw, /example_tool/, 'the public work run still records which tool was used');
    const runs = Object.values(stored.conversations).flatMap(item => item.workRuns || []);
    assert.equal(runs.length, 3);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].expanded, true);
    assert.equal((runs[0].guides as GuideReceipt[]).length, 1, 'Guide receipt updates replace by ID instead of appending duplicates');
    assert.equal((runs[0].guides as GuideReceipt[])[0].status, 'applied');
    assert.equal(runs[1].status, 'force_interrupted');
    assert.equal(runs[1].expanded, true);
    assert.equal(runs[2].status, 'completed');
    assert.deepEqual(agent.chatMessages.filter(message => message.clientMessageId).map(message => message.clientMessageId).sort(), [
      'guide-exactly-once',
      'guide-repair-chat',
      'guide-repair-history',
      'guide-same-text-new-id',
    ].sort());

    const restarted = new Agent(root, { agentOnly: true });
    restarted.workspace.current = workspace;
    restarted.setConversation('default');
    const snapshot = restarted.getConversationSnapshot('default');
    assert.equal(snapshot.workRuns.length, 3);
    assert.equal(snapshot.workRuns[0].expanded, true, 'manual completed-fold preference survives reload');
    const sequences = snapshot.workRuns[0].events.map(event => Number(event.sequence || 0));
    assert.deepEqual(sequences, sequences.slice().sort((a, b) => a - b), 'persisted public events retain strict sequence order');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function verifyStatefulHiddenReasoningAndLiveToolArgsSanitization(): void {
  const root = path.join(process.cwd(), 'test-tmp-hidden-stream-filter');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const { target, workspace } = workspaceFixture(root);
    const agent = new Agent(root, { agentOnly: true });
    agent.workspace.current = workspace;
    agent.setConversation('default');
    agent.beginConversationWorkRun('hidden-stream-run', target, '2026-07-13T00:07:00.000Z');
    const live: AgentWorkEvent[] = [];
    agent.subscribeWorkEvents(event => live.push(event));
    const chunks = [
      '<thi', 'nk>never expose this interrupted secret', '</think>',
      'rea', 'soning_', 'content: split reasoning secret', '\nvisible answer',
      '\nthinking_', 'delta: split thinking secret', '\nvisible tail',
    ];
    const ordinaryChunks = ['Hello', ' world', ', this', ' is', ' streamed.'];
    const ordinaryPieces = ordinaryChunks.map(chunk => filterPublicAssistantDelta(agent, chunk));
    const ordinaryVisible = ordinaryPieces.join('');
    assert.equal(ordinaryVisible, 'Hello world, this is streamed.', 'streaming sanitation preserves inter-chunk whitespace');
    for (const piece of ordinaryPieces) agent.emitWorkEvent({ type: 'text', content: piece });
    assert.equal(live.filter(event => event.type === 'text').map(event => event.content).join(''), ordinaryVisible,
      'live work events preserve the same inter-chunk whitespace as public tokens');
    resetPublicAssistantDeltaFilter(agent);
    for (const chunk of chunks) {
      const visible = filterPublicAssistantDelta(agent, chunk);
      if (visible) agent.emitWorkEvent({ type: 'text', content: visible });
    }
    filterPublicAssistantDelta(agent, '<think>unfinished hidden stream');
    resetPublicAssistantDeltaFilter(agent);
    agent.emitWorkEvent({
      type: 'tool_call',
      content: 'Calling tool example with LIVE_PRIVATE_COMMAND',
      toolName: 'example',
      toolCallId: 'live-private-call-id',
      toolArgs: '{"command":"LIVE_PRIVATE_COMMAND","path":"LIVE_PRIVATE_PATH"}',
    });
    agent.emitWorkEvent({
      type: 'tool_result',
      content: 'LIVE_PRIVATE_RESULT',
      toolName: 'example',
      toolCallId: 'live-private-call-id',
    });
    const liveToolEvents = live.filter(event => event.type === 'tool_call' || event.type === 'tool_result');
    assert.equal(liveToolEvents.length, 2);
    assert.ok(liveToolEvents.every(event => event.toolName === 'example'), 'live work events expose the tool name');
    assert.equal(liveToolEvents[0].toolArgs, '{"command":"LIVE_PRIVATE_COMMAND","path":"LIVE_PRIVATE_PATH"}',
      'live tool calls retain sanitized expandable arguments inside their owning Build event');
    assert.ok(liveToolEvents.every(event => event.toolCallId === undefined),
      'live public work events still drop private call identifiers at the publication boundary');
    assert.doesNotMatch(JSON.stringify(liveToolEvents), /LIVE_PRIVATE_RESULT|live-private-call-id/,
      'live work events never publish raw tool results or private call IDs');
    const liveSnapshot = agent.getConversationSnapshot('default');
    const snapshotToolEvents = liveSnapshot.workRuns.flatMap(run => run.events)
      .filter(event => event.type === 'tool_call' || event.type === 'tool_result');
    assert.equal(snapshotToolEvents.length, 2,
      'active conversation snapshots read the live work-run state instead of a stale persisted start event');
    assert.match(JSON.stringify(snapshotToolEvents), /LIVE_PRIVATE_COMMAND/,
      'active snapshots retain the sanitized tool detail used by the inline Build expansion');
    assert.doesNotMatch(JSON.stringify(snapshotToolEvents), /LIVE_PRIVATE_RESULT|live-private-call-id/,
      'active snapshots still exclude raw results and private call IDs');
    const visibleArgs = agent.visibleToolArgs(JSON.stringify({
      api_key: 'secret-key',
      reasoning_content: 'TOP_SECRET_REASONING',
      nested: { thinking_delta: 'TOP_SECRET_THINKING', prompt: 'safe' },
      prompt: 'safe',
    }));
    assert.doesNotMatch(visibleArgs, /secret-key/);
    assert.match(visibleArgs, /REDACTED/);
    assert.doesNotMatch(visibleArgs, /reasoning_content|thinking_delta|TOP_SECRET/i, 'structured hidden reasoning keys are removed from visible tool arguments');
    assert.equal(
      agent.sanitizeAssistantOutput('reasoning_content: TOP_SECRET_REASONING\nthinking_delta: TOP_SECRET_THINKING\nVisible answer'),
      'Visible answer',
      'completed-message sanitation cannot reintroduce hidden reasoning lines after streaming ends',
    );
    assert.equal(agent.sanitizeAssistantOutput('<think>unfinished final secret'), '', 'unfinished hidden blocks stay hidden at completion');
    const serializedLive = JSON.stringify(live);
    assert.doesNotMatch(serializedLive, /never expose|unfinished hidden|split reasoning secret|split thinking secret|reasoning_content|LIVE_PRIVATE_RESULT|live-private-call-id/i,
      'stateful hidden reasoning, raw results, and private call IDs never cross the live public-work boundary');
    assert.match(serializedLive, /visible answer/);
    assert.match(serializedLive, /visible tail/);
    agent.finishConversationWorkRun('hidden-stream-run', 'interrupted');
    const stored = fs.readFileSync(path.join(workspace!.path, 'conversations', 'state.json'), 'utf8');
    assert.doesNotMatch(stored, /never expose|unfinished hidden|split reasoning secret|split thinking secret|reasoning_content|LIVE_PRIVATE_RESULT|live-private-call-id/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await verifySteeringWinsTheFinalBoundary();
  await verifySteeringCanArriveBeforeTheFirstProviderTurn();
  await verifyParallelToolBatchBarrier();
  await verifyCompressionReplacesLiveToolTurnContext();
  await verifyTaskBoundaryGuideIsDeferredAndContinued();
  await verifyGuideInPendingEmptyFinalizeWindowIsApplied();
  await verifyGuideFromCompletionEventAutoContinues();
  await verifyImageOnlyDeferredGuideSurvivesCheckpointReloadExactlyOnce();
  verifyExactlyOnceAndV3Persistence();
  verifyStatefulHiddenReasoningAndLiveToolArgsSanitization();
  console.log('Guide and work-run verification passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
