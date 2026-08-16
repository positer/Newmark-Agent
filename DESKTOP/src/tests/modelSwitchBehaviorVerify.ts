/**
 * dev-0.4.4 model-switch behavior gate.
 *
 * Locks the contract the GUI context window and queue rely on:
 *
 *   1. A model switch while a Build block is running does NOT change the
 *      in-flight block's model; the block finishes on the model it started.
 *   2. The switch takes effect the next time a queued Guide/Next re-enters the
 *      block (Guide steering, or a follow-up dequeue, both follow the newly
 *      selected model).
 *   3. Queued messages carry no send-time model; the model used at dequeue is
 *      the current conversation selection recorded on the runtime options.
 *
 * Run: npm run build && node dist/tests/modelSwitchBehaviorVerify.js
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
} from '../core/conversationKernel';
import { ConversationTarget, StreamToken } from '../core/types';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-model-switch-'));
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

function runOptions(model: string): ConversationKernelRunOptions {
  return { mode: 'build', model, intelligence: 'medium', inputMode: 'guide', engine: 'builtin' };
}

/**
 * Probe replacing the real Agent kernel with a short scripted turn. It records
 * the model the runner was bound to at each process() call, and forces queued
 * Guides onto the pendingNextTurn path (queueActiveKernelMessage returns false)
 * so the conversation kernel's own dequeue seam is what decides the model.
 */
class ModelSwitchProbe extends Agent {
  public processModels: string[] = [];
  public delayMs = 20;

  override queueActiveKernelMessage(_content: string, _queueMode: 'steer' | 'followUp'): boolean {
    return false;
  }

  override async process(input: string | AgentPromptMessage): Promise<StreamToken[]> {
    this.processModels.push(this.model);
    const text = typeof input === 'string' ? input : input.text;
    await new Promise(resolve => setTimeout(resolve, this.delayMs));
    return [{ type: 'text', text: `done:${text}` }];
  }
}

interface Harness {
  kernel: ConversationKernel;
  probe: ModelSwitchProbe;
  target: ConversationTarget;
}

function makeHarness(root: string, conversationId: string): Harness {
  const host = new Agent(path.join(root, `host-${conversationId}`));
  const probe = new ModelSwitchProbe(path.join(root, `probe-${conversationId}`), { agentOnly: true });
  const kernel = new ConversationKernel(root, host, null, {
    createRunner(target) {
      if (target.conversationId !== conversationId) {
        throw new Error(`Unexpected probe conversation ${target.conversationId}`);
      }
      return probe;
    },
  });
  const target: ConversationTarget = { workspaceId: 'model-switch-workspace', conversationId };
  return { kernel, probe, target };
}

async function main(): Promise<void> {
  const root = tempRoot();
  try {
    // 1. In-flight block keeps its model after a mid-block switch.
    const h = makeHarness(root, 'switch-inflight');
    h.probe.delayMs = 30;
    const running = h.kernel.prompt('first', h.target, runOptions('m1'), 'steer');
    await wait(5);
    h.kernel.setModel(h.target, 'm2');
    assertOk(h.probe.model === 'm1', 'in-flight block keeps its model immediately after setModel');
    await running;
    assertOk(h.probe.processModels.length === 1 && h.probe.processModels[0] === 'm1',
      'in-flight block completes on the original model');

    // 2. A Guide steering the same block after a mid-block switch re-enters with
    //    the newly selected model.
    const g = makeHarness(root, 'switch-guide');
    g.probe.delayMs = 30;
    const guideRun = g.kernel.prompt('build-one', g.target, runOptions('m1'), 'steer');
    await wait(5);
    g.kernel.setModel(g.target, 'm2');
    g.kernel.enqueueGuide({
      clientMessageId: 'switch-guide-1',
      target: g.target,
      deliveryMode: 'steer',
      text: 'guide-after-switch',
      createdAt: new Date().toISOString(),
    });
    await guideRun;
    assertOk(g.probe.processModels.length === 2
      && g.probe.processModels[0] === 'm1'
      && g.probe.processModels[1] === 'm2',
      'Guide dequeued after a mid-block switch re-enters the block with the newly selected model');

    // 3. A queued follow-up carries no send-time model: its dequeue follows the
    //    current conversation selection (m2), not the model supplied on send.
    const q = makeHarness(root, 'switch-queue');
    q.probe.delayMs = 30;
    const queueRun = q.kernel.prompt('build-one', q.target, runOptions('m1'), 'steer');
    await wait(5);
    q.kernel.setModel(q.target, 'm2');
    // Send-time model is deliberately m3; the queued message must ignore it.
    await q.kernel.prompt('queued-next', q.target, runOptions('m3'), 'followUp');
    await queueRun;
    assertOk(q.probe.processModels.length === 2
      && q.probe.processModels[0] === 'm1'
      && q.probe.processModels[1] === 'm2',
      'queued follow-up dequeues on the current selection, ignoring the send-time model');

    console.log(`\nmodelSwitchBehaviorVerify: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } finally {
    cleanup(root);
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
