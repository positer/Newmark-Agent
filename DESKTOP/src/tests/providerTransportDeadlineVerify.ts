import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { LLMProvider } from '../llm/provider';
import { ChatCompletionsAdapter, defaultProviderTransport } from '../providers';

// A shorter underlying deadline makes the real transport regression cheap;
// the separate archived probe runs the untouched five-minute runtime default.
class ShortDeadlineDispatcher extends Dispatcher {
  private readonly agent = new Agent();
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.agent.dispatch({ ...options, headersTimeout: 45, bodyTimeout: 45 }, handler);
  }
  async close(): Promise<void> { await this.agent.close(); }
}

export async function verifyProviderTransportDeadline(): Promise<void> {
  const original = getGlobalDispatcher();
  const short = new ShortDeadlineDispatcher();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let requests = 0;
  let checks = 0;
  const check = (condition: boolean, name: string) => {
    assert.ok(condition, name);
    checks += 1;
    console.log(`  [PASS] provider transport deadline: ${name}`);
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      requests += 1;
      if (req.url?.startsWith('/body')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': heartbeat\n\n');
      }
      if (req.url?.startsWith('/hang')) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"slow-success"}}]}\n\ndata: [DONE]\n\n');
      // Undici fast parser timers are coarse; exceed their tick as well as
      // the configured 45ms deadline, rather than assuming exact timing.
      }, 1800);
      timers.add(timer);
      res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    setGlobalDispatcher(short);
    let outsideCode = '';
    try { await fetch(`${base}/headers`); }
    catch (e) { outsideCode = (e as { cause?: { code?: string } }).cause?.code || String(e); }
    check(outsideCode === 'UND_ERR_HEADERS_TIMEOUT', `unrelated global fetch still enforces its own deadline (${outsideCode || 'completed'})`);

    for (const phase of ['headers', 'body']) {
      const before = requests;
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), 5000);
      const provider = new LLMProvider('local-deadline', `${base}/${phase}`, 'fixture', 'openai', 'chat_stream', true);
      let output = '';
      try {
        for await (const token of provider.chatStreamWithTools('fixture', [{ role: 'user', content: 'fixture' }], null, 0, 32, [], controller.signal)) {
          if (token.type === 'text') output += token.text;
        }
      } finally { clearTimeout(watchdog); }
      check(output === 'slow-success' && !controller.signal.aborted, `${phase}: slow but successful LLM stream outlives the lower transport default`);
      check(requests - before === 1, `${phase}: no duplicate non-streaming fallback request`);
    }

    const adapter = new ChatCompletionsAdapter('direct-local-deadline');
    let direct = '';
    for await (const event of adapter.execute({ url: `${base}/body`, headers: {}, body: { stream: true } }, new AbortController().signal, defaultProviderTransport)) {
      if (event.type === 'text.delta') direct += event.delta;
    }
    check(direct === 'slow-success', 'direct adapter transport shares cancellation-only streaming semantics');

    const cancelled = new AbortController();
    const timer = setTimeout(() => cancelled.abort(), 60);
    const before = requests;
    let abortName = '';
    const provider = new LLMProvider('cancel-local-deadline', `${base}/hang`, 'fixture', 'openai', 'chat_stream', true);
    try {
      for await (const _ of provider.chatStreamWithTools('fixture', [{ role: 'user', content: 'fixture' }], null, 0, 32, [], cancelled.signal)) { /* no response */ }
    } catch (e) { abortName = e instanceof Error ? e.name : String(e); }
    finally { clearTimeout(timer); }
    check(abortName === 'AbortError' && requests - before === 1, 'user cancellation remains prompt and never starts a fallback request');
  } finally {
    setGlobalDispatcher(original);
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await short.close();
  }
  console.log(`providerTransportDeadlineVerify: ${checks} assertions passed`);
}

if (require.main === module) verifyProviderTransportDeadline().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
