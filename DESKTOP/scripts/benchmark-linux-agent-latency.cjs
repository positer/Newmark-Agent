const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const RUNS = Math.max(20, Number(process.env.NEWMARK_LATENCY_RUNS || 20));
const repoRoot = path.resolve(__dirname, '..', '..');
const desktopRoot = path.resolve(__dirname, '..');
const outputPath = process.env.NEWMARK_LATENCY_OUTPUT || path.join(repoRoot, 'archive', '2026-07-17-dev-0.1.0-linux-agent-latency.json');

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function startProvider() {
  const stats = { requests: 0, receivedAt: [] };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'latency-mock' }] }));
        return;
      }
      stats.requests += 1;
      stats.receivedAt.push(performance.now());
      const payload = JSON.parse(body || '{}');
      const toolResult = (payload.messages || []).some(message => message.role === 'tool');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      if (body.includes('TOOL_LATENCY') && !toolResult) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'latency-tool', function: { name: 'pwd', arguments: '{}' } }] } }] })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'LATENCY_OK' } }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, stats })));
}

function writeRoot(root, port) {
  const config = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'config.example.json'), 'utf8'));
  config.workspace = config.workspace || {};
  config.context = config.context || {};
  config.models = config.models || {};
  config.workspace.auto_create_timestamp_workspace = { value: false };
  config.context.auto_compress = { value: false };
  config.models.default_model = { value: 'Latency Mock/latency-mock' };
  config.models.openai_api_mode = { value: 'chat_stream' };
  config.models.providers = { value: [{ name: 'Latency Mock', base_url: `http://127.0.0.1:${port}/v1`, api_key: 'benchmark-only', protocol: 'openai', enabled: true, models: [{ name: 'latency-mock', evaluation: { status: 'available' } }] }] };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'agent.md'), 'Latency benchmark root.', 'utf8');
}

(async () => {
  const provider = await startProvider();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-latency-'));
  writeRoot(root, provider.port);
  try {
    const { Agent } = require('../dist/core/agent.js');
    const { setPerformanceDiagnosticSink } = require('../dist/core/performanceDiagnostics.js');
    const agent = new Agent(root, { agentOnly: true, conversationId: 'hot' });
    agent.setModel('Latency Mock/latency-mock');
    const samples = [];
    let currentEvents = [];
    setPerformanceDiagnosticSink(event => currentEvents.push(event));
    for (let index = 0; index < RUNS; index++) {
      currentEvents = [];
      const beforeRequests = provider.stats.requests;
      const started = performance.now();
      const tokens = await agent.process(`LATENCY_RUN_${index}`);
      if (!tokens.some(token => String(token.text || '').includes('LATENCY_OK'))) throw new Error('hot response missing LATENCY_OK');
      const providerAt = provider.stats.receivedAt[beforeRequests];
      samples.push({
        localBeforeProviderMs: providerAt - started,
        firstTokenMs: currentEvents.find(event => event.stage === 'first_token')?.durationMs ?? null,
        totalMs: performance.now() - started,
        persistenceWrites: currentEvents.filter(event => event.stage === 'persistence').length,
      });
    }
    agent.setConversation('tool');
    currentEvents = [];
    const beforeToolRequests = provider.stats.requests;
    const toolTokens = await agent.process('TOOL_LATENCY');
    if (!toolTokens.some(token => String(token.text || '').includes('LATENCY_OK'))) throw new Error('tool response missing LATENCY_OK');
    const tool = {
      providerRequests: provider.stats.requests - beforeToolRequests,
      persistenceWrites: currentEvents.filter(event => event.stage === 'persistence').length,
    };
    const coldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-latency-cold-'));
    writeRoot(coldRoot, provider.port);
    const coldStarted = performance.now();
    const beforeColdRequests = provider.stats.requests;
    const coldAgent = new Agent(coldRoot, { agentOnly: true, conversationId: 'cold' });
    coldAgent.setModel('Latency Mock/latency-mock');
    await coldAgent.process('COLD_LATENCY');
    const cold = { localBeforeProviderMs: provider.stats.receivedAt[beforeColdRequests] - coldStarted };
    fs.rmSync(coldRoot, { recursive: true, force: true });
    setPerformanceDiagnosticSink(null);
    const summary = {
      runs: RUNS,
      hotFirstEventP95Ms: percentile(samples.map(sample => sample.localBeforeProviderMs), 0.95),
      hotFirstTokenP95Ms: percentile(samples.map(sample => sample.firstTokenMs), 0.95),
      coldLocalBeforeProviderMs: cold.localBeforeProviderMs,
      toolProviderRequests: tool.providerRequests,
      maxHotPersistenceWrites: Math.max(...samples.map(sample => sample.persistenceWrites)),
      passed: false,
    };
    summary.passed = summary.hotFirstEventP95Ms <= 300
      && summary.hotFirstTokenP95Ms <= 500
      && summary.coldLocalBeforeProviderMs <= 2000
      && summary.toolProviderRequests === 2
      && summary.maxHotPersistenceWrites <= 4;
    const report = { generatedAt: new Date().toISOString(), platform: process.platform, summary, samples, cold, tool };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(summary));
    if (!summary.passed) process.exitCode = 1;
  } finally {
    provider.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exit(1); });
