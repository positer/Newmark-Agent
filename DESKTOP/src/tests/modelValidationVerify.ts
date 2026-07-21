import * as assert from 'assert';
import {
  MODEL_VALIDATION_MAX_CONCURRENCY,
  MODEL_VALIDATION_TTL_MS,
  VALIDATION_LEVELS,
  VALIDATION_STATUSES,
  InMemoryModelValidationCache,
  ModelValidationProbeError,
  ModelValidationService,
  ToolValidationErrorCode,
  executeValidatedToolCall,
  redactValidationAudit,
  runMajorityProbe,
  validateImageOutput,
  type ModelValidationProbeAdapter,
  type ToolProbeObservation,
  type ToolProbeScenario,
} from '../core/modelValidation';

let assertions = 0;

function ok(value: unknown, message: string): asserts value {
  assert.ok(value, message);
  assertions += 1;
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.strictEqual(actual, expected, message);
  assertions += 1;
}

function png1x1(): Uint8Array {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}

async function verifyMajorityAndPermanentErrors(): Promise<void> {
  let stableAttempts = 0;
  const stable = await runMajorityProbe(async () => {
    stableAttempts += 1;
    return { ok: true };
  });
  equal(stableAttempts, 2, 'stable probe is sampled exactly twice');
  ok(stable.ok && stable.successes === 2 && stable.attempts === 2, 'two matching successes verify the probe');

  let splitAttempts = 0;
  const split = await runMajorityProbe(async () => {
    splitAttempts += 1;
    return { ok: splitAttempts !== 2 };
  });
  equal(splitAttempts, 3, 'split first two observations trigger a third sample');
  ok(split.ok && split.successes === 2 && split.attempts === 3, 'split probe uses a two-of-three majority');

  let permanentAttempts = 0;
  const permanent = await runMajorityProbe(async () => {
    permanentAttempts += 1;
    throw new ModelValidationProbeError('invalid key', {
      status: 'auth_error',
      permanent: true,
      code: 'invalid_api_key',
    });
  });
  equal(permanentAttempts, 1, 'permanent probe failures are never retried');
  ok(!permanent.ok && permanent.status === 'auth_error' && permanent.permanentFailure, 'permanent authentication failure is classified');

  let reportedPermanentAttempts = 0;
  const reportedPermanent = await runMajorityProbe(async () => {
    reportedPermanentAttempts += 1;
    return { ok: false, status: 'invalid_config', reasonCode: 'missing_endpoint' };
  });
  equal(reportedPermanentAttempts, 1, 'returned permanent statuses short-circuit just like thrown permanent errors');
  ok(reportedPermanent.permanentFailure && reportedPermanent.status === 'invalid_config', 'returned invalid configuration is marked permanent');

  let cannotDemoteAttempts = 0;
  await runMajorityProbe(async () => {
    cannotDemoteAttempts += 1;
    return { ok: false, status: 'auth_error', permanent: false };
  });
  equal(cannotDemoteAttempts, 1, 'an adapter cannot demote authentication errors into retryable failures');
}

function successfulAdapter(hooks: {
  enter?: () => void;
  leave?: () => void;
  healthOk?: boolean;
  onVision?: () => void;
  onImage?: () => void;
} = {}): ModelValidationProbeAdapter {
  const wrap = async <T>(value: T): Promise<T> => {
    hooks.enter?.();
    await new Promise<void>(resolve => setTimeout(resolve, 2));
    hooks.leave?.();
    return value;
  };
  return {
    health: () => wrap({ ok: hooks.healthOk !== false, latencyMs: 3 }),
    textNonce: request => wrap({ output: request.nonce, latencyMs: 4 }),
    streamNonce: request => wrap({
      chunks: [request.nonce.slice(0, 4), request.nonce.slice(4)],
      completed: true,
      completionEvent: 'provider_completed',
      latencyMs: 5,
    }),
    strictJson: request => wrap({ raw: JSON.stringify({ nonce: request.nonce }), latencyMs: 6 }),
    tool: (scenario: ToolProbeScenario): Promise<ToolProbeObservation> => wrap({
      selectedToolName: scenario.knownToolName,
      rawArguments: JSON.stringify({ nonce: scenario.nonce }),
      unknownToolAttempted: false,
      toolResultAccepted: scenario.kind === 'tool_result' ? true : undefined,
      finalText: scenario.kind === 'tool_result' ? scenario.nonce : undefined,
      latencyMs: 7,
    }),
    vision: challenge => {
      hooks.onVision?.();
      return wrap({ answer: challenge.expectedAnswer, latencyMs: 8 });
    },
    imageOutput: () => {
      hooks.onImage?.();
      return wrap({ bytes: png1x1(), mimeType: 'image/png', latencyMs: 9 });
    },
  };
}

async function verifyStandardOrchestrationAndConcurrency(): Promise<void> {
  let active = 0;
  let peak = 0;
  let visionCalls = 0;
  let imageCalls = 0;
  const adapter = successfulAdapter({
    enter: () => { active += 1; peak = Math.max(peak, active); },
    leave: () => { active -= 1; },
    onVision: () => { visionCalls += 1; },
    onImage: () => { imageCalls += 1; },
  });
  const service = new ModelValidationService({
    nonceFactory: () => 'NMK-VALIDATION-1234',
    maxConcurrency: 99,
  });
  const result = await service.validate({
    model: { provider: 'fixture', model: 'standard' },
    level: 'standard',
    declaredCapabilities: { vision: true, imageOutput: true },
    visionChallenge: {
      bytes: png1x1(),
      mimeType: 'image/png',
      expectedAnswer: 'ONE_WHITE_PIXEL',
    },
    adapter,
  });

  equal(MODEL_VALIDATION_MAX_CONCURRENCY, 2, 'validation service publishes a hard concurrency ceiling of two');
  ok(peak <= 2, `standard probes never exceed two concurrent calls (observed ${peak})`);
  ok(result.status === 'verified', 'complete standard suite verifies the model');
  ok(result.health?.status === 'verified', 'health is recorded independently');
  for (const capability of ['text', 'streaming', 'strict_json', 'tools', 'vision'] as const) {
    ok(result.capabilities[capability]?.status === 'verified', `standard suite verifies ${capability}`);
  }
  equal(result.capabilities.tools?.evidence.length, 4, 'tool capability requires correct selection, unknown exclusion, schema, and tool-result probes');
  equal(visionCalls, 2, 'declared vision capability is sampled twice');
  equal(imageCalls, 0, 'standard validation does not run the extended image-output probe');

  const extended = await service.validate({
    model: { provider: 'fixture', model: 'extended' },
    level: 'extended',
    declaredCapabilities: { imageOutput: true },
    adapter,
  });
  ok(extended.capabilities.image_output?.status === 'verified', 'extended validation verifies declared image output');
  equal(imageCalls, 2, 'declared image output is sampled twice at extended level');
}

async function verifyStreamingRequiresTerminalEvidence(): Promise<void> {
  const adapter = successfulAdapter();
  adapter.streamNonce = async request => ({
    chunks: [request.nonce],
    completed: true,
    // Deliberately omit completionEvent: socket EOF is not protocol evidence.
  });
  const result = await new ModelValidationService({ nonceFactory: () => 'NMK-NO-DONE-1234' }).validate({
    model: { provider: 'fixture', model: 'truncated-stream' },
    level: 'standard',
    adapter,
  });
  ok(result.capabilities.streaming?.status === 'unavailable', 'streaming is rejected when content arrives without a terminal protocol event');
  ok(result.capabilities.streaming?.evidence[0]?.reasonCodes.includes('stream_terminal_event_missing'), 'missing terminal SSE evidence has a stable reason code');
  ok(result.status === 'degraded', 'a successful base text probe keeps the model available when optional streaming validation fails');
}

async function verifyUnsupportedOptionalCapabilityDoesNotBlockAvailability(): Promise<void> {
  const adapter = successfulAdapter();
  adapter.strictJson = async () => {
    throw new ModelValidationProbeError('response_format is unsupported', {
      status: 'invalid_config',
      permanent: true,
      code: 'http_400',
    });
  };
  const result = await new ModelValidationService({ nonceFactory: () => 'NMK-OPTIONAL-1234' }).validate({
    model: { provider: 'fixture', model: 'text-works-json-unsupported' },
    level: 'standard',
    adapter,
  });
  ok(result.capabilities.text?.status === 'verified', 'base text availability is independently verified');
  ok(result.capabilities.strict_json?.status === 'invalid_config', 'unsupported strict JSON remains visible as capability evidence');
  ok(result.status === 'degraded', 'unsupported optional capability degrades rather than blocks an otherwise usable model');
}

async function verifyLegacyFalseNegativeCacheRepairsWithoutProviderCalls(): Promise<void> {
  const cache = new InMemoryModelValidationCache();
  const now = Date.UTC(2026, 6, 21, 0, 0, 0);
  cache.set({
    schemaVersion: 1,
    model: { provider: 'fixture', model: 'legacy-false-negative' },
    modelKey: 'fixture/legacy-false-negative',
    level: 'standard',
    status: 'invalid_config',
    checkedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MODEL_VALIDATION_TTL_MS).toISOString(),
    cacheHit: false,
    health: { status: 'verified', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + MODEL_VALIDATION_TTL_MS).toISOString(), attempts: 2, successes: 2, failures: 0, reasonCodes: [] },
    capabilities: {
      text: { capability: 'text', status: 'verified', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + MODEL_VALIDATION_TTL_MS).toISOString(), evidence: [] },
      streaming: { capability: 'streaming', status: 'verified', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + MODEL_VALIDATION_TTL_MS).toISOString(), evidence: [] },
      strict_json: { capability: 'strict_json', status: 'invalid_config', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + MODEL_VALIDATION_TTL_MS).toISOString(), evidence: [] },
      tools: { capability: 'tools', status: 'verified', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + MODEL_VALIDATION_TTL_MS).toISOString(), evidence: [] },
    },
    audit: [],
  });
  let calls = 0;
  const result = await new ModelValidationService({ cache, clock: () => now }).validate({
    model: { provider: 'fixture', model: 'legacy-false-negative' },
    level: 'standard',
    adapter: { health: async () => { calls += 1; return { ok: true }; } },
  });
  ok(result.cacheHit && result.status === 'degraded', 'fresh legacy false-negative cache is repaired to usable degraded status');
  equal(calls, 0, 'legacy availability repair does not issue duplicate provider requests');
}

async function verifyTtlAndLevelCache(): Promise<void> {
  equal(MODEL_VALIDATION_TTL_MS, 7 * 24 * 60 * 60 * 1_000, 'validation evidence TTL is exactly seven days');
  let now = Date.UTC(2026, 6, 15, 0, 0, 0);
  let textCalls = 0;
  const adapter = successfulAdapter();
  const counted: ModelValidationProbeAdapter = {
    ...adapter,
    textNonce: async request => {
      textCalls += 1;
      return adapter.textNonce!(request);
    },
  };
  const service = new ModelValidationService({
    clock: () => now,
    nonceFactory: () => 'NMK-CACHE-1234',
  });
  const request = {
    model: { provider: 'fixture', model: 'cache' },
    level: 'basic' as const,
    adapter: counted,
  };
  const first = await service.validate(request);
  equal(textCalls, 2, 'initial basic validation performs two stable text samples');
  equal(Date.parse(first.expiresAt) - Date.parse(first.checkedAt), MODEL_VALIDATION_TTL_MS, 'stored record expires seven days after validation');

  now += MODEL_VALIDATION_TTL_MS - 1;
  const cached = await service.validate(request);
  ok(cached.cacheHit, 'fresh evidence is reused before the seven-day expiry');
  equal(textCalls, 2, 'fresh cache avoids duplicate probes');

  now += 1;
  const refreshed = await service.validate(request);
  ok(!refreshed.cacheHit, 'evidence is refreshed at the expiry boundary');
  equal(textCalls, 4, 'expired cache runs a fresh two-sample probe');
}

async function verifyTransientHealthDoesNotRefreshCapabilityEvidence(): Promise<void> {
  let now = Date.UTC(2026, 6, 15, 0, 0, 0);
  const cache = new InMemoryModelValidationCache();
  const service = new ModelValidationService({
    cache,
    clock: () => now,
    nonceFactory: () => 'NMK-STALE-EVIDENCE-1234',
  });
  const model = { provider: 'fixture', model: 'transient-after-expiry' };
  const first = await service.validate({ model, level: 'standard', adapter: successfulAdapter() });
  const originalCapabilities = JSON.stringify(first.capabilities);
  const originalCapabilityExpiry = first.capabilities.streaming?.expiresAt;
  now += MODEL_VALIDATION_TTL_MS;
  let capabilityCalls = 0;
  const transient = successfulAdapter();
  transient.health = async () => ({ ok: false, status: 'rate_limited', reasonCode: 'http_429' });
  transient.textNonce = async request => { capabilityCalls += 1; return { output: request.nonce }; };
  transient.streamNonce = async request => {
    capabilityCalls += 1;
    return { chunks: [request.nonce], completed: true, completionEvent: 'provider_completed' };
  };
  transient.strictJson = async request => { capabilityCalls += 1; return { raw: JSON.stringify({ nonce: request.nonce }) }; };
  transient.tool = async scenario => {
    capabilityCalls += 1;
    return { selectedToolName: scenario.knownToolName, rawArguments: JSON.stringify({ nonce: scenario.nonce }) };
  };
  const failedHealth = await service.validate({ model, level: 'standard', adapter: transient });
  ok(failedHealth.status === 'rate_limited' && failedHealth.health?.checkedAt === new Date(now).toISOString(), 'transient retry updates only current health state');
  equal(capabilityCalls, 0, 'transient health failure does not fan out expired capability probes');
  equal(JSON.stringify(failedHealth.capabilities), originalCapabilities, 'transient health failure preserves capability evidence byte-for-byte');
  equal(failedHealth.capabilities.streaming?.expiresAt, originalCapabilityExpiry, 'expired capability evidence never receives a new seven-day expiry');
  const retriedHealth = await service.validate({ model, level: 'standard', adapter: transient });
  ok(!retriedHealth.cacheHit, 'fresh health does not make preserved expired capability evidence cache-valid');
  equal(capabilityCalls, 0, 'rechecking stale evidence still performs health only while the endpoint is transiently unavailable');
}

async function verifyHealthCapabilitySeparation(): Promise<void> {
  const adapter = successfulAdapter({ healthOk: false });
  const service = new ModelValidationService({ nonceFactory: () => 'NMK-HEALTH-1234' });
  const healthOnly = await service.validateHealth(adapter);
  const capabilitiesOnly = await service.validateCapabilities({ level: 'basic', adapter });
  ok(healthOnly?.status === 'unavailable', 'health can be scheduled independently from capability validation');
  ok(capabilitiesOnly.text?.status === 'verified', 'capability validation can be scheduled independently from health');

  const result = await service.validate({
    model: { provider: 'fixture', model: 'health-split' },
    level: 'basic',
    adapter,
  });
  ok(result.health?.status === 'unavailable', 'failed health check remains in the health record');
  ok(result.capabilities.text?.status === 'verified', 'health failure does not erase independently verified text capability');
  ok(result.status === 'unavailable', 'overall usability still reflects current failed health');

  let textCallsAfterPermanentHealthFailure = 0;
  const permanentHealthAdapter = successfulAdapter();
  permanentHealthAdapter.health = async () => ({ ok: false, status: 'auth_error', reasonCode: 'invalid_api_key' });
  permanentHealthAdapter.textNonce = async request => {
    textCallsAfterPermanentHealthFailure += 1;
    return { output: request.nonce };
  };
  const authFailure = await new ModelValidationService().validate({
    model: { provider: 'fixture', model: 'auth-failure' },
    level: 'basic',
    adapter: permanentHealthAdapter,
  });
  equal(authFailure.health?.attempts, 1, 'permanent health status stops its own retry loop');
  equal(textCallsAfterPermanentHealthFailure, 0, 'permanent health failure prevents a fan-out of capability requests');
  ok(authFailure.status === 'auth_error' && !authFailure.capabilities.text, 'health auth failure remains separate from unprobed capability evidence');
}

async function verifyToolErrorTaxonomy(): Promise<void> {
  type Expected = ToolValidationErrorCode;
  const contract = {
    validate: (args: unknown) => !!args && typeof args === 'object' && (args as { nonce?: unknown }).nonce === 'ok',
    policy: () => true,
    execute: async () => ({ echoed: 'ok' }),
    postcondition: (result: unknown) => (result as { echoed?: string }).echoed === 'ok',
  };
  const cases: Array<{ expected: Expected; run: () => Promise<unknown> }> = [
    { expected: 'InvalidJson', run: () => executeValidatedToolCall({ name: 'echo', rawArguments: '{', tools: { echo: contract } }) },
    { expected: 'UnknownName', run: () => executeValidatedToolCall({ name: 'missing', rawArguments: '{}', tools: { echo: contract } }) },
    { expected: 'SchemaMismatch', run: () => executeValidatedToolCall({ name: 'echo', rawArguments: '{}', tools: { echo: contract } }) },
    { expected: 'PolicyDenied', run: () => executeValidatedToolCall({ name: 'echo', rawArguments: '{"nonce":"ok"}', tools: { echo: { ...contract, policy: () => false } } }) },
    { expected: 'ExecutionFailed', run: () => executeValidatedToolCall({ name: 'echo', rawArguments: '{"nonce":"ok"}', tools: { echo: { ...contract, execute: async () => { throw new Error('boom'); } } } }) },
    { expected: 'PostconditionFailed', run: () => executeValidatedToolCall({ name: 'echo', rawArguments: '{"nonce":"ok"}', tools: { echo: { ...contract, postcondition: () => false } } }) },
  ];
  for (const testCase of cases) {
    const result = await testCase.run() as { ok: boolean; error?: { code: ToolValidationErrorCode } };
    ok(!result.ok && result.error?.code === testCase.expected, `tool validation reports ${testCase.expected}`);
  }
  const passed = await executeValidatedToolCall({ name: 'echo', rawArguments: '{"nonce":"ok"}', tools: { echo: contract } });
  ok(passed.ok, 'valid tool call passes the complete validation/execution/postcondition chain');
}

function verifyImageValidation(): void {
  const valid = validateImageOutput({ bytes: png1x1(), mimeType: 'image/png' });
  ok(valid.ok && valid.detectedMimeType === 'image/png' && valid.width === 1 && valid.height === 1, 'image validation reads real bytes, MIME, and dimensions');

  const mismatch = validateImageOutput({ bytes: png1x1(), mimeType: 'image/jpeg' });
  ok(!mismatch.ok && mismatch.error === 'MimeMismatch', 'declared MIME must match image bytes');

  const malformed = validateImageOutput({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' });
  ok(!malformed.ok && malformed.error === 'MalformedImage', 'truncated image bytes are rejected');

  const dimensions = validateImageOutput({ bytes: png1x1(), mimeType: 'image/png' }, { minWidth: 2, minHeight: 2 });
  ok(!dimensions.ok && dimensions.error === 'InvalidDimensions', 'dimension bounds are enforced');
}

function verifyAuditRedaction(): void {
  const secret = 'fixture-secret-never-real-value';
  const sanitized = redactValidationAudit({
    authorization: `Bearer ${secret}`,
    apiKey: secret,
    nested: {
      url: `https://user:${secret}@example.test/v1`,
      message: `Authorization: Bearer ${secret}; api_key=${secret}`,
      safe: 'probe_completed',
    },
  }, [secret]);
  const serialized = JSON.stringify(sanitized);
  ok(!serialized.includes(secret), 'audit redaction removes configured secrets from keys, headers, URLs, and messages');
  ok(serialized.includes('[REDACTED]') && serialized.includes('probe_completed'), 'audit keeps useful non-secret diagnostics');
}

async function verifyPublishedStateMachine(): Promise<void> {
  assert.deepStrictEqual(VALIDATION_LEVELS, ['discovered', 'basic', 'standard', 'extended']);
  assertions += 1;
  assert.deepStrictEqual(VALIDATION_STATUSES, ['verified', 'degraded', 'unavailable', 'auth_error', 'rate_limited', 'invalid_config']);
  assertions += 1;
  let calls = 0;
  const discovered = await new ModelValidationService().validate({
    model: { provider: 'fixture', model: 'catalog-only' },
    level: 'discovered',
    adapter: {
      health: async () => { calls += 1; return { ok: true }; },
      textNonce: async request => { calls += 1; return { output: request.nonce }; },
    },
  });
  ok(discovered.status === 'degraded' && !discovered.health && Object.keys(discovered.capabilities).length === 0, 'discovered level records catalog evidence without claiming live verification');
  equal(calls, 0, 'discovered level performs no network probes');
}

async function main(): Promise<void> {
  await verifyMajorityAndPermanentErrors();
  await verifyStandardOrchestrationAndConcurrency();
  await verifyStreamingRequiresTerminalEvidence();
  await verifyUnsupportedOptionalCapabilityDoesNotBlockAvailability();
  await verifyLegacyFalseNegativeCacheRepairsWithoutProviderCalls();
  await verifyTtlAndLevelCache();
  await verifyTransientHealthDoesNotRefreshCapabilityEvidence();
  await verifyHealthCapabilitySeparation();
  await verifyPublishedStateMachine();
  await verifyToolErrorTaxonomy();
  verifyImageValidation();
  verifyAuditRedaction();
  console.log(`model validation verification passed (${assertions} assertions)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
