/**
 * dev-0.3.0 agent runtime v2 verification.
 * Run: npm run build && node dist/tests/agentRuntimeV2Verify.js
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentRunService, recoverRunningAgentRuns } from '../agent-runtime';
import { SubAgentContextService, SubAgentCeiling } from '../subagent-runtime';
import { Agent } from '../core/agent';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-agent-runtime-v2-'));
}

function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  [PASS] ${name}`);
  else console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`);
  assert.ok(cond, name);
}

async function main(): Promise<void> {
  const root = tempRoot();
  try {
    console.log('agentRuntimeV2Verify');

    // -----------------------------------------------------------------------
    // Agent Run state machine
    // -----------------------------------------------------------------------
    const service = new AgentRunService(root);
    const run = service.create({
      conversationId: 'conv-1',
      buildBlockId: 'block-1',
      agentId: 'agent-1',
      agentType: 'main',
      limits: {
        maxIterations: 5,
        maxRunDurationMs: 10 * 60 * 1000,
        maxConsecutiveModelErrors: 2,
        maxConsecutiveToolErrors: 2,
        maxNoProgressIterations: 3,
      },
    });
    check(run.status === 'created', 'run starts in created status');
    check(run.maxIterations === 5, 'run carries custom iteration limit');

    // lease
    const acquired = service.acquireLease(run.id, 'owner-1');
    check(acquired === true, 'lease is acquired by the first owner');
    const secondOwner = service.acquireLease(run.id, 'owner-2');
    check(secondOwner === false, 'a live lease blocks a second owner');
    const takenOver = service.acquireLease(run.id, 'owner-3');
    check(takenOver === false, 'live lease blocks takeover before expiry');

    // A short-lived lease on a separate run expires and allows takeover.
    const expiringRun = service.create({
      conversationId: 'conv-lease',
      buildBlockId: 'block-lease',
      agentId: 'agent-1',
      agentType: 'main',
    });
    service.acquireLease(expiringRun.id, 'dead-owner', 1);
    await new Promise(resolve => setTimeout(resolve, 15));
    const afterExpiry = service.acquireLease(expiringRun.id, 'owner-3');
    check(afterExpiry === true, 'expired lease allows takeover');
    service.releaseLease(expiringRun.id, 'owner-3');

    // transitions
    const recovering = service.markRecovering(run.id);
    check(recovering?.status === 'recovering', 'recovering transition works');
    const preparing = service.transition(run.id, { status: 'preparing_context' });
    check(preparing?.status === 'preparing_context', 'preparing_context transition works');

    // iteration + limits
    for (let i = 0; i < 5; i++) service.advanceIteration(run.id);
    const limitCheck = service.checkLimits(run.id);
    check(limitCheck.paused === true && limitCheck.reason === 'max_iterations', 'max iterations pauses the run');
    const afterPause = service.read(run.id);
    check(afterPause?.status === 'paused' && afterPause.pauseReason === 'max_iterations', 'run is paused, never faked completed');

    // no-progress pause
    const run2 = service.create({
      conversationId: 'conv-1',
      buildBlockId: 'block-2',
      agentId: 'agent-1',
      agentType: 'main',
      limits: { maxNoProgressIterations: 2 },
    });
    service.recordNoProgress(run2.id);
    const npCheck1 = service.checkLimits(run2.id);
    check(npCheck1.paused === false, 'no-progress under limit does not pause');
    service.recordNoProgress(run2.id);
    const npCheck2 = service.checkLimits(run2.id);
    check(npCheck2.paused === true && npCheck2.reason === 'max_no_progress', 'no-progress limit pauses the run');

    // error counters
    const run3 = service.create({
      conversationId: 'conv-1',
      buildBlockId: 'block-3',
      agentId: 'agent-1',
      agentType: 'subagent',
      limits: { maxConsecutiveModelErrors: 2 },
    });
    service.recordModelError(run3.id);
    const errCheck1 = service.checkLimits(run3.id);
    check(errCheck1.paused === false, 'one model error does not pause');
    service.recordModelError(run3.id);
    const errCheck2 = service.checkLimits(run3.id);
    check(errCheck2.paused === true && errCheck2.reason === 'max_consecutive_model_errors', 'consecutive model errors pause the run');
    service.resetModelErrors(run3.id);
    check(service.read(run3.id)?.consecutiveModelErrors === 0, 'model error counter resets');

    // cost accounting
    const run4 = service.create({
      conversationId: 'conv-1',
      buildBlockId: 'block-4',
      agentId: 'agent-1',
      agentType: 'main',
      limits: { maxCumulativeCostUsd: 1.0 },
    });
    service.addCost(run4.id, 0.6);
    check(service.read(run4.id)?.costUsd === 0.6, 'cost is accumulated');
    const costCheck1 = service.checkLimits(run4.id);
    check(costCheck1.paused === false, 'cost under ceiling does not pause');
    service.addCost(run4.id, 0.5);
    const costCheck2 = service.checkLimits(run4.id);
    check(costCheck2.paused === true && costCheck2.reason === 'max_cumulative_cost', 'cost ceiling pauses the run');

    // pause/resume/cancel/complete
    const run5 = service.create({ conversationId: 'conv-1', buildBlockId: 'block-5', agentId: 'agent-1', agentType: 'main' });
    service.pause(run5.id, 'user_stop');
    check(service.read(run5.id)?.status === 'paused', 'pause sets paused status');
    service.resume(run5.id);
    check(service.read(run5.id)?.status === 'preparing_context', 'resume returns to preparing_context');
    service.cancel(run5.id);
    check(service.read(run5.id)?.status === 'cancelled', 'cancel sets cancelled status');

    // crash recovery
    const run6 = service.create({ conversationId: 'conv-2', buildBlockId: 'block-6', agentId: 'agent-1', agentType: 'main' });
    service.acquireLease(run6.id, 'dead-owner', 5);
    await new Promise(resolve => setTimeout(resolve, 15));
    const recovered = recoverRunningAgentRuns(service);
    check(recovered.includes(run6.id), 'crash recovery marks the stale-lease run recovering');
    const recoveredRun = service.read(run6.id);
    check(recoveredRun?.status === 'recovering', 'recovered run is in recovering status');

    // -----------------------------------------------------------------------
    // SubAgent runtime: context package + ceiling
    // -----------------------------------------------------------------------
    const subAgent = new SubAgentContextService(root);
    const ceiling: SubAgentCeiling = {
      allowedCapabilityDomains: ['filesystem', 'code'],
      forbiddenCapabilityIds: ['secrets.read'],
      allowedToolIds: ['file.read', 'code.search'],
      resourceScopes: ['workspace:conv-1'],
      riskCeiling: 'write',
    };
    const pkg = subAgent.createPackage({
      runId: 'sub-1',
      parentRunId: run.id,
      task: 'investigate the codebase',
      ceiling,
      discoverableCapabilityIds: ['code.search', 'web.search', 'vcs.publish'],
    });
    check(pkg.immutableContextHash.length === 64, 'subagent context package is hash-bound');
    check(subAgent.verifyImmutable('sub-1') === true, 'immutable package verifies');

    const allowed = subAgent.capabilityAllowed('sub-1', 'filesystem.read', 'read');
    check(allowed.allowed === true, 'allowed capability within ceiling passes');
    const forbidden = subAgent.capabilityAllowed('sub-1', 'secrets.read', 'read');
    check(forbidden.allowed === false && !!forbidden.reason?.includes('forbidden'), 'explicitly forbidden capability is rejected');
    const riskExceeded = subAgent.capabilityAllowed('sub-1', 'vcs.publish', 'external');
    check(riskExceeded.allowed === false && !!riskExceeded.reason?.includes('ceiling'), 'risk above ceiling is rejected');
    const domainExceeded = subAgent.capabilityAllowed('sub-1', 'web.search', 'read');
    check(domainExceeded.allowed === false && !!domainExceeded.reason?.includes('domains'), 'domain outside allowed list is rejected');

    // deltas are appended, package immutable
    const delta1 = subAgent.appendDelta('sub-1', 'first observation');
    const delta2 = subAgent.appendDelta('sub-1', 'second observation');
    check(delta1.sequence === 1 && delta2.sequence === 2, 'deltas are appended in sequence');
    const deltas = subAgent.readDeltas('sub-1');
    check(deltas.length === 2, 'two deltas persisted');
    check(subAgent.verifyImmutable('sub-1') === true, 'appending deltas does not mutate the immutable package');
    const contextText = subAgent.buildContextText('sub-1');
    check(contextText.includes('SubAgent Context Package') && contextText.includes('second observation'), 'context text combines package + deltas');

    // -----------------------------------------------------------------------
    // Layer D dual-write: Agent begin/finish/resume sync AgentRunService
    // -----------------------------------------------------------------------
    const dualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-agent-dual-write-'));
    try {
      fs.writeFileSync(path.join(dualRoot, 'config.json'), JSON.stringify({ models: {}, context: { agent_runtime_v2: { value: true } } }), 'utf-8');
      const dualAgent = new Agent(dualRoot);
      const dualService = new AgentRunService(path.join(dualRoot, '.newmark-context-v2'));
      const target = { workspaceId: 'ws-dual', conversationId: 'conv-dual' };

      dualAgent.beginConversationWorkRun('dual-run-1', target);
      const persisted1 = dualService.listByConversation('conv-dual').find(r => r.payload?.workRunId === 'dual-run-1');
      check(!!persisted1, 'beginConversationWorkRun creates a persisted AgentRun');
      check(persisted1?.status === 'preparing_context', 'persisted run starts in preparing_context');
      check(persisted1?.conversationId === 'conv-dual' && persisted1?.agentId === dualAgent['runtimeActorId'], 'persisted run carries conversation + agent identity');

      dualAgent.emitWorkEvent({ type: 'tool_call', content: 'Reading file', toolName: 'file.read', toolCallId: 'tc-dual', runId: 'dual-run-1' });
      check(dualService.read(persisted1!.id)?.status === 'executing_tools', 'tool_call event syncs persisted status to executing_tools');

      dualAgent.finishConversationWorkRun('dual-run-1', 'completed');
      check(dualService.read(persisted1!.id)?.status === 'completed', 'finish completed syncs persisted run to completed');

      dualAgent.beginConversationWorkRun('dual-run-2', target);
      dualAgent.finishConversationWorkRun('dual-run-2', 'error');
      const errRun = dualService.listByConversation('conv-dual').find(r => r.payload?.workRunId === 'dual-run-2');
      check(errRun?.status === 'failed', 'finish error syncs persisted run to failed');

      dualAgent.beginConversationWorkRun('dual-run-3', target);
      dualAgent.finishConversationWorkRun('dual-run-3', 'interrupted');
      const intRun = dualService.listByConversation('conv-dual').find(r => r.payload?.workRunId === 'dual-run-3');
      check(intRun?.status === 'paused' && intRun.pauseReason === 'interrupted', 'interrupted syncs persisted run to paused');
      check(dualAgent.resumeConversationWorkRun('dual-run-3') === true, 'interrupted run is resumable in the in-memory view');
      check(dualService.read(intRun!.id)?.status === 'preparing_context', 'resume syncs persisted run back to preparing_context');
      dualAgent.finishConversationWorkRun('dual-run-3', 'completed');

      dualAgent.beginConversationWorkRun('dual-run-4', target);
      dualAgent.finishConversationWorkRun('dual-run-4', 'force_interrupted');
      const fiRun = dualService.listByConversation('conv-dual').find(r => r.payload?.workRunId === 'dual-run-4');
      check(fiRun?.status === 'cancelled', 'force_interrupted syncs persisted run to cancelled');
    } finally {
      cleanup(dualRoot);
    }

    // flag disabled (explicit override) -> AgentRunService is never initialized
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-agent-legacy-'));
    try {
      fs.writeFileSync(path.join(legacyRoot, 'config.json'), JSON.stringify({ models: {}, context: { agent_runtime_v2: { value: false } } }), 'utf-8');
      const legacyAgent = new Agent(legacyRoot);
      legacyAgent.beginConversationWorkRun('legacy-run', { workspaceId: 'ws', conversationId: 'conv-legacy' });
      check(fs.existsSync(path.join(legacyRoot, '.newmark-context-v2', 'agent-runs')) === false, 'flag off leaves AgentRunService untouched');
    } finally {
      cleanup(legacyRoot);
    }

    console.log('agentRuntimeV2Verify: all assertions passed');
  } finally {
    cleanup(root);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
