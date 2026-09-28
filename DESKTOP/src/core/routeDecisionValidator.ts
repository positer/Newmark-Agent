/**
 * RouteDecisionValidator — the boundary between a decision engine (which may
 * be a model runtime) and the provider invocation path.
 *
 * A JEV decision is never trusted directly. Before it can become a
 * `RouteDecision` it is checked against the Guard output: the primary must be
 * eligible, alternates must be eligible, duplicates are removed and the
 * provider scope of the request can never be widened by the engine. A decision
 * that fails validation stops Auto routing. There is no alternate local or
 * configured selector when the current model cannot return a valid decision.
 */
import type {
  AutoRouteCandidate,
  DeploymentRef,
  ModelSelection,
  RouteAttempt,
  RouteDecision,
  RoutePolicy,
  RouteRequest,
  TaskClass,
} from './autoRouter';
import { catalogSnapshotHash, createRouteId } from './autoRouter';
import {
  DEFAULT_JEV_MAX_ALTERNATES,
  DEFAULT_JEV_TIMEOUT_MS,
  JEV_ROUTE_MODEL_VERSION,
  buildJevRouteRequest,
  decideWithinBudget,
  type JevDecisionEngine,
  type JevRouteDecision,
} from './jevDecision';
import { evaluateRouteEligibility, sameDeploymentRef, type RouteExclusion } from './routeEligibility';

export type JevDecisionValidationErrorCode =
  | 'no_eligible_candidates'
  | 'missing_primary'
  | 'invalid_deployment'
  | 'primary_not_eligible';

export class JevDecisionValidationError extends Error {
  constructor(readonly code: JevDecisionValidationErrorCode, message: string) {
    super(message);
    this.name = 'JevDecisionValidationError';
  }
}

export interface DroppedAlternate {
  deployment: DeploymentRef;
  reason: 'not_eligible' | 'duplicate' | 'primary_duplicate' | 'over_limit' | 'invalid_deployment';
}

export interface ValidatedJevDecision {
  primary: DeploymentRef;
  alternates: DeploymentRef[];
  reasonCodes: string[];
  confidence?: number;
  modelVersion: string;
  droppedAlternates: DroppedAlternate[];
}

function validDeployment(deployment: unknown): deployment is DeploymentRef {
  if (!deployment || typeof deployment !== 'object') return false;
  const candidate = deployment as Partial<DeploymentRef>;
  return !!String(candidate.providerId || '').trim() && !!String(candidate.modelId || '').trim();
}

function normalizeDeployment(deployment: DeploymentRef): DeploymentRef {
  const logicalModelGroupId = String((deployment as Partial<DeploymentRef>).logicalModelGroupId || '').trim();
  return {
    providerId: String(deployment.providerId),
    modelId: String(deployment.modelId),
    ...(logicalModelGroupId ? { logicalModelGroupId } : {}),
  };
}

/**
 * Validate a decision engine output against the Guard result.
 *
 * The engine may only choose inside the space the Guard allowed. Alternates
 * that leave that space are dropped (they are recovery hints, not primary
 * decisions), while an ineligible primary is a hard failure: routing must fall
 * back deterministically instead of silently executing something the Guard
 * excluded.
 */
export function validateJevDecision(
  decision: JevRouteDecision | null | undefined,
  eligible: AutoRouteCandidate[],
  options: { maxAlternates?: number } = {},
): ValidatedJevDecision {
  if (!eligible.length) {
    throw new JevDecisionValidationError('no_eligible_candidates', 'No eligible candidate was available for Auto selection');
  }
  if (!decision || typeof decision !== 'object') {
    throw new JevDecisionValidationError('missing_primary', 'The decision engine returned no decision');
  }
  if (!validDeployment(decision.primary)) {
    throw new JevDecisionValidationError('missing_primary', 'The decision engine returned no usable primary deployment');
  }
  const allowed = new Map(eligible.map(candidate => [
    `${candidate.deployment.providerId}\u0000${candidate.deployment.modelId}`,
    candidate,
  ]));
  const primary = normalizeDeployment(decision.primary);
  const allowedPrimary = allowed.get(`${primary.providerId}\u0000${primary.modelId}`);
  if (!allowedPrimary) {
    throw new JevDecisionValidationError(
      'primary_not_eligible',
      `The decision engine selected ${primary.providerId}/${primary.modelId}, which the eligibility guard excluded`,
    );
  }

  const maxAlternates = Math.max(0, options.maxAlternates ?? DEFAULT_JEV_MAX_ALTERNATES);
  const alternates: DeploymentRef[] = [];
  const droppedAlternates: DroppedAlternate[] = [];
  const rawAlternates = Array.isArray(decision.alternates) ? decision.alternates : [];
  for (const raw of rawAlternates) {
    if (!validDeployment(raw)) {
      droppedAlternates.push({ deployment: { providerId: String((raw as Partial<DeploymentRef>)?.providerId || ''), modelId: String((raw as Partial<DeploymentRef>)?.modelId || '') }, reason: 'invalid_deployment' });
      continue;
    }
    const alternate = normalizeDeployment(raw);
    if (sameDeploymentRef(alternate, primary)) {
      droppedAlternates.push({ deployment: alternate, reason: 'primary_duplicate' });
      continue;
    }
    if (!allowed.get(`${alternate.providerId}\u0000${alternate.modelId}`)) {
      droppedAlternates.push({ deployment: alternate, reason: 'not_eligible' });
      continue;
    }
    if (alternates.some(existing => sameDeploymentRef(existing, alternate))) {
      droppedAlternates.push({ deployment: alternate, reason: 'duplicate' });
      continue;
    }
    if (alternates.length >= maxAlternates) {
      droppedAlternates.push({ deployment: alternate, reason: 'over_limit' });
      continue;
    }
    alternates.push(alternate);
  }

  return {
    primary: { ...allowedPrimary.deployment, ...primary, ...(allowedPrimary.deployment.logicalModelGroupId && !primary.logicalModelGroupId
      ? { logicalModelGroupId: allowedPrimary.deployment.logicalModelGroupId }
      : {}) },
    alternates,
    reasonCodes: Array.isArray(decision.reasonCodes) ? decision.reasonCodes.map(code => String(code)) : [],
    ...(typeof decision.confidence === 'number' && Number.isFinite(decision.confidence) ? { confidence: decision.confidence } : {}),
    modelVersion: String(decision.modelVersion || 'unknown'),
    droppedAlternates,
  };
}

export interface RouteDecisionBuildInput {
  routeId: string;
  selection: ModelSelection;
  policyVersion: string;
  decisionSource: RouteDecision['decisionSource'];
  catalogSnapshotHash: string;
  taskClasses: TaskClass[];
  excluded: RouteExclusion[];
  decision: ValidatedJevDecision;
  jev: RouteDecision['jev'];
  decisionError?: string;
  pinReason?: RouteDecision['pinReason'];
  attempts?: RouteAttempt[];
  finalStatus?: RouteDecision['finalStatus'];
  retryBudgetMs?: number;
}

export function buildRouteDecision(input: RouteDecisionBuildInput): RouteDecision {
  return {
    routeId: input.routeId,
    requestedSelection: input.selection,
    policyVersion: input.policyVersion,
    decisionSource: input.decisionSource,
    catalogSnapshotHash: input.catalogSnapshotHash,
    taskClasses: [...input.taskClasses],
    excludedCandidates: input.excluded.map(entry => ({ deployment: { ...entry.deployment }, reasons: [...entry.reasons] })),
    resolvedDeployment: { ...input.decision.primary },
    alternatives: input.decision.alternates.map(deployment => ({ ...deployment })),
    jev: input.jev,
    ...(input.decisionError ? { decisionError: input.decisionError } : {}),
    ...(input.pinReason ? { pinReason: input.pinReason } : {}),
    attempts: input.attempts ? input.attempts.map(attempt => ({ ...attempt })) : [],
    finalStatus: input.finalStatus || 'resolved',
    ...(input.retryBudgetMs === undefined ? {} : { retryBudgetMs: input.retryBudgetMs }),
  };
}

export interface AutoRoutePipelineInput {
  selection: ModelSelection;
  policy: RoutePolicy;
  taskText: string;
  request: RouteRequest;
  candidates: AutoRouteCandidate[];
  taskClasses: TaskClass[];
  intelligence?: string;
  engine?: JevDecisionEngine;
  timeoutMs?: number;
  /** Machine-readable reason when the current-model decision engine is absent. */
  unavailableReason?: string;
  previousDeployment?: DeploymentRef | null;
  pinnedDeployment?: DeploymentRef;
  routeId?: string;
  policyVersion?: string;
}

/**
 * The single Auto decision pipeline used by the Agent and by the verification
 * suite. Keeping it here (instead of inline in the Agent) is what guarantees
 * that tests exercise the shipping order of stages:
 *
 *   guard → decision engine → validator → optional transaction pin
 */
export async function resolveAutoRouteDecision(input: AutoRoutePipelineInput): Promise<RouteDecision> {
  const {
    selection, policy, taskText, request, candidates, taskClasses,
  } = input;
  const routeId = input.routeId || createRouteId();
  const policyVersion = input.policyVersion || 'newmark-auto-v2';
  const base = {
    routeId,
    policyVersion,
    taskClasses,
    retryBudgetMs: request.batch ? 15_000 : 5_000,
  };

  const eligibility = evaluateRouteEligibility({ selection, policy, request, candidates });
  const catalogHash = catalogSnapshotHash(candidates);
  if (!eligibility.eligible.length) {
    return {
      routeId: base.routeId,
      requestedSelection: selection,
      policyVersion: base.policyVersion,
      decisionSource: 'jev',
      catalogSnapshotHash: catalogHash,
      taskClasses,
      excludedCandidates: eligibility.excluded,
      alternatives: [],
      jev: { modelVersion: JEV_ROUTE_MODEL_VERSION, reasonCodes: [...taskClasses, 'no_eligible_candidate'], latencyMs: 0 },
      attempts: [],
      finalStatus: 'no_candidate',
      retryBudgetMs: base.retryBudgetMs,
    };
  }

  const timeoutMs = Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
    ? Math.min(5_000, Number(input.timeoutMs))
    : DEFAULT_JEV_TIMEOUT_MS;
  let decisionError = '';
  let failureCode = '';
  let validated: ValidatedJevDecision | null = null;
  let jevLatencyMs = 0;

  if (input.engine) {
    const jevRequest = buildJevRouteRequest({
      transactionId: request.transactionId,
      taskText,
      taskClasses,
      estimatedInputTokens: request.estimatedInputTokens,
      expectedOutputTokens: request.expectedOutputTokens,
      requiredCapabilities: request.requiredCapabilities,
      intelligence: input.intelligence || 'default',
      policy,
      request,
      candidates: eligibility.eligible,
      previousDeployment: input.previousDeployment,
    });
    const outcome = await decideWithinBudget(input.engine as JevDecisionEngine, jevRequest, timeoutMs);
    jevLatencyMs = outcome.latencyMs;
    try {
      if (!outcome.decision) throw new Error(outcome.error?.message || 'The current model returned no JEV decision');
      validated = validateJevDecision(outcome.decision, eligibility.eligible);
    } catch (error) {
      failureCode = outcome.error?.code
        || (error instanceof JevDecisionValidationError ? error.code : 'invalid_output');
      decisionError = `${failureCode}: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    failureCode = input.unavailableReason || 'runtime_unavailable';
    decisionError = `${failureCode}: current-model JEV routing is not available`;
  }

  if (!validated) {
    return {
      routeId: base.routeId,
      requestedSelection: selection,
      policyVersion: base.policyVersion,
      decisionSource: 'jev',
      catalogSnapshotHash: catalogHash,
      taskClasses,
      excludedCandidates: eligibility.excluded,
      alternatives: [],
      jev: { modelVersion: JEV_ROUTE_MODEL_VERSION, reasonCodes: [...taskClasses, `decision_failed:${failureCode || 'unknown'}`], latencyMs: jevLatencyMs },
      decisionError: decisionError || 'current-model decision did not produce a valid JSON route',
      attempts: [],
      finalStatus: 'no_candidate',
      retryBudgetMs: base.retryBudgetMs,
    };
  }

  // Transaction pinning keeps one Build on one deployment. It is execution
  // consistency, not a second routing decision: the pin can only ever hold a
  // deployment the guard already accepted, and a fresh Auto route outside the
  // transaction is decided by JEV alone.
  let primary = validated.primary;
  let alternates = validated.alternates;
  let pinReason: RouteDecision['pinReason'];
  const pinned = input.pinnedDeployment;
  if (pinned
    && !sameDeploymentRef(pinned, primary)
    && eligibility.eligible.some(candidate => sameDeploymentRef(candidate.deployment, pinned))) {
    const previousPrimary = validated.primary;
    primary = { ...pinned };
    pinReason = 'transaction';
    alternates = [previousPrimary, ...validated.alternates]
      .filter(deployment => !sameDeploymentRef(deployment, primary))
      .filter((deployment, index, list) => list.findIndex(item => sameDeploymentRef(item, deployment)) === index)
      .slice(0, DEFAULT_JEV_MAX_ALTERNATES);
  }

  return buildRouteDecision({
    routeId: base.routeId,
    selection,
    policyVersion: base.policyVersion,
    decisionSource: 'jev',
    catalogSnapshotHash: catalogHash,
    taskClasses,
    excluded: eligibility.excluded,
    decision: { ...validated, primary, alternates },
    jev: {
      modelVersion: validated.modelVersion,
      ...(validated.confidence === undefined ? {} : { confidence: validated.confidence }),
      reasonCodes: validated.reasonCodes,
      latencyMs: jevLatencyMs,
    },
    ...(pinReason ? { pinReason } : {}),
    attempts: [{ deployment: { ...primary }, kind: 'initial', status: 'planned' }],
    finalStatus: 'resolved',
    retryBudgetMs: base.retryBudgetMs,
  });
}
