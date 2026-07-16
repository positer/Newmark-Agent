import { createHash, randomUUID } from 'crypto';

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

export type RouteMode = 'quality' | 'balanced' | 'cost' | 'speed';
export type RoutePrivacy = 'default' | 'no_training' | 'zdr';
export type TaskClass = 'chat' | 'coding' | 'reasoning' | 'long_context' | 'vision' | 'image_generation' | 'tool_use' | 'computer_use';
export type ValidationLevel = 'discovered' | 'legacy_basic' | 'basic' | 'standard' | 'extended';
export type ValidationStatus = 'verified' | 'degraded' | 'unavailable' | 'auth_error' | 'rate_limited' | 'invalid_config';

export interface RoutePolicy {
  mode: RouteMode;
  maxQualityLoss: number;
  maxExpectedCostUsd?: number;
  allowPreview: boolean;
  privacy: RoutePrivacy;
  requiredCapabilities: string[];
  dataRegion?: string;
  requiredProtocolParameters?: string[];
}

export interface AutoRouteCandidate {
  deployment: DeploymentRef;
  enabled: boolean;
  validation: { level: ValidationLevel; status: ValidationStatus; checkedAt: string };
  capabilities: string[];
  maxContextTokens: number;
  preview: boolean;
  privacy: RoutePrivacy[];
  dataRegions?: string[];
  supportedProtocolParameters?: string[];
  expectedInputCostUsdPerM?: number;
  expectedOutputCostUsdPerM?: number;
  latencyMs?: number;
  reliability?: number;
  toolValidity?: number;
  throughput?: number;
  qualityByTask?: Partial<Record<TaskClass, { successes: number; attempts: number }>>;
  preference?: number;
  fallbackOnly?: boolean;
}

export interface RouteRequest {
  transactionId: string;
  affinityKey: string;
  taskText: string;
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  requiredCapabilities: string[];
  batch?: boolean;
}

export interface RankedRouteCandidate {
  deployment: DeploymentRef;
  quality: number;
  utility: number;
  expectedCostUsd?: number;
  components: {
    cost: number;
    reliability: number;
    speed: number;
    cache: number;
    preference: number;
  };
}

export type RouteAttemptStatus = 'planned' | 'success' | 'failed' | 'blocked';
export interface RouteAttempt {
  deployment: DeploymentRef;
  kind: 'initial' | 'retry_same_deployment' | 'equivalent_deployment' | 'fallback_model';
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
  catalogSnapshotHash: string;
  taskClasses: TaskClass[];
  excludedCandidates: Array<{ deployment: DeploymentRef; reasons: string[] }>;
  rankedCandidates: RankedRouteCandidate[];
  resolvedDeployment?: DeploymentRef;
  pinReason?: 'transaction' | 'cache_affinity';
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

export interface RouteFeedbackEvent {
  deployment: DeploymentRef;
  taskClass: TaskClass;
  score: number;
  source: 'manual_switch' | 'explicit_rating' | 'objective_success';
  at?: number;
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

interface AffinityEntry {
  deployment: DeploymentRef;
  expiresAt: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const VALIDATION_TTL_MS = 7 * DAY_MS;
const AFFINITY_TTL_MS = 5 * 60_000;
const HEALTH_WINDOW_MS = 30 * 60_000;
const CIRCUIT_COOLDOWN_MS = 60_000;
const FEEDBACK_WINDOW_MS = 30 * DAY_MS;
const FEEDBACK_HALF_LIFE_MS = 30 * DAY_MS;

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

function sameDeployment(left: DeploymentRef, right: DeploymentRef): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function inSubset(deployment: DeploymentRef, subset: DeploymentRef[] | undefined): boolean {
  if (!subset?.length) return true;
  return subset.some(item => sameDeployment(item, deployment));
}

function inScope(deployment: DeploymentRef, scope: AutoScope): boolean {
  return scope.kind === 'global' || deployment.providerId === scope.providerId;
}

function validationEligible(candidate: AutoRouteCandidate, now: number): string[] {
  const reasons: string[] = [];
  if (candidate.validation.level !== 'standard' && candidate.validation.level !== 'extended') {
    reasons.push(`validation_level:${candidate.validation.level}`);
  }
  if (candidate.validation.status !== 'verified' && candidate.validation.status !== 'degraded') {
    reasons.push(`validation_status:${candidate.validation.status}`);
  }
  const checkedAt = Date.parse(candidate.validation.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > VALIDATION_TTL_MS) reasons.push('validation_expired');
  return reasons;
}

export function normalizeAutoPreference(value: string): RouteMode {
  switch (String(value || '').toLowerCase()) {
    case 'performance':
    case 'quality': return 'quality';
    case 'cheap_save':
    case 'cost': return 'cost';
    case 'speed': return 'speed';
    default: return 'balanced';
  }
}

export function defaultRoutePolicy(mode: RouteMode = 'balanced'): RoutePolicy {
  const maxQualityLoss = mode === 'quality' ? 0 : mode === 'balanced' ? 0.02 : mode === 'cost' ? 0.06 : 0.04;
  return {
    mode,
    maxQualityLoss,
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
  if (statusCode === 429 || /rate limit|too many requests/i.test(text)) {
    return { type: 'rate_limited', retryable: true, switchAllowed: true, statusCode: 429, retryAfterMs };
  }
  if (statusCode === 408 || /timeout|timed out|aborterror/i.test(text)) {
    return { type: 'timeout', retryable: true, switchAllowed: true, statusCode };
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return { type: 'server_error', retryable: true, switchAllowed: true, statusCode };
  }
  if (/empty response|no response body|empty completion/i.test(text)) return { type: 'empty_response', retryable: true, switchAllowed: true };
  if (/network|econn|enotfound|socket|fetch failed|connection reset|transport/i.test(text)) {
    return { type: 'transport', retryable: true, switchAllowed: true };
  }
  return { type: 'execution_error', retryable: false, switchAllowed: false, statusCode };
}

export class AutoRouter {
  private readonly now: () => number;
  private readonly policyVersion: string;
  private readonly affinityTtlMs: number;
  private readonly switchThreshold: number;
  private readonly transactionPins = new Map<string, DeploymentRef>();
  private readonly affinities = new Map<string, AffinityEntry>();
  private readonly endpointHealth = new Map<string, EndpointHealth>();
  private readonly feedback = new Map<string, RouteFeedbackEvent[]>();

  constructor(options: { now?: () => number; policyVersion?: string; affinityTtlMs?: number; switchThreshold?: number } = {}) {
    this.now = options.now || Date.now;
    this.policyVersion = options.policyVersion || 'newmark-auto-v1';
    this.affinityTtlMs = Math.max(0, options.affinityTtlMs ?? AFFINITY_TTL_MS);
    this.switchThreshold = Math.max(0, options.switchThreshold ?? 0.15);
  }

  route(selection: ModelSelection, policy: RoutePolicy, candidates: AutoRouteCandidate[], request: RouteRequest): RouteDecision {
    const now = this.now();
    const taskClasses = classifyTaskClasses(request.taskText, [...policy.requiredCapabilities, ...request.requiredCapabilities], request.estimatedInputTokens);
    const decision: RouteDecision = {
      routeId: randomUUID(),
      requestedSelection: cloneSelection(selection),
      policyVersion: this.policyVersion,
      catalogSnapshotHash: catalogHash(candidates),
      taskClasses,
      excludedCandidates: [],
      rankedCandidates: [],
      attempts: [],
      finalStatus: 'no_candidate',
      retryBudgetMs: request.batch ? 15_000 : 5_000,
    };

    if (selection.kind === 'fixed') {
      const fixed = candidates.find(item => sameDeployment(item.deployment, selection.deployment));
      if (!fixed || fixed.enabled === false) {
        decision.finalStatus = 'fixed_unavailable';
        return decision;
      }
      const ranked = this.rankCandidate(fixed, taskClasses, policy, request, false, now);
      decision.rankedCandidates = [ranked];
      decision.resolvedDeployment = { ...fixed.deployment };
      decision.attempts = [{ deployment: { ...fixed.deployment }, kind: 'initial', status: 'planned' }];
      decision.finalStatus = 'resolved';
      this.claimEndpointAttempt(fixed.deployment);
      return decision;
    }

    const requiredCapabilities = new Set([...policy.requiredCapabilities, ...request.requiredCapabilities].map(item => String(item).toLowerCase()));
    const eligible: AutoRouteCandidate[] = [];
    for (const candidate of candidates) {
      const reasons: string[] = [];
      if (!candidate.enabled) reasons.push('disabled');
      if (!inScope(candidate.deployment, selection.scope)) reasons.push('outside_scope');
      if (!inSubset(candidate.deployment, selection.subset)) reasons.push('outside_subset');
      if (candidate.fallbackOnly) reasons.push('fallback_only');
      if (candidate.preview && !policy.allowPreview) reasons.push('preview_disallowed');
      reasons.push(...validationEligible(candidate, now));
      if (request.estimatedInputTokens + request.expectedOutputTokens > Math.max(0, candidate.maxContextTokens || 0)) reasons.push('context_too_small');
      const capabilities = new Set(candidate.capabilities.map(item => String(item).toLowerCase()));
      for (const capability of requiredCapabilities) if (!capabilities.has(capability)) reasons.push(`missing_capability:${capability}`);
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
      if (this.circuitState(candidate.deployment, now, false) === 'open') reasons.push('circuit_open');
      if (reasons.length) decision.excludedCandidates.push({ deployment: { ...candidate.deployment }, reasons: [...new Set(reasons)] });
      else eligible.push(candidate);
    }
    if (!eligible.length) return decision;

    const affinityKey = this.affinityKey(request.affinityKey, selection.scope, policy.mode);
    let affinity = this.affinities.get(affinityKey);
    if (affinity && affinity.expiresAt <= now) {
      this.affinities.delete(affinityKey);
      affinity = undefined;
    }
    const affinityDeployment = affinity?.deployment;
    const transactionPin = this.transactionPins.get(request.transactionId);
    if (transactionPin) {
      const pinned = eligible.find(item => sameDeployment(item.deployment, transactionPin));
      if (pinned) {
        decision.rankedCandidates = this.rankEligible(eligible, taskClasses, policy, request, now, affinityDeployment);
        decision.resolvedDeployment = { ...pinned.deployment };
        decision.pinReason = 'transaction';
        decision.attempts = [{ deployment: { ...pinned.deployment }, kind: 'initial', status: 'planned' }];
        decision.finalStatus = 'resolved';
        this.claimEndpointAttempt(pinned.deployment);
        return decision;
      }
      this.transactionPins.delete(request.transactionId);
    }

    const ranked = this.rankEligible(eligible, taskClasses, policy, request, now, affinityDeployment);
    decision.rankedCandidates = ranked;
    let selected = ranked[0];
    if (affinity) {
      const incumbent = ranked.find(item => sameDeployment(item.deployment, affinity.deployment));
      if (incumbent && selected.utility - incumbent.utility < this.switchThreshold) {
        selected = incumbent;
        decision.pinReason = 'cache_affinity';
      }
    }
    decision.resolvedDeployment = { ...selected.deployment };
    decision.attempts = [{ deployment: { ...selected.deployment }, kind: 'initial', status: 'planned' }];
    decision.finalStatus = 'resolved';
    this.claimEndpointAttempt(selected.deployment);
    this.transactionPins.set(request.transactionId, { ...selected.deployment });
    this.affinities.set(affinityKey, { deployment: { ...selected.deployment }, expiresAt: now + this.affinityTtlMs });
    return decision;
  }

  endTransaction(transactionId: string): void {
    this.transactionPins.delete(transactionId);
  }

  planAttempts(
    decision: RouteDecision,
    candidates: AutoRouteCandidate[],
    failure: { error: RouteFailure; streamCommitted: boolean; sideEffectCommitted: boolean },
  ): PlannedRouteAttempt[] {
    const current = decision.resolvedDeployment;
    if (!current || !failure.error.retryable || !failure.error.switchAllowed || failure.streamCommitted || failure.sideEffectCommitted) return [];
    const remainingAttempts = Math.max(0, 3 - decision.attempts.length);
    if (!remainingAttempts) return [];
    const attempts: PlannedRouteAttempt[] = [];
    const retryDelayMs = failure.error.retryAfterMs ?? 250;
    const alreadyRetriedCurrent = decision.attempts.some(attempt => attempt.kind === 'retry_same_deployment'
      && sameDeployment(attempt.deployment, current));
    if (!alreadyRetriedCurrent && retryDelayMs <= (decision.retryBudgetMs ?? 5_000)) {
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
    const selection = decision.requestedSelection;
    if (selection.kind === 'fixed') return attempts.slice(0, remainingAttempts);
    const scope = selection.kind === 'auto' ? selection.scope : { kind: 'provider' as const, providerId: current.providerId };
    const subset = selection.kind === 'auto' ? selection.subset : undefined;
    const currentGroup = current.logicalModelGroupId;
    const now = this.now();
    const attemptedDeployments = decision.attempts.map(attempt => attempt.deployment);
    const eligible = candidates.filter(candidate => candidate.enabled
      && inScope(candidate.deployment, scope)
      && inSubset(candidate.deployment, subset)
      && !sameDeployment(candidate.deployment, current)
      && !attemptedDeployments.some(attempted => sameDeployment(candidate.deployment, attempted))
      && validationEligible(candidate, now).length === 0
      && this.passedInitialHardFilters(decision, candidate)
      && this.circuitState(candidate.deployment, now, false) !== 'open');
    const equivalent = currentGroup
      ? eligible.find(candidate => candidate.deployment.logicalModelGroupId === currentGroup && !candidate.fallbackOnly)
      : undefined;
    const fallback = eligible.find(candidate => candidate.fallbackOnly);
    for (const next of [equivalent, fallback]) {
      if (!next || attempts.length >= 2) continue;
      attempts.push({
        deployment: { ...next.deployment },
        kind: next === equivalent ? 'equivalent_deployment' : 'fallback_model',
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

  recordFeedback(event: RouteFeedbackEvent): boolean {
    const at = event.at ?? this.now();
    const safe: RouteFeedbackEvent = {
      deployment: { ...event.deployment },
      taskClass: event.taskClass,
      score: clamp(Number(event.score) || 0, -1, 1),
      source: event.source,
      at,
    };
    const key = feedbackKey(safe.deployment, safe.taskClass);
    const events = (this.feedback.get(key) || []).filter(item => at - Number(item.at || 0) <= FEEDBACK_WINDOW_MS);
    events.push(safe);
    this.feedback.set(key, events);
    return events.length >= 3;
  }

  clearLearnedPreferences(): void {
    this.feedback.clear();
  }

  learnedPreference(deployment: DeploymentRef, taskClasses: TaskClass[]): number {
    const now = this.now();
    const values: number[] = [];
    for (const taskClass of taskClasses) {
      const events = (this.feedback.get(feedbackKey(deployment, taskClass)) || [])
        .filter(event => now - Number(event.at || 0) <= FEEDBACK_WINDOW_MS)
        .sort((left, right) => Number(left.at || 0) - Number(right.at || 0));
      if (events.length < 3) continue;
      let ewma = events[0].score;
      let previousAt = Number(events[0].at || now);
      for (const event of events.slice(1)) {
        const eventAt = Number(event.at || previousAt);
        const betweenDecay = Math.pow(0.5, Math.max(0, eventAt - previousAt) / FEEDBACK_HALF_LIFE_MS);
        ewma = 0.2 * event.score + 0.8 * ewma * betweenDecay;
        previousAt = eventAt;
      }
      const newestAt = Number(events[events.length - 1].at || now);
      const decay = Math.pow(0.5, Math.max(0, now - newestAt) / FEEDBACK_HALF_LIFE_MS);
      values.push(clamp(ewma * decay, -1, 1));
    }
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  private rankEligible(candidates: AutoRouteCandidate[], taskClasses: TaskClass[], policy: RoutePolicy, request: RouteRequest, now: number, affinityDeployment?: DeploymentRef): RankedRouteCandidate[] {
    const qualities = candidates.map(candidate => ({ candidate, quality: qualityScore(candidate, taskClasses) }));
    const bestQuality = Math.max(...qualities.map(item => item.quality));
    const band = qualities.filter(item => bestQuality - item.quality <= policy.maxQualityLoss + Number.EPSILON);
    return band.map(item => this.rankCandidate(item.candidate, taskClasses, policy, request, !!affinityDeployment && sameDeployment(item.candidate.deployment, affinityDeployment), now, item.quality))
      .sort((left, right) => right.utility - left.utility || right.quality - left.quality || deploymentKey(left.deployment).localeCompare(deploymentKey(right.deployment)));
  }

  private rankCandidate(candidate: AutoRouteCandidate, taskClasses: TaskClass[], policy: RoutePolicy, request: RouteRequest, cache: boolean, _now: number, quality = qualityScore(candidate, taskClasses)): RankedRouteCandidate {
    const expectedCostUsd = expectedRequestCost(candidate, request);
    const cost = expectedCostUsd === undefined ? 0 : 1 / (1 + Math.max(0, expectedCostUsd) * 1_000);
    const endpointReliability = candidate.reliability === undefined ? 0.5 : clamp(candidate.reliability);
    const toolRelevant = taskClasses.some(taskClass => taskClass === 'tool_use' || taskClass === 'computer_use');
    const reliability = toolRelevant && candidate.toolValidity !== undefined
      ? (endpointReliability + clamp(candidate.toolValidity)) / 2
      : endpointReliability;
    const latency = candidate.latencyMs === undefined ? 0.5 : 1 / (1 + Math.max(0, candidate.latencyMs) / 1_000);
    const throughput = candidate.throughput === undefined ? 0.5 : Math.max(0, candidate.throughput) / (Math.max(0, candidate.throughput) + 40);
    const speed = (latency + throughput) / 2;
    const learned = this.learnedPreference(candidate.deployment, taskClasses);
    const configuredPreference = clamp(Number(candidate.preference) || 0, -1, 1);
    const effectivePreference = configuredPreference === 0 ? learned : configuredPreference;
    const preference = clamp((effectivePreference + 1) / 2);
    const components = { cost, reliability, speed, cache: cache ? 1 : 0, preference };
    let utility: number;
    switch (policy.mode) {
      case 'quality': utility = quality * 0.55 + reliability * 0.25 + speed * 0.15 + cost * 0.05; break;
      case 'cost': utility = cost * 0.65 + reliability * 0.15 + speed * 0.10 + components.cache * 0.05 + preference * 0.05; break;
      case 'speed': utility = speed * 0.60 + reliability * 0.20 + cost * 0.10 + components.cache * 0.05 + preference * 0.05; break;
      default: utility = cost * 0.40 + reliability * 0.25 + speed * 0.20 + components.cache * 0.10 + preference * 0.05; break;
    }
    return {
      deployment: { ...candidate.deployment },
      quality,
      utility: clamp(utility),
      expectedCostUsd,
      components,
    };
  }

  private affinityKey(key: string, scope: AutoScope, mode: RouteMode): string {
    return `${key}\u0000${scope.kind === 'global' ? 'global' : `provider:${scope.providerId}`}\u0000${mode}`;
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
    const exclusion = decision.excludedCandidates.find(entry => sameDeployment(entry.deployment, candidate.deployment));
    if (!exclusion) return true;
    return !!candidate.fallbackOnly
      && exclusion.reasons.length > 0
      && exclusion.reasons.every(reason => reason === 'fallback_only');
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

function cloneSelection(selection: ModelSelection): ModelSelection {
  if (selection.kind === 'fixed') return { kind: 'fixed', deployment: { ...selection.deployment } };
  return {
    kind: 'auto',
    scope: selection.scope.kind === 'global' ? { kind: 'global' } : { kind: 'provider', providerId: selection.scope.providerId },
    policyId: selection.policyId,
    subset: selection.subset?.map(item => ({ ...item })),
  };
}

function qualityScore(candidate: AutoRouteCandidate, taskClasses: TaskClass[]): number {
  const scores = taskClasses.map(taskClass => {
    const metric = candidate.qualityByTask?.[taskClass];
    if (!metric) return 0.5;
    const attempts = Math.max(0, Math.floor(Number(metric.attempts) || 0));
    const successes = clamp(Number(metric.successes) || 0, 0, attempts);
    return (successes + 2) / (attempts + 4);
  });
  return scores.reduce((sum, value) => sum + value, 0) / Math.max(1, scores.length);
}

function expectedRequestCost(candidate: AutoRouteCandidate, request: RouteRequest): number | undefined {
  const input = finite(candidate.expectedInputCostUsdPerM);
  const output = finite(candidate.expectedOutputCostUsdPerM);
  if (input === undefined || output === undefined) return undefined;
  return input * Math.max(0, request.estimatedInputTokens) / 1_000_000
    + output * Math.max(0, request.expectedOutputTokens) / 1_000_000;
}

function catalogHash(candidates: AutoRouteCandidate[]): string {
  const snapshot = candidates.map(candidate => ({
    deployment: candidate.deployment,
    enabled: candidate.enabled,
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
    qualityByTask: candidate.qualityByTask,
    preference: candidate.preference,
    fallbackOnly: !!candidate.fallbackOnly,
  })).sort((left, right) => deploymentKey(left.deployment).localeCompare(deploymentKey(right.deployment)));
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function feedbackKey(deployment: DeploymentRef, taskClass: TaskClass): string {
  return `${deploymentKey(deployment)}\u0000${taskClass}`;
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
  return { type, retryable, switchAllowed: retryable };
}
