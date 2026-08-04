/**
 * dev-0.3.0 Guide insertion stress gate.
 *
 * Continuous-feedback stress for the conversation kernel's Guide delivery
 * seams. It exercises the three high-risk insertion positions the desktop
 * UI can hit while a Build is running:
 *
 *   1. Standard mid-turn insertion (Guide steering burst while the first
 *      provider turn is still in flight; kernel-accepted and fallback paths).
 *   2. Pre-first-response insertion (a Guide arriving before the first
 *      assistant response has been produced, including the receipt-tracked
 *      enqueueGuide path and stale-run rejection).
 *   3. End-of-build-block insertion (a Guide submitted synchronously by a
 *      consumer of the public completion event; the persisted work run must
 *      be reopened and the Guide must become the next segment of the same
 *      Build), plus post-completion insertion = next Build block start.
 *
 * It also covers Build/Plan/Goal/Flow continuous feedback: Goal-mode
 * autonomous continuation after completion (bounded, never overtaking user
 * input) and Next/Flow-style follow-up steps queueing visibly and draining
 * continuously inside one run.
 *
 * Run: npm run build && node dist/tests/guideInsertionStressVerify.js
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';
import {
  ConversationKernel,
  AgentPromptMessage,
  ConversationKernelRunOptions,
  ConversationTargetInput,
} from '../core/conversationKernel';
import { ConversationInputEnvelope, ConversationTarget, GuideReceipt, StreamToken } from '../core/types';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-guide-insertion-'));
}

function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

let passed = 0;
let failed = 0;

function assertOk(cond: boolean, name: string, detail?: string): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`); }
  assert.ok(cond, name);
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runMany(count: number, fn: (index: number) => Promise<void>): Promise<void[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => fn(index)));
}

function runOptions(mode: ConversationKernelRunOptions['mode'], inputMode: ConversationKernelRunOptions['inputMode'] = 'guide'): ConversationKernelRunOptions {
  return { mode, model: 'test-model', intelligence: 'medium', inputMode, engine: 'builtin' };
}

/**
 * Probe replacing the real Agent kernel with a scripted 25ms provider turn.
 * Records every kernel-visible seam: process calls (with the live runId),
 * steering delivery, guide receipts, work-run resume/finish, and goal
 * continuation claims. `submitTailGuideOnFinish` simulates a consumer of the
 * public completion event submitting a Guide synchronously.
 */
class GuideInsertionProbe extends Agent {
  public processCalls: Array<{ input: string; runId: string }> = [];
  public steered: Array<{ content: string; queueMode: 'steer' | 'followUp' }> = [];
  public receipts: GuideReceipt[] = [];
  public finishCalls: Array<{ runId: string; status?: string }> = [];
  public resumeCalls = 0;
  public acceptKernelMessages = true;
  public submitTailGuideOnFinish = false;
  public maxContinuationClaims = 1;
  public kernel: ConversationKernel | null = null;
  public probeTarget: ConversationTarget | null = null;
  public delayMs = 25;
  private tailSubmitted = false;
  private continuationClaims = 0;

  override queueActiveKernelMessage(content: string, queueMode: 'steer' | 'followUp'): boolean {
    this.steered.push({ content, queueMode });
    return this.acceptKernelMessages;
  }

  override recordWorkStatus(_content: string): void {}

  override setConversation(id: string): string { this.activeConversationId = id; return id; }

  override recordGuideReceipt(receipt: GuideReceipt): GuideReceipt {
    this.receipts.push({ ...receipt });
    return super.recordGuideReceipt(receipt);
  }

  override resumeConversationWorkRun(runId: string): boolean {
    this.resumeCalls += 1;
    return super.resumeConversationWorkRun(runId);
  }

  override claimGoalContinuationMessage(): AgentPromptMessage | null {
    this.continuationClaims += 1;
    if (this.continuationClaims > this.maxContinuationClaims) return null;
    return super.claimGoalContinuationMessage();
  }

  override finishConversationWorkRun(runId: string, status: 'error' | 'completed' | 'interrupted' | 'force_interrupted', endedAt?: string): boolean {
    this.finishCalls.push({ runId, status });
    if (this.submitTailGuideOnFinish && !this.tailSubmitted && status === 'completed' && this.kernel && this.probeTarget) {
      this.tailSubmitted = true;
      this.kernel.enqueueGuide({
        clientMessageId: `tail-guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        target: this.probeTarget,
        deliveryMode: 'steer',
        text: 'guide-tail',
        createdAt: new Date().toISOString(),
      });
    }
    return super.finishConversationWorkRun(runId, status, endedAt);
  }

  override async process(input: string | AgentPromptMessage): Promise<StreamToken[]> {
    const text = typeof input === 'string' ? input : input.text;
    const runId = this.kernel && this.probeTarget
      ? this.kernel.snapshot(this.probeTarget).runtime?.runId || ''
      : '';
    this.processCalls.push({ input: text, runId });
    if (typeof input !== 'string' && input.clientMessageId) {
      this.notifyAgentKernelUserMessageStart(text, input.clientMessageId);
    }
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    return [{ type: 'text', text: `done:${text}` }];
  }
}

interface Harness {
  kernel: ConversationKernel;
  probe: GuideInsertionProbe;
  target: ConversationTarget;
}

function makeHarness(root: string, conversationId: string): Harness {
  const host = new Agent(path.join(root, `host-${conversationId}`));
  const probe = new GuideInsertionProbe(path.join(root, `probe-${conversationId}`), { agentOnly: true });
  const kernel = new ConversationKernel(root, host, null, {
    createRunner(target) {
      if (target.conversationId !== conversationId) throw new Error(`Unexpected probe conversation ${target.conversationId}`);
      return probe;
    },
  });
  const target: ConversationTarget = { workspaceId: 'guide-workspace', conversationId };
  probe.kernel = kernel;
  probe.probeTarget = target;
  return { kernel, probe, target };
}

// ---------------------------------------------------------------------------
// 1. Standard mid-turn insertion
// ---------------------------------------------------------------------------
async function scenarioMidTurnInsertion(root: string): Promise<void> {
  // 1a. Kernel-accepted burst: 8 concurrent Guides while the first turn is
  // active are all steered into the active kernel; the run stays one process.
  const h = makeHarness(root, 'mid-accepted');
  const p1 = h.kernel.prompt('first', h.target, runOptions('build'), 'steer');
  await wait(2);
  await runMany(8, async i => {
    h.kernel.prompt(`guide-${i}`, h.target, runOptions('build'), 'steer');
  });
  await p1;
  assertOk(h.probe.processCalls.length === 1 && h.probe.processCalls[0].input === 'first',
    'mid-turn kernel-accepted: exactly one active process');
  assertOk(h.probe.steered.length === 8
    && h.probe.steered.map(s => s.content).join(',') === Array.from({ length: 8 }, (_, i) => `guide-${i}`).join(',')
    && h.probe.steered.every(s => s.queueMode === 'steer'),
    'mid-turn kernel-accepted: steering delivered in submission order');
  assertOk(h.kernel.queued(h.target).steering.length === 0 && h.kernel.queued(h.target).followUp.length === 0,
    'mid-turn kernel-accepted: visible queue stays empty');
  assertOk(h.probe.finishCalls.filter(f => f.status === 'completed').length === 1,
    'mid-turn kernel-accepted: one completed work run');

  // 1b. Fallback burst: when the kernel cannot accept, Guides are retained as
  // pending next turns and drained continuously inside the SAME run.
  const h2 = makeHarness(root, 'mid-fallback');
  h2.probe.acceptKernelMessages = false;
  const p2 = h2.kernel.prompt('first', h2.target, runOptions('build'), 'steer');
  await wait(2);
  await runMany(8, async i => {
    h2.kernel.prompt(`guide-${i}`, h2.target, runOptions('build'), 'steer');
  });
  await p2;
  assertOk(h2.probe.processCalls.map(c => c.input).join(',')
    === ['first', ...Array.from({ length: 8 }, (_, i) => `guide-${i}`)].join(','),
    'mid-turn fallback: Guides drain continuously in submission order');
  assertOk(new Set(h2.probe.processCalls.map(c => c.runId)).size === 1,
    'mid-turn fallback: all segments run inside one work run');
  assertOk(h2.probe.finishCalls.filter(f => f.status === 'completed').length === 1,
    'mid-turn fallback: single completion for the continuous run');
  assertOk(h2.kernel.queued(h2.target).steering.length === 0 && h2.kernel.queued(h2.target).followUp.length === 0,
    'mid-turn fallback: visible queue drains to empty');
}

// ---------------------------------------------------------------------------
// 2. Pre-first-response insertion
// ---------------------------------------------------------------------------
async function scenarioPreFirstResponse(root: string): Promise<void> {
  // 2a. A Guide submitted before the first assistant response is produced is
  // steered into the active kernel without becoming a second process call.
  const h = makeHarness(root, 'pre-accepted');
  const p1 = h.kernel.prompt('build-1', h.target, runOptions('build'), 'steer');
  const p2 = h.kernel.prompt('guide-pre', h.target, runOptions('build'), 'steer');
  const r = await Promise.all([p1, p2]);
  assertOk(h.probe.processCalls.length === 1 && h.probe.processCalls[0].input === 'build-1',
    'pre-first-response kernel-accepted: guide never becomes a separate turn');
  assertOk(h.probe.steered.some(s => s.content === 'guide-pre' && s.queueMode === 'steer'),
    'pre-first-response kernel-accepted: guide delivered as steering');
  assertOk(r[0].runId === r[1].runId && r[0].runId === h.probe.processCalls[0].runId,
    'pre-first-response kernel-accepted: same run settles both handles');

  // 2b. Fallback path: the pre-first-response Guide is retained and processed
  // as the immediate next segment of the same build run.
  const h2 = makeHarness(root, 'pre-fallback');
  h2.probe.acceptKernelMessages = false;
  const p2b = h2.kernel.prompt('build-1', h2.target, runOptions('build'), 'steer');
  await wait(1);
  const p2c = h2.kernel.prompt('guide-pre', h2.target, runOptions('build'), 'steer');
  await Promise.all([p2b, p2c]);
  assertOk(h2.probe.processCalls.map(c => c.input).join(',') === 'build-1,guide-pre',
    'pre-first-response fallback: guide becomes the next segment after the first response');
  assertOk(new Set(h2.probe.processCalls.map(c => c.runId)).size === 1,
    'pre-first-response fallback: one continuous work run');

  // 2c. Receipt-tracked enqueueGuide path: accepted while the first turn is
  // in flight; a duplicate id is idempotent; a stale runId is rejected.
  const h3 = makeHarness(root, 'pre-receipt');
  const p3 = h3.kernel.prompt('build-1', h3.target, runOptions('build'), 'steer');
  await wait(5);
  const envelope: ConversationInputEnvelope = {
    clientMessageId: 'g-pre-receipt-1',
    target: h3.target,
    deliveryMode: 'steer',
    text: 'guide-pre-receipt',
    createdAt: new Date().toISOString(),
  };
  const receipt = h3.kernel.enqueueGuide(envelope);
  const duplicate = h3.kernel.enqueueGuide({ ...envelope, createdAt: new Date().toISOString() });
  const stale = h3.kernel.enqueueGuide({
    clientMessageId: 'g-pre-stale',
    target: h3.target,
    deliveryMode: 'steer',
    text: 'guide-pre-stale',
    runId: 'stale-run-123',
    createdAt: new Date().toISOString(),
  });
  await p3;
  assertOk(receipt.status === 'accepted' && duplicate === receipt,
    'pre-first-response receipt: accepted and duplicate submissions are idempotent');
  assertOk(h3.probe.receipts.filter(r => r.clientMessageId === 'g-pre-receipt-1').length === 1,
    'pre-first-response receipt: accepted receipt recorded exactly once');
  assertOk(stale.status === 'rejected' && (stale.reason || '').includes('does not match'),
    'pre-first-response receipt: stale runId Guide is rejected');
  assertOk(h3.probe.processCalls.length === 1 && h3.probe.steered.some(s => s.content === 'guide-pre-receipt'),
    'pre-first-response receipt: accepted guide delivered to the active kernel');
}

// ---------------------------------------------------------------------------
// 3. End-of-build-block insertion (synchronous completion-event consumer)
// ---------------------------------------------------------------------------
async function scenarioEndOfBlock(root: string): Promise<void> {
  const h = makeHarness(root, 'end-block');
  h.probe.submitTailGuideOnFinish = true;
  const result = await h.kernel.prompt('build-tail', h.target, runOptions('build'), 'steer');
  assertOk(h.probe.processCalls.map(c => c.input).join(',') === 'build-tail,guide-tail',
    'end-of-block: completion-event Guide continues as the next segment of the build');
  assertOk(new Set(h.probe.processCalls.map(c => c.runId)).size === 1 && h.probe.processCalls[1].runId === result.runId,
    'end-of-block: same persisted work run is reopened, no new run allocated');
  assertOk(h.probe.resumeCalls === 1,
    'end-of-block: deferred Guide work run resumed exactly once');
  assertOk(h.probe.finishCalls.filter(f => f.status === 'completed').length === 2,
    'end-of-block: run is finalized only after the continued segment drains');
  const tailReceipts = h.probe.receipts.filter(r => r.clientMessageId.startsWith('tail-guide-'));
  assertOk(tailReceipts.some(r => r.status === 'accepted')
    && tailReceipts.some(r => r.status === 'deferred')
    && tailReceipts.some(r => r.status === 'applied'),
    'end-of-block: receipt lifecycle accepted -> deferred -> applied');
  assertOk(h.kernel.queued(h.target).steering.length === 0 && h.kernel.queued(h.target).followUp.length === 0,
    'end-of-block: visible queue stays empty');
}

// ---------------------------------------------------------------------------
// 4. Post-completion insertion = next Build block start
// ---------------------------------------------------------------------------
async function scenarioPostCompletion(root: string): Promise<void> {
  const h = makeHarness(root, 'post-completion');
  const first = await h.kernel.prompt('build-one', h.target, runOptions('plan'), 'followUp');
  assertOk(h.probe.processCalls.length === 1 && h.probe.processCalls[0].runId === first.runId,
    'post-completion: first plan block completes normally');
  const next = await h.kernel.prompt('guide-next', h.target, runOptions('build'), 'steer');
  assertOk(next.runId !== first.runId,
    'post-completion: follow-up Guide starts the next Build block with a fresh run');
  assertOk(h.probe.processCalls.map(c => c.input).join(',') === 'build-one,guide-next',
    'post-completion: sequential continuous responses across blocks');
  assertOk(h.probe.finishCalls.filter(f => f.status === 'completed').length === 2,
    'post-completion: each block closes its own work run');
}

// ---------------------------------------------------------------------------
// 5. Goal-mode continuous feedback
// ---------------------------------------------------------------------------
async function scenarioGoalContinuation(root: string): Promise<void> {
  // 5a. After a goal-mode build completes, the autonomous continuation claims
  // once (bounded) and runs as a new work run. The goal is carried on the
  // prompt itself (goalObjective), the same way the desktop goal bar binds it.
  const h = makeHarness(root, 'goal-cont');
  h.probe.maxContinuationClaims = 1;
  const first = await h.kernel.prompt(
    { text: 'goal-build', goalObjective: 'Finish the scoped goal objective' },
    h.target,
    runOptions('goal', 'next'),
    'followUp',
  );
  assertOk(h.probe.processCalls.length === 1 && h.probe.processCalls[0].input === 'goal-build',
    'goal mode: build block processed once');
  await wait(450);
  assertOk(h.probe.processCalls.length === 2,
    'goal mode: autonomous continuation claimed once after completion');
  assertOk(h.probe.processCalls[1].input.startsWith('Continue working exclusively toward'),
    'goal mode: continuation prompt targets the goal objective');
  assertOk(h.probe.processCalls[1].runId !== h.probe.processCalls[0].runId,
    'goal mode: continuation runs as its own work run');
  await wait(450);
  assertOk(h.probe.processCalls.length === 2,
    'goal mode: continuation chain stays bounded (no runaway loop)');

  // 5b. User input submitted right after completion wins over the pending
  // autonomous claim; the continuation runs once after it, never before.
  const h2 = makeHarness(root, 'goal-gate');
  h2.probe.maxContinuationClaims = 1;
  const gated = await h2.kernel.prompt(
    { text: 'goal-gate', goalObjective: 'Gate the autonomous claim behind user input' },
    h2.target,
    runOptions('goal', 'next'),
    'followUp',
  );
  const guided = await h2.kernel.prompt('guide-wins', h2.target, runOptions('build', 'guide'), 'steer');
  assertOk(guided.runId !== gated.runId,
    'goal gate: user Guide starts a fresh run before the claim timer fires');
  assertOk(h2.probe.processCalls.map(c => c.input).join(',') === 'goal-gate,guide-wins',
    'goal gate: user Guide is processed before any autonomous claim');
  await wait(500);
  assertOk(h2.probe.processCalls.length === 3 && h2.probe.processCalls[2].input.startsWith('Continue working exclusively toward'),
    'goal gate: autonomous continuation never overtakes user input and runs exactly once after it');
  await wait(450);
  assertOk(h2.probe.processCalls.length === 3,
    'goal gate: continuation chain stays bounded');
}

// ---------------------------------------------------------------------------
// 6. Next/Flow-mode continuous feedback
// ---------------------------------------------------------------------------
async function scenarioNextFlowFeedback(root: string): Promise<void> {
  const h = makeHarness(root, 'next-followup');
  h.probe.acceptKernelMessages = false;
  const first = h.kernel.prompt('flow-step', h.target, runOptions('flow', 'next'), 'followUp');
  await wait(2);
  await runMany(4, async i => {
    h.kernel.prompt(`step-${i}`, h.target, runOptions('flow', 'next'), 'followUp');
  });
  const during = h.kernel.queued(h.target);
  assertOk(during.followUp.length === 4,
    'next follow-up: pending steps are visible in the follow-up queue during the active run');
  await first;
  assertOk(h.probe.processCalls[0].input === 'flow-step'
    && h.probe.processCalls.slice(1).every((call, i) => call.input.includes(`step-${i}`)),
    'next follow-up: steps drain continuously in order inside the flow run');
  assertOk(new Set(h.probe.processCalls.map(c => c.runId)).size === 1,
    'next follow-up: one continuous run for the whole flow block');
  assertOk(h.kernel.queued(h.target).followUp.length === 0 && h.kernel.queued(h.target).steering.length === 0,
    'next follow-up: visible follow-up queue drains to empty');
}

async function main(): Promise<void> {
  const root = tempRoot();
  const startedAt = Date.now();
  try {
    console.log('guideInsertionStressVerify');
    await scenarioMidTurnInsertion(root);
    await scenarioPreFirstResponse(root);
    await scenarioEndOfBlock(root);
    await scenarioPostCompletion(root);
    await scenarioGoalContinuation(root);
    await scenarioNextFlowFeedback(root);
    const elapsedMs = Date.now() - startedAt;
    console.log(`guideInsertionStressVerify: ${passed} passed, ${failed} failed, ${elapsedMs} ms`);
    if (failed > 0) process.exitCode = 1;
    else process.exitCode = 0;
  } finally {
    cleanup(root);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
