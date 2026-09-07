'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net');
const assert = require('node:assert/strict'), { getEventListeners } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { LLMProvider } = require('../dist/llm/provider');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const rounds = Number(option('--rounds', '24'));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 200) throw Error('rounds must be 1..200');
const output = path.resolve(option('--out', path.join(process.cwd(), 'user-soak-transport.json')));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = body => 'data: ' + JSON.stringify(body) + '\n\n';
const samples = [], failures = [], counts = {}, warnings = [], openResponses = new Set(), sockets = new Set(), tunnels = new Set();
const requestPlans = new Map(), latencies = [], checkpoints = [];
let received = 0, closed = 0, peakOpenResponses = 0, maxAbortListeners = 0;
const startedAt = new Date().toISOString(), start = performance.now();
const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
process.on('warning', w => warnings.push({ name: w.name, message: w.message }));
const variants = [
  { name: 'chat-sse', protocol: 'openai', mode: 'chat_stream' },
  { name: 'responses-sse', protocol: 'openai', mode: 'responses' },
  { name: 'github-sse', protocol: 'github_models', mode: 'chat_stream' },
  { name: 'chat-json', protocol: 'openai', mode: 'chat', json: true },
  { name: 'anthropic-json', protocol: 'anthropic', mode: 'chat_stream', json: true },
];
const percentile = (values, p) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : 0;
const server = http.createServer(async (req, res) => {
  try {
    let body = ''; for await (const bytes of req) body += bytes;
    const parsed = JSON.parse(body), plan = requestPlans.get(parsed.model);
    if (!plan) { res.writeHead(400); res.end('Unknown isolated fixture request'); return; }
    received++; openResponses.add(res); peakOpenResponses = Math.max(peakOpenResponses, openResponses.size);
    res.once('close', () => { closed++; openResponses.delete(res); });
    if (plan.action === '503') { res.writeHead(503, { 'content-type': 'application/json', 'retry-after-ms': '25' }); res.end('{"error":{"message":"SOAK_TRANSIENT"}}'); return; }
    res.writeHead(200, { 'content-type': plan.variant.json ? 'application/json' : 'text/event-stream' });
    const marker = plan.marker;
    if (plan.variant.json) {
      const result = plan.variant.protocol === 'anthropic'
        ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: marker }], usage: { input_tokens: 10, output_tokens: 4 } }
        : { choices: [{ message: { role: 'assistant', content: marker }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } };
      const encoded = JSON.stringify(result);
      if (plan.action === 'abort') { res.write(encoded.slice(0, 15)); plan.abortTimer = setTimeout(() => { plan.abortedAt = performance.now(); plan.controller.abort(); }, 10); }
      else if (plan.action === 'truncate') res.end(encoded.slice(0, -9));
      else res.end(encoded);
      return;
    }
    const first = plan.variant.mode === 'responses'
      ? frame({ type: 'response.output_text.delta', delta: marker })
      : frame({ choices: [{ delta: { content: marker }, finish_reason: null }] });
    res.write(first);
    if (plan.action === 'abort') plan.abortTimer = setTimeout(() => { plan.abortedAt = performance.now(); plan.controller.abort(); }, 10);
    else if (plan.action === 'truncate') res.end();
    else if (plan.action !== 'early') {
      res.write(plan.variant.mode === 'responses'
        ? frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 4 } } })
        : frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) + 'data: [DONE]\n\n');
      // Deliberately held open: a terminal protocol event must release it.
    }
  } catch (error) { res.destroy(); failures.push({ phase: 'fixture', error: String(error) }); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
// An isolated HTTP CONNECT proxy exercises remote-style dispatch without DNS,
// external traffic, user proxy configuration or any actual provider credential.
const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
proxy.on('connect', (req, client, head) => {
  if (req.url !== `soak.invalid:${server.address().port}`) { client.destroy(); return; }
  const upstream = net.connect(server.address().port, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  tunnels.add(client); tunnels.add(upstream);
  const close = () => { client.destroy(); upstream.destroy(); tunnels.delete(client); tunnels.delete(upstream); };
  client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
});
function snapshot(round) {
  const memory = process.memoryUsage();
  checkpoints.push({ round, elapsedMs: performance.now() - start, ...memory, openResponses: openResponses.size, sockets: sockets.size, tunnels: tunnels.size, resources: process.getActiveResourcesInfo() });
}
function save(passed = false) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - start, rounds, passed, received, closed, peakOpenResponses, maxAbortListeners, counts,
    latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), max: Math.max(0, ...latencies) },
    loopDelayMs: { p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 }, checkpoints, warnings, failures, samples,
    boundary: 'Actual production LLM facade over loopback HTTP and isolated CONNECT proxy. Sequential repeated exchanges, not a claim of equivalent elapsed days. GC checkpoints are explicit diagnostics; natural memory is recorded separately.' }, null, 2) + '\n');
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  let attempt = 0;
  try {
    snapshot(-1);
    for (let round = 0; round < rounds; round++) {
      for (const route of ['direct', 'proxy']) for (const variant of variants) {
        const provider = new LLMProvider('soak', `http://${route === 'direct' ? '127.0.0.1' : 'soak.invalid'}:${server.address().port}/v1`, 'fixture-only', variant.protocol, variant.mode, true, 0, undefined,
          route === 'direct' ? { enabled: false } : { enabled: true, url: `http://127.0.0.1:${proxy.address().port}` });
        for (const action of ['complete', 'abort', ...(variant.json ? [] : ['early']), 'truncate', '503', 'recovered']) {
          const controller = new AbortController(), id = 'soak-' + (++attempt), marker = '公开回复🌟-' + id;
          const plan = { controller, action, variant, marker }; requestPlans.set(id, plan);
          const began = performance.now(); let text = '', error = '', usage = 0;
          const watchdog = setTimeout(() => { plan.watchdog = true; controller.abort(); }, 5000);
          try {
            for await (const token of provider.chatStreamWithTools(id, [{ role: 'user', content: 'isolated transport soak' }], null, 0, 64, [], controller.signal)) {
              if (token.type === 'text') text += token.text || '';
              if (token.type === 'usage') usage++;
              if (action === 'early' && token.type === 'text') break;
            }
          } catch (cause) { error = `${cause.name}: ${cause.message}`; }
          finally { clearTimeout(watchdog); clearTimeout(plan.abortTimer); requestPlans.delete(id); }
          const elapsedMs = performance.now() - began;
          await pause(2);
          const listeners = getEventListeners(controller.signal, 'abort').length;
          maxAbortListeners = Math.max(maxAbortListeners, listeners); latencies.push(elapsedMs);
          let problem = '';
          try {
            assert.ok(!plan.watchdog, 'request required fixture watchdog');
            if (action === 'abort') { assert.match(error, /AbortError/); assert.ok(performance.now() - plan.abortedAt < 500, 'cancellation exceeded 500ms'); }
            else if (action === 'truncate' || action === '503') assert.ok(error || /\[(?:LLM Error|Error)/.test(text), 'failure was not surfaced');
            else { assert.equal(error, ''); assert.equal(text, marker); if (action !== 'early') assert.equal(usage, 1); }
            assert.equal(listeners, 0, 'finished request retained an abort listener on its owner');
          } catch (cause) { problem = cause.message; failures.push({ id, route, protocol: variant.name, action, problem, error, text }); }
          const key = `${route}/${variant.name}/${action}`; counts[key] = (counts[key] || 0) + 1;
          samples.push({ id, key, elapsedMs, abortLatencyMs: plan.abortedAt ? performance.now() - plan.abortedAt : undefined, abortListeners: listeners, passed: !problem });
          if (failures.length >= 8) throw Error('Stopped after eight reproducible failures; retain evidence before more load');
        }
      }
      snapshot(round);
      if (global.gc && (round === 2 || round === rounds - 1)) { global.gc(); await pause(20); snapshot('gc-' + round); }
      save(); console.log(`transport round=${round + 1}/${rounds} requests=${received} failures=${failures.length} activeBodies=${openResponses.size}`);
    }
    await pause(100);
    assert.equal(openResponses.size, 0, 'response bodies remained owned after the cycle');
    assert.equal(received, attempt, 'hidden transport retries changed the request count');
    assert.ok(!warnings.some(w => w.name === 'MaxListenersExceededWarning'), 'abort/listener accumulation warning');
  } catch (error) { failures.push({ phase: 'soak', error: String(error) }); }
  finally {
    for (const socket of [...sockets, ...tunnels]) socket.destroy();
    server.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => proxy.close(r))]);
    lag.disable(); snapshot('closed'); save(failures.length === 0);
    console.log(JSON.stringify({ passed: failures.length === 0, requests: received, elapsedMs: performance.now() - start, failures: failures.length, output }));
    if (failures.length) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
