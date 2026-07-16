'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_POSTS = 3;
const STREAM_MARKER = `NEWMARK_STREAM_${Date.now().toString(36)}`;
const TOOL_MARKER = `NEWMARK_TOOL_${Date.now().toString(36)}`;
const SECOND_MARKER = `NEWMARK_RESULT_${Date.now().toString(36)}`;
let postCount = 0;

function argValue(key) {
  const index = process.argv.indexOf(key);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function redact(value) {
  return String(value || '')
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, '<redacted>')
    .replace(/(?:authorization|x-api-key)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/https?:\/\/[^\s]+/gi, '<redacted-url>')
    .slice(0, 240);
}

function safeLog(step, status, requestId, error) {
  const record = {
    step,
    status,
    request_id: String(requestId || '').slice(0, 128) || undefined,
    error: error ? redact(error) : undefined,
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function requestIdOf(response) {
  return response.headers.get('request-id')
    || response.headers.get('x-request-id')
    || response.headers.get('cf-ray')
    || '';
}

function assertSafeRoot(root) {
  const resolved = path.resolve(root);
  const projectRoot = path.resolve(__dirname, '..');
  if (resolved === projectRoot || projectRoot.startsWith(`${resolved}${path.sep}`)) {
    throw new Error('The real-provider smoke requires an independent --root outside the project tree.');
  }
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

async function parseJsonResponse(response) {
  const raw = await response.text();
  try { return JSON.parse(raw); } catch { return null; }
}

async function parseAnthropicSse(response) {
  if (!response.body) throw new Error('Streaming response body is unavailable.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const eventTypes = [];
  const meaningfulEventTypes = [];
  const blocks = [];
  let activeBlock = null;
  let messageStarted = false;
  let messageDeltaSeen = false;
  let messageStopped = false;

  const processEvent = frame => {
    const lines = String(frame || '').split(/\r?\n/);
    let eventName = '';
    const dataLines = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        if (eventName) throw new Error('anthropic_sse:duplicate_event_field');
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      } else {
        throw new Error('anthropic_sse:unsupported_field');
      }
    }
    if (!dataLines.length) return;
    if (!eventName) throw new Error('anthropic_sse:event_name_missing');
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') throw new Error('anthropic_sse:non_anthropic_done_marker');
    let payload;
    try { payload = JSON.parse(data); } catch { throw new Error('anthropic_sse:invalid_json'); }
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') throw new Error('anthropic_sse:type_missing');
    if (eventName !== payload.type) throw new Error('anthropic_sse:event_type_mismatch');
    const type = payload.type;
    eventTypes.push(type);
    if (type === 'error') throw new Error(`anthropic_sse:${String(payload.error?.type || 'stream_error')}`);
    if (messageStopped) throw new Error('anthropic_sse:event_after_message_stop');
    if (type === 'ping') {
      if (!messageStarted) throw new Error('anthropic_sse:ping_before_message_start');
      return;
    }
    meaningfulEventTypes.push(type);
    if (type === 'message_start') {
      if (messageStarted || meaningfulEventTypes.length !== 1) throw new Error('anthropic_sse:message_start_out_of_order');
      messageStarted = true;
      return;
    }
    if (!messageStarted) throw new Error('anthropic_sse:event_before_message_start');
    if (type === 'content_block_start') {
      if (messageDeltaSeen || activeBlock) throw new Error('anthropic_sse:content_block_start_out_of_order');
      const index = Number(payload.index);
      const block = payload.content_block;
      if (!Number.isInteger(index) || index !== blocks.length || !block || typeof block.type !== 'string') {
        throw new Error('anthropic_sse:content_block_start_invalid');
      }
      activeBlock = {
        index,
        type: block.type,
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        text: typeof block.text === 'string' ? block.text : '',
        partial_json: '',
      };
      blocks.push(activeBlock);
      return;
    }
    if (type === 'content_block_delta') {
      if (!activeBlock || Number(payload.index) !== activeBlock.index || !payload.delta || typeof payload.delta.type !== 'string') {
        throw new Error('anthropic_sse:content_block_delta_out_of_order');
      }
      const deltaType = payload.delta.type;
      if (deltaType === 'text_delta') {
        if (activeBlock.type !== 'text') throw new Error('anthropic_sse:text_delta_block_mismatch');
        activeBlock.text += String(payload.delta.text || '');
      } else if (deltaType === 'input_json_delta') {
        if (activeBlock.type !== 'tool_use' && activeBlock.type !== 'server_tool_use') throw new Error('anthropic_sse:json_delta_block_mismatch');
        activeBlock.partial_json += String(payload.delta.partial_json || '');
      } else if (deltaType !== 'thinking_delta' && deltaType !== 'signature_delta') {
        throw new Error('anthropic_sse:unknown_delta_type');
      }
      return;
    }
    if (type === 'content_block_stop') {
      if (!activeBlock || Number(payload.index) !== activeBlock.index) throw new Error('anthropic_sse:content_block_stop_out_of_order');
      if (activeBlock.partial_json) {
        try { activeBlock.input = JSON.parse(activeBlock.partial_json); } catch { throw new Error('anthropic_sse:tool_input_invalid_json'); }
      }
      activeBlock = null;
      return;
    }
    if (type === 'message_delta') {
      if (activeBlock || !blocks.length || messageDeltaSeen) throw new Error('anthropic_sse:message_delta_out_of_order');
      messageDeltaSeen = true;
      return;
    }
    if (type === 'message_stop') {
      if (activeBlock || !messageDeltaSeen) throw new Error('anthropic_sse:message_stop_out_of_order');
      messageStopped = true;
      return;
    }
    throw new Error(`anthropic_sse:unexpected_event_${type}`);
  };

  const drainFrames = final => {
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      processEvent(frame);
    }
    if (final && buffer.trim()) {
      const frame = buffer;
      buffer = '';
      processEvent(frame);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    if (done) buffer += decoder.decode();
    drainFrames(done);
    if (done) break;
  }
  if (!messageStarted) throw new Error('anthropic_sse:message_start_missing');
  if (activeBlock) throw new Error('anthropic_sse:content_block_stop_missing');
  if (!messageDeltaSeen) throw new Error('anthropic_sse:message_delta_missing');
  if (!messageStopped) throw new Error('anthropic_sse:message_stop_missing');
  return {
    text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
    blocks,
    eventTypes,
    meaningfulEventTypes,
    messageStopped,
  };
}

function validateStrictTextStream(stream, expectedMarker, step) {
  if (!stream?.messageStopped) throw new Error(`${step}:message_stop_missing`);
  if (!Array.isArray(stream.blocks) || stream.blocks.length !== 1 || stream.blocks[0]?.type !== 'text') {
    throw new Error(`${step}:expected_exactly_one_text_block`);
  }
  if (String(stream.text || '').trim() !== expectedMarker) throw new Error(`${step}:marker_mismatch`);
  const expectedOrder = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];
  const order = stream.meaningfulEventTypes.filter((type, index, list) => type !== 'content_block_delta' || index === list.indexOf(type));
  if (order.join('|') !== expectedOrder.join('|')) throw new Error(`${step}:event_order_mismatch`);
}

function createMarkerTool(marker) {
  return {
    name: 'echo_marker',
    description: 'Returns a deterministic compatibility marker.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { marker: { type: 'string', const: marker } },
      required: ['marker'],
      additionalProperties: false,
    },
  };
}

function validateStrictToolUse(toolMessage, expectedMarker) {
  if (!Array.isArray(toolMessage?.content)) throw new Error('strict_tool_use:anthropic_content_array_missing');
  const toolUses = toolMessage.content.filter(block => block?.type === 'tool_use');
  if (toolUses.length !== 1) throw new Error(`strict_tool_use:expected_one_tool_use_received_${toolUses.length}`);
  const toolUse = toolUses[0];
  if (toolUse.name !== 'echo_marker') throw new Error('strict_tool_use:tool_name_mismatch');
  if (typeof toolUse.id !== 'string' || !toolUse.id.trim()) throw new Error('strict_tool_use:tool_use_id_missing');
  if (!toolUse.input || typeof toolUse.input !== 'object' || Array.isArray(toolUse.input)) throw new Error('strict_tool_use:input_object_missing');
  const keys = Object.keys(toolUse.input).sort();
  if (keys.length !== 1 || keys[0] !== 'marker') throw new Error('strict_tool_use:closed_schema_violation');
  if (toolUse.input.marker !== expectedMarker) throw new Error('strict_tool_use:strict_marker_mismatch');
  if (toolMessage.stop_reason !== 'tool_use') throw new Error('strict_tool_use:stop_reason_mismatch');
  return toolUse;
}

function validateToolResultRequest(messages, toolUseId, expectedMarker) {
  if (!Array.isArray(messages) || messages.length !== 3) throw new Error('tool_result_marker:message_sequence_invalid');
  if (messages[0]?.role !== 'user' || messages[1]?.role !== 'assistant' || messages[2]?.role !== 'user') {
    throw new Error('tool_result_marker:role_sequence_invalid');
  }
  const assistantBlocks = Array.isArray(messages[1].content) ? messages[1].content : [];
  const assistantToolUses = assistantBlocks.filter(block => block?.type === 'tool_use');
  if (assistantToolUses.length !== 1 || assistantToolUses[0]?.id !== toolUseId) throw new Error('tool_result_marker:assistant_tool_use_mismatch');
  const resultBlocks = Array.isArray(messages[2].content) ? messages[2].content : [];
  const toolResults = resultBlocks.filter(block => block?.type === 'tool_result');
  const textBlocks = resultBlocks.filter(block => block?.type === 'text');
  if (toolResults.length !== 1 || toolResults[0]?.tool_use_id !== toolUseId) throw new Error('tool_result_marker:tool_use_id_mismatch');
  if (textBlocks.length !== 1 || !String(textBlocks[0]?.text || '').includes(expectedMarker)) throw new Error('tool_result_marker:continuation_marker_missing');
}

async function postMessages(baseUrl, apiKey, body, step) {
  postCount += 1;
  if (postCount > MAX_POSTS) throw new Error(`POST budget exceeded (${MAX_POSTS}).`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request_timeout')), 60_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const requestId = requestIdOf(response);
    if (!response.ok) {
      const failure = await parseJsonResponse(response);
      const errorType = failure?.error?.type || failure?.type || `http_${response.status}`;
      safeLog(step, response.status, requestId, errorType);
      throw new Error(`${step}:${errorType}`);
    }
    safeLog(step, response.status, requestId);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (process.env.NEWMARK_RUN_REAL_OPENAI_HUB !== '1' && !process.argv.includes('--run')) {
    safeLog('opt_in', 'skipped', '', 'set NEWMARK_RUN_REAL_OPENAI_HUB=1 or pass --run');
    return;
  }

  const ownedRoot = !argValue('--root');
  const root = assertSafeRoot(argValue('--root') || fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-openai-hub-')));
  const keyFile = path.resolve(argValue('--key-file') || process.env.NEWMARK_OPENAI_HUB_API_KEY_FILE || path.resolve(__dirname, '../../_ref/OpenAI-hub key.txt'));
  const apiKey = fs.readFileSync(keyFile, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!apiKey) throw new Error('OpenAI-Hub API key file is empty after trimming.');
  const baseUrl = String(process.env.NEWMARK_OPENAI_HUB_BASE_URL || 'https://api.openai-hub.com/v1').replace(/\/+$/, '');
  // Keep the default aligned with OpenAI-Hub's native Claude-format example;
  // callers can override it without changing or logging credentials.
  const model = String(process.env.NEWMARK_OPENAI_HUB_MODEL || 'claude-sonnet-4-5');
  const markerTool = createMarkerTool(TOOL_MARKER);

  try {
    const streamResponse = await postMessages(baseUrl, apiKey, {
      model,
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: `Reply with exactly ${STREAM_MARKER}` }],
    }, 'stream_marker');
    const streamed = await parseAnthropicSse(streamResponse);
    validateStrictTextStream(streamed, STREAM_MARKER, 'stream_marker');

    const toolResponse = await postMessages(baseUrl, apiKey, {
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: `Call echo_marker once with marker ${TOOL_MARKER}. Do not answer in text.` }],
      tools: [markerTool],
      tool_choice: { type: 'tool', name: 'echo_marker' },
    }, 'strict_tool_use');
    const toolMessage = await parseJsonResponse(toolResponse);
    const toolUse = validateStrictToolUse(toolMessage, TOOL_MARKER);

    const continuationMessages = [
      { role: 'user', content: `Call echo_marker once with marker ${TOOL_MARKER}. Do not answer in text.` },
      { role: 'assistant', content: [toolUse] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUse.id, content: 'marker accepted' },
          { type: 'text', text: `Reply with exactly ${SECOND_MARKER}` },
        ],
      },
    ];
    validateToolResultRequest(continuationMessages, toolUse.id, SECOND_MARKER);
    const continuationResponse = await postMessages(baseUrl, apiKey, {
      model,
      max_tokens: 64,
      stream: true,
      messages: continuationMessages,
      tools: [markerTool],
    }, 'tool_result_marker');
    const continued = await parseAnthropicSse(continuationResponse);
    validateStrictTextStream(continued, SECOND_MARKER, 'tool_result_marker');
    if (postCount !== MAX_POSTS) throw new Error(`Expected exactly ${MAX_POSTS} POST requests, received ${postCount}.`);
    safeLog('summary', 'passed', '');
  } finally {
    if (ownedRoot) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    safeLog('summary', 'failed', '', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  createMarkerTool,
  parseAnthropicSse,
  validateStrictTextStream,
  validateStrictToolUse,
  validateToolResultRequest,
};
