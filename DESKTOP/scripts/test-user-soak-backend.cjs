'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const iterations = Math.max(1, Math.min(500, Number(option('--iterations', '100'))));
const runStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
const output = path.resolve(option('--output', '../archive/' + runStamp + '-user-soak-backend/soak.json'));
const sourceKernel = option('--kernel-source', '');
const loadedIdentity = {}, digest = content => crypto.createHash('sha256').update(content).digest('hex');
{
  const Module = require('node:module'), native = Module._extensions['.js'], distRoot = path.resolve(__dirname, '../dist') + path.sep;
  const sourceFiles = new Map(option('--lifecycle-source', 'false') === 'true'
    ? ['agent', 'subagent', 'conversationKernel'].map(name => [path.resolve(__dirname, '../dist/core/' + name + '.js'), path.resolve(__dirname, '../src/core/' + name + '.ts')]) : []);
  const ts = sourceFiles.size ? require('typescript') : null;
  Module._extensions['.js'] = (loaded, filename) => {
    if (!filename.startsWith(distRoot)) return native(loaded, filename);
    const sourcePath = sourceFiles.get(filename) || filename, source = fs.readFileSync(sourcePath, 'utf8');
    const code = sourceFiles.has(filename) ? ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText : source;
    loadedIdentity[path.relative(distRoot, filename)] = { sourcePath, sourceSha256: digest(source), executedJavaScriptSha256: digest(code) };
    return loaded._compile(code, filename);
  };
}
if (sourceKernel) {
  const Module = require('node:module'), ts = require('typescript');
  const filename = path.resolve(__dirname, '../dist/core/conversationKernel.js');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(ts.transpileModule(fs.readFileSync(path.resolve(sourceKernel), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename); require.cache[filename] = loaded;
}
const { Agent } = require('../dist/core/agent');
const { ConversationKernel } = require('../dist/core/conversationKernel');
const { ElectronUtilityRuntimePool } = require('../dist/core/electronUtilityRuntimePool');
const { normalizeConversationTarget } = require('../dist/core/conversationTarget');
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-user-soak-'));
const report = { at: new Date().toISOString(), iterations, root, checks: [], samples: [], cycles: [], requests: [], restarts: [],
  boundary: 'Real Agent, ConversationKernel, runtime-pool supervisor and LLMProvider with loopback HTTP. Pool client transport calls the real in-process Kernel; no Electron utility-process, physical mobile, upstream API, forced provider, paid API or simulated-duration claim.' };
const check = (name, fn) => { try { fn(); report.checks.push({ name, passed: true }); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack || String(error) }); console.error('FAIL ' + name + ': ' + error.message); } };
const waitFor = async (fn, name, timeout = 12000) => { const start = performance.now();
  while (!fn()) { if (performance.now() - start > timeout) throw Error('Timed out: ' + name); await delay(10); } };
const encoder = payload => 'data: ' + JSON.stringify(payload) + '\n\n';
const expectedUsage = new Map(), accepted = new Map(), expectedUsers = new Map(), expectedFinals = new Map();
const requestCounts = new Map(), targets = [], sockets = new Set(), owners = new Map(), observerDisposers = new Map();
const held = new Map(), phases = new Map(), weakOwners = [], warnings = [], toolCalls = new Map();
let host, kernel, pool, activeCycle, unsubscribePool, ownerCreations = 0;
const loopLag = monitorEventLoopDelay({ resolution: 10 }); loopLag.enable();
const startAt = performance.now();
process.on('warning', warning => warnings.push({ name: warning.name, message: warning.message }));
const usageFor = targetId => {
  const number = (requestCounts.get(targetId) || 0) + 1; requestCounts.set(targetId, number);
  const input = 100 + number, output = 10, cached = number % 3 === 0 ? undefined : number % 2 ? 0 : 50;
  const total = expectedUsage.get(targetId) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  total.input += input; total.output += output; total.cacheRead += cached || 0; expectedUsage.set(targetId, total);
  return { prompt_tokens: input, completion_tokens: output, ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) };
};
function finish(res, targetId, text, call) {
  const usage = usageFor(targetId);
  res.setHeader('content-type', 'application/json');
  const message = call ? { role: 'assistant', tool_calls: [{ id: call, type: 'function', function: { name: 'pwd', arguments: '{}' } }] }
    : { role: 'assistant', content: text };
  res.end(JSON.stringify({ choices: [{ message, finish_reason: call ? 'tool_calls' : 'stop' }], usage }));
  if (text && !text.startsWith('Soak title')) { const list = expectedFinals.get(targetId) || []; list.push(text); expectedFinals.set(targetId, list); }
}
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages || [];
    const userText = messages.filter(message => message.role === 'user').map(message => String(message.content)).join('\n');
    const tags = [...userText.matchAll(/SOAK:(t\d+):(c\d+):(main|q1|q2|guide)/g)];
    const tag = tags.at(-1), targetId = tag?.[1] || activeCycle?.targetId;
    if (!targetId) throw Error('Provider request has no test target');
    const title = messages.some(message => message.role === 'system' && String(message.content).includes('You are a conversation title generator.'));
    const marker = tag ? tag[0] : 'title';
    report.requests.push({ targetId, marker, title, model: body.model, stream: body.stream === true,
      messageCount: messages.length, bytes: Buffer.byteLength(raw), atMs: performance.now() - startAt });
    if (title) { finish(res, targetId, 'Soak title ' + targetId); return; }
    if (!tag) throw Error('Formal provider request has no marker');
    const cycleId = tag[2], kind = tag[3], cycle = report.cycles.find(item => item.id === cycleId);
    if (!cycle) throw Error('Unknown cycle ' + cycleId);
    const phaseKey = marker, phase = phases.get(phaseKey) || 0; phases.set(phaseKey, phase + 1);
    if (phase > 7) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'Soak request bound exceeded' } })); return; }
    const reply = () => {
      if (res.destroyed) return;
      if (kind === 'main' && phase === 0) {
        if (cycle.kind === 'transient') { res.statusCode = 503; res.setHeader('Retry-After-Ms', '20'); res.end(JSON.stringify({ error: { message: 'temporary fixture failure' } })); return; }
        if (cycle.kind === 'empty') { finish(res, targetId, ''); return; }
        if (cycle.kind === 'auth') { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'fixture authentication failure' } })); return; }
        if (cycle.kind === 'tool') { finish(res, targetId, '', 'soak-pwd-' + cycleId); return; }
        if (cycle.kind === 'truncated' || cycle.kind === 'cancel') {
          res.setHeader('content-type', 'text/event-stream');
          res.write(encoder({ choices: [{ delta: { content: 'PARTIAL:' + marker }, finish_reason: null }], usage: usageFor(targetId) }));
          cycle.cancelReady = cycle.kind === 'cancel';
          if (cycle.kind === 'truncated') res.end();
          return;
        }
      }
      finish(res, targetId, 'DONE:' + marker);
    };
    if (kind === 'main' && phase === 0) { held.set(cycleId, reply); return; }
    reply();
  } catch (error) {
    report.checks.push({ name: 'HTTP fixture', passed: false, error: error.stack || String(error) });
    if (!res.headersSent) res.statusCode = 500; res.end('fixture failure');
  }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const options = { mode: 'build', model: 'soak-model', intelligence: 'medium', inputMode: 'next', engine: 'builtin' };
function createStack() {
  host = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached' });
  kernel = new ConversationKernel(root, host, null, { createRunner: target => {
    const owner = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached' }); ownerCreations++;
    owners.set(target.runtimeKey, owner); weakOwners.push(new WeakRef(owner));
    observerDisposers.set(target.runtimeKey, owner.subscribeAgentKernelUserMessageStart((content, id) => {
      // Ordinary dequeued input retains user_message_id in persisted history;
      // the callback's optional clientMessageId is reserved for Guide identity.
      const persistedId = owner.history.findLast(message => message.role === 'user' && message.content === content)?.user_message_id;
      const rows = accepted.get(target.conversationId) || []; rows.push({ content, id: id || persistedId, mode: owner.mode }); accepted.set(target.conversationId, rows);
    }));
    return owner;
  } });
  pool = new ElectronUtilityRuntimePool(root, 'in-process-soak-transport', target => {
    let connected = true;
    const ensure = () => { if (!kernel.conversationOwner(target)) kernel.queueAction(target, 'set_pause', { paused: true }); };
    const release = async () => { const owner = kernel.conversationOwner(target); await kernel.prepareForArchive(target); kernel.finishArchive(target, true);
      observerDisposers.get(target.runtimeKey)?.(); observerDisposers.delete(target.runtimeKey); owners.delete(target.runtimeKey);
      connected = false;
      if (owner) check('released owner has no kernel subscribers: ' + target.conversationId, () => {
        assert.equal(owner.workEventSubscribers.length, 0); assert.equal(owner.peerWorkEventSubscribers.length, 0); assert.equal(owner.agentKernelUserMessageStartSubscribers.length, 0);
      }); };
    return { subscribe: listener => kernel.subscribe(event => { if (event.runtimeKey === target.runtimeKey) listener(event); }),
      setHostToolHandler() {}, status: () => ({ enabled: true, connected, pid: connected ? process.pid : 0, error: '', runtimeKey: target.runtimeKey }),
      prompt: request => kernel.prompt(request.message, target, request.options, request.queueMode),
      snapshot: window => { ensure(); return Promise.resolve(kernel.snapshot(target, window)); },
      queueAction: (action, input) => Promise.resolve(kernel.queueAction(target, action, input)),
      enqueueGuide: envelope => Promise.resolve(kernel.enqueueGuide(envelope)),
      requestStop: runId => Promise.resolve(kernel.requestStop(target, runId)),
      checkpoint: () => Promise.resolve(kernel.checkpoint(target)),
      setMode: mode => Promise.resolve(kernel.setMode(target, mode)), setInputMode: mode => Promise.resolve(kernel.setInputMode(target, mode)),
      stop: release, forceStop: release, forceRestart: release,
    };
  }, { maxResidentRuntimes: 4, idleTtlMs: 60000 });
  unsubscribePool = pool.subscribe(event => {
    if (event.type === 'tool_call' && event.toolName === 'pwd') toolCalls.set(event.toolCallId, (toolCalls.get(event.toolCallId) || 0) + 1);
    if (activeCycle?.kind === 'cancel' && event.type === 'text' && String(event.content).includes('PARTIAL:') && !activeCycle.cancelAt) {
      activeCycle.cancelAt = performance.now(); queueMicrotask(() => pool.requestStop(activeCycle.target).catch(error => { report.checks.push({ name: 'cancel request', passed: false, error: String(error) }); }));
    }
  });
}
function sample(label) {
  global.gc?.();
  const resources = {}; for (const type of process.getActiveResourcesInfo()) resources[type] = (resources[type] || 0) + 1;
  const currentOwners = [...owners.values()];
  report.samples.push({ label, elapsedMs: performance.now() - startAt, ...process.memoryUsage(),
    lagMeanMs: Number.isFinite(loopLag.mean) ? loopLag.mean / 1e6 : 0, lagMaxMs: loopLag.max / 1e6,
    resources, sockets: sockets.size, poolEntries: pool.entries.size, runtimeEntries: kernel.runtimes.size,
    kernelListeners: kernel.listeners.size, poolListeners: pool.listeners.size,
    ownerCreations, liveWeakOwners: weakOwners.filter(ref => ref.deref()).length,
    ownerSubscribers: currentOwners.map(owner => ({ work: owner.workEventSubscribers.length, peer: owner.peerWorkEventSubscribers.length,
      userStart: owner.agentKernelUserMessageStartSubscribers.length, activeSignal: !!owner.activeProcessSignal() })),
    retainedRuntimeEvents: [...kernel.runtimes.values()].map(runtime => runtime.events.length),
  }); loopLag.reset();
  if (process.memoryUsage().rss > 1100 * 1024 * 1024) throw Error('Owned process RSS exceeded 1100 MiB safeguard');
}
function transcript(target) {
  const owner = kernel.conversationOwner(target); if (!owner) throw Error('Missing owner for transcript');
  return { history: clone(owner.history), chat: clone(owner.chatMessages), usage: clone(owner.conversationProviderUsage()),
    workRuns: clone(owner.workRuns), mode: owner.mode, queue: clone(kernel.queueItems(target)) };
}
function verifyTarget(target, label) {
  const owner = kernel.conversationOwner(target), state = transcript(target);
  check(label + ': exact real provider usage ownership ' + target.conversationId, () => assert.deepEqual(state.usage.totals, expectedUsage.get(target.conversationId)));
  for (const { text, mode } of expectedUsers.get(target.conversationId) || []) check(label + ': user persists once ' + text, () => {
    const matches = state.chat.filter(message => message.role === 'user' && message.content === text);
    assert.equal(matches.length, 1); if (matches[0]?.mode) assert.equal(matches[0].mode.toLowerCase(), mode);
  });
  const savedText = [...state.chat.map(message => message.content), ...state.workRuns.flatMap(run => (run.events || []).filter(event => event.type === 'response' || event.type === 'final_response').map(event => event.content))];
  for (const text of expectedFinals.get(target.conversationId) || []) check(label + ': assistant persists ' + text, () => assert.ok(savedText.includes(text)));
  check(label + ': settled resources ' + target.conversationId, () => { assert.equal(owner.activeProcessSignal(), undefined); assert.ok(!kernel.isRunning(target)); assert.equal(state.queue.length, 0); });
  return state;
}
async function coldRestart(label) {
  const saved = new Map(), parked = new Map();
  for (const target of targets) if (kernel.conversationOwner(target)) saved.set(target.runtimeKey, verifyTarget(target, label));
  for (const target of targets) if (saved.has(target.runtimeKey)) {
    await pool.queueAction(target, 'set_pause', { paused: true });
    for (const [suffix, mode] of [['one', 'build'], ['two', 'chat']]) await pool.queueAction(target, 'enqueue', {
      id: `${label}-${target.conversationId}-${suffix}`, text: `PARKED:${label}:${target.conversationId}:${suffix}`, requestedMode: mode,
      createdAt: '2026-09-06T00:00:00.000Z',
    });
    await pool.queueAction(target, 'reorder', { orderedIds: [`${label}-${target.conversationId}-two`, `${label}-${target.conversationId}-one`] });
    parked.set(target.runtimeKey, clone(kernel.queueItems(target)));
  }
  await pool.stopAll(); unsubscribePool(); host.flushWorkspaceConversationState(); host.releaseConversationRuntimeBindings?.();
  check(label + ': all runtime entries and listeners released', () => { assert.equal(pool.entries.size, 0); assert.equal(kernel.runtimes.size, 0); assert.equal(kernel.listeners.size, 0); });
  createStack();
  for (const target of targets) if (saved.has(target.runtimeKey)) {
    await pool.snapshot(target); const after = transcript(target), before = saved.get(target.runtimeKey);
    check(label + ': cold history/chat/usage survives ' + target.conversationId, () => {
      assert.deepEqual(after.history, before.history);
      // Cold hydration assigns deterministic IDs to assistant rows that did
      // not yet have one. Existing user/assistant IDs must never change.
      const semantic = rows => rows.map(({ messageId, branchNodeId, ...row }) => row);
      assert.deepEqual(semantic(after.chat), semantic(before.chat));
      for (let index = 0; index < before.chat.length; index++) if (before.chat[index].messageId) assert.equal(after.chat[index].messageId, before.chat[index].messageId);
      assert.deepEqual(after.usage, before.usage);
    });
    check(label + ': paused queue retains exact IDs/order/mode/time after reload ' + target.conversationId, () => {
      assert.deepEqual(after.queue, parked.get(target.runtimeKey)); assert.equal(kernel.snapshot(target).queuePaused, true);
    });
    for (const item of after.queue) await pool.queueAction(target, 'delete', { id: item.id });
    await pool.queueAction(target, 'set_pause', { paused: false });
  }
  report.restarts.push({ label, elapsedMs: performance.now() - startAt, targets: saved.size }); sample(label);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(root, 'work'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: { providers: [{ id: 'soak', name: 'Soak local HTTP',
    protocol: 'openai', base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: '', enabled: true,
    models: [{ name: 'soak-model', max_tokens: 128000, enabled: true, capabilities: ['text_input', 'text_output', 'tool_use'] }] }],
    default_model: 'soak-model', auto_switch: false, fallback_on_unavailable: false }, context: { auto_compress: false },
    workspace: { auto_create_timestamp_workspace: false }, network: { proxy_enabled: false } }));
  for (let i = 0; i < 4; i++) targets.push(normalizeConversationTarget({ workspaceId: 'soak-work', conversationId: 't' + i,
    workspace: { id: 'soak-work', name: 'Isolated soak', path: path.join(root, 'work'), kind: 'local', isInternal: false } }));
  createStack(); sample('initial');
  try {
    for (let i = 0; i < iterations; i++) {
      const target = targets[i % targets.length], id = 'c' + String(i).padStart(3, '0');
      const kind = ['plain', 'tool', 'transient', 'empty', 'truncated', 'cancel', 'auth', 'plain'][i % 8];
      activeCycle = { id, target, targetId: target.conversationId, kind, startMs: performance.now() - startAt }; report.cycles.push(activeCycle);
      const tag = suffix => `SOAK:${target.conversationId}:${id}:${suffix}`;
      const main = tag('main'), q1 = tag('q1') + ':UPDATED', q2 = tag('q2');
      const beforeAccepted = (accepted.get(target.conversationId) || []).length;
      // A user mode change is its own shared conversation command. Prompt
      // options must not overwrite a target's previously restored selection.
      await pool.snapshot(target); await pool.setMode(target, 'build');
      const watchdog = setTimeout(() => { activeCycle.watchdog = true; kernel.requestStop(target); }, 15000);
      const work = pool.prompt({ target, message: { text: main, clientMessageId: id + '-main', userMessageId: id + '-main' }, options, queueMode: 'followUp' })
        .finally(() => clearTimeout(watchdog))
        .then(value => ({ value }), error => ({ error: String(error.message || error) }));
      await waitFor(() => held.has(id), 'main HTTP request ' + id);
      await pool.queueAction(target, 'set_pause', { paused: true });
      for (const [suffix, mode] of [['q1', 'chat'], ['q2', 'build'], ['delete', 'plan']])
        await pool.queueAction(target, 'enqueue', { id: id + '-' + suffix, text: tag(suffix), requestedMode: mode, createdAt: new Date().toISOString() });
      await pool.queueAction(target, 'update', { id: id + '-q1', text: q1, requestedMode: 'chat' });
      await pool.queueAction(target, 'delete', { id: id + '-delete' });
      await pool.queueAction(target, 'reorder', { orderedIds: [id + '-q2', id + '-q1'] });
      const queued = (await pool.snapshot(target)).queueItems;
      check(id + ': queue ID/order/mode before acceptance', () => assert.deepEqual(queued.map(item => [item.id, item.text, item.requestedMode]), [[id + '-q2', q2, 'build'], [id + '-q1', q1, 'chat']]));
      if (kind === 'tool') {
        const envelope = { clientMessageId: id + '-guide', guideId: id + '-guide', target, runId: kernel.runtimeState(target).runId,
          deliveryMode: 'steer', text: tag('guide'), createdAt: new Date().toISOString() };
        const receipt = await pool.enqueueGuide(envelope), duplicate = await pool.enqueueGuide(envelope);
        check(id + ': Guide accepted once by stable ID', () => { assert.notEqual(receipt.status, 'rejected'); assert.equal(duplicate.clientMessageId, receipt.clientMessageId); });
      }
      held.get(id)(); held.delete(id);
      if (kind === 'cancel') {
        await waitFor(() => activeCycle.cancelReady, 'cancel request read stage ' + id);
        await delay(20);
        if (!activeCycle.cancelAt) { activeCycle.cancelAt = performance.now(); activeCycle.stopResult = await pool.requestStop(target); }
      }
      const result = await work; activeCycle.mainError = result.error;
      await waitFor(() => !kernel.isRunning(target), 'main settlement ' + id);
      check(id + ': queue remains paused through main settlement', () => { assert.equal(kernel.snapshot(target).queuePaused, true); assert.equal(kernel.queueItems(target).length, 2); });
      if (kind === 'cancel') activeCycle.cancelLatencyMs = activeCycle.cancelAt ? performance.now() - activeCycle.cancelAt : null;
      check(id + ': test watchdog was not needed', () => assert.ok(!activeCycle.watchdog));
      if (kind === 'truncated' || kind === 'auth') check(id + ': explicit failure settles', () => assert.ok(result.error));
      else check(id + ': main completes or cooperatively cancels', () => assert.equal(result.error, undefined));
      await pool.queueAction(target, 'set_pause', { paused: false });
      await waitFor(() => kernel.queueItems(target).length === 0 && !kernel.isRunning(target), 'queue drain ' + id);
      await delay(5);
      const rows = (accepted.get(target.conversationId) || []).slice(beforeAccepted);
      activeCycle.accepted = clone(rows);
      check(id + ': exact accepted queue IDs/order/mode', () => assert.deepEqual(rows.filter(row => row.id === id + '-q1' || row.id === id + '-q2').map(row => [row.id, row.mode]), [[id + '-q2', 'build'], [id + '-q1', 'chat']]));
      check(id + ': deleted queue input is never accepted', () => assert.ok(!rows.some(row => row.content.includes(tag('delete')))));
      if (kind === 'tool') check(id + ': pwd executes exactly once', () => assert.equal(toolCalls.get('soak-pwd-' + id), 1));
      const expected = expectedUsers.get(target.conversationId) || [];
      expected.push({ text: main, mode: 'build' }, { text: q2, mode: 'build' }, { text: q1, mode: 'chat' });
      if (kind === 'tool') expected.push({ text: tag('guide'), mode: 'guide' }); expectedUsers.set(target.conversationId, expected);
      const owner = kernel.conversationOwner(target); owner.flushWorkspaceConversationState();
      check(id + ': usage remains with source target', () => assert.deepEqual(owner.conversationProviderUsage().totals, expectedUsage.get(target.conversationId)));
      for (let refresh = 0; refresh < 4; refresh++) await pool.snapshot(target, refresh % 2 ? { window: 17, before: 10 } : undefined);
      activeCycle.elapsedMs = performance.now() - startAt - activeCycle.startMs;
      if ((i + 1) % 5 === 0) {
        sample('cycle-' + (i + 1));
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output + '.progress.json', JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ cycles: i + 1, requests: report.requests.length, failedChecks: report.checks.filter(item => !item.passed).length,
          rssMiB: Math.round(process.memoryUsage().rss / 1048576), heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576), liveOwners: report.samples.at(-1).liveWeakOwners }));
      }
      if ((i + 1) % 10 === 0) await coldRestart('cold-' + (i + 1));
      if (report.checks.some(item => !item.passed) && option('--keep-going', 'false') !== 'true') throw Error('Calibration failure retained; stopping before additional load');
    }
    await coldRestart('final-cold');
    for (const target of targets) if (kernel.conversationOwner(target)) verifyTarget(target, 'final');
    check('at most four resident runtime owners', () => { assert.ok(report.samples.every(item => item.poolEntries <= 4 && item.runtimeEntries <= 4)); });
    check('runtime work event buffers stay capped at 500', () => assert.ok(report.samples.every(item => item.retainedRuntimeEvents.every(count => count <= 500))));
    check('no listener leak warning', () => assert.ok(!warnings.some(warning => warning.name === 'MaxListenersExceededWarning')));
  } catch (error) { report.failure = error.stack || String(error); console.error(report.failure); }
  finally {
    for (const target of targets) if (kernel.isRunning(target)) kernel.requestStop(target);
    await pool.stopAll().catch(error => { report.cleanupError = String(error); }); unsubscribePool?.(); host.flushWorkspaceConversationState(); host.releaseConversationRuntimeBindings?.();
    sample('after-stop'); loopLag.disable();
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    const idleSeconds = Math.max(0, Math.min(300, Number(option('--idle-seconds', '60'))));
    for (let seconds = 0; seconds < idleSeconds; seconds += 5) {
      await delay(Math.min(5, idleSeconds - seconds) * 1000); sample('released-idle-' + Math.min(seconds + 5, idleSeconds));
    }
    if (idleSeconds > 0 && global.gc) check('released owners are reclaimed after an idle GC turn', () => assert.equal(report.samples.at(-1).liveWeakOwners, 0));
    report.elapsedMs = performance.now() - startAt; report.warnings = warnings;
    report.passed = !report.failure && !report.cleanupError && report.checks.every(item => item.passed);
    report.passedChecks = report.checks.filter(item => item.passed).length; report.failedChecks = report.checks.filter(item => !item.passed).length;
    report.identity = loadedIdentity;
    report.changedFilesAfterLoading = Object.entries(loadedIdentity).filter(([, value]) => !fs.existsSync(value.sourcePath) || digest(fs.readFileSync(value.sourcePath, 'utf8')) !== value.sourceSha256).map(([name]) => name);
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, cycles: report.cycles.length, requests: report.requests.length,
      elapsedMs: report.elapsedMs, passedChecks: report.passedChecks, failedChecks: report.failedChecks, output }));
    // Keep isolated durable data with a failed calibration; successful runs can
    // opt into removal, after an absolute temporary-directory boundary check.
    if (report.passed && option('--cleanup', 'false') === 'true') {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('newmark-user-soak-')) throw Error('Cleanup path guard failed');
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (!report.passed) process.exitCode = 1;
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
