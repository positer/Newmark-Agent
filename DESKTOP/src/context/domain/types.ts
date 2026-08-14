/**
 * dev-0.3.0 context domain model.
 *
 * These are the structured objects that replace ad-hoc "text-拼接式" state.
 * They are independent of the current in-memory `ConversationWorkRun` model so
 * the old path stays untouched until the corresponding feature flag is enabled.
 */

// ---------------------------------------------------------------------------
// Build Block
// ---------------------------------------------------------------------------

export type BuildBlockStatus =
  | 'created'
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BuildBlock {
  id: string;
  conversationId: string;
  branchId: string;
  parentBuildBlockId: string | null;
  /** Creation-time startup input. Never mutated in place; corrections are amendments. */
  startupInput: string;
  status: BuildBlockStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Incremented on every persistent state change. */
  revision: number;
  activeCheckpointId: string | null;
  tokenBudgetPolicyId: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Build History (append-only)
// ---------------------------------------------------------------------------

export type BuildHistoryEntryType =
  | 'user_guide'
  | 'analysis_summary'
  | 'established_fact'
  | 'decision'
  | 'tool_observation'
  | 'implementation_progress'
  | 'verification'
  | 'error'
  | 'warning'
  | 'unresolved_item'
  | 'compression_summary'
  | 'work_overview'
  | 'amendment';

export type BuildHistorySource = 'user' | 'agent' | 'tool' | 'system' | 'subagent' | 'migration';
export type BuildHistoryImportance = 'low' | 'normal' | 'high' | 'critical';

export interface BuildHistoryEntry {
  id: string;
  buildBlockId: string;
  revision: number;
  type: BuildHistoryEntryType;
  content: string;
  structuredData?: Record<string, unknown>;
  source: BuildHistorySource;
  importance: BuildHistoryImportance;
  createdAt: string;
  /** When set, this entry supersedes an earlier entry id (invalidated content). */
  supersededBy: string | null;
  toolCallId?: string;
  /** Idempotency key: re-applying the same operationId must be a no-op. */
  operationId: string;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Branch long-log
// ---------------------------------------------------------------------------

export interface BranchLogBlockRecord {
  buildBlockId: string;
  branchId: string;
  startupInput: string;
  guideTimeline: Array<{ at: string; guide: string; applied: boolean }>;
  resultSummary: string;
  decisions: string[];
  artifacts: string[];
  unresolvedItems: string[];
  supersedes: string[];
  createdAt: string;
}

export interface BranchLogEpoch {
  id: string;
  branchId: string;
  /** Composed from a range of completed build blocks. */
  summary: string;
  firstBuildBlockId: string;
  lastBuildBlockId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Structured Linked Plan
// ---------------------------------------------------------------------------

export type PlanStatus = 'draft' | 'active' | 'blocked' | 'completed' | 'archived' | 'superseded';
export type PlanStepStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

export interface StructuredPlanStep {
  id: string;
  title: string;
  detail: string;
  status: PlanStepStatus;
  expectedVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface StructuredPlan {
  id: string;
  conversationId: string;
  title: string;
  status: PlanStatus;
  revision: number;
  steps: StructuredPlanStep[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Structured Task List
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

export interface StructuredTask {
  id: string;
  conversationId: string;
  buildBlockId?: string;
  title: string;
  detail: string;
  status: TaskStatus;
  /** Optimistic concurrency version. Reject writes when expectedVersion differs. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  blockedReason?: string;
}

// ---------------------------------------------------------------------------
// Tool Result lifecycle
// ---------------------------------------------------------------------------

export type ToolResultLifecycle =
  | 'ephemeral'
  | 'build_scoped'
  | 'conversation_scoped'
  | 'persistent_reference';

export interface ToolResultRecord {
  id: string;
  callId: string;
  toolId: string;
  capabilityId?: string;
  buildBlockId?: string;
  conversationId: string;
  lifecycle: ToolResultLifecycle;
  status: 'ok' | 'error' | 'unknown';
  /** Compact summary placed in context. */
  summary: string;
  /** Optional artifact references for large outputs stored on disk. */
  artifactPaths: string[];
  contentHash: string;
  operationId: string;
  createdAt: string;
  /** Raw output is only carried for `ephemeral` results. */
  rawOutput?: string;
}

// ---------------------------------------------------------------------------
// Toolchain capability model
// ---------------------------------------------------------------------------

export type RiskLevel = 'read' | 'write' | 'external' | 'destructive';
export type SideEffectClass =
  | 'none'
  | 'local_reversible'
  | 'local_irreversible'
  | 'external_reversible'
  | 'external_irreversible';
export type Discoverability = 'always' | 'task_relevant' | 'hidden';
export type LoadPolicy = 'eager' | 'on_demand' | 'approval_required' | 'never';
export type LatencyClass = 'low' | 'medium' | 'high';

export interface CapabilityDescriptor {
  capabilityId: string;
  domain: string;
  name: string;
  shortDescription: string;
  detailedDescription?: string;
  operations: string[];
  riskLevel: RiskLevel;
  sideEffectClass: SideEffectClass;
  requiredPermissions: string[];
  supportedResourceScopes: string[];
  discoverability: Discoverability;
  loadPolicy: LoadPolicy;
  estimatedSchemaTokens: number;
  estimatedLatencyClass: LatencyClass;
  toolIds: string[];
  version: number;
}

export type ToolIdempotency = 'idempotent' | 'conditionally_idempotent' | 'non_idempotent';

/** 最小执行上下文：承载 DSH 工具 execute 的 exec.signal/agent 等运行时能力。 */
export interface ToolExecuteContext {
  signal?: AbortSignal;
  agent?: unknown;
  token?: unknown;
  [key: string]: unknown;
}

/** DSH ToolDefinition.execute 的运行时执行函数签名（cordis 核功能承载）。 */
export type ToolExecuteFn = (args: unknown, context: ToolExecuteContext) => Promise<unknown> | unknown;

/** DSH ToolDefinition.isConcurrencySafe 的运行时并发分类（cordis 核功能承载）。 */
export type ToolConcurrencySafeFn = (args: unknown) => boolean;

/** DSH ToolOutputDefinition.render 的模型可见内容投影。 */
export type ToolRenderFn = (args: unknown, value: unknown) => unknown;

/** DSH ToolOutputDefinition.presentationMeta 的可回放 UI 状态投影。 */
export type ToolPresentationMetaFn = (args: unknown, value: unknown) => unknown;

/** DSH ToolDefinition.finalizeContent 的同步 last-mile 内容变换（可选）。 */
export type ToolFinalizeContentFn = (context: ToolExecuteContext, result: unknown) => unknown;

/** DSH ToolDefinition.presentCall 的 PENDING 卡片展示投影（可选）。 */
export type ToolPresentCallFn = (args: unknown) => unknown;

/** DSH ToolDefinition.presentResult 的 COMPLETED 卡片展示投影（可选）。 */
export type ToolPresentResultFn = (args: unknown, result: unknown) => unknown;

export interface ToolDescriptor {
  toolId: string;
  capabilityId: string;
  namespace: string;
  name: string;
  version: string;
  shortDescription: string;
  fullDescription: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  riskLevel: RiskLevel;
  idempotency: ToolIdempotency;
  requiredPermissions: string[];
  supportedScopes: string[];
  schemaHash: string;
  implementationHash?: string;
  cacheGroup: string;
  enabled: boolean;
  /** DSH ToolDefinition.execute 承载：接入的命令式功能实现（不 import/execute DSH 代码，仅承载已安全注入的函数引用）。 */
  execute?: ToolExecuteFn;
  /** DSH ToolDefinition.isConcurrencySafe 承载：运行时并发分类，静态 riskLevel 的补充。 */
  isConcurrencySafe?: ToolConcurrencySafeFn;
  /** DSH ToolOutputDefinition.render：模型可见内容投影（功能承载）。 */
  render?: ToolRenderFn;
  /** DSH ToolOutputDefinition.presentationMeta：可回放 UI 状态投影（功能承载）。 */
  presentationMeta?: ToolPresentationMetaFn;
  /** DSH ToolDefinition.finalizeContent：同步 last-mile 内容变换（功能承载）。 */
  finalizeContent?: ToolFinalizeContentFn;
  /** DSH ToolDefinition.timeoutMs：协作超时预算（功能承载）。 */
  timeoutMs?: number;
  /** DSH ToolDefinition.presentCall：PENDING 卡片展示投影（功能承载）。 */
  presentCall?: ToolPresentCallFn;
  /** DSH ToolDefinition.presentResult：COMPLETED 卡片展示投影（功能承载）。 */
  presentResult?: ToolPresentResultFn;
}

export interface ActiveToolManifestEntry {
  toolId: string;
  capabilityId: string;
  shortDescription: string;
  riskLevel: RiskLevel;
  availability: 'ready' | 'conditional' | 'temporarily_unavailable';
  schemaLoaded: boolean;
}

export interface ToolExposurePlan {
  planId: string;
  agentRunId: string;
  buildBlockId: string;
  baseToolsetId: string;
  activeToolIds: string[];
  suggestedCapabilityIds: string[];
  omittedToolIds: string[];
  omissionReasons: Record<string, string>;
  estimatedSchemaTokens: number;
  stableToolsetHash: string;
  createdAt: string;
}

export type ToolExposureScope = 'single_turn' | 'build_block' | 'agent_run' | 'conversation';

export interface ToolExposureRecord {
  exposureId: string;
  agentRunId: string;
  toolId: string;
  scope: ToolExposureScope;
  reason: string;
  loadedAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  schemaHash: string;
}

// ---------------------------------------------------------------------------
// Context usage snapshot (frontend/backend contract)
// ---------------------------------------------------------------------------

export type TokenizerSource =
  | 'provider_tokenizer'
  | 'model_tokenizer'
  | 'local_compatible_tokenizer'
  | 'provider_reported'
  | 'estimated';

export type TokenAccuracy = 'exact' | 'provider_reported' | 'compatible' | 'estimated';

export interface ContextSectionUsage {
  sectionName: string;
  order: number;
  estimatedTokens: number;
  contentHash: string;
}

export interface ContextUsageSnapshot {
  snapshotId: string;
  conversationId: string;
  branchId: string;
  buildBlockId: string;
  agentId: string;
  agentType: 'main' | 'subagent';
  provider: string;
  model: string;
  modelContextLimit: number;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  estimatedTotalTokens: number;
  effectiveContextBudget: number;
  remainingInputTokens: number;
  usageRatio: number;
  sections: ContextSectionUsage[];
  tokenizerSource: TokenizerSource;
  accuracy: TokenAccuracy;
  calculationRevision: number;
  contextContentHash: string;
  createdAt: string;
  /** Set when the provider reported actual usage after the request. */
  actualInputTokens?: number;
  actualOutputTokens?: number;
  /** Estimation error versus actual usage (diagnostic only). */
  estimateErrorTokens?: number;
}

// ---------------------------------------------------------------------------
// Agent Run (persisted state machine)
// ---------------------------------------------------------------------------

export type AgentRunStatus =
  | 'created'
  | 'preparing_context'
  | 'waiting_model'
  | 'streaming'
  | 'waiting_tools'
  | 'executing_tools'
  | 'verifying'
  | 'checkpointing'
  | 'waiting_subagents'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovering';

export interface AgentRun {
  id: string;
  conversationId: string;
  buildBlockId: string;
  agentId: string;
  agentType: 'main' | 'subagent';
  status: AgentRunStatus;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  pauseReason?: string;
  iteration: number;
  /** Limits. */
  maxIterations: number;
  maxRunDurationMs: number;
  maxConsecutiveModelErrors: number;
  maxConsecutiveToolErrors: number;
  maxNoProgressIterations: number;
  maxCumulativeCostUsd?: number;
  costUsd: number;
  consecutiveModelErrors: number;
  consecutiveToolErrors: number;
  noProgressIterations: number;
  activeCheckpointId?: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SubAgent
// ---------------------------------------------------------------------------

export interface SubAgentContextPackage {
  runId: string;
  parentRunId: string;
  task: string;
  allowedCapabilityDomains: string[];
  loadedToolIds: string[];
  discoverableCapabilityIds: string[];
  forbiddenCapabilityIds: string[];
  resourceScopes: string[];
  riskCeiling: RiskLevel;
  immutableContextHash: string;
  createdAt: string;
}

export interface SubAgentDelta {
  runId: string;
  appendedAt: string;
  content: string;
  sequence: number;
}
