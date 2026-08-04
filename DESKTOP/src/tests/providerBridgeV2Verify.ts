/**
 * dev-0.3.0 Layer F provider bridge verification (pure V2).
 *
 * The legacy inlined OpenAI streaming path was removed in dev-0.3.0: every
 * OpenAI-protocol provider now routes through chatStreamWithToolsV2
 * (useProviderAdaptersV2). This suite pins the V2 contract end-to-end:
 * request serialization (URL, body shape, stream flag), the exact emitted
 * StreamToken stream, and the 4xx Chat -> Responses downgrade.
 *
 * Run: npm run build && node dist/tests/providerBridgeV2Verify.js
 */
import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { LLMProvider } from '../llm/provider';
import { StreamToken } from '../core/types';

type CapturedRequest = { url: string; body: string };

function startCaptureServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ server: http.Server; port: number; requests: CapturedRequest[]; stop(): Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: String(req.url || ''), body });
      handler(req, res, body);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        server,
        port: address.port,
        requests,
        stop: () => new Promise<void>(res => server.close(() => res())),
      });
    });
  });
}

async function collectTokens(generator: AsyncGenerator<StreamToken>): Promise<StreamToken[]> {
  const tokens: StreamToken[] = [];
  for await (const token of generator) tokens.push(token);
  return tokens;
}

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  [PASS] ${name}`);
  else console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`);
  assert.ok(cond, name);
}

const TOOL = {
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  },
};
const MESSAGES: Array<Record<string, unknown>> = [{ role: 'user', content: 'run pwd' }];
const SYSTEM = 'You are a helper.';

async function main(): Promise<void> {
  console.log('providerBridgeV2Verify');

  // -------------------------------------------------------------------------
  // chat_stream: reasoning_content + text + usage + tool call
  // -------------------------------------------------------------------------
  {
    const chatServer = await startCaptureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":" step"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"id":"call-x","function":{"name":"bash","arguments":"{\\"cmd\\":\\"pwd\\"}"}}]}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const base = `http://127.0.0.1:${chatServer.port}/v1`;
      const provider = new LLMProvider('eq-chat-stream', base, 'sk', 'openai', 'chat_stream', true);
      const tokens = await collectTokens(provider.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      check(chatServer.requests.length === 1, 'chat_stream: single request through V2 adapter');
      check(chatServer.requests[0].url.endsWith('/v1/chat/completions'), 'chat_stream: hits /chat/completions');
      const body = JSON.parse(chatServer.requests[0].body);
      check(body.stream === true, 'chat_stream: body.stream === true');
      check(body.model === 'gpt-5-mini', 'chat_stream: body.model');
      check(body.max_tokens === 1024 && body.temperature === 0.2, 'chat_stream: max_tokens + temperature');
      check(body.tool_choice === 'auto', 'chat_stream: tool_choice auto');
      check(body.tools?.[0]?.function?.name === 'bash', 'chat_stream: tools serialized');
      check(body.messages?.[0]?.role === 'system' && body.messages?.[0]?.content === SYSTEM, 'chat_stream: system message');
      assert.deepStrictEqual(tokens, [
        { type: 'text', text: 'Hello', reasoningContent: ' step' },
        { type: 'text', text: ' world', reasoningContent: ' step' },
        { type: 'usage', text: '', usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
        { type: 'tool_call', text: '', toolCall: { id: 'call-x', name: 'bash', arguments: '{"cmd":"pwd"}' }, reasoningContent: ' step' },
      ]);
      check(true, 'chat_stream: exact StreamToken stream');
    } finally {
      await chatServer.stop();
    }
  }

  // -------------------------------------------------------------------------
  // chat (non-streaming): usage + reasoning status + text + tool call
  // -------------------------------------------------------------------------
  {
    const chatServer = await startCaptureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            reasoning_content: 'rc',
            content: 'Hello',
            tool_calls: [{ id: 'call-x', function: { name: 'bash', arguments: '{"cmd":"pwd"}' } }],
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
    });
    try {
      const base = `http://127.0.0.1:${chatServer.port}/v1`;
      const provider = new LLMProvider('eq-chat', base, 'sk', 'openai', 'chat', true);
      const tokens = await collectTokens(provider.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      check(chatServer.requests.length === 1, 'chat: single request through V2 adapter');
      check(chatServer.requests[0].url.endsWith('/v1/chat/completions'), 'chat: hits /chat/completions');
      const body = JSON.parse(chatServer.requests[0].body);
      check(body.stream === false, 'chat: body.stream === false (non-streaming)');
      assert.deepStrictEqual(tokens, [
        { type: 'usage', text: '', usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
        { type: 'status', text: '', reasoningContent: 'rc' },
        { type: 'text', text: 'Hello', reasoningContent: 'rc' },
        { type: 'tool_call', text: '', toolCall: { id: 'call-x', name: 'bash', arguments: '{"cmd":"pwd"}' } },
      ]);
      check(true, 'chat: exact StreamToken stream');
    } finally {
      await chatServer.stop();
    }
  }

  // -------------------------------------------------------------------------
  // responses: reasoning effort (default medium) + text + tool call + usage
  // -------------------------------------------------------------------------
  {
    const responsesServer = await startCaptureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"delta":"World"}\n\n');
      res.write('event: response.output_item.added\ndata: {"item":{"id":"fc-1","type":"function_call","name":"bash","arguments":""}}\n\n');
      res.write('event: response.function_call_arguments.delta\ndata: {"item_id":"fc-1","delta":"{\\"cmd\\":\\"ls\\"}"}\n\n');
      res.write('event: response.output_item.done\ndata: {"item":{"id":"fc-1","type":"function_call","call_id":"fc-1","name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}\n\n');
      res.write('event: response.completed\ndata: {"response":{"usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}\n\n');
      res.end();
    });
    try {
      const base = `http://127.0.0.1:${responsesServer.port}/v1`;
      const provider = new LLMProvider('eq-responses', base, 'sk', 'openai', 'responses', true);
      const tokens = await collectTokens(provider.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal));
      check(responsesServer.requests.length === 1, 'responses: single request through V2 adapter');
      check(responsesServer.requests[0].url.endsWith('/v1/responses'), 'responses: hits /responses');
      const body = JSON.parse(responsesServer.requests[0].body);
      check(body.stream === true, 'responses: body.stream === true');
      check(body.reasoning?.effort === 'medium' && body.reasoning?.summary === 'auto', 'responses: default reasoning effort medium');
      check(body.instructions === SYSTEM, 'responses: system prompt as instructions');
      check(body.input?.[0]?.role === 'user' && body.input?.[0]?.content === 'run pwd', 'responses: input messages');
      check(body.tools?.[0]?.type === 'function' && body.tools?.[0]?.name === 'bash', 'responses: tools serialized');
      assert.deepStrictEqual(tokens, [
        { type: 'text', text: 'World' },
        { type: 'tool_call', text: '', toolCall: { id: 'fc-1', name: 'bash', arguments: '{"cmd":"ls"}' } },
        { type: 'usage', text: '', usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0 } },
      ]);
      check(true, 'responses: exact StreamToken stream');
    } finally {
      await responsesServer.stop();
    }
  }

  // -------------------------------------------------------------------------
  // 4xx Chat -> Responses downgrade from chat_stream
  // -------------------------------------------------------------------------
  {
    const downgradeServer = await startCaptureServer((req, res) => {
      if ((req.url || '').includes('/chat/completions')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Error: Chat Completions is not supported for this model, please use the Responses API.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"delta":"Downgraded"}\n\n');
      res.write('event: response.completed\ndata: {"response":{"usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}}}\n\n');
      res.end();
    });
    try {
      const base = `http://127.0.0.1:${downgradeServer.port}/v1`;
      const provider = new LLMProvider('eq-downgrade', base, 'sk', 'openai', 'chat_stream', true);
      const tokens = await collectTokens(provider.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      const chatRequests = downgradeServer.requests.filter(r => r.url.includes('/chat/completions'));
      const responsesRequests = downgradeServer.requests.filter(r => r.url.includes('/responses'));
      check(chatRequests.length === 1 && responsesRequests.length === 1, 'downgrade: chat 400 then responses retry');
      check(JSON.parse(chatRequests[0].body).stream === true, 'downgrade: chat request streaming');
      const responsesBody = JSON.parse(responsesRequests[0].body);
      check(responsesBody.stream === true, 'downgrade: responses retry streaming');
      check(responsesBody.reasoning?.effort === 'high', 'downgrade: reasoning tier propagated on downgrade');
      assert.deepStrictEqual(tokens, [
        { type: 'text', text: 'Downgraded' },
        { type: 'usage', text: '', usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 } },
      ]);
      check(true, 'downgrade: exact StreamToken stream');
    } finally {
      await downgradeServer.stop();
    }
  }

  console.log('providerBridgeV2Verify: all assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
