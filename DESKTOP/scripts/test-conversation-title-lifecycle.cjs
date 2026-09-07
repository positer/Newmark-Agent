const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const desktop = path.resolve(__dirname, '..');

function loadAgent(source) {
  const filename = path.join(desktop, 'dist/core/agent.js');
  if (!source) return require(filename).Agent;
  // Source-only validation without altering a concurrently owned dist build.
  const ts = require('typescript'), Module = require('node:module');
  const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: source,
  }).outputText;
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled, filename);
  return loaded.exports.Agent;
}

async function verifyConversationTitleLifecycle(options = {}) {
  const Agent = loadAgent(options.source);
  const { LLMProvider } = require(path.join(desktop, 'dist/llm/provider.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-title-lifecycle-'));
  const requests = [], timers = new Set();
  let resolveCancelRequest;
  const cancelRequestArrived = new Promise(resolve => { resolveCancelRequest = resolve; });
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const record = { route: req.url, startedAt: Date.now(), finished: false, disconnectedAt: 0 };
      requests.push(record);
      if (/^\/(?:http503|error-then-empty|empty-then-error|key-code)\//.test(req.url)) {
        const request = JSON.parse(body);
        record.request = { model: request.model, maxTokens: request.max_tokens, reasoningEffort: request.reasoning_effort };
        const attempt = requests.filter(item => item.route === req.url).length;
        const empty = req.url.startsWith('/error-then-empty/') ? attempt === 5 : req.url.startsWith('/empty-then-error/') && attempt < 5;
        record.finished = true;
        res.writeHead(empty ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(empty ? { choices: [{ message: { content: '' } }] } : {
          error: { type: 'new_api_error', code: req.url.startsWith('/key-code/') ? 'fixture-key' : 'get_channel_failed', message: 'Unavailable: fixture-key https://private-provider.invalid/secret?token=fixture-token RAW_BODY_SENTINEL', debug: 'PRIVATE_TRACE_SENTINEL' }
        }));
        res.on('close', () => { record.disconnectedAt = Date.now(); });
        return;
      }
      if (req.url.startsWith('/cancel/')) resolveCancelRequest();
      const delay = req.url.startsWith('/slow/') ? 16000 : 1000;
      const timer = setTimeout(() => {
        timers.delete(timer); record.finished = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Healthy delayed title' } }] }));
      }, delay);
      timers.add(timer);
      res.on('close', () => { record.disconnectedAt = Date.now(); clearTimeout(timer); timers.delete(timer); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const provider = route => new LLMProvider('Title fixture', url + route + '/v1', 'fixture-key', 'openai', 'chat', false, 0, undefined, { enabled: false });
  const makeAgent = name => new Agent(path.join(root, name), { agentOnly: true });
  const result = { root, source: options.source || null, agentSha256: crypto.createHash('sha256').update(fs.readFileSync(options.source || path.join(desktop, 'dist/core/agent.js'))).digest('hex'), cases: {} };
  try {
    await Promise.all([
      (async () => {
        const agent = makeAgent('slow'), started = Date.now();
        const title = await agent.deriveConversationTitleFromProvider('Slow healthy user intent', provider('/slow'), 'fixture-model', 'high');
        result.cases.slowTitle = { title, elapsedMs: Date.now() - started };
      })(),
      (async () => {
        const started = Date.now();
        const title = await provider('/slow').chat('fixture-model', [{ role: 'user', content: 'Transport control' }], null, 0, 64);
        result.cases.slowTransportControl = { title, elapsedMs: Date.now() - started };
      })(),
      (async () => {
        const agent = makeAgent('cancel'), controller = new AbortController(), started = Date.now();
        const pending = agent.deriveConversationTitleFromProvider('Cancelled intent', provider('/cancel'), 'fixture-model', 'high', controller.signal);
        let arrivalTimer;
        await Promise.race([cancelRequestArrived, new Promise((_, reject) => { arrivalTimer = setTimeout(() => reject(Error('Cancel fixture request never reached local server')), 10000); })]);
        clearTimeout(arrivalTimer);
        let cancelledAt = 0;
        const timer = setTimeout(() => { cancelledAt = Date.now(); controller.abort(new Error('user requested stop')); }, 100);
        const title = await pending;
        clearTimeout(timer);
        result.cases.cancelTitle = { title, elapsedMs: Date.now() - started, cancelLatencyMs: Date.now() - cancelledAt, requestReachedServer: true, aborted: controller.signal.aborted, abortListenersAfter: getEventListeners(controller.signal, 'abort').length };
      })(),
      (async () => {
        const agent = makeAgent('empty');
        const providerId = agent.config.upsertProvider('Offline fixture', 'http://127.0.0.1:9/v1', 'fixture-key', 'openai');
        agent.config.addModelToProvider(providerId, 'fixture-model', 'fixture-model', 'Fixture');
        const workspace = agent.createInternalWorkspace('Fixture workspace');
        agent.setModel('fixture-model'); agent.setConversation('empty-title');
        let titleCalls = 0, formalCalls = 0;
        agent.engineModel = () => ({ intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }), chat: async () => { titleCalls++; return ''; }, chatStreamWithTools: async function* () { formalCalls++; yield { type: 'text', text: 'must not start' }; } });
        const started = Date.now(); let error = '';
        try { await agent.process('Persist this first user message'); } catch (e) { error = e.message; }
        const stored = JSON.parse(fs.readFileSync(path.join(workspace.path, 'conversations/state.json'), 'utf8'));
        const entry = Object.values(stored.conversations).find(item => item.chatMessages?.some(message => message.content === 'Persist this first user message'));
        result.cases.emptyTitles = { elapsedMs: Date.now() - started, error, titleCalls, formalCalls, status: agent.status, processDepth: agent.processDepth, processingConversationId: agent.processingConversationId,
          firstUserPersisted: !!entry, persistedUserCount: entry?.chatMessages?.filter(message => message.role === 'user').length, firstAgentResponseStarted: entry?.firstAgentResponseStarted };
      })(),
      (async () => {
        const agent = makeAgent('cancel-retry');
        const providerId = agent.config.upsertProvider('Offline fixture', 'http://127.0.0.1:9/v1', 'fixture-key', 'openai');
        agent.config.addModelToProvider(providerId, 'fixture-model', 'fixture-model', 'Fixture');
        agent.createInternalWorkspace('Cancel retry workspace'); agent.setModel('fixture-model'); agent.setConversation('cancel-retry');
        let titleCalls = 0, formalCalls = 0;
        agent.engineModel = () => ({ intelligenceConfig: () => ({ temperature: 0, maxTokens: 100 }), chat: async () => { titleCalls++; return ''; }, chatStreamWithTools: async function* () { formalCalls++; yield { type: 'text', text: 'must not start' }; } });
        let resolveBackoff;
        const backoffReady = new Promise(resolve => { resolveBackoff = resolve; });
        const originalWait = agent.waitForConversationTitleRetry.bind(agent);
        agent.waitForConversationTitleRetry = async (delayMs, signal) => {
          // Invoke the actual wait first: its timer and abort listener are
          // attached synchronously before the phase barrier becomes ready.
          const waiting = originalWait(delayMs, signal);
          if (delayMs > 0) resolveBackoff({ delayMs, signal, titleCalls });
          return await waiting;
        };
        const started = Date.now();
        const pending = agent.process('Cancel during title retry').catch(error => error.message);
        let arrivalTimer;
        const backoff = await Promise.race([
          backoffReady,
          pending.then(() => { throw new Error('Title run ended before retry backoff'); }),
          new Promise((_, reject) => { arrivalTimer = setTimeout(() => reject(new Error('Title retry backoff was never entered')), 10000); }),
        ]).finally(() => clearTimeout(arrivalTimer));
        const signal = backoff.signal;
        const abortListenersBeforeStop = getEventListeners(signal, 'abort').length;
        const titleCallsAtStop = titleCalls;
        const stoppedAt = Date.now();
        agent.abortActiveKernelRun('title retry fixture user stop');
        const error = await pending;
        result.cases.cancelRetry = { elapsedMs: Date.now() - started, titleCalls, formalCalls, error, status: agent.status, processDepth: agent.processDepth,
          cancelLatencyMs: Date.now() - stoppedAt, elapsedBeforeStopMs: stoppedAt - started,
          backoffDelayMs: backoff.delayMs, titleCallsAtBackoff: backoff.titleCalls, titleCallsAtStop, abortListenersBeforeStop,
          aborted: signal.aborted, abortListenersAfter: getEventListeners(signal, 'abort').length };
      })(),
      ...['http503', 'error-then-empty', 'empty-then-error', 'key-code'].map(async scenario => {
        const agent = makeAgent(scenario);
        const providerId = agent.config.upsertProvider('Title HTTP fixture', url + '/' + scenario + '/v1', 'fixture-key', 'openai');
        agent.config.addModelToProvider(providerId, 'gpt-5-fixture', 'gpt-5-fixture', 'Fixture');
        const workspace = agent.createInternalWorkspace('Title cause fixture');
        agent.setModel('gpt-5-fixture'); agent.setConversation(scenario); agent.intelligence = 'low';
        const real = provider('/' + scenario);
        let formalCalls = 0;
        real.chatStreamWithTools = async function* () { formalCalls++; yield { type: 'text', text: 'must not start' }; };
        agent.engineModel = () => real;
        let error = '';
        try { await agent.process('Persist the provider failure fixture'); } catch (e) { error = e.message; }
        const stored = JSON.parse(fs.readFileSync(path.join(workspace.path, 'conversations/state.json'), 'utf8'));
        const entry = Object.values(stored.conversations).find(item => item.chatMessages?.some(message => message.content === 'Persist the provider failure fixture'));
        const calls = requests.filter(item => item.route.startsWith('/' + scenario + '/'));
        result.cases[scenario] = { error, formalCalls, attempts: calls.length, outbound: calls.map(call => call.request),
          status: agent.status, processDepth: agent.processDepth, processingConversationId: agent.processingConversationId,
          persistedUserCount: entry?.chatMessages?.filter(message => message.role === 'user').length, firstAgentResponseStarted: entry?.firstAgentResponseStarted };
      }),
    ]);
    result.requests = requests.map(item => ({ route: item.route, finished: item.finished, lifetimeMs: item.disconnectedAt - item.startedAt }));
    result.checks = [
      ['The real transport accepts the healthy 16-second response', result.cases.slowTransportControl.title === 'Healthy delayed title' && result.cases.slowTransportControl.elapsedMs >= 15000],
      ['Title generation shares the healthy slow-response policy', result.cases.slowTitle.title === 'Healthy delayed title' && result.cases.slowTitle.elapsedMs >= 15000],
      ['User cancellation promptly ends the in-flight title', result.cases.cancelTitle.title === '' && result.cases.cancelTitle.cancelLatencyMs < 500 && result.cases.cancelTitle.requestReachedServer],
      ['Cancelled title transport releases parent listeners', result.cases.cancelTitle.abortListenersAfter === 0],
      ['Empty titles retain the existing five-attempt limit', result.cases.emptyTitles.titleCalls === 5],
      ['Failed title never starts the formal response', result.cases.emptyTitles.formalCalls === 0 && result.cases.emptyTitles.firstAgentResponseStarted === false],
      ['Failed title preserves exactly one persisted first input', result.cases.emptyTitles.firstUserPersisted && result.cases.emptyTitles.persistedUserCount === 1],
      ['Failed title releases busy ownership', result.cases.emptyTitles.status === 'error' && result.cases.emptyTitles.processDepth === 0 && result.cases.emptyTitles.processingConversationId === null],
      ['User stop interrupts retry backoff without another provider call', result.cases.cancelRetry.cancelLatencyMs < 700
        && result.cases.cancelRetry.backoffDelayMs === 1000 && result.cases.cancelRetry.titleCallsAtBackoff === 2
        && result.cases.cancelRetry.abortListenersBeforeStop > 0 && result.cases.cancelRetry.titleCallsAtStop === 2
        && result.cases.cancelRetry.titleCalls === result.cases.cancelRetry.titleCallsAtStop && result.cases.cancelRetry.formalCalls === 0],
      ['Cancelled retry clears ownership and its abort listener', result.cases.cancelRetry.status === 'idle' && result.cases.cancelRetry.processDepth === 0 && result.cases.cancelRetry.abortListenersAfter === 0],
      ['An empty final title is reported explicitly', /empty.*title/i.test(result.cases.emptyTitles.error)],
      ...['http503', 'error-then-empty', 'empty-then-error', 'key-code'].flatMap(scenario => {
        const item = result.cases[scenario];
        return [
          [`${scenario}: retains exactly five real HTTP attempts`, item.attempts === 5],
          [`${scenario}: final failure describes the last attempt`, scenario === 'error-then-empty'
            ? /empty.*title/i.test(item.error) && !/503|get_channel_failed/.test(item.error)
            : /HTTP 503/.test(item.error) && (scenario === 'key-code' ? /service unavailable/.test(item.error) : /get_channel_failed/.test(item.error))],
          [`${scenario}: excludes credentials, private URL and raw body`, !/fixture-key|private-provider|fixture-token|RAW_BODY_SENTINEL|PRIVATE_TRACE_SENTINEL|new_api_error/.test(item.error)],
          [`${scenario}: preserves frozen deployment, 64-token budget and reasoning`, item.outbound.every(request => request.model === 'gpt-5-fixture' && request.maxTokens === 64 && request.reasoningEffort === 'low')],
          [`${scenario}: retains persisted input and prevents formal response`, item.formalCalls === 0 && item.persistedUserCount === 1 && item.firstAgentResponseStarted === false],
          [`${scenario}: releases busy ownership`, item.status === 'error' && item.processDepth === 0 && item.processingConversationId === null],
        ];
      }),
    ].map(([name, pass]) => ({ name, pass: !!pass }));
    result.passed = result.checks.every(check => check.pass);
    if (options.evidence) { fs.mkdirSync(path.dirname(options.evidence), { recursive: true }); fs.writeFileSync(options.evidence, JSON.stringify(result, null, 2)); }
    console.log(JSON.stringify(result));
    if (!options.baseline) assert.ok(result.passed, 'Title probe must preserve healthy slow responses, promptly honor user stop, and retain its hard gate and persisted first input');
    return result;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { verifyConversationTitleLifecycle };
if (require.main === module) {
  const args = process.argv.slice(2), option = name => args.includes(name) ? path.resolve(args[args.indexOf(name) + 1]) : undefined;
  verifyConversationTitleLifecycle({ source: option('--agent-source'), evidence: option('--evidence'), baseline: args.includes('--baseline') }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
