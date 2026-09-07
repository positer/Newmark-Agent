/**
 * dev-0.4.3 上下文缓存命中率压力测试（Build block 内前缀缓存稳定性）。
 *
 * 通过 fake provider 在每个 Build 内返回多次 tool_call（pwd），让同一次
 * Agent.process 产生多个 provider 子轮。验证：
 *   1. 每个 Build 从首请求开始完整保留 system 与先前 messages、工具 schema；
 *   2. provider usage 累积后 contextWindow() 暴露的全对话 token 与
 *      缓存命中率统计正确；
 *   3. 多 Build 重复压力下统计不漂移、无越界。
 *
 * Run: npm run build && node dist/tests/contextCacheHitStressVerify.js
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';
import type { StreamToken } from '../core/types';

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label}`); }
};

function writeConfig(root: string): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: { value: [{
        id: 'cache-provider',
        name: 'Cache Provider',
        base_url: 'https://cache-provider.invalid/v1',
        api_key: 'fixture-cache',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'cache-model',
          display: 'Cache Model',
          description: 'Cache stress fixture.',
          max_tokens: 128000,
          vision: false,
          image_output: false,
          thinking: false,
          speed_rating: 'fast',
          capability_rating: 'high',
          validation: {
            level: 'standard',
            status: 'verified',
            checked_at: new Date().toISOString(),
            capabilities: { text_input: true, text_output: true, tool_use: true },
          },
          capabilities: ['text_input', 'text_output', 'tool_use'],
        }],
      }] },
      default_model: { value: 'cache-model' },
      auto_switch: { value: false },
      fallback_on_unavailable: { value: false },
    },
    context: { auto_compress: { value: false } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-cache-hit-stress-'));
  writeConfig(root);
  const runner = new Agent(root, { agentOnly: true });
  try {
    runner.setConversation('cache-hit-stress');
    runner.workspace.current = null;
    const providerCalls: Array<{ system: string; messages: Array<Record<string, unknown>>; tools: unknown[] }> = [];
    const inputTokensPerCall = 1000;
    const outputTokensPerCall = 40;
    const cacheReadPerCall = 950;
    const builds = 5;
    const toolRoundsPerBuild = 8;
    let buildToolCounter = 0;
    const fakeProvider = {
      intelligenceConfig: () => ({ temperature: 0, maxTokens: 32 }),
      async *chatStreamWithTools(_model: string, messages: Array<Record<string, unknown>>, system: string, _temperature: number, _maxTokens: number, tools: unknown[]): AsyncGenerator<StreamToken> {
        providerCalls.push({ system, messages: JSON.parse(JSON.stringify(messages)), tools: JSON.parse(JSON.stringify(tools)) });
        yield { type: 'usage', text: '', usage: { input: inputTokensPerCall, output: outputTokensPerCall, cacheRead: cacheReadPerCall, cacheWrite: 0 } };
        if (buildToolCounter < toolRoundsPerBuild) {
          buildToolCounter += 1;
          yield { type: 'tool_call', text: '', toolCall: { id: `cache-hit-pwd-${buildToolCounter}`, name: 'pwd', arguments: '{}' } };
        } else {
          yield { type: 'text', text: 'CACHE_HIT_DONE' };
        }
      },
      async chat(): Promise<string> { return 'unused'; },
    };
    (runner as unknown as { forcedProvider: typeof fakeProvider }).forcedProvider = fakeProvider;

    for (let build = 0; build < builds; build += 1) {
      buildToolCounter = 0;
      const tokens = await runner.process(`stress-build-${build}`);
      const text = tokens.map(token => token.text || '').join('');
      check(text.includes('CACHE_HIT_DONE'), `build ${build}: multi-tool provider run completes`);
    }

    const requestsPerBuild = toolRoundsPerBuild + 1;
    const totalCalls = builds * requestsPerBuild;
    check(providerCalls.length === totalCalls, `stress volume: ${totalCalls} provider requests across ${builds} Builds (${providerCalls.length})`);

    const window = runner.contextWindow();
    const expectedInput = totalCalls * inputTokensPerCall;
    const expectedOutput = totalCalls * outputTokensPerCall;
    const expectedCacheRead = totalCalls * cacheReadPerCall;
    check(window.providerInputTokens === expectedInput
      && window.providerOutputTokens === expectedOutput
      && window.providerTotalTokens === expectedInput + expectedOutput,
    'context window: whole-conversation token totals match simulated usage');
    check(window.providerCacheReadTokens === expectedCacheRead
      && Number(window.providerCacheReadRatio) === cacheReadPerCall / inputTokensPerCall,
    'context window: cache-read tokens and cache-hit ratio match simulated usage');
    // These supplied counts validate accounting only; actual cache service
    // hits must be measured independently from provider usage.

    for (let build = 0; build < builds; build += 1) {
      const start = build * requestsPerBuild;
      const calls = providerCalls.slice(start, start + requestsPerBuild);
      const systems = calls.map(call => call.system);
      check(systems[0].includes('## Build Context Bootstrap'), `build ${build}: first provider request injects Build bootstrap`);
      check(systems[0].includes('## Request-Scoped Task Focus'), `build ${build}: first provider request injects request-scoped task focus`);
      check(new Set(systems).size === 1, `build ${build}: every request keeps the complete first system prefix`);
      check(new Set(calls.map(call => JSON.stringify(call.tools))).size === 1,
        `build ${build}: unchanged tool availability retains the exact schema sequence`);
      check(calls.slice(1).every((call, index) => JSON.stringify(call.messages.slice(0, calls[index].messages.length)) === JSON.stringify(calls[index].messages)),
        `build ${build}: each request retains all prior ordered messages and only appends`);
      check(build === 0 || systems[0] !== providerCalls[start - requestsPerBuild].system,
        `build ${build}: a new Build initializes a fresh task-ledger snapshot`);
    }
    check(!JSON.stringify(runner.history).includes('Build Context Bootstrap'),
      'Build metadata remains request-only after all tool rounds and Builds');

    console.log(`\ncontextCacheHitStressVerify: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
