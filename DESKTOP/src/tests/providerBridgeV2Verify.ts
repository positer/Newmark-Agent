/**
 * dev-0.3.0 Layer C provider bridge verification.
 *
 * Proves the adapter-backed path (useProviderAdaptersV2) is byte-equivalent to
 * the legacy inlined chatStreamWithTools: the same request body hits the
 * server and the emitted StreamToken stream is identical, across chat_stream,
 * chat (non-streaming), responses, and the 4xx Chat -> Responses downgrade.
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
    const chatServer = await startCaptureServer((_req, res, _body) => {
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
      const legacy = new LLMProvider('eq-chat-stream', base, 'sk', 'openai', 'chat_stream', false);
      const v2 = new LLMProvider('eq-chat-stream', base, 'sk', 'openai', 'chat_stream', true);
      const legacyTokens = await collectTokens(legacy.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      const v2Tokens = await collectTokens(v2.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      check(chatServer.requests.length === 2, 'chat_stream: both paths hit the server');
      check(chatServer.requests[0].body === chatServer.requests[1].body, 'chat_stream: request bodies byte-identical');
      assert.deepStrictEqual(v2Tokens, legacyTokens, 'chat_stream: token streams identical');
      check(true, 'chat_stream: token streams byte-identical');
    } finally {
      await chatServer.stop();
    }
  }

  // -------------------------------------------------------------------------
  // chat (non-streaming): usage + reasoning status + text + tool call
  // -------------------------------------------------------------------------
  {
    const chatServer = await startCaptureServer((_req, res, _body) => {
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
      const legacy = new LLMProvider('eq-chat', base, 'sk', 'openai', 'chat', false);
      const v2 = new LLMProvider('eq-chat', base, 'sk', 'openai', 'chat', true);
      const legacyTokens = await collectTokens(legacy.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      const v2Tokens = await collectTokens(v2.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      check(chatServer.requests.length === 2, 'chat: both paths hit the server');
      check(chatServer.requests[0].body === chatServer.requests[1].body, 'chat: request bodies byte-identical');
      assert.deepStrictEqual(v2Tokens, legacyTokens, 'chat: token streams identical');
      check(true, 'chat: token streams byte-identical');
    } finally {
      await chatServer.stop();
    }
  }

  // -------------------------------------------------------------------------
  // responses: reasoning effort (default medium) + text + tool call + usage
  // -------------------------------------------------------------------------
  {
    const responsesServer = await startCaptureServer((_req, res, _body) => {
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
      const legacy = new LLMProvider('eq-responses', base, 'sk', 'openai', 'responses', false);
      const v2 = new LLMProvider('eq-responses', base, 'sk', 'openai', 'responses', true);
      const legacyTokens = await collectTokens(legacy.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal));
      const v2Tokens = await collectTokens(v2.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal));
      check(responsesServer.requests.length === 2, 'responses: both paths hit the server');
      check(responsesServer.requests[0].body === responsesServer.requests[1].body, 'responses: request bodies byte-identical');
      assert.deepStrictEqual(v2Tokens, legacyTokens, 'responses: token streams identical');
      check(true, 'responses: token streams byte-identical');
    } finally {
      await responsesServer.stop();
    }
  }

  // -------------------------------------------------------------------------
  // 4xx Chat -> Responses downgrade from chat_stream
  // -------------------------------------------------------------------------
  {
    const downgradeServer = await startCaptureServer((req, res, _body) => {
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
      const legacy = new LLMProvider('eq-downgrade', base, 'sk', 'openai', 'chat_stream', false);
      const v2 = new LLMProvider('eq-downgrade', base, 'sk', 'openai', 'chat_stream', true);
      const legacyTokens = await collectTokens(legacy.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      const v2Tokens = await collectTokens(v2.chatStreamWithTools('gpt-5-mini', MESSAGES, SYSTEM, 0.2, 1024, [TOOL], new AbortController().signal, 'high'));
      const chatBodies = downgradeServer.requests.filter(r => r.url.includes('/chat/completions'));
      const responsesBodies = downgradeServer.requests.filter(r => r.url.includes('/responses'));
      check(chatBodies.length === 2 && responsesBodies.length === 2 && downgradeServer.requests.length === 4, 'downgrade: chat + responses requests from both paths');
      check(chatBodies[0].body === chatBodies[1].body, 'downgrade: /chat/completions bodies byte-identical');
      check(responsesBodies[0].body === responsesBodies[1].body, 'downgrade: /responses bodies byte-identical');
      assert.deepStrictEqual(v2Tokens, legacyTokens, 'downgrade: token streams identical');
      check(true, 'downgrade: token streams byte-identical');
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
