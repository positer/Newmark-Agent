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
    console.log(JSON.stringify({ ok: true, tiers, capturedRequests: 602, perProtocolStressRequests: 300 }));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

run().catch(error => {
  globalThis.fetch = originalFetch;
  console.error(error);
  process.exit(1);
});
