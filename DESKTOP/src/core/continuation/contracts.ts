/**
 * continuation-v1 contracts.
 *
 * These are the runtime-checked boundaries shared by the PC GUI, the hosted
 * mobile API and the isolated runtimes. A view may read a snapshot, but it can
 * never supply the execution identity that a write is allowed to use.
 */

export type WorkspaceId = string;
export type RootId = string;
export type BranchId = string;
export type BuildId = string;
export type AttemptId = string;
export type CommandId = string;
export type SnapshotId = string;

export const CONTINUATION_SCHEMA_VERSION = 1 as const;

export type BuildStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_TOOL'
  | 'WAITING_APPROVAL'
  | 'WAITING_SUBAGENT'
  | 'FINALIZING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export type AttemptStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';

export type ContinuationErrorCode =
  | 'TARGET_REQUIRED'
  | 'ROUTE_MISMATCH'
  | 'QUEUE_REVISION_CONFLICT'
  | 'ANCHOR_NOT_IN_LINEAGE'
  | 'ANCHOR_NOT_COMMITTED'
  | 'IDEMPOTENCY_KEY_REUSE'
  | 'STALE_EXECUTION'
  | 'FINAL_ALREADY_COMMITTED'
  | 'BUILD_NOT_READY'
  | 'BRANCH_PAUSED'
  | 'EFFECT_UNCERTAIN'
  | 'UNKNOWN_BRANCH'
  | 'UNKNOWN_BUILD'
  | 'UNKNOWN_COMMAND';

export class ContinuationError extends Error {
  constructor(
    public readonly code: ContinuationErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContinuationError';
  }
}

export interface CommandTarget {
  workspaceId: WorkspaceId;
  expectedRootId: RootId;
  branchId: BranchId;
}

export interface BuildInput {
  text: string;
  images?: Array<{ dataUrl: string; name?: string; type?: string }>;
  attachments?: Array<{ id: string; name: string; mimeType: string; dataUrl?: string }>;
  requestedMode?: string;
  goalObjective?: string;
  /** Provider-qualified model frozen at command acceptance time. */
  modelSelection?: string;
  /** Branch node captured when the user submitted the command. */
  branchNodeId?: string;
  branchPath?: string[];
}

export interface EnqueueBuildCommand {
  schemaVersion: typeof CONTINUATION_SCHEMA_VERSION;
  type: 'ENQUEUE_BUILD';
  commandId: CommandId;
  actorId: string;
  target: CommandTarget;
  expectedTailBuildId: BuildId | null;
  expectedQueueRevision: number;
  input: BuildInput;
  recipeSnapshotId: SnapshotId;
  createdAt: string;
}

export interface CommandReceipt {
  schemaVersion: typeof CONTINUATION_SCHEMA_VERSION;
  commandId: CommandId;
  requestHash: string;
  workspaceId: WorkspaceId;
  rootId: RootId;
  branchId: BranchId;
  buildId: BuildId;
  parentBuildId: BuildId | null;
  queueSequence: number;
  queueRevision: number;
  lifecycleRevision: number;
  acceptedAt: string;
  duplicate?: boolean;
}

export interface ExecutionScope {
  workspaceId: WorkspaceId;
  rootId: RootId;
  branchId: BranchId;
  buildId: BuildId;
  attemptId: AttemptId;
  fence: number;
  parentBuildId: BuildId | null;
  baseContextSnapshotId: SnapshotId;
  environmentSnapshotId: SnapshotId;
  workerCapability: string;
}

export interface BranchGuardSnapshot {
  branchId: BranchId;
  activeBuildId: BuildId | null;
  activeAttemptId: AttemptId | null;
  fence: number;
  leaseUntil: number;
  workerCapability: string;
}

export interface QueueSnapshot {
  workspaceId: WorkspaceId;
  rootId: RootId;
  branchId: BranchId;
  headBuildId: BuildId | null;
  tailBuildId: BuildId | null;
  queueRevision: number;
  lifecycleRevision: number;
  paused: boolean;
  activeBuildId: BuildId | null;
  guard: BranchGuardSnapshot;
  builds: BuildRecord[];
}

export interface BuildRecord {
  buildId: BuildId;
  workspaceId: WorkspaceId;
  rootId: RootId;
  branchId: BranchId;
  parentBuildId: BuildId | null;
  inputHash: string;
  input: BuildInput;
  recipeSnapshotId: SnapshotId;
  status: BuildStatus;
  queueSequence: number;
  createdAt: string;
  updatedAt: string;
  finalId?: string;
  waitingReason?: string;
}

export interface AttemptRecord {
  attemptId: AttemptId;
  buildId: BuildId;
  branchId: BranchId;
  fence: number;
  status: AttemptStatus;
  leaseUntil: number;
  workerCapability: string;
  startedAt: string;
  endedAt?: string;
}

export interface FinalRecord {
  finalId: string;
  buildId: BuildId;
  branchId: BranchId;
  finalHash: string;
  stateSnapshotId: SnapshotId;
  text: string;
  committedAt: string;
}

export interface ContinuationEvent {
  eventId: string;
  cursor: number;
  type:
    | 'BuildAccepted'
    | 'AttemptStarted'
    | 'AttemptHeartbeat'
    | 'BuildCommitted'
    | 'BuildFailed'
    | 'BuildCancelled'
    | 'BranchForked'
    | 'BranchPaused'
    | 'BranchResumed'
    | 'StaleWriteRejected';
  workspaceId: WorkspaceId;
  rootId: RootId;
  branchId: BranchId;
  buildId: BuildId | null;
  attemptId: AttemptId | null;
  fence: number | null;
  at: string;
  payload?: Record<string, unknown>;
}

export interface LedgerFile {
  version: typeof CONTINUATION_SCHEMA_VERSION;
  workspaceId: WorkspaceId;
  roots: Record<RootId, { rootId: RootId; workspaceId: WorkspaceId; defaultBranchId: BranchId; createdAt: string }>;
  branches: Record<BranchId, BranchRecord>;
  builds: Record<BuildId, BuildRecord>;
  attempts: Record<AttemptId, AttemptRecord>;
  guards: Record<BranchId, BranchGuardSnapshot>;
  commands: Record<string, CommandReceipt>;
  finals: Record<BuildId, FinalRecord>;
  events: ContinuationEvent[];
  nextEventCursor: number;
  nextQueueSequence: number;
}

export interface BranchRecord {
  branchId: BranchId;
  workspaceId: WorkspaceId;
  rootId: RootId;
  parentAnchorBuildId: BuildId | null;
  headBuildId: BuildId | null;
  tailBuildId: BuildId | null;
  queueRevision: number;
  lifecycleRevision: number;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function emptyLedger(workspaceId: WorkspaceId): LedgerFile {
  return {
    version: CONTINUATION_SCHEMA_VERSION,
    workspaceId,
    roots: {},
    branches: {},
    builds: {},
    attempts: {},
    guards: {},
    commands: {},
    finals: {},
    events: [],
    nextEventCursor: 1,
    nextQueueSequence: 1,
  };
}

export function defaultGuard(branchId: BranchId): BranchGuardSnapshot {
  return { branchId, activeBuildId: null, activeAttemptId: null, fence: 0, leaseUntil: 0, workerCapability: '' };
}

export function commandKey(actorId: string, commandId: CommandId): string {
  return `${actorId}\u0000${commandId}`;
}

export function buildInputHash(input: BuildInput): string {
  return require('crypto').createHash('sha256').update(stableJson(input)).digest('hex').slice(0, 24);
}

export function requestHash(command: EnqueueBuildCommand): string {
  return require('crypto').createHash('sha256').update(stableJson({
    type: command.type,
    target: command.target,
    expectedTailBuildId: command.expectedTailBuildId,
    expectedQueueRevision: command.expectedQueueRevision,
    input: command.input,
    recipeSnapshotId: command.recipeSnapshotId,
  })).digest('hex');
}
