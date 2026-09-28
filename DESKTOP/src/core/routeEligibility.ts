/**
 * RouteEligibilityGuard — Auto Router v2 hard-eligibility stage.
 *
 * This module answers exactly one question: "which candidate deployments may
 * the decision engine even see?". It never answers "which candidate is
 * better". Ranking, scoring, learned preference, cost/speed utility and cache
 * affinity are therefore absent by design; the only decision source downstream
 * of this file is the JEV decision engine.
 *
 * Keep this file free of history: no feedback log, no quality_by_task, no
 * user-rating history, no endpoint statistics. Endpoint health is operational
 * input for the decision engine, not an eligibility rule (an endpoint that is
 * currently failing must stay visible so the system can still probe it).
 */
import type {
  AutoRouteCandidate,
  AutoScope,
  DeploymentRef,
  ModelSelection,
  RoutePolicy,
  RouteRequest,
} from './autoRouter';

export interface RouteExclusion {
  deployment: DeploymentRef;
  reasons: string[];
}

export interface RouteEligibilityRequest {
  selection: ModelSelection;
  policy: RoutePolicy;
  request: RouteRequest;
  candidates: AutoRouteCandidate[];
}

export interface RouteEligibilityResult {
  eligible: AutoRouteCandidate[];
  excluded: RouteExclusion[];
}

export function deploymentKey(deployment: DeploymentRef): string {
  return `${deployment.providerId}\u0000${deployment.modelId}\u0000${deployment.logicalModelGroupId || ''}`;
}

export function sameDeploymentRef(left: DeploymentRef, right: DeploymentRef): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export function inAutoScope(deployment: DeploymentRef, scope: AutoScope): boolean {
  return scope.kind === 'global' || deployment.providerId === scope.providerId;
}

export function inAutoSubset(deployment: DeploymentRef, subset: DeploymentRef[] | undefined): boolean {
  if (!subset?.length) return true;
  return subset.some(item => sameDeploymentRef(item, deployment));
}

export function expectedRequestCost(candidate: AutoRouteCandidate, request: RouteRequest): number | undefined {
  const input = finiteNumber(candidate.expectedInputCostUsdPerM);
  const output = finiteNumber(candidate.expectedOutputCostUsdPerM);
  if (input === undefined || output === undefined) return undefined;
  return input * Math.max(0, request.estimatedInputTokens) / 1_000_000
    + output * Math.max(0, request.expectedOutputTokens) / 1_000_000;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * The single authoritative implementation of Auto hard eligibility.
 *
 * `Agent.autoRouteCandidates()` only projects configuration into candidate
 * facts (enabled flag, capability list, prices, context window, privacy and
 * region declarations, observed endpoint health). Every hard rule that can
 * remove a candidate lives here so there is never a second copy of the rules
 * in the Agent or in the execution controller.
 */
export function evaluateRouteEligibility(input: RouteEligibilityRequest): RouteEligibilityResult {
  const { selection, policy, request, candidates } = input;
  const eligible: AutoRouteCandidate[] = [];
  const excluded: RouteExclusion[] = [];

  if (selection.kind === 'fixed') {
    // Fixed selections bypass Auto eligibility entirely; the caller resolves
    // the deployment directly. Returning an empty guard result keeps this
    // function honest about what it can decide.
    return { eligible, excluded };
  }

  for (const candidate of candidates) {
    const reasons: string[] = [];
    if (!candidate.enabled) reasons.push('disabled');
    if (candidate.unavailableReason) reasons.push(candidate.unavailableReason);
    if (!inAutoScope(candidate.deployment, selection.scope)) reasons.push('outside_scope');
    if (!inAutoSubset(candidate.deployment, selection.subset)) reasons.push('outside_subset');
    if (candidate.fallbackOnly) reasons.push('fallback_only');
    if (candidate.preview && !policy.allowPreview) reasons.push('preview_disallowed');
    if (request.estimatedInputTokens + request.expectedOutputTokens > Math.max(0, candidate.maxContextTokens || 0)) {
      reasons.push('context_too_small');
    }

    if (policy.privacy !== 'default' && !candidate.privacy.includes(policy.privacy)) reasons.push(`privacy:${policy.privacy}`);
    if (policy.dataRegion) {
      const requiredRegion = policy.dataRegion.toLowerCase();
      const regions = new Set((candidate.dataRegions || []).map(item => String(item).toLowerCase()));
      if (!regions.has(requiredRegion)) reasons.push(`data_region:${policy.dataRegion}`);
    }
    const supportedParameters = new Set((candidate.supportedProtocolParameters || []).map(item => String(item).toLowerCase()));
    for (const parameter of policy.requiredProtocolParameters || []) {
      const requiredParameter = String(parameter).toLowerCase();
      if (requiredParameter && !supportedParameters.has(requiredParameter)) reasons.push(`protocol_parameter:${requiredParameter}`);
    }
    const expectedCost = expectedRequestCost(candidate, request);
    if (policy.maxExpectedCostUsd !== undefined && (expectedCost === undefined || expectedCost > policy.maxExpectedCostUsd)) {
      reasons.push(expectedCost === undefined ? 'unknown_cost' : 'budget_exceeded');
    }

    if (reasons.length) excluded.push({ deployment: { ...candidate.deployment }, reasons: [...new Set(reasons)] });
    else eligible.push(candidate);
  }

  return { eligible, excluded };
}

/**
 * A candidate excluded by the Guard may still be used by provider-local
 * recovery when *only* the fallback-only marker removed it. This mirrors the
 * pre-existing behaviour: fallback-only deployments are never primary
 * candidates but may serve as an explicit recovery pool.
 */
export function excludedOnlyForFallbackPool(exclusion: RouteExclusion | undefined): boolean {
  return !!exclusion
    && exclusion.reasons.length > 0
    && exclusion.reasons.every(reason => reason === 'fallback_only');
}
