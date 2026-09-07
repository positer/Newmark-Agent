/** Build-scoped provider identity and real loopback transport behavior. */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { Agent, type BuildProviderCache } from '../core/agent';
import { LLMProvider, type OpenAITransportMode } from '../llm/provider';

const checks: Array<{ name: string; passed: boolean }> = [];
function check(passed: boolean, name: string): void {
  checks.push({ name, passed });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}`);
}

function fixture(baseUrl = 'http://127.0.0.1:1/v1') {
  const state = {
    model: {
      provider_id: 'fixture-id', provider: 'fixture', name: 'fixture-model',
      logical_model_group_id: 'fixture-group', provider_url: baseUrl,
      api_key: 'test-only-value', provider_protocol: 'openai',
      thinking_tier_map: { medium: 'medium', high: 'high' },
    } as Record<string, unknown> | undefined,
    apiMode: 'chat_stream' as OpenAITransportMode,
    adapters: true,
    proxy: { enabled: false, url: '', auth: '' } as { enabled?: boolean; url: string; auth: string },
  };
  // The real method runs on a narrow owner fixture: no Agent constructor,
  // user configuration, persistent runtime, or model-resolution mock transport.
  const agent: Agent = Object.assign(Object.create(Agent.prototype), {
    forcedProvider: null, forcedProviderDeployment: '',
    activeModelConfig: () => state.model,
    activeDeployment: () => state.model ? {
      providerId: state.model.provider_id, modelId: state.model.name,
      logicalModelGroupId: state.model.logical_model_group_id,
    } : null,
    config: { openAIApiMode: () => state.apiMode, contextFlag: () => state.adapters },
    providerProxyConfig: () => ({ ...state.proxy }),
  });
  return { state, agent };
}

async function main(): Promise<void> {
  const environmentKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
  const oldEnvironment = environmentKeys.map(key => [key, process.env[key]] as const);
  let server: http.Server | undefined;
  const sockets = new Set<net.Socket>();
  try {
    for (const key of environmentKeys) delete process.env[key];
    const { state, agent } = fixture();
    check(agent.engineModel() !== agent.engineModel(), 'unscoped callers retain existing fresh-provider semantics');
    const cache: BuildProviderCache = {};
    const first = agent.engineModel(cache)!;
    check(first === agent.engineModel(cache), 'same Build and configuration reuse one provider');
    check(first !== agent.engineModel({}), 'independent Builds do not share providers');
    state.model = { ...state.model, thinking_tier_map: { high: 'high', medium: 'medium' } };
    check(first === agent.engineModel(cache), 'equivalent reallocated configuration and mapping order reuse provider');
    const serializedCacheKey = String(cache.key || '');
    check(/^[a-f0-9]{64}$/.test(serializedCacheKey) && !serializedCacheKey.includes('test-only-value'), 'cache key is a digest and does not retain raw credential text');

    const invalidations: Array<[string, (s: ReturnType<typeof fixture>['state']) => void]> = [
      ['provider identity', s => { s.model!.provider_id = 'second-id'; }],
      ['provider name', s => { s.model!.provider = 'second-provider'; }],
      ['model identity', s => { s.model!.name = 'second-model'; }],
      ['logical deployment group', s => { s.model!.logical_model_group_id = 'second-group'; }],
      ['endpoint URL', s => { s.model!.provider_url = 'http://127.0.0.1:2/v1'; }],
      ['credential', s => { s.model!.api_key = 'rotated-test-only-value'; }],
      ['provider protocol', s => { s.model!.provider_protocol = 'github_models'; }],
      ['API mode', s => { s.apiMode = 'responses'; }],
      ['adapter flag', s => { s.adapters = false; }],
      ['thinking map', s => { s.model!.thinking_tier_map = { high: 'medium' }; }],
      ['proxy enable flag', s => { s.proxy.enabled = true; }],
      ['proxy endpoint', s => { s.proxy.url = 'http://127.0.0.1:2'; }],
      ['proxy authentication', s => { s.proxy.auth = 'fixture:rotated'; }],
    ];
    for (const [name, change] of invalidations) {
      const f = fixture(), local: BuildProviderCache = {};
      const previous = f.agent.engineModel(local);
      change(f.state);
      check(previous !== f.agent.engineModel(local), `changing ${name} invalidates the Build cache`);
    }
    const env = fixture(), envCache: BuildProviderCache = {};
    env.state.proxy.enabled = undefined;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3';
    const envFirst = env.agent.engineModel(envCache);
    process.env.HTTPS_PROXY = 'http://127.0.0.1:4';
    check(envFirst !== env.agent.engineModel(envCache), 'changing effective environment proxy invalidates cached transport');
    env.state.proxy.enabled = false;
    const disabled = env.agent.engineModel(envCache);
    process.env.HTTPS_PROXY = 'http://127.0.0.1:5';
    check(disabled === env.agent.engineModel(envCache), 'disabled proxy ignores irrelevant environment changes');
    env.state.proxy = { enabled: true, url: 'http://127.0.0.1:6', auth: '' };
    const explicit = env.agent.engineModel(envCache);
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7';
    check(explicit === env.agent.engineModel(envCache), 'explicit configured proxy ignores irrelevant environment changes');
    for (const key of environmentKeys) delete process.env[key];

    state.model = undefined;
    check(agent.engineModel(cache) === null && cache.provider === undefined && cache.key === undefined, 'missing model clears the Build candidate rather than using stale credentials');
    state.model = fixture().state.model;
    check(first !== agent.engineModel(cache), 'restoring a model after absence creates a fresh provider');
    const forced = new LLMProvider('forced', 'http://127.0.0.1:1', 'test-only-value');
    Object.assign(agent, { forcedProvider: forced, forcedProviderDeployment: '' });
    check(agent.engineModel(cache) === forced && cache.provider === undefined, 'forced provider retains priority and clears ordinary candidate');
    Object.assign(agent, { forcedProviderDeployment: 'fixture-id\u0000fixture-model' });
    check(agent.engineModel(cache) === forced, 'matching forced deployment retains its existing provider identity');
    Object.assign(agent, { forcedProviderDeployment: 'unmatched-deployment' });
    check(agent.engineModel(cache) !== forced, 'forced deployment mismatch still resolves the ordinary current model');
    Object.assign(agent, { forcedProvider: null, forcedProviderDeployment: '' });

    const requests: Array<{ temperature: boolean; content: string }> = [];
    let stallStarted: (() => void) | undefined;
    let stalledClosed: (() => void) | undefined;
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const content = String(body.messages?.at(-1)?.content || body.input?.at(-1)?.content || '');
        requests.push({ temperature: body.temperature !== undefined, content });
        if (body.temperature !== undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { param: 'temperature', message: 'Unsupported parameter: temperature' } }));
          return;
        }
        if (content === 'STALL') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
          res.on('close', () => stalledClosed?.());
          stallStarted?.();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url?.endsWith('/responses')
          ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
          : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] }));
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const network = fixture(`http://127.0.0.1:${port}/v1`);
    const collect = async (p: LLMProvider, text: string, signal?: AbortSignal): Promise<string> => {
      let result = '';
      for await (const token of p.chatStreamWithTools('fixture-model', [{ role: 'user', content: text }], 'Stable Build system', 0, 32, [], signal)) result += token.text;
      return result;
    };
    for (let i = 0; i < 3; i++) await collect(network.agent.engineModel()!, 'round-' + i);
    check(requests.length === 6 && requests.filter(r => r.temperature).length === 3, 'real HTTP baseline repeats temperature rejection in every fresh instance');
    requests.length = 0;
    const networkCache: BuildProviderCache = {};
    const replies: string[] = [];
    for (let i = 0; i < 3; i++) replies.push(await collect(network.agent.engineModel(networkCache)!, 'round-' + i));
    check(requests.length === 4 && requests.filter(r => r.temperature).length === 1, 'real HTTP Build cache learns unsupported temperature once: three rounds use four requests');
    check(replies.every(reply => reply === 'OK'), 'provider reuse preserves each successful response exactly once');
    const current = network.agent.engineModel(networkCache)!;
    const began = new Promise<void>(resolve => { stallStarted = resolve; });
    const closed = new Promise<void>(resolve => { stalledClosed = resolve; });
    const abort = new AbortController();
    const pending = collect(current, 'STALL', abort.signal).then(() => false, () => true);
    await began; abort.abort(new Error('Fixture stop'));
    check(await pending, 'cancellation still interrupts a cached-provider stalled body');
    const closedOnCancel = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), 1000); timer.unref(); })]);
    check(closedOnCancel, 'cancellation releases the actual stalled server response');
    check(await collect(network.agent.engineModel(networkCache)!, 'healthy-after-stop') === 'OK', 'cancelled request does not poison the provider for later work');
    check(network.agent.engineModel(networkCache) === current, 'successful stop recovery retains the same Build provider');
    const beforeIndependent = requests.length;
    await collect(network.agent.engineModel({})!, 'new-build');
    check(requests.length - beforeIndependent === 2, 'new Build has independent capability state and is not silently globally pooled');
    const beforeResponses = requests.length;
    network.state.apiMode = 'responses';
    const responsesReplies: string[] = [];
    for (let i = 0; i < 3; i++) responsesReplies.push(await collect(network.agent.engineModel(networkCache)!, 'responses-' + i));
    check(requests.length - beforeResponses === 4 && requests.slice(beforeResponses).filter(r => r.temperature).length === 1, 'native Responses mode also learns temperature once after transport change');
    check(responsesReplies.every(reply => reply === 'OK'), 'native Responses reuse preserves all three replies');
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    for (const [key, value] of oldEnvironment) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (process.env.NEWMARK_BUILD_PROVIDER_REUSE_REPORT) {
      fs.writeFileSync(process.env.NEWMARK_BUILD_PROVIDER_REUSE_REPORT, JSON.stringify({ checks, passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length }, null, 2) + '\n');
    }
  }
  const failures = checks.filter(c => !c.passed).length;
  console.log(`buildProviderReuseVerify: ${checks.length - failures} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
