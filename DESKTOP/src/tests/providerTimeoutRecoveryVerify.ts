/**
 * dev-0.3.13 provider transport/recovery regression gate.
 *
 * The test intentionally exercises the transport at the boundary where the
 * installed Windows build previously chained fetch -> node-http -> PowerShell
 * after a single request deadline.
 */
import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { LLMProvider } from '../llm/provider';
import { readProviderStreamChunk } from '../providers/provider-events';

function check(condition: boolean, message: string): void {
  if (condition) console.log(`  [PASS] ${message}`);
  else console.log(`  [FAIL] ${message}`);
  assert.ok(condition, message);
}

async function startHangingServer(): Promise<{ server: http.Server; port: number; stop(): Promise<void> }> {
  const server = http.createServer(req => {
    req.resume();
    req.once('aborted', () => req.socket.destroy());
  });
  return await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        server,
        port: address.port,
        stop: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
      });
    });
  });
}

async function startTemperatureCompatibilityServer(): Promise<{
  port: number;
  bodies: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      bodies.push(body);
      if (body.temperature !== undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error', param: 'temperature', code: null } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'temperature-compatible' } }] }));
    });
  });
  return await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as net.AddressInfo).port,
    bodies,
    stop: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  })));
}

async function main(): Promise<void> {
  console.log('providerTimeoutRecoveryVerify');
  const originalNodeTransport = LLMProvider.nodeHttpTransport;
  const originalPowerShellTransport = LLMProvider.powershellTransport;
  const originalFetch = globalThis.fetch;
  let nodeFallbacks = 0;
  let powershellFallbacks = 0;
  LLMProvider.nodeHttpTransport = async () => {
    nodeFallbacks += 1;
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'fallback-ok' } }] }) };
  };
  LLMProvider.powershellTransport = async () => {
    powershellFallbacks += 1;
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'powershell-fallback' } }] }) };
  };

  try {
    // An AbortError from fetch is not a transport failure. It must not start a
    // second transport, even when the caller did not provide an AbortSignal.
    globalThis.fetch = (async () => {
      const error = new Error('simulated internal abort');
      error.name = 'AbortError';
      throw error;
    }) as typeof fetch;
    const abortedProvider = new LLMProvider('abort-fixture', 'https://abort-fixture.invalid/v1', 'sk-fixture', 'openai', 'chat', true, 250);
    let abortError = '';
    try {
      await abortedProvider.chat('fixture-model', [{ role: 'user', content: 'hello' }], null, 0, 32);
    } catch (error) {
      abortError = error instanceof Error ? error.name : String(error);
    }
    check(abortError === 'AbortError', 'fetch AbortError is returned directly');
    check(nodeFallbacks === 0 && powershellFallbacks === 0, 'fetch AbortError does not trigger node/PowerShell fallback');

    // A genuine fetch transport failure still retains the documented fallback.
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const fallbackProvider = new LLMProvider('fallback-fixture', 'https://fallback-fixture.invalid/v1', 'sk-fixture', 'openai', 'chat', true, 250);
    const fallbackText = await fallbackProvider.chat('fixture-model', [{ role: 'user', content: 'hello' }], null, 0, 32);
    check(fallbackText === 'fallback-ok', 'genuine fetch failure still uses node fallback');
    check(nodeFallbacks === 1 && powershellFallbacks === 0, 'node fallback is used exactly once');

    // A stalled provider is intentionally unbounded. It ends only when the
    // caller cancels; silence must not become an empty-response timeout.
    globalThis.fetch = originalFetch;
    const hanging = await startHangingServer();
    try {
      const hangingProvider = new LLMProvider('hanging-fixture', `http://127.0.0.1:${hanging.port}/v1`, 'sk-fixture', 'openai', 'chat_stream', true, 250);
      const started = Date.now();
      let abortName = '';
      const controller = new AbortController();
      const cancelTimer = setTimeout(() => controller.abort(), 50);
      try {
        for await (const _token of hangingProvider.chatStreamWithTools(
          'fixture-model',
          [{ role: 'user', content: 'hello' }],
          null,
          0,
          32,
          [],
          controller.signal,
        )) {
          // no response is expected
        }
      } catch (error) {
        abortName = error instanceof Error ? error.name : String(error);
      }
      clearTimeout(cancelTimer);
      const elapsed = Date.now() - started;
      check(abortName === 'AbortError', 'stalled fetch ends only after caller cancellation');
      check(elapsed < 3000, `caller cancellation releases the stalled request (${elapsed}ms)`);
      check(nodeFallbacks === 1 && powershellFallbacks === 0, 'stalled fetch does not cascade to fallback transports');
    } finally {
      await hanging.stop();
    }

    const compatibility = await startTemperatureCompatibilityServer();
    try {
      LLMProvider.nodeHttpTransport = originalNodeTransport;
      const provider = new LLMProvider('temperature-fixture', `http://127.0.0.1:${compatibility.port}/v1`, 'sk-fixture', 'openai', 'chat', true, 1000);
      const first = await provider.chat('no-temperature-model', [{ role: 'user', content: 'hello' }], null, 0.7, 32);
      const second = await provider.chat('no-temperature-model', [{ role: 'user', content: 'again' }], null, 0.7, 32);
      check(first === 'temperature-compatible' && second === 'temperature-compatible', 'explicit unsupported-temperature 400 recovers without surfacing an LLM error');
      check(compatibility.bodies.length === 3, 'the first request retries exactly once and the cached second request needs no retry');
      check(compatibility.bodies[0].temperature === 0.7 && compatibility.bodies.slice(1).every(body => body.temperature === undefined),
        'temperature is removed only after the structured capability error and stays omitted for that provider/model path');
    } finally {
      await compatibility.stop();
      LLMProvider.nodeHttpTransport = async () => {
        nodeFallbacks += 1;
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: 'fallback-ok' } }] }) };
      };
    }

    let readerCancelled = false;
    const hangingReader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
      cancel: async () => { readerCancelled = true; },
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    let streamTimeoutName = '';
    try {
      await readProviderStreamChunk(hangingReader, new AbortController().signal, 50);
    } catch (error) {
      streamTimeoutName = error instanceof Error ? error.name : String(error);
    }
    check(streamTimeoutName === 'TimeoutError' && readerCancelled, 'stream read timeout cancels the reader and releases the socket');
  } finally {
    globalThis.fetch = originalFetch;
    LLMProvider.nodeHttpTransport = originalNodeTransport;
    LLMProvider.powershellTransport = originalPowerShellTransport;
  }

  console.log(JSON.stringify({ ok: true, nodeFallbacks, powershellFallbacks }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
