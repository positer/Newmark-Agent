/**
 * dev-0.3.0 provider adapter v2 verification.
 * Run: npm run build && node dist/tests/providerAdapterV2Verify.js
 */
import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import {
  ChatCompletionsAdapter,
  ResponsesAdapter,
  NormalizedAgentRequest,
  normalizeProviderUsage,
  parseProviderSse,
  normalizeProviderHeaders,
  RetryPolicy,
  filterRequestHeadersForDiagnostics,
} from '../providers';

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  [PASS] ${name}`);
  else console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`);
  assert.ok(cond, name);
}

function sampleRequest(apiMode: 'chat_completions' | 'responses'): NormalizedAgentRequest {
  return {
    providerId: 'fixture',
    model: 'fixture-model',
    apiMode,
    systemPrompt: 'You are a helper.',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi', toolCalls: [{ id: 'call-1', name: 'file_read', arguments: '{"path":"a.txt"}' }] },
      { role: 'tool', content: 'content of a.txt', toolCallId: 'call-1', name: 'file_read' },
    ],
    tools: [
      { type: 'function', function: { name: 'file_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    ],
    temperature: 0.2,
    maxOutputTokens: 1024,
    reasoningEffort: 'high',
    apiKey: 'sk-test',
    baseUrl: 'https://fixture.invalid/v1',
  };
}

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<{ server: http.Server; port: number; requests: string[]; stop(): Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(body);
      handler(req, res, body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    server,
    port: address.port,
    requests,
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  console.log('providerAdapterV2Verify');

  // -------------------------------------------------------------------------
  // Chat Completions serialization
  // -------------------------------------------------------------------------
  const chatAdapter = new ChatCompletionsAdapter('fixture');
  check(chatAdapter.apiMode === 'chat_completions', 'chat adapter apiMode is chat_completions');
  const chatSerialized = await chatAdapter.serializeRequest(sampleRequest('chat_completions'));
  check(chatSerialized.url.endsWith('/chat/completions'), 'chat adapter targets /chat/completions');
  check(chatSerialized.body.model === 'fixture-model', 'chat request carries the model');
  check(chatSerialized.body.reasoning_effort === 'high', 'chat request carries reasoning_effort');
  const chatMessages = chatSerialized.body.messages as Array<Record<string, unknown>>;
  check(chatMessages[0].role === 'system', 'system message is first in chat request');
  const toolMessages = chatMessages.filter(message => message.role === 'tool');
  check(toolMessages.length === 1 && toolMessages[0].tool_call_id === 'call-1', 'tool result is serialized with its call id');

  // -------------------------------------------------------------------------
  // Responses serialization
  // -------------------------------------------------------------------------
  const responsesAdapter = new ResponsesAdapter('fixture');
  check(responsesAdapter.apiMode === 'responses', 'responses adapter apiMode is responses');
  const responsesSerialized = await responsesAdapter.serializeRequest(sampleRequest('responses'));
  check(responsesSerialized.url.endsWith('/responses'), 'responses adapter targets /responses');
  check(responsesSerialized.body.instructions === 'You are a helper.', 'responses request carries instructions');
  check((responsesSerialized.body.reasoning as Record<string, unknown>)?.effort === 'high', 'responses request carries reasoning.effort');
  const input = responsesSerialized.body.input as Array<Record<string, unknown>>;
  check(input.some(item => item.type === 'function_call' && item.call_id === 'call-1'), 'responses input carries function_call items');
  check(input.some(item => item.type === 'function_call_output' && item.call_id === 'call-1'), 'responses input carries function_call_output');

  // -------------------------------------------------------------------------
  // SSE parsing + usage normalization
  // -------------------------------------------------------------------------
  const sse = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\n';
  const events = parseProviderSse(sse);
  check(events.length === 2 && events[0].event === 'a' && events[1].event === 'b', 'SSE parser splits events with event names');

  const chatUsage = normalizeProviderUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  check(!!chatUsage && chatUsage.inputTokens === 10 && chatUsage.outputTokens === 5, 'chat usage normalized');
  const responsesUsage = normalizeProviderUsage({ input_tokens: 20, output_tokens: 7, cached_tokens: 3, total_tokens: 27 });
  check(!!responsesUsage && responsesUsage.inputTokens === 20 && responsesUsage.cacheReadTokens === 3, 'responses usage normalized with cache read');
  check(normalizeProviderUsage(null) === null, 'null usage normalizes to null');

  // -------------------------------------------------------------------------
  // Header normalization + filtering
  // -------------------------------------------------------------------------
  const meta = normalizeProviderHeaders({
    'x-request-id': 'req-123',
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '42',
    'x-ratelimit-reset': '10',
    'retry-after': '3',
    authorization: 'Bearer sk-test',
    cookie: 'session=abc',
  });
  check(meta.requestId === 'req-123', 'request id extracted');
  check(!!meta.rateLimit && meta.rateLimit.limit === 100 && meta.rateLimit.remaining === 42, 'rate limit extracted');
  check(meta.retryAfterSeconds === 3, 'retry-after extracted');
  check(meta.requestId === 'req-123', 'request id retained');

  const filtered = filterRequestHeadersForDiagnostics({
    authorization: 'Bearer sk-test',
    cookie: 'x',
    'x-request-id': 'req-123',
    'x-ratelimit-limit': '50',
  });
  check(!('authorization' in filtered), 'authorization header filtered from diagnostics');
  check(!('cookie' in filtered), 'cookie header filtered from diagnostics');
  check('x-request-id' in filtered, 'safe diagnostic header retained');

  // -------------------------------------------------------------------------
  // Adapter streaming over a real loopback HTTP server
  // -------------------------------------------------------------------------
  const chatServer = await startServer((_req, res, _body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"id":"call-x","function":{"name":"bash","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}]}\n\n');
    res.write('data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const request = sampleRequest('chat_completions');
    request.baseUrl = `http://127.0.0.1:${chatServer.port}/v1`;
    const serialized = await chatAdapter.serializeRequest(request);
    const events: string[] = [];
    const textChunks: string[] = [];
    for await (const event of chatAdapter.execute(serialized, new AbortController().signal)) {
      events.push(event.type);
      if (event.type === 'text.delta') textChunks.push(event.delta);
    }
    check(events.includes('response.started'), 'chat stream starts with response.started');
    check(textChunks.join('') === 'Hello', 'chat stream text deltas assemble to "Hello"');
    check(events.includes('tool_call.completed'), 'chat stream emits tool_call.completed');
    check(events.includes('usage.updated'), 'chat stream emits usage.updated');
    check(events.includes('response.completed'), 'chat stream completes');
  } finally {
    await chatServer.stop();
  }

  const responsesServer = await startServer((_req, res, _body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"delta":"World"}\n\n');
    res.write('event: response.output_item.added\ndata: {"item":{"id":"fc-1","type":"function_call","name":"bash","arguments":""}}\n\n');
    res.write('event: response.function_call_arguments.delta\ndata: {"item_id":"fc-1","delta":"{\\"cmd\\":\\"ls\\"}"}\n\n');
    res.write('event: response.output_item.done\ndata: {"item":{"id":"fc-1","type":"function_call","call_id":"fc-1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}\n\n');
    res.write('event: response.completed\ndata: {"response":{"usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}\n\n');
    res.end();
  });
  try {
    const request = sampleRequest('responses');
    request.baseUrl = `http://127.0.0.1:${responsesServer.port}/v1`;
    const serialized = await responsesAdapter.serializeRequest(request);
    const events: string[] = [];
    const textChunks: string[] = [];
    let toolCall: { id: string; name: string; arguments: string } | null = null;
    for await (const event of responsesAdapter.execute(serialized, new AbortController().signal)) {
      events.push(event.type);
      if (event.type === 'text.delta') textChunks.push(event.delta);
      if (event.type === 'tool_call.completed') toolCall = { id: event.id, name: event.name, arguments: event.arguments };
    }
    check(textChunks.join('') === 'World', 'responses stream text deltas assemble to "World"');
    check(!!toolCall && toolCall.id === 'fc-1' && toolCall.name === 'bash' && toolCall.arguments.includes('ls'), 'responses stream assembles the function call');
    check(events.includes('usage.updated'), 'responses stream emits usage.updated');
    check(events.includes('response.completed'), 'responses stream completes');
  } finally {
    await responsesServer.stop();
  }

  // -------------------------------------------------------------------------
  // Retry policy
  // -------------------------------------------------------------------------
  const retry = new RetryPolicy({ maxRetries: 3, initialDelayMs: 10, maxDelayMs: 100, jitter: false });
  const first = retry.decide(0, { status: 500 });
  check(first.retry === true && first.delayMs > 0, '5xx status is retryable');
  const permanent = retry.decide(0, { status: 400 });
  check(permanent.retry === false && permanent.reason === 'permanent_error', '4xx is permanent (no retry)');
  const aborted = retry.decide(0, { aborted: true });
  check(aborted.retry === false && aborted.reason === 'aborted', 'aborted is never retried');
  const exhausted = retry.decide(3, { status: 500 });
  check(exhausted.retry === false && exhausted.reason === 'max_retries', 'retry limit is enforced');
  const rateLimited = retry.decide(0, { status: 429, retryAfterSeconds: 2 });
  check(rateLimited.retry === true, '429 with retry-after is retryable');

  console.log('providerAdapterV2Verify: all assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
