'use strict';

// Explicitly authorized paid acceptance. The provider and all model/tool
// replies are real; instrumentation observes them without supplying answers.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const semanticHash = value => hash(canonical(value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/test-subagent-real-provider-stress.cjs --allow-paid-api --out <report.json> [--config <local-config.json>] [--orchestrator [--orchestrator-timeout-ms <30000..480000>]]');
    return;
  }
  if (!args.includes('--allow-paid-api')) throw new Error('Explicit --allow-paid-api is required before any configuration is read or provider request starts.');
  const orchestrator = args.includes('--orchestrator');
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const output = path.resolve(option('--out', '../archive/subagent-real-provider.json'));
  const wireDirectory = output.replace(/\.json$/i, '') + '-wire';
  const source = JSON.parse(fs.readFileSync(option('--config', path.join(os.homedir(), '.Newmark', 'config.json')), 'utf8'));
  const unbox = value => value && typeof value === 'object' && 'value' in value ? value.value : value;
  const provider = unbox(source.models?.providers)?.find(item => item.name?.toLowerCase() === 'apinebula');
  const model = 'gpt-5.6-sol';
  if (!provider?.api_key || !provider.models?.some(item => item.name === model)) throw new Error('Configured APInebula/gpt-5.6-sol is unavailable.');
  const secret = provider.api_key;
  const endpoint = new URL(provider.base_url);
  const redact = value => String(value).split(secret).join('<redacted>').replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>');
  const originalConsole = Object.fromEntries(['log', 'warn', 'error'].map(name => [name, console[name].bind(console)]));
  for (const name of Object.keys(originalConsole)) console[name] = (...values) => originalConsole[name](...values.map(value => redact(typeof value === 'string' ? value : JSON.stringify(value))));

  const { Agent } = require('../dist/core/agent');
  const { LLMProvider } = require('../dist/llm/provider');
  const { releaseSharedSubagentManager } = require('../dist/core/subagent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-real-subagent-'));
  const workspace = path.join(root, 'synthetic-workspace');
  fs.mkdirSync(workspace);
  const started = performance.now();
  const orchestratorTimeoutMs = Number(option('--orchestrator-timeout-ms', '180000'));
  if (!Number.isInteger(orchestratorTimeoutMs) || orchestratorTimeoutMs < 30000 || orchestratorTimeoutMs > 480000) throw new Error('Orchestrator timeout must be an integer between 30000 and 480000 ms.');
  const requestLimit = orchestrator ? 30 : 100, stageLimitMs = orchestrator ? orchestratorTimeoutMs : 180000, totalLimitMs = orchestrator ? orchestratorTimeoutMs : 480000;
  const cleanupBudgetMs = 10000, workLimitMs = totalLimitMs - cleanupBudgetMs;
  const report = {
    startedAt: new Date().toISOString(), provider: provider.name, model, intelligence: 'ultra', modelThinking: false,
    endpoint: endpoint.origin + endpoint.pathname, root, workspace,
    bounds: { simultaneousPeers: 16, requestLimit, stageLimitMs, totalLimitMs },
    boundary: orchestrator
      ? 'One actual Ultra root.process receives four independent file tasks plus a root-owned manifest check. The real root model must create and assign its own four peers, retain local verification work, collect results and compute the final sum; the harness never creates its peers or supplies model replies. This tests model execution of an explicit delegation requirement, not spontaneous decomposition on an unspecified task.'
      : 'Manually dispatched 16 real Agent peers verify execution concurrency, file-tool ownership, silent default-false mailbox delivery without recipient requests/history/cache changes, explicit wakeup continuation, and a fresh owner restored from persisted state in the same process. They do not demonstrate model-autonomous task decomposition or an installed/package release. Cache usage is actual reported usage; zero cache never triggers a retry.',
    credentialBoundary: 'Saved config contains a non-secret placeholder. The selected credential is attached in memory only to real providerFetch requests to the configured provider origin; it is never placed in Agent config or evidence.',
    runtimeHashes: Object.fromEntries(['core/agent', 'core/agentKernelRunner', 'core/subagent', 'llm/provider', 'providers/chat-completions.adapter', 'providers/provider-events'].map(name => [name, hash(fs.readFileSync(path.join(__dirname, '../dist', name + '.js'), 'utf8'))])),
    phases: [], requests: [], streams: [], jobs: [], tools: [], checks: [], maxConcurrentPeers: 0, maxConcurrentStreams: 0,
  };
  const ownedAgents = [];
  const context = new AsyncLocalStorage();
  let phase = 'setup', totalRequests = 0, activeJobs = 0, activeStreams = 0, stopping = false;
  let host, ids = [];
  const fixtures = Array.from({ length: 16 }, (_, index) => ({ index, nonce: crypto.randomBytes(12).toString('hex'), value: crypto.randomInt(100, 900), file: path.join(workspace, `peer-${String(index).padStart(2, '0')}.json`) }));
  for (const fixture of fixtures) fs.writeFileSync(fixture.file, JSON.stringify({ nonce: fixture.nonce, value: fixture.value, owner_index: fixture.index }) + '\n');
  const safeConfig = {
    models: { providers: [{ id: 'real-subagent-provider', name: 'APInebula', base_url: provider.base_url, api_key: 'memory-injected-at-transport', protocol: 'openai', enabled: true,
      models: [{ name: model, max_tokens: 128000, enabled: true, capabilities: ['text_input', 'text_output', 'tool_use'], thinking: false }] }],
      default_model: model, openai_api_mode: 'chat_stream', default_intelligence: 'ultra', auto_switch: false, fallback_on_unavailable: false, agent_engine: 'builtin' },
    context: { auto_compress: false, provider_adapters_v2: true, agent_runtime_v2: true },
    workspace: { auto_create_timestamp_workspace: false, access_permission: 'full_access', on_permission_violation: 'deny' },
    network: { proxy_enabled: false }, agent: { default_mode: 'build', option_feedback: 'fully_autonomous' },
    skills: { auto_download: 'disabled' },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(safeConfig, null, 2));
  const save = final => {
    report.elapsedMs = performance.now() - started;
    if (final) { report.finishedAt = new Date().toISOString(); report.ok = !report.fatal && report.phases.length === (orchestrator ? 1 : 4) && report.checks.every(check => check.ok); }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, redact(JSON.stringify(report, null, 2)) + '\n');
  };
  const check = (name, fn) => {
    try { fn(); report.checks.push({ name, ok: true }); }
    catch (error) { report.checks.push({ name, ok: false, error: redact(error.message) }); }
  };
  const stop = reason => {
    if (!report.stopReason) report.stopReason = reason;
    if (reason === 'total-deadline') report.timedOut = true;
    stopping = true;
    for (const owner of ownedAgents) owner.abortActiveKernelRun(`bounded-real-subagent-test:${reason}`);
  };
  const originalJob = Agent.prototype.runSubagentJob;
  const originalFetch = LLMProvider.prototype.providerFetch;
  const originalStream = LLMProvider.prototype.chatStreamWithTools;
  Agent.prototype.runSubagentJob = async function(id, prompt, flowName, reason) {
    const row = { peer: id, phase, reason, promptHash: hash(prompt), assignment: orchestrator ? this.subagents.get(id)?.prompt : undefined, atMs: performance.now() - started };
    report.jobs.push(row); activeJobs++; report.maxConcurrentPeers = Math.max(report.maxConcurrentPeers, activeJobs);
    try {
      return await context.run({ peer: id, phase, job: row }, async () => {
        const result = await originalJob.call(this, id, prompt, flowName, reason);
        row.result = result; row.resultHash = hash(result); return result;
      });
    } catch (error) { row.error = redact(error.message); throw error; }
    finally { activeJobs--; row.elapsedMs = performance.now() - started - row.atMs; save(); }
  };
  LLMProvider.prototype.providerFetch = async function(input, init = {}, streaming = false) {
    const target = new URL(String(input));
    if (target.origin !== endpoint.origin) throw new Error('Provider request outside the configured origin was refused.');
    if (stopping || performance.now() - started >= workLimitMs || totalRequests >= requestLimit) {
      stop('request-or-time-budget'); throw new Error('Bounded real-provider request budget reached.');
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const messages = body.messages || body.input || [];
    const store = context.getStore();
    const lastUser = messages.filter(message => message.role === 'user').at(-1);
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content
      : (lastUser?.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n');
    const rootInboxMessageId = lastUserText.match(/^\[Root subagent inbox id=([0-9a-f-]{36})\b/i)?.[1];
    const rootInboxMessage = rootInboxMessageId && host?.subagents.serialize().rootInbox.find(message => message.id === rootInboxMessageId);
    const resultObservedBeforeRequest = rootInboxMessage?.source === 'automatic-settlement' && host.history.some(message =>
      message.role === 'tool' && message.subagent_settlement_receipt?.peerId === rootInboxMessage.fromAgentId
      && message.subagent_settlement_receipt?.revision === rootInboxMessage.settlementRevision);
    const row = { index: ++totalRequests, phase: store?.phase || phase, peer: store?.peer || null,
      stream: store?.stream?.index || null, path: target.pathname, model: body.model, atMs: performance.now() - started,
      reasoningEffort: body.reasoning_effort || body.reasoning?.effort || null,
      systemHash: hash(body.instructions || messages.filter(message => message.role === 'system')),
      toolsHash: hash(body.tools || []), toolHashes: (body.tools || []).map(hash),
      messagesHash: hash(messages), messageHashes: messages.map(hash), messageCount: messages.length,
      semanticMessageHashes: messages.map(semanticHash),
      messageShapes: messages.map(message => ({ role: message.role || message.type, keys: Object.keys(message), contentHash: hash(message.content ?? null), toolCallsHash: hash(message.tool_calls || null) })),
      rootInboxMessageId: rootInboxMessageId || null, rootInboxSource: rootInboxMessage?.source || null,
      rootInboxRevision: rootInboxMessage?.settlementRevision || null,
      resultObservedBeforeRequest: resultObservedBeforeRequest === true,
      requestHash: hash(body), bytes: Buffer.byteLength(init.body || '') };
    fs.mkdirSync(wireDirectory, { recursive: true });
    row.wireSnapshot = path.join(wireDirectory, `request-${String(row.index).padStart(3, '0')}.json`);
    fs.writeFileSync(row.wireSnapshot, redact(JSON.stringify({ peer: row.peer, phase: row.phase, messages, tools: body.tools || [], instructions: body.instructions }, null, 2)) + '\n');
    report.requests.push(row); save();
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${secret}`);
    try {
      const response = await originalFetch.call(this, input, { ...init, headers }, streaming);
      row.status = response.status; row.headerMs = performance.now() - started - row.atMs;
      row.requestId = response.headers.get('x-request-id') || response.headers.get('request-id');
      return response;
    } catch (error) { row.error = redact(error.message); throw error; }
    finally { save(); }
  };
  LLMProvider.prototype.chatStreamWithTools = async function* (...streamArgs) {
    const store = context.getStore() || {};
    const row = { index: report.streams.length + 1, phase: store.phase || phase, peer: store.peer || null,
      atMs: performance.now() - started, systemHash: hash(streamArgs[2] || ''), toolsHash: hash(streamArgs[5] || []), usage: null };
    report.streams.push(row); activeStreams++; report.maxConcurrentStreams = Math.max(report.maxConcurrentStreams, activeStreams);
    const generator = context.run({ ...store, stream: row }, () => originalStream.apply(this, streamArgs));
    try {
      while (true) {
        const next = await context.run({ ...store, stream: row }, () => generator.next());
        if (next.done) break;
        if (next.value.type === 'usage' && next.value.usage) row.usage = { ...(row.usage || {}), ...next.value.usage };
        yield next.value;
      }
    } catch (error) { row.error = redact(error.message); throw error; }
    finally { await generator.return?.(); activeStreams--; row.elapsedMs = performance.now() - started - row.atMs; save(); }
  };
  const createOwner = () => {
    const owner = new Agent(root, { agentOnly: true, readOnlyConfig: true, workspaceRegistryMode: 'detached' });
    ownedAgents.push(owner);
    owner.workspace.current = { id: 'synthetic-real-subagent', name: 'Synthetic SubAgent acceptance', path: workspace, kind: 'local', isInternal: false };
    owner.setConversation('real-subagent-continuity'); owner.setIntelligence('ultra');
    owner.setModel(`deployment:real-subagent-provider:${model}`); owner.setMode('build');
    const captureTool = (event, actor) => {
      if (event.type === 'tool_call' || event.type === 'tool_result') report.tools.push({ phase, peer: actor, type: event.type, name: event.toolName, toolCallId: event.toolCallId, atMs: performance.now() - started,
        arguments: event.toolArgs || event.toolArguments, contentHash: hash(event.content || ''), contentPreview: String(event.content || '').slice(0, 800) });
    };
    owner.subscribePeerWorkEvents(event => captureTool(event, event.actorId));
    if (orchestrator) owner.subscribeWorkEvents(event => captureTool(event, 'root'));
    return owner;
  };
  const runPhase = async (name, selected, action, expected) => {
    phase = name;
    const row = { name, atMs: performance.now() - started, peerCount: selected?.length || 16, requestStart: totalRequests };
    report.phases.push(row); save();
    const deadline = Math.min(started + workLimitMs, performance.now() + stageLimitMs);
    await action();
    while (host.subagents.hasPendingWork()) {
      if (stopping || performance.now() >= deadline) { row.timedOut = true; stop(name); throw new Error(`Phase ${name} exceeded its bounded duration.`); }
      await pause(50);
    }
    row.elapsedMs = performance.now() - started - row.atMs; row.requests = totalRequests - row.requestStart;
    const currentIds = selected || ids;
    row.results = currentIds.map(id => ({ id, status: host.subagents.get(id)?.status, result: host.subagents.get(id)?.result, contextMessages: host.subagents.get(id)?.messages.length }));
    for (const id of currentIds) {
      const fixture = fixtures[ids.indexOf(id)], record = host.subagents.get(id);
      check(`${name}:peer-${fixture.index}:completed`, () => assert.equal(record.status, 'completed', record.error));
      check(`${name}:peer-${fixture.index}:nonce-and-arithmetic`, () => {
        assert.ok(record.result?.includes(fixture.nonce), `missing original nonce: ${record.result}`);
        assert.match(record.result || '', new RegExp(`\\b${expected(fixture)}\\b`));
        for (const other of fixtures) if (other !== fixture) assert.ok(!record.result.includes(other.nonce), 'another peer nonce leaked into result');
      });
    }
    save(); originalConsole.log(JSON.stringify({ phase: name, peers: currentIds.length, requests: row.requests, elapsedMs: row.elapsedMs, failedChecks: report.checks.filter(item => !item.ok).length }));
    if (row.results.some(result => result.status !== 'completed')) throw new Error(`Phase ${name} has a failed real peer; later paid stages are not started.`);
  };
  const deadlineTimer = setTimeout(() => stop('total-deadline'), workLimitMs);
  const progressTimer = setInterval(() => { save(); originalConsole.log(JSON.stringify({ progress: true, phase, totalRequests, activeJobs, activeStreams, elapsedMs: performance.now() - started })); }, 30000);
  progressTimer.unref();
  process.once('SIGINT', () => stop('SIGINT'));
  try {
    if (orchestrator) {
      phase = 'ultra-model-orchestrator'; host = createOwner();
      const selected = fixtures.slice(0, 4), sum = selected.reduce((value, fixture) => value + fixture.value * 2 + fixture.index, 0);
      const manifest = path.join(workspace, 'root-only-check.json');
      fs.writeFileSync(manifest, JSON.stringify({ expected_sum: sum, check_id: crypto.randomBytes(8).toString('hex') }) + '\n');
      const row = { name: phase, atMs: performance.now() - started, peerCount: 4, expectedSum: sum };
      report.phases.push(row);
      const prompt = `Perform this bounded synthetic parallel verification using your real SubAgent tool. There are four independent JSON input files:\n${selected.map(fixture => fixture.file).join('\n')}\nCreate exactly four peer agents in parallel and give each one exclusive responsibility for one listed file. Each peer must use read on its own file and return nonce, owner_index, and answer=value*2+owner_index, with no delegation or other work. Do not read these four input files yourself. After dispatch, keep useful work for yourself: independently read ${manifest} while the peers work, and retain the manifest expected_sum. Obtain completed results from all four actual peers, verify distinct ownership and add their four answers. Do not repeatedly send directives or recreate a peer. Do not finish with only a plan or a delegation status. Finish only after all four results are available, with JSON containing nonces (all four original nonces), sum (your arithmetic sum of peer answers), and verified (comparison to manifest expected_sum). Use no network tools and make no writes. Provision SubAgent and peer inspection tools if needed.`;
      row.promptHash = hash(prompt);
      const tokens = await context.run({ peer: 'root', phase }, () => host.process(prompt));
      row.result = tokens.map(token => token.text || '').join('').trim();
      row.finalResponse = String(host.history.filter(message => message.role === 'assistant' && !message.tool_calls?.length).at(-1)?.content || row.result);
      // process() can also drain automatic peer-result mailbox turns after
      // completing the original user task. Preserve those real responses,
      // while grading the final belonging to the requested primary turn.
      const primaryIndex = host.history.findIndex(message => message.role === 'user' && String(message.content || '').includes(prompt));
      const nextUserIndex = host.history.findIndex((message, index) => index > primaryIndex && message.role === 'user');
      const primaryHistory = host.history.slice(primaryIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex);
      row.primaryFinalResponse = String(primaryHistory.filter(message => message.role === 'assistant' && !message.tool_calls?.length).at(-1)?.content || '');
      row.automaticFollowUpResponses = nextUserIndex < 0 ? [] : host.history.slice(nextUserIndex).filter(message => message.role === 'assistant' && !message.tool_calls?.length).map(message => String(message.content || ''));
      row.settlementReceipts = host.history.filter(message => message.role === 'tool' && message.subagent_settlement_receipt)
        .map(message => ({ tool: message.name, ...message.subagent_settlement_receipt }));
      row.automaticFollowUpRequestIndices = report.requests.filter(request => request.peer === 'root' && request.rootInboxSource === 'automatic-settlement').map(request => request.index);
      row.redundantAutomaticFollowUpRequestIndices = report.requests.filter(request => request.peer === 'root' && request.resultObservedBeforeRequest).map(request => request.index);
      while (host.subagents.hasPendingWork() && !stopping && performance.now() - started < workLimitMs) await pause(50);
      if (host.subagents.hasPendingWork()) throw new Error('Ultra model orchestration exceeded the bounded duration.');
      ids = host.subagents.listAll().map(record => record.id);
      row.elapsedMs = performance.now() - started - row.atMs; row.requests = totalRequests;
      row.peers = host.subagents.listAll().map(record => ({ id: record.id, prompt: record.prompt, status: record.status, result: record.result }));
      check('ultra root model creates exactly four actual peers', () => { assert.equal(ids.length, 4); assert.equal(report.tools.filter(tool => tool.peer === 'root' && tool.type === 'tool_call' && tool.name === 'SubAgent').length, 4); });
      check('four independently owned peer reads complete', () => {
        const readers = [];
        for (const fixture of selected) {
          const matching = report.tools.filter(tool => tool.peer !== 'root' && tool.type === 'tool_call' && /^(?:read|read_file)$/.test(tool.name || '') && String(tool.arguments || '').includes(path.basename(fixture.file)));
          assert.equal(matching.length, 1, `one read for ${path.basename(fixture.file)}`); readers.push(matching[0].peer);
          const record = host.subagents.get(matching[0].peer); assert.equal(record.status, 'completed');
          assert.ok(record.result.includes(fixture.nonce)); assert.match(record.result, new RegExp(`\\b${fixture.value * 2 + fixture.index}\\b`));
        }
        assert.equal(new Set(readers).size, 4, 'each file has a distinct assigned peer');
      });
      check('root retains independent manifest verification while peers work', () => {
        const reads = report.tools.filter(tool => tool.peer === 'root' && tool.type === 'tool_call' && /^(?:read|read_file)$/.test(tool.name || ''));
        const manifestRead = reads.find(tool => String(tool.arguments || '').includes(path.basename(manifest)));
        assert.ok(manifestRead, 'root must read its own manifest');
        assert.ok(!reads.some(tool => selected.some(fixture => String(tool.arguments || '').includes(path.basename(fixture.file)))), 'root must not duplicate peer file reads');
        assert.ok(report.jobs.some(job => manifestRead.atMs >= job.atMs && manifestRead.atMs <= job.atMs + job.elapsedMs), 'root performs its local check during peer execution');
      });
      check('root completes with all original nonces and the correct sum', () => {
        assert.equal(host.status, 'idle');
        for (const fixture of selected) assert.ok(row.primaryFinalResponse.includes(fixture.nonce), `missing nonce ${fixture.index}`);
        const json = JSON.parse(row.primaryFinalResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
        assert.equal(json.sum, sum); assert.equal(json.verified, true);
      });
      check('actual delegated jobs overlap without exceeding the Ultra cap', () => { assert.ok(report.maxConcurrentPeers > 1); assert.ok(report.maxConcurrentPeers <= 16); });
      check('all four completed results have explicit persisted read receipts', () => {
        for (const id of ids) assert.ok(row.settlementReceipts.some(receipt => receipt.peerId === id
          && receipt.revision === host.subagents.get(id).settlementRevision), `missing explicit current-revision result read for ${id}`);
      });
      check('explicit result reads avoid redundant automatic confirmations', () => {
        assert.deepEqual(row.redundantAutomaticFollowUpRequestIndices, []);
        assert.deepEqual(row.automaticFollowUpResponses, [], 'no extra automatic response after the primary task final');
      });
      report.actualUsage = report.streams.map(stream => ({ peer: stream.peer, stream: stream.index, usage: stream.usage }));
      report.rootUsage = host.conversationProviderUsage();
      save();
      return;
    }
    host = createOwner(); host.beginConversationWorkRun('manual-ultra-real-subagent');
    await runPhase('initial-16', null, async () => {
      const accepted = await Promise.all(fixtures.map(fixture => host.handleSubagentEnvelope(JSON.stringify({ name: `synthetic-reader-${fixture.index}`, model,
        prompt: `Read only this synthetic file using the read tool: ${fixture.file}. Its JSON contains nonce and value. Remember both for later mailbox turns. Reply with a single JSON object containing phase="initial", owner_index, nonce, and answer=value+7. Call no other tool and do not create peers or send messages. Keep your reply below 100 words.` }), true)));
      assert.ok(accepted.every(result => result.ok), 'all sixteen peers must be admitted'); ids = accepted.map(result => result.data.id);
    }, fixture => fixture.value + 7);
    const silentBefore = new Map(ids.map(id => [id, { history: hash(host.subagents.get(id).messages), cache: hash(host.subagents.get(id).metadata?.requestCache || null) }]));
    const silentRequestStart = totalRequests, silentJobStart = report.jobs.length;
    await runPhase('silent-mailbox-16', ids, async () => {
      for (const id of ids) {
        const delivery = host.subagents.sendMessage(host.runtimeActorId, id, 'Silent delivery check: retain the nonce and value from your original file. Wait for the next explicit continuation and answer only that instruction.');
        assert.equal(delivery.ok, true); assert.equal(delivery.message.wakeup, false);
      }
      await pause(150);
    }, fixture => fixture.value + 7);
    check('silent mailbox creates no provider request or peer execution', () => {
      assert.equal(totalRequests, silentRequestStart); assert.equal(report.jobs.length, silentJobStart);
      assert.equal(host.subagents.hasPendingWork(), false);
    });
    check('sixteen passive recipients retain unchanged history and request cache', () => {
      for (const id of ids) {
        const record = host.subagents.get(id), before = silentBefore.get(id);
        assert.equal(hash(record.messages), before.history); assert.equal(hash(record.metadata?.requestCache || null), before.cache);
        const passiveUnread = host.subagents.serialize().mailbox.filter(message => message.toAgentId === id && !message.readAt && message.wakeup === false);
        assert.equal(passiveUnread.length, 1);
      }
    });
    await runPhase('mailbox-16', ids, async () => {
      for (const id of ids) assert.ok(host.subagents.sendMessage(host.runtimeActorId, id, 'Continue your existing task from your working history. Do not read any file and call no tool. Recall your original nonce and original value; reply with one JSON object containing phase="mailbox", nonce, and answer=original_value*3+11. Do not restart, delegate, or send messages.', 'directive', {}, true).ok);
    }, fixture => fixture.value * 3 + 11);
    const beforeState = host.subagents.serialize();
    report.persistedStateHash = hash(beforeState); report.persistedPeerIds = beforeState.records.map(record => record.id);
    host.flushWorkspaceConversationState(); host.finishConversationWorkRun('manual-ultra-real-subagent', 'completed'); host.releaseConversationRuntimeBindings();
    releaseSharedSubagentManager(`${path.resolve(workspace).toLowerCase()}::real-subagent-continuity`);
    host = createOwner();
    check('cold-owner: restored all peer identities', () => assert.deepEqual(host.subagents.listAll().map(record => record.id), ids));
    check('cold-owner: persisted transcript content restored', () => {
      for (const record of beforeState.records) assert.equal(hash(host.subagents.get(record.id).messages), hash(record.messages));
    });
    await runPhase('cold-owner-4', ids.slice(0, 4), async () => {
      for (const id of ids.slice(0, 4)) assert.ok(host.subagents.sendMessage(host.runtimeActorId, id, 'Continue from your saved peer history after owner restart. Do not use tools. Recall your original nonce and original value; reply with JSON phase="cold", nonce, and answer=original_value*5-3.', 'directive', {}, true).ok);
    }, fixture => fixture.value * 5 - 3);
    check('sixteen real peer executions overlap', () => assert.equal(report.maxConcurrentPeers, 16));
    check('real provider requests overlap without exceeding sixteen streams', () => { assert.ok(report.maxConcurrentStreams > 1); assert.ok(report.maxConcurrentStreams <= 16); });
    check('all requests belong to a known peer', () => assert.ok(report.requests.every(request => ids.includes(request.peer))));
    check('initial real read belongs to every peer', () => {
      for (const id of ids) assert.ok(report.tools.some(tool => tool.phase === 'initial-16' && tool.peer === id && tool.type === 'tool_call' && /^(?:read|read_file)$/.test(tool.name || '')), `no read call for ${id}`);
    });
    check('mailbox and cold continuation do not reread files', () => assert.ok(!report.tools.some(tool => tool.phase !== 'initial-16' && tool.type === 'tool_call')));
    const comparisons = [];
    for (const id of ids) {
      const requests = report.requests.filter(request => request.peer === id);
      for (let index = 1; index < requests.length; index++) {
        const previous = requests[index - 1], current = requests[index];
        comparisons.push({ peer: id, before: previous.index, after: current.index, phase: current.phase,
          stableSystem: previous.systemHash === current.systemHash, stableTools: previous.toolsHash === current.toolsHash,
          appendOnlyMessages: previous.messageHashes.every((item, offset) => current.messageHashes[offset] === item),
          semanticAppendOnlyMessages: previous.semanticMessageHashes.every((item, offset) => current.semanticMessageHashes[offset] === item),
          firstChangedMessageIndex: previous.messageHashes.findIndex((item, offset) => current.messageHashes[offset] !== item) });
      }
    }
    report.prefixComparisons = comparisons;
    check('same peer system prefix survives mailbox and cold owner', () => assert.ok(comparisons.every(item => item.stableSystem)));
    check('same peer serialized messages remain append-only', () => assert.ok(comparisons.every(item => item.appendOnlyMessages)));
    check('same peer semantic message prefix remains append-only', () => assert.ok(comparisons.every(item => item.semanticAppendOnlyMessages)));
    report.actualUsage = report.streams.map(stream => ({ peer: stream.peer, phase: stream.phase, stream: stream.index, usage: stream.usage }));
    report.cacheObservation = { streamsWithUsage: report.streams.filter(stream => stream.usage).length,
      reportedInput: report.streams.reduce((sum, stream) => sum + (stream.usage?.input || 0), 0),
      reportedCacheRead: report.streams.reduce((sum, stream) => sum + (stream.usage?.cacheRead || 0), 0) };
  } catch (error) { report.fatal = redact(error.stack || error.message); stop('failure'); }
  finally {
    clearTimeout(deadlineTimer); clearInterval(progressTimer);
    stop('cleanup');
    const cleanupDeadline = Math.min(performance.now() + cleanupBudgetMs, started + totalLimitMs);
    while ((activeJobs || activeStreams) && performance.now() < cleanupDeadline) await pause(50);
    report.cleanup = { activeJobs, activeStreams, canceledOwnedAgents: ownedAgents.length };
    check('owned peer and provider runs settled after cleanup', () => { assert.equal(activeJobs, 0); assert.equal(activeStreams, 0); });
    const files = [];
    const visit = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) visit(file); else if (entry.isFile()) files.push(file); } };
    visit(root);
    check('no credential written into isolated files', () => { for (const file of files) assert.ok(!fs.readFileSync(file).includes(Buffer.from(secret)), `credential leak in ${path.relative(root, file)}`); });
    Agent.prototype.runSubagentJob = originalJob; LLMProvider.prototype.providerFetch = originalFetch; LLMProvider.prototype.chatStreamWithTools = originalStream;
    save(true);
    originalConsole.log(JSON.stringify({ ok: report.ok, output, requests: totalRequests, phases: report.phases.length, maxConcurrentPeers: report.maxConcurrentPeers, maxConcurrentStreams: report.maxConcurrentStreams, failedChecks: report.checks.filter(item => !item.ok).length, fatal: report.fatal || null, elapsedMs: report.elapsedMs }));
    for (const name of Object.keys(originalConsole)) console[name] = originalConsole[name];
    if (!report.ok) process.exitCode = 1;
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
