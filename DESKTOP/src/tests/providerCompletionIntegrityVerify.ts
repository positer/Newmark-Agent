/** Loopback completion/error integrity: partial streams may not become successful tool work. */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { ChatCompletionsAdapter } from '../providers/chat-completions.adapter';
import { ResponsesAdapter } from '../providers/responses.adapter';
import { LLMProvider } from '../llm/provider';
import { classifyRouteFailure } from '../core/autoRouter';
import type { NormalizedProviderEvent } from '../providers/provider-adapter';

const checks: Array<{ name: string; passed: boolean; error?: string }> = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, passed: false, error: String(error) }); console.log('FAIL ' + name + ': ' + error); }
}
const frame = (payload: unknown) => 'data: ' + JSON.stringify(payload) + '\n\n';
const chatText = (text: string) => frame({ choices: [{ delta: { content: text } }] });
const chatFinish = (finish_reason = 'stop') => frame({ choices: [{ delta: {}, finish_reason }] });
const done = 'data: [DONE]\n\n';
const call = (id: string, name: string, args: string, index?: number) => ({ ...(index === undefined ? {} : { index }), id, type: 'function', function: { name, arguments: args } });
const chatCalls = (...tool_calls: unknown[]) => frame({ choices: [{ delta: { tool_calls } }] });
const item = (args = '{"path":"ok"}') => ({ type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read_file', arguments: args });
const added = (value: unknown) => frame({ type: 'response.output_item.added', output_index: 0, item: value });
const itemDone = (value: unknown) => frame({ type: 'response.output_item.done', output_index: 0, item: value });
const responseDone = (extra: Record<string, unknown> = {}) => frame({ type: 'response.completed', response: { status: 'completed', ...extra } });
const textItem = { type: 'message', content: [{ type: 'output_text', text: 'OK' }] };
const usage = { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 0 } };
const failure = (events: NormalizedProviderEvent[]) => events.filter(event => event.type === 'response.failed');
const completed = (events: NormalizedProviderEvent[]) => events.filter(event => event.type === 'response.completed');
const tools = (events: NormalizedProviderEvent[]) => events.filter(event => event.type === 'tool_call.completed');
const text = (events: NormalizedProviderEvent[]) => events.filter(event => event.type === 'text.delta').map(event => event.delta).join('');

async function main() {
  const fixtures: Record<string, { body: string; json?: boolean; hold?: boolean }> = {
    'chat-eof-text': { body: chatText('PARTIAL') },
    'chat-empty-finish': { body: frame({ choices: [{ delta: { content: 'PARTIAL' }, finish_reason: '' }] }) },
    'chat-no-arguments': { body: chatCalls({ index: 0, id: 'call_1', function: { name: 'read_file' } }) + chatFinish('tool_calls') + done },
    'chat-json-no-arguments': { json: true, body: JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call_1', function: { name: 'read_file' } }] }, finish_reason: 'tool_calls' }] }) },
    'chat-eof-tool': { body: chatCalls(call('call_1', 'read_file', '{"path":"ok"}', 0)) },
    'chat-eof-broken-tool': { body: chatCalls(call('call_1', 'read_file', '{"path":"unfinished', 0)) },
    'chat-inband-error': { body: chatText('PARTIAL') + frame({ error: { message: 'fixture provider failure', type: 'server_error' } }) + done },
    'chat-inband-error-open': { body: frame({ error: { message: 'fixture provider failure', type: 'server_error' } }), hold: true },
    'chat-inband-overloaded': { body: frame({ error: { code: 'server_is_overloaded', message: 'Try again later', type: 'service_unavailable_error' } }), hold: true },
    'chat-json-overloaded': { json: true, body: JSON.stringify({ error: { type: 'overloaded_error', message: 'Try again later' } }) },
    'responses-inband-overloaded': { body: frame({ type: 'response.failed', response: { error: { code: 'server_is_overloaded', message: 'Try again later' } } }), hold: true },
    'responses-json-overloaded': { json: true, body: JSON.stringify({ status: 'failed', error: { type: 'service_unavailable_error', message: 'Try again later' } }) },
    'chat-success': { body: chatText('OK') + done, hold: true },
    'chat-usage-tail': { body: chatText('OK') + chatFinish() + frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 0 } } }) + done },
    'chat-finish-eof': { body: chatText('OK') + chatFinish() },
    'chat-length-text': { body: chatText('PARTIAL') + chatFinish('length') + done },
    'chat-valid-tool': { body: chatCalls(call('call_1', 'read_file', '{"path":', 0)) + chatCalls({ index: 0, function: { arguments: '"ok"}' } }) + chatFinish('tool_calls') + done },
    'chat-broken-tool': { body: chatCalls(call('call_1', 'read_file', '{"path":"unfinished', 0)) + chatFinish('tool_calls') + done },
    'chat-mixed-tools': { body: chatCalls(call('call_1', 'pwd', '{}', 0), call('call_2', 'read_file', '{"path":"unfinished', 1)) + chatFinish('tool_calls') + done },
    'chat-repeated-id': { body: chatCalls(call('call_1', 'read_file', '{"path":')) + chatCalls(call('call_1', 'read_file', '{"path":"ok"}')) + chatFinish('tool_calls') + done },
    'chat-cumulative-truncated-last': { body: chatCalls(call('call_1', 'read_file', '{"path":"old"}', 0)) + chatCalls({ index: 0, function: { arguments: '{"path":"new' } }) + chatFinish('tool_calls') + done },
    'chat-cumulative-shorter-last': { body: chatCalls(call('call_1', 'read_file', '{"path":"old"}', 0)) + chatCalls({ index: 0, function: { arguments: '{"path":' } }) + chatFinish('tool_calls') + done },
    'chat-cumulative-corrected': { body: chatCalls(call('call_1', 'read_file', '{"path":"old"}', 0)) + chatCalls({ index: 0, function: { arguments: '{"path":"ok"}' } }) + chatFinish('tool_calls') + done },
    'chat-null-fragment': { body: chatCalls(call('call_1', 'read_file', '{"value":', 0)) + chatCalls({ index: 0, function: { arguments: 'null' } }) + chatCalls({ index: 0, function: { arguments: '}' } }) + chatFinish('tool_calls') + done },
    'chat-null-correction': { body: chatCalls(call('call_1', 'read_file', '{"path":"old"}', 0)) + chatCalls({ index: 0, function: { arguments: 'null' } }) + chatFinish('tool_calls') + done },
    'chat-usage-eof': { body: chatText('PARTIAL') + frame({ usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 0 } }, choices: [] }) },
    'chat-two-ids': { body: chatCalls(call('call_1', 'pwd', '{}'), call('call_2', 'pwd', '{}')) + chatFinish('tool_calls') + done },
    'chat-json-error': { json: true, body: JSON.stringify({ error: { message: 'fixture provider failure' }, usage }) },
    'chat-json-valid': { json: true, body: JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage }) },
    'chat-json-length': { json: true, body: JSON.stringify({ choices: [{ message: { content: 'PARTIAL' }, finish_reason: 'length' }], usage }) },
    'responses-json-failed': { json: true, body: JSON.stringify({ status: 'failed', error: { message: 'fixture provider failure' }, output: [textItem, item()], usage }) },
    'responses-json-incomplete': { json: true, body: JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [textItem, item()], usage }) },
    'responses-json-valid': { json: true, body: JSON.stringify({ status: 'completed', output: [textItem, item()], usage }) },
    'responses-json-status-omitted': { json: true, body: JSON.stringify({ output: [textItem], usage }) },
    'responses-json-broken-tool': { json: true, body: JSON.stringify({ status: 'completed', output: [item('{"path":"unfinished')], usage }) },
    'responses-json-no-arguments': { json: true, body: JSON.stringify({ status: 'completed', output: [{ type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'read_file' }], usage }) },
    'responses-tool-then-failed': { body: added(item()) + itemDone(item()) + frame({ type: 'response.failed', response: { error: { message: 'fixture provider failure' }, usage } }) },
    'responses-tool-eof': { body: added(item()) + itemDone(item()) },
    'responses-tool-good': { body: added(item()) + itemDone(item()) + responseDone({ usage }), hold: true },
    'responses-tool-missing-done': { body: added(item()) + responseDone({ usage }) },
    'responses-tool-broken': { body: added(item('{"path":"unfinished')) + responseDone({ usage }) },
    'responses-final-tool-broken': { body: added(item()) + itemDone(item('{"path":"unfinished')) + responseDone({ usage }) },
    'responses-arguments-done': { body: added(item('')) + frame({ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"path":' }) + frame({ type: 'response.function_call_arguments.done', item_id: 'item_1', name: 'read_file', arguments: '{"path":"ok"}' }) + responseDone({ usage }) },
    'responses-call-id-alias': { body: added(item('')) + frame({ type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: '{"path":"ok"}' }) + responseDone({ usage }) },
    'responses-snapshot-only': { body: responseDone({ output: [textItem], usage }) },
    'responses-snapshot-tool-only': { body: responseDone({ output: [item()], usage }) },
    'responses-normal-text': { body: frame({ type: 'response.output_text.delta', delta: 'OK' }) + responseDone({ output: [textItem], usage }) },
    'anthropic-json-error': { json: true, body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'fixture provider failure' }, usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) },
    'anthropic-json-incomplete': { json: true, body: JSON.stringify({ type: 'message', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'PARTIAL' }, { type: 'tool_use', id: 'call_1', name: 'pwd', input: {} }], usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) },
    'anthropic-json-valid': { json: true, body: JSON.stringify({ type: 'message', stop_reason: 'tool_use', content: [{ type: 'text', text: 'OK' }, { type: 'tool_use', id: 'call_1', name: 'pwd', input: {} }], usage: { input_tokens: 50, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) },
  };
  const sockets = new Set<net.Socket>(); const requestCounts: Record<string, number> = {}; const closed: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      const key = (req.url || '').split('/')[1]; const fixture = fixtures[key];
      requestCounts[key] = (requestCounts[key] || 0) + 1;
      res.once('close', () => { closed[key] = (closed[key] || 0) + 1; });
      if (!fixture) { res.writeHead(404); res.end('unknown fixture'); return; }
      res.writeHead(200, { 'content-type': fixture.json ? 'application/json' : 'text/event-stream', ...(key.includes('overloaded') ? { 'retry-after': '2' } : {}) }); res.write(fixture.body);
      if (!fixture.hold) res.end();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const collect = async (key: string) => {
    const adapter = key.startsWith('chat-') ? new ChatCompletionsAdapter('fixture') : new ResponsesAdapter('fixture');
    const controller = new AbortController(); const watchdog = setTimeout(() => controller.abort(), 1000);
    const events: NormalizedProviderEvent[] = [];
    try { for await (const event of adapter.execute({ url: `${base}/${key}`, headers: {}, body: {} }, controller.signal)) events.push(event); }
    finally { clearTimeout(watchdog); }
    assert.equal(controller.signal.aborted, false, 'provider terminal must beat the watchdog'); return events;
  };
  try {
    for (const key of ['chat-inband-overloaded', 'chat-json-overloaded', 'responses-inband-overloaded', 'responses-json-overloaded']) {
      await check(`${key} retains semantic error codes on HTTP 200`, async () => {
        const events = await collect(key);
        assert.equal(completed(events).length, 0); assert.equal(failure(events).length, 1);
        assert.equal(classifyRouteFailure(failure(events)[0].error).type, 'server_error');
        assert.equal(classifyRouteFailure(failure(events)[0].error).retryable, true);
        assert.equal(classifyRouteFailure(failure(events)[0].error).retryAfterMs, 2000);
      });
    }
    for (const key of ['chat-eof-text', 'chat-empty-finish', 'chat-no-arguments', 'chat-json-no-arguments', 'chat-eof-tool', 'chat-eof-broken-tool', 'chat-inband-error', 'chat-inband-error-open', 'chat-length-text', 'chat-broken-tool', 'chat-mixed-tools', 'chat-cumulative-truncated-last', 'chat-cumulative-shorter-last', 'chat-null-correction', 'chat-json-length', 'chat-json-error', 'responses-json-failed', 'responses-json-incomplete', 'responses-json-broken-tool', 'responses-json-no-arguments', 'responses-tool-then-failed', 'responses-tool-eof', 'responses-tool-broken', 'responses-final-tool-broken']) {
      await check(`${key} reports failure without successful completion or executable tools`, async () => {
        const events = await collect(key);
        assert.equal(failure(events).length, 1); assert.equal(completed(events).length, 0); assert.equal(tools(events).length, 0);
        if (key.includes('inband-error') || key.endsWith('json-failed') || key.endsWith('then-failed')) assert.ok(failure(events)[0].error.includes('fixture provider failure'));
        if (key === 'chat-eof-text' || key === 'chat-inband-error') assert.equal(text(events), 'PARTIAL');
      });
    }
    for (const key of ['chat-success', 'chat-usage-tail', 'chat-finish-eof', 'chat-json-valid', 'responses-json-valid', 'responses-json-status-omitted', 'responses-normal-text', 'responses-snapshot-only']) {
      await check(`${key} preserves one successful text response`, async () => {
        const events = await collect(key); assert.equal(failure(events).length, 0); assert.equal(completed(events).length, 1); assert.equal(text(events), 'OK');
        if (key === 'chat-usage-tail') {
          const measured = events.find(event => event.type === 'usage.updated'); assert.equal(measured?.usage.cacheReadTokens, 0); assert.equal(measured?.usage.reported?.cacheRead, true);
        }
      });
    }
    for (const key of ['chat-valid-tool', 'chat-repeated-id', 'chat-cumulative-corrected', 'responses-tool-good', 'responses-tool-missing-done', 'responses-snapshot-tool-only', 'responses-arguments-done', 'responses-call-id-alias']) {
      await check(`${key} completes one exact tool only after success`, async () => {
        const events = await collect(key); assert.equal(failure(events).length, 0); assert.equal(completed(events).length, 1); assert.equal(tools(events).length, 1);
        assert.equal(tools(events)[0].id, 'call_1'); assert.equal(tools(events)[0].name, 'read_file'); assert.equal(tools(events)[0].arguments, '{"path":"ok"}');
      });
    }
    await check('two distinct id-only Chat calls stay distinct', async () => assert.equal(tools(await collect('chat-two-ids')).length, 2));
    await check('literal null argument delta preserves a valid nullable object field', async () => {
      const events = await collect('chat-null-fragment');
      assert.equal(failure(events).length, 0); assert.equal(completed(events).length, 1); assert.equal(tools(events).length, 1);
      assert.equal(tools(events)[0].arguments, '{"value":null}');
    });
    await check('failed Responses terminal retains already reported usage and explicit cache zero', async () => {
      const events = await collect('responses-tool-then-failed'); const actual = events.find(event => event.type === 'usage.updated')?.usage;
      assert.equal(actual?.inputTokens, 100); assert.equal(actual?.reported?.cacheRead, true); assert.equal(actual?.cacheReadTokens, 0);
    });
    await check('Chat EOF retains usage already delivered before failure', async () => {
      const events = await collect('chat-usage-eof'); const actual = events.find(event => event.type === 'usage.updated')?.usage;
      assert.equal(failure(events).length, 1); assert.equal(actual?.inputTokens, 100); assert.equal(actual?.reported?.cacheRead, true); assert.equal(actual?.cacheReadTokens, 0);
    });
    for (const [key, protocol, mode] of [['chat-json-error', 'openai', 'chat'], ['chat-json-length', 'openai', 'chat'], ['responses-json-failed', 'openai', 'responses'], ['responses-json-incomplete', 'openai', 'responses'], ['anthropic-json-error', 'anthropic', 'chat'], ['anthropic-json-incomplete', 'anthropic', 'chat']] as const) {
      await check(`${protocol}/${key} auxiliary chat rejects failed JSON while retaining one actual usage callback`, async () => {
        const provider = new LLMProvider('fixture', `${base}/${key}`, 'fixture-only', protocol, mode, true, 0, undefined, { enabled: false });
        const usageReports: unknown[] = [];
        let outcome = '';
        try { outcome = await provider.chat('fixture', [{ role: 'user', content: 'fixture' }], null, 0, 32, undefined, undefined, value => usageReports.push(value)); }
        catch (error) { outcome = String(error); }
        assert.ok(/\[(?:LLM Error|Error)/.test(outcome)); assert.equal(usageReports.length, 1);
        assert.equal((usageReports[0] as { reported: { cacheRead: boolean } }).reported.cacheRead, true);
      });
    }
    for (const [key, mode] of [['chat-eof-text', 'chat_stream'], ['responses-json-failed', 'responses']] as const) {
      await check(`${key} actual provider facade surfaces the failure`, async () => {
        const provider = new LLMProvider('fixture', `${base}/${key}`, 'fixture-only', 'openai', mode, true, 0, undefined, { enabled: false });
        const tokens = [];
        for await (const token of provider.chatStreamWithTools('fixture', [{ role: 'user', content: 'fixture' }], null, 0, 32, [])) tokens.push(token);
        assert.ok(tokens.some(token => token.type === 'text' && /\[(?:LLM Error|Error)/.test(token.text))); assert.ok(!tokens.some(token => token.type === 'tool_call'));
      });
    }
    for (const [key, protocol] of [['chat-eof-text', 'github_models'], ['chat-inband-error', 'github_models'], ['chat-broken-tool', 'github_models'], ['anthropic-json-error', 'anthropic'], ['anthropic-json-incomplete', 'anthropic']] as const) {
      await check(`${protocol}/${key} dedicated provider path fails without tool submission`, async () => {
        const provider = new LLMProvider('fixture', `${base}/${key}`, 'fixture-only', protocol, 'chat_stream', true, 0, undefined, { enabled: false });
        const tokens = []; for await (const token of provider.chatStreamWithTools('fixture', [{ role: 'user', content: 'fixture' }], null, 0, 32, [])) tokens.push(token);
        assert.ok(tokens.some(token => token.type === 'text' && /\[(?:LLM Error|Error)/.test(token.text))); assert.equal(tokens.filter(token => token.type === 'tool_call').length, 0);
        if (protocol === 'anthropic') assert.equal(tokens.find(token => token.type === 'usage')?.usage?.input, 50);
      });
    }
    for (const [key, protocol] of [['chat-usage-tail', 'github_models'], ['anthropic-json-valid', 'anthropic']] as const) {
      await check(`${protocol} successful dedicated response preserves usage and tools`, async () => {
        const provider = new LLMProvider('fixture', `${base}/${key}`, 'fixture-only', protocol, 'chat_stream', true, 0, undefined, { enabled: false });
        const tokens = []; for await (const token of provider.chatStreamWithTools('fixture', [{ role: 'user', content: 'fixture' }], null, 0, 32, [])) tokens.push(token);
        assert.equal(tokens.filter(token => token.type === 'text').map(token => token.text).join(''), 'OK'); assert.equal(tokens.find(token => token.type === 'usage')?.usage?.reported?.cacheRead, true);
        if (protocol === 'anthropic') assert.equal(tokens.filter(token => token.type === 'tool_call').length, 1);
      });
    }
  } finally {
    for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
  const failed = checks.filter(row => !row.passed).length;
  if (process.env.NEWMARK_COMPLETION_INTEGRITY_REPORT) fs.writeFileSync(process.env.NEWMARK_COMPLETION_INTEGRITY_REPORT, JSON.stringify({ checks, passed: checks.length - failed, failed, requestCounts, closed }, null, 2) + '\n');
  console.log(`providerCompletionIntegrityVerify: ${checks.length - failed} passed, ${failed} failed`); if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
