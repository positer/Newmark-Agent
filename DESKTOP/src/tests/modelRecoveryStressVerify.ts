import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';
import { AutoRouteCandidate, AutoRouter, classifyRouteFailure, defaultRoutePolicy } from '../core/autoRouter';

function model(name: string, cost: number): Record<string, unknown> {
  return {
    name,
    display: name,
    description: '',
    cost_per_1k_input: cost,
    cost_per_1k_output: cost,
    max_tokens: 128000,
    vision: false,
    thinking: false,
    image_output: false,
    enabled: true,
    capabilities: ['text_input', 'text_output'],
    validation: { level: 'standard', status: 'verified', checked_at: 'fixture', capabilities: { text_input: true, text_output: true } },
    speed_rating: 'fast',
    capability_rating: 'high',
    intelligence_tiers: {
      low: { description: 'Low' }, medium: { description: 'Medium' }, high: { description: 'High' },
      xhigh: { description: 'XHigh' }, max: { description: 'Max' },
    },
  };
}

function candidate(modelId: string, cost: number, providerId = 'stress-provider'): AutoRouteCandidate {
  return {
    deployment: { providerId, modelId },
    enabled: true,
    validation: { level: 'standard', status: 'verified', checkedAt: new Date().toISOString() },
    capabilities: ['text_input', 'text_output'],
    maxContextTokens: 128000,
    preview: false,
    privacy: ['default'],
    expectedInputCostUsdPerM: cost,
    expectedOutputCostUsdPerM: cost,
    reliability: modelId === 'primary' ? 1 : 0.99,
    throughput: modelId === 'primary' ? 100 : 90,
  };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-model-recovery-stress-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      models: {
        providers: { value: [{
          id: 'stress-provider', name: 'Stress', base_url: 'https://stress.invalid/v1', api_key: 'stress-key', protocol: 'openai', enabled: true,
          models: [model('primary', 0.1), model('backup', 0.2)],
        }] },
        default_model: { value: 'primary' },
        auto_switch: { value: true },
        auto_switch_scope: { value: 'provider' },
        auto_switch_anchor_provider: { value: 'stress-provider' },
        auto_switch_preference: { value: 'balanced' },
        fallback_on_unavailable: { value: true },
      },
      workspace: { auto_create_timestamp_workspace: { value: false } },
    }, null, 2));
    const agent = new Agent(root, { agentOnly: true, conversationId: 'model-recovery-stress' });

    const noOpProviders = JSON.parse(JSON.stringify(agent.config.providers())) as Array<Record<string, any>>;
    agent.updateProviders(noOpProviders);
    let preserved = agent.config.findDeployment({ providerId: 'stress-provider', modelId: 'primary' });
    assert.equal(preserved?.validation?.level, 'standard', 'no-op save discarded verified validation level');
    assert.equal(preserved?.validation?.status, 'verified', 'no-op save discarded verified validation status');
    assert.equal(preserved?.speed_rating, 'fast', 'no-op save discarded speed evidence');
    assert.equal(preserved?.capability_rating, 'high', 'no-op save discarded capability evidence');

    const credentialRotation = JSON.parse(JSON.stringify(agent.config.providers())) as Array<Record<string, any>>;
    credentialRotation[0].api_key = 'rotated-stress-key';
    agent.updateProviders(credentialRotation);
    preserved = agent.config.findDeployment({ providerId: 'stress-provider', modelId: 'primary' });
    assert.equal(preserved?.validation?.level, 'standard', 'credential-only edit discarded verified capability evidence');
    assert.equal(preserved?.validation?.status, 'verified', 'credential-only edit changed verified status');

    const endpointEdit = JSON.parse(JSON.stringify(agent.config.providers())) as Array<Record<string, any>>;
    endpointEdit[0].base_url = 'https://stress-edited.invalid/v1';
    endpointEdit[0].models[0].evaluation = { status: 'unavailable', checked_at: 'stale-primary' };
    endpointEdit[0].models[1].evaluation = { status: 'unavailable', checked_at: 'stale-backup' };
    agent.updateProviders(endpointEdit);
    for (const modelName of ['primary', 'backup']) {
      const reset = agent.config.findDeployment({ providerId: 'stress-provider', modelId: modelName });
      assert.equal(reset?.validation?.level, 'discovered', `endpoint edit did not reset ${modelName}`);
      assert.equal(reset?.validation?.status, 'degraded', `endpoint edit left ${modelName} terminally unavailable`);
      assert.equal(reset?.evaluation, undefined, `endpoint edit retained stale ${modelName} evaluation`);
      assert.equal(reset?.speed_rating, 'unknown', `endpoint edit retained stale ${modelName} speed rating`);
      assert.equal(reset?.capability_rating, 'unknown', `endpoint edit retained stale ${modelName} capability rating`);
    }

    const renameProviders = JSON.parse(JSON.stringify(agent.config.providers())) as Array<Record<string, any>>;
    const renamed = renameProviders[0].models.find((entry: Record<string, unknown>) => entry.name === 'primary');
    renamed._previous_name = 'primary';
    renamed.name = 'primary-renamed';
    renamed.display = 'Primary Renamed';
    renamed.validation = { level: 'standard', status: 'unavailable', checked_at: 'rename-failure', capabilities: {} };
    agent.updateProviders(renameProviders);
    const renamedSaved = agent.config.findDeployment({ providerId: 'stress-provider', modelId: 'primary-renamed' });
    assert.equal(renamedSaved?.validation?.level, 'discovered', 'renamed model did not return to untested state');
    assert.equal(renamedSaved?.validation?.status, 'degraded', 'renamed model retained unavailable status');
    agent.setModel('deployment:stress-provider:primary-renamed');
    assert.equal(agent.modelIsUnavailable('primary-renamed'), false, 'renamed model remained selection-locked');

    const renameBackProviders = JSON.parse(JSON.stringify(agent.config.providers())) as Array<Record<string, any>>;
    const renameBack = renameBackProviders[0].models.find((entry: Record<string, unknown>) => entry.name === 'primary-renamed');
    renameBack._previous_name = 'primary-renamed';
    renameBack.name = 'primary';
    renameBack.display = 'primary';
    agent.updateProviders(renameBackProviders);
    agent.setModel('deployment:stress-provider:primary');

    for (let round = 0; round < 250; round += 1) {
      const providers = JSON.parse(JSON.stringify(agent.config.providers())) as Array<Record<string, any>>;
      const edited = providers[0].models.find((entry: Record<string, unknown>) => entry.name === 'primary');
      edited.description = `edit-${round}`;
      edited.validation = { level: 'standard', status: round % 2 ? 'rate_limited' : 'unavailable', checked_at: `failure-${round}`, capabilities: {} };
      edited.evaluation = { status: 'unavailable', checked_at: `failure-${round}` };
      agent.updateProviders(providers);
      const saved = agent.config.findDeployment({ providerId: 'stress-provider', modelId: 'primary' });
      assert.equal(saved?.validation?.level, 'discovered', `edit round ${round} did not reset validation level`);
      assert.equal(saved?.validation?.status, 'degraded', `edit round ${round} retained a terminal unavailable status`);
      assert.equal(saved?.validation?.checked_at, '', `edit round ${round} retained stale checked_at`);
      assert.equal(saved?.evaluation, undefined, `edit round ${round} retained stale evaluation`);
      assert.equal(saved?.speed_rating, 'unknown', `edit round ${round} retained stale speed evidence`);
      assert.equal(saved?.capability_rating, 'unknown', `edit round ${round} retained stale capability evidence`);
      assert.equal(agent.modelIsUnavailable('primary'), false, `edit round ${round} left the model selection-locked`);
    }

    const failureMessages = [
      'HTTP 402 insufficient balance',
      'HTTP 429 insufficient_quota',
      'quota exceeded: credits exhausted',
      'billing hard limit reached',
      '预算 exhausted 额度不足',
      'HTTP 402 payment required',
      'insufficient funds for this request',
      'credit balance depleted',
      'budget exhausted for project',
      '配额超限，请充值',
    ];
    for (let round = 0; round < 2000; round += 1) {
      const router = new AutoRouter();
      const candidates = [candidate('primary', 0.1), candidate('backup', 0.2), candidate('backup-two', 0.3)];
      const decision = router.route(
        { kind: 'auto', scope: { kind: 'provider', providerId: 'stress-provider' }, policyId: 'balanced' },
        defaultRoutePolicy('balanced'),
        candidates,
        { transactionId: `quota-${round}`, affinityKey: `quota-${round}`, taskText: 'chat', estimatedInputTokens: 64, expectedOutputTokens: 64, requiredCapabilities: [] },
      );
      assert.equal(decision.resolvedDeployment?.modelId, 'primary', `route round ${round} did not select primary fixture`);
      const failure = classifyRouteFailure(failureMessages[round % failureMessages.length]);
      assert.equal(failure.type, 'balance_exhausted', `route round ${round} misclassified quota failure`);
      assert.equal(failure.retryable, false, `route round ${round} would retry exhausted deployment`);
      assert.equal(failure.switchAllowed, true, `route round ${round} blocked safe switching`);
      const attempts = router.planAttempts(decision, candidates, { error: failure, streamCommitted: false, sideEffectCommitted: false });
      assert.equal(attempts.length, 2, `route round ${round} did not fill the bounded recovery ladder`);
      assert.equal(attempts[0].kind, 'alternate_model', `route round ${round} did not use ordinary alternate`);
      assert.equal(attempts[0].deployment.modelId, 'backup', `route round ${round} selected the wrong alternate`);
      assert.equal(attempts[1].kind, 'alternate_model', `route round ${round} did not schedule a second ordinary alternate`);
      assert.equal(attempts[1].deployment.modelId, 'backup-two', `route round ${round} selected the wrong second alternate`);
      assert.equal(new Set(attempts.map(attempt => `${attempt.deployment.providerId}:${attempt.deployment.modelId}`)).size, 2,
        `route round ${round} repeated a deployment in the fallback ladder`);
      assert.equal(router.planAttempts(decision, candidates, { error: failure, streamCommitted: true, sideEffectCommitted: false }).length, 0,
        `route round ${round} switched after stream commit`);
      assert.equal(router.planAttempts(decision, candidates, { error: failure, streamCommitted: false, sideEffectCommitted: true }).length, 0,
        `route round ${round} switched after side-effect commit`);
    }

    const nonQuotaFailures: Array<[string, string]> = [
      ['HTTP 429 rate limit exceeded', 'rate_limited'],
      ['HTTP 401 invalid api key', 'auth'],
      ['HTTP 403 forbidden', 'auth'],
      ['HTTP 400 invalid request', 'invalid_request'],
      ['content policy refusal', 'content_policy'],
      ['monthly budget configured at 20 dollars', 'execution_error'],
      ['quota remaining: 5000 tokens', 'execution_error'],
    ];
    for (let round = 0; round < 500; round += 1) {
      const [message, expected] = nonQuotaFailures[round % nonQuotaFailures.length];
      assert.equal(classifyRouteFailure(message).type, expected, `non-quota failure was misclassified: ${message}`);
    }

    agent.setModel('deployment:stress-provider:primary');
    agent.noteProviderBalanceFailure();
    const previous = agent.switchToFallbackModel('HTTP 429 insufficient_quota');
    assert.equal(previous, 'primary');
    assert.equal(agent.activeDeployment()?.modelId, 'backup');
    assert.equal(agent.isBalanceBlockedDeployment({ providerId: 'stress-provider', modelId: 'primary' }), true);
    assert.equal(agent.isBalanceBlockedDeployment({ providerId: 'stress-provider', modelId: 'backup' }), false);

    // Same-name cross-provider boundary: when the failed provider has no
    // remaining usable model, a fixed-model fallback must NOT reach a
    // same-named model on another provider. The failed deployment stays
    // selected and the switch reports null.
    const boundaryRoot = path.join(root, 'boundary-provider');
    fs.mkdirSync(boundaryRoot, { recursive: true });
    fs.writeFileSync(path.join(boundaryRoot, 'config.json'), JSON.stringify({
      models: {
        providers: { value: [
          { id: 'boundary-a', name: 'Boundary A', base_url: 'https://boundary-a.invalid/v1', api_key: 'a-key', protocol: 'openai', enabled: true, models: [model('same-model', 0.1)] },
          { id: 'boundary-b', name: 'Boundary B', base_url: 'https://boundary-b.invalid/v1', api_key: 'b-key', protocol: 'openai', enabled: true, models: [model('same-model', 0.2)] },
        ] },
        default_model: { value: 'same-model' },
        auto_switch: { value: false },
        fallback_on_unavailable: { value: true },
      },
      workspace: { auto_create_timestamp_workspace: { value: false } },
    }, null, 2));
    const boundaryAgent = new Agent(boundaryRoot, { agentOnly: true, conversationId: 'boundary-provider' });
    boundaryAgent.setModel('deployment:boundary-a:same-model');
    const boundaryBefore = boundaryAgent.activeDeployment();
    boundaryAgent.noteProviderBalanceFailure();
    const boundarySwitched = boundaryAgent.switchToFallbackModel('HTTP 402 insufficient_quota');
    assert.equal(boundarySwitched, null, 'fixed-model fallback must not cross to a same-named model on another provider');
    const boundaryAfter = boundaryAgent.activeDeployment();
    assert.equal(boundaryAfter?.providerId, 'boundary-a', 'cross-provider fallback leaked the provider identity');
    assert.equal(boundaryAfter?.modelId, boundaryBefore?.modelId, 'cross-provider fallback changed the selected model');

    const originalFetch = globalThis.fetch;
    let processFailovers = 0;
    try {
      for (let round = 0; round < 30; round += 1) {
        const processRoot = path.join(root, `process-${round}`);
        fs.mkdirSync(processRoot, { recursive: true });
        fs.writeFileSync(path.join(processRoot, 'config.json'), JSON.stringify({
          models: {
            providers: { value: [
              {
                id: 'quota-primary', name: 'Quota Primary', base_url: 'https://quota-primary.invalid/v1', api_key: 'primary-key', protocol: 'openai', enabled: true,
                models: [model('shared-model', 0.1), model('shared-backup', 0.2), model('shared-final', 0.3)],
              },
              {
                id: 'quota-other', name: 'Quota Other', base_url: 'https://quota-other.invalid/v1', api_key: 'other-key', protocol: 'openai', enabled: true,
                models: [model('shared-model', 0.4)],
              },
            ] },
            default_model: { value: 'shared-model' },
            auto_switch: { value: false },
            auto_switch_scope: { value: 'all' },
            fallback_on_unavailable: { value: true },
          },
          workspace: { auto_create_timestamp_workspace: { value: false } },
        }, null, 2));
        let primaryRequests = 0;
        let backupRequests = 0;
        let finalRequests = 0;
        let crossProviderRequests = 0;
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.includes('quota-other.invalid')) {
            crossProviderRequests += 1;
            throw new Error(`fallback crossed the provider boundary: ${url}`);
          }
          if (url.includes('quota-primary.invalid')) {
            const rawBody = String((init as RequestInit | undefined)?.body || '');
            const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
            if (body.stream !== true) {
              return new Response(JSON.stringify({ choices: [{ message: { content: `TITLE_OK_${round}` } }] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            const requestedModel = String(body.model || '');
            if (requestedModel === 'shared-model') {
              primaryRequests += 1;
              return new Response(JSON.stringify({ error: { message: 'insufficient_quota: credits exhausted' } }), {
                status: 402,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            if (requestedModel === 'shared-backup') {
              backupRequests += 1;
              return new Response(JSON.stringify({ error: { message: 'billing hard limit reached' } }), {
                status: 402,
                headers: { 'Content-Type': 'application/json' },
              });
            }
            if (requestedModel === 'shared-final') {
              finalRequests += 1;
              return new Response(JSON.stringify({ choices: [{ message: { content: `FINAL_OK_${round}` } }] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }
          throw new Error(`unexpected request URL during quota failover stress: ${url}`);
        }) as typeof fetch;
        const processAgent = new Agent(processRoot, { agentOnly: true, conversationId: `quota-process-${round}` });
        processAgent.setModel('deployment:quota-primary:shared-model');
        const fallbackEvents: Array<{ from: string; to: string; providerId?: string }> = [];
        const unsubscribeFallback = processAgent.subscribeWorkEvents(event => {
          if (event.fallback) fallbackEvents.push({ from: event.fallback.from, to: event.fallback.to, providerId: event.fallback.providerId });
        });
        let tokens;
        try {
          tokens = await processAgent.process(`quota failover round ${round}`);
        } catch (error) {
          unsubscribeFallback();
          throw new Error(`process round ${round} failed after requests primary=${primaryRequests} backup=${backupRequests} final=${finalRequests} crossProvider=${crossProviderRequests} active=${JSON.stringify(processAgent.activeDeployment())} blockedPrimary=${processAgent.isBalanceBlockedDeployment({ providerId: 'quota-primary', modelId: 'shared-model' })} blockedBackup=${processAgent.isBalanceBlockedDeployment({ providerId: 'quota-primary', modelId: 'shared-backup' })}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        }
        unsubscribeFallback();
        assert.ok(
          fallbackEvents.length >= 2 && fallbackEvents.every(item => item.providerId === 'quota-primary')
            && fallbackEvents[0].from === 'shared-model' && fallbackEvents[0].to === 'shared-backup'
            && fallbackEvents[fallbackEvents.length - 1].to === 'shared-final',
          `process round ${round} did not publish structured visible fallback events along the failover chain: ${JSON.stringify(fallbackEvents)}`,
        );
        const visible = tokens.map(token => token.text || '').join('');
        assert.equal(primaryRequests, 1, `process round ${round} retried the exhausted deployment`);
        assert.equal(backupRequests, 1, `process round ${round} retried the exhausted same-provider backup`);
        assert.equal(finalRequests, 1, `process round ${round} did not call the same-provider final backup exactly once`);
        assert.equal(crossProviderRequests, 0, `process round ${round} crossed the provider boundary while same-provider backups remained`);
        assert.equal(processAgent.activeDeployment()?.providerId, 'quota-primary', `process round ${round} left the failed provider`);
        assert.equal(processAgent.activeDeployment()?.modelId, 'shared-final', `process round ${round} did not reach the third same-provider model`);
        assert.equal(processAgent.isBalanceBlockedDeployment({ providerId: 'quota-primary', modelId: 'shared-model' }), true,
          `process round ${round} did not isolate the primary balance block`);
        assert.equal(processAgent.isBalanceBlockedDeployment({ providerId: 'quota-primary', modelId: 'shared-backup' }), true,
          `process round ${round} did not isolate the backup balance block`);
        assert.equal(processAgent.isBalanceBlockedDeployment({ providerId: 'quota-final', modelId: 'shared-model' }), false,
          `process round ${round} contaminated the healthy deployment`);
        assert.match(visible, new RegExp(`FINAL_OK_${round}`), `process round ${round} lost the final response`);
        assert.match(visible, /Model fallback/i, `process round ${round} omitted the visible fallback notice`);
        processFailovers += 1;
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log(`model recovery stress verification passed: edits=250 quotaRoutes=2000 nonQuotaGuards=500 fixedSwitch=1 chainedProcessFailovers=${processFailovers}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
