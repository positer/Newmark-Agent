import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Agent } from '../core/agent';
import { emitProviderUsageDiagnostic, emitRequestContextDiagnostic, extractProviderUsage, setAgentKernelDiagnosticSink, type AgentKernelDiagnosticEvent } from '../core/agentKernelDiagnostics';

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-performance-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      general: { language: { value: 'en' } },
      agent: { default_mode: { value: 'build' } },
      workspace: { prompt_mode: { value: 'global_only' }, auto_create_timestamp_workspace: { value: false } },
      models: { providers: { value: [] } },
    }));
    fs.writeFileSync(path.join(root, 'agent.md'), 'Performance test prompt.');
    const agent = new Agent(root, { agentOnly: true });
    const firstPrompt = agent.buildSystemPrompt();
    assert.strictEqual(agent.buildSystemPrompt(), firstPrompt, 'stable system prompt is cached');
    const firstTools = agent.cachedToolDefinitions();
    assert.strictEqual(agent.cachedToolDefinitions(), firstTools, 'stable tool catalog is cached');
    agent.setMode('plan');
    assert.notStrictEqual(agent.cachedToolDefinitions(), firstTools, 'mode changes invalidate tool catalog cache');
    const diagnostics: AgentKernelDiagnosticEvent[] = [];
    setAgentKernelDiagnosticSink(event => diagnostics.push(event));
    const firstDiagnostic = emitRequestContextDiagnostic({
      conversationId: 'diagnostic-test',
      systemPrompt: 'private system prompt',
      messages: [{ role: 'user', content: 'private user task' }],
      tools: [{ name: 'private_tool', parameters: { secret: 'value' } }],
    });
    const stableDiagnostic = emitRequestContextDiagnostic({
      conversationId: 'diagnostic-test',
      systemPrompt: 'private system prompt',
      messages: [{ role: 'user', content: 'private user task' }],
      tools: [{ parameters: { secret: 'value' }, name: 'private_tool' }],
    });
    const changedDiagnostic = emitRequestContextDiagnostic({
      conversationId: 'diagnostic-test',
      systemPrompt: 'private system prompt changed',
      messages: [{ role: 'user', content: 'private user task' }],
      tools: [{ name: 'private_tool', parameters: { secret: 'value' } }],
    });
    setAgentKernelDiagnosticSink(null);
    assert.strictEqual(firstDiagnostic.requestFingerprint, stableDiagnostic.requestFingerprint, 'diagnostic fingerprints are stable across object key ordering');
    assert.notStrictEqual(firstDiagnostic.requestFingerprint, changedDiagnostic.requestFingerprint, 'diagnostic fingerprints change when the request context changes');
    const serializedDiagnostics = JSON.stringify(diagnostics);
    assert.ok(!serializedDiagnostics.includes('private system prompt') && !serializedDiagnostics.includes('private user task') && !serializedDiagnostics.includes('private_tool') && !serializedDiagnostics.includes('secret'), 'diagnostics contain fingerprints and counts without request content');
    assert.ok(firstDiagnostic.messageCount === 1 && firstDiagnostic.toolCount === 1 && firstDiagnostic.estimatedMessageTokens > 0 && firstDiagnostic.estimatedToolTokens > 0, 'diagnostics expose bounded request and tool-surface measurements');
    assert.deepEqual(extractProviderUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 75 } } }),
      { input: 100, output: 20, cacheRead: 75, cacheWrite: 0 }, 'OpenAI Chat usage normalizes cached prompt tokens');
    assert.deepEqual(extractProviderUsage({ usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 90 } } }),
      { input: 120, output: 30, cacheRead: 90, cacheWrite: 0 }, 'OpenAI Responses usage normalizes cached input tokens');
    assert.deepEqual(extractProviderUsage({ usage: { input_tokens: 80, output_tokens: 15, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } }),
      { input: 80, output: 15, cacheRead: 50, cacheWrite: 10 }, 'Anthropic usage normalizes cache read and creation tokens');
    const usageDiagnostic = emitProviderUsageDiagnostic({ conversationId: 'diagnostic-test', inputTokens: 100, outputTokens: 20, cacheReadTokens: 75, cacheWriteTokens: 5 });
    assert.ok(usageDiagnostic.type === 'provider_usage' && usageDiagnostic.cacheReadRatio === 0.75, 'provider usage diagnostics expose a bounded cache-read ratio');
    console.log(JSON.stringify({ ok: true, assertions: 11 }));
  } finally {
    setAgentKernelDiagnosticSink(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
