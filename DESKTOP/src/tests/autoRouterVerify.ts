import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AutoRouteCandidate,
  ModelSelection,
  RouteDecision,
  RouteExecutionController,
  RoutePolicy,
  RouteRequest,
  classifyRouteFailure,
  classifyTaskClasses,
  defaultRoutePolicy,
  normalizeAutoPreference,
} from '../core/autoRouter';
import { ConfigManager, stableProviderId } from '../core/config';
import { LocalJevDecisionEngine } from './fixtures/localJevDecisionEngine';
import { evaluateRouteEligibility } from '../core/routeEligibility';
import { resolveAutoRouteDecision, type AutoRoutePipelineInput } from '../core/routeDecisionValidator';

type Check = { ok: boolean; label: string };

function assert(ok: boolean, label: string, checks: Check[]): void {
  checks.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
}

function candidate(
  providerId: string,
  modelId: string,
  options: Partial<AutoRouteCandidate> = {},
): AutoRouteCandidate {
  return {
    deployment: { providerId, modelId },
    enabled: true,
    validation: { level: 'standard', status: 'verified', checkedAt: '2026-07-15T00:00:00.000Z' },
    capabilities: ['text_input', 'text_output'],
    maxContextTokens: 128_000,
    preview: false,
    privacy: ['default'],
    expectedInputCostUsdPerM: 1,
    expectedOutputCostUsdPerM: 4,
    latencyMs: 1_000,
    reliability: 0.95,
    throughput: 40,
    ...options,
  };
}

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    transactionId: 'turn-1',
    taskText: 'Explain this result',
    estimatedInputTokens: 1_000,
    expectedOutputTokens: 1_000,
    requiredCapabilities: ['text_input', 'text_output'],
    ...overrides,
  };
}

function autoSelection(policyId = 'balanced'): ModelSelection {
  return { kind: 'auto', scope: { kind: 'global' }, policyId };
}

async function decide(
  selection: ModelSelection,
  policy: RoutePolicy,
  candidates: AutoRouteCandidate[],
  routeRequest: RouteRequest,
  extra: Partial<AutoRoutePipelineInput> = {},
): Promise<RouteDecision> {
  return resolveAutoRouteDecision({
    selection,
    policy,
    taskText: routeRequest.taskText,
    request: routeRequest,
    candidates,
    taskClasses: classifyTaskClasses(routeRequest.taskText, routeRequest.requiredCapabilities, routeRequest.estimatedInputTokens),
    engine: new LocalJevDecisionEngine(),
    ...extra,
  });
}

export async function verifyAutoRouter(): Promise<Check[]> {
  const checks: Check[] = [];
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const controller = new RouteExecutionController({ now: () => now });

  assert(normalizeAutoPreference('default') === 'balanced'
    && normalizeAutoPreference('conservative') === 'conservative'
    && normalizeAutoPreference('aggressive') === 'aggressive'
    && normalizeAutoPreference('quality') === 'balanced'
    && normalizeAutoPreference('cheap_save') === 'balanced'
    && normalizeAutoPreference('speed') === 'balanced',
  'auto tendency: canonical values survive and retired route objectives normalize to balanced', checks);

  const chineseTaskClasses = classifyTaskClasses('请调试这段代码并证明算法为什么正确', [], 0);
  assert(chineseTaskClasses.includes('coding') && chineseTaskClasses.includes('reasoning'),
    'auto task classifier: Chinese coding and reasoning cues are recognized independently', checks);
  assert(JSON.stringify(classifyTaskClasses('你好，请简单介绍一下自己', ['text_input', 'text_output', 'tool_use'], 0)) === JSON.stringify(['chat']),
    'auto task classifier: executor tool availability does not misclassify ordinary chat as tool use', checks);
  assert(classifyTaskClasses('list files', ['text_input', 'text_output', 'tool_use'], 0).includes('tool_use')
    && classifyTaskClasses('列出工作区文件', ['text_input', 'text_output', 'tool_use'], 0).includes('tool_use'),
  'auto task classifier: explicit workspace actions remain tool-use tasks', checks);

  const stableA = stableProviderId('Example', 'https://one.example/v1', 'openai');
  const stableARepeat = stableProviderId(' example ', 'HTTPS://ONE.EXAMPLE/v1/', 'openai');
  const stableRenamed = stableProviderId('Renamed display', 'https://one.example/v1/', 'openai');
  const stableB = stableProviderId('Example', 'https://two.example/v1', 'openai');
  assert(stableA === stableARepeat && stableA !== stableRenamed && stableA !== stableB,
    'auto identity: legacy providers receive deterministic account-and-endpoint-stable ids', checks);

  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-auto-config-'));
  try {
    fs.writeFileSync(path.join(configRoot, 'config.json'), JSON.stringify({
      models: {
        providers: {
          value: [
            { name: 'One', base_url: 'https://one.example/v1', api_key: 'one', protocol: 'openai', enabled: true, models: [{ name: 'same', evaluation: { status: 'available', checked_at: '2026-07-15T00:00:00.000Z' } }] },
            { name: 'Two', base_url: 'https://two.example/v1', api_key: 'two', protocol: 'anthropic', enabled: true, models: [{ name: 'same', evaluation: { status: 'available', checked_at: '2026-07-15T00:00:00.000Z' } }] },
          ],
        },
      },
    }, null, 2));
    const config = new ConfigManager(configRoot);
    const providers = config.providers();
    const first = config.findDeployment({ providerId: providers[0].id, modelId: 'same' });
    const second = config.findDeployment({ providerId: providers[1].id, modelId: 'same' });
    assert(first?.api_key === 'one' && first.provider_protocol === 'openai'
      && second?.api_key === 'two' && second.provider_protocol === 'anthropic',
    'auto deployment resolution: every attempt re-resolves the correct URL, key and protocol', checks);
    assert(first?.validation?.level === 'legacy_basic' && second?.validation?.level === 'legacy_basic',
      'auto migration: legacy available evaluations do not gain Standard eligibility', checks);
    assert(first?.cost_per_1k_input === undefined
      && first?.cost_per_1k_output === undefined
      && first?.max_tokens === 8192,
    'auto catalog priors: unknown price remains unknown and unknown context uses a conservative limit', checks);
  } finally {
    fs.rmSync(configRoot, { recursive: true, force: true });
  }

  // ---- Guard: hard eligibility only -------------------------------------

  const sameName = [
    candidate('provider-a', 'shared-model'),
    candidate('provider-b', 'shared-model'),
  ];
  const scopedGuard = evaluateRouteEligibility({
    selection: { kind: 'auto', scope: { kind: 'provider', providerId: 'provider-b' }, policyId: 'balanced' },
    policy: defaultRoutePolicy('balanced'),
    request: request(),
    candidates: sameName,
  });
  assert(scopedGuard.eligible.length === 1
    && scopedGuard.eligible[0].deployment.providerId === 'provider-b'
    && scopedGuard.excluded.some(entry => entry.deployment.providerId === 'provider-a' && entry.reasons.includes('outside_scope')),
  'auto guard: provider scope never confuses equal model ids and never exposes the other account', checks);

  const hardFilterCandidates = [
    candidate('p', 'legacy', { validation: { level: 'legacy_basic', status: 'verified', checkedAt: '2026-07-15T00:00:00.000Z' } }),
    candidate('p', 'preview', { preview: true }),
    candidate('p', 'short', { maxContextTokens: 1_500 }),
    candidate('p', 'image-output-only', { capabilities: ['text_input', 'text_output', 'image_output'] }),
    candidate('p', 'vision', { capabilities: ['text_input', 'text_output', 'image_input'] }),
  ];
  const visionGuard = evaluateRouteEligibility({
    selection: autoSelection(),
    policy: defaultRoutePolicy('balanced'),
    request: request({ requiredCapabilities: ['text_input', 'text_output', 'image_input'] }),
    candidates: hardFilterCandidates,
  });
  assert(visionGuard.excluded.length === 2
    && visionGuard.excluded.some(entry => entry.deployment.modelId === 'preview')
    && visionGuard.excluded.some(entry => entry.deployment.modelId === 'short'),
  'auto guard: explicit preview and context limits remain, observational capability flags do not exclude', checks);
  assert(!visionGuard.excluded.some(entry => ['legacy', 'image-output-only', 'vision'].includes(entry.deployment.modelId)),
  'auto guard: untested image input remains eligible for a real response', checks);

  const regionalPolicy: RoutePolicy = {
    ...defaultRoutePolicy('balanced'),
    dataRegion: 'eu-west',
    requiredProtocolParameters: ['strict_json', 'streaming'],
  };
  const regionalGuard = evaluateRouteEligibility({
    selection: autoSelection(),
    policy: regionalPolicy,
    request: request({ transactionId: 'regional' }),
    candidates: [
      candidate('p', 'wrong-region', { dataRegions: ['us-east'], supportedProtocolParameters: ['strict_json', 'streaming'] }),
      candidate('p', 'missing-parameter', { dataRegions: ['eu-west'], supportedProtocolParameters: ['streaming'] }),
      candidate('p', 'regional-compatible', { dataRegions: ['EU-WEST'], supportedProtocolParameters: ['STRICT_JSON', 'STREAMING'] }),
    ],
  });
  assert(regionalGuard.eligible.length === 1
    && regionalGuard.eligible[0].deployment.modelId === 'regional-compatible'
    && regionalGuard.excluded.some(entry => entry.deployment.modelId === 'wrong-region'
      && entry.reasons.includes('data_region:eu-west'))
    && regionalGuard.excluded.some(entry => entry.deployment.modelId === 'missing-parameter'
      && entry.reasons.includes('protocol_parameter:strict_json')),
  'auto guard: data region and required protocol parameters are case-normalized and enforced', checks);

  const constrainedPolicy: RoutePolicy = {
    ...defaultRoutePolicy('balanced'),
    privacy: 'zdr',
    maxExpectedCostUsd: 0.003,
  };
  const constrainedGuard = evaluateRouteEligibility({
    selection: {
      kind: 'auto',
      scope: { kind: 'global' },
      policyId: 'cost',
      subset: [
        { providerId: 'constraints', modelId: 'wrong-privacy' },
        { providerId: 'constraints', modelId: 'over-budget' },
        { providerId: 'constraints', modelId: 'eligible' },
      ],
    },
    policy: constrainedPolicy,
    request: request({ transactionId: 'constraints' }),
    candidates: [
      candidate('constraints', 'outside-subset', { privacy: ['zdr'] }),
      candidate('constraints', 'wrong-privacy', { privacy: ['default'] }),
      candidate('constraints', 'over-budget', { privacy: ['zdr'], expectedInputCostUsdPerM: 10, expectedOutputCostUsdPerM: 10 }),
      candidate('constraints', 'eligible', { privacy: ['default', 'zdr'], expectedInputCostUsdPerM: 1, expectedOutputCostUsdPerM: 1 }),
    ],
  });
  assert(constrainedGuard.eligible.length === 1
    && constrainedGuard.eligible[0].deployment.modelId === 'eligible'
    && constrainedGuard.excluded.some(item => item.deployment.modelId === 'outside-subset' && item.reasons.includes('outside_subset'))
    && constrainedGuard.excluded.some(item => item.deployment.modelId === 'wrong-privacy' && item.reasons.includes('privacy:zdr'))
    && constrainedGuard.excluded.some(item => item.deployment.modelId === 'over-budget' && item.reasons.includes('budget_exceeded')),
  'auto guard: explicit subset, privacy and expected-cost budget are enforced together', checks);

  const unavailableGuard = evaluateRouteEligibility({
    selection: autoSelection(),
    policy: defaultRoutePolicy('balanced'),
    request: request({ transactionId: 'unavailable' }),
    candidates: [candidate('p', 'healthy'), candidate('p', 'balance-blocked', { unavailableReason: 'balance_blocked' })],
  });
  assert(unavailableGuard.eligible.length === 1
    && unavailableGuard.excluded.some(entry => entry.deployment.modelId === 'balance-blocked' && entry.reasons.includes('balance_blocked')),
  'auto guard: an explicitly unavailable deployment is excluded with its own reason instead of a silent disable', checks);

  // ---- JEV decision semantics -------------------------------------------

  const costPool = [
    candidate('p', 'expensive', { expectedInputCostUsdPerM: 20, expectedOutputCostUsdPerM: 60 }),
    candidate('p', 'cheap', { expectedInputCostUsdPerM: 0.1, expectedOutputCostUsdPerM: 0.2 }),
    candidate('p', 'mid', { expectedInputCostUsdPerM: 5, expectedOutputCostUsdPerM: 5 }),
  ];
  const balancedDecision = await decide(autoSelection('balanced'), defaultRoutePolicy('balanced'), costPool, request({ transactionId: 'balanced-turn' }));
  assert(balancedDecision.resolvedDeployment?.modelId === 'cheap'
    && balancedDecision.alternatives.length === 2,
  'auto JEV: the decision engine weighs cost with other candidate evidence and returns ordered alternates', checks);

  const speedPool = [
    candidate('p', 'slow', { latencyMs: 1_000, throughput: 20 }),
    candidate('p', 'fast', { latencyMs: 20, throughput: 400 }),
  ];
  const aggressiveDecision = await decide(autoSelection('aggressive'), defaultRoutePolicy('aggressive'), speedPool, request({ transactionId: 'aggressive-turn' }));
  assert(aggressiveDecision.resolvedDeployment?.modelId === 'fast'
    && aggressiveDecision.alternatives.some(item => item.modelId === 'slow'),
  'auto JEV: aggressive tendency still selects only an eligible deployment using live evidence', checks);

  const tiePool = [
    candidate('p', 'first-in-catalog'),
    candidate('p', 'second-in-catalog'),
  ];
  const tieDecision = await decide(autoSelection('balanced'), defaultRoutePolicy('balanced'), tiePool, request({ transactionId: 'tie-turn' }));
  assert(tieDecision.resolvedDeployment?.modelId === 'first-in-catalog',
    'auto JEV: identical candidates resolve by catalog order, never by history', checks);

  const preferencePool = [
    candidate('p', 'preferred', { preference: 1, expectedInputCostUsdPerM: 50, expectedOutputCostUsdPerM: 50 }),
    candidate('p', 'cheaper', { expectedInputCostUsdPerM: 0.1, expectedOutputCostUsdPerM: 0.1 }),
  ];
  const preferenceDecision = await decide(autoSelection('balanced'), defaultRoutePolicy('balanced'), preferencePool, request({ transactionId: 'preference-turn' }));
  assert(preferenceDecision.resolvedDeployment?.modelId === 'preferred'
    && preferenceDecision.jev.reasonCodes.includes('user_preference_applied'),
  'auto JEV: explicit user route preference is honored and reported in the audit reason codes', checks);

  const openCircuitDecision = await decide(autoSelection('balanced'), defaultRoutePolicy('balanced'), [
    candidate('p', 'circuit-open', { circuit: 'open', expectedInputCostUsdPerM: 0.01, expectedOutputCostUsdPerM: 0.01 }),
    candidate('p', 'circuit-closed', { circuit: 'closed', expectedInputCostUsdPerM: 50, expectedOutputCostUsdPerM: 50 }),
  ], request({ transactionId: 'circuit-turn' }));
  assert(openCircuitDecision.resolvedDeployment?.modelId === 'circuit-closed',
    'auto JEV: an open circuit demotes an endpoint without removing it from the catalog', checks);

  const continuationDecision = await decide(autoSelection('conservative'), defaultRoutePolicy('conservative'), tiePool, request({ transactionId: 'continuation-turn' }), {
    previousDeployment: { providerId: 'p', modelId: 'second-in-catalog' },
  });
  assert(continuationDecision.resolvedDeployment?.modelId === 'second-in-catalog'
    && continuationDecision.jev.reasonCodes.includes('previous_deployment_continuation'),
  'auto JEV: an exact tie continues the previous deployment for context continuity', checks);

  const transactionPool = [candidate('p', 'a'), candidate('p', 'b')];
  const transactionRequest = request({ transactionId: 'build-transaction' });
  const firstTurn = await decide(autoSelection('balanced'), defaultRoutePolicy('balanced'), transactionPool, transactionRequest, {
    pinnedDeployment: { providerId: 'p', modelId: 'b' },
  });
  assert(firstTurn.resolvedDeployment?.modelId === 'b'
    && firstTurn.pinReason === 'transaction'
    && firstTurn.alternatives.some(item => item.modelId === 'a'),
  'auto transaction pin: one Build keeps its first deployment and the JEV primary becomes the first alternate', checks);

  // ---- Operational health (no learning) ---------------------------------

  const interruptedStreak = { providerId: 'p', modelId: 'interrupted-streak' };
  controller.recordEndpointFailure(interruptedStreak, 'transport');
  controller.recordEndpointFailure(interruptedStreak, 'transport');
  controller.recordEndpointFailure(interruptedStreak, 'invalid_request');
  controller.recordEndpointFailure(interruptedStreak, 'transport');
  assert(controller.endpointMetrics(interruptedStreak).circuit === 'closed',
    'auto health: a non-transport failure breaks the consecutive transport streak', checks);

  controller.recordEndpointFailure({ providerId: 'p', modelId: 'broken' }, 'transport');
  controller.recordEndpointFailure({ providerId: 'p', modelId: 'broken' }, 'transport');
  controller.recordEndpointFailure({ providerId: 'p', modelId: 'broken' }, 'transport');
  assert(controller.endpointMetrics({ providerId: 'p', modelId: 'broken' }).circuit === 'open',
    'auto health: three consecutive transport failures open the circuit for diagnostics', checks);
  now += 60_001;
  assert(controller.endpointMetrics({ providerId: 'p', modelId: 'broken' }).circuit === 'half_open',
    'auto health: metrics reads are pure and report the half-open probe window', checks);
  controller.recordEndpointSuccess({ providerId: 'p', modelId: 'broken' }, 800);

  const metricsController = new RouteExecutionController({ now: () => now });
  const measuredDeployment = { providerId: 'metrics-provider', modelId: 'metrics-model' };
  metricsController.recordEndpointSuccess(measuredDeployment, 100, 10);
  metricsController.recordEndpointSuccess(measuredDeployment, 300, 30);
  metricsController.recordEndpointSuccess(measuredDeployment, 200, 20);
  metricsController.recordEndpointFailure(measuredDeployment, 'transport');
  metricsController.recordToolOutcome(measuredDeployment, true);
  metricsController.recordToolOutcome(measuredDeployment, true);
  metricsController.recordToolOutcome(measuredDeployment, false);
  const measured = metricsController.endpointMetrics(measuredDeployment);
  assert(measured.attempts === 4
    && Math.abs(measured.reliability - 0.625) < 1e-9
    && measured.p50 === 200
    && measured.p95 === 300
    && measured.throughput === 20
    && measured.toolAttempts === 3
    && Math.abs(measured.toolValidity - (4 / 7)) < 1e-9,
  'auto health metrics: latency percentiles, median throughput, Beta reliability and tool validity use observed outcomes', checks);

  metricsController.recordEndpointFailure(measuredDeployment, 'auth');
  const authOpen = metricsController.endpointMetrics(measuredDeployment);
  metricsController.resetEndpointAfterConfigChange(measuredDeployment);
  const authReset = metricsController.endpointMetrics(measuredDeployment);
  assert(authOpen.circuit === 'open' && authReset.circuit === 'closed' && authReset.attempts === 0,
    'auto health: a provider configuration change clears an authentication circuit', checks);

  // ---- Provider-local recovery ladder -----------------------------------

  const fallbackPool = [
    candidate('p', 'primary', { deployment: { providerId: 'p', modelId: 'primary', logicalModelGroupId: 'logical-primary' } }),
    candidate('p', 'equivalent', { deployment: { providerId: 'p', modelId: 'equivalent', logicalModelGroupId: 'logical-primary' } }),
    candidate('p', 'fallback', { fallbackOnly: true }),
    candidate('other', 'forbidden', { fallbackOnly: true }),
  ];
  const fallbackDecision = await decide(
    { kind: 'auto', scope: { kind: 'provider', providerId: 'p' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), fallbackPool, request({ transactionId: 'fallback' }),
  );
  const ladder = controller.planAttempts(fallbackDecision, fallbackPool, {
    error: classifyRouteFailure('HTTP 503 upstream unavailable'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(ladder.length === 2
    && ladder[0].kind === 'retry_same_deployment'
    && ladder[1].deployment.modelId === 'equivalent'
    && ladder.every(attempt => attempt.deployment.providerId === 'p'),
  'auto fallback: failed initial call plus retry and explicit equivalent stay within three total attempts', checks);
  const fallbackDisabledLadder = controller.planAttempts(fallbackDecision, fallbackPool, {
    error: classifyRouteFailure('HTTP 503 upstream unavailable'),
    streamCommitted: false,
    sideEffectCommitted: false,
    allowModelFallback: false,
  });
  assert(fallbackDisabledLadder.length === 1
    && fallbackDisabledLadder[0].kind === 'retry_same_deployment'
    && fallbackDisabledLadder[0].deployment.modelId === fallbackDecision.resolvedDeployment?.modelId,
  'auto fallback off: only a same-deployment retry is planned and no other model identity is eligible', checks);
  const fallbackDisabledNonRetryable = controller.planAttempts(fallbackDecision, fallbackPool, {
    error: classifyRouteFailure('HTTP 402 insufficient_quota'),
    streamCommitted: false,
    sideEffectCommitted: false,
    allowModelFallback: false,
  });
  assert(fallbackDisabledNonRetryable.length === 0,
    'auto fallback off: a non-retryable failure cannot schedule an equivalent, fallback, or alternate model', checks);

  const globalFallbackPool = [
    ...fallbackPool,
    candidate('other', 'same-model-name', { fallbackOnly: true }),
    candidate('other', 'ordinary-backup'),
  ];
  const globalFallbackDecision = await decide(autoSelection(), defaultRoutePolicy('balanced'), globalFallbackPool, request({ transactionId: 'global-provider-boundary' }));
  const globalFallbackLadder = controller.planAttempts(globalFallbackDecision, globalFallbackPool, {
    error: classifyRouteFailure('HTTP 503 upstream unavailable'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(globalFallbackLadder.every(attempt => attempt.deployment.providerId === 'p'),
    'auto fallback: global Auto still keeps every retry and fallback on the failed provider', checks);
  const fallbackOnlyLadder = controller.planAttempts(fallbackDecision, fallbackPool.filter(item => item.deployment.modelId !== 'equivalent'), {
    error: classifyRouteFailure('HTTP 503 upstream unavailable'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(fallbackOnlyLadder.length === 2
    && fallbackOnlyLadder[1].deployment.modelId === 'fallback'
    && fallbackOnlyLadder.every(attempt => attempt.deployment.providerId === 'p'),
  'auto fallback: fallback-only models are used only inside the original scope', checks);

  const previewFallback = candidate('p', 'unsafe-preview-fallback', { fallbackOnly: true, preview: true });
  const previewFallbackPool = [fallbackPool[0], previewFallback];
  const previewFallbackDecision = await decide(
    { kind: 'auto', scope: { kind: 'provider', providerId: 'p' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), previewFallbackPool, request({ transactionId: 'unsafe-preview-fallback' }),
  );
  const previewFallbackLadder = controller.planAttempts(previewFallbackDecision, previewFallbackPool, {
    error: classifyRouteFailure('HTTP 503 upstream unavailable'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(previewFallbackLadder.length === 1 && previewFallbackLadder[0].kind === 'retry_same_deployment',
    'auto fallback: fallback-only candidates cannot bypass preview or other initial hard filters', checks);

  const overBudget429 = controller.planAttempts(fallbackDecision, fallbackPool, {
    error: classifyRouteFailure('HTTP 429 Retry-After: 10s'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(overBudget429.length === 2
    && overBudget429.every(attempt => attempt.kind !== 'retry_same_deployment')
    && overBudget429[0].kind === 'equivalent_deployment'
    && overBudget429[1].kind === 'fallback_model',
  'auto retry budget: Retry-After is honored and an over-5s interactive wait is not performed', checks);

  const ordinaryBackupPool = [
    candidate('p', 'quota-primary', { reliability: 1, throughput: 100, latencyMs: 100 }),
    candidate('p', 'ordinary-backup', { reliability: 0.8, throughput: 10, latencyMs: 2_000 }),
  ];
  const ordinaryBackupDecision = await decide(
    { kind: 'auto', scope: { kind: 'provider', providerId: 'p' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), ordinaryBackupPool, request({ transactionId: 'quota-alternate' }),
  );
  const quotaFailure = classifyRouteFailure('HTTP 429 insufficient_quota: account credits exhausted');
  const quotaLadder = controller.planAttempts(ordinaryBackupDecision, ordinaryBackupPool, {
    error: quotaFailure,
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(quotaFailure.type === 'balance_exhausted'
    && quotaFailure.retryable === false
    && quotaFailure.switchAllowed === true
    && quotaLadder.length === 1
    && quotaLadder[0].kind === 'alternate_model'
    && quotaLadder[0].deployment.modelId === 'ordinary-backup',
  'auto balance recovery: exhausted quota skips same-deployment retry and switches to a JEV alternate', checks);

  const batchDecision = await decide(
    { kind: 'auto', scope: { kind: 'provider', providerId: 'p' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), fallbackPool, request({ transactionId: 'fallback-batch', batch: true }),
  );
  const batch429 = controller.planAttempts(batchDecision, fallbackPool, {
    error: classifyRouteFailure('HTTP 429 Retry-After: 10s'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(fallbackDecision.retryBudgetMs === 5_000
    && batchDecision.retryBudgetMs === 15_000
    && batch429[0]?.kind === 'retry_same_deployment'
    && batch429[0]?.retryDelayMs === 10_000,
  'auto retry budget: interactive requests cap waits at 5s while batch requests admit Retry-After up to 15s', checks);
  const refused = [
    controller.planAttempts(fallbackDecision, fallbackPool, { error: classifyRouteFailure('content policy refusal'), streamCommitted: false, sideEffectCommitted: false }),
    controller.planAttempts(fallbackDecision, fallbackPool, { error: classifyRouteFailure('HTTP 503'), streamCommitted: true, sideEffectCommitted: false }),
    controller.planAttempts(fallbackDecision, fallbackPool, { error: classifyRouteFailure('HTTP 503'), streamCommitted: false, sideEffectCommitted: true }),
  ];
  assert(refused.every(plan => plan.length === 0),
    'auto fallback: moderation, committed streams and side effects cannot switch or replay', checks);

  // ---- Audit + determinism ----------------------------------------------

  const auditDecision = await decide(autoSelection(), defaultRoutePolicy('balanced'), costPool, request({ transactionId: 'audit-turn' }));
  const alternateCandidates = costPool.map(item => item.deployment.modelId === 'mid'
    ? { ...item, expectedInputCostUsdPerM: Number(item.expectedInputCostUsdPerM) + 1 }
    : item);
  const changedCatalog = await decide(autoSelection(), defaultRoutePolicy('balanced'), alternateCandidates, request({ transactionId: 'catalog-change' }));
  assert(changedCatalog.catalogSnapshotHash !== auditDecision.catalogSnapshotHash,
    'auto audit: catalog snapshot hash changes when a routing input changes', checks);
  assert(!JSON.stringify(auditDecision).includes('Explain this result'),
    'auto audit: RouteDecision does not retain prompt text', checks);
  assert(auditDecision.decisionSource === 'jev'
    && auditDecision.jev.modelVersion.length > 0
    && auditDecision.jev.reasonCodes.length > 0
    && typeof auditDecision.jev.latencyMs === 'number'
    && !('rankedCandidates' in (auditDecision as unknown as Record<string, unknown>)),
  'auto audit: decision source, JEV model version, reason codes and latency are recorded without legacy ranking', checks);

  // ---- Legacy learning has no API left ----------------------------------

  const controllerSurface = controller as unknown as Record<string, unknown>;
  assert(typeof controllerSurface.recordFeedback === 'undefined'
    && typeof controllerSurface.learnedPreference === 'undefined'
    && typeof controllerSurface.clearLearnedPreferences === 'undefined',
  'auto router v2: the feedback, EWMA preference and learned-preference APIs are gone', checks);
  const cwd = process.cwd();
  const routerSource = fs.readFileSync(path.join(cwd, 'src', 'core', 'autoRouter.ts'), 'utf-8');
  const agentSource = fs.readFileSync(path.join(cwd, 'src', 'core', 'agent.ts'), 'utf-8');
  const runnerSource = fs.readFileSync(path.join(cwd, 'src', 'core', 'agentKernelRunner.ts'), 'utf-8');
  const forbidden = [
    'learnedPreference',
    'FEEDBACK_WINDOW_MS',
    'FEEDBACK_HALF_LIFE_MS',
    'recordFeedback(',
    'loadLearnedRouteFeedback',
    'recordRouteQualityObservation',
    'recordObjectiveRouteResult',
    'objective_success',
    'cache_affinity',
    'switchThreshold',
  ];
  assert(forbidden.every(token => !routerSource.includes(token) && !agentSource.includes(token) && !runnerSource.includes(token)),
    'auto router v2: no online preference learning, quality observation or cache affinity remains on the routing path', checks);
  assert(!agentSource.includes("updateModelByDeployment(deployment.providerId, deployment.modelId, { quality_by_task"),
    'auto router v2: quality_by_task is never written by runtime feedback', checks);

  return checks;
}

if (require.main === module) {
  verifyAutoRouter().then(checks => {
    const failed = checks.filter(check => !check.ok);
    console.log(`\nAuto Router verification: ${checks.length - failed.length}/${checks.length} passed`);
    if (failed.length) process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
