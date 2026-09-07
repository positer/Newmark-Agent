/** Real protocol usage counters retain reported zero, absence, and input semantics. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { normalizeProviderUsage } from '../providers/provider-events';
import { extractProviderUsage } from '../core/agentKernelDiagnostics';
import { LLMProvider } from '../llm/provider';
import type { StreamToken } from '../core/types';

const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, passed: false, error: String(error) }); console.log('FAIL ' + name + ': ' + error); }
}
const normalize = normalizeProviderUsage as (value: unknown, options?: { protocol?: 'openai' | 'anthropic' | 'github_models' }) => any;
const extract = extractProviderUsage as (value: unknown, options?: { protocol?: 'openai' | 'anthropic' | 'github_models' }) => any;
const flags = (input: boolean, output: boolean, cacheRead: boolean, cacheWrite: boolean) => ({ input, output, cacheRead, cacheWrite });

async function main() {
  await check('absent usage objects do not manufacture measured zero', () => {
    for (const payload of [null, {}, { usage: {} }, { response: { status: 'completed' } }]) assert.equal(normalize(payload), null);
  });
  await check('reported input/output without cache stays cache-unknown', () => {
    const usage = normalize({ prompt_tokens: 100, completion_tokens: 5 });
    assert.deepEqual(usage.reported, flags(true, true, false, false));
    assert.equal(usage.cacheReadTokens, 0);
  });
  await check('explicit zero cache is reported even when no tokens were cached', () => {
    assert.deepEqual(normalize({ input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }).reported, flags(true, true, true, false));
  });
  await check('explicit input/output zeros take precedence over compatible aliases', () => {
    const usage = normalize({ input_tokens: 0, prompt_tokens: 91, output_tokens: 0, completion_tokens: 12 });
    assert.equal(usage.inputTokens, 0); assert.equal(usage.outputTokens, 0);
    assert.deepEqual(usage.reported, flags(true, true, false, false));
  });
  await check('invalid or absent scalar values do not become measured zero', () => {
    for (const value of [null, '', '  ', true, false, -1, Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      const usage = normalize({ input_tokens: value, output_tokens: 3, cached_tokens: value });
      assert.deepEqual(usage.reported, flags(false, true, false, false));
    }
  });
  await check('compatible finite numeric strings retain zero and normalize integers', () => {
    const usage = normalize({ prompt_tokens: '120.8', completion_tokens: '7', cached_tokens: '0' });
    assert.equal(usage.inputTokens, 120); assert.equal(usage.outputTokens, 7);
    assert.deepEqual(usage.reported, flags(true, true, true, false));
  });
  await check('malformed alias does not hide a valid compatible field', () => {
    const usage = normalize({ input_tokens: 'not-a-count', prompt_tokens: 120, cached_tokens: {}, prompt_tokens_details: { cached_tokens: 100 } });
    assert.equal(usage.inputTokens, 120); assert.equal(usage.cacheReadTokens, 100);
  });
  await check('Responses and Chat nested shapes preserve separate read/write presence', () => {
    const usage = normalize({ response: { usage: { input_tokens: 200, output_tokens: 5, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 } } } });
    assert.deepEqual(usage.reported, flags(true, true, true, true));
    assert.equal(usage.inputTokens, 200); assert.equal(usage.cacheReadTokens, 80); assert.equal(usage.cacheWriteTokens, 20);
  });
  await check('DeepSeek documented cache-hit count uses total prompt tokens as input', () => {
    const usage = normalize({ prompt_tokens: 1000, completion_tokens: 9, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
    assert.equal(usage.inputTokens, 1000); assert.equal(usage.cacheReadTokens, 800);
    assert.deepEqual(usage.reported, flags(true, true, true, false));
  });
  await check('DeepSeek explicit zero cache-hit count remains a measured miss', () => {
    const usage = normalize({ prompt_tokens: 1000, completion_tokens: 9, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 });
    assert.equal(usage.cacheReadTokens, 0); assert.equal(usage.reported.cacheRead, true);
  });
  await check('Anthropic explicit protocol totals uncached plus cache reads and writes', () => {
    const usage = normalize({ input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 150 }, { protocol: 'anthropic' });
    assert.equal(usage.inputTokens, 1000); assert.equal(usage.totalTokens, 1010);
    assert.deepEqual(usage.reported, flags(true, true, true, true));
  });
  await check('compatible OpenAI aliases do not imply Anthropic input semantics', () => {
    const usage = normalize({ input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 150 });
    assert.equal(usage.inputTokens, 1000); assert.equal(usage.totalTokens, 1010);
  });
  await check('legacy dedicated protocol extractor shares presence and alias normalization', () => {
    const usage = extract({ usage: { prompt_tokens: 100, completion_tokens: 4, cached_tokens: 0 } });
    assert.deepEqual(usage.reported, flags(true, true, true, false));
    assert.equal(extract({ usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 150 } }, { protocol: 'anthropic' }).input, 1000);
  });
  await check('empty dedicated usage has all presence flags false', () => assert.deepEqual(extract({}).reported, flags(false, false, false, false)));

  let server: http.Server | undefined;
  const sockets = new Set<net.Socket>();
  const requests: Array<{ path: string; input: string }> = [];
  try {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const input = JSON.stringify(body.messages || body.input || []);
        requests.push({ path: req.url || '', input });
        if (input.includes('ERROR')) {
          res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture temporary failure' } })); return;
        }
        if (input.includes('FALLBACK') && !req.url?.endsWith('/responses')) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Use Responses API for this model' } })); return;
        }
        const usage = input.includes('ABSENT') ? undefined : input.includes('ZERO')
          ? { input_tokens: 1000, prompt_tokens: 1000, output_tokens: 10, completion_tokens: 10, input_tokens_details: { cached_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 } }
          : { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 150 };
        if (input.includes('SSE') || (req.url?.includes('/inference/') && body.stream)) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const emit = (value: unknown) => res.write('data: ' + JSON.stringify(value) + '\n\n');
          if (req.url?.endsWith('/responses')) {
            emit({ type: 'response.output_text.delta', delta: 'OK' });
            emit({ type: 'response.completed', response: { status: 'completed', usage } });
          } else {
            if (input.includes('SSE')) emit({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2 } });
            emit({ choices: [{ delta: { content: 'OK' } }] });
            emit({ choices: [{ finish_reason: 'stop', delta: {} }], usage });
            res.write('data: [DONE]\n\n');
          }
          res.end(); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url?.endsWith('/messages')
          ? { content: [{ type: 'text', text: 'OK' }], usage }
          : req.url?.endsWith('/responses')
            ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }], usage }
            : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }], usage }));
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`;
    for (const [protocol, mode] of [['openai', 'chat_stream'], ['openai', 'responses'], ['anthropic', 'chat_stream'], ['github_models', 'chat_stream']] as const) {
      const provider = new LLMProvider('usage-local', base, 'fixture-only', protocol, mode, true, 0, undefined, { enabled: false });
      const collect = async (text: string) => {
        const tokens: StreamToken[] = [];
        for await (const token of provider.chatStreamWithTools('usage-fixture', [{ role: 'user', content: text }], 'stable system', 0, 32, [])) tokens.push(token);
        return tokens;
      };
      await check(`${protocol}/${mode} auxiliary JSON chat reports usage exactly once`, async () => {
        const usages: any[] = [];
        const reply = await (provider.chat as any)('usage-fixture', [{ role: 'user', content: 'ZERO' }], 'stable system', 0, 32, undefined, undefined, (usage: any) => usages.push(usage));
        assert.equal(reply, 'OK'); assert.equal(usages.length, 1);
        assert.deepEqual(usages[0].reported, flags(true, true, true, false));
      });
      await check(`${protocol}/${mode} auxiliary JSON chat reports missing measurement once`, async () => {
        const usages: any[] = [];
        const reply = await (provider.chat as any)('usage-fixture', [{ role: 'user', content: 'ABSENT' }], 'stable system', 0, 32, undefined, undefined, (usage: any) => usages.push(usage));
        assert.equal(reply, 'OK'); assert.equal(usages.length, 1);
        assert.deepEqual(usages[0].reported, flags(false, false, false, false));
      });
      await check(`${protocol}/${mode} failed auxiliary response does not manufacture successful usage`, async () => {
        const usages: any[] = [];
        const result = await (provider.chat as any)('usage-fixture', [{ role: 'user', content: 'ERROR' }], 'stable system', 0, 32, undefined, undefined, (usage: any) => usages.push(usage)).catch((error: unknown) => String(error));
        assert.ok(String(result).includes('503')); assert.equal(usages.length, 0);
      });
      await check(`${protocol}/${mode} real HTTP zero usage retains presence at StreamToken`, async () => {
        const tokens = await collect('ZERO'); const usage: any = tokens.find(t => t.type === 'usage')?.usage;
        assert.equal(tokens.filter(t => t.type === 'text').map(t => t.text).join(''), 'OK');
        assert.deepEqual(usage?.reported, flags(true, true, true, false));
      });
      await check(`${protocol}/${mode} real HTTP absent usage stays unreported`, async () => {
        const tokens = await collect('ABSENT');
        assert.equal(tokens.filter(t => t.type === 'text').map(t => t.text).join(''), 'OK');
        for (const token of tokens.filter(t => t.type === 'usage')) assert.deepEqual((token.usage as any)?.reported, flags(false, false, false, false));
      });
      if (protocol === 'anthropic') await check('Anthropic transport explicitly normalizes total input', async () => {
        const tokens = await collect('CACHE'); const usage: any = tokens.find(t => t.type === 'usage')?.usage;
        assert.equal(usage?.input, 1000); assert.equal(usage?.cacheRead, 800); assert.equal(usage?.cacheWrite, 150);
      });
      if (protocol === 'anthropic') await check('Anthropic auxiliary JSON chat normalizes total input', async () => {
        const usages: any[] = [];
        await (provider.chat as any)('usage-fixture', [{ role: 'user', content: 'CACHE' }], 'stable system', 0, 32, undefined, undefined, (usage: any) => usages.push(usage));
        assert.equal(usages.length, 1); assert.equal(usages[0].input, 1000);
      });
      if (protocol === 'openai' && mode === 'chat_stream') await check('Chat-to-Responses auxiliary fallback invokes usage callback exactly once', async () => {
        const usages: any[] = []; const before = requests.length;
        const reply = await (provider.chat as any)('usage-fixture', [{ role: 'user', content: 'FALLBACK ZERO' }], 'stable system', 0, 32, undefined, undefined, (usage: any) => usages.push(usage));
        assert.equal(reply, 'OK'); assert.equal(requests.length - before, 2); assert.equal(usages.length, 1);
        assert.deepEqual(usages[0].reported, flags(true, true, true, false));
      });
      if (protocol !== 'anthropic') await check(`${protocol}/${mode} SSE preserves measured zero after incomplete cumulative usage`, async () => {
        const tokens = await collect('SSE ZERO');
        const usages = tokens.filter(t => t.type === 'usage').map(t => t.usage as any);
        assert.equal(tokens.filter(t => t.type === 'text').map(t => t.text).join(''), 'OK');
        assert.equal(usages.length, mode === 'responses' ? 1 : 2);
        if (usages.length === 2) assert.deepEqual(usages[0].reported, flags(true, true, false, false));
        assert.deepEqual(usages.at(-1).reported, flags(true, true, true, false));
      });
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  const failures = checks.filter(c => !c.passed).length;
  if (process.env.NEWMARK_PROVIDER_USAGE_REPORT) fs.writeFileSync(process.env.NEWMARK_PROVIDER_USAGE_REPORT, JSON.stringify({ checks, requests, passed: checks.length - failures, failed: failures }, null, 2) + '\n');
  console.log(`providerUsageReportingVerify: ${checks.length - failures} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
