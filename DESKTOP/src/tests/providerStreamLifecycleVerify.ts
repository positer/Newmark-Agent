import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ChatCompletionsAdapter, ResponsesAdapter, ModelProviderAdapter, NormalizedProviderEvent, ProviderTransport } from '../providers';
import { LLMProvider } from '../llm/provider';

const encoder = new TextEncoder();
const text = '正常响应🌟';
const responseFrames = `event: response.output_text.delta\r\ndata: {"delta":"${text}"}\r\n\r\nevent: response.completed\r\ndata: {"response":{"status":"completed"}}\r\n\r\n`;
const chatFrames = `data:{"choices":[{"delta":{"content":"${text}"}}]}\n\ndata:[DONE]\n\n`;
const request = { url: 'http://127.0.0.1/unused-fixture', headers: {}, body: {} };

function responseBody(bytes: Uint8Array[], open = false): { transport: ProviderTransport; cancelled(): boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk);
      if (!open) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return {
    transport: async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    cancelled: () => cancelled,
  };
}

async function collect(adapter: ModelProviderAdapter, transport: ProviderTransport): Promise<NormalizedProviderEvent[]> {
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.execute(request, new AbortController().signal, transport)) events.push(event);
  return events;
}

export async function verifyProviderStreamLifecycle(): Promise<void> {
  let checks = 0;
  const check = (condition: boolean, name: string) => {
    assert.ok(condition, name);
    checks += 1;
    console.log(`  [PASS] provider stream lifecycle: ${name}`);
  };
  const chat = new ChatCompletionsAdapter('local-lifecycle');
  const responses = new ResponsesAdapter('local-lifecycle');
  const succeeds = (events: NormalizedProviderEvent[]) =>
    events.filter(e => e.type === 'text.delta').map(e => e.delta).join('') === text
    && events.filter(e => e.type === 'response.completed').length === 1
    && !events.some(e => e.type === 'response.failed');

  for (const [name, adapter, frames] of [
    ['Responses CRLF', responses, responseFrames],
    ['Chat compact data field', chat, chatFrames],
    ['Chat CRLF', chat, chatFrames.replaceAll('\n', '\r\n')],
    ['Responses CR-only', responses, responseFrames.replaceAll('\r\n', '\r')],
  ] as const) {
    const bytes = encoder.encode(frames);
    let allSplits = true;
    for (let split = 1; split < bytes.length; split += 1) {
      const result = await collect(adapter, responseBody([bytes.slice(0, split), bytes.slice(split)]).transport);
      if (!succeeds(result)) { allSplits = false; break; }
    }
    check(allSplits, `${name} survives every possible two-chunk UTF-8 boundary`);
    check(succeeds(await collect(adapter, responseBody([...bytes].map(byte => Uint8Array.of(byte))).transport)),
      `${name} survives one-byte chunks without text loss or duplicate completion`);
  }

  const multiline = ': heartbeat\r\nevent: ignored\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"正常响应🌟"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  check(succeeds(await collect(chat, responseBody([encoder.encode(multiline)]).transport)),
    'comments and multiple data lines retain a valid Chat JSON event');

  for (const [name, adapter, frames] of [['Chat', chat, chatFrames], ['Responses', responses, responseFrames]] as const) {
    const source = responseBody([encoder.encode(frames)], true);
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 500);
    const events: NormalizedProviderEvent[] = [];
    try {
      for await (const event of adapter.execute(request, controller.signal, source.transport)) events.push(event);
    } finally { clearTimeout(watchdog); }
    check(succeeds(events) && !controller.signal.aborted, `${name} completion does not depend on HTTP EOF`);
    check(source.cancelled(), `${name} completion closes the still-open response body`);

    const early = responseBody([encoder.encode(frames)], true);
    for await (const event of adapter.execute(request, new AbortController().signal, early.transport)) {
      if (event.type === 'text.delta') break;
    }
    check(early.cancelled(), `${name} consumer return cancels its owned response body`);

    const firstEvent = frames.slice(0, frames.indexOf(name === 'Chat' ? '\n\n' : '\r\n\r\n') + (name === 'Chat' ? 2 : 4));
    const interrupted = responseBody([encoder.encode(firstEvent)], true);
    const aborted = new AbortController();
    let abortName = '';
    try {
      for await (const event of adapter.execute(request, aborted.signal, interrupted.transport)) {
        if (event.type === 'text.delta') aborted.abort();
      }
    } catch (error) { abortName = error instanceof Error ? error.name : String(error); }
    check(interrupted.cancelled() && abortName === 'AbortError', `${name} abort during consumer handoff releases its body and preserves cancellation`);
  }

  for (const failure of ['response.failed', 'response.incomplete', 'error']) {
    const source = responseBody([encoder.encode(`event: ${failure}\ndata: {"error":{"message":"fixture failure"}}\n\n`)], true);
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 500);
    const events: NormalizedProviderEvent[] = [];
    try { for await (const event of responses.execute(request, controller.signal, source.transport)) events.push(event); }
    finally { clearTimeout(watchdog); }
    check(events.some(e => e.type === 'response.failed' && e.error.includes('fixture failure'))
      && !events.some(e => e.type === 'response.completed') && source.cancelled() && !controller.signal.aborted,
    `${failure} reports the provider failure promptly and closes the socket`);
  }

  // Real HTTP: leave the server response open after the terminal event. A
  // watchdog only bounds a regression; it must never end a successful call.
  let receivedRequests = 0;
  let closedResponses = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      receivedRequests += 1;
      res.on('close', () => { closedResponses += 1; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(req.url?.endsWith('/responses') ? responseFrames : chatFrames);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [name, protocol, mode] of [
      ['Chat', 'openai', 'chat_stream'], ['Responses', 'openai', 'responses'], ['GitHub Models', 'github_models', 'chat_stream'],
    ] as const) {
      const provider = new LLMProvider(`lifecycle-${name}`, base, 'fixture-no-credential', protocol, mode, true);
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), 1500);
      let output = '';
      try {
        for await (const token of provider.chatStreamWithTools('fixture', [{ role: 'user', content: 'fixture' }], null, 0, 32, [], controller.signal)) {
          if (token.type === 'text') output += token.text;
        }
      } finally { clearTimeout(watchdog); }
      check(output === text && !controller.signal.aborted, `${name} real provider facade completes against an open loopback HTTP stream`);
    }
    for (let i = 0; i < 50 && closedResponses < receivedRequests; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    check(receivedRequests === 3 && closedResponses === 3, 'all three real sockets close with exactly one request per provider');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  console.log(`providerStreamLifecycleVerify: ${checks} assertions passed`);
}

if (require.main === module) verifyProviderStreamLifecycle().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
