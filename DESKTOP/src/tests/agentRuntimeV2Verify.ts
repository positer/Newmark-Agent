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

    console.log('agentRuntimeV2Verify: all assertions passed');
  } finally {
    cleanup(root);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
