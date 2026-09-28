/**
 * dev-0.6.6 regression: a crashed owner must not wedge a conversation's queue.
 *
 * Field evidence (real workspace ledger + runtime log, 2026-09-16):
 *   - a utility host process died of V8 OOM (`utility_runtime_unexpected_exit`,
 *     exit 4294930435) while it held the branch guard;
 *   - the build stayed RUNNING, the guard kept pointing at the dead attempt,
 *     its lease had expired 2h earlier;
 *   - every later queued row was accepted but never executed, and the queue
 *     could not be repaired from the UI;
 *   - an earlier 34-minute turn failed with
 *     `BuildFailed ... Attempt no longer owns branch` because nothing renewed
 *     the 60s lease while a long turn was running.
 *
 * This gate pins the durable-queue guarantees that make those states
 * impossible: ownership is decided by attempt identity (not by the lease
 * clock), live owners renew their lease, and a dead owner's attempt is
 * reclaimed by any live reader so the queue keeps moving.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuardedContinuationStore } from '../core/continuation/store';
import { CONTINUATION_SCHEMA_VERSION, EnqueueBuildCommand, ExecutionScope } from '../core/continuation/contracts';

const workspaceId = 'orphan-recovery';
const rootId = 'conv-orphan';
const branchId = `${rootId}::main`;

function enqueue(store: GuardedContinuationStore, commandId: string, text: string, workspace = 'orphan-recovery', branch = branchId): string {
  const snapshot = store.snapshot({ workspaceId: workspace, rootId, branchId: branch });
  return store.enqueueBuild({
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    type: 'ENQUEUE_BUILD',
    commandId,
    actorId: 'verify',
    target: { workspaceId: workspace, expectedRootId: rootId, branchId: branch },
    expectedTailBuildId: snapshot.tailBuildId,
    expectedQueueRevision: snapshot.queueRevision,
    input: { text },
    recipeSnapshotId: 'recipe',
    createdAt: new Date().toISOString(),
  } as EnqueueBuildCommand).buildId;
}

function main(): void {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-orphan-recovery-'));
  const store = new GuardedContinuationStore(workspace, workspaceId, { leaseMs: 5_000 });
  const checks: Array<[boolean, string]> = [];
  const check = (condition: boolean, message: string) => {
    checks.push([condition, message]);
    assert.ok(condition, message);
  };
  try {
    store.ensureRoot(rootId, branchId);

    // ---- a long turn keeps ownership even after its original lease expired ----
    // Real incident: a 34-minute turn lost its 60s lease and its final write was
    // rejected as `Attempt ... no longer owns branch`.
    const firstBuild = enqueue(store, 'cmd-1', 'long turn');
    const claimAt = Date.now();
    const longScope = store.claimBuild({ workspaceId, rootId, branchId, workerCapability: `kernel:${process.pid}`, now: claimAt });
    check(!!longScope && longScope.buildId === firstBuild, 'claim: the first turn is executing');
    const afterOriginalLease = claimAt + 10_000;
    check(store.heartbeat({ branchId, buildId: longScope!.buildId, attemptId: longScope!.attemptId, fence: longScope!.fence }, afterOriginalLease) === true,
      'lease: a live owner can renew its lease after the original window');
    const longFinal = store.commitFinal({ scope: longScope!, text: 'long final', now: afterOriginalLease + 1_000 });
    const afterLongRun = store.snapshot({ workspaceId, rootId, branchId });
    check(longFinal.buildId === firstBuild && afterLongRun.headBuildId === firstBuild,
      'commit: the owning attempt commits even though the original lease window had passed');
    check(afterLongRun.builds.find(build => build.buildId === firstBuild)?.status === 'SUCCEEDED',
      'commit: the long turn is never left FAILED with an uncommitted final');

    // ---- a dead owner's attempt is reclaimed and the queue continues ----
    // Real incident shape: RUNNING build + guard lease expired + queued successor.
    const deadBranch = `${rootId}::dead-owner`;
    store.ensureRoot(rootId, deadBranch);
    const deadBuild = enqueue(store, 'cmd-dead-1', 'turn interrupted by the host crash', workspaceId, deadBranch);
    const queuedAfter = enqueue(store, 'cmd-dead-2', 'queued row waiting behind the crashed turn', workspaceId, deadBranch);
    const deadClaimAt = Date.now();
    const deadScope = store.claimBuild({ workspaceId, rootId, branchId: deadBranch, workerCapability: 'kernel:4294967', now: deadClaimAt }) as ExecutionScope;
    check(!!deadScope && deadScope.buildId === deadBuild, 'orphan: the crashed owner held this build');
    const deadSnapshot = store.snapshot({ workspaceId, rootId, branchId: deadBranch });
    check(deadSnapshot.builds.find(build => build.buildId === deadBuild)?.status === 'RUNNING',
      'orphan: the ledger still shows RUNNING after the owner died');
    check(store.claimBuild({ workspaceId, rootId, branchId: deadBranch, workerCapability: 'kernel:other', now: deadClaimAt + 1_000 }) === null,
      'orphan: a fresh owner cannot claim while the dead attempt holds the guard');

    const queuedBeforeRecovery = store.snapshot({ workspaceId, rootId, branchId: deadBranch }).builds
      .find(build => build.buildId === queuedAfter);
    check(queuedBeforeRecovery?.status === 'QUEUED' && !queuedBeforeRecovery.waitingReason,
      'orphan: the queued successor is a normal queued row, not a dependency-blocked one');

    const activeBefore = store.activeAttempt({ workspaceId, rootId, branchId: deadBranch });
    check(!!activeBefore && activeBefore.workerCapability === 'kernel:4294967' && activeBefore.status === 'RUNNING',
      'orphan: the guard exposes the dead owner so a live reader can prove it is gone');

    const recovery = store.recoverOrphanedAttempt({
      workspaceId, rootId, branchId: deadBranch,
      now: deadClaimAt + 2_000, graceMs: 120_000,
      ownerAlive: () => false,
      reason: 'verify-owner-process-exited',
    });
    check(recovery.recovered === true && recovery.previousBuildStatus === 'RUNNING',
      'orphan: a dead owner is reclaimed immediately');
    const afterRecovery = store.snapshot({ workspaceId, rootId, branchId: deadBranch });
    check(afterRecovery.builds.find(build => build.buildId === deadBuild)?.status === 'QUEUED',
      'orphan: the reclaimed build returns to QUEUED so the turn can run again');
    check(afterRecovery.builds.find(build => build.buildId === deadBuild)?.status !== 'RUNNING'
      && !store.activeAttempt({ workspaceId, rootId, branchId: deadBranch }),
      'orphan: the guard is released');
    const recoveryEvents = store.events(0, 1_000).filter(event => event.type === 'AttemptOrphanRecovered' && event.branchId === deadBranch);
    check(recoveryEvents.length === 1 && recoveryEvents[0].payload?.ownerAlive === false,
      'orphan: the reclaim is audited with the reason');

    const recoveredScope = store.claimBuild({ workspaceId, rootId, branchId: deadBranch, workerCapability: 'kernel:new-owner', now: deadClaimAt + 3_000 });
    check(!!recoveredScope && recoveredScope.buildId === deadBuild, 'orphan: the queue continues with the recovered turn');
    store.commitFinal({ scope: recoveredScope!, text: 'recovered final' });
    const nextScope = store.claimBuild({ workspaceId, rootId, branchId: deadBranch, workerCapability: 'kernel:new-owner' });
    check(!!nextScope && nextScope.buildId === queuedAfter, 'orphan: the following queued row runs after the recovered one');

    // ---- a live owner is never stolen ----
    const liveBranch = `${rootId}::live-owner`;
    store.ensureRoot(rootId, liveBranch);
    const liveBuild = enqueue(store, 'cmd-live-1', 'turn owned by a healthy process', workspaceId, liveBranch);
    const liveClaimAt = Date.now();
    const liveScope = store.claimBuild({ workspaceId, rootId, branchId: liveBranch, workerCapability: `kernel:${process.pid}`, now: liveClaimAt })!;
    check(store.heartbeat({ branchId: liveBranch, buildId: liveScope.buildId, attemptId: liveScope.attemptId, fence: liveScope.fence }, liveClaimAt + 1_000) === true,
      'live owner: heartbeat renews the lease');
    const liveRecovery = store.recoverOrphanedAttempt({
      workspaceId, rootId, branchId: liveBranch,
      now: liveClaimAt + 2_000, graceMs: 120_000,
      ownerAlive: () => true,
      reason: 'must-not-steal',
    });
    check(liveRecovery.recovered === false, 'live owner: a healthy attempt is not reclaimed');
    const liveSnapshot = store.snapshot({ workspaceId, rootId, branchId: liveBranch });
    check(liveSnapshot.builds.find(build => build.buildId === liveBuild)?.status === 'RUNNING',
      'live owner: its RUNNING build is untouched');

    // ---- a dangling guard (attempt already terminal) is released ----
    const danglingBranch = `${rootId}::dangling`;
    store.ensureRoot(rootId, danglingBranch);
    enqueue(store, 'cmd-dangling-1', 'dangling guard row', workspaceId, danglingBranch);
    const danglingClaim = store.claimBuild({ workspaceId, rootId, branchId: danglingBranch, workerCapability: 'kernel:1', now: Date.now() })!;
    store.requeueBuild({ workspaceId, rootId, branchId: danglingBranch, buildId: danglingClaim.buildId });
    const danglingRecovery = store.recoverOrphanedAttempt({ workspaceId, rootId, branchId: danglingBranch, ownerAlive: () => true });
    check(danglingRecovery.recovered === false || !store.activeAttempt({ workspaceId, rootId, branchId: danglingBranch }),
      'dangling guard: requeue already released the guard so the branch stays claimable');

    // ---- a corrupt ledger recovers from the previous good copy ----
    const corruptBranch = `${rootId}::corrupt`;
    store.ensureRoot(rootId, corruptBranch);
    enqueue(store, 'cmd-corrupt-1', 'row that must survive a truncated ledger', workspaceId, corruptBranch);
    enqueue(store, 'cmd-corrupt-2', 'second row so a backup exists', workspaceId, corruptBranch);
    const ledgerPath = store.filePath;
    fs.writeFileSync(ledgerPath, '{"version":1,"branches":', 'utf-8');
    const recoveredStore = new GuardedContinuationStore(workspace, workspaceId, { leaseMs: 5_000 });
    const recoveredSnapshot = recoveredStore.snapshot({ workspaceId, rootId, branchId: corruptBranch });
    check(recoveredSnapshot.builds.length === 2,
      'durability: a truncated ledger is restored from the previous good copy');
    check(fs.existsSync(`${ledgerPath}.corrupt`), 'durability: the unreadable ledger is kept for post-mortem');

    console.log(`queueOrphanRecoveryVerify: ${checks.length} checks passed`);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main();
