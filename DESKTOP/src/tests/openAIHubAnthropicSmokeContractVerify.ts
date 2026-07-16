import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

interface AnthropicSmokeContract {
  createMarkerTool: (marker: string) => Record<string, any>;
  parseAnthropicSse: (response: Response) => Promise<Record<string, any>>;
  validateStrictTextStream: (stream: Record<string, any>, marker: string, step: string) => void;
  validateStrictToolUse: (message: Record<string, any>, marker: string) => Record<string, any>;
  validateToolResultRequest: (messages: Array<Record<string, any>>, toolUseId: string, marker: string) => void;
}

function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function chunkedResponse(source: string): Response {
  const splitPoints = [1, 7, 23, 61, 127, 211, 347, source.length - 3].filter((value, index, values) => value > 0 && value < source.length && values.indexOf(value) === index).sort((a, b) => a - b);
  const chunks: string[] = [];
  let start = 0;
  for (const point of splitPoints) {
    chunks.push(source.slice(start, point));
    start = point;
  }
  chunks.push(source.slice(start));
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function textStream(marker: string, includeMessageDelta = true): string {
  return [
    sseEvent('message_start', { message: { id: 'msg_offline', type: 'message', role: 'assistant', content: [] } }),
    sseEvent('ping', {}),
    sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: marker.slice(0, 5) } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: marker.slice(5) } }),
    sseEvent('content_block_stop', { index: 0 }),
    includeMessageDelta ? sseEvent('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) : '',
    sseEvent('message_stop', {}),
  ].join('');
}

async function main(): Promise<void> {
  const scriptPath = path.resolve(__dirname, '../../scripts/real-openai-hub-anthropic-smoke.cjs');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('offline contract test must never call fetch');
  }) as typeof fetch;
  let contract: AnthropicSmokeContract;
  try {
    contract = require(scriptPath) as AnthropicSmokeContract;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.strictEqual(fetchCalls, 0, 'requiring the real-provider script never invokes main or fetch');

  assert.match(source, /NEWMARK_RUN_REAL_OPENAI_HUB/);
  assert.match(source, /const MAX_POSTS = 3/);
  assert.match(source, /anthropic-version/);
  assert.match(source, /'x-api-key': apiKey/);
  assert.match(source, /strict:\s*true/);
  assert.match(source, /additionalProperties:\s*false/);
  assert.match(source, /type:\s*'tool_result'/);
  assert.match(source, /tool_use_id:\s*toolUse\.id/);
  assert.match(source, /stream:\s*true/);
  assert.match(source, /\.trim\(\)/);
  assert.match(source, /newmark-openai-hub-/);
  assert.doesNotMatch(source, /console\.(?:log|error|warn)/);
  assert.doesNotMatch(source, /safeLog\([^\n]*(?:apiKey|toolUse\.input|toolMessage\.content)/);
  assert.ok(!source.includes("authorization':"), 'Anthropic smoke uses x-api-key and never serializes an Authorization header');

  const marker = 'NEWMARK_OFFLINE_STREAM_MARKER';
  const parsed = await contract.parseAnthropicSse(chunkedResponse(textStream(marker)));
  assert.strictEqual(parsed.text, marker);
  assert.strictEqual(parsed.messageStopped, true);
  assert.deepStrictEqual(parsed.meaningfulEventTypes, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  contract.validateStrictTextStream(parsed, marker, 'offline_text');

  const deltaBeforeStart = [
    sseEvent('message_start', { message: { id: 'bad' } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'bad' } }),
    sseEvent('message_stop', {}),
  ].join('');
  await assert.rejects(contract.parseAnthropicSse(chunkedResponse(deltaBeforeStart)), /content_block_delta_out_of_order/);
  await assert.rejects(contract.parseAnthropicSse(chunkedResponse(textStream(marker, false))), /message_stop_out_of_order|message_delta_missing/);
  await assert.rejects(contract.parseAnthropicSse(chunkedResponse(`${textStream(marker)}${sseEvent('ping', {})}`)), /event_after_message_stop/);

  const tool = contract.createMarkerTool(marker);
  assert.strictEqual(tool.strict, true);
  assert.strictEqual(tool.input_schema.additionalProperties, false);
  assert.deepStrictEqual(tool.input_schema.required, ['marker']);
  const validToolMessage = {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_offline_1', name: 'echo_marker', input: { marker } }],
  };
  const toolUse = contract.validateStrictToolUse(validToolMessage, marker);
  assert.strictEqual(toolUse.id, 'toolu_offline_1');
  assert.throws(() => contract.validateStrictToolUse({ ...validToolMessage, content: [...validToolMessage.content, { ...validToolMessage.content[0], id: 'toolu_offline_2' }] }, marker), /expected_one_tool_use/);
  assert.throws(() => contract.validateStrictToolUse({ ...validToolMessage, content: [{ ...validToolMessage.content[0], input: { marker, extra: true } }] }, marker), /closed_schema_violation/);
  assert.throws(() => contract.validateStrictToolUse({ ...validToolMessage, content: [{ ...validToolMessage.content[0], name: 'wrong_tool' }] }, marker), /tool_name_mismatch/);

  const secondMarker = 'NEWMARK_OFFLINE_RESULT_MARKER';
  const continuation = [
    { role: 'user', content: `Call echo_marker with ${marker}` },
    { role: 'assistant', content: [toolUse] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolUse.id, content: 'marker accepted' },
      { type: 'text', text: `Reply with exactly ${secondMarker}` },
    ] },
  ];
  contract.validateToolResultRequest(continuation, toolUse.id, secondMarker);
  const mismatchedContinuation = JSON.parse(JSON.stringify(continuation));
  mismatchedContinuation[2].content[0].tool_use_id = 'toolu_wrong';
  assert.throws(() => contract.validateToolResultRequest(mismatchedContinuation, toolUse.id, secondMarker), /tool_use_id_mismatch/);

  console.log(JSON.stringify({
    ok: true,
    assertions: 30,
    real_api_called: false,
    strict_sse_state_machine: true,
    exact_tool_use: '1',
    closed_schema: true,
    tool_result_correlated: true,
  }));
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
