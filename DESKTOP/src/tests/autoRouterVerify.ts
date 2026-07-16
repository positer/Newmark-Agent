import {
  AutoRouter,
  AutoRouteCandidate,
  RoutePolicy,
  classifyTaskClasses,
  classifyRouteFailure,
  defaultRoutePolicy,
  normalizeAutoPreference,
} from '../core/autoRouter';
import { ConfigManager, stableProviderId } from '../core/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    qualityByTask: { chat: { successes: 8, attempts: 10 } },
    ...options,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: 'turn-1',
    affinityKey: 'conversation-1',
    taskText: 'Explain this result',
    estimatedInputTokens: 1_000,
    expectedOutputTokens: 1_000,
    requiredCapabilities: ['text_input', 'text_output'],
    ...overrides,
  };
}

export function verifyAutoRouter(): Check[] {
  const checks: Check[] = [];
  let now = Date.parse('2026-07-15T00:00:00.000Z');
  const router = new AutoRouter({ now: () => now });

  assert(normalizeAutoPreference('default') === 'balanced'
    && normalizeAutoPreference('performance') === 'quality'
    && normalizeAutoPreference('cheap_save') === 'cost'
    && normalizeAutoPreference('speed') === 'speed',
  'auto migration: legacy preferences map to the four policies', checks);

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

  const sameName = [
    candidate('provider-a', 'shared-model', { qualityByTask: { chat: { successes: 20, attempts: 20 } } }),
    candidate('provider-b', 'shared-model', { qualityByTask: { chat: { successes: 1, attempts: 20 } } }),
  ];
  const providerDecision = router.route(
    { kind: 'auto', scope: { kind: 'provider', providerId: 'provider-b' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), sameName, request(),
  );
  assert(providerDecision.resolvedDeployment?.providerId === 'provider-b'
    && providerDecision.resolvedDeployment.modelId === 'shared-model',
  'auto identity: provider scope never confuses equal model ids', checks);

  const hardFilterCandidates = [
    candidate('p', 'legacy', { validation: { level: 'legacy_basic', status: 'verified', checkedAt: '2026-07-15T00:00:00.000Z' } }),
    candidate('p', 'preview', { preview: true }),
    candidate('p', 'short', { maxContextTokens: 1_500 }),
    candidate('p', 'image-output-only', { capabilities: ['text_input', 'text_output', 'image_output'] }),
    candidate('p', 'vision', { capabilities: ['text_input', 'text_output', 'image_input'] }),
  ];
  const visionDecision = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), hardFilterCandidates,
    request({ requiredCapabilities: ['text_input', 'text_output', 'image_input'] }),
  );
  assert(visionDecision.resolvedDeployment?.modelId === 'vision'
    && visionDecision.excludedCandidates.length === 4,
  'auto hard filters: standard validation, preview, context and image-input are enforced', checks);
  assert(visionDecision.excludedCandidates.some(entry => entry.deployment.modelId === 'image-output-only'
    && entry.reasons.includes('missing_capability:image_input')),
  'auto capability: image output never satisfies image input', checks);

  const regionalPolicy: RoutePolicy = {
    ...defaultRoutePolicy('balanced'),
    dataRegion: 'eu-west',
    requiredProtocolParameters: ['strict_json', 'streaming'],
  };
  const regionalDecision = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
    regionalPolicy,
    [
      candidate('p', 'wrong-region', { dataRegions: ['us-east'], supportedProtocolParameters: ['strict_json', 'streaming'] }),
      candidate('p', 'missing-parameter', { dataRegions: ['eu-west'], supportedProtocolParameters: ['streaming'] }),
      candidate('p', 'regional-compatible', { dataRegions: ['EU-WEST'], supportedProtocolParameters: ['STRICT_JSON', 'STREAMING'] }),
    ],
    request({ transactionId: 'regional', affinityKey: 'regional' }),
  );
  assert(regionalDecision.resolvedDeployment?.modelId === 'regional-compatible'
    && regionalDecision.excludedCandidates.some(entry => entry.deployment.modelId === 'wrong-region'
      && entry.reasons.includes('data_region:eu-west'))
    && regionalDecision.excludedCandidates.some(entry => entry.deployment.modelId === 'missing-parameter'
      && entry.reasons.includes('protocol_parameter:strict_json')),
  'auto hard filters: data region and required protocol parameters are case-normalized and enforced', checks);

  const qualityPool = [
    candidate('p', 'best', {
      expectedInputCostUsdPerM: 20,
      expectedOutputCostUsdPerM: 60,
      qualityByTask: { chat: { successes: 98, attempts: 100 } },
    }),
    candidate('p', 'near', {
      expectedInputCostUsdPerM: 0.1,
      expectedOutputCostUsdPerM: 0.2,
      qualityByTask: { chat: { successes: 96, attempts: 100 } },
    }),
    candidate('p', 'cheap-low', {
      expectedInputCostUsdPerM: 0.01,
      expectedOutputCostUsdPerM: 0.02,
      qualityByTask: { chat: { successes: 85, attempts: 100 } },
    }),
  ];
  const quality = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'quality' },
    defaultRoutePolicy('quality'), qualityPool, request({ transactionId: 'quality-turn', affinityKey: 'quality' }),
  );
  const balanced = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), qualityPool, request({ transactionId: 'balanced-turn', affinityKey: 'balanced' }),
  );
  const cost = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'cost' },
    defaultRoutePolicy('cost'), qualityPool, request({ transactionId: 'cost-turn', affinityKey: 'cost' }),
  );
  assert(quality.resolvedDeployment?.modelId === 'best'
    && balanced.resolvedDeployment?.modelId === 'near'
    && cost.resolvedDeployment?.modelId !== 'cheap-low',
  'auto quality bands: quality is exact, balanced admits 2%, cost cannot cross 6%', checks);

  const speedBand = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'speed' },
    defaultRoutePolicy('speed'), [
      candidate('speed-provider', 'quality-anchor', { latencyMs: 1_000, throughput: 20, qualityByTask: { chat: { successes: 98, attempts: 100 } } }),
      candidate('speed-provider', 'fast-within-band', { latencyMs: 20, throughput: 400, qualityByTask: { chat: { successes: 94, attempts: 100 } } }),
      candidate('speed-provider', 'fast-outside-band', { latencyMs: 1, throughput: 1_000, qualityByTask: { chat: { successes: 93, attempts: 100 } } }),
    ], request({ transactionId: 'speed-band', affinityKey: 'speed-band' }),
  );
  assert(speedBand.resolvedDeployment?.modelId === 'fast-within-band'
    && !speedBand.rankedCandidates.some(item => item.deployment.modelId === 'fast-outside-band'),
  'auto quality bands: speed selects the fastest candidate inside its 4% loss band', checks);

  const constrainedPolicy: RoutePolicy = {
    ...defaultRoutePolicy('cost'),
    privacy: 'zdr',
    maxExpectedCostUsd: 0.003,
  };
  const constrained = router.route(
    {
      kind: 'auto',
      scope: { kind: 'global' },
      policyId: 'cost',
      subset: [
        { providerId: 'constraints', modelId: 'wrong-privacy' },
        { providerId: 'constraints', modelId: 'over-budget' },
        { providerId: 'constraints', modelId: 'eligible' },
      ],
    },
    constrainedPolicy,
    [
      candidate('constraints', 'outside-subset', { privacy: ['zdr'] }),
      candidate('constraints', 'wrong-privacy', { privacy: ['default'] }),
      candidate('constraints', 'over-budget', { privacy: ['zdr'], expectedInputCostUsdPerM: 10, expectedOutputCostUsdPerM: 10 }),
      candidate('constraints', 'eligible', { privacy: ['default', 'zdr'], expectedInputCostUsdPerM: 1, expectedOutputCostUsdPerM: 1 }),
    ],
    request({ transactionId: 'constraints', affinityKey: 'constraints' }),
  );
  assert(constrained.resolvedDeployment?.modelId === 'eligible'
    && constrained.excludedCandidates.some(item => item.deployment.modelId === 'outside-subset' && item.reasons.includes('outside_subset'))
    && constrained.excludedCandidates.some(item => item.deployment.modelId === 'wrong-privacy' && item.reasons.includes('privacy:zdr'))
    && constrained.excludedCandidates.some(item => item.deployment.modelId === 'over-budget' && item.reasons.includes('budget_exceeded')),
  'auto hard filters: explicit subset, privacy and expected-cost budget are enforced together', checks);

  const unknownCost = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'cost' },
    defaultRoutePolicy('cost'), [
      candidate('p', 'known-cost', { expectedInputCostUsdPerM: 5, expectedOutputCostUsdPerM: 5 }),
      candidate('p', 'unknown-cost', { expectedInputCostUsdPerM: undefined, expectedOutputCostUsdPerM: undefined }),
    ], request({ transactionId: 'unknown-cost', affinityKey: 'unknown-cost' }),
  );
  assert(unknownCost.resolvedDeployment?.modelId === 'known-cost',
    'auto cost: unknown price is worst-case rather than free', checks);

  const affinityPool = [
    candidate('p', 'incumbent', { latencyMs: 1_000 }),
    candidate('p', 'challenger', { latencyMs: 950 }),
  ];
  const incumbent = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'speed' },
    defaultRoutePolicy('speed'), [affinityPool[0]], request({ transactionId: 'affinity-1', affinityKey: 'sticky' }),
  );
  const sticky = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'speed' },
    defaultRoutePolicy('speed'), affinityPool, request({ transactionId: 'affinity-2', affinityKey: 'sticky' }),
  );
  assert(incumbent.resolvedDeployment?.modelId === 'incumbent'
    && sticky.resolvedDeployment?.modelId === 'incumbent'
    && sticky.pinReason === 'cache_affinity',
  'auto affinity: a sub-0.15 challenger cannot displace a valid five-minute route', checks);
  router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'speed' },
    defaultRoutePolicy('speed'), [candidate('p', 'slow-incumbent', { latencyMs: 1_000, throughput: 20 })],
    request({ transactionId: 'threshold-1', affinityKey: 'switch-threshold' }),
  );
  const thresholdSwitch = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'speed' },
    defaultRoutePolicy('speed'), [
      candidate('p', 'slow-incumbent', { latencyMs: 1_000, throughput: 20 }),
      candidate('p', 'decisive-challenger', { latencyMs: 10, throughput: 400 }),
    ],
    request({ transactionId: 'threshold-2', affinityKey: 'switch-threshold' }),
  );
  assert(thresholdSwitch.resolvedDeployment?.modelId === 'decisive-challenger' && !thresholdSwitch.pinReason,
    'auto affinity: a challenger with at least 0.15 utility advantage switches immediately', checks);
  const stickyIncumbent = sticky.rankedCandidates.find(item => item.deployment.modelId === 'incumbent');
  const stickyChallenger = sticky.rankedCandidates.find(item => item.deployment.modelId === 'challenger');
  assert(stickyIncumbent?.components.cache === 1 && stickyChallenger?.components.cache === 0,
    'auto affinity: the incumbent receives the cache component and challengers do not', checks);
  now += 5 * 60_000 + 1;
  const expired = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'speed' },
    defaultRoutePolicy('speed'), affinityPool, request({ transactionId: 'affinity-3', affinityKey: 'sticky' }),
  );
  assert(expired.pinReason !== 'cache_affinity', 'auto affinity: five-minute expiry causes fresh selection', checks);

  const interruptedStreak = { providerId: 'p', modelId: 'interrupted-streak' };
  router.recordEndpointFailure(interruptedStreak, 'transport');
  router.recordEndpointFailure(interruptedStreak, 'transport');
  router.recordEndpointFailure(interruptedStreak, 'invalid_request');
  router.recordEndpointFailure(interruptedStreak, 'transport');
  assert(router.endpointMetrics(interruptedStreak).circuit === 'closed',
    'auto health: a non-transport failure breaks the consecutive transport streak', checks);

  router.recordEndpointFailure({ providerId: 'p', modelId: 'broken' }, 'transport');
  router.recordEndpointFailure({ providerId: 'p', modelId: 'broken' }, 'transport');
  router.recordEndpointFailure({ providerId: 'p', modelId: 'broken' }, 'transport');
  const circuit = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), [candidate('p', 'broken'), candidate('p', 'healthy')],
    request({ transactionId: 'circuit', affinityKey: 'circuit' }),
  );
  assert(circuit.resolvedDeployment?.modelId === 'healthy'
    && circuit.excludedCandidates.some(entry => entry.deployment.modelId === 'broken' && entry.reasons.includes('circuit_open')),
  'auto health: three transport failures open a 60-second circuit', checks);
  now += 60_001;
  const halfOpenMetrics = router.endpointMetrics({ providerId: 'p', modelId: 'broken' });
  const halfOpen = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), [candidate('p', 'broken')],
    request({ transactionId: 'half-open-probe', affinityKey: 'half-open-probe' }),
  );
  const secondHalfOpen = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), [candidate('p', 'broken')],
    request({ transactionId: 'half-open-blocked', affinityKey: 'half-open-blocked' }),
  );
  assert(halfOpenMetrics.circuit === 'half_open'
    && halfOpen.resolvedDeployment?.modelId === 'broken'
    && !secondHalfOpen.resolvedDeployment
    && secondHalfOpen.excludedCandidates.some(entry => entry.reasons.includes('circuit_open')),
  'auto health: metrics reads are pure and cooldown permits exactly one half-open probe until success or failure', checks);
  router.recordEndpointSuccess({ providerId: 'p', modelId: 'broken' }, 800);

  const metricsRouter = new AutoRouter({ now: () => now });
  const measuredDeployment = { providerId: 'metrics-provider', modelId: 'metrics-model' };
  metricsRouter.recordEndpointSuccess(measuredDeployment, 100, 10);
  metricsRouter.recordEndpointSuccess(measuredDeployment, 300, 30);
  metricsRouter.recordEndpointSuccess(measuredDeployment, 200, 20);
  metricsRouter.recordEndpointFailure(measuredDeployment, 'transport');
  metricsRouter.recordToolOutcome(measuredDeployment, true);
  metricsRouter.recordToolOutcome(measuredDeployment, true);
  metricsRouter.recordToolOutcome(measuredDeployment, false);
  const measured = metricsRouter.endpointMetrics(measuredDeployment);
  assert(measured.attempts === 4
    && Math.abs(measured.reliability - 0.625) < 1e-9
    && measured.p50 === 200
    && measured.p95 === 300
    && measured.throughput === 20
    && measured.toolAttempts === 3
    && Math.abs(measured.toolValidity - (4 / 7)) < 1e-9,
  'auto health metrics: latency percentiles, median throughput, Beta reliability and tool validity use observed outcomes', checks);

  metricsRouter.recordEndpointFailure(measuredDeployment, 'auth');
  const authOpen = metricsRouter.endpointMetrics(measuredDeployment);
  metricsRouter.resetEndpointAfterConfigChange(measuredDeployment);
  const authReset = metricsRouter.endpointMetrics(measuredDeployment);
  assert(authOpen.circuit === 'open' && authReset.circuit === 'closed' && authReset.attempts === 0,
    'auto health: a provider configuration change clears an authentication circuit', checks);

  const feedbackNow = Date.parse('2026-07-30T00:00:00.000Z');
  const feedbackDeployment = { providerId: 'feedback-provider', modelId: 'feedback-model' };
  const spacedFeedback = new AutoRouter({ now: () => feedbackNow });
  const feedbackActivation = [
    spacedFeedback.recordFeedback({ deployment: feedbackDeployment, taskClass: 'coding', score: 1, source: 'explicit_rating', at: feedbackNow - 29 * 24 * 60 * 60_000 }),
    spacedFeedback.recordFeedback({ deployment: feedbackDeployment, taskClass: 'coding', score: 1, source: 'explicit_rating', at: feedbackNow - 15 * 24 * 60 * 60_000 }),
    spacedFeedback.recordFeedback({ deployment: feedbackDeployment, taskClass: 'coding', score: 1, source: 'explicit_rating', at: feedbackNow - 1 * 24 * 60 * 60_000 }),
  ];
  const clusteredFeedback = new AutoRouter({ now: () => feedbackNow });
  for (const offsetMs of [3_000, 2_000, 1_000]) {
    clusteredFeedback.recordFeedback({ deployment: feedbackDeployment, taskClass: 'coding', score: 1, source: 'explicit_rating', at: feedbackNow - offsetMs });
  }
  const spacedPreference = spacedFeedback.learnedPreference(feedbackDeployment, ['coding']);
  const clusteredPreference = clusteredFeedback.learnedPreference(feedbackDeployment, ['coding']);
  assert(feedbackActivation[0] === false
    && feedbackActivation[1] === false
    && feedbackActivation[2] === true
    && spacedPreference > 0
    && spacedPreference < clusteredPreference,
  'auto preference: learning starts at three domain events and EWMA decays between individually spaced events', checks);

  const fallbackPool = [
    candidate('p', 'primary', {
      deployment: { providerId: 'p', modelId: 'primary', logicalModelGroupId: 'logical-primary' },
      qualityByTask: { chat: { successes: 10, attempts: 10 } },
    }),
    candidate('p', 'equivalent', { deployment: { providerId: 'p', modelId: 'equivalent', logicalModelGroupId: 'logical-primary' } }),
    candidate('p', 'fallback', { fallbackOnly: true }),
    candidate('other', 'forbidden', { fallbackOnly: true }),
  ];
  const fallbackDecision = router.route(
    { kind: 'auto', scope: { kind: 'provider', providerId: 'p' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), fallbackPool,
    request({ transactionId: 'fallback', affinityKey: 'fallback' }),
  );
  const ladder = router.planAttempts(fallbackDecision, fallbackPool, {
    error: classifyRouteFailure('HTTP 503 upstream unavailable'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(ladder.length === 2
    && ladder[0].kind === 'retry_same_deployment'
    && ladder[1].deployment.modelId === 'equivalent'
    && ladder.every(attempt => attempt.deployment.providerId === 'p'),
  'auto fallback: failed initial call plus retry and explicit equivalent stay within three total attempts', checks);
  const fallbackOnlyLadder = router.planAttempts(fallbackDecision, fallbackPool.filter(item => item.deployment.modelId !== 'equivalent'), {
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
  const previewFallbackDecision = router.route(
    { kind: 'auto', scope: { kind: 'provider', providerId: 'p' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), previewFallbackPool,
    request({ transactionId: 'unsafe-preview-fallback', affinityKey: 'unsafe-preview-fallback' }),
  );
  const previewFallbackLadder = router.planAttempts(previewFallbackDecision, previewFallbackPool, {
    error: classifyRouteFailure('HTTP 503 upstream unavailable'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(previewFallbackLadder.length === 1 && previewFallbackLadder[0].kind === 'retry_same_deployment',
    'auto fallback: fallback-only candidates cannot bypass preview or other initial hard filters', checks);
  const overBudget429 = router.planAttempts(fallbackDecision, fallbackPool, {
    error: classifyRouteFailure('HTTP 429 Retry-After: 10s'),
    streamCommitted: false,
    sideEffectCommitted: false,
  });
  assert(overBudget429.length === 2
    && overBudget429.every(attempt => attempt.kind !== 'retry_same_deployment')
    && overBudget429[0].kind === 'equivalent_deployment'
    && overBudget429[1].kind === 'fallback_model',
  'auto retry budget: Retry-After is honored and an over-5s interactive wait is not performed', checks);
  const batchDecision = router.route(
    { kind: 'auto', scope: { kind: 'provider', providerId: 'p' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'), fallbackPool,
    request({ transactionId: 'fallback-batch', affinityKey: 'fallback-batch', batch: true }),
  );
  const batch429 = router.planAttempts(batchDecision, fallbackPool, {
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
    router.planAttempts(fallbackDecision, fallbackPool, { error: classifyRouteFailure('content policy refusal'), streamCommitted: false, sideEffectCommitted: false }),
    router.planAttempts(fallbackDecision, fallbackPool, { error: classifyRouteFailure('HTTP 503'), streamCommitted: true, sideEffectCommitted: false }),
    router.planAttempts(fallbackDecision, fallbackPool, { error: classifyRouteFailure('HTTP 503'), streamCommitted: false, sideEffectCommitted: true }),
  ];
  assert(refused.every(plan => plan.length === 0),
    'auto fallback: moderation, committed streams and side effects cannot switch or replay', checks);

  const policy: RoutePolicy = defaultRoutePolicy('balanced');
  const fixed = router.route(
    { kind: 'fixed', deployment: { providerId: 'p', modelId: 'best' } },
    policy, qualityPool, request({ transactionId: 'fixed', affinityKey: 'fixed' }),
  );
  assert(fixed.resolvedDeployment?.modelId === 'best' && fixed.rankedCandidates.length === 1,
    'auto contract: fixed selection bypasses model ranking', checks);
  assert(!JSON.stringify(balanced).includes('Explain this result'),
    'auto audit: RouteDecision does not retain prompt text', checks);

  const changedCatalog = router.route(
    { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
    defaultRoutePolicy('balanced'),
    qualityPool.map(item => item.deployment.modelId === 'near'
      ? { ...item, expectedInputCostUsdPerM: Number(item.expectedInputCostUsdPerM) + 1 }
      : item),
    request({ transactionId: 'catalog-change', affinityKey: 'catalog-change' }),
  );
  assert(changedCatalog.catalogSnapshotHash !== balanced.catalogSnapshotHash,
    'auto audit: catalog snapshot hash changes when a routing input changes', checks);

  return checks;
}

if (require.main === module) {
  const checks = verifyAutoRouter();
  const failed = checks.filter(check => !check.ok);
  console.log(`\nAuto Router verification: ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) process.exitCode = 1;
}
