import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';
import { defaultConfig } from '../core/config';
import { IntelligenceTier, LLMProvider } from '../llm/provider';

const tiers: IntelligenceTier[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const originalFetch = globalThis.fetch;
const captured: Array<{ url: string; body: Record<string, any> }> = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body || '{}')) as Record<string, any>;
  captured.push({ url, body });
  if (url.endsWith('/responses')) {
    return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

async function run(): Promise<void> {
  try {
    const chat = new LLMProvider('fixture', 'https://gateway.example/v1', 'secret', 'openai', 'chat');
    const responses = new LLMProvider('fixture', 'https://gateway.example/v1', 'secret', 'openai', 'responses');
    for (let round = 0; round < 50; round++) {
      for (const tier of tiers) {
        const cfg = chat.intelligenceConfig(tier);
        assert.equal(cfg.reasoningEffort, tier === 'ultra' ? 'max' : tier);
        assert.equal(await chat.chat('gpt-5.6-codex', [{ role: 'user', content: 'ping' }], null, cfg.temperature, cfg.maxTokens, undefined, cfg.reasoningEffort), 'ok');
        assert.equal(captured.at(-1)?.body.reasoning_effort, tier === 'ultra' ? 'max' : tier);
        assert.equal(await responses.chat('gpt-5.6-codex', [{ role: 'user', content: 'ping' }], null, cfg.temperature, cfg.maxTokens, undefined, cfg.reasoningEffort), 'ok');
        assert.equal(captured.at(-1)?.body.reasoning?.effort, tier === 'ultra' ? 'max' : tier);
      }
    }
    assert.equal(captured.length, 600);

    await chat.chat('plain-text-model', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'max');
    assert.equal('reasoning_effort' in (captured.at(-1)?.body || {}), false);

    const official = new LLMProvider('OpenAI', 'https://api.openai.com/v1', 'secret', 'openai', 'chat');
    await official.chat('gpt-5.6-codex', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'max');
    assert.equal(captured.at(-1)?.body.reasoning_effort, 'xhigh');

    // ---- dev-0.4.3 thinking_tier_map：模型原生档位映射 ----
    const mappedChat = new LLMProvider('mapped', 'https://gateway.example/v1', 'secret', 'openai', 'chat', undefined, undefined, {
      'native-effort-model': { minimal: 'low', balanced: 'medium', deep: 'high' },
    });
    // 精确命中：Newmark medium → 模型原生 balanced
    await mappedChat.chat('native-effort-model', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'medium');
    assert.equal(captured.at(-1)?.body.reasoning_effort, 'balanced');
    // 降级命中：Newmark max 未声明 → 就近取不高于 max 的最高档 deep
    await mappedChat.chat('native-effort-model', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'max');
    assert.equal(captured.at(-1)?.body.reasoning_effort, 'deep');
    // ultra 归一为 max → deep
    await mappedChat.chat('native-effort-model', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'ultra');
    assert.equal(captured.at(-1)?.body.reasoning_effort, 'deep');
    // Newmark high 精确命中 → deep
    await mappedChat.chat('native-effort-model', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'high');
    assert.equal(captured.at(-1)?.body.reasoning_effort, 'deep');
    // 目标档位低于全部已声明档位：取最低档 minimal
    await mappedChat.chat('native-effort-model', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'low');
    assert.equal(captured.at(-1)?.body.reasoning_effort, 'minimal');

    // 未配置映射的模型：默认不变动映射（模型名匹配时 Newmark 档位名原样透传）
    await mappedChat.chat('gpt-5.6-codex', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'xhigh');
    assert.equal(captured.at(-1)?.body.reasoning_effort, 'xhigh');
    // 未配置映射且模型名不匹配思考模型正则：维持原行为，不发送 effort
    await mappedChat.chat('plain-other-model', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'xhigh');
    assert.equal('reasoning_effort' in (captured.at(-1)?.body || {}), false);

    // responses 协议同样走映射
    const mappedResponses = new LLMProvider('mapped-resp', 'https://gateway.example/v1', 'secret', 'openai', 'responses', undefined, undefined, {
      'native-effort-model': { minimal: 'low', balanced: 'medium', deep: 'high' },
    });
    await mappedResponses.chat('native-effort-model', [{ role: 'user', content: 'ping' }], null, 0, 32, undefined, 'max');
    assert.equal(captured.at(-1)?.body.reasoning?.effort, 'deep');

    // v2 adapter chat 路径也携带映射后的原生档位名
    const mappedV2 = new LLMProvider('mapped-v2', 'https://gateway.example/v1', 'secret', 'openai', 'chat_stream', true, undefined, {
      'native-effort-model': { minimal: 'low', balanced: 'medium', deep: 'high' },
    });
    const v2Tokens: string[] = [];
    for await (const token of mappedV2.chatStreamWithTools('native-effort-model', [{ role: 'user', content: 'ping' }], null, 0, 32, [], undefined, 'max')) {
      v2Tokens.push(token.type);
    }
    assert.equal(captured.at(-1)?.body.reasoning_effort, 'deep');
    assert.ok(v2Tokens.includes('text'), 'mapped v2 chat: emits text token');

    const config = defaultConfig();
    assert.deepEqual(config.models.default_intelligence._values, tiers);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-intelligence-tier-'));
    try {
      const agent = new Agent(root, { agentOnly: true });
      for (const tier of tiers) {
        agent.setIntelligence(tier, true);
        assert.equal(agent.intelligence, tier);
        assert.equal(new Agent(root, { agentOnly: true }).intelligence, tier);
      }
      agent.setIntelligence('not-a-tier', true);
      assert.equal(agent.intelligence, 'medium');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ ok: true, tiers, capturedRequests: 610, perProtocolStressRequests: 300, thinkingTierMapCases: 8 }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch(error => {
  globalThis.fetch = originalFetch;
  console.error(error);
  process.exit(1);
});
