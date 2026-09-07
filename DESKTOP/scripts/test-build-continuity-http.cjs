'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), assert = require('node:assert/strict');
const { Agent } = require('../dist/core/agent');
const clone = value => JSON.parse(JSON.stringify(value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } };
const tool = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const json = (res, message) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage }));
};
const event = payload => 'data: ' + JSON.stringify(payload) + '\n\n';
const checks = [], scenarios = [], sockets = new Set(), agents = [];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-build-continuity-http-'));
let current;
function check(name, test) {
  try { test(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: String(error) }); }
  console.log(`${checks.at(-1).passed ? 'PASS' : 'FAIL'} ${name}`);
}
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.messages.some(m => m.role === 'system' && String(m.content).includes('You are a conversation title generator.'))) {
      current.titles++; json(res, { role: 'assistant', content: 'Build continuity test' }); return;
    }
    current.requests.push(clone(body));
    const round = current.requests.length;
    if (round > 12) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'Fixture request bound exceeded' } })); return; }
    const mode = current.mode;
    if (mode === 'cancel') { json(res, { role: 'assistant', content: '' }); return; }
    if (round === 1) {
      json(res, { role: 'assistant', tool_calls: [tool(mode + '-provision', 'tool_provision', { names: ['git_status'] })] }); return;
    }
    if (mode === 'incomplete-tool') {
      res.setHeader('content-type', 'text/event-stream');
      res.end(event({ choices: [{ delta: { tool_calls: [{ index: 0, id: mode + '-unsafe', type: 'function', function: { name: 'pwd', arguments: '{"unfinished":' } }] }, finish_reason: null }] }));
      return;
    }
    if (round === 2) {
      json(res, { role: 'assistant', tool_calls: [tool(mode + '-pwd', 'pwd')] }); return;
    }
    if (mode === 'truncated-text') {
      res.setHeader('content-type', 'text/event-stream');
      res.end(event({ choices: [{ delta: { content: 'PARTIAL_CONTINUITY_TEXT' }, finish_reason: null }] })); return;
    }
    if (mode === 'cancel-text') {
      res.setHeader('content-type', 'text/event-stream');
      res.write(event({ choices: [{ delta: { content: 'CANCELLED_VISIBLE_CONTINUITY_TEXT' }, finish_reason: null }] })); return;
    }
    if (round === 3) {
      res.statusCode = 503; res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable' } })); return;
    }
    if (round === 4) { json(res, { role: 'assistant', content: '' }); return; }
    if (round === 5) {
      res.setHeader('content-type', 'text/event-stream');
      res.end(event({ choices: [{ delta: { reasoning_content: 'Considering the already completed tool result.' }, finish_reason: null }] })
        + event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + 'data: [DONE]\n\n'); return;
    }
    json(res, { role: 'assistant', content: 'BUILD_CONTINUITY_COMPLETE' });
  } catch (error) {
    checks.push({ name: 'fixture HTTP handler', passed: false, error: String(error) });
    res.statusCode = 500; res.end('Fixture failure');
  }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const mode of ['mixed', 'truncated-text', 'incomplete-tool', 'cancel', 'cancel-text']) {
      const stateRoot = path.join(root, mode); fs.mkdirSync(stateRoot);
      fs.writeFileSync(path.join(stateRoot, 'config.json'), JSON.stringify({
        models: { providers: [{ id: 'local', name: 'Local continuity fixture', protocol: 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: 'fixture-only', enabled: true,
          models: [{ name: 'continuity', max_tokens: 128000, enabled: true, capabilities: ['text_input', 'text_output', 'tool_use'] }] }], default_model: 'continuity', auto_switch: false, fallback_on_unavailable: false },
        context: { auto_compress: false }, workspace: { auto_create_timestamp_workspace: false }, network: { proxy_enabled: false },
      }));
      const agent = new Agent(stateRoot, { agentOnly: true, workspaceRegistryMode: 'detached' });
      agents.push(agent);
      agent.workspace.current = { id: mode, name: mode, path: stateRoot, kind: 'local', isInternal: false };
      agent.setConversation(mode);
      current = { mode, requests: [], titles: 0, statusEvents: [], error: '', text: '' };
      scenarios.push(current);
      const record = agent.recordWorkStatus.bind(agent);
      let stoppedAt = 0;
      const unsubscribe = agent.subscribeWorkEvents(event => {
        if (mode === 'cancel-text' && event.type === 'text' && event.content.includes('CANCELLED_VISIBLE_CONTINUITY_TEXT') && !stoppedAt) {
          stoppedAt = Date.now(); setTimeout(() => agent.abortActiveKernelRun('partial-text-stop-fixture'), 5);
        }
      });
      agent.recordWorkStatus = text => {
        current.statusEvents.push(String(text)); record(text);
        if (mode === 'cancel' && String(text).includes('[Model retry]') && !stoppedAt) {
          stoppedAt = Date.now(); setTimeout(() => agent.abortActiveKernelRun('retry-cancel-fixture'), 5);
        }
      };
      const watchdog = setTimeout(() => agent.abortActiveKernelRun('fixture-watchdog'), 16000);
      const started = Date.now();
      try { current.text = (await agent.process('BUILD_CONTINUITY: read the working directory once and then answer.')).map(t => t.text || '').join(''); }
      catch (error) { current.error = `${error.name}: ${error.message}`; }
      finally { clearTimeout(watchdog); unsubscribe(); }
      current.elapsedMs = Date.now() - started;
      current.stopLatencyMs = stoppedAt ? Date.now() - stoppedAt : null;
      current.history = clone(agent.history);
      current.workRuns = clone(agent.workRuns);
      current.usage = clone(agent.conversationProviderUsage());
      agent.saveWorkspaceConversationState(true);
      check(`${mode}: title gate completes once and runtime returns idle`, () => {
        assert.equal(current.titles, 1); assert.equal(agent.activeProcessSignal(), undefined);
        assert.ok(!agent.workRuns.some(run => run.status === 'running'));
      });
      if (mode === 'mixed') {
        check('503 then empty then thought-only continues to a real answer on the same deployment', () => {
          assert.equal(current.error, ''); assert.ok(current.text.includes('BUILD_CONTINUITY_COMPLETE'));
          assert.equal(current.requests.length, 6); assert.ok(current.requests.every(r => r.model === 'continuity'));
        });
        check('the completed tool is neither lost nor executed again during recovery', () => {
          assert.equal(current.history.filter(m => m.role === 'tool' && m.tool_call_id === 'mixed-pwd').length, 1);
          for (const r of current.requests.slice(2)) assert.equal(r.messages.filter(m => m.role === 'tool' && m.tool_call_id === 'mixed-pwd').length, 1);
          assert.equal(current.workRuns.flatMap(r => r.events || []).filter(t => t.type === 'tool_call' && t.toolName === 'pwd').length, 1);
        });
        check('recovery preserves the exact submitted system, tools and completed-history prefix', () => {
          const failed = current.requests[2]; assert.ok(failed);
          for (const r of current.requests.slice(3)) {
            assert.deepEqual(r.messages, failed.messages); assert.deepEqual(r.tools, failed.tools);
          }
        });
        check('all response usage is recorded once and missing error usage does not become zero-cache coverage', () => {
          assert.equal(current.usage.totals.input, 600); assert.equal(current.usage.totals.output, 60);
          assert.equal(agent.contextWindow().providerUsageRequests, 7);
          assert.equal(agent.contextWindow().providerCacheReadRatio, null);
          assert.equal(agent.contextWindow().providerKnownCacheReadRatio, 0);
        });
        const reopened = new Agent(stateRoot, { agentOnly: true, workspaceRegistryMode: 'detached' }); agents.push(reopened);
        reopened.workspace.current = { ...agent.workspace.current }; reopened.setConversation(mode);
        check('the completed Build transcript and measured usage survive a cold Agent', () => {
          assert.deepEqual(reopened.history, agent.history);
          assert.deepEqual(reopened.conversationProviderUsage(), agent.conversationProviderUsage());
        });
      } else if (mode === 'truncated-text') {
        check('EOF after visible text cannot report a successful Build or replay the partial answer', () => {
          assert.match(current.error, /ProviderRunError/); assert.equal(current.requests.length, 3);
          assert.equal(current.workRuns.at(-1).status, 'error');
        });
      } else if (mode === 'incomplete-tool') {
        check('an unfinished streamed tool call is never executed', () => {
          assert.match(current.error, /ProviderRunError/);
          assert.ok(!current.history.some(m => m.tool_call_id === 'incomplete-tool-unsafe'));
          assert.ok(!current.workRuns.flatMap(r => r.events || []).some(t => t.type === 'tool_call' && t.toolName === 'pwd'));
          assert.ok(current.requests.length <= 3);
        });
      } else if (mode === 'cancel-text') {
        check('Stop after visible text remains interrupted and does not issue another request', () => {
          assert.match(current.error, /AbortError/); assert.equal(current.requests.length, 3);
          assert.equal(current.workRuns.at(-1).status, 'interrupted');
        });
      } else {
        check('Stop interrupts actual Build backoff promptly without another HTTP request', () => {
          assert.match(current.error, /AbortError/); assert.equal(current.requests.length, 1);
          assert.ok(current.stopLatencyMs !== null && current.stopLatencyMs < 180, String(current.stopLatencyMs));
          assert.equal(current.workRuns.at(-1).status, 'interrupted');
        });
      }
      if (mode === 'truncated-text' || mode === 'cancel-text') {
        const expected = mode === 'truncated-text' ? 'PARTIAL_CONTINUITY_TEXT' : 'CANCELLED_VISIBLE_CONTINUITY_TEXT';
        check(`${mode}: published partial text is saved exactly once without a successful final response`, () => {
          const events = current.workRuns.at(-1).events;
          assert.equal(events.filter(e => e.type === 'response' && e.content === expected).length, 1);
          assert.ok(!events.some(e => e.type === 'final_response' || e.type === 'text'));
          assert.ok(!current.history.some(m => m.role === 'assistant' && m.content === expected));
        });
        const reopened = new Agent(stateRoot, { agentOnly: true, workspaceRegistryMode: 'detached' }); agents.push(reopened);
        reopened.workspace.current = { ...agent.workspace.current }; reopened.setConversation(mode);
        check(`${mode}: partial response survives a cold Agent with its terminal status`, () => {
          const run = reopened.workRuns.at(-1);
          assert.equal(run.status, mode === 'truncated-text' ? 'error' : 'interrupted');
          assert.equal(run.events.filter(e => e.type === 'response' && e.content === expected).length, 1);
        });
      }
    }
  } finally {
    for (const agent of agents) agent.saveWorkspaceConversationState(true);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    const report = { at: new Date().toISOString(), checks, scenarios, passed: checks.every(c => c.passed), boundary: 'Actual compiled Agent/Kernel + loopback HTTP; isolated roots, no forced provider, paid API or production state.' };
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n');
    console.log(`${checks.filter(c => c.passed).length}/${checks.length} Build HTTP continuity checks passed`);
    // Each generated test root is scoped beneath os.tmpdir and never a user workspace.
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Unexpected test root');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
