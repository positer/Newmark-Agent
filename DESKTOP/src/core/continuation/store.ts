import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import {
  AttemptRecord,
  BranchGuardSnapshot,
  BranchId,
  BranchRecord,
  BuildId,
  BuildInput,
  BuildRecord,
  CommandReceipt,
  ContinuationError,
  ContinuationEvent,
  EnqueueBuildCommand,
  ExecutionScope,
  FinalRecord,
  LedgerFile,
  QueueSnapshot,
  RootId,
  SnapshotId,
  buildInputHash,
  commandKey,
  defaultGuard,
  emptyLedger,
  requestHash,
} from './contracts';

export interface GuardedContinuationStoreOptions {
  /** Lease duration for one attempt. */
  leaseMs?: number;
  /** Maximum retained append-only events per workspace ledger. */
  eventRetention?: number;
}

/**
 * Single-writer continuation ledger for one workspace.
 *
 * The spec's reference uses SQLite. This implementation keeps the same
 * boundaries with a lock-file + atomic-replace JSON ledger because the project
 * does not ship a native SQLite module and an Electron native dependency would
 * change the packaging/signing contract. All continuation writes must go
 * through this class; callers never mutate the ledger directly.
 */
export class GuardedContinuationStore {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly leaseMs: number;
  private readonly eventRetention: number;
  private fingerprint = '';
  private cached: LedgerFile | null = null;

  constructor(
    private readonly workspacePath: string,
    private readonly workspaceId: string,
    options: GuardedContinuationStoreOptions = {},
  ) {
    this.ledgerPath = path.join(path.resolve(workspacePath), 'conversations', 'continuation-ledger.json');
    this.lockPath = `${this.ledgerPath}.lock`;
    this.leaseMs = Math.max(5_000, Math.floor(options.leaseMs || 60_000));
    this.eventRetention = Math.max(200, Math.floor(options.eventRetention || 5_000));
  }

  get filePath(): string {
    return this.ledgerPath;
  }

  ensureRoot(rootId: RootId, defaultBranchId: BranchId): void {
    this.mutate(ledger => {
      if (!ledger.roots[rootId]) {
        ledger.roots[rootId] = {
          rootId,
          workspaceId: this.workspaceId,
          defaultBranchId,
          createdAt: new Date().toISOString(),
        };
      }
      this.ensureBranchRecord(ledger, { rootId, branchId: defaultBranchId, parentAnchorBuildId: null });
    });
  }

  ensureBranch(input: { rootId: RootId; branchId: BranchId; parentAnchorBuildId: BuildId | null }): BranchRecord {
    return this.mutate(ledger => this.ensureBranchRecord(ledger, input));
  }

  getReceipt(actorId: string, commandId: string): CommandReceipt | undefined {
    return this.readLedger().commands[commandKey(actorId, commandId)];
  }

  enqueueBuild(command: EnqueueBuildCommand): CommandReceipt {
    if (!command.target?.workspaceId || !command.target.expectedRootId || !command.target.branchId) {
      throw new ContinuationError('TARGET_REQUIRED', 'workspaceId, expectedRootId and branchId are required');
    }
    if (command.target.workspaceId !== this.workspaceId) {
      throw new ContinuationError('ROUTE_MISMATCH', `Command workspace ${command.target.workspaceId} does not match ledger workspace ${this.workspaceId}`);
    }
    const hash = requestHash(command);
    return this.mutate(ledger => {
      const key = commandKey(command.actorId, command.commandId);
      const existing = ledger.commands[key];
      if (existing) {
        if (existing.requestHash !== hash) {
          throw new ContinuationError('IDEMPOTENCY_KEY_REUSE', `Command ${command.commandId} was already used with a different request`, { commandId: command.commandId });
        }
        return { ...existing, duplicate: true };
      }
      const branch = this.requireBranch(ledger, {
        workspaceId: command.target.workspaceId,
        rootId: command.target.expectedRootId,
        branchId: command.target.branchId,
      });
      if (branch.queueRevision !== command.expectedQueueRevision) {
        throw new ContinuationError('QUEUE_REVISION_CONFLICT', `Queue revision ${command.expectedQueueRevision} is stale; authoritative revision is ${branch.queueRevision}`, {
          expected: command.expectedQueueRevision,
          actual: branch.queueRevision,
        });
      }
      if ((branch.tailBuildId || null) !== (command.expectedTailBuildId || null)) {
        throw new ContinuationError('QUEUE_REVISION_CONFLICT', `Expected tail ${command.expectedTailBuildId || 'null'} does not match authoritative tail ${branch.tailBuildId || 'null'}`, {
          expected: command.expectedTailBuildId,
          actual: branch.tailBuildId,
        });
      }
      const parentBuildId = branch.tailBuildId;
      const parent = parentBuildId ? ledger.builds[parentBuildId] : null;
      if (parentBuildId && (!parent || parent.branchId !== branch.branchId)) {
        throw new ContinuationError('ROUTE_MISMATCH', `Branch tail ${parentBuildId} is not owned by branch ${branch.branchId}`);
      }
      const buildId = `build-${randomUUID()}`;
      const queueSequence = ledger.nextQueueSequence++;
      const now = new Date().toISOString();
      const build: BuildRecord = {
        buildId,
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        parentBuildId,
        inputHash: buildInputHash(command.input),
        input: cloneInput(command.input),
        recipeSnapshotId: command.recipeSnapshotId,
        status: 'QUEUED',
        queueSequence,
        createdAt: now,
        updatedAt: now,
      };
      ledger.builds[buildId] = build;
      branch.tailBuildId = buildId;
      branch.queueRevision += 1;
      branch.lifecycleRevision += 1;
      branch.updatedAt = now;
      const receipt: CommandReceipt = {
        schemaVersion: 1,
        commandId: command.commandId,
        requestHash: hash,
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId,
        parentBuildId,
        queueSequence,
        queueRevision: branch.queueRevision,
        lifecycleRevision: branch.lifecycleRevision,
        acceptedAt: now,
      };
      ledger.commands[key] = receipt;
      this.appendEvent(ledger, {
        type: 'BuildAccepted',
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId,
        attemptId: null,
        fence: null,
        payload: { parentBuildId, queueSequence, inputHash: build.inputHash },
      });
      return receipt;
    });
  }

  claimBuild(input: { workspaceId: string; rootId: RootId; branchId: BranchId; workerCapability: string; now?: number }): ExecutionScope | null {
    return this.mutate(ledger => {
      const branch = this.requireBranch(ledger, input);
      if (branch.paused) throw new ContinuationError('BRANCH_PAUSED', `Branch ${branch.branchId} is paused`);
      const now = input.now ?? Date.now();
      const guard = this.ensureGuard(ledger, branch.branchId);
      if (guard.activeBuildId && guard.leaseUntil > now) {
        return null;
      }
      if (guard.activeBuildId) this.releaseExpiredGuard(ledger, branch, guard, now);
      const candidate = Object.values(ledger.builds)
        .filter(build => build.branchId === branch.branchId && build.status === 'QUEUED')
        .sort((a, b) => a.queueSequence - b.queueSequence)
        .find(build => {
          if ((branch.headBuildId || null) !== (build.parentBuildId || null)) return false;
          const parent = build.parentBuildId ? ledger.builds[build.parentBuildId] : null;
          return !parent || parent.status === 'SUCCEEDED';
        });
      if (!candidate) return null;
      const attemptId = `attempt-${randomUUID()}`;
      const fence = guard.fence + 1;
      const leaseUntil = now + this.leaseMs;
      const attempt: AttemptRecord = {
        attemptId,
        buildId: candidate.buildId,
        branchId: branch.branchId,
        fence,
        status: 'RUNNING',
        leaseUntil,
        workerCapability: String(input.workerCapability || 'unknown'),
        startedAt: new Date(now).toISOString(),
      };
      ledger.attempts[attemptId] = attempt;
      ledger.guards[branch.branchId] = {
        branchId: branch.branchId,
        activeBuildId: candidate.buildId,
        activeAttemptId: attemptId,
        fence,
        leaseUntil,
        workerCapability: attempt.workerCapability,
      };
      candidate.status = 'RUNNING';
      candidate.updatedAt = attempt.startedAt;
      candidate.waitingReason = undefined;
      branch.lifecycleRevision += 1;
      branch.updatedAt = attempt.startedAt;
      this.appendEvent(ledger, {
        type: 'AttemptStarted',
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: candidate.buildId,
        attemptId,
        fence,
        payload: { parentBuildId: candidate.parentBuildId, workerCapability: attempt.workerCapability },
      });
      return {
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: candidate.buildId,
        attemptId,
        fence,
        parentBuildId: candidate.parentBuildId,
        baseContextSnapshotId: candidate.recipeSnapshotId,
        environmentSnapshotId: candidate.recipeSnapshotId,
        workerCapability: attempt.workerCapability,
      };
    });
  }

  updateQueuedBuild(input: {
    workspaceId: string; rootId: RootId; branchId: BranchId; buildId: BuildId; input: BuildInput;
  }): BuildRecord {
    return this.mutate(ledger => {
      const build = ledger.builds[input.buildId];
      if (!build) throw new ContinuationError('UNKNOWN_BUILD', `Build ${input.buildId} does not exist`);
      if (build.workspaceId !== this.workspaceId || (input.rootId && build.rootId !== input.rootId)) {
        throw new ContinuationError('ROUTE_MISMATCH', `Build ${input.buildId} does not belong to workspace/root ${this.workspaceId}/${input.rootId}`);
      }
      const branch = ledger.branches[build.branchId];
      if (!branch) throw new ContinuationError('UNKNOWN_BRANCH', `Build ${input.buildId} references missing branch ${build.branchId}`);
      if (build.status !== 'QUEUED') throw new ContinuationError('BUILD_NOT_READY', `Build ${build.buildId} is ${build.status}; only QUEUED builds can be edited`);
      build.input = cloneInput(input.input);
      build.inputHash = buildInputHash(build.input);
      build.updatedAt = new Date().toISOString();
      branch.queueRevision += 1;
      branch.lifecycleRevision += 1;
      branch.updatedAt = build.updatedAt;
      return { ...build, input: cloneInput(build.input) };
    });
  }

  deleteQueuedBuild(input: { workspaceId: string; rootId: RootId; branchId: BranchId; buildId: BuildId }): void {
    this.mutate(ledger => {
      const build = ledger.builds[input.buildId];
      if (!build) throw new ContinuationError('UNKNOWN_BUILD', `Build ${input.buildId} does not exist`);
      if (build.workspaceId !== this.workspaceId || (input.rootId && build.rootId !== input.rootId)) {
        throw new ContinuationError('ROUTE_MISMATCH', `Build ${input.buildId} does not belong to workspace/root ${this.workspaceId}/${input.rootId}`);
      }
      const branch = ledger.branches[build.branchId];
      if (!branch) throw new ContinuationError('UNKNOWN_BRANCH', `Build ${input.buildId} references missing branch ${build.branchId}`);
      if (build.status !== 'QUEUED') throw new ContinuationError('BUILD_NOT_READY', `Build ${build.buildId} is ${build.status}; only QUEUED builds can be deleted`);
      if (Object.values(ledger.builds).some(item => item.parentBuildId === build.buildId)) {
        throw new ContinuationError('ANCHOR_NOT_COMMITTED', `Build ${build.buildId} still has queued successors; delete them from the tail first`);
      }
      if (branch.tailBuildId === build.buildId) branch.tailBuildId = build.parentBuildId;
      delete ledger.builds[build.buildId];
      branch.queueRevision += 1;
      branch.lifecycleRevision += 1;
      branch.updatedAt = new Date().toISOString();
    });
  }

  reorderQueuedBuilds(input: {
    workspaceId: string; rootId: RootId; branchId: BranchId; orderedBuildIds: BuildId[];
  }): QueueSnapshot {
    return this.mutate(ledger => {
      const branch = this.requireBranch(ledger, input);
      const queued = Object.values(ledger.builds)
        .filter(build => build.branchId === branch.branchId && build.status === 'QUEUED')
        .sort((a, b) => a.queueSequence - b.queueSequence);
      // continuation-v1 fixes parentBuildId at admission. Reordering admitted
      // builds would silently change the context chain, so it is rejected.
      // Changing the order requires explicit cancel + new commands.
      throw new ContinuationError(
        'ANCHOR_NOT_COMMITTED',
        `Branch ${branch.branchId} has ${queued.length} admitted queued build(s); reordering would change their fixed parents. Cancel the suffix and submit it as new commands.`,
        { branchId: branch.branchId, queuedBuildIds: queued.map(build => build.buildId) },
      );
    });
  }

  heartbeat(scope: Pick<ExecutionScope, 'branchId' | 'buildId' | 'attemptId' | 'fence'>, now = Date.now()): boolean {
    return this.mutate(ledger => {
      const guard = ledger.guards[scope.branchId];
      const attempt = ledger.attempts[scope.attemptId];
      if (!guard || !attempt
        || guard.activeBuildId !== scope.buildId
        || guard.activeAttemptId !== scope.attemptId
        || guard.fence !== scope.fence
        || attempt.fence !== scope.fence
        || attempt.status !== 'RUNNING'
        || guard.leaseUntil <= now) {
        this.appendEvent(ledger, {
          type: 'StaleWriteRejected',
          workspaceId: this.workspaceId,
          rootId: ledger.builds[scope.buildId]?.rootId || '',
          branchId: scope.branchId,
          buildId: scope.buildId,
          attemptId: scope.attemptId,
          fence: scope.fence,
          payload: { operation: 'heartbeat' },
        });
        return false;
      }
      const leaseUntil = now + this.leaseMs;
      attempt.leaseUntil = leaseUntil;
      guard.leaseUntil = leaseUntil;
      this.appendEvent(ledger, {
        type: 'AttemptHeartbeat',
        workspaceId: this.workspaceId,
        rootId: ledger.builds[scope.buildId]?.rootId || '',
        branchId: scope.branchId,
        buildId: scope.buildId,
        attemptId: scope.attemptId,
        fence: scope.fence,
        payload: { leaseUntil },
      });
      return true;
    });
  }

  commitFinal(input: {
    scope: ExecutionScope;
    text: string;
    finalHash?: string;
    stateSnapshotId?: SnapshotId;
    now?: number;
  }): FinalRecord {
    return this.mutate(ledger => {
      const { scope } = input;
      const branch = this.requireBranch(ledger, scope);
      const build = ledger.builds[scope.buildId];
      const attempt = ledger.attempts[scope.attemptId];
      const guard = ledger.guards[scope.branchId];
      const now = input.now ?? Date.now();
      if (!build || build.branchId !== scope.branchId || build.rootId !== scope.rootId) {
        throw new ContinuationError('UNKNOWN_BUILD', `Build ${scope.buildId} does not belong to branch ${scope.branchId}`);
      }
      if (ledger.finals[build.buildId]) {
        throw new ContinuationError('FINAL_ALREADY_COMMITTED', `Build ${build.buildId} already has an immutable final`, { final: ledger.finals[build.buildId] });
      }
      if (!attempt || !guard
        || guard.activeBuildId !== scope.buildId
        || guard.activeAttemptId !== scope.attemptId
        || guard.fence !== scope.fence
        || attempt.fence !== scope.fence
        || attempt.status !== 'RUNNING'
        || guard.leaseUntil <= now) {
        this.appendEvent(ledger, {
          type: 'StaleWriteRejected',
          workspaceId: this.workspaceId,
          rootId: branch.rootId,
          branchId: branch.branchId,
          buildId: build.buildId,
          attemptId: scope.attemptId,
          fence: scope.fence,
          payload: { operation: 'commit_final' },
        });
        throw new ContinuationError('STALE_EXECUTION', `Attempt ${scope.attemptId} no longer owns branch ${branch.branchId}`);
      }
      if ((branch.headBuildId || null) !== (build.parentBuildId || null)) {
        throw new ContinuationError('ANCHOR_NOT_COMMITTED', `Build ${build.buildId} parent ${build.parentBuildId || 'null'} is not the current head ${branch.headBuildId || 'null'}`);
      }
      const final: FinalRecord = {
        finalId: `final-${randomUUID()}`,
        buildId: build.buildId,
        branchId: branch.branchId,
        finalHash: String(input.finalHash || createHash('sha256').update(String(input.text || '')).digest('hex').slice(0, 24)),
        stateSnapshotId: String(input.stateSnapshotId || build.recipeSnapshotId),
        text: String(input.text || ''),
        committedAt: new Date(now).toISOString(),
      };
      ledger.finals[build.buildId] = final;
      build.status = 'SUCCEEDED';
      build.finalId = final.finalId;
      build.updatedAt = final.committedAt;
      attempt.status = 'COMPLETED';
      attempt.endedAt = final.committedAt;
      branch.headBuildId = build.buildId;
      branch.lifecycleRevision += 1;
      branch.updatedAt = final.committedAt;
      this.releaseGuard(ledger, branch.branchId, attempt.fence);
      this.appendEvent(ledger, {
        type: 'BuildCommitted',
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: build.buildId,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        payload: { finalId: final.finalId, finalHash: final.finalHash, headBuildId: branch.headBuildId },
      });
      return final;
    });
  }

  /**
   * Trusted external-owner completion.
   *
   * A Flow is a kernel-owned external run, not a leased model worker. It still
   * has to be a durable build so queued Goal/Next successors have a committed
   * parent. This path validates the parent/head relation transactionally but
   * does not require a BranchGuard attempt; the kernel owns the Flow lifetime.
   * If the build is not the next ready build, it stays QUEUED and the caller
   * must retry after the predecessor commits.
   */
  commitExternalBuild(input: {
    workspaceId: string; rootId: RootId; branchId: BranchId; buildId: BuildId; text?: string; now?: number;
  }): boolean {
    return this.mutate(ledger => {
      const branch = this.requireBranch(ledger, input);
      const build = ledger.builds[input.buildId];
      if (!build || build.branchId !== branch.branchId) throw new ContinuationError('UNKNOWN_BUILD', `Build ${input.buildId} is not in branch ${branch.branchId}`);
      if (build.status === 'SUCCEEDED') return true;
      if (build.status !== 'QUEUED') throw new ContinuationError('BUILD_NOT_READY', `External build ${build.buildId} is ${build.status}`);
      if ((branch.headBuildId || null) !== (build.parentBuildId || null)) return false;
      const now = input.now ?? Date.now();
      const committedAt = new Date(now).toISOString();
      const final: FinalRecord = {
        finalId: `final-${randomUUID()}`,
        buildId: build.buildId,
        branchId: branch.branchId,
        finalHash: createHash('sha256').update(String(input.text || '')).digest('hex').slice(0, 24),
        stateSnapshotId: build.recipeSnapshotId,
        text: String(input.text || ''),
        committedAt,
      };
      ledger.finals[build.buildId] = final;
      build.status = 'SUCCEEDED';
      build.finalId = final.finalId;
      build.updatedAt = committedAt;
      branch.headBuildId = build.buildId;
      branch.lifecycleRevision += 1;
      branch.updatedAt = committedAt;
      this.appendEvent(ledger, {
        type: 'BuildCommitted',
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: build.buildId,
        attemptId: null,
        fence: null,
        payload: { finalId: final.finalId, finalHash: final.finalHash, externalOwner: true, headBuildId: branch.headBuildId },
      });
      return true;
    });
  }

  /**
   * Claim a new attempt for an existing external Flow build (suspend/resume).
   * The build identity and fixed parent are preserved; only the attempt/fence
   * advance. This is the external-owner equivalent of retryBuild.
   */
  claimExternalBuild(input: {
    workspaceId: string; rootId: RootId; branchId: BranchId; buildId: BuildId; workerCapability?: string; now?: number;
  }): ExecutionScope {
    return this.mutate(ledger => {
      const branch = this.requireBranch(ledger, input);
      const build = ledger.builds[input.buildId];
      if (!build || build.branchId !== branch.branchId) throw new ContinuationError('UNKNOWN_BUILD', `Build ${input.buildId} is not in branch ${branch.branchId}`);
      if (build.status === 'SUCCEEDED') throw new ContinuationError('FINAL_ALREADY_COMMITTED', `Build ${build.buildId} already committed`);
      if (build.status !== 'QUEUED') throw new ContinuationError('BUILD_NOT_READY', `External build ${build.buildId} is ${build.status}`);
      if ((branch.headBuildId || null) !== (build.parentBuildId || null)) {
        throw new ContinuationError('ANCHOR_NOT_COMMITTED', `External build ${build.buildId} parent is not the current head`);
      }
      const now = input.now ?? Date.now();
      const guard = this.ensureGuard(ledger, branch.branchId);
      const attemptId = `attempt-${randomUUID()}`;
      const fence = guard.fence + 1;
      const leaseUntil = now + this.leaseMs;
      const attempt: AttemptRecord = {
        attemptId,
        buildId: build.buildId,
        branchId: branch.branchId,
        fence,
        status: 'RUNNING',
        leaseUntil,
        workerCapability: String(input.workerCapability || 'flow-external'),
        startedAt: new Date(now).toISOString(),
      };
      ledger.attempts[attemptId] = attempt;
      ledger.guards[branch.branchId] = {
        branchId: branch.branchId,
        activeBuildId: build.buildId,
        activeAttemptId: attemptId,
        fence,
        leaseUntil,
        workerCapability: attempt.workerCapability,
      };
      build.status = 'RUNNING';
      build.updatedAt = attempt.startedAt;
      branch.lifecycleRevision += 1;
      this.appendEvent(ledger, {
        type: 'AttemptStarted',
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: build.buildId,
        attemptId,
        fence,
        payload: { externalOwner: true, workerCapability: attempt.workerCapability },
      });
      return {
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: build.buildId,
        attemptId,
        fence,
        parentBuildId: build.parentBuildId,
        baseContextSnapshotId: build.recipeSnapshotId,
        environmentSnapshotId: build.recipeSnapshotId,
        workerCapability: attempt.workerCapability,
      };
    });
  }

  failBuild(input: { scope: ExecutionScope; reason: string; now?: number }): void {
    this.terminateAttempt(input.scope, 'FAILED', input.reason, input.now);
  }

  cancelBuild(input: { workspaceId: string; rootId: RootId; branchId: BranchId; buildId: BuildId; now?: number }): void {
    this.mutate(ledger => {
      const branch = this.requireBranch(ledger, input);
      const build = ledger.builds[input.buildId];
      if (!build || build.branchId !== branch.branchId) throw new ContinuationError('UNKNOWN_BUILD', `Build ${input.buildId} is not in branch ${branch.branchId}`);
      if (build.status === 'SUCCEEDED') throw new ContinuationError('FINAL_ALREADY_COMMITTED', `Build ${input.buildId} already committed`);
      const guard = this.ensureGuard(ledger, branch.branchId);
      if (guard.activeBuildId === build.buildId) {
        const attempt = guard.activeAttemptId ? ledger.attempts[guard.activeAttemptId] : undefined;
        if (attempt) {
          attempt.status = 'CANCELLED';
          attempt.endedAt = new Date(input.now ?? Date.now()).toISOString();
        }
        this.releaseGuard(ledger, branch.branchId, guard.fence);
      }
      build.status = 'CANCELLED';
      build.updatedAt = new Date(input.now ?? Date.now()).toISOString();
      branch.lifecycleRevision += 1;
      this.markDependentsBlocked(ledger, branch, build.buildId);
      this.appendEvent(ledger, {
        type: 'BuildCancelled',
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: build.buildId,
        attemptId: null,
        fence: null,
      });
    });
  }

  retryBuild(input: { workspaceId: string; rootId: RootId; branchId: BranchId; buildId: BuildId }): BuildRecord {
    return this.mutate(ledger => {
      const branch = this.requireBranch(ledger, input);
      const build = ledger.builds[input.buildId];
      if (!build || build.branchId !== branch.branchId) throw new ContinuationError('UNKNOWN_BUILD', `Build ${input.buildId} is not in branch ${branch.branchId}`);
      if (build.status !== 'FAILED' && build.status !== 'CANCELLED') {
        throw new ContinuationError('BUILD_NOT_READY', `Build ${build.buildId} is ${build.status}; only FAILED/CANCELLED builds can be retried`);
      }
      if (this.hasCommittedDescendant(ledger, build.buildId)) {
        throw new ContinuationError('ANCHOR_NOT_COMMITTED', `Build ${build.buildId} already has a committed descendant`);
      }
      build.status = 'QUEUED';
      build.updatedAt = new Date().toISOString();
      branch.lifecycleRevision += 1;
      return { ...build, input: cloneInput(build.input) };
    });
  }

  /**
   * Idempotent failure recovery for an input that was never accepted.
   *
   * Stop/archive may release the branch guard before the runtime reports the
   * failure. In that case the build is still the same durable row and must be
   * returned to QUEUED for an explicit resume instead of being stranded in
   * RUNNING (or permanently FAILED). A committed build is never requeued.
   */
  requeueBuild(input: { workspaceId: string; rootId: RootId; branchId: BranchId; buildId: BuildId }): BuildRecord {
    return this.mutate(ledger => {
      const branch = this.requireBranch(ledger, input);
      const build = ledger.builds[input.buildId];
      if (!build || build.branchId !== branch.branchId) throw new ContinuationError('UNKNOWN_BUILD', `Build ${input.buildId} is not in branch ${branch.branchId}`);
      if (build.status === 'SUCCEEDED') throw new ContinuationError('FINAL_ALREADY_COMMITTED', `Build ${build.buildId} already committed and cannot be requeued`);
      const guard = this.ensureGuard(ledger, branch.branchId);
      if (guard.activeBuildId === build.buildId) {
        const attempt = guard.activeAttemptId ? ledger.attempts[guard.activeAttemptId] : undefined;
        if (attempt && attempt.status === 'RUNNING') {
          attempt.status = 'EXPIRED';
          attempt.endedAt = new Date().toISOString();
        }
        this.releaseGuard(ledger, branch.branchId, guard.fence);
      }
      build.status = 'QUEUED';
      build.waitingReason = undefined;
      build.updatedAt = new Date().toISOString();
      branch.lifecycleRevision += 1;
      branch.updatedAt = build.updatedAt;
      return { ...build, input: cloneInput(build.input) };
    });
  }

  forkBranch(input: {
    commandId: string;
    actorId: string;
    workspaceId: string;
    sourceBranchId: BranchId;
    anchorBuildId: BuildId;
    newBranchId: BranchId;
  }): BranchRecord {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.mutate(ledger => {
      const key = commandKey(input.actorId, input.commandId);
      const existing = ledger.commands[key];
      if (existing) {
        if (existing.requestHash !== hash) throw new ContinuationError('IDEMPOTENCY_KEY_REUSE', `Command ${input.commandId} was already used with a different fork request`);
        return { ...ledger.branches[existing.branchId] };
      }
      const source = this.requireBranch(ledger, { workspaceId: input.workspaceId, rootId: '', branchId: input.sourceBranchId });
      const anchor = ledger.builds[input.anchorBuildId];
      if (!anchor || anchor.branchId !== source.branchId || anchor.status !== 'SUCCEEDED') {
        throw new ContinuationError('ANCHOR_NOT_COMMITTED', `Anchor ${input.anchorBuildId} is not a committed build of source branch ${source.branchId}`);
      }
      if (!this.isAncestorOfHead(ledger, source, anchor.buildId)) {
        throw new ContinuationError('ANCHOR_NOT_IN_LINEAGE', `Anchor ${anchor.buildId} is not on the source branch lineage`);
      }
      const branch = this.ensureBranchRecord(ledger, {
        rootId: source.rootId,
        branchId: input.newBranchId,
        parentAnchorBuildId: anchor.buildId,
      });
      branch.headBuildId = anchor.buildId;
      branch.tailBuildId = anchor.buildId;
      branch.queueRevision = 0;
      branch.lifecycleRevision += 1;
      const receipt: CommandReceipt = {
        schemaVersion: 1,
        commandId: input.commandId,
        requestHash: hash,
        workspaceId: this.workspaceId,
        rootId: source.rootId,
        branchId: branch.branchId,
        buildId: anchor.buildId,
        parentBuildId: anchor.buildId,
        queueSequence: 0,
        queueRevision: branch.queueRevision,
        lifecycleRevision: branch.lifecycleRevision,
        acceptedAt: new Date().toISOString(),
      };
      ledger.commands[key] = receipt;
      this.appendEvent(ledger, {
        type: 'BranchForked',
        workspaceId: this.workspaceId,
        rootId: source.rootId,
        branchId: branch.branchId,
        buildId: anchor.buildId,
        attemptId: null,
        fence: null,
        payload: { sourceBranchId: source.branchId, anchorBuildId: anchor.buildId },
      });
      return { ...branch };
    });
  }

  setPaused(input: { workspaceId: string; rootId: RootId; branchId: BranchId; paused: boolean }): boolean {
    return this.mutate(ledger => {
      const branch = this.requireBranch(ledger, input);
      branch.paused = input.paused === true;
      branch.lifecycleRevision += 1;
      branch.updatedAt = new Date().toISOString();
      this.appendEvent(ledger, {
        type: branch.paused ? 'BranchPaused' : 'BranchResumed',
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: null,
        attemptId: null,
        fence: null,
      });
      return branch.paused;
    });
  }

  snapshot(input: { workspaceId: string; rootId: RootId; branchId: BranchId }): QueueSnapshot {
    const ledger = this.readLedger();
    const branch = this.requireBranch(ledger, input);
    return this.snapshotUnlocked(ledger, branch);
  }

  private snapshotUnlocked(ledger: LedgerFile, branch: BranchRecord): QueueSnapshot {
    const guard = ledger.guards[branch.branchId] || defaultGuard(branch.branchId);
    const builds = Object.values(ledger.builds)
      .filter(build => build.branchId === branch.branchId)
      .sort((a, b) => a.queueSequence - b.queueSequence)
      .map(build => ({ ...build, input: cloneInput(build.input) }));
    return {
      workspaceId: this.workspaceId,
      rootId: branch.rootId,
      branchId: branch.branchId,
      headBuildId: branch.headBuildId,
      tailBuildId: branch.tailBuildId,
      queueRevision: branch.queueRevision,
      lifecycleRevision: branch.lifecycleRevision,
      paused: branch.paused,
      activeBuildId: guard.activeBuildId,
      guard: { ...guard },
      builds,
    };
  }

  events(afterCursor = 0, limit = 500): ContinuationEvent[] {
    return this.readLedger().events
      .filter(event => event.cursor > afterCursor)
      .slice(0, Math.max(1, Math.min(5_000, limit)))
      .map(event => ({ ...event, payload: event.payload ? { ...event.payload } : undefined }));
  }

  recoverExpiredLeases(now = Date.now()): number {
    return this.mutate(ledger => {
      let recovered = 0;
      for (const guard of Object.values(ledger.guards)) {
        if (!guard.activeBuildId || guard.leaseUntil > now) continue;
        const attempt = guard.activeAttemptId ? ledger.attempts[guard.activeAttemptId] : undefined;
        const build = ledger.builds[guard.activeBuildId];
        if (attempt && attempt.status === 'RUNNING') {
          attempt.status = 'EXPIRED';
          attempt.endedAt = new Date(now).toISOString();
        }
        if (build && build.status === 'RUNNING') {
          build.status = 'QUEUED';
          build.updatedAt = new Date(now).toISOString();
        }
        this.releaseGuard(ledger, guard.branchId, guard.fence);
        recovered += 1;
      }
      return recovered;
    });
  }

  private terminateAttempt(scope: ExecutionScope, status: 'FAILED' | 'CANCELLED', reason: string, now = Date.now()): void {
    this.mutate(ledger => {
      const branch = this.requireBranch(ledger, scope);
      const build = ledger.builds[scope.buildId];
      const attempt = ledger.attempts[scope.attemptId];
      const guard = ledger.guards[scope.branchId];
      if (!build || !attempt || !guard
        || guard.activeAttemptId !== scope.attemptId
        || guard.fence !== scope.fence
        || attempt.fence !== scope.fence) {
        throw new ContinuationError('STALE_EXECUTION', `Attempt ${scope.attemptId} cannot terminate branch ${scope.branchId}`);
      }
      build.status = status;
      build.updatedAt = new Date(now).toISOString();
      attempt.status = status === 'FAILED' ? 'FAILED' : 'CANCELLED';
      attempt.endedAt = build.updatedAt;
      branch.lifecycleRevision += 1;
      this.releaseGuard(ledger, branch.branchId, attempt.fence);
      this.markDependentsBlocked(ledger, branch, build.buildId);
      this.appendEvent(ledger, {
        type: status === 'FAILED' ? 'BuildFailed' : 'BuildCancelled',
        workspaceId: this.workspaceId,
        rootId: branch.rootId,
        branchId: branch.branchId,
        buildId: build.buildId,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        payload: { reason: String(reason || '') },
      });
    });
  }

  private releaseExpiredGuard(ledger: LedgerFile, branch: BranchRecord, guard: BranchGuardSnapshot, now: number): void {
    const attempt = guard.activeAttemptId ? ledger.attempts[guard.activeAttemptId] : undefined;
    const build = guard.activeBuildId ? ledger.builds[guard.activeBuildId] : undefined;
    if (attempt && attempt.status === 'RUNNING') {
      attempt.status = 'EXPIRED';
      attempt.endedAt = new Date(now).toISOString();
    }
    if (build && build.status === 'RUNNING') {
      build.status = 'QUEUED';
      build.updatedAt = new Date(now).toISOString();
    }
    this.releaseGuard(ledger, branch.branchId, guard.fence);
  }

  private markDependentsBlocked(ledger: LedgerFile, branch: BranchRecord, failedBuildId: BuildId): void {
    for (const build of Object.values(ledger.builds)) {
      if (build.branchId !== branch.branchId || build.status !== 'QUEUED') continue;
      if (build.parentBuildId === failedBuildId) build.waitingReason = 'DEPENDENCY_FAILED';
    }
  }

  private hasCommittedDescendant(ledger: LedgerFile, buildId: BuildId): boolean {
    return Object.values(ledger.builds).some(build => build.parentBuildId === buildId && build.status === 'SUCCEEDED');
  }

  private isAncestorOfHead(ledger: LedgerFile, branch: BranchRecord, anchorBuildId: BuildId): boolean {
    let cursor = branch.headBuildId;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      if (cursor === anchorBuildId) return true;
      cursor = ledger.builds[cursor]?.parentBuildId || null;
    }
    return false;
  }

  private ensureBranchRecord(
    ledger: LedgerFile,
    input: { rootId: RootId; branchId: BranchId; parentAnchorBuildId: BuildId | null },
  ): BranchRecord {
    const existing = ledger.branches[input.branchId];
    if (existing) return existing;
    const now = new Date().toISOString();
    const branch: BranchRecord = {
      branchId: input.branchId,
      workspaceId: this.workspaceId,
      rootId: input.rootId,
      parentAnchorBuildId: input.parentAnchorBuildId,
      headBuildId: input.parentAnchorBuildId,
      tailBuildId: input.parentAnchorBuildId,
      queueRevision: 0,
      lifecycleRevision: 0,
      paused: false,
      createdAt: now,
      updatedAt: now,
    };
    ledger.branches[branch.branchId] = branch;
    ledger.guards[branch.branchId] = defaultGuard(branch.branchId);
    if (!ledger.roots[branch.rootId]) {
      ledger.roots[branch.rootId] = { rootId: branch.rootId, workspaceId: this.workspaceId, defaultBranchId: branch.branchId, createdAt: now };
    }
    return branch;
  }

  private requireBranch(ledger: LedgerFile, target: { workspaceId: string; rootId: RootId; branchId: BranchId }): BranchRecord {
    const branch = ledger.branches[target.branchId];
    if (!branch) throw new ContinuationError('UNKNOWN_BRANCH', `Branch ${target.branchId} does not exist`);
    if (branch.workspaceId !== this.workspaceId) {
      throw new ContinuationError('ROUTE_MISMATCH', `Branch ${target.branchId} belongs to workspace ${branch.workspaceId}`);
    }
    if (target.rootId && branch.rootId !== target.rootId) {
      throw new ContinuationError('ROUTE_MISMATCH', `Branch ${target.branchId} belongs to root ${branch.rootId}, not ${target.rootId}`);
    }
    return branch;
  }

  private ensureGuard(ledger: LedgerFile, branchId: BranchId): BranchGuardSnapshot {
    if (!ledger.guards[branchId]) ledger.guards[branchId] = defaultGuard(branchId);
    return ledger.guards[branchId];
  }

  /**
   * Release the active attempt without ever moving the branch fence backward.
   * A recovered/completed attempt's fence stays as the monotonic high-water
   * mark; the next claim increments it again.
   */
  private releaseGuard(ledger: LedgerFile, branchId: BranchId, fence: number): void {
    ledger.guards[branchId] = {
      ...defaultGuard(branchId),
      fence: Math.max(0, Math.floor(Number(fence) || 0)),
    };
  }

  private appendEvent(
    ledger: LedgerFile,
    input: Omit<ContinuationEvent, 'eventId' | 'cursor' | 'at'> & { at?: string },
  ): ContinuationEvent {
    const event: ContinuationEvent = {
      ...input,
      eventId: `event-${randomUUID()}`,
      cursor: ledger.nextEventCursor++,
      at: input.at || new Date().toISOString(),
    };
    ledger.events.push(event);
    if (ledger.events.length > this.eventRetention) ledger.events = ledger.events.slice(-this.eventRetention);
    return event;
  }

  private mutate<T>(apply: (ledger: LedgerFile) => T): T {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const lockHandle = this.acquireLock();
    try {
      this.invalidateCache();
      const ledger = this.readLedgerUnlocked();
      const result = apply(ledger);
      this.writeLedgerUnlocked(ledger);
      return result;
    } finally {
      try { fs.closeSync(lockHandle); } catch { /* lock already released */ }
      try { fs.unlinkSync(this.lockPath); } catch { /* another process may have removed it */ }
    }
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        return fs.openSync(this.lockPath, 'wx');
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code || '') : '';
        if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error;
        if (code === 'EEXIST') {
          try {
            if (Date.now() - fs.statSync(this.lockPath).mtimeMs > 30_000) fs.unlinkSync(this.lockPath);
          } catch { /* lock may have been released */ }
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + attempt);
      }
    }
    throw new ContinuationError('EFFECT_UNCERTAIN', `Timed out acquiring continuation ledger lock: ${this.lockPath}`);
  }

  private readLedger(): LedgerFile {
    this.ensureLedgerExists();
    const stat = fs.statSync(this.ledgerPath, { bigint: true });
    const fingerprint = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    if (this.cached && this.fingerprint === fingerprint) return this.cached;
    const ledger = this.readLedgerUnlocked();
    this.cached = ledger;
    this.fingerprint = fingerprint;
    return ledger;
  }

  private readLedgerUnlocked(): LedgerFile {
    this.ensureLedgerExists();
    try {
      const raw = fs.readFileSync(this.ledgerPath, 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as LedgerFile;
      if (!parsed || parsed.version !== 1 || !parsed.branches || !parsed.builds) {
        throw new ContinuationError('EFFECT_UNCERTAIN', `Continuation ledger ${this.ledgerPath} has an unsupported shape`);
      }
      parsed.attempts = parsed.attempts || {};
      parsed.guards = parsed.guards || {};
      parsed.commands = parsed.commands || {};
      parsed.finals = parsed.finals || {};
      parsed.events = Array.isArray(parsed.events) ? parsed.events : [];
      parsed.nextEventCursor = Math.max(1, Number(parsed.nextEventCursor) || (parsed.events.at(-1)?.cursor || 0) + 1);
      parsed.nextQueueSequence = Math.max(1, Number(parsed.nextQueueSequence) || (Object.values(parsed.builds).reduce((max, build) => Math.max(max, build.queueSequence || 0), 0) + 1));
      return parsed;
    } catch (error) {
      if (error instanceof ContinuationError) throw error;
      throw new ContinuationError('EFFECT_UNCERTAIN', `Continuation ledger ${this.ledgerPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private writeLedgerUnlocked(ledger: LedgerFile): void {
    const temp = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, this.ledgerPath);
    this.invalidateCache();
  }

  private ensureLedgerExists(): void {
    if (fs.existsSync(this.ledgerPath)) return;
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    const ledger = emptyLedger(this.workspaceId);
    const temp = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, this.ledgerPath);
  }

  private invalidateCache(): void {
    this.cached = null;
    this.fingerprint = '';
  }
}

function cloneInput(input: BuildInput): BuildInput {
  return {
    ...input,
    images: input.images?.map(image => ({ ...image })),
    attachments: input.attachments?.map(attachment => ({ ...attachment })),
    branchPath: input.branchPath?.slice(),
  };
}
