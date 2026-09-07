import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';
import type { StreamToken } from '../core/types';
import type { AgentKernelDiagnosticEvent } from '../core/agentKernelDiagnostics';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-build-cache-diagnostics-'));
  const diagnosticModule: typeof import('../core/agentKernelDiagnostics') = require('../core/agentKernelDiagnostics');
  const originalEmit = diagnosticModule.emitRequestContextDiagnostic;
  const originalEnv = process.env.NEWMARK_KERNEL_DIAGNOSTICS;
  const originalError = console.error;
  const calls: Array<{system: string; messages: unknown[]; tools: unknown[]}> = [];
  const emittedAt: number[] = [], sinkEvents: AgentKernelDiagnosticEvent[] = [], loggedEvents: AgentKernelDiagnosticEvent[] = [];
  try {
    delete process.env.NEWMARK_KERNEL_DIAGNOSTICS;
    diagnosticModule.setAgentKernelDiagnosticSink(null);
    diagnosticModule.emitRequestContextDiagnostic = input => {
      emittedAt.push(calls.length + 1);
      return originalEmit(input);
    };
    console.error = (...args: unknown[]) => {
      const text = String(args[0] || '');
      if (text.startsWith('[NewmarkKernelDiagnostic] ')) loggedEvents.push(JSON.parse(text.slice('[NewmarkKernelDiagnostic] '.length)));
      else originalError(...args);
    };
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      models: {providers: [{id: 'cache-fixture', name: 'Cache fixture', protocol: 'openai', base_url: 'https://fixture.invalid/v1', api_key: 'fixture-only', enabled: true, models: [{name: 'cache-fixture', max_tokens: 128000, enabled: true}]}], default_model: 'cache-fixture', auto_switch: false, fallback_on_unavailable: false},
      context: {auto_compress: false}, workspace: {auto_create_timestamp_workspace: false},
    }));
    const agent = new Agent(root, {agentOnly: true});
    agent.setConversation('cache-diagnostic-subturns');
    const provider = {
      intelligenceConfig: () => ({temperature: 0, maxTokens: 32}),
      async chat(): Promise<string> { return 'Cache diagnostics fixture'; },
      async *chatStreamWithTools(_model: string, messages: unknown[], system: string, _temperature: number, _maxTokens: number, tools: unknown[]): AsyncGenerator<StreamToken> {
        calls.push({system, messages: JSON.parse(JSON.stringify(messages)), tools: JSON.parse(JSON.stringify(tools))});
        const round = calls.length;
        yield {type: 'usage', text: '', usage: {input: 1000, output: 20, cacheRead: round % 2 ? 0 : 750, cacheWrite: 0}};
        if (round === 1) diagnosticModule.setAgentKernelDiagnosticSink(event => sinkEvents.push(event));
        if (round === 2) { diagnosticModule.setAgentKernelDiagnosticSink(null); process.env.NEWMARK_KERNEL_DIAGNOSTICS = '1'; }
        if (round === 3) delete process.env.NEWMARK_KERNEL_DIAGNOSTICS;
        if (round < 4) yield {type: 'tool_call', text: '', toolCall: {id: `diagnostic-pwd-${round}`, name: 'pwd', arguments: '{}'}};
        else yield {type: 'text', text: 'CACHE_DIAGNOSTICS_DONE'};
      },
    };
    (agent as unknown as {forcedProvider: typeof provider}).forcedProvider = provider;
    const tokens = await agent.process('Read the current working directory three times, then finish.');
    assert.ok(tokens.some(token => token.text?.includes('CACHE_DIAGNOSTICS_DONE')));
    assert.equal(calls.length, 4, 'zero-cache usage never retries successful responses');
    assert.deepEqual(emittedAt, [2, 3], 'only subscribed subturns traverse and hash request history; disabling resumes the fast path');
    assert.equal(sinkEvents.filter(event => event.type === 'request_context').length, 1);
    assert.equal(loggedEvents.filter(event => event.type === 'request_context').length, 1);
    assert.ok(!JSON.stringify([...sinkEvents, ...loggedEvents]).includes('Read the current working directory'), 'diagnostics never expose prompt contents');
    assert.ok(calls.every(call => call.system === calls[0].system), 'diagnostic mode never rewrites the Build system prefix');
    assert.ok(calls.every(call => JSON.stringify(call.tools) === JSON.stringify(calls[0].tools)), 'diagnostic mode never changes tool schema order');
    assert.ok(calls.slice(1).every((call, index) => JSON.stringify(call.messages.slice(0, calls[index].messages.length)) === JSON.stringify(calls[index].messages)), 'each subturn retains prior messages');
    const usage = agent.contextWindow();
    assert.equal(usage.providerInputTokens, 4000);
    assert.equal(usage.providerOutputTokens, 80);
    assert.equal(usage.providerCacheReadTokens, 1500, 'usage remains recorded when diagnostics are disabled, including real zero values');
    console.log(JSON.stringify({ok: true, assertions: 12, formalCalls: calls.length, requestDiagnosticSubturns: emittedAt}));
  } finally {
    diagnosticModule.emitRequestContextDiagnostic = originalEmit;
    diagnosticModule.setAgentKernelDiagnosticSink(null);
    if (originalEnv === undefined) delete process.env.NEWMARK_KERNEL_DIAGNOSTICS; else process.env.NEWMARK_KERNEL_DIAGNOSTICS = originalEnv;
    console.error = originalError;
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
