import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { getEventListeners } from 'events';
import { Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { LLMProvider } from '../llm/provider';

class ShortJsonDeadline extends Dispatcher {
  private readonly delegate = new Agent();
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return this.delegate.dispatch({ ...options, headersTimeout: 45, bodyTimeout: 45 }, handler);
  }
  async close(): Promise<void> { await this.delegate.close(); }
}

export async function probeProviderJsonLifecycle(): Promise<Array<Record<string, unknown>>> {
  const original = getGlobalDispatcher();
  const short = new ShortJsonDeadline();
  const requests = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      const route = req.url?.split('/')[1] || '';
      requests.set(route, (requests.get(route) || 0) + 1);
      const json = JSON.stringify({ choices: [{ message: { content: 'json-slow-success' } }], content: [{ type: 'text', text: 'json-slow-success' }] });
      if (route !== 'headers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(json.slice(0, 5));
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (route === 'headers') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(json); }
        else res.end(json.slice(5));
      }, 1800);
      timers.add(timer);
      res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rows: Array<Record<string, unknown>> = [];
  try {
    for (const route of ['headers', 'body', 'cancel', 'deadline', 'anthropic']) {
      setGlobalDispatcher(route === 'cancel' || route === 'deadline' ? original : short);
      const provider = new LLMProvider('json-local-fixture', `${base}/${route}`, 'fixture', route === 'anthropic' ? 'anthropic' : 'openai', 'chat', true,
        route === 'deadline' ? 60 : 0, undefined, { enabled: false });
      // Select the production remote-fetch branch while retaining an actual
      // local socket. This avoids external DNS/TLS or a global host override.
      (provider as unknown as { isPlainHttpLoopback(url: string): boolean }).isPlainHttpLoopback = () => false;
      const controller = new AbortController();
      const cancel = route === 'cancel' ? setTimeout(() => controller.abort(), 60) : undefined;
      const watchdog = setTimeout(() => controller.abort(), 6000);
      const started = Date.now();
      let text = '';
      let errorName = '';
      let errorCode = '';
      try { text = await provider.chat('fixture', [{ role: 'user', content: 'title fixture' }], null, 0, 32, controller.signal); }
      catch (error) {
        errorName = error instanceof Error ? error.name : String(error);
        errorCode = (error as { cause?: { code?: string } }).cause?.code || '';
      } finally { clearTimeout(cancel); clearTimeout(watchdog); }
      rows.push({ route, text, errorName, errorCode, elapsedMs: Date.now() - started, requests: requests.get(route) || 0 });
    }
  } finally {
    setGlobalDispatcher(original);
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await short.close();
  }
  return rows;
}

export async function verifyProviderJsonLifecycle(): Promise<void> {
  const rows = await probeProviderJsonLifecycle();
  for (const row of rows) {
    const expectedError = row.route === 'cancel' ? 'AbortError' : row.route === 'deadline' ? 'TimeoutError' : '';
    assert.strictEqual(row.errorName, expectedError, `${row.route}: ${JSON.stringify(row)}`);
    assert.strictEqual(row.requests, 1, `${row.route}: a valid JSON model request must not be sent twice`);
    if (expectedError) assert.ok(Number(row.elapsedMs) < 1200 && !row.text, `${row.route}: body reading remains controlled after headers`);
    else assert.strictEqual(row.text, 'json-slow-success', `${row.route}: complete JSON model output`);
    console.log(`  [PASS] provider JSON lifecycle: ${row.route} preserves response, request count and caller policy`);
  }
  console.log('providerJsonLifecycleVerify: 15 assertions passed');
  const streamingRows = await probeStreamingBodyLifecycle();
  for (const row of streamingRows) {
    const cancelling = String(row.scenario).startsWith('cancel');
    assert.strictEqual(row.errorName, cancelling ? 'AbortError' : '', JSON.stringify(row));
    assert.strictEqual(row.requests, row.scenario === 'temperature' ? 2 : 1, JSON.stringify(row));
    assert.strictEqual(row.closed, row.requests, `every response closes: ${JSON.stringify(row)}`);
    assert.strictEqual(row.abortListeners, 0, `forwarding listener released: ${JSON.stringify(row)}`);
    if (cancelling) assert.ok(Number(row.elapsedMs) < 900 && !row.text, `body remains cancellable: ${JSON.stringify(row)}`);
    else if (row.scenario === 'error') assert.match(String(row.text), /fixture permission denied/, JSON.stringify(row));
    else assert.strictEqual(row.text, 'stream-request-json-success', JSON.stringify(row));
    if (row.scenario === 'temperature') assert.deepStrictEqual(row.temperatures, [true, false], JSON.stringify(row));
    console.log(`  [PASS] streaming request body: ${row.mode}/${row.scenario} preserves cancellation, body and request lifecycle`);
  }
  console.log('providerJsonLifecycleVerify: streaming-response compatibility 62 additional assertions passed');
}

/** A stream request can legally be answered with buffered JSON or an HTTP error. */
export async function probeStreamingBodyLifecycle(): Promise<Array<Record<string, unknown>>> {
  const records = new Map<string, { requests: number; closed: number; temperatures: boolean[] }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const headersReady = new Map<string, () => void>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.once('end', () => {
      const route = req.url?.split('/')[1] || '';
      const scenario = route.slice(route.indexOf('-') + 1);
      const record = records.get(route) || { requests: 0, closed: 0, temperatures: [] };
      record.requests += 1;
      record.temperatures.push(Object.hasOwn(JSON.parse(body), 'temperature'));
      records.set(route, record);
      const temperatureRejection = (scenario === 'temperature' || scenario === 'cancel-temperature') && record.requests === 1;
      const isError = temperatureRejection || scenario === 'error' || scenario === 'cancel-error';
      const json = JSON.stringify(isError
        ? { error: { message: temperatureRejection ? 'Unsupported parameter: temperature' : 'fixture permission denied', param: temperatureRejection ? 'temperature' : 'fixture' } }
        : { status: 'completed', choices: [{ message: { content: 'stream-request-json-success' }, finish_reason: 'stop' }], output: [{ type: 'message', content: [{ type: 'output_text', text: 'stream-request-json-success' }] }] });
      res.writeHead(isError ? (scenario === 'cancel-error' ? 403 : 400) : 200, { 'Content-Type': 'application/json' });
      res.write(json.slice(0, 5));
      headersReady.get(route)?.();
      const timer = setTimeout(() => { timers.delete(timer); res.end(json.slice(5)); }, scenario.startsWith('cancel') ? 1400 : 35);
      timers.add(timer);
      res.once('close', () => { record.closed += 1; clearTimeout(timer); timers.delete(timer); });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rows: Array<Record<string, unknown>> = [];
  try {
    for (const mode of ['chat_stream', 'responses'] as const) {
      for (const scenario of ['json', 'error', 'temperature', 'cancel-json', 'cancel-error', 'cancel-temperature']) {
        const route = `${mode}-${scenario}`;
        const ready = new Promise<void>(resolve => headersReady.set(route, resolve));
        const provider = new LLMProvider('stream-json-fixture', `${base}/${route}`, 'fixture', 'openai', mode, true, 0, undefined, { enabled: false });
        const controller = new AbortController();
        const started = Date.now();
        let text = '';
        let errorName = '';
        const consume = (async () => {
          try {
            for await (const token of provider.chatStreamWithTools('fixture', [{ role: 'user', content: 'fixture' }], null, 0, 32, [], controller.signal)) {
              if (token.type === 'text') text += token.text;
            }
          } catch (error) { errorName = error instanceof Error ? error.name : String(error); }
        })();
        const watchdog = setTimeout(() => controller.abort(), 4000);
        try {
          await ready;
          if (scenario.startsWith('cancel')) {
            await new Promise(resolve => setTimeout(resolve, 80));
            controller.abort();
          }
          await consume;
        } finally { clearTimeout(watchdog); }
        const elapsedMs = Date.now() - started;
        const record = records.get(route)!;
        for (let i = 0; i < 40 && record.closed < record.requests; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
        rows.push({ mode, scenario, text, errorName, elapsedMs, ...record, abortListeners: getEventListeners(controller.signal, 'abort').length });
      }
    }
  } finally {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return rows;
}

if (require.main === module) verifyProviderJsonLifecycle().catch(error => { console.error(error); process.exitCode = 1; });
