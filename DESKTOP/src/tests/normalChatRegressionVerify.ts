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

    const successCalls: Array<{ messages: Array<Record<string, unknown>>; system: string }> = [];
    const successProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 32 }),
      async *chatStreamWithTools(_model: string, messages: Array<Record<string, unknown>>, system: string): AsyncGenerator<StreamToken> {
        successCalls.push({ messages: messages.map(message => ({ ...message })), system });
        yield { type: 'text', text: 'NORMAL_CHAT_OK' };
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (agent as unknown as { forcedProvider: typeof successProvider }).forcedProvider = successProvider;
    const success = (await agent.process('你好')).map(token => token.text || '').join('');
    assert.ok(success.includes('NORMAL_CHAT_OK'), 'first normal prompt reaches the provider without a renderer model race');
    await agent.process('第二轮');
    assert.deepEqual(successCalls[1]?.messages.map(message => message.role), ['user', 'assistant', 'user'],
      'the second provider request receives prior user and assistant history before the new prompt');
    assert.ok(JSON.stringify(successCalls[1]?.messages).includes('你好') && JSON.stringify(successCalls[1]?.messages).includes('NORMAL_CHAT_OK'),
      'the second provider payload contains the previous turn content');
    assert.ok(successCalls[1]?.system.includes('## Request-Scoped Task Focus')
      && successCalls[1]?.system.includes('strict newest-to-oldest order')
      && successCalls[1]?.system.includes('finish the newest unfinished task first, then the next-newest')
      && successCalls[1]?.system.includes('do not revive completed, superseded, abandoned, or unrelated historical tasks'),
    'each provider turn prioritizes the latest instruction and resumes relevant unfinished history newest-to-oldest');
    assert.ok(!successCalls[1]?.system.includes('第二轮')
      && String(successCalls[1]?.messages.at(-1)?.content || '').includes('第二轮'),
    'request focus preserves the current instruction in its original user role instead of elevating user-authored text into the system prompt');
    assert.ok(!JSON.stringify(agent.history).includes('Request-Scoped Task Focus'), 'request-scoped focus is never persisted into conversation history');
    assert.ok(successCalls[0]?.system.includes('## Build Context Bootstrap')
      && successCalls[0]?.system.includes('Injection reason: this is the first provider request of a new Build.')
      && successCalls[0]?.system.includes('Historical Build Blocks (newest to oldest; #1 is the previous/last task):')
      && successCalls[0]?.system.includes('## Tool Awareness Bootstrap')
      && successCalls[0]?.system.includes('Necessary full schemas supplied natively for this provider turn:'),
    'a new Build receives one request-only context, recent-Build, and tool-awareness bootstrap');
    assert.ok(!JSON.stringify(agent.history).includes('Build Context Bootstrap')
      && !JSON.stringify(agent.chatMessages).includes('Tool Awareness Bootstrap'),
    'Build bootstrap metadata is never persisted into conversation history or visible chat');

    agent.conversationPlan = {
      items: [
        { id: 'done', text: 'Retired migration', status: 'done' },
        { id: 'active', text: 'Run the unfinished provider regression', status: 'in_progress' },
      ],
    };
    await agent.process('继续完成还没有完成的工作');
    const continuationFocus = successCalls.at(-1)?.system || '';
    assert.ok(!continuationFocus.includes('继续完成还没有完成的工作')
      && continuationFocus.includes('1 unfinished plan item(s): 1 in progress and 0 pending')
      && !continuationFocus.includes('Retired migration'),
    'continuation focus retains explicit unfinished plan state while excluding completed plan items');
    assert.ok(String(successCalls.at(-1)?.messages.at(-1)?.content || '').includes('继续完成还没有完成的工作'),
      'continuation instruction remains the final real user message in provider context');

    agent.workRuns = [{
      runId: 'run-old-completed',
      target: { workspaceId: 'fixture', conversationId: 'normal-chat' },
      runtimeKey: 'fixture::normal-chat',
      status: 'completed',
      startedAt: '2026-07-18T08:00:00.000Z',
      endedAt: '2026-07-18T08:20:00.000Z',
      expanded: true,
      sequence: 1,
      events: [{ id: 'old-final', conversationId: 'normal-chat', type: 'final_response', content: '旧版发布检查已完成。', mode: 'build', model: 'shared-model', timestamp: '2026-07-18T08:20:00.000Z', runId: 'run-old-completed', sequence: 1 }],
      guides: [],
      primaryPrompt: '完成旧版发布检查',
    }, {
      runId: 'run-unrelated-interrupted',
      target: { workspaceId: 'fixture', conversationId: 'normal-chat' },
      runtimeKey: 'fixture::normal-chat',
      status: 'interrupted',
      startedAt: '2026-07-19T08:00:00.000Z',
      endedAt: '2026-07-19T08:10:00.000Z',
      expanded: true,
      sequence: 2,
      events: [{ id: 'unrelated-tool', conversationId: 'normal-chat', type: 'tool_result', content: '旧错误定位到 legacy.ts。', mode: 'build', model: 'shared-model', timestamp: '2026-07-19T08:05:00.000Z', runId: 'run-unrelated-interrupted', sequence: 1, toolName: 'grep', toolCallId: 'old-call' }],
      guides: [],
      primaryPrompt: '修复一个与当前问题无关的旧错误',
    }, {
      runId: 'run-previous-completed',
      target: { workspaceId: 'fixture', conversationId: 'normal-chat' },
      runtimeKey: 'fixture::normal-chat',
      status: 'completed',
      startedAt: '2026-07-20T08:00:00.000Z',
      endedAt: '2026-07-20T09:00:00.000Z',
      expanded: true,
      sequence: 3,
      events: [{ id: 'previous-tool', conversationId: 'normal-chat', type: 'tool_result', content: '完整测试通过。', mode: 'build', model: 'shared-model', timestamp: '2026-07-20T08:50:00.000Z', runId: 'run-previous-completed', sequence: 1, toolName: 'bash', toolCallId: 'previous-call' }, { id: 'previous-final', conversationId: 'normal-chat', type: 'final_response', content: 'dev-0.1.2 内核优化已完成。', mode: 'build', model: 'shared-model', timestamp: '2026-07-20T09:00:00.000Z', runId: 'run-previous-completed', sequence: 2 }],
      guides: [],
      primaryPrompt: '完成 dev-0.1.2 内核优化',
    }, {
      runId: 'run-current-status-query',
      target: { workspaceId: 'fixture', conversationId: 'normal-chat' },
      runtimeKey: 'fixture::normal-chat',
      status: 'running',
      startedAt: '2026-07-20T10:00:00.000Z',
      expanded: true,
      sequence: 4,
      events: [],
      guides: [],
      primaryPrompt: '上个任务完成了吗？',
    }];
    (agent as unknown as { activeWorkRunId: string }).activeWorkRunId = 'run-current-status-query';
    const statusFocus = agentKernelRunnerInternals.buildRequestTaskFocus(agent, [{
      role: 'user',
      content: '上个任务完成了吗？',
      timestamp: Date.now(),
    }]);
    const previousIndex = statusFocus.indexOf('user_input="完成 dev-0.1.2 内核优化"');
    const unrelatedIndex = statusFocus.indexOf('user_input="修复一个与当前问题无关的旧错误"');
    const oldIndex = statusFocus.indexOf('user_input="完成旧版发布检查"');
    assert.ok(previousIndex >= 0 && unrelatedIndex > previousIndex && oldIndex > unrelatedIndex,
      'authoritative task ledger lists historical work runs newest-to-oldest regardless of completion state');
    assert.ok(statusFocus.includes('user_input="完成 dev-0.1.2 内核优化"; final_summary="dev-0.1.2 内核优化已完成。"; completion_status=completed')
      && !statusFocus.includes('完整测试通过。')
      && !statusFocus.includes('run-previous-completed')
      && !statusFocus.includes('startedAt='),
    'default task ledger exposes only user input, final summary, and completion status');
    assert.ok(statusFocus.includes('phrases such as "the previous task" or "the last task" refer to Historical Build Block #1')
      && statusFocus.includes('A status/history question is read-only and does not authorize resuming any task'),
    'status questions resolve the newest historical run without authorizing unrelated continuation');
    const queueStart = statusFocus.indexOf('Unfinished Continuation Queue');
    assert.ok(queueStart >= 0
      && statusFocus.slice(queueStart).includes('修复一个与当前问题无关的旧错误')
      && !statusFocus.slice(queueStart).includes('完成 dev-0.1.2 内核优化')
      && statusFocus.slice(queueStart).includes('newest to oldest'),
    'unfinished continuation queue excludes completed work and declares newest-to-oldest ordering');
    assert.ok(!statusFocus.includes('user_input="上个任务完成了吗？"'),
      'the current status question is excluded from historical task records');
    const noBootstrapFocus = agentKernelRunnerInternals.buildRequestTaskFocus(agent, [{
      role: 'user', content: 'tool subturn', timestamp: Date.now(),
    }], { includeBootstrap: false });
    assert.ok(!noBootstrapFocus.includes('Build Context Bootstrap')
      && !noBootstrapFocus.includes('Authoritative Conversation Task Ledger')
      && noBootstrapFocus.includes('Request-Scoped Task Focus'),
    'ordinary tool subturns retain instruction priority without repeating the large Build bootstrap');
    const historyDetail = JSON.parse(agent.handleBuildHistoryQuery(JSON.stringify({ history_index: 1, max_events: 20 }))) as Record<string, any>;
    assert.equal(historyDetail.ok, true);
    assert.equal(historyDetail.buildBlock.runId, 'run-previous-completed');
    assert.equal(historyDetail.buildBlock.completionStatus, 'completed');
    assert.equal(historyDetail.buildBlock.publicActivities[0].content, '完整测试通过。');
    assert.ok(!statusFocus.includes(historyDetail.buildBlock.publicActivities[0].content),
      'concrete Build activity is available only through the history query tool');
    const historyTool = (agent.tools.definitions('build') as Array<any>).find(tool => tool.function?.name === 'build_history_query');
    assert.ok(historyTool && historyTool.function.description.includes('read-only tool'),
      'history detail query is provider-visible as an explicitly read-only Build Block tool');
    const detailedRoute = agentKernelRunnerInternals.selectTaskToolDefinitions('上个任务具体做了什么？', agent.subagentToolDefinitions(agent.tools.definitions('build')));
    assert.ok(detailedRoute.some((tool: any) => tool.function?.name === 'build_history_query'),
      'history-detail intent preloads the Build history query schema');
    let historyQueryRound = 0;
    let historyQueryToolResult = '';
    const historyQueryProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
      async *chatStreamWithTools(
        _model: string,
        messages: Array<Record<string, any>>,
        _system: string,
        _temperature: number,
        _maxTokens: number,
        tools: Array<any>,
      ): AsyncGenerator<StreamToken> {
        if (historyQueryRound++ === 0) {
          assert.ok(tools.some(tool => tool.function?.name === 'build_history_query'),
            'history-detail request exposes the query schema on the first provider turn');
          yield { type: 'tool_call', text: '', toolCall: { id: 'history-query-call', name: 'build_history_query', arguments: JSON.stringify({ history_index: 1 }) } };
          return;
        }
        historyQueryToolResult = String(messages.find(message => message.role === 'tool' && message.name === 'build_history_query')?.content || '');
        yield { type: 'text', text: 'HISTORY_DETAIL_OK' };
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (agent as unknown as { forcedProvider: typeof historyQueryProvider }).forcedProvider = historyQueryProvider;
    const historyQueryOutput = (await agent.process('上个任务具体做了什么？')).map(token => token.text || '').join('');
    assert.ok(historyQueryOutput.includes('HISTORY_DETAIL_OK')
      && historyQueryToolResult.includes('完整测试通过。')
      && historyQueryToolResult.includes('run-previous-completed'),
    'native Kernel executes build_history_query and returns the selected Build Block details to the next model turn');

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
    assert.equal(
      agentKernelRunnerInternals.normalizePublicProviderError(new Error('PowerShell HTTP fallback failed: Invoke-WebRequest: {"error":{"message":"No tool call found for function call output with call_id call_memory"}}')),
      'Provider rejected the tool-result continuation because its matching tool call was missing. Newmark preserved the run for retry.',
      'provider diagnostics replace the PowerShell stack with a concise tool-continuation error',
    );
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
