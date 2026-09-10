/**
 * dev-0.6.4 hotfix regression: a failed admitted build must not wedge the queue.
 *
 * 用户现场（`continuation-ledger.json`）：
 *   seq2 build FAILED → seq3 QUEUED(waitingReason=DEPENDENCY_FAILED) → seq4 QUEUED → seq5 QUEUED
 * `claimBuild` 只认「父 = 已提交 frontier」，于是整条队列永远无法出队：恢复暂停的
 * 队列看起来“没有反应”，新提交也只是接在这条失败链后面。
 *
 * 本测试复现该形状并验证显式修复通道 `repairBlockedQueue`：受阻行被重新挂到最后一个
 * 已提交 Build（保持原顺序、写入 BuildQueueRepaired 审计事件），随后可以依次执行。
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuardedContinuationStore } from '../core/continuation/store';

const workspaceId = 'dev064-repair';
const rootId = 'conv-repair';
const branchId = `${rootId}::main`;

function main(): void {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-queue-repair-'));
  try {
    const store = new GuardedContinuationStore(workspace, workspaceId);
    store.ensureRoot(rootId, branchId);
    const target = { workspaceId, expectedRootId: rootId, branchId };
    const enqueue = (id: string, text: string) => store.enqueueBuild({
      schemaVersion: 1,
      type: 'ENQUEUE_BUILD',
      commandId: id,
      actorId: 'verify',
      target,
      expectedTailBuildId: store.snapshot({ workspaceId, rootId, branchId }).tailBuildId,
      expectedQueueRevision: store.snapshot({ workspaceId, rootId, branchId }).queueRevision,
      input: { text },
      recipeSnapshotId: `${rootId}:${branchId}:verify`,
      createdAt: new Date().toISOString(),
    });

    // 用户现场形状：先入队成链，再让链首失败 → 后继被标记 DEPENDENCY_FAILED
    const first = enqueue('cmd-1', 'first build');
    const blocked = enqueue('cmd-2', 'queued row blocked by the failure');
    const successor = enqueue('cmd-3', 'queued row behind the blocked one');
    const firstScope = store.claimBuild({ workspaceId, rootId, branchId, workerCapability: 'verify' });
    assert.ok(firstScope && firstScope.buildId === first.buildId, 'the first admitted build is claimable');
    store.failBuild({ scope: firstScope!, reason: 'provider failure' });

    const blockedSnapshot = store.snapshot({ workspaceId, rootId, branchId });
    const blockedRecord = blockedSnapshot.builds.find(build => build.buildId === blocked.buildId);
    assert.equal(blockedRecord?.waitingReason, 'DEPENDENCY_FAILED', 'the successor of a failed build is marked DEPENDENCY_FAILED');
    // 用户现场的关键补充：失败之后才入队的行也必须推导为受阻（否则界面既看不到原因，
    // 也不会出现显式修复入口）。
    const lateRow = enqueue('cmd-4', 'queued after the failure');
    const lateSnapshot = store.snapshot({ workspaceId, rootId, branchId });
    assert.equal(lateSnapshot.builds.find(build => build.buildId === lateRow.buildId)?.waitingReason, 'DEPENDENCY_FAILED',
      'a row admitted after the failure is derived as blocked even without a fail-time marker');
    assert.equal(store.claimBuild({ workspaceId, rootId, branchId, workerCapability: 'verify' }), null,
      'a queue wedged behind a failed build cannot be claimed (reproduces the user report)');

    // 显式修复：受阻行重新挂到已提交 frontier（此处 frontier = null，因为还没有提交）
    const repair = store.repairBlockedQueue({ workspaceId, rootId, branchId, reason: 'verify-repair' });
    assert.deepEqual(repair.repaired, [blocked.buildId],
      'the row whose parent failed is re-anchored; its own successor stays behind it in queue order');
    const repairedSnapshot = store.snapshot({ workspaceId, rootId, branchId });
    const repairedBlocked = repairedSnapshot.builds.find(build => build.buildId === blocked.buildId);
    const repairedSuccessor = repairedSnapshot.builds.find(build => build.buildId === successor.buildId);
    assert.equal(repairedBlocked?.parentBuildId, null, 'the first repaired row hangs off the committed frontier');
    assert.equal(repairedBlocked?.waitingReason, undefined, 'the repair clears the dependency-failed marker');
    assert.equal(repairedSuccessor?.parentBuildId, blocked.buildId, 'queue order is preserved inside the repaired chain');
    const repairEvents = store.events(0, 500).filter(event => event.type === 'BuildQueueRepaired');
    assert.equal(repairEvents.length, 1, 'each re-anchor writes an audit event');
    assert.equal(repairEvents[0].payload?.previousParentBuildId, first.buildId, 'the audit event records the failed previous parent');

    // 修复后队列可以继续按顺序执行
    const blockedScope = store.claimBuild({ workspaceId, rootId, branchId, workerCapability: 'verify' });
    assert.equal(blockedScope?.buildId, blocked.buildId, 'the repaired row can now be claimed');
    store.commitFinal({ scope: blockedScope!, text: 'blocked row done' });
    const successorScope = store.claimBuild({ workspaceId, rootId, branchId, workerCapability: 'verify' });
    assert.equal(successorScope?.buildId, successor.buildId, 'the following row runs after its repaired predecessor commits');
    store.commitFinal({ scope: successorScope!, text: 'successor done' });
    assert.equal(store.snapshot({ workspaceId, rootId, branchId }).builds.filter(build => build.status === 'SUCCEEDED').length, 2,
      'both queued rows complete once the queue is repaired');

    // 修复是幂等的：健康队列不再产生事件
    const secondRepair = store.repairBlockedQueue({ workspaceId, rootId, branchId, reason: 'verify-repair-2' });
    assert.equal(secondRepair.repaired.length, 0, 'a healthy queue is left untouched');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log('Queue blocked-repair verification passed');
}

main();
