/**
 * Auto Router v2 — shared route contracts, failure classification, operational
 * endpoint health and provider-local recovery planning.
 *
 * This file no longer selects models. Model selection is the exclusive
 * responsibility of the JEV decision engine (`jevDecision.ts`) inside the
 * candidate space produced by the deterministic eligibility guard
 * (`routeEligibility.ts`). What remains here is execution plumbing:
 *
 *   - shared route types (`RouteDecision`, `RouteAttempt`, `RoutePolicy`, …)
 *   - provider failure classification
 *   - endpoint health / circuit breaker (operational protection only)
 *   - build-scoped transaction pinning (execution consistency inside one Build)
 *   - provider-local recovery planning (retry / equivalent / fallback / JEV alternate)
 *
 * Removed on purpose: the feedback map, EWMA preference learning,
 * `quality_by_task` scoring, cache affinity, switch thresholds, and every
 * weighted cost/reliability/speed utility pass. Nothing in this file may
 * reconstruct a second model selector.
 */
import { createHash, randomUUID } from 'crypto';
import { excludedOnlyForFallbackPool, inAutoScope, inAutoSubset, sameDeploymentRef } from './routeEligibility';

export type AutoScope =
  | { kind: 'global' }
  | { kind: 'provider'; providerId: string };

export interface DeploymentRef {
  providerId: string;
  modelId: string;
  logicalModelGroupId?: string;
}

export type ModelSelection =
  | { kind: 'fixed'; deployment: DeploymentRef }
  | { kind: 'auto'; scope: AutoScope; policyId: string; subset?: DeploymentRef[] };

export type RouteMode = 'conservative' | 'balanced' | 'aggressive';
export type RoutePrivacy = 'default' | 'no_training' | 'zdr';
export type TaskClass = 'chat' | 'coding' | 'reasoning' | 'long_context' | 'vision' | 'image_generation' | 'tool_use' | 'computer_use';
export type ValidationLevel = 'discovered' | 'legacy_basic' | 'basic' | 'standard' | 'extended';
export type ValidationStatus = 'verified' | 'degraded' | 'unavailable' | 'auth_error' | 'rate_limited' | 'invalid_config';

export interface RoutePolicy {
  mode: RouteMode;
  allowPreview: boolean;
  privacy: RoutePrivacy;
  requiredCapabilities: string[];
  dataRegion?: string;
  requiredProtocolParameters?: string[];
  maxExpectedCostUsd?: number;
}

export interface AutoRouteCandidate {
  deployment: DeploymentRef;
  enabled: boolean;
  /**
   * Set by the Agent when a deployment is explicitly unusable right now
   * (for example a provider-reported balance exhaustion window). It carries a
   * guard reason instead of silently mutating `enabled`.
   */
  unavailableReason?: string;
  validation: { level: ValidationLevel; status: ValidationStatus; checkedAt: string };
  capabilities: string[];
  maxContextTokens: number;
  preview: boolean;
  privacy: RoutePrivacy[];
  dataRegions?: string[];
  supportedProtocolParameters?: string[];
  expectedInputCostUsdPerM?: number;
  expectedOutputCostUsdPerM?: number;
  /** Current operational measurements. Never persisted as a preference. */
  latencyMs?: number;
  reliability?: number;
  toolValidity?: number;
  throughput?: number;
  circuit?: 'closed' | 'open' | 'half_open';
  /** Explicit user configuration (`route_preference`), not learned history. */
  preference?: number;
  fallbackOnly?: boolean;
}

export interface RouteRequest {
  transactionId: string;
  taskText: string;
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  requiredCapabilities: string[];
  batch?: boolean;
}

export type RouteAttemptStatus = 'planned' | 'success' | 'failed' | 'blocked';
export interface RouteAttempt {
  deployment: DeploymentRef;
  kind: 'initial' | 'retry_same_deployment' | 'equivalent_deployment' | 'fallback_model' | 'alternate_model';
  status: RouteAttemptStatus;
  errorType?: RouteFailureType;
  durationMs?: number;
  streamCommitted?: boolean;
  sideEffectBoundary?: boolean;
  retryDelayMs?: number;
}

export interface RouteDecision {
  routeId: string;
  requestedSelection: ModelSelection;
  policyVersion: string;
  decisionSource: 'jev';
  catalogSnapshotHash: string;
  taskClasses: TaskClass[];
  excludedCandidates: Array<{ deployment: DeploymentRef; reasons: string[] }>;
  resolvedDeployment?: DeploymentRef;
  /** Ordered recovery hints produced by the decision engine, already validated. */
  alternatives: DeploymentRef[];
  jev: {
    modelVersion: string;
    confidence?: number;
    reasonCodes: string[];
    latencyMs: number;
  };
  decisionError?: string;
  pinReason?: 'transaction';
  attempts: RouteAttempt[];
  finalStatus: 'resolved' | 'no_candidate' | 'fixed_unavailable' | 'retrying' | 'succeeded' | 'failed' | 'blocked';
  retryBudgetMs?: number;
}

export type RouteFailureType =
  | 'timeout'
  | 'rate_limited'
  | 'transport'
  | 'server_error'
  | 'empty_response'
  | 'invalid_request'
  | 'invalid_schema'
  | 'unknown_tool'
  | 'auth'
  | 'content_policy'
  | 'policy_denied'
  | 'balance_exhausted'
  | 'execution_error';

export interface RouteFailure {
  type: RouteFailureType;
  retryable: boolean;
  switchAllowed: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}

export interface PlannedRouteAttempt extends RouteAttempt {
  status: 'planned';
}

interface HealthEvent {
  at: number;
  ok: boolean;
  type?: RouteFailureType;
  latencyMs?: number;
  throughput?: number;
}

interface ToolHealthEvent {
  at: number;
  ok: boolean;
}

interface EndpointHealth {
  events: HealthEvent[];
  toolEvents: ToolHealthEvent[];
  consecutiveTransportFailures: number;
  openUntil: number;
  halfOpenClaimed: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const VALIDATION_TTL_MS = 7 * DAY_MS;
const HEALTH_WINDOW_MS = 30 * 60_000;
const CIRCUIT_COOLDOWN_MS = 60_000;

export const ROUTE_POLICY_VERSION = 'newmark-auto-v2';

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function deploymentKey(deployment: DeploymentRef): string {
  return `${deployment.providerId}\u0000${deployment.modelId}\u0000${deployment.logicalModelGroupId || ''}`;
}

export function normalizeAutoPreference(value: string): RouteMode {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'conservative' || normalized === 'balanced' || normalized === 'aggressive') return normalized;
  // Previous values selected fixed quality/cost/speed objectives. They do not
  // have a reliable one-to-one mapping to a model decision tendency.
  return 'balanced';
}

export function defaultRoutePolicy(mode: RouteMode = 'balanced'): RoutePolicy {
  return {
    mode,
    allowPreview: false,
    privacy: 'default',
    requiredCapabilities: [],
  };
}

export function classifyTaskClasses(taskText: string, requiredCapabilities: string[], estimatedInputTokens = 0): TaskClass[] {
  const text = String(taskText || '').toLowerCase();
  const required = new Set(requiredCapabilities.map(item => String(item).toLowerCase()));
  const classes = new Set<TaskClass>();
  if (/\b(code|coding|implement|refactor|debug|typescript|javascript|python|rust|golang)\b/i.test(text) || /(编程|代码|实现|重构|调试)/.test(text)) classes.add('coding');
  if (/\b(reason|prove|derive|analy[sz]e|logic|theorem)\b/i.test(text) || /(推理|证明|推导|分析)/.test(text)) classes.add('reasoning');
  if (estimatedInputTokens >= 32_000 || /long[_ -]?context|长上下文/i.test(text)) classes.add('long_context');
  if (required.has('image_input') || /vision|screenshot|image attachment|视觉|截图|图片|图像/i.test(text)) classes.add('vision');
  if (required.has('image_output') || /generate (?:an )?image|image generation|生成图片|图像生成/i.test(text)) classes.add('image_generation');
  if (/tool[_ -]?use|function call|call (?:a |the )?tool|工具调用|调用工具/i.test(text)
    || /\b(?:list|inspect|search|read|write|edit|modify|create|delete)\b[^.\n]{0,48}\b(?:workspace|repo(?:sitory)?|files?|director(?:y|ies))\b/i.test(text)
    || /(?:列出|查看|检查|搜索|读取|写入|编辑|修改|创建|删除).{0,16}(?:工作区|仓库|文件|目录)/.test(text)) classes.add('tool_use');
  if (required.has('computer_use') || /computer[_ -]?use|click|keyboard|scroll|电脑操作|点击|滚动/i.test(text)) classes.add('computer_use');
  if (!classes.size) classes.add('chat');
  return [...classes];
}

export function classifyRouteFailure(error: unknown): RouteFailure {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
  // Gateways may return HTTP 200 followed by a structured provider error.
  // Match actual code/type fields, never incidental overload words in prose.
  let structuredCodes: string[] = [];
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonStart));
      const detail = payload?.error || payload?.response?.error || payload;
      structuredCodes = [detail?.code, detail?.type].filter(value => typeof value === 'string').map(value => value.toLowerCase());
    } catch { /* Ordinary non-JSON errors retain their existing classification. */ }
  }
  const statusMatch = text.match(/(?:http|error|status)?\s*[:=]?\s*(408|429|4\d\d|5\d\d)\b/i);
  const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
  const retryAfterMatch = text.match(/retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i);
  const retryAfterValue = retryAfterMatch ? Number(retryAfterMatch[1]) : undefined;
  const retryAfterMs = retryAfterValue === undefined
    ? undefined
    : retryAfterValue * ((retryAfterMatch?.[2] || 's').toLowerCase() === 'ms' ? 1 : 1_000);
  if (/content policy|moderation|safety refusal|content_filter|审核|内容策略/i.test(text)) {
    return { type: 'content_policy', retryable: false, switchAllowed: false, statusCode };
  }
  if (/unknown tool|unknown function|未知工具/i.test(text)) return { type: 'unknown_tool', retryable: false, switchAllowed: false, statusCode };
  if (/invalid schema|schema mismatch|json schema|无效.*schema/i.test(text)) return { type: 'invalid_schema', retryable: false, switchAllowed: false, statusCode };
  if (/policy denied|permission denied|not allowed|策略拒绝/i.test(text)) return { type: 'policy_denied', retryable: false, switchAllowed: false, statusCode };
  if (statusCode === 401 || statusCode === 403 || /unauthori[sz]ed|forbidden|authentication|invalid api key/i.test(text)) {
    return { type: 'auth', retryable: false, switchAllowed: false, statusCode };
  }
  if (statusCode === 400 || /bad request|invalid parameter|invalid request/i.test(text)) {
    return { type: 'invalid_request', retryable: false, switchAllowed: false, statusCode };
  }
  if (statusCode === 402 || /insufficient balance|insufficient funds|payment required|insufficient[_ -]?quota|quota (?:exceeded|exhausted)|credit(?:s| balance)? (?:exhausted|depleted)|billing hard limit|budget exhausted|余额不足|额度不足|配额(?:不足|耗尽|超限)/i.test(text)) {
    return { type: 'balance_exhausted', retryable: false, switchAllowed: true, statusCode: statusCode || 402 };
  }
  if (statusCode === 429 || /rate limit|too many requests/i.test(text)) {
    return { type: 'rate_limited', retryable: true, switchAllowed: true, statusCode: 429, retryAfterMs };
  }
  if (statusCode === 408 || /timeout|timed out|aborterror/i.test(text)) {
    return { type: 'timeout', retryable: true, switchAllowed: true, statusCode, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  if ((statusCode !== undefined && statusCode >= 500)
    || structuredCodes.some(code => ['server_is_overloaded', 'overloaded_error', 'service_unavailable_error', 'server_error', 'internal_server_error'].includes(code))) {
    return { type: 'server_error', retryable: true, switchAllowed: true, statusCode, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  if (/empty response|no response body|empty completion/i.test(text)) return { type: 'empty_response', retryable: true, switchAllowed: true };
  if (/network|econn|enotfound|socket|fetch failed|connection reset|transport/i.test(text)) {
    return { type: 'transport', retryable: true, switchAllowed: true };
  }
  return { type: 'execution_error', retryable: false, switchAllowed: false, statusCode };
}

export function createRouteId(): string {
  return randomUUID();
}

export function catalogSnapshotHash(candidates: AutoRouteCandidate[]): string {
  const snapshot = candidates.map(candidate => ({
    deployment: candidate.deployment,
    enabled: candidate.enabled,
    unavailableReason: candidate.unavailableReason,
    validation: candidate.validation,
    capabilities: [...candidate.capabilities].sort(),
    maxContextTokens: candidate.maxContextTokens,
    preview: candidate.preview,
    privacy: [...candidate.privacy].sort(),
    dataRegions: [...(candidate.dataRegions || [])].sort(),
    supportedProtocolParameters: [...(candidate.supportedProtocolParameters || [])].sort(),
    expectedInputCostUsdPerM: candidate.expectedInputCostUsdPerM,
    expectedOutputCostUsdPerM: candidate.expectedOutputCostUsdPerM,
    latencyMs: candidate.latencyMs,
    reliability: candidate.reliability,
    toolValidity: candidate.toolValidity,
    throughput: candidate.throughput,
    circuit: candidate.circuit,
    preference: candidate.preference,
    fallbackOnly: !!candidate.fallbackOnly,
  })).sort((left, right) => deploymentKey(left.deployment).localeCompare(deploymentKey(right.deployment)));
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/**
 * Operational execution controller.
 *
 * It owns endpoint health, the circuit breaker, build-scoped transaction pins
 * and the provider-local recovery ladder. It never ranks models and never
 * learns a preference; health observations only decide whether an endpoint is
 * attempted right now.
 */
export class RouteExecutionController {
  private readonly now: () => number;
  private readonly policyVersion: string;
  private readonly transactionPins = new Map<string, DeploymentRef>();
  private readonly endpointHealth = new Map<string, EndpointHealth>();

  constructor(options: { now?: () => number; policyVersion?: string } = {}) {
    this.now = options.now || Date.now;
    this.policyVersion = options.policyVersion || ROUTE_POLICY_VERSION;
  }

  version(): string {
    return this.policyVersion;
  }

  /** Execution-consistency pin for one Build / route transaction. */
  pinTransaction(transactionId: string, deployment: DeploymentRef): void {
    if (!transactionId || !deployment.providerId || !deployment.modelId) return;
    this.transactionPins.set(transactionId, { ...deployment });
  }

  transactionPin(transactionId: string): DeploymentRef | undefined {
    const pinned = this.transactionPins.get(transactionId);
    return pinned ? { ...pinned } : undefined;
  }

  endTransaction(transactionId: string): void {
    this.transactionPins.delete(transactionId);
  }

  /**
   * Provider-local recovery ladder.
   *
   * Order of preference: retry the same deployment (when the failure is
   * retryable inside the retry budget), then an equivalent deployment of the
   * same logical model group, then the alternates the decision engine already
   * validated (in the order it produced them), then explicit fallback-only
   * models. Recovery never crosses the failed provider boundary and never
   * re-runs model selection.
   */
  planAttempts(
    decision: RouteDecision,
    candidates: AutoRouteCandidate[],
    failure: { error: RouteFailure; streamCommitted: boolean; sideEffectCommitted: boolean; allowModelFallback?: boolean },
  ): PlannedRouteAttempt[] {
    const current = decision.resolvedDeployment;
    if (!current || !failure.error.switchAllowed || failure.streamCommitted || failure.sideEffectCommitted) return [];
    const remainingAttempts = Math.max(0, 3 - decision.attempts.length);
    if (!remainingAttempts) return [];
    const attempts: PlannedRouteAttempt[] = [];
    const retryDelayMs = failure.error.retryAfterMs ?? 250;
    const alreadyRetriedCurrent = decision.attempts.some(attempt => attempt.kind === 'retry_same_deployment'
      && sameDeploymentRef(attempt.deployment, current));
    if (failure.error.retryable && !alreadyRetriedCurrent && retryDelayMs <= (decision.retryBudgetMs ?? 5_000)) {
      attempts.push({
        deployment: { ...current },
        kind: 'retry_same_deployment',
        status: 'planned',
        errorType: failure.error.type,
        streamCommitted: false,
        sideEffectBoundary: false,
        retryDelayMs,
      });
    }
    if (failure.allowModelFallback === false) return attempts.slice(0, remainingAttempts);
    const selection = decision.requestedSelection;
    if (selection.kind === 'fixed') return attempts.slice(0, remainingAttempts);
    const subset = selection.kind === 'auto' ? selection.subset : undefined;
    const currentGroup = current.logicalModelGroupId;
    const currentProviderId = current.providerId;
    const attemptedDeployments = decision.attempts.map(attempt => attempt.deployment);
    // Fallback is a recovery operation, not a new global routing decision.
    // It must never cross the provider boundary, even when the original Auto
    // selection has global scope. This prevents equal model ids from silently
    // switching credentials/endpoints (for example provider A/model X to
    // provider B/model X).
    const eligible = candidates.filter(candidate => candidate.enabled
      && !candidate.unavailableReason
      && candidate.deployment.providerId === currentProviderId
      && inAutoScope(candidate.deployment, { kind: 'provider', providerId: currentProviderId })
      && inAutoSubset(candidate.deployment, subset)
      && !sameDeploymentRef(candidate.deployment, current)
      && !attemptedDeployments.some(attempted => sameDeploymentRef(candidate.deployment, attempted))
      && this.passedInitialHardFilters(decision, candidate));
    const equivalent = currentGroup
      ? eligible.find(candidate => candidate.deployment.logicalModelGroupId === currentGroup && !candidate.fallbackOnly)
      : undefined;
    const fallback = eligible.find(candidate => candidate.fallbackOnly);
    const orderedAlternates: AutoRouteCandidate[] = [];
    for (const alternate of decision.alternatives) {
      const match = eligible.find(candidate => sameDeploymentRef(candidate.deployment, alternate));
      if (!match || match === equivalent || match === fallback || match.fallbackOnly) continue;
      if (orderedAlternates.some(existing => sameDeploymentRef(existing.deployment, match.deployment))) continue;
      orderedAlternates.push(match);
    }
    for (const candidate of eligible) {
      if (candidate === equivalent || candidate === fallback || candidate.fallbackOnly
        || orderedAlternates.some(existing => sameDeploymentRef(existing.deployment, candidate.deployment))) continue;
      orderedAlternates.push(candidate);
    }
    for (const next of [equivalent, ...orderedAlternates, fallback]) {
      if (!next || attempts.length >= 2) continue;
      attempts.push({
        deployment: { ...next.deployment },
        kind: next === equivalent ? 'equivalent_deployment' : next === fallback ? 'fallback_model' : 'alternate_model',
        status: 'planned',
        errorType: failure.error.type,
        streamCommitted: false,
        sideEffectBoundary: false,
      });
    }
    return attempts.slice(0, remainingAttempts);
  }

  recordEndpointFailure(deployment: DeploymentRef, failure: RouteFailureType | RouteFailure): void {
    const routeFailure = typeof failure === 'string'
      ? failureFromType(failure)
      : failure;
    const now = this.now();
    const health = this.healthFor(deployment, now);
    health.events.push({ at: now, ok: false, type: routeFailure.type });
    trimHealth(health, now);
    if (routeFailure.type === 'auth') {
      health.openUntil = Number.POSITIVE_INFINITY;
      health.halfOpenClaimed = true;
      return;
    }
    if (routeFailure.type === 'transport' || routeFailure.type === 'timeout' || routeFailure.type === 'server_error' || routeFailure.type === 'empty_response') {
      health.consecutiveTransportFailures += 1;
      if (health.consecutiveTransportFailures >= 3) {
        health.openUntil = now + CIRCUIT_COOLDOWN_MS;
        health.halfOpenClaimed = false;
      }
    } else {
      health.consecutiveTransportFailures = 0;
    }
  }

  recordEndpointSuccess(deployment: DeploymentRef, latencyMs?: number, throughput?: number): void {
    const now = this.now();
    const health = this.healthFor(deployment, now);
    health.events.push({ at: now, ok: true, latencyMs: finite(latencyMs), throughput: finite(throughput) });
    health.consecutiveTransportFailures = 0;
    health.openUntil = 0;
    health.halfOpenClaimed = false;
    trimHealth(health, now);
  }

  resetEndpointAfterConfigChange(deployment: DeploymentRef): void {
    this.endpointHealth.delete(deploymentKey(deployment));
  }

  claimEndpointAttempt(deployment: DeploymentRef): boolean {
    return this.circuitState(deployment, this.now(), true) !== 'open';
  }

  recordToolOutcome(deployment: DeploymentRef, valid: boolean): void {
    const now = this.now();
    const health = this.healthFor(deployment, now);
    health.toolEvents.push({ at: now, ok: valid });
    trimHealth(health, now);
  }

  endpointMetrics(deployment: DeploymentRef): { attempts: number; reliability: number; p50?: number; p95?: number; throughput?: number; toolAttempts: number; toolValidity: number; circuit: 'closed' | 'open' | 'half_open' } {
    const now = this.now();
    const health = this.healthFor(deployment, now);
    trimHealth(health, now);
    const successes = health.events.filter(event => event.ok).length;
    const latencies = health.events.flatMap(event => event.ok && event.latencyMs !== undefined ? [event.latencyMs] : []).sort((a, b) => a - b);
    const throughputs = health.events.flatMap(event => event.ok && event.throughput !== undefined ? [event.throughput] : []).sort((a, b) => a - b);
    const validTools = health.toolEvents.filter(event => event.ok).length;
    return {
      attempts: health.events.length,
      reliability: (successes + 2) / (health.events.length + 4),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      throughput: percentile(throughputs, 0.5),
      toolAttempts: health.toolEvents.length,
      toolValidity: (validTools + 2) / (health.toolEvents.length + 4),
      circuit: this.circuitState(deployment, now, false),
    };
  }

  private healthFor(deployment: DeploymentRef, now: number): EndpointHealth {
    const key = deploymentKey(deployment);
    let health = this.endpointHealth.get(key);
    if (!health) {
      health = { events: [], toolEvents: [], consecutiveTransportFailures: 0, openUntil: 0, halfOpenClaimed: false };
      this.endpointHealth.set(key, health);
    }
    trimHealth(health, now);
    return health;
  }

  private passedInitialHardFilters(decision: RouteDecision, candidate: AutoRouteCandidate): boolean {
    const exclusion = decision.excludedCandidates.find(entry => sameDeploymentRef(entry.deployment, candidate.deployment));
    if (!exclusion) return true;
    return !!candidate.fallbackOnly && excludedOnlyForFallbackPool(exclusion);
  }

  private circuitState(deployment: DeploymentRef, now: number, claimHalfOpen = true): 'closed' | 'open' | 'half_open' {
    const health = this.healthFor(deployment, now);
    if (health.openUntil === Number.POSITIVE_INFINITY || health.openUntil > now) return 'open';
    if (health.openUntil > 0) {
      if (!health.halfOpenClaimed) {
        if (claimHalfOpen) health.halfOpenClaimed = true;
        return 'half_open';
      }
      return 'open';
    }
    return 'closed';
  }
}

export function validationEvidenceIsStale(checkedAt: string | undefined, now = Date.now()): boolean {
  const checked = Date.parse(String(checkedAt || ''));
  if (!Number.isFinite(checked)) return true;
  return now - checked > VALIDATION_TTL_MS;
}

function trimHealth(health: EndpointHealth, now: number): void {
  health.events = health.events.filter(event => now - event.at <= HEALTH_WINDOW_MS).slice(-100);
  health.toolEvents = health.toolEvents.filter(event => now - event.at <= HEALTH_WINDOW_MS).slice(-100);
}

function percentile(values: number[], fraction: number): number | undefined {
  if (!values.length) return undefined;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))];
}

function failureFromType(type: RouteFailureType): RouteFailure {
  const retryable = type === 'timeout' || type === 'rate_limited' || type === 'transport' || type === 'server_error' || type === 'empty_response';
  return { type, retryable, switchAllowed: retryable || type === 'balance_exhausted' };
}
