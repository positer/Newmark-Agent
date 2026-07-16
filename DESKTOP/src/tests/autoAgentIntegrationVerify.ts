import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';
import { agentKernelRunnerInternals, toolResultObjectiveOutcome } from '../core/agentKernelRunner';
import { LLMProvider } from '../llm/provider';

let assertions = 0;
function ok(value: unknown, message: string): void {
  assert.ok(value, message);
  assertions += 1;
  console.log(`PASS: ${message}`);
}

function model(name: string, cost: number, logicalModelGroupId?: string, toolUse = true) {
  return {
    name,
    display: name,
    description: '',
    cost_per_1k_input: cost,
    cost_per_1k_output: cost,
    max_tokens: 128000,
    vision: true,
    thinking: false,
    image_output: false,
    speed_rating: 'fast',
    capability_rating: 'high',
    logical_model_group_id: logicalModelGroupId,
    capabilities: ['text_input', 'text_output', 'image_input', ...(toolUse ? ['tool_use'] : []), 'json_schema'],
    validation: {
      level: 'standard',
      status: 'verified',
      checked_at: new Date().toISOString(),
      capabilities: { text_input: true, text_output: true, image_input: true, ...(toolUse ? { tool_use: true } : {}), json_schema: true },
    },
    intelligence_tiers: { low: { description: 'Quick' }, medium: { description: 'Balanced' }, high: { description: 'Deep' } },
  };
}

async function main(): Promise<void> {
  const splitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-auto-tool-split-'));
  try {
    fs.writeFileSync(path.join(splitRoot, 'config.json'), JSON.stringify({
      models: {
        providers: { value: [
          { id: 'chat-provider', name: 'Chat', base_url: 'https://chat.invalid/v1', api_key: 'chat-key', protocol: 'openai', enabled: true, models: [model('chat-only', 0.01, undefined, false)] },
          { id: 'tool-provider', name: 'Tool', base_url: 'https://tool.invalid/v1', api_key: 'tool-key', protocol: 'openai', enabled: true, models: [model('tool-capable', 10)] },
        ] },
        default_model: { value: 'tool-capable' },
        auto_switch: { value: true },
        auto_switch_preference: { value: 'cost' },
        auto_switch_scope: { value: 'all' },
        auto_switch_anchor_provider: { value: 'tool-provider' },
        fallback_on_unavailable: { value: true },
      },
      workspace: { auto_create_timestamp_workspace: { value: false } },
    }, null, 2));
    const splitAgent = new Agent(splitRoot, { agentOnly: true, conversationId: 'auto-tool-split' });
    splitAgent.setModel('auto');

    await splitAgent.evaluateAndSwitch('你好');
    ok(splitAgent.activeDeployment()?.modelId === 'chat-only'
      && splitAgent.lastRouteDecision?.taskClasses.length === 1
      && splitAgent.lastRouteDecision.taskClasses[0] === 'chat',
    'ordinary chat remains taskClass=chat and can select a Standard model without verified tool_use');
    const noToolSurface = agentKernelRunnerInternals.routeToolSurface(splitAgent, [{ name: 'read', parameters: { type: 'object' } }]);
    ok(noToolSurface.definitions.length === 0
      && noToolSurface.systemPromptNotice.includes('No tool interface is available for this turn'),
    'Auto chat routes without verified tool_use send no tool schemas and explicitly disclose the no-tool turn');

    splitAgent.resetAutoRoute();
    await splitAgent.evaluateAndSwitch('Call a tool to inspect the workspace');
    ok(splitAgent.activeDeployment()?.modelId === 'tool-capable'
      && splitAgent.lastRouteDecision?.taskClasses.includes('tool_use')
      && splitAgent.lastRouteDecision.excludedCandidates.some(candidate => candidate.deployment.modelId === 'chat-only'
        && candidate.reasons.some(reason => reason.includes('capability:tool_use'))),
    'an explicit tool request hard-filters candidates without verified tool_use');
    splitAgent.history.push({ role: 'user', content: 'Call a tool to inspect the workspace' });
    const toolSurface = agentKernelRunnerInternals.routeToolSurface(splitAgent, [{ name: 'read', parameters: { type: 'object' } }]);
    ok(toolSurface.definitions.length === 1 && !toolSurface.systemPromptNotice,
      'a tool-capable Auto route preloads the task-relevant schema');
    splitAgent.history.pop();

    splitAgent.resetAutoRoute();
    await splitAgent.evaluateAndSwitch('Implement a fix for this repository bug');
    ok(splitAgent.activeDeployment()?.modelId === 'tool-capable'
      && splitAgent.lastRouteDecision?.taskClasses.includes('coding'),
    'actionable coding tasks require a verified tool interface while retaining coding-domain quality');

    splitAgent.setModel('chat-only');
    const fixedCompatibilitySurface = agentKernelRunnerInternals.routeToolSurface(splitAgent, [{ name: 'read', parameters: { type: 'object' } }]);
    ok(fixedCompatibilitySurface.definitions.length === 0
      && fixedCompatibilitySurface.systemPromptNotice.includes('tool_provision'),
    'fixed model selections also start from the on-demand broker instead of the legacy full schema surface');
  } finally {
    fs.rmSync(splitRoot, { recursive: true, force: true });
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-auto-agent-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      models: {
        providers: { value: [
          { id: 'provider-openai', name: 'OpenAI-side', base_url: 'https://openai-side.invalid/v1', api_key: 'openai-key', protocol: 'openai', enabled: true, models: [model('same-name', 10, 'logical-same')] },
          { id: 'provider-anthropic', name: 'Anthropic-side', base_url: 'https://anthropic-side.invalid/v1', api_key: 'anthropic-key', protocol: 'anthropic', enabled: true, models: [model('same-name', 0.1, 'logical-same')] },
        ] },
        default_model: { value: 'same-name' },
        auto_switch: { value: true },
        auto_switch_preference: { value: 'balanced' },
        auto_switch_scope: { value: 'all' },
        auto_switch_anchor_provider: { value: 'provider-openai' },
        fallback_on_unavailable: { value: true },
      },
      workspace: { auto_create_timestamp_workspace: { value: false } },
    }, null, 2));
    const agent = new Agent(root, { agentOnly: true, conversationId: 'auto-integration' });
    agent.setModel('auto');
    const routed = await agent.evaluateAndSwitch('Use a validated tool to inspect this image attachment');
    ok(routed, 'agent Auto resolves an eligible deployment');
    ok(agent.model === 'auto', 'agent preserves Auto as the selection intent after routing');
    ok(agent.activeDeployment()?.providerId === 'provider-anthropic', 'global Auto selects by deployment identity instead of bare model name');
    const provider = agent.engineModel();
    ok(provider?.baseUrl === 'https://anthropic-side.invalid/v1'
      && provider.apiKey === 'anthropic-key'
      && provider.explicitProtocol === 'anthropic',
    'engine resolves URL, credential and protocol from the selected deployment on every attempt');

    await agent.evaluateAndSwitch('Continue the next user turn');
    ok(agent.model === 'auto' && agent.lastRouteDecision?.requestedSelection.kind === 'auto',
      'Auto remains active across consecutive user turns');

    agent.config.set('models', 'auto_switch_scope', 'provider');
    agent.config.set('models', 'auto_switch_anchor_provider', 'provider-openai');
    agent.resetAutoRoute();
    await agent.evaluateAndSwitch('Provider-scoped request');
    ok(agent.activeDeployment()?.providerId === 'provider-openai', 'provider Auto cannot escape its provider scope');

    agent.beginRouteAttempt();
    agent.recordRouteSuccess(24, 48);
    ok(agent.lastRouteDecision?.finalStatus === 'succeeded'
      && agent.lastRouteDecision.attempts.at(-1)?.status === 'success'
      && agent.lastRouteDecision.attempts.at(-1)?.durationMs === 24,
    'successful execution updates the actual route attempt and final audit status');

    agent.resetAutoRoute();
    await agent.evaluateAndSwitch('Provider-scoped authentication check');
    agent.beginRouteAttempt();
    agent.switchToFallbackModel('[LLM Error: 401] Unauthorized');
    ok(agent.lastRouteDecision?.finalStatus === 'blocked'
      && agent.lastRouteDecision.attempts.at(-1)?.status === 'failed'
      && agent.lastRouteDecision.attempts.at(-1)?.errorType === 'auth',
    'authentication failures mark the actual attempt failed and the non-switchable route blocked');
    agent.resetAutoRoute();
    await agent.evaluateAndSwitch('Authentication circuit remains open');
    ok(agent.activeDeployment() === null,
      'authentication failures keep the deployment circuit open until provider configuration changes');

    const changedProviders = JSON.parse(JSON.stringify(agent.config.providers())) as Array<Record<string, unknown>>;
    const changedOpenAI = changedProviders.find(item => item.id === 'provider-openai');
    if (changedOpenAI) changedOpenAI.api_key = 'rotated-openai-key';
    agent.updateProviders(changedProviders);
    await agent.evaluateAndSwitch('Provider configuration changed');
    ok(agent.activeDeployment()?.providerId === 'provider-openai',
      'Agent.updateProviders clears an authentication circuit after credentials change');

    agent.config.set('models', 'fallback_on_unavailable', false);
    agent.resetAutoRoute();
    await agent.evaluateAndSwitch('Failure audit without fallback');
    agent.beginRouteAttempt();
    agent.switchToFallbackModel('[LLM Error: 503] upstream unavailable');
    ok(agent.lastRouteDecision?.finalStatus === 'failed'
      && agent.lastRouteDecision.attempts.at(-1)?.status === 'failed'
      && agent.lastRouteDecision.attempts.at(-1)?.errorType === 'server_error',
    'retryable execution failure is persisted as a failed attempt and failed final status when fallback is disabled');
    agent.config.set('models', 'fallback_on_unavailable', true);

    const auditPath = path.join(root, 'routing', 'route-decisions.jsonl');
    const audit = fs.readFileSync(auditPath, 'utf-8');
    ok(audit.includes('catalogSnapshotHash') && !audit.includes('Provider-scoped request') && !audit.includes('openai-key'),
      'route audit records decisions without prompts or credentials');
    const runnerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agentKernelRunner.ts'), 'utf-8');
    ok(runnerSource.includes('if (!finalContent.length)') && runnerSource.includes('[Error] Provider returned an empty response.'),
      'empty provider responses enter retry/fallback classification instead of recording route success');
    const providerStreamSource = runnerSource.slice(
      runnerSource.indexOf('function streamWithNewmarkProvider'),
      runnerSource.indexOf('async function transformContext'),
    );
    const transformSource = runnerSource.slice(
      runnerSource.indexOf('async function transformContext'),
      runnerSource.indexOf('async function shouldStopAfterTurn'),
    );
    ok(providerStreamSource.includes('const currentProvider = currentAgent.engineModel()')
      && providerStreamSource.includes('currentProvider.intelligenceConfig(currentAgent.intelligence)')
      && /const provider(?:\s*:\s*LLMProvider\s*\|\s*null)?\s*=\s*agent\.engineModel\(\)/.test(transformSource)
      && !runnerSource.includes('transformContext(agent, provider,'),
    'provider streaming and context compression re-resolve the active deployment instead of capturing the initial provider');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const fixedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-fixed-fallback-'));
  try {
    fs.writeFileSync(path.join(fixedRoot, 'config.json'), JSON.stringify({
      models: {
        providers: { value: [
          { id: 'fixed-primary-provider', name: 'Primary', base_url: 'https://primary.invalid/v1', api_key: 'primary-key', protocol: 'openai', enabled: true, models: [model('fixed-primary', 10)] },
          { id: 'fixed-backup-provider', name: 'Backup', base_url: 'https://backup.invalid/v1', api_key: 'backup-key', protocol: 'anthropic', enabled: true, models: [model('fixed-backup', 0.1)] },
        ] },
        default_model: { value: 'fixed-primary' },
        auto_switch: { value: false },
        auto_switch_scope: { value: 'all' },
        auto_switch_preference: { value: 'balanced' },
        fallback_on_unavailable: { value: true },
      },
      workspace: { auto_create_timestamp_workspace: { value: false } },
    }, null, 2));
    const fixedAgent = new Agent(fixedRoot, { agentOnly: true, conversationId: 'fixed-fallback' });
    fixedAgent.setModel('fixed-primary');
    const previous = fixedAgent.switchToFallbackModel('[LLM Error: 503] upstream unavailable');
    ok(previous === 'fixed-primary'
      && fixedAgent.model === 'fixed-backup'
      && fixedAgent.activeDeployment()?.providerId === 'fixed-backup-provider'
      && fixedAgent.activeDeployment()?.modelId === 'fixed-backup',
    'fixed-model fallback updates both the displayed model and active deployment identity');
  } finally {
    fs.rmSync(fixedRoot, { recursive: true, force: true });
  }

  ok(toolResultObjectiveOutcome('{"ok":true}') === undefined
    && toolResultObjectiveOutcome('{"postcondition":true}') === true
    && toolResultObjectiveOutcome('{"test_result":{"passed":false}}') === false
    && toolResultObjectiveOutcome('{"objective_evidence":true,"ok":true}') === true,
  'objective quality accepts explicit postcondition/test evidence but ignores ordinary JSON ok fields');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '10', 'Content-Type': 'text/plain' },
    })) as typeof fetch;
    const provider = new LLMProvider('Retry Provider', 'https://retry-provider.invalid/v1', 'test-key', 'openai', 'chat');
    let retryError = '';
    try {
      await provider.chat('retry-model', [{ role: 'user', content: 'test' }], null, 0, 16);
    } catch (error) {
      retryError = error instanceof Error ? error.message : String(error);
    }
    ok(retryError.includes('[LLM Error: 429] Retry-After: 10s'),
      'HTTPS fetch-style 429 responses propagate Retry-After into route failure classification');
  } finally {
    globalThis.fetch = originalFetch;
  }

  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: '' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const provider = new LLMProvider('Policy Provider', 'https://policy-provider.invalid/v1', 'test-key', 'openai', 'chat');
    const tokens: string[] = [];
    for await (const token of provider.chatStreamWithTools('policy-model', [{ role: 'user', content: 'test' }], '', 0, 16, [])) {
      if (token.text) tokens.push(token.text);
    }
    ok(tokens.join('').includes('Content policy refusal (content_filter)'),
      'provider content-filter finish reasons are classified explicitly instead of masquerading as retryable empty responses');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(`auto agent integration verification passed (${assertions} assertions)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
