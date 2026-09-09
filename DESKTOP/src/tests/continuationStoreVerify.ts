/**
 * continuation-v1 Gate B/C negative tests.
 *
 * These run against the real guarded ledger, not a mock repository. They pin
 * the invariants that previously failed in the JSON/runtime queue path:
 * target identity, CAS admission, idempotency, single-writer fencing, unique
 * final, head/tail separation, dependency blocking and fork lineage.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuardedContinuationStore } from '../core/continuation/store';
import { ContinuationError, EnqueueBuildCommand, ExecutionScope } from '../core/continuation/contracts';

function check(condition: boolean, message: string): void {
  if (condition) console.log(`  [PASS] ${message}`);
  else console.log(`  [FAIL] ${message}`);
  assert.ok(condition, message);
}

function expectCode(fn: () => unknown, code: string, message: string): void {
  try {
    fn();
    check(false, `${message} (no error)`);
  } catch (error) {
    const actual = error instanceof ContinuationError ? error.code : (error instanceof Error ? error.message : String(error));
    check(actual === code, `${message} [${actual}]`);
  }
}

function command(input: {
  commandId: string;
  actorId?: string;
  workspaceId?: string;
  rootId?: string;
  branchId?: string;
  expectedTailBuildId?: string | null;
  expectedQueueRevision?: number;
  text?: string;
  modelSelection?: string;
}): EnqueueBuildCommand {
  return {
    schemaVersion: 1,
    type: 'ENQUEUE_BUILD',
    commandId: input.commandId,
    actorId: input.actorId || 'actor-pc',
    target: {
      workspaceId: input.workspaceId || 'ws-1',
      expectedRootId: input.rootId || 'root-1',
      branchId: input.branchId || 'branch-a',
    },
    expectedTailBuildId: input.expectedTailBuildId ?? null,
    expectedQueueRevision: input.expectedQueueRevision ?? 0,
    input: { text: input.text || 'hello', modelSelection: input.modelSelection || 'deployment:p:model' },
    recipeSnapshotId: 'recipe-1',
    createdAt: new Date().toISOString(),
  };
}

function claim(store: GuardedContinuationStore, branchId = 'branch-a', worker = 'worker-1'): ExecutionScope | null {
  return store.claimBuild({ workspaceId: 'ws-1', rootId: 'root-1', branchId, workerCapability: worker });
}

function main(): void {
  console.log('continuationStoreVerify');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-continuation-store-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const store = new GuardedContinuationStore(workspace, 'ws-1', { leaseMs: 50 });
  store.ensureRoot('root-1', 'branch-a');

  // ---- CAS admission: one accepted, one conflict, parent fixed to tail ----
  const first = store.enqueueBuild(command({ commandId: 'cmd-1', text: 'first' }));
  check(first.parentBuildId === null && first.queueSequence === 1, 'enqueue: first build has null parent and sequence 1');
  const second = store.enqueueBuild(command({
    commandId: 'cmd-2', text: 'second',
    expectedTailBuildId: first.buildId, expectedQueueRevision: first.queueRevision,
  }));
  check(second.parentBuildId === first.buildId && second.queueSequence === 2, 'enqueue: second build parent is the accepted tail');
  expectCode(() => store.enqueueBuild(command({
    commandId: 'cmd-3', text: 'stale',
    expectedTailBuildId: first.buildId, expectedQueueRevision: first.queueRevision,
  })), 'QUEUE_REVISION_CONFLICT', 'enqueue: stale tail/revision is rejected, never silently rebased');

  // ---- idempotency: same command+hash returns the same build; changed request is a conflict ----
  const duplicate = store.enqueueBuild(command({ commandId: 'cmd-1', text: 'first' }));
  check(duplicate.buildId === first.buildId && duplicate.duplicate === true, 'idempotency: same command and request hash returns the original receipt');
  expectCode(() => store.enqueueBuild(command({ commandId: 'cmd-1', text: 'changed' })), 'IDEMPOTENCY_KEY_REUSE', 'idempotency: same command with changed input is rejected');

  // ---- target identity: wrong root/branch/workspace fails closed ----
  expectCode(() => store.enqueueBuild(command({ commandId: 'cmd-wrong-root', rootId: 'root-2', expectedTailBuildId: second.buildId, expectedQueueRevision: second.queueRevision })),
    'ROUTE_MISMATCH', 'target: wrong root fails closed');
  expectCode(() => store.enqueueBuild(command({ commandId: 'cmd-wrong-workspace', workspaceId: 'ws-2' })), 'ROUTE_MISMATCH', 'target: wrong workspace fails closed');
  expectCode(() => store.enqueueBuild(command({ commandId: 'cmd-missing', branchId: 'branch-missing' })), 'UNKNOWN_BRANCH', 'target: missing branch fails closed');

  // ---- single writer per branch, parallel writers across branches ----
  store.ensureRoot('root-1', 'branch-b');
  const branchBBuild = store.enqueueBuild(command({
    commandId: 'cmd-b-1', text: 'branch b first', branchId: 'branch-b',
  }));
  const claimA = claim(store, 'branch-a', 'worker-a');
  const claimAAgain = claim(store, 'branch-a', 'worker-a2');
  check(!!claimA && claimAAgain === null, 'guard: same branch admits exactly one active attempt');
  const claimB = claim(store, 'branch-b', 'worker-b');
  check(!!claimB && claimB.fence === 1 && claimB.buildId === branchBBuild.buildId,
    'guard: sibling branch claims independently with its own fence');

  // ---- stale fence after lease expiry ----
  const expiredNow = Date.now() + 10_000;
  store.recoverExpiredLeases(expiredNow);
  const claimA2 = store.claimBuild({ workspaceId: 'ws-1', rootId: 'root-1', branchId: 'branch-a', workerCapability: 'worker-a2', now: expiredNow });
  check(!!claimA2 && claimA2.fence > claimA!.fence, 'fence: expired lease is recovered and the new attempt receives a higher fence');
  check(store.heartbeat({ branchId: claimA!.branchId, buildId: claimA!.buildId, attemptId: claimA!.attemptId, fence: claimA!.fence }, expiredNow) === false,
    'fence: old attempt heartbeat is rejected after takeover');
  expectCode(() => store.commitFinal({ scope: claimA!, text: 'late final', now: expiredNow }), 'STALE_EXECUTION', 'fence: old attempt final write is rejected');

  // ---- final uniqueness, head/tail separation ----
  const final = store.commitFinal({ scope: claimA2!, text: 'first final', now: expiredNow });
  const afterFirst = store.snapshot({ workspaceId: 'ws-1', rootId: 'root-1', branchId: 'branch-a' });
  check(afterFirst.headBuildId === first.buildId && afterFirst.tailBuildId === second.buildId,
    'commit: head advances to the committed build while tail keeps the queued successor');
  check(final.buildId === first.buildId && afterFirst.builds.find(build => build.buildId === first.buildId)?.status === 'SUCCEEDED',
    'commit: final and build status commit atomically');
  expectCode(() => store.commitFinal({ scope: claimA2!, text: 'second final', now: expiredNow }), 'FINAL_ALREADY_COMMITTED',
    'commit: one build cannot have a second final');

  // ---- successor runs only after its parent commits; cancel blocks the rest ----
  const claimSecond = store.claimBuild({ workspaceId: 'ws-1', rootId: 'root-1', branchId: 'branch-a', workerCapability: 'worker-a3', now: expiredNow + 1 });
  check(!!claimSecond && claimSecond.buildId === second.buildId && claimSecond.parentBuildId === first.buildId,
    'scheduler: successor is claimable only after its parent committed');
  store.cancelBuild({ workspaceId: 'ws-1', rootId: 'root-1', branchId: 'branch-a', buildId: second.buildId, now: expiredNow + 2 });
  const afterCancel = store.snapshot({ workspaceId: 'ws-1', rootId: 'root-1', branchId: 'branch-a' });
  check(afterCancel.builds.find(build => build.buildId === second.buildId)?.status === 'CANCELLED' && afterCancel.headBuildId === first.buildId,
    'cancel: cancelled successor never advances head or rewrites the parent');

  // ---- fork lineage ----
  const forked = store.forkBranch({
    commandId: 'fork-1', actorId: 'actor-pc', workspaceId: 'ws-1',
    sourceBranchId: 'branch-a', anchorBuildId: first.buildId, newBranchId: 'branch-c',
  });
  check(forked.headBuildId === first.buildId && forked.tailBuildId === first.buildId && forked.queueRevision === 0,
    'fork: new branch starts at the committed anchor with an empty queue');
  const sourceAfterFork = store.snapshot({ workspaceId: 'ws-1', rootId: 'root-1', branchId: 'branch-a' });
  check(sourceAfterFork.headBuildId === first.buildId && sourceAfterFork.builds.length === 2,
    'fork: source branch is unchanged');
  expectCode(() => store.forkBranch({
    commandId: 'fork-2', actorId: 'actor-pc', workspaceId: 'ws-1',
    sourceBranchId: 'branch-a', anchorBuildId: second.buildId, newBranchId: 'branch-d',
  }), 'ANCHOR_NOT_COMMITTED', 'fork: cancelled/non-committed anchor is rejected');

  // ---- restart persistence + append-only event cursor ----
  const reloaded = new GuardedContinuationStore(workspace, 'ws-1', { leaseMs: 50 });
  const reloadedSnapshot = reloaded.snapshot({ workspaceId: 'ws-1', rootId: 'root-1', branchId: 'branch-a' });
  check(reloadedSnapshot.headBuildId === first.buildId && reloadedSnapshot.builds.length === 2,
    'restart: a fresh store instance reads the same authoritative ledger');
  const events = reloaded.events(0, 10_000);
  check(events.length > 0
    && events.every((event, index) => index === 0 || event.cursor > events[index - 1].cursor)
    && events.some(event => event.type === 'StaleWriteRejected'),
    'events: append-only cursor order is retained and stale writes are audited');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('continuationStoreVerify: all checks passed');
}

main();
