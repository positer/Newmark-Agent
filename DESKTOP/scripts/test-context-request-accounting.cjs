'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Agent } = require('../dist/core/agent');
const { openAIChatMessages } = require('../dist/providers/chat-messages');

const argumentsList = process.argv.slice(2);
const option = name => argumentsList.includes(name) ? argumentsList[argumentsList.indexOf(name) + 1] : '';
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-context-request-accounting-'));
  const checks = [], requests = [], contexts = [], usageEvents = [], sockets = new Set(), agents = [];
  const rounds = { 1: 0, 2: 0 };
  let agent;
  const check = (name, action) => {
    action(); checks.push({ name, passed: true }); console.log('PASS ' + name);
  };
  const tool = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const usage = (input, output, cache) => ({ prompt_tokens: input, completion_tokens: output,
    ...(cache === undefined ? {} : { prompt_tokens_details: { cached_tokens: cache } }) });
  const jsonResponse = (res, message, actualUsage) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: actualUsage }));
  };
  const streamedResponse = (res, message, updates) => {
    res.setHeader('content-type', 'text/event-stream');
    const delta = message.tool_calls
      ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
      : { content: message.content };
    res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n');
    for (const update of updates) res.write('data: ' + JSON.stringify({ choices: [], usage: update }) + '\n\n');
    res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const title = body.messages.some(message => message.role === 'system' && String(message.content).includes('You are a conversation title generator.'));
      if (title) {
        requests.push({ title, stream: false });
        jsonResponse(res, { role: 'assistant', content: 'Context accounting fixture' }, usage(50, 5, 10));
        return;
      }
      const marker = body.messages.filter(message => message.role === 'user' && String(message.content).startsWith('CONTEXT_ACCOUNTING_BUILD_')).at(-1)?.content || '';
      const build = String(marker).includes('BUILD_2') ? 2 : 1;
      const round = ++rounds[build];
      const captured = contexts.at(-1);
      const live = clone(agent.contextWindow());
      const summary = { title: false, build, round, bodyMessageCount: body.messages.length - 1,
        systemHash: hash(body.messages[0]), toolsHash: hash(body.tools), toolNames: body.tools.map(value => value.function.name),
        messageRunIds: captured.messages.map(message => message.run_id || null), live };
      requests.push(summary);
      check(`Build ${build} round ${round}: measured snapshot belongs to the submitted request`, () => {
        assert.equal(live.contextEstimateSource, 'active_request');
        assert.equal(live.requestContext.requestId, captured.context.requestId);
        assert.equal(live.requestContext.messageCount, body.messages.length - 1);
        assert.deepEqual(body.messages, [{ role: 'system', content: captured.system }, ...openAIChatMessages(captured.messages)]);
        assert.deepEqual(body.tools, captured.tools);
      });
      check(`Build ${build} round ${round}: live history, Build, system and tool costs sum without billed-token rescaling`, () => {
        const context = live.requestContext;
        assert.equal(context.estimatedTokens, context.longHistoryTokens + context.buildBlockTokens + context.systemPromptTokens + context.toolSchemaTokens);
        assert.equal(live.estimatedTokens, context.estimatedTokens);
        assert.equal(live.buildBlockTokens, context.buildBlockTokens);
        assert.equal(live.longHistoryTokens, context.longHistoryTokens);
        assert.equal(live.systemPromptTokens, context.systemPromptTokens);
        assert.equal(live.toolSchemaTokens, context.toolSchemaTokens);
        assert.ok(context.systemPromptTokens > 0 && context.toolSchemaTokens > 0 && context.buildBlockTokens > 0);
        assert.equal(context.inputTokens, undefined, 'last request billing cannot be reused for a newly submitted request');
      });
      if (build === 1 && round === 1) {
        jsonResponse(res, { role: 'assistant', content: null, tool_calls: [tool('context-provision', 'tool_provision', { names: ['git_status'] })] }, usage(100, 10));
      } else if (build === 1 && round === 2) {
        streamedResponse(res, { role: 'assistant', tool_calls: [tool('context-pwd-one', 'pwd')] }, [usage(200, 5, 0), { completion_tokens: 20 }, usage(200, 20, 0)]);
      } else if (build === 1 && round === 3) {
        streamedResponse(res, { role: 'assistant', tool_calls: [tool('context-pwd-two', 'pwd')] }, [usage(400, 10, 300), usage(400, 10, 300), { completion_tokens: 40 }]);
      } else if (build === 1 && round === 4) {
        jsonResponse(res, { role: 'assistant', content: 'CONTEXT_ACCOUNTING_DONE_1' }, usage(800, 80, 600));
      } else if (build === 2 && round <= 3) {
        jsonResponse(res, round < 3
          ? { role: 'assistant', content: null, tool_calls: [tool(`context-second-pwd-${round}`, 'pwd')] }
          : { role: 'assistant', content: 'CONTEXT_ACCOUNTING_DONE_2' }, usage(800 + round * 100, 80 + round * 10, 0));
      } else {
        throw Error(`Unexpected additional model request: Build ${build}, round ${round}`);
      }
    } catch (error) {
      checks.push({ name: 'HTTP request verification', passed: false, error: error.stack || String(error) });
      res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'Isolated fixture request verification failed' } }));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const report = { at: new Date().toISOString(), checks, requests, usageEvents,
    boundary: 'Compiled actual Agent.process and Native Kernel with loopback HTTP Chat JSON/SSE transport; no forced provider, account, paid calls, GUI or production state.' };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      models: { providers: [{ id: 'context-loopback', name: 'Context loopback', protocol: 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: 'fixture-only', enabled: true,
        models: [{ name: 'context-loopback', max_tokens: 128000, enabled: true, capabilities: ['text_input', 'text_output', 'tool_use'] }] }], default_model: 'context-loopback', auto_switch: false, fallback_on_unavailable: false },
      context: { auto_compress: false }, workspace: { auto_create_timestamp_workspace: false }, network: { proxy_enabled: false },
    }));
    const workspace = { id: 'context-fixture', name: 'Context fixture', path: root, isInternal: false, kind: 'local' };
    const make = target => {
      const instance = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached' });
      agents.push(instance); instance.workspace.current = { ...workspace }; instance.workspace.external = [{ ...workspace }]; instance.setConversation(target);
      return instance;
    };
    agent = make('context-requests');
    const originalContext = agent.recordRequestContext.bind(agent);
    agent.recordRequestContext = (request, messages, system, tools, model) => {
      originalContext(request, messages, system, tools, model);
      contexts.push({ messages: clone(messages), system, tools: clone(tools), context: clone(agent.contextWindow().requestContext) });
    };
    const originalUsage = agent.recordProviderUsage.bind(agent);
    agent.recordProviderUsage = (input, request) => {
      originalUsage(input, request);
      const snapshot = agent.contextWindow();
      usageEvents.push({ requestId: request?.id, input: clone(input), totals: clone(agent.providerUsageTotals),
        context: snapshot.requestContext, coverage: [snapshot.providerUsageRequests, snapshot.providerUsageCacheReportedRequests] });
    };
    for (const build of [1, 2]) {
      const tokens = await agent.process(`CONTEXT_ACCOUNTING_BUILD_${build}: provision if needed, read the current working directory twice, and finish.`);
      check(`Build ${build} completes after two real pwd calls`, () => {
        assert.ok(tokens.some(token => String(token.text).includes(`CONTEXT_ACCOUNTING_DONE_${build}`)));
        const lastMessages = contexts.at(-1).messages;
        const expectedIds = build === 1 ? ['context-pwd-one', 'context-pwd-two'] : ['context-second-pwd-1', 'context-second-pwd-2'];
        for (const id of expectedIds) assert.ok(lastMessages.some(message => message.role === 'tool' && message.tool_call_id === id && String(message.content).includes(root)));
      });
      if (build === 1) {
        check('First Build totals include the independent title and deduplicate mixed JSON/SSE cumulative usage', () => {
          assert.deepEqual(agent.providerUsageTotals, { input: 1550, output: 155, cacheRead: 910, cacheWrite: 0 });
          const value = agent.contextWindow();
          assert.equal(value.providerUsageRequests, 5);
          assert.equal(value.providerUsageInputReportedRequests, 5);
          assert.equal(value.providerUsageOutputReportedRequests, 5);
          assert.equal(value.providerUsageCacheReportedRequests, 4);
          assert.equal(value.providerCacheReadRatio, null);
          assert.equal(value.providerKnownCacheReadRatio, 910 / 1450);
          assert.equal(value.providerCacheEligibleInputTokens, 1450);
        });
      }
    }
    const first = requests.filter(request => !request.title && request.build === 1);
    const second = requests.filter(request => !request.title && request.build === 2);
    check('Only one title and seven formal requests were necessary; zero cache never creates a retry', () => {
      assert.equal(requests.filter(request => request.title).length, 1);
      assert.equal(first.length, 4); assert.equal(second.length, 3);
    });
    check('Provisioning updates live tool schema cost while keeping the initialized system unchanged', () => {
      assert.ok(!first[0].toolNames.includes('git_status'));
      assert.ok(first[1].toolNames.includes('git_status'));
      assert.ok(first[1].live.toolSchemaTokens > first[0].live.toolSchemaTokens);
      assert.equal(new Set(first.map(value => value.systemHash)).size, 1);
    });
    check('Build-local tool results increase the real submitted message count and Build estimate', () => {
      assert.ok(first[2].bodyMessageCount > first[1].bodyMessageCount);
      assert.ok(first[3].bodyMessageCount > first[2].bodyMessageCount);
      assert.ok(first[2].live.buildBlockTokens > first[1].live.buildBlockTokens);
      assert.ok(first[3].live.buildBlockTokens > first[2].live.buildBlockTokens);
    });
    check('The next Build exposes prior history separately from its growing current tool context', () => {
      assert.ok(second[0].live.longHistoryTokens > 0);
      assert.ok(second.every(value => value.live.longHistoryTokens === second[0].live.longHistoryTokens));
      assert.ok(second[2].live.buildBlockTokens > second[0].live.buildBlockTokens);
    });
    check('Duplicate full SSE usage and partial output updates retain prior input/cache exactly once', () => {
      const repeated = usageEvents.filter(event => event.input.input === 400 && event.input.cacheRead === 300);
      assert.equal(repeated.length, 2);
      assert.deepEqual(repeated[1].totals, repeated[0].totals);
      const partial = usageEvents.find(event => event.input.output === 40 && event.input.reported?.input === false);
      assert.ok(partial);
      assert.equal(partial.context.inputTokens, 400);
      assert.equal(partial.context.cacheReadTokens, 300);
      assert.equal(partial.totals.input, 750);
    });
    const final = clone(agent.contextWindow());
    check('Actual server usage is shown separately from local estimates without proportional fabrication', () => {
      assert.deepEqual(agent.providerUsageTotals, { input: 4550, output: 455, cacheRead: 910, cacheWrite: 0 });
      assert.equal(final.providerLastInputTokens, 1100);
      assert.equal(final.requestContext.inputTokens, 1100);
      assert.equal(final.requestContext.cacheReadTokens, 0);
      assert.notEqual(final.requestContext.estimatedTokens, 1100);
      assert.equal(final.requestContext.estimatedTokens, final.requestContext.longHistoryTokens + final.requestContext.buildBlockTokens + final.requestContext.systemPromptTokens + final.requestContext.toolSchemaTokens);
      assert.equal(final.providerUsageRequests, 8);
      assert.equal(final.providerCacheReadRatio, null);
      assert.equal(final.providerKnownCacheReadRatio, 910 / 4450);
      assert.equal(final.providerCacheEligibleInputTokens, 4450);
      assert.equal(final.contextEstimateSource, 'history');
    });
    agent.saveWorkspaceConversationState(true);
    const persisted = clone(agent.conversationProviderUsage());
    agent.setConversation('empty-target');
    check('Switching to an empty conversation clears the preceding request and measured accounting', () => {
      const empty = agent.contextWindow();
      assert.equal(empty.providerUsageRequests, 0); assert.equal(empty.providerInputTokens, 0);
      assert.equal(empty.providerCacheReadRatio, null); assert.equal(empty.requestContext, null);
    });
    agent.setConversation('context-requests');
    check('Switching back restores exact cumulative totals, reporting coverage and submitted request snapshot', () => assert.deepEqual(agent.conversationProviderUsage(), persisted));
    const reopened = make('context-requests');
    check('A fresh Agent restores accounting and actual last-request components across restart', () => {
      assert.deepEqual(reopened.conversationProviderUsage(), persisted);
      assert.equal(reopened.contextWindow().providerKnownCacheReadRatio, 910 / 4450);
      assert.equal(reopened.contextWindow().providerCacheReadRatio, null);
      assert.equal(reopened.contextWindow().contextEstimateSource, 'history');
    });
    report.passed = checks.every(check => check.passed);
  } catch (error) {
    report.passed = false; report.error = error.stack || String(error); process.exitCode = 1;
  } finally {
    for (const instance of agents) instance.flushWorkspaceConversationState();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (option('--output')) fs.writeFileSync(path.resolve(option('--output')), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, checks: checks.length, formalRequests: requests.filter(value => !value.title).length, titleRequests: requests.filter(value => value.title).length, error: report.error }));
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('newmark-context-request-accounting-')) throw Error('Temporary cleanup path guard failed');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
