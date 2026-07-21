import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';
import { agentKernelRunnerInternals } from '../core/agentKernelRunner';
import type { StreamToken } from '../core/types';

type ToolDefinition = {
  type: string;
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

function toolName(definition: unknown): string {
  return String((definition as ToolDefinition)?.function?.name || '');
}

function brokerCatalogNames(definition: ToolDefinition): string[] {
  return String(definition.function.description || '')
    .split(/\r?\n/)
    .flatMap(line => {
      const match = /^([A-Za-z0-9_.-]+):\s/.exec(line);
      return match ? [match[1]] : [];
    });
}

function writeFixtureConfig(root: string): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: { value: [{
        id: 'fixture-provider',
        name: 'Fixture',
        base_url: 'https://fixture.invalid/v1',
        api_key: 'fixture-only',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'fixture-model',
          display: 'Fixture model',
          description: 'Tool provisioning fixture.',
          max_tokens: 128000,
          vision: true,
          image_output: true,
          thinking: false,
          speed_rating: 'fast',
          capability_rating: 'high',
          evaluation: { status: 'available' },
          validation: {
            level: 'standard',
            status: 'verified',
            checked_at: new Date().toISOString(),
            capabilities: { text_input: true, text_output: true, image_input: true, image_output: true, tool_use: true },
          },
          capabilities: ['text_input', 'text_output', 'image_input', 'image_output', 'tool_use'],
        }],
      }] },
      default_model: { value: 'fixture-model' },
      auto_switch: { value: false },
      fallback_on_unavailable: { value: false },
    },
    context: { auto_compress: { value: false } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'agentKernelRunner.js'), 'utf8');
  const bufferedEmitter = runnerSource.slice(runnerSource.indexOf('function emitBufferedAssistantText'), runnerSource.indexOf('function resetAssistantToolVisibility'));
  assert.ok(bufferedEmitter.includes('agent.markRouteStreamCommitted()'),
    'broker-only text becomes a committed public stream as soon as its buffer is released');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-tool-provisioning-'));
  try {
    writeFixtureConfig(root);
    const agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: 'tool-provisioning' });
    agent.workspace.current = null;
    agent.config.clearWorkspaceOverrides();
    agent.tools.setHostProfile({ kind: 'electron-utility', platform: 'win32', electronBrowser: true, windowsComputerUse: true });
    const catalog = agent.subagentToolDefinitions(agent.tools.definitions('build')) as ToolDefinition[];
    const names = catalog.map(toolName);
    assert.ok(names.length >= 50, `expected broad native catalog, received ${names.length}`);
    assert.equal(new Set(names).size, names.length, 'callable catalog has unique names');
    assert.ok(catalog.every(definition => definition.function.parameters.additionalProperties === false),
      'every provider-visible tool schema is closed before provisioning');
    assert.ok(names.includes('computer_use') && names.includes('browser_use') && names.includes('image_generate'),
      'desktop catalog includes platform and model-dependent tools');

    const Session = agentKernelRunnerInternals.ToolProvisionSession;
    const emptySession = new Session(catalog, []);
    const initial = emptySession.currentDefinitions() as ToolDefinition[];
    assert.deepEqual(initial.map(toolName), [agentKernelRunnerInternals.TOOL_PROVISION_NAME],
      'conversational initialization sends only the broker schema');
    const broker = initial[0];
    assert.deepEqual(brokerCatalogNames(broker), names,
      'broker compact catalog names exactly match the complete policy-filtered callable catalog');
    assert.ok(JSON.stringify(initial).length < JSON.stringify(catalog).length * 0.55,
      'compact broker catalog is materially smaller than every full tool schema');
    const initialMetrics = emptySession.metrics();
    assert.ok(initialMetrics.catalogToolCount === names.length
      && initialMetrics.initialToolCount === 0
      && initialMetrics.provisionedToolCount === 0
      && initialMetrics.activeSurfaceEstimatedTokens < initialMetrics.fullCatalogEstimatedTokens * 0.55,
    'provision metrics quantify the compact initial surface without exposing catalog content');

    for (const definition of catalog) {
      const name = toolName(definition);
      const session = new Session(catalog, []);
      const result = session.provision({ names: [name] });
      assert.equal(result.ok, true, `${name} exact-name provision succeeds`);
      assert.deepEqual(result.provisioned, [name], `${name} is reported as newly provisioned`);
      const visible = (session.currentDefinitions() as ToolDefinition[]).find(item => toolName(item) === name);
      assert.deepEqual(visible, definition, `${name} retains its original name, description, and JSON schema`);
    }

    const searchSession = new Session(catalog, []);
    const searched = searchSession.provision({ query: 'browser click' });
    assert.ok(searched.ok && searched.matches.some(name => name.startsWith('browser_')), 'query returns compact catalog matches');
    assert.deepEqual((searchSession.currentDefinitions() as ToolDefinition[]).map(toolName), [agentKernelRunnerInternals.TOOL_PROVISION_NAME],
      'query is search-only and does not silently grant schemas');
    const granted = searchSession.provision({ names: [searched.matches[0]] });
    assert.deepEqual(granted.provisioned, [searched.matches[0]], 'a searched exact name is provisioned in the second phase');
    const grantedMetrics = searchSession.metrics();
    assert.ok(grantedMetrics.brokerCalls === 2
      && grantedMetrics.provisionedToolCount === 1
      && grantedMetrics.activeSurfaceEstimatedTokens > initialMetrics.activeSurfaceEstimatedTokens
      && grantedMetrics.activeSurfaceEstimatedTokens < grantedMetrics.fullCatalogEstimatedTokens,
    'provision metrics track discovery round trips and incremental schema cost');

    const discoveryCases: Array<{ query: string; accept: (name: string) => boolean }> = [
      { query: 'browser click page', accept: name => name.startsWith('browser_') },
      { query: 'computer screen desktop', accept: name => name === 'computer_use' },
      { query: 'terminal command script', accept: name => name === 'bash' || name === 'terminal_takeover' },
      { query: 'file directory repository code', accept: name => ['glob', 'grep', 'read', 'write', 'edit'].includes(name) },
      { query: 'web search online', accept: name => name === 'web_search' || name === 'web_fetch' },
      { query: 'automation schedule reminder', accept: name => name.startsWith('automation_') },
    ];
    let discoveryHits = 0;
    for (const item of discoveryCases) {
      const result = new Session(catalog, []).provision({ query: item.query });
      if (result.matches.some(item.accept)) discoveryHits += 1;
    }
    assert.equal(discoveryHits, discoveryCases.length, 'representative capability queries retain complete discovery coverage');

    const guarded = new Session(catalog, []);
    assert.equal(guarded.provision({ names: ['pwd'], extra: true }).error?.code, 'unexpected_field');
    assert.equal(guarded.provision({ names: Array.from({ length: 9 }, () => 'pwd') }).error?.code, 'batch_limit');
    assert.equal(guarded.provision({ query: 'x'.repeat(161) }).error?.code, 'invalid_query');
    assert.equal(guarded.provision({ names: ['not/a/tool'] }).error?.code, 'invalid_name');
    assert.equal(guarded.provision({ names: ['missing_tool'] }).unknown[0], 'missing_tool');
    guarded.provision({ query: 'browser' });
    guarded.provision({ query: 'web' });
    assert.equal(guarded.provision({ names: ['pwd'] }).error?.code, 'call_limit', 'broker calls are bounded per run');

    const capacitySession = new Session(catalog, []);
    assert.equal(capacitySession.provision({ names: names.slice(0, 8) }).provisioned.length, 8);
    assert.equal(capacitySession.provision({ names: names.slice(8, 16) }).provisioned.length, 8);
    assert.deepEqual(capacitySession.provision({ names: [names[16]] }).deferred, [names[16]],
      'one run can expose at most sixteen additional full schemas');

    agent.history.push({ role: 'user', content: 'Fix the repository and then use git_push.' });
    const routedSurface = agentKernelRunnerInternals.routeToolSurface(agent, catalog);
    agent.history.pop();
    assert.ok(routedSurface.definitions.length <= agentKernelRunnerInternals.INITIAL_TOOL_SCHEMA_LIMIT
      && routedSurface.definitions.some(definition => toolName(definition) === 'git_push')
      && toolName(routedSurface.definitions[0]) === 'git_push',
    'initial preload is capped and prioritizes an explicitly named tool');

    agent.setMode('plan');
    const planCatalog = agent.subagentToolDefinitions(agent.tools.definitions('plan')) as ToolDefinition[];
    const planNames = planCatalog.map(toolName);
    assert.ok(planNames.includes('browser_use') && planNames.includes('computer_use'),
      'Windows Desktop Plan catalog retains its parameter-scoped read-only browser and desktop tools');
    assert.ok(!planNames.some(name => ['write', 'edit', 'browser_click', 'browser_type', 'browser_eval', 'browser_cdp'].includes(name)),
      'Plan broker catalog excludes mutating standalone tools');
    const planBrowser = planCatalog.find(definition => toolName(definition) === 'browser_use')!;
    const planComputer = planCatalog.find(definition => toolName(definition) === 'computer_use')!;
    assert.deepEqual((planBrowser.function.parameters as any).properties.action.enum, ['observe', 'navigate', 'wait', 'extract']);
    assert.deepEqual((planComputer.function.parameters as any).properties.action.enum, ['observe', 'app_list', 'app_observe']);
    const blockedPlanInvocation = agent.tools.validateInvocation(
      'computer_use',
      JSON.stringify({ action: 'click', x: 1, y: 1 }),
      'plan',
      planComputer.function.parameters,
    );
    assert.equal(blockedPlanInvocation.ok, false, 'Plan narrowed schema rejects hidden Computer Use actions');
    const blockedPlanExecution = await agent.tools.execute(
      'computer_use',
      JSON.stringify({ action: 'click', x: 1, y: 1 }),
      root,
      { mode: 'plan' },
    );
    assert.ok(blockedPlanExecution.startsWith('[permission]'), 'runtime policy independently blocks hidden Plan actions');
    assert.deepEqual(brokerCatalogNames(new Session(planCatalog, []).currentDefinitions()[0] as ToolDefinition), planNames,
      'Plan broker describes exactly the narrowed callable boundary');
    agent.setMode('build');

    agent.tools.setHostProfile({ kind: 'cli', platform: 'linux', electronBrowser: false, windowsComputerUse: false });
    const cliCatalog = agent.subagentToolDefinitions(agent.tools.definitions('build')) as ToolDefinition[];
    const cliNames = cliCatalog.map(toolName);
    assert.ok(!cliNames.includes('computer_use') && !cliNames.some(name => name.startsWith('browser_')),
      'pure Linux CLI catalog cannot advertise desktop or Electron browser tools');
    const cliBroker = new Session(cliCatalog, []).currentDefinitions()[0] as ToolDefinition;
    assert.ok(!brokerCatalogNames(cliBroker).includes('computer_use'), 'filtered tools are absent from the compact broker boundary');

    agent.setMode('plan');
    agent.tools.setHostProfile({ kind: 'cli', platform: 'win32', electronBrowser: false, windowsComputerUse: true });
    const windowsCliPlanNames = agent.subagentToolDefinitions(agent.tools.definitions('plan')).map(toolName);
    assert.ok(windowsCliPlanNames.includes('computer_use') && !windowsCliPlanNames.some(name => name.startsWith('browser_')),
      'Windows CLI Plan advertises only its read-only desktop surface');

    agent.tools.setHostProfile({ kind: 'cli', platform: 'linux', electronBrowser: false, windowsComputerUse: false });
    const linuxCliPlanNames = agent.subagentToolDefinitions(agent.tools.definitions('plan')).map(toolName);
    assert.ok(!linuxCliPlanNames.includes('computer_use') && !linuxCliPlanNames.some(name => name.startsWith('browser_')),
      'Linux CLI Plan advertises neither Electron Browser nor Windows Computer Use');

    agent.tools.setHostProfile({ kind: 'wsl', platform: 'linux', electronBrowser: true, windowsComputerUse: false });
    const wslNames = agent.subagentToolDefinitions(agent.tools.definitions('plan')).map(toolName);
    assert.ok(wslNames.includes('browser_use') && !wslNames.includes('computer_use'),
      'managed WSL Plan advertises its read-only Electron browser tool but not Windows Computer Use');

    agent.setMode('build');
    agent.tools.setHostProfile({ kind: 'electron-utility', platform: 'win32', electronBrowser: true, windowsComputerUse: true });
    const providerTurns: string[][] = [];
    const providerSystems: string[] = [];
    let providerTurn = 0;
    const fakeProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
      async *chatStreamWithTools(
        _model: string,
        _messages: Array<Record<string, unknown>>,
        system: string,
        _temperature: number,
        _maxTokens: number,
        tools: ToolDefinition[],
      ): AsyncGenerator<StreamToken> {
        providerTurns.push(tools.map(toolName));
        providerSystems.push(system);
        if (providerTurn++ === 0) {
          yield { type: 'text', text: 'INTERNAL_PROVISION_PREFACE' };
          yield { type: 'tool_call', text: '', toolCall: { id: 'provision-pwd', name: 'tool_provision', arguments: JSON.stringify({ names: ['pwd'] }) } };
        } else if (providerTurn === 2) {
          yield { type: 'tool_call', text: '', toolCall: { id: 'call-pwd', name: 'pwd', arguments: '{}' } };
        } else {
          yield { type: 'text', text: 'BROKER_EXECUTION_OK' };
        }
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (agent as unknown as { forcedProvider: typeof fakeProvider }).forcedProvider = fakeProvider;
    const publicToolEvents: string[] = [];
    agent.subscribeWorkEvents(event => {
      if (event.toolName) publicToolEvents.push(event.toolName);
    });
    const output = (await agent.process('Complete the request without assuming unavailable interfaces.')).map(token => token.text || '').join('');
    assert.deepEqual(providerTurns[0], ['skill', 'tool_provision'], 'first provider request carries only the compact broker plus bounded skill discovery for ordinary chat');
    assert.ok(providerTurns[1].includes('pwd') && providerTurns[1].includes('tool_provision'),
      'broker result refreshes the next provider request in the same user run');
    assert.ok(providerTurns[1].length < catalog.length, 'dynamic refresh does not expand back to the whole catalog');
    assert.ok(providerSystems[0].includes('## Build Context Bootstrap')
      && providerSystems[0].includes('## Tool Awareness Bootstrap')
      && providerSystems[0].includes('pwd:')
      && providerSystems[0].includes('Necessary full schemas supplied natively for this provider turn: skill'),
    'the first Build request receives the full brief catalog and identifies schemas supplied through the native tools field');
    assert.ok(providerSystems.slice(1).every(system => !system.includes('## Build Context Bootstrap') && !system.includes('## Tool Awareness Bootstrap')),
      'broker and real-tool subturns do not repeat the Build bootstrap');
    assert.ok(output.includes('BROKER_EXECUTION_OK'), 'newly provisioned original tool executes and the run completes');
    assert.ok(!output.includes('INTERNAL_PROVISION_PREFACE'), 'short broker-only prefaces never enter public output');
    assert.ok(publicToolEvents.includes('pwd') && !publicToolEvents.includes('tool_provision'),
      'internal provisioning is hidden while the real tool keeps normal work events');
    assert.ok(!JSON.stringify(agent.history).includes('tool_provision'), 'broker calls and results are not persisted in public conversation history');

    let unexpectedTargetExecutions = 0;
    for (const targetName of names) {
      const probe = new Agent(root, {
        agentOnly: true,
        workspaceRegistryMode: 'detached',
        conversationId: `tool-reach-${targetName}`,
      });
      probe.workspace.current = null;
      probe.config.clearWorkspaceOverrides();
      probe.tools.setHostProfile({ kind: 'electron-utility', platform: 'win32', electronBrowser: true, windowsComputerUse: true });
      const originalExecute = probe.tools.execute.bind(probe.tools);
      probe.tools.execute = async (...args: Parameters<typeof originalExecute>) => {
        unexpectedTargetExecutions += 1;
        return originalExecute(...args);
      };
      const reachTurns: ToolDefinition[][] = [];
      let reachTurn = 0;
      const reachProvider = {
        intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
        async *chatStreamWithTools(
          _model: string,
          _messages: Array<Record<string, unknown>>,
          _system: string,
          _temperature: number,
          _maxTokens: number,
          tools: ToolDefinition[],
        ): AsyncGenerator<StreamToken> {
          reachTurns.push(tools);
          if (reachTurn++ === 0) {
            yield {
              type: 'tool_call',
              text: '',
              toolCall: {
                id: `provision-${targetName}`,
                name: 'tool_provision',
                arguments: JSON.stringify({ names: [targetName] }),
              },
            };
            return;
          }
          yield { type: 'text', text: `REACHED_${targetName}` };
        },
        async chat(): Promise<string> { return 'unused'; },
      };
      (probe as unknown as { forcedProvider: typeof reachProvider }).forcedProvider = reachProvider;
      const reachOutput = (await probe.process('Continue using the available capability boundary.'))
        .map(token => token.text || '')
        .join('');
      assert.deepEqual(reachTurns[0].map(toolName), ['skill', 'tool_provision'], `${targetName} starts behind the broker plus bounded skill discovery boundary`);
      const reachedDefinition = reachTurns[1]?.find(definition => toolName(definition) === targetName);
      assert.deepEqual(reachedDefinition, catalog.find(definition => toolName(definition) === targetName),
        `${targetName} original schema reaches the next provider subturn without drift`);
      assert.ok(reachOutput.includes(`REACHED_${targetName}`), `${targetName} reachability probe completes`);
    }
    assert.equal(unexpectedTargetExecutions, 0, 'all-tool reachability probes provision schemas without executing side effects');

    const mixedAgent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: 'tool-provision-mixed' });
    mixedAgent.workspace.current = null;
    mixedAgent.config.clearWorkspaceOverrides();
    mixedAgent.tools.setHostProfile({ kind: 'electron-utility', platform: 'win32', electronBrowser: true, windowsComputerUse: true });
    let mixedRound = 0;
    const mixedProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
      async *chatStreamWithTools(): AsyncGenerator<StreamToken> {
        if (mixedRound++ === 0) {
          yield { type: 'tool_call', text: '', toolCall: { id: 'mixed-provision', name: 'tool_provision', arguments: JSON.stringify({ names: ['web_search'] }) } };
          yield { type: 'tool_call', text: '', toolCall: { id: 'mixed-pwd', name: 'pwd', arguments: '{}' } };
          return;
        }
        yield { type: 'text', text: 'MIXED_CALL_OK' };
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (mixedAgent as unknown as { forcedProvider: typeof mixedProvider }).forcedProvider = mixedProvider;
    await mixedAgent.process('Use pwd to identify the current workspace.');
    const mixedHistory = mixedAgent.history as Array<Record<string, any>>;
    const mixedAssistantCalls = mixedHistory.flatMap(message => Array.isArray(message.tool_calls) ? message.tool_calls : []);
    assert.ok(mixedAssistantCalls.some(call => call.id === 'mixed-pwd')
      && !mixedAssistantCalls.some(call => call.function?.name === 'tool_provision'),
    'mixed broker and real-tool responses persist only the real assistant tool call');
    assert.ok(mixedHistory.some(message => message.role === 'tool' && message.tool_call_id === 'mixed-pwd')
      && !mixedHistory.some(message => message.name === 'tool_provision'),
    'mixed responses retain a paired real tool result without persisting broker state');

    const compressionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-tool-provision-compression-'));
    try {
      writeFixtureConfig(compressionRoot);
      const compressionAgent = new Agent(compressionRoot, { conversationId: 'tool-provision-compression' });
      compressionAgent.createInternalWorkspace('tool-provision-compression');
      compressionAgent.config.set('context', 'auto_compress', true);
      compressionAgent.config.set('context', 'keep_recent_messages', 2);
      compressionAgent.config.updateModel('fixture-provider', 'fixture-model', { max_tokens: 1_000 });
      compressionAgent.setModel('fixture-model');
      compressionAgent.config.save();
      compressionAgent.history = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${index}:` + 'x'.repeat(500),
      }));
      compressionAgent.saveWorkspaceConversationState();
      let compressionRound = 0;
      const compressionContexts: string[] = [];
      const compressionSystems: string[] = [];
      const compressionProvider = {
        intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }),
        async *chatStreamWithTools(_model: string, messages: Array<Record<string, unknown>>, system: string): AsyncGenerator<StreamToken> {
          compressionContexts.push(JSON.stringify(messages));
          compressionSystems.push(system);
          if (compressionRound++ === 0) {
            yield { type: 'tool_call', text: '', toolCall: { id: 'compressed-provision', name: 'tool_provision', arguments: JSON.stringify({ names: ['pwd'] }) } };
            return;
          }
          yield { type: 'text', text: 'COMPRESSION_OK' };
        },
        async chat(): Promise<string> {
          setTimeout(() => (compressionAgent as unknown as { activeAgentKernelRuntime?: { abort(): void } }).activeAgentKernelRuntime?.abort(), 0);
          return 'PUBLIC_COMPRESSION_SUMMARY';
        },
      };
      (compressionAgent as unknown as { forcedProvider: typeof compressionProvider }).forcedProvider = compressionProvider;
      const compressionOutput = (await compressionAgent.process('Continue after compacting this long public context.')).map(token => token.text || '').join('');
      assert.ok(compressionAgent.lastCompression && !JSON.stringify(compressionAgent.history).includes('tool_provision'),
        'automatic compression persists only the public projection of broker-backed context');
      assert.ok(compressionOutput.includes('COMPRESSION_OK') && compressionAgent.workRuns.at(-1)?.events.some(event => event.type === 'final_response'),
        'a compression-side kernel abort resumes the same Build through its final response instead of interrupting the task');
      assert.ok(compressionAgent.workRuns.at(-1)?.events.some(event => event.type === 'tool_result' && event.toolName === 'context_compression')
        && compressionContexts.some(context => context.includes('Continue Same Build After Context Compression') && context.includes('Build Primary Prompt') && context.includes('Continue after compacting this long public context.')),
      'context compression is a completed Build activity and continuation submits the summary, primary prompt, Guide slot, and current Build snapshot');
      assert.ok(compressionSystems[0]?.includes('Injection reason: context compression just completed')
        && compressionSystems[0].includes('PUBLIC_COMPRESSION_SUMMARY')
        && compressionSystems[0].includes('Historical Build Blocks (newest to oldest; #1 is the previous/last task):')
        && compressionSystems[0].includes('## Tool Awareness Bootstrap'),
      'the first provider request after compression rehydrates the mixed Build, recent-history, and tool-awareness bootstrap');
      assert.ok(compressionSystems.slice(1).every(system => !system.includes('## Build Context Bootstrap')),
        'post-compression tool subturns do not repeat the bootstrap');
      assert.ok(compressionSystems.every(system => !system.includes('0:' + 'x'.repeat(500))),
        'the mixed bootstrap uses the compression summary and never restores the removed original transcript');
      assert.ok(!JSON.stringify(compressionAgent.history).includes('Build Context Bootstrap')
        && !JSON.stringify(compressionAgent.chatMessages).includes('Tool Awareness Bootstrap'),
      'compression bootstrap metadata is not persisted into durable conversation state');
      const reloaded = new Agent(compressionRoot, { conversationId: 'tool-provision-compression' });
      assert.ok(!JSON.stringify(reloaded.history).includes('tool_provision'),
        'reloading compressed conversation state cannot revive the internal broker');
    } finally {
      fs.rmSync(compressionRoot, { recursive: true, force: true });
    }

    console.log(`PASS: ${names.length}/${names.length} callable tools retain exact schemas through on-demand provisioning`);
    console.log(`PASS: ${names.length}/${names.length} callable tools reach a provider subturn behind the broker boundary`);
    console.log('PASS: dynamic broker -> original tool execution stays within one user run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
