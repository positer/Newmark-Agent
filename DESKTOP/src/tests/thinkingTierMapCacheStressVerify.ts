/**
 * dev-0.4.3 模型原生思考强度档位映射（thinking_tier_map）缓存命中压力测试。
 *
 * 新情况：模型配置了 thinking_tier_map 后，LLMProvider 把 Newmark 档位反查为
 * 模型原生档位名写入请求体（chat_completions V2 adapter 此前还漏带
 * reasoningEffort）。本套件走真实 provider 序列化路径（V2 adapter + 本地
 * capture server），验证：
 *   1. 映射确定性：同档位反复请求，请求体 reasoning_effort 字节级一致
 *      （无状态泄漏、无随机漂移），多档位切换按精确/降级/最低档规则稳定；
 *   2. 缓存前缀稳定：同 Build 内 tool 子轮共享字节级一致的 system 前缀，
 *      reasoning_effort 只进请求体、不进 system prompt，不破坏前缀缓存；
 *   3. Agent 集成：带映射模型经 agentKernelRunner 全链路（intelligence →
 *      intelligenceConfig → chatStreamWithTools → reasoningEffort），
 *      contextWindow() 缓存命中率统计与模拟 usage 一致且不漂移；
 *   4. 档位切换压力：默认档位与 ultra 切换后映射值随档位正确变化。
 *
 * Run: npm run build && node dist/tests/thinkingTierMapCacheStressVerify.js
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';
import { LLMProvider } from '../llm/provider';
import type { StreamToken } from '../core/types';

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string, detail?: string): void => {
  if (cond) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; console.log(`  [FAIL] ${label}${detail !== undefined ? `: ${detail}` : ''}`); }
};

const TOOL_CALL_BODY = 'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-x","function":{"name":"bash","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}]}\n\n';
const TEXT_BODY = 'data: {"choices":[{"delta":{"content":"CACHE_MAP_DONE"}}]}\n\n';
const DONE = 'data: [DONE]\n\n';

function usageBody(input = 1000, cached = 950, output = 40): string {
  return `data: {"usage":{"prompt_tokens":${input},"completion_tokens":${output},"total_tokens":${input + output},"prompt_tokens_details":{"cached_tokens":${cached}}}}\n\n`;
}

type CaptureServer = {
  server: http.Server;
  port: number;
  requests: Array<{ url: string; body: string }>;
  stop(): Promise<void>;
};

function startCaptureServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<CaptureServer> {
  const requests: CaptureServer['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: String(req.url || ''), body });
      handler(req, res, body);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        server,
        port: address.port,
        requests,
        stop: () => new Promise<void>(res => server.close(() => res())),
      });
    });
  });
}

async function collectTokens(generator: AsyncGenerator<StreamToken>): Promise<StreamToken[]> {
  const tokens: StreamToken[] = [];
  for await (const token of generator) tokens.push(token);
  return tokens;
}

function writeConfig(root: string): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: { value: [{
        id: 'tier-map-provider',
        name: 'Tier Map Provider',
        base_url: 'http://127.0.0.1:1/v1',
        api_key: 'fixture-tier-map',
        protocol: 'openai',
        enabled: true,
        models: [{
          name: 'tier-map-model',
          display: 'Tier Map Model',
          description: 'Native tier map stress fixture.',
          max_tokens: 128000,
          vision: false,
          image_output: false,
          thinking: true,
          speed_rating: 'fast',
          capability_rating: 'high',
          validation: {
            level: 'standard',
            status: 'verified',
            checked_at: new Date().toISOString(),
            capabilities: { text_input: true, text_output: true, tool_use: true },
          },
          capabilities: ['text_input', 'text_output', 'tool_use'],
          intelligence_tiers: {
            low: { description: 'Minimal' },
            medium: { description: 'Balanced' },
            high: { description: 'Deep' },
            xhigh: { description: 'Deep' },
            max: { description: 'Deep' },
          },
          thinking_tier_map: { minimal: 'low', balanced: 'medium', deep: 'high' },
        }],
      }] },
      default_model: { value: 'tier-map-model' },
      auto_switch: { value: false },
      fallback_on_unavailable: { value: false },
    },
    context: { auto_compress: { value: false } },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Part A：真实 provider 序列化路径下，映射确定性 + system 前缀字节稳定
  // ---------------------------------------------------------------------------
  console.log('\n=== A. thinking_tier_map deterministic serialization ===');
  const simpleServer = await startCaptureServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(usageBody());
    res.write(TEXT_BODY);
    res.write(DONE);
    res.end();
  });
  try {
    const base = `http://127.0.0.1:${simpleServer.port}/v1`;
    const provider = new LLMProvider('tier-map', base, 'sk', 'openai', 'chat_stream', true, undefined, {
      'tier-map-model': { minimal: 'low', balanced: 'medium', deep: 'high' },
    });
    const system = 'STABLE_SYSTEM_PREFIX_FOR_CACHE';
    const messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'ping' }];
    const rounds = 30;
    for (let round = 0; round < rounds; round += 1) {
      const tokens = await collectTokens(provider.chatStreamWithTools('tier-map-model', messages, system, 0, 1024, [], undefined, 'max'));
      check(tokens.some(token => token.type === 'text' && token.text === 'CACHE_MAP_DONE'), `round ${round}: stream completes`);
    }
    check(simpleServer.requests.length === rounds, `volume: ${rounds} requests serialized (${simpleServer.requests.length})`);
    const efforts = simpleServer.requests.map(req => (JSON.parse(req.body) as { reasoning_effort?: string }).reasoning_effort);
    check(efforts.every(effort => effort === 'deep'), `mapping determinism: 30/30 requests carry native tier "deep" (max -> high fallback)`, JSON.stringify([...new Set(efforts)]));
    const systems = simpleServer.requests.map(req => {
      const body = JSON.parse(req.body) as { messages?: Array<{ role: string; content: string }> };
      return (body.messages || []).filter(message => message.role === 'system').map(message => message.content).join('');
    });
    check(new Set(systems).size === 1 && systems[0] === system, `cache prefix: system content byte-identical across ${rounds} requests`);
    // reasoning_effort 只进请求体顶层字段，不进入 system prompt（前缀缓存不被映射破坏）
    const systemWithEffort = systems.every(value => !value.includes('reasoning_effort') && !value.includes('deep'));
    check(systemWithEffort, 'cache prefix: mapped effort never leaks into the system prompt');
  } finally {
    await simpleServer.stop();
  }

  // ---------------------------------------------------------------------------
  // Part B：多档位切换压力 —— 每档 10 轮，映射值确定且符合精确/降级/最低档规则
  // ---------------------------------------------------------------------------
  console.log('\n=== B. multi-tier switching stability ===');
  const tierServer = await startCaptureServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(usageBody());
    res.write(TEXT_BODY);
    res.write(DONE);
    res.end();
  });
  try {
    const base = `http://127.0.0.1:${tierServer.port}/v1`;
    const provider = new LLMProvider('tier-map-switch', base, 'sk', 'openai', 'chat_stream', true, undefined, {
      'tier-map-model': { minimal: 'low', balanced: 'medium', deep: 'high' },
    });
    const expectations: Array<[string, string]> = [
      ['low', 'minimal'],    // 目标档位低于全部已映射档位 → 取最低档
      ['medium', 'balanced'], // 精确命中
      ['high', 'deep'],      // 精确命中
      ['xhigh', 'deep'],     // 就近降级
      ['max', 'deep'],       // 就近降级
      ['ultra', 'deep'],     // ultra 归一为 max 后降级
    ];
    const perTierRounds = 10;
    for (const tier of expectations.map(entry => entry[0])) {
      for (let round = 0; round < perTierRounds; round += 1) {
        await collectTokens(provider.chatStreamWithTools(
          'tier-map-model',
          [{ role: 'user', content: `tier=${tier}` }],
          `SYS_${tier}`,
          0, 1024, [], undefined, tier,
        ));
      }
    }
    const totalExpected = expectations.length * perTierRounds;
    check(tierServer.requests.length === totalExpected, `volume: ${totalExpected} requests across 6 tiers (${tierServer.requests.length})`);
    for (const [tier, expected] of expectations) {
      const tierEfforts = tierServer.requests
        .filter((req, index) => Math.floor(index / perTierRounds) === expectations.findIndex(([t]) => t === tier))
        .map(req => (JSON.parse(req.body) as { reasoning_effort?: string }).reasoning_effort);
      check(tierEfforts.length === perTierRounds && tierEfforts.every(effort => effort === expected),
        `tier ${tier}: ${perTierRounds}/${perTierRounds} requests map to native "${expected}"`, JSON.stringify([...new Set(tierEfforts)]));
    }
  } finally {
    await tierServer.stop();
  }

  // ---------------------------------------------------------------------------
  // Part C：Agent 集成压力 —— 带映射模型经全链路跑 5 Build × 8 tool 子轮
  // ---------------------------------------------------------------------------
  console.log('\n=== C. Agent integration cache-hit pressure ===');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-tier-map-cache-stress-'));
  writeConfig(root);
  const runner = new Agent(root, { agentOnly: true });
  try {
    let buildToolCounter = 0;
    const toolRoundsPerBuild = 8;
    const builds = 5;
    const inputTokensPerCall = 1000;
    const outputTokensPerCall = 40;
    const cacheReadPerCall = 950;
    const agentServer = await startCaptureServer((_req, res, rawBody) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(usageBody(inputTokensPerCall, cacheReadPerCall, outputTokensPerCall));
      try {
        const body = JSON.parse(rawBody) as { messages?: Array<{ role: string; content: string }> };
        const systemText = (body.messages || []).filter(message => message.role === 'system').map(message => message.content).join('');
        if (systemText.includes('## Build Context Bootstrap')) buildToolCounter = 0;
      } catch { /* keep current counter */ }
      if (buildToolCounter < toolRoundsPerBuild) {
        buildToolCounter += 1;
        res.write(TOOL_CALL_BODY);
      } else {
        res.write(TEXT_BODY);
      }
      res.write(DONE);
      res.end();
    });
    try {
      const base = `http://127.0.0.1:${agentServer.port}/v1`;
      const provider = new LLMProvider('tier-map-agent', base, 'sk', 'openai', 'chat_stream', true, undefined, {
        'tier-map-model': { minimal: 'low', balanced: 'medium', deep: 'high' },
      });
      (runner as unknown as { forcedProvider: LLMProvider }).forcedProvider = provider;
      runner.setConversation('tier-map-cache-stress');
      runner.workspace.current = null;
      // C1：默认档位 medium → 精确命中 balanced
      for (let build = 0; build < 2; build += 1) {
        const tokens = await runner.process(`stress-build-medium-${build}`);
        check(tokens.map(token => token.text || '').join('').includes('CACHE_MAP_DONE'), `build ${build} (medium): completes`);
      }
      // C2：切换 ultra → 归一 max 后降级 deep
      runner.setIntelligence('ultra', true);
      for (let build = 2; build < builds; build += 1) {
        const tokens = await runner.process(`stress-build-ultra-${build}`);
        check(tokens.map(token => token.text || '').join('').includes('CACHE_MAP_DONE'), `build ${build} (ultra): completes`);
      }

      const requestsPerBuild = toolRoundsPerBuild + 1;
      const totalCalls = builds * requestsPerBuild;
      check(agentServer.requests.length === totalCalls, `volume: ${totalCalls} agent provider requests across ${builds} Builds (${agentServer.requests.length})`);

      // 全链路映射：medium Build 全部 balanced，ultra Build 全部 deep
      const requestEfforts = agentServer.requests.map(req => (JSON.parse(req.body) as { reasoning_effort?: string }).reasoning_effort);
      const mediumCalls = 2 * requestsPerBuild;
      const ultraCalls = (builds - 2) * requestsPerBuild;
      check(requestEfforts.slice(0, mediumCalls).every(effort => effort === 'balanced'),
        `agent chain: medium Builds carry native "balanced" (${mediumCalls} requests)`);
      check(requestEfforts.slice(mediumCalls).every(effort => effort === 'deep'),
        `agent chain: ultra Builds carry native "deep" (${ultraCalls} requests)`);

      // system 前缀：每 Build 首请求 bootstrap，tool 子轮共享字节级稳定前缀
      for (let build = 0; build < builds; build += 1) {
        const start = build * requestsPerBuild;
        const systems = agentServer.requests.slice(start, start + requestsPerBuild).map(req => {
          const body = JSON.parse(req.body) as { messages?: Array<{ role: string; content: string }> };
          return (body.messages || []).filter(message => message.role === 'system').map(message => message.content).join('');
        });
        check(systems[0].includes('## Build Context Bootstrap'), `build ${build}: first request injects Build bootstrap`);
        const stableTail = systems.slice(1);
        check(new Set(stableTail).size === 1, `build ${build}: ${toolRoundsPerBuild} tool sub-turns share one byte-stable system prefix`);
        check(!stableTail[0].includes('reasoning_effort') && !stableTail[0].includes('balanced') && !stableTail[0].includes('deep'),
          `build ${build}: mapped effort stays out of the cache prefix`);
      }

      // 缓存命中率统计：contextWindow 与模拟 usage 一致且保持高位
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
      check(Number(window.providerCacheReadRatio) >= 0.9,
        'cache-hit pressure: ratio stays near-total under mapped native effort tiers');
    } finally {
      await agentServer.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log(`\nthinkingTierMapCacheStressVerify: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
