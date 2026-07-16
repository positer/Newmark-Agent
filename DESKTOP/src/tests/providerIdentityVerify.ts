import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';
import { AutoRouteCandidate, AutoRouter, defaultRoutePolicy } from '../core/autoRouter';
import { ConfigManager, mergeProviderSecrets, ProviderConfig, stableProviderId } from '../core/config';

type Check = { ok: boolean; label: string };

function check(value: boolean, label: string, checks: Check[]): void {
  checks.push({ ok: value, label });
  console.log(`${value ? 'PASS' : 'FAIL'}: ${label}`);
}

function rawProvider(
  name: string,
  apiKey: string,
  id?: string,
  baseUrl = 'HTTPS://gateway.example.test/v1/',
  protocol: 'openai' | 'anthropic' = 'openai',
): Record<string, unknown> {
  return {
    ...(id === undefined ? {} : { id }),
    name,
    base_url: baseUrl,
    api_key: apiKey,
    protocol,
    enabled: true,
    models: [{
      name: 'shared-model',
      validation: {
        level: 'standard',
        status: 'verified',
        checked_at: '2026-07-15T00:00:00.000Z',
        capabilities: { text_input: true, text_output: true },
      },
    }],
  };
}

function routeCandidate(provider: ProviderConfig): AutoRouteCandidate {
  return {
    deployment: { providerId: provider.id, modelId: 'shared-model' },
    enabled: true,
    validation: {
      level: 'standard',
      status: 'verified',
      checkedAt: '2026-07-15T00:00:00.000Z',
    },
    capabilities: ['text_input', 'text_output'],
    maxContextTokens: 128_000,
    preview: false,
    privacy: ['default'],
    expectedInputCostUsdPerM: 1,
    expectedOutputCostUsdPerM: 4,
    latencyMs: 1_000,
    reliability: 0.95,
    qualityByTask: { chat: { successes: 8, attempts: 10 } },
  };
}

export async function verifyProviderIdentity(): Promise<Check[]> {
  const checks: Check[] = [];
  const normalized = stableProviderId('  Account Alpha  ', 'HTTPS://gateway.example.test/v1/', 'openai');
  const normalizedRepeat = stableProviderId('account   alpha', 'https://GATEWAY.example.test/v1', 'openai');
  const otherAccount = stableProviderId('Account Beta', 'https://gateway.example.test/v1', 'openai');
  check(normalized === normalizedRepeat && normalized !== otherAccount,
    'provider identity includes normalized account name plus endpoint and protocol', checks);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-provider-identity-'));
  try {
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      models: {
        providers: {
          value: [
            rawProvider('Account Alpha', 'alpha-key'),
            rawProvider('Account Beta', 'beta-key'),
            rawProvider('Explicit Account', 'explicit-key', 'provider-explicit'),
            rawProvider('Duplicate Account', 'duplicate-key', 'provider-explicit'),
          ],
        },
      },
    }, null, 2));

    const config = new ConfigManager(root);
    const providers = config.providers();
    const ids = providers.map(provider => provider.id);
    check(providers.length === 4 && new Set(ids).size === providers.length
      && ids[0] !== ids[1]
      && ids[2] === 'provider-explicit'
      && ids[3] !== 'provider-explicit',
    'load migration preserves a unique explicit id and deterministically repairs missing or duplicate ids', checks);

    const alpha = config.findDeployment({ providerId: ids[0], modelId: 'shared-model' });
    const beta = config.findDeployment({ providerId: ids[1], modelId: 'shared-model' });
    check(alpha?.provider === 'Account Alpha' && alpha.api_key === 'alpha-key'
      && beta?.provider === 'Account Beta' && beta.api_key === 'beta-key'
      && alpha.provider_id !== beta.provider_id
      && alpha.provider_url === beta.provider_url
      && alpha.provider_protocol === beta.provider_protocol,
    'deployment lookup isolates equal model ids on two accounts sharing one gateway and protocol', checks);

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      models: { providers: { value: Array<{ id?: string }> } };
    };
    const persistedIds = persisted.models.providers.value.map(provider => provider.id || '');
    const reloadedIds = new ConfigManager(root).providers().map(provider => provider.id);
    check(JSON.stringify(persistedIds) === JSON.stringify(ids)
      && JSON.stringify(reloadedIds) === JSON.stringify(ids),
    'load migration persists provider ids and remains stable after reload', checks);

    const router = new AutoRouter({ now: () => Date.parse('2026-07-15T00:00:00.000Z') });
    const scoped = router.route(
      { kind: 'auto', scope: { kind: 'provider', providerId: ids[1] }, policyId: 'balanced' },
      defaultRoutePolicy('balanced'),
      providers.slice(0, 2).map(routeCandidate),
      {
        transactionId: 'provider-scope-turn',
        affinityKey: 'provider-scope-conversation',
        taskText: 'Explain this result',
        estimatedInputTokens: 100,
        expectedOutputTokens: 100,
        requiredCapabilities: ['text_input', 'text_output'],
      },
    );
    check(scoped.resolvedDeployment?.providerId === ids[1]
      && scoped.resolvedDeployment.modelId === 'shared-model'
      && scoped.excludedCandidates.some(item => item.deployment.providerId === ids[0]
        && item.reasons.includes('outside_scope')),
    'provider-scoped Auto cannot cross to a same-url same-protocol account', checks);

    config.set('models', 'providers', [
      rawProvider('Set Account One', 'one-key', 'provider-set-explicit'),
      rawProvider('Set Account Two', 'two-key', 'provider-set-explicit'),
    ]);
    const setIds = config.providers().map(provider => provider.id);
    config.save();
    const setReloadedIds = new ConfigManager(root).providers().map(provider => provider.id);
    check(setIds[0] === 'provider-set-explicit'
      && setIds[1] !== setIds[0]
      && JSON.stringify(setReloadedIds) === JSON.stringify(setIds),
    'set(models.providers) resolves duplicate ids before save and persists the repaired catalog', checks);

    const collisionProviders = [
      rawProvider('Shared Account', 'alpha-secret', 'provider-alpha', 'https://alpha.example.test/v1', 'openai'),
      rawProvider('Shared Account', 'beta-secret', 'provider-beta', 'https://beta.example.test/anthropic', 'anthropic'),
      rawProvider('Legacy Unique', 'legacy-secret', 'provider-legacy', 'https://legacy.example.test/v1', 'openai'),
    ] as unknown as ProviderConfig[];
    const merged = mergeProviderSecrets([
      { ...collisionProviders[1], api_key: '' },
      { ...collisionProviders[0], api_key: '' },
      { name: 'Shared Account', base_url: 'https://unidentified.example.test/v1', api_key: '', protocol: 'openai', models: [] },
      { name: 'Legacy Unique', base_url: 'https://legacy.example.test/v1', api_key: '', protocol: 'openai', models: [] },
      { id: 'provider-not-found', name: 'Legacy Unique', base_url: 'https://legacy.example.test/v1', api_key: '', protocol: 'openai', models: [] },
    ], collisionProviders) as Array<Record<string, unknown>>;
    check(merged[0].api_key === 'beta-secret'
      && merged[1].api_key === 'alpha-secret'
      && merged[2].api_key === ''
      && merged[3].api_key === 'legacy-secret'
      && merged[4].api_key === '',
    'secret merge uses provider id first and only falls back to a unique legacy display name', checks);

    const duplicateIdentityMerge = mergeProviderSecrets([
      { ...collisionProviders[0], base_url: 'https://attacker.example.test/v1', api_key: '' },
      { ...collisionProviders[0], api_key: '' },
    ], collisionProviders) as Array<Record<string, unknown>>;
    check(duplicateIdentityMerge.every(provider => provider.api_key === ''),
      'secret merge rejects duplicate incoming provider ids instead of assigning one account key by list order', checks);

    config.set('models', 'providers', collisionProviders);
    const betaUpdated = config.updateModelByDeployment('provider-beta', 'shared-model', { description: 'beta-only-write' });
    const ambiguousUpdate = config.updateModel('Shared Account', 'shared-model', { description: 'must-not-write' });
    const alphaAfterUpdate = config.findDeployment({ providerId: 'provider-alpha', modelId: 'shared-model' });
    const betaAfterUpdate = config.findDeployment({ providerId: 'provider-beta', modelId: 'shared-model' });
    check(betaUpdated && !ambiguousUpdate
      && alphaAfterUpdate?.description !== 'beta-only-write'
      && alphaAfterUpdate?.description !== 'must-not-write'
      && betaAfterUpdate?.description === 'beta-only-write',
    'model writes target providerId plus modelId and reject ambiguous display-name fallback', checks);

    const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-provider-validation-identity-'));
    try {
      fs.writeFileSync(path.join(validationRoot, 'config.json'), JSON.stringify({
        models: {
          providers: { value: [
            rawProvider('Shared Account', '', 'provider-alpha', 'https://alpha.invalid/v1', 'openai'),
            rawProvider('Shared Account', '', 'provider-beta', 'https://beta.invalid/anthropic', 'anthropic'),
          ] },
          default_model: { value: 'shared-model' },
          auto_switch: { value: false },
        },
        workspace: { auto_create_timestamp_workspace: { value: false } },
      }, null, 2));
      const validationAgent = new Agent(validationRoot, { agentOnly: true });
      const selected = await validationAgent.validateModels([
        `deployment:${encodeURIComponent('provider-beta')}:${encodeURIComponent('shared-model')}`,
      ]);
      const alphaAfterValidation = validationAgent.config.findDeployment({ providerId: 'provider-alpha', modelId: 'shared-model' });
      const betaAfterValidation = validationAgent.config.findDeployment({ providerId: 'provider-beta', modelId: 'shared-model' });
      const ambiguousLegacy = await validationAgent.validateModels(['Shared Account/shared-model']);
      check(selected.length === 1
        && selected[0].provider_id === 'provider-beta'
        && alphaAfterValidation?.validation?.status === 'verified'
        && betaAfterValidation?.validation?.status === 'invalid_config'
        && ambiguousLegacy.length === 0,
      'selected validation resolves providerId plus modelId and never writes through an ambiguous provider name', checks);
    } finally {
      fs.rmSync(validationRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return checks;
}

if (require.main === module) {
  verifyProviderIdentity().then(checks => {
    const failed = checks.filter(item => !item.ok);
    console.log(`\nProvider identity verification: ${checks.length - failed.length}/${checks.length} passed`);
    if (failed.length > 0) process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
