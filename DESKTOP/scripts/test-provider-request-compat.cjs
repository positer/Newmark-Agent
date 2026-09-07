'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { LLMProvider } = require('../dist/llm/provider');
const checks = [], cases = [], sockets = new Set();
let active;
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), url = new URL(req.url, 'http://local');
  const request = { pathname: url.pathname, query: [...url.searchParams], headers: req.headers, stream: body.stream === true };
  active.requests.push(request);
  // Do not print or persist actual credential values, even in this fixture.
  request.headers = { ...req.headers, authorization: req.headers.authorization ? '<present>' : undefined, 'x-api-key': req.headers['x-api-key'] ? '<present>' : undefined };
  try {
    assert.equal(url.pathname, active.expectedPath);
    assert.equal(url.searchParams.get('tenant'), active.query ? 'fixture' : null);
    assert.equal(url.searchParams.size, active.query ? 1 : 0);
    assert.equal(req.headers['content-type'], 'application/json');
    const expectAccept = body.stream === true ? 'text/event-stream' : active.protocol === 'github_models' ? 'application/vnd.github+json' : 'application/json';
    assert.equal(req.headers.accept, expectAccept);
    if (active.protocol === 'anthropic') {
      assert.equal(req.headers['x-api-key'], 'fixture-key'); assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
    } else {
      assert.equal(req.headers.authorization, active.noKey ? undefined : 'Bearer fixture-key');
      assert.equal(req.headers['x-api-key'], undefined);
      if (active.protocol === 'github_models') assert.equal(req.headers['x-github-api-version'], '2022-11-28');
      else assert.equal(req.headers['x-github-api-version'], undefined);
    }
  } catch (error) {
    active.headerError = String(error); res.statusCode = 422; res.end(JSON.stringify({ error: { message: 'Fixture rejected incompatible request headers or URL' } })); return;
  }
  if (active.fallback && active.requests.length === 1) {
    active.expectedPath = '/proxy/v1/responses'; active.mode = 'responses';
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'This model does not support Chat; use the Responses API.' } })); return;
  }
  if (active.retryMs) {
    res.statusCode = 503; res.setHeader('retry-after-ms', String(active.retryMs));
    res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable' } })); return;
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const usage = { input_tokens: 100, output_tokens: 10 };
  res.end(JSON.stringify(active.protocol === 'anthropic'
    ? { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'COMPATIBLE' }], usage }
    : active.mode === 'responses'
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'COMPATIBLE' }] }], usage }
      : { choices: [{ message: { role: 'assistant', content: 'COMPATIBLE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const protocol of ['openai', 'anthropic', 'github_models']) {
      for (const mode of protocol === 'openai' ? ['chat_stream', 'chat', 'responses'] : ['chat_stream', 'chat']) {
        for (const full of [false, true]) {
          const prefix = protocol === 'anthropic' ? '/gateway/v1' : protocol === 'github_models' ? '/orgs/fixture' : '/proxy/v1';
          const endpoint = protocol === 'anthropic' ? '/messages' : protocol === 'github_models' ? '/inference/chat/completions' : mode === 'responses' ? '/responses' : '/chat/completions';
          active = { name: `${protocol}/${mode}/${full ? 'full-endpoint-query' : 'base'}`, protocol, mode, query: full, expectedPath: prefix + endpoint, requests: [] };
          cases.push(active);
          const provider = new LLMProvider('Fixture', origin + prefix + (full ? endpoint + '?tenant=fixture' : ''), 'fixture-key', protocol, mode, true, 1500, undefined, { enabled: false });
          let answer = '', error = '';
          try {
            if (mode === 'chat') answer = await provider.chat('fixture-model', [{ role: 'user', content: 'hello' }], 'Test', 0, 32, AbortSignal.timeout(3000));
            else for await (const token of provider.chatStreamWithTools('fixture-model', [{ role: 'user', content: 'hello' }], 'Test', 0, 32, [], AbortSignal.timeout(3000))) answer += token.text || '';
          } catch (e) { error = String(e); }
          const passed = !active.headerError && !error && answer === 'COMPATIBLE' && active.requests.length === 1;
          checks.push({ name: active.name, passed, error: active.headerError || error || (passed ? undefined : answer) });
          console.log(`${passed ? 'PASS' : 'FAIL'} ${active.name}`);
        }
      }
    }
    active = { name: 'keyless local Chat', protocol: 'openai', mode: 'chat_stream', expectedPath: '/v1/chat/completions', query: false, noKey: true, requests: [] }; cases.push(active);
    const provider = new LLMProvider('Local', origin + '/v1', '', 'openai', 'chat_stream', true, 1500, undefined, { enabled: false });
    let answer = '';
    for await (const token of provider.chatStreamWithTools('fixture-model', [{ role: 'user', content: 'hello' }], '', 0, 32, [], AbortSignal.timeout(3000))) answer += token.text || '';
    const passed = !active.headerError && answer === 'COMPATIBLE';
    checks.push({ name: active.name, passed, error: active.headerError }); console.log(`${passed ? 'PASS' : 'FAIL'} ${active.name}`);
    active = { name: 'Chat-to-Responses fallback retains query and protocol headers', protocol: 'openai', mode: 'chat_stream', expectedPath: '/proxy/v1/chat/completions', query: true, fallback: true, requests: [] }; cases.push(active);
    const switched = new LLMProvider('Local', origin + '/proxy/v1/chat/completions?tenant=fixture', 'fixture-key', 'openai', 'chat_stream', true, 1500, undefined, { enabled: false });
    let switchedText = '';
    for await (const token of switched.chatStreamWithTools('fixture-model', [{ role: 'user', content: 'hello' }], '', 0, 32, [], AbortSignal.timeout(3000))) switchedText += token.text || '';
    const fallbackPassed = !active.headerError && switchedText === 'COMPATIBLE' && active.requests.length === 2;
    checks.push({ name: active.name, passed: fallbackPassed, error: active.headerError || (!fallbackPassed ? switchedText : undefined) }); console.log(`${fallbackPassed ? 'PASS' : 'FAIL'} ${active.name}`);
    for (const mode of ['chat_stream', 'chat', 'responses']) {
      active = { name: `${mode} preserves Retry-After-Ms through actual HTTP errors`, protocol: 'openai', mode, expectedPath: mode === 'responses' ? '/v1/responses' : '/v1/chat/completions', query: false, retryMs: 6500, requests: [] }; cases.push(active);
      const retryProvider = new LLMProvider('Local', origin + '/v1', 'fixture-key', 'openai', mode, true, 1500, undefined, { enabled: false });
      let errorText = '';
      try {
        if (mode === 'chat') errorText = await retryProvider.chat('fixture-model', [{ role: 'user', content: 'hello' }], '', 0, 32, AbortSignal.timeout(3000));
        else for await (const token of retryProvider.chatStreamWithTools('fixture-model', [{ role: 'user', content: 'hello' }], '', 0, 32, [], AbortSignal.timeout(3000))) errorText += token.text || '';
      } catch (error) { errorText = String(error); }
      const retryPassed = !active.headerError && /Retry-After: 6\.5s/.test(errorText) && active.requests.length === 1;
      checks.push({ name: active.name, passed: retryPassed, error: retryPassed ? undefined : errorText }); console.log(`${retryPassed ? 'PASS' : 'FAIL'} ${active.name}`);
    }
  } finally {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    const result = { at: new Date().toISOString(), checks, cases, passed: checks.every(c => c.passed), boundary: 'Actual LLMProvider and loopback HTTP; fixture-only credentials, no production state or paid API.' };
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(result, null, 2) + '\n');
    console.log(`${checks.filter(c => c.passed).length}/${checks.length} request compatibility checks passed`);
    if (!result.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
