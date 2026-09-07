'use strict';
// Explicit opt-in paid API acceptance. Synthetic documents only; the saved
// provider credential is read locally and never written into the evidence.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const args = process.argv.slice(2), option = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
if (!args.includes('--allow-paid-api')) throw Error('Explicit --allow-paid-api authorization is required');
const rounds = Number(option('--rounds', '60')), toolRounds = Number(option('--tool-rounds', '6'));
const chainLength = Number(option('--chain-length', '8')), prefillLines = Number(option('--prefill-lines', '300'));
const requestLimit = Number(option('--request-limit', '240'));
if (![rounds, toolRounds, chainLength, prefillLines, requestLimit].every(Number.isInteger)
  || rounds < 1 || rounds > 300 || toolRounds < 0 || toolRounds > 30 || chainLength < 2 || chainLength > 30
  || prefillLines < 0 || prefillLines > 800 || requestLimit < 1 || requestLimit > 1000) throw Error('Invalid bounded workload');
const output = path.resolve(option('--out', '../archive/user-soak-real-model.json'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-paid-soak-'));
const source = JSON.parse(fs.readFileSync(option('--config', path.join(os.homedir(), '.Newmark/config.json')), 'utf8'));
const unbox = x => x && typeof x === 'object' && 'value' in x ? x.value : x;
const provider = unbox(source.models?.providers)?.find(p => p.name?.toLowerCase() === 'apinebula');
const model = option('--model', 'gpt-5.6-sol');
if (!provider?.api_key || !provider.models?.some(m => m.name === model)) throw Error('Configured APInebula model/credential unavailable');
const secret = provider.api_key;
const redact = value => String(value).split(secret).join('<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
const rawLog = console.log.bind(console), rawError = console.error.bind(console), rawWarn = console.warn.bind(console);
for (const [k, logger] of [['log', rawLog], ['error', rawError], ['warn', rawWarn]]) console[k] = (...v) => logger(...v.map(x => typeof x === 'string' ? redact(x) : x));
const { Agent } = require('../dist/core/agent');
const { ConversationKernel } = require('../dist/core/conversationKernel');
const { normalizeConversationTarget } = require('../dist/core/conversationTarget');
const { LLMProvider } = require('../dist/llm/provider');
const modes = option('--modes', 'chat_stream,responses,chat').split(',');
if (modes.some(m => !['chat_stream', 'responses', 'chat'].includes(m))) throw Error('Unknown API mode');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
const runtimeIdentity = () => Object.fromEntries(['core/agent', 'core/agentKernelRunner', 'core/conversationKernel', 'core/subagent', 'core/autoRouter', 'llm/provider', 'providers/chat-completions.adapter', 'providers/responses.adapter', 'providers/provider-events'].map(name => [name, hash(fs.readFileSync(path.join(__dirname, '../dist', name + '.js')))]));
const loadedIdentity = runtimeIdentity();
const start = performance.now(), lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
const report = { startedAt: new Date().toISOString(), provider: provider.name, endpoint: provider.base_url, model,
  rounds, toolRounds, chainLength, prefillLines, requestLimit, root, requests: [], builds: [], samples: [], checks: [],
  boundary: 'Paid real APInebula model, production Agent/ConversationKernel/LLMProvider and isolated synthetic conversation/files. No generated fixture replies, provider substitution, production history, credentials in evidence, or days-of-use equivalence. Not a packaged GUI test.' };
let active, requests = 0, stopping = false;
const progressTimer = setInterval(() => {
  save(); rawLog(JSON.stringify({ progress: true, current: active?.id, mode: active?.mode,
    elapsedMs: performance.now() - start, currentMs: active ? performance.now() - active.began : null,
    requests, latestStatus: report.requests.at(-1)?.status }));
}, 30000);
progressTimer.unref();
const states = [], knownNonces = new Map();
function check(name, fn) { try { fn(); report.checks.push({ name, passed: true }); }
  catch (e) { report.checks.push({ name, passed: false, error: redact(e.message) }); } }
function save(final = false) {
  report.elapsedMs = performance.now() - start; report.finishedAt = final ? new Date().toISOString() : undefined;
  report.passed = final ? !report.fatal && report.checks.every(c => c.passed) && report.builds.length >= rounds + toolRounds : undefined;
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, redact(JSON.stringify(report, null, 2)) + '\n');
}
const fetchOriginal = LLMProvider.prototype.providerFetch;
LLMProvider.prototype.providerFetch = async function(input, init, streaming) {
  if (++requests > requestLimit) throw Error('Explicit paid-request safety limit reached');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  const messages = body.messages || body.input || [];
  const row = { index: requests, build: active?.id || 'auxiliary', mode: active?.mode, model: body.model,
    path: new URL(String(input)).pathname, bytes: Buffer.byteLength(init?.body || ''), messageCount: messages.length,
    requestHash: hash(body), systemHash: hash(body.instructions || messages.filter(m => m.role === 'system')),
    toolsHash: hash(body.tools || []), atMs: performance.now() - start };
  report.requests.push(row); save(); const began = performance.now();
  try { const response = await fetchOriginal.call(this, input, init, streaming);
    row.headerMs = performance.now() - began; row.status = response.status;
    row.requestId = response.headers.get('x-request-id') || response.headers.get('request-id'); save();
    return response;
  } catch (error) { row.error = redact(error.message); throw error; }
};
function setup(mode) {
  const dir = path.join(root, mode); fs.mkdirSync(dir); const work = path.join(dir, 'work'); fs.mkdirSync(work);
  const config = { models: { providers: [{ id: 'paid-soak', name: 'APInebula', base_url: provider.base_url, api_key: secret,
    protocol: 'openai', enabled: true, models: [{ name: model, max_tokens: 128000, enabled: true,
      capabilities: ['text_input', 'text_output', 'tool_use'], thinking: false }] }], default_model: model,
    openai_api_mode: mode, default_intelligence: 'low', auto_switch: false, fallback_on_unavailable: false, agent_engine: 'builtin' },
    context: { auto_compress: false }, workspace: { auto_create_timestamp_workspace: false, access_permission: 'full_access', on_permission_violation: 'deny' },
    network: { proxy_enabled: false }, agent: { default_mode: 'chat', option_feedback: 'fully_autonomous' } };
  // Isolated runtime config is transient and scrubbed in finally. Only the
  // selected provider is copied; user settings and conversation data stay out.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const host = new Agent(dir, { agentOnly: true, workspaceRegistryMode: 'detached' });
  const kernel = new ConversationKernel(dir, host, null);
  const target = normalizeConversationTarget({ workspaceId: 'paid-soak', conversationId: mode,
    workspace: { id: 'paid-soak', name: 'Synthetic real-model soak', path: work, kind: 'local', isInternal: false } });
  const anchor = crypto.randomBytes(6).toString('hex');
  const state = { mode, dir, work, config, host, kernel, target, anchor, count: 0, finals: [], userIds: [], unsubscribe: null };
  state.unsubscribe = kernel.subscribe(e => {
    const event = e.event || e;
    if (!active || active.mode !== mode) return;
    if (event.type === 'text' && !active.firstTextMs) active.firstTextMs = performance.now() - active.began;
    if (event.type === 'tool_call') active.tools.push({ name: event.toolName, id: event.toolCallId });
  });
  states.push(state); return state;
}
function document(state) {
  const lines = Array.from({ length: prefillLines }, (_, i) => `Record ${String(i).padStart(4, '0')}: laboratory batch Q${i % 17}; temperature ${20 + i % 30}; charge ${(i * 37) % 997}; status ${(i % 4) ? 'reviewed' : 'pending'}; supplier synthetic-${i % 11}. This is generated acceptance data without personal information. Preserve record identifiers and avoid inventing missing measurements.`);
  return `Long-term reference: the immutable memory_anchor for this conversation is ${state.anchor}.\n<synthetic_reference>\n${lines.join('\n')}\n</synthetic_reference>\n`;
}
async function execute(state, id, prompt, { tool = false, expected = [], cancel = false } = {}) {
  const { kernel, target } = state;
  const row = { id, mode: state.mode, kind: tool ? 'tool-chain' : cancel ? 'intentional-stop' : 'conversation', began: performance.now(),
    startedAt: new Date().toISOString(), tools: [], expected, requestStart: requests, historyBefore: kernel.conversationOwner(target)?.history.length || 0 };
  report.builds.push(row); active = row;
  kernel.setMode(target, tool ? 'build' : 'chat');
  const watchdog = setTimeout(() => { row.watchdog = true; kernel.requestStop(target); }, 360000);
  const cancelTimer = cancel ? setTimeout(() => { row.stopAtMs = performance.now() - row.began; kernel.requestStop(target); }, 1200) : null;
  try {
    await kernel.prompt({ text: prompt, userMessageId: id, clientMessageId: id }, target,
      { mode: tool ? 'build' : 'chat', model, intelligence: 'low', inputMode: 'next', engine: 'builtin' }, 'followUp');
  } catch (error) { row.error = redact(error.message); }
  finally { clearTimeout(watchdog); clearTimeout(cancelTimer); }
  const owner = kernel.conversationOwner(target);
  if (!owner) throw Error('No runtime owner after prompt: ' + (row.error || 'unknown'));
  owner.flushWorkspaceConversationState();
  const runs = owner.workRuns.slice(), run = runs.at(-1);
  row.runId = run?.runId; row.status = run?.status; row.elapsedMs = performance.now() - row.began;
  row.requests = requests - row.requestStart; row.historyAfter = owner.history.length;
  row.usage = JSON.parse(JSON.stringify(owner.conversationProviderUsage()));
  row.context = owner.contextWindow();
  row.reply = (run?.events || []).filter(e => e.type === 'final_response' || e.type === 'response').map(e => e.content).join('\n');
  if (!row.reply) row.reply = owner.chatMessages.filter(m => m.role === 'assistant').at(-1)?.content || '';
  row.tools = (run?.events || []).filter(e => e.type === 'tool_call').map(e => ({ name: e.toolName, id: e.toolCallId }));
  check(id + ': returns idle without watchdog', () => { assert.ok(!row.watchdog); assert.equal(kernel.isRunning(target), false); assert.equal(owner.activeProcessSignal(), undefined); });
  check(id + ': input persists exactly once', () => assert.equal(owner.history.filter(m => m.user_message_id === id).length, 1));
  if (!cancel) {
    check(id + ': real reply completes', () => { assert.ok(!row.error, row.error); assert.equal(row.status, 'completed'); assert.ok(row.reply.trim()); });
    for (const marker of expected) check(id + ': response contains ' + marker, () => assert.ok(row.reply.includes(marker), row.reply.slice(0, 600)));
    if (tool) check(id + ': executes sequential real file tools', () => {
      assert.ok(row.tools.filter(t => /^(?:read|read_file)$/.test(t.name)).length >= chainLength, JSON.stringify(row.tools));
      assert.ok(row.requests >= chainLength + 1, 'A dependent file chain must span multiple real model requests');
      const ids = row.tools.map(t => t.id).filter(Boolean); assert.equal(new Set(ids).size, ids.length);
    });
    state.finals.push(row.reply);
  } else check(id + ': explicit stop does not claim success', () => assert.notEqual(row.status, 'completed'));
  state.userIds.push(id);
  report.samples.push({ build: id, ...process.memoryUsage(), historyCount: owner.history.length, requests,
    p99EventLoopMs: lag.percentile(99) / 1e6, maxEventLoopMs: lag.max / 1e6 });
  row.failedChecks = report.checks.filter(c => c.name.startsWith(id + ':') && !c.passed).length;
  delete row.began; save(); rawLog(JSON.stringify({ build: id, mode: state.mode, status: row.status, requests: row.requests,
    totalRequests: requests, elapsedMs: row.elapsedMs, failedChecks: row.failedChecks, input: row.usage.totals.input, cached: row.usage.totals.cacheRead }));
  active = null; return row;
}
async function coldCheck(state) {
  const owner = state.kernel.conversationOwner(state.target); if (!owner) return;
  owner.flushWorkspaceConversationState(); const before = { history: hash(owner.history), usage: owner.conversationProviderUsage() };
  const reloaded = new Agent(state.dir, { agentOnly: true, workspaceRegistryMode: 'detached' });
  reloaded.workspace.current = { ...state.target.workspace }; reloaded.setConversation(state.target.conversationId);
  check(state.mode + ': cold history exact identity', () => assert.equal(hash(reloaded.history), before.history));
  check(state.mode + ': cold usage exact identity', () => assert.deepEqual(reloaded.conversationProviderUsage(), before.usage));
  reloaded.releaseConversationRuntimeBindings?.();
}
async function queueCheck(state) {
  const { kernel, target } = state, prefix = 'queue-' + state.mode;
  kernel.queueAction(target, 'set_pause', { paused: true });
  const primary = execute(state, prefix + '-primary', 'Without tools, give a short summary of our synthetic reference and repeat memory_anchor.', { expected: [state.anchor] });
  const q1 = crypto.randomBytes(5).toString('hex'), q2 = crypto.randomBytes(5).toString('hex');
  const message = nonce => `No tools. Respond with only our memory_anchor and nonce ${nonce}.`;
  kernel.queueAction(target, 'enqueue', { id: prefix + '-one', text: 'This queued text will be edited before sending.', requestedMode: 'chat' });
  kernel.queueAction(target, 'enqueue', { id: prefix + '-two', text: message(q2), requestedMode: 'build' });
  kernel.queueAction(target, 'enqueue', { id: prefix + '-delete', text: 'This entry must never execute.', requestedMode: 'chat' });
  kernel.queueAction(target, 'update', { id: prefix + '-one', text: message(q1), requestedMode: 'chat' });
  kernel.queueAction(target, 'delete', { id: prefix + '-delete' });
  kernel.queueAction(target, 'reorder', { orderedIds: [prefix + '-two', prefix + '-one'] });
  check(prefix + ': real pending queue identities/modes', () => assert.deepEqual(kernel.queueItems(target).map(q => [q.id, q.requestedMode]), [[prefix + '-two', 'build'], [prefix + '-one', 'chat']]));
  await primary;
  check(prefix + ': paused queue survives primary reply', () => assert.equal(kernel.queueItems(target).length, 2));
  const historyStart = kernel.conversationOwner(target).history.length;
  const row = { id: prefix + '-drain', mode: state.mode, kind: 'real-next-queue', began: performance.now(), tools: [], requestStart: requests };
  report.builds.push(row); active = row;
  kernel.queueAction(target, 'set_pause', { paused: false });
  while (kernel.isRunning(target) || kernel.queueItems(target).length) {
    if (performance.now() - row.began > 480000) { kernel.requestStop(target); throw Error('Real queue exceeded explicit 8-minute test bound'); }
    await pause(50);
  }
  const owner = kernel.conversationOwner(target); owner.flushWorkspaceConversationState();
  row.elapsedMs = performance.now() - row.began; row.requests = requests - row.requestStart;
  row.usage = owner.conversationProviderUsage();
  const messages = owner.chatMessages.filter(m => m.role === 'user' && [message(q1), message(q2)].includes(m.content));
  check(prefix + ': real queue order/mode/display', () => assert.deepEqual(messages.map(m => [m.content, m.mode?.toLowerCase()]), [[message(q2), 'build'], [message(q1), 'chat']]));
  check(prefix + ': accepted queue IDs persist once', () => {
    for (const suffix of ['two', 'one']) assert.equal(owner.history.filter(m => m.user_message_id === prefix + '-' + suffix).length, 1);
    assert.equal(owner.history.filter(m => m.user_message_id === prefix + '-delete').length, 0);
  });
  // Chat queue responses have their ordinary history boundary; selecting the
  // last two Build blocks incorrectly reads an older, unrelated Build.
  row.reply = owner.history.slice(historyStart).filter(m => m.role === 'assistant').map(m => typeof m.content === 'string'
    ? m.content : (m.content || []).filter(part => part.type === 'text').map(part => part.text).join('')).join('\n');
  for (const nonce of [q1, q2]) check(prefix + ': queued real response ' + nonce, () => assert.ok(row.reply.includes(nonce)));
  delete row.began; active = null; save();
}
process.on('SIGINT', () => { stopping = true; for (const s of states) s.kernel.requestStop(s.target); });
(async () => {
  try {
    modes.forEach(setup);
    for (let i = 0; i < rounds && !stopping; i++) {
      const state = states[i % states.length], id = `real-${String(i).padStart(3, '0')}`;
      const nonce = crypto.randomBytes(7).toString('hex');
      const previous = knownNonces.get(state.mode);
      const prompt = (state.count === 0 ? document(state) : '') + `Acceptance turn ${state.count}. Do not call tools for this message. Reply in JSON with memory_anchor copied from the initial reference, current_nonce="${nonce}", previous_nonce=${previous ? 'the current_nonce from your preceding answer' : 'null'}, and a concise one-sentence summary of reference records. Do not reprint the document. Keep the answer below 180 words.`;
      await execute(state, id, prompt, { expected: [state.anchor, nonce, ...(previous ? [previous] : [])] });
      knownNonces.set(state.mode, nonce); state.count++;
      if (report.builds.slice(-3).length === 3 && report.builds.slice(-3).every(b => b.error || b.watchdog)) throw Error('Three consecutive real-provider failures; retained receipts before further paid traffic');
      if (i > 0 && (i + 1) % 15 === 0) for (const s of states) await coldCheck(s);
    }
    for (let i = 0; i < toolRounds && !stopping; i++) {
      const state = states[i % states.length], id = `tool-${String(i).padStart(3, '0')}`;
      const values = Array.from({ length: chainLength }, () => crypto.randomBytes(5).toString('hex'));
      const names = Array.from({ length: chainLength }, () => crypto.randomBytes(8).toString('hex') + '.txt');
      for (let j = 0; j < chainLength; j++) fs.writeFileSync(path.join(state.work, names[j]), `Step ${j + 1} of ${chainLength}. Receipt=${values[j]}.\n${j + 1 < chainLength ? 'Next file: ' + names[j + 1] : 'END OF CHAIN'}\n`);
      const prompt = `Run a real sequential file-reading acceptance task in the current isolated workspace. Start by reading ${names[0]} using the available single-file read tool (normally named read; provision it if needed). Each file names the next unknown file. Read all ${chainLength} files individually in order; use single-file reads, no shell, no directory listing or broad wildcard. After reaching END OF CHAIN, answer with the exact ordered Receipt values from every file and memory_anchor from our original reference. Do not change files. Do not stop before the end; this is one continuous Build.`;
      await execute(state, id, prompt, { tool: true, expected: [state.anchor, ...values] });
    }
    if (args.includes('--exercise-queue-stop') && !stopping) for (const state of states) {
      await queueCheck(state);
      await execute(state, 'stop-' + state.mode, 'Write a detailed long analysis of the reference records in numbered paragraphs. Aim for 2000 words.', { cancel: true });
      const nonce = crypto.randomBytes(5).toString('hex');
      await execute(state, 'resume-' + state.mode, `Continue after my explicit stop. No tools. Reply with only memory_anchor and nonce ${nonce}.`, { expected: [state.anchor, nonce] });
    }
    for (const state of states) await coldCheck(state);
  } catch (error) { report.fatal = redact(error.stack || error); rawError(report.fatal); }
  finally {
    for (const state of states) {
      state.kernel.requestStop(state.target); await state.kernel.prepareForArchive(state.target).catch(() => {});
      state.kernel.finishArchive(state.target, true); state.unsubscribe?.(); state.host.flushWorkspaceConversationState();
      // Scrub all test config snapshots, including any ConfigManager backups.
      const scrub = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = path.join(dir, entry.name); if (entry.isDirectory()) scrub(name);
        else if (/\.(?:json|jsonl|log|txt|md)$/i.test(entry.name)) { const text = fs.readFileSync(name, 'utf8'); if (text.includes(secret)) fs.writeFileSync(name, text.split(secret).join('<redacted>')); }
      } }; scrub(state.dir);
    }
    LLMProvider.prototype.providerFetch = fetchOriginal; clearInterval(progressTimer); lag.disable();
    report.identity = loadedIdentity;
    report.distChangedWhileRunning = JSON.stringify(loadedIdentity) !== JSON.stringify(runtimeIdentity());
    report.requestCount = requests; report.cancelledByOperator = stopping; save(true);
    rawLog(JSON.stringify({ passed: report.passed, builds: report.builds.length, requests, elapsedMs: report.elapsedMs, output }));
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => { rawError(redact(error.stack || error)); process.exitCode = 1; });
