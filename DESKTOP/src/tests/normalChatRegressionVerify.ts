import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';
import { agentKernelRunnerInternals } from '../core/agentKernelRunner';
import type { StreamToken } from '../core/types';

function fixtureModel(name: string, options: { vision?: boolean; imageOutput?: boolean } = {}) {
  const vision = !!options.vision;
  const imageOutput = !!options.imageOutput;
  return {
    name,
    display: name,
    description: 'Normal chat fixture.',
    max_tokens: 128000,
    vision,
    image_output: imageOutput,
    thinking: false,
    speed_rating: 'fast',
    capability_rating: 'high',
    evaluation: { status: 'degraded' },
    validation: {
      level: 'standard',
      status: 'degraded',
      checked_at: new Date().toISOString(),
      capabilities: { text_input: true, text_output: true, tool_use: true, image_input: vision, image_output: imageOutput },
    },
    capabilities: ['text_input', 'text_output', 'tool_use', ...(vision ? ['image_input'] : []), ...(imageOutput ? ['image_output'] : [])],
  };
}

function writeConfig(root: string, providers: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: { value: providers },
      default_model: { value: '' },
      auto_switch: { value: false },
      fallback_on_unavailable: { value: false },
    },
    context: { auto_compress: { value: false } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-normal-chat-'));
  const errorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-normal-chat-error-'));
  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-normal-chat-fallback-'));
  try {
    const providers = [{
      id: 'provider-a',
      name: 'Provider A',
      base_url: 'https://provider-a.invalid/v1',
      api_key: 'fixture-a',
      protocol: 'openai',
      enabled: true,
      models: [fixtureModel('shared-model')],
    }, {
      id: 'provider-b',
      name: 'Provider B',
      base_url: 'https://provider-b.invalid/v1',
      api_key: 'fixture-b',
      protocol: 'anthropic',
      enabled: true,
      models: [fixtureModel('shared-model')],
    }];
    writeConfig(root, providers);
    const agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: 'normal-chat' });
    agent.workspace.current = null;
    agent.config.clearWorkspaceOverrides();
    assert.equal(agent.model, 'shared-model', 'empty default resolves a concrete model before renderer hydration');
    assert.deepEqual(agent.activeDeployment(), { providerId: 'provider-a', modelId: 'shared-model', logicalModelGroupId: undefined },
      'empty default resolves a stable provider-qualified deployment when model ids collide');
    assert.equal(agent.modelSelectionValue(), 'deployment:provider-a:shared-model', 'runtime handoff retains qualified deployment identity');

    const successProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 32 }),
      async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
        yield { type: 'text', text: 'NORMAL_CHAT_OK' };
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (agent as unknown as { forcedProvider: typeof successProvider }).forcedProvider = successProvider;
    const success = (await agent.process('你好')).map(token => token.text || '').join('');
    assert.ok(success.includes('NORMAL_CHAT_OK'), 'first normal prompt reaches the provider without a renderer model race');

    writeConfig(errorRoot, [providers[0]]);
    const errorAgent = new Agent(errorRoot, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: 'normal-chat-error' });
    errorAgent.workspace.current = null;
    errorAgent.config.clearWorkspaceOverrides();
    const emptyErrorProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 32 }),
      async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
        yield await Promise.reject<StreamToken>(new Error(''));
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (errorAgent as unknown as { forcedProvider: typeof emptyErrorProvider }).forcedProvider = emptyErrorProvider;
    const eventTypes: string[] = [];
    const errorContents: string[] = [];
    errorAgent.subscribeWorkEvents(event => {
      eventTypes.push(event.type);
      if (event.type === 'error') errorContents.push(event.content);
    });
    await assert.rejects(
      () => errorAgent.process('你好'),
      /Provider request failed without diagnostic details/,
      'empty provider exceptions become non-empty typed run failures',
    );
    assert.ok(eventTypes.includes('error') && !eventTypes.includes('done'), 'provider failure is not marked Response complete');
    assert.ok(errorContents.every(content => content.trim().length > 0), 'public failure events always contain a diagnostic');
    assert.ok(!errorAgent.chatMessages.some(message => message.role === 'assistant' && message.content.trim() === '[Error]'),
      'bare provider errors are never persisted as successful assistant messages');

    assert.equal(agentKernelRunnerInternals.normalizePublicProviderError(new Error('')), 'Provider request failed without diagnostic details.');
    assert.equal(agentKernelRunnerInternals.normalizePublicProviderError(new Error('<think>hidden</think>')), 'Provider request failed without diagnostic details.');
    const redacted = agentKernelRunnerInternals.normalizePublicProviderError(new Error('Authorization: Bearer secret-token-value'));
    assert.ok(redacted.includes('[redacted]') && !redacted.includes('secret-token-value'), 'provider diagnostics redact credentials');
    const providerSecret = 'literal-provider-secret-20260716';
    const sensitiveDiagnostics = [
      'https://gateway.invalid/v1?key=query-secret-20260716&mode=test',
      '{"apiKey":"json-secret-20260716","error":"denied"}',
      'x-goog-api-key: header-secret-20260716',
      `request failed with credential ${providerSecret}`,
      `https://gateway.invalid/v1?token=${encodeURIComponent(providerSecret)}`,
    ];
    for (const diagnostic of sensitiveDiagnostics) {
      const safe = agentKernelRunnerInternals.normalizePublicProviderError(new Error(diagnostic), [providerSecret]);
      assert.ok(safe.includes('[redacted]'), `provider diagnostic was not redacted: ${diagnostic}`);
      assert.ok(!safe.includes('query-secret-20260716')
        && !safe.includes('json-secret-20260716')
        && !safe.includes('header-secret-20260716')
        && !safe.includes(providerSecret)
        && !safe.includes(encodeURIComponent(providerSecret)),
      `provider diagnostic leaked a credential: ${safe}`);
    }

    fs.writeFileSync(path.join(fallbackRoot, 'config.json'), JSON.stringify({
      models: {
        providers: { value: [{
          id: 'fallback-provider',
          name: 'Fallback Provider',
          base_url: 'https://fallback.invalid/v1',
          api_key: 'fixture-fallback',
          protocol: 'openai',
          enabled: true,
          models: [
            fixtureModel('primary-vision', { vision: true, imageOutput: true }),
            fixtureModel('fallback-text'),
          ],
        }] },
        default_model: { value: 'primary-vision' },
        auto_switch: { value: false },
        fallback_on_unavailable: { value: true },
      },
      context: { auto_compress: { value: false } },
      workspace: { auto_create_timestamp_workspace: { value: false } },
    }, null, 2), 'utf-8');
    const fallbackAgent = new Agent(fallbackRoot, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: 'normal-chat-fallback' });
    fallbackAgent.workspace.current = null;
    fallbackAgent.config.clearWorkspaceOverrides();
    const fallbackCalls: Array<{ model: string; messages: Array<Record<string, unknown>>; tools: Array<Record<string, any>> }> = [];
    const fallbackProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 32 }),
      async *chatStreamWithTools(
        model: string,
        messages: Array<Record<string, unknown>>,
        _system: string,
        _temperature: number,
        _maxTokens: number,
        tools: Array<Record<string, any>>,
      ): AsyncGenerator<StreamToken> {
        fallbackCalls.push({ model, messages, tools });
        if (model === 'primary-vision') {
          yield { type: 'text', text: '[LLM Error: 503] primary unavailable' };
          return;
        }
        yield { type: 'text', text: 'FALLBACK_CONTEXT_OK' };
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (fallbackAgent as unknown as { forcedProvider: typeof fallbackProvider }).forcedProvider = fallbackProvider;
    const fallbackOutput = (await fallbackAgent.process('你好')).map(token => token.text || '').join('');
    const finalFallbackCall = fallbackCalls.find(call => call.model === 'fallback-text');
    assert.ok(finalFallbackCall && fallbackOutput.includes('FALLBACK_CONTEXT_OK'), 'fallback executor reaches the replacement deployment');
    assert.ok(!JSON.stringify(finalFallbackCall?.messages || []).includes('primary unavailable'),
      'fallback removes the failed assistant tail before replaying provider context');
    const fallbackBroker = finalFallbackCall?.tools.find(tool => tool.function?.name === 'tool_provision');
    assert.ok(fallbackBroker
      && !String(fallbackBroker.function.description).includes('image_generate:')
      && !String(fallbackBroker.function.description).includes('image_inspect:'),
    'fallback rebuilds the compact tool catalog for replacement-model capabilities');

    fallbackAgent.setModel('primary-vision');
    assert.equal(fallbackAgent.switchToFallbackModel('HTTP 401 Unauthorized'), null, 'fixed fallback never crosses an authentication failure');
    assert.equal(fallbackAgent.model, 'primary-vision');
    assert.equal(fallbackAgent.switchToFallbackModel('content policy refusal'), null, 'fixed fallback never bypasses a content-policy refusal');
    assert.equal(fallbackAgent.model, 'primary-vision');
    fallbackAgent.markRouteStreamCommitted();
    assert.equal(fallbackAgent.switchToFallbackModel('HTTP 503 server error'), null, 'fixed fallback is blocked after public output commits');
    assert.equal(fallbackAgent.model, 'primary-vision');
    fallbackAgent.setModel('primary-vision');
    fallbackAgent.markRouteToolExecuted('write', '{"path":"side-effect.txt","content":"x"}');
    assert.equal(fallbackAgent.switchToFallbackModel('HTTP 503 server error'), null, 'fixed fallback is blocked after a side-effect tool boundary');
    assert.equal(fallbackAgent.model, 'primary-vision');
    fallbackAgent.setModel('primary-vision');
    assert.equal(fallbackAgent.switchToFallbackModel('HTTP 503 server error'), 'primary-vision', 'fixed fallback remains available for retryable uncommitted transport failures');
    assert.equal(fallbackAgent.model, 'fallback-text');

    fallbackAgent.setModel('primary-vision');
    const refusalProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 32 }),
      async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
        yield { type: 'text', text: '[LLM Error: content policy refusal]' };
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (fallbackAgent as unknown as { forcedProvider: typeof refusalProvider }).forcedProvider = refusalProvider;
    await assert.rejects(() => fallbackAgent.process('refusal fixture'), /content policy refusal/i,
      'kernel execution surfaces a fixed-model policy refusal instead of switching providers');
    assert.equal(fallbackAgent.model, 'primary-vision', 'fixed model identity remains pinned after a policy refusal');

    console.log('PASS: empty default model resolves before the first normal prompt');
    console.log('PASS: provider failures remain non-empty and finish as errors');
    console.log('PASS: provider fallback refreshes context and model-specific tool capabilities');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(errorRoot, { recursive: true, force: true });
    fs.rmSync(fallbackRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
