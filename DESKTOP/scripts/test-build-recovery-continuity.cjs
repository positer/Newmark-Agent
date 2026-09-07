'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const desktop = path.resolve(__dirname, '..');
const { Agent } = require('../dist/core/agent');
if (option('--kernel-source')) {
  const ts = require('typescript'), Module = require('node:module'), filename = path.join(desktop, 'dist/core/agentKernelRunner.js');
  const controlled = new Module(filename, module); controlled.filename = filename; controlled.paths = Module._nodeModulePaths(path.dirname(filename));
  controlled._compile(ts.transpileModule(fs.readFileSync(path.resolve(option('--kernel-source')), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  require(filename).runAgentKernel = controlled.exports.runAgentKernel;
}
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = { kind: 'text' }, empty = { kind: 'empty' }, thought = { kind: 'thought' };
const error = value => ({ kind: 'error', value });
const transient = error('[LLM Error: 503] TRANSIENT_FIXTURE_FAILURE');
const specs = [
  { name: 'empty then visible', steps: [empty, text], calls: 2, waits: [200] },
  { name: 'thought then visible', steps: [thought, text], calls: 2, waits: [200] },
  { name: 'thought exhaustion', step: () => thought, calls: 6, failure: true, waits: [200, 800, 2000, 10000, 60000] },
  { name: 'alternating no-progress exhaustion', step: round => round % 2 ? empty : thought, calls: 6, failure: true, waits: [200, 800, 2000, 10000, 60000] },
  { name: 'route then empty', routed: true, step: (round, model) => model === 'primary' ? transient : round === 3 ? empty : text, calls: 4, models: ['primary', 'primary', 'backup', 'backup'] },
  { name: 'route then thought', routed: true, step: (round, model) => model === 'primary' ? transient : round === 3 ? thought : text, calls: 4, models: ['primary', 'primary', 'backup', 'backup'] },
  { name: 'tool then empty', steps: [{ kind: 'tool' }, empty, text], calls: 3, tools: 1, identical: [1, 2] },
  { name: 'tool then transient', steps: [{ kind: 'tool' }, transient, text], calls: 3, tools: 1, identical: [1, 2] },
  { name: 'fixed single-model transient', steps: [transient, text], calls: 2, waits: [250], identical: [0, 1] },
  { name: 'HTTP 200 structured overload after completed tool', steps: [{ kind: 'tool' }, error('[LLM Error] {"error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later.","param":null,"type":"service_unavailable_error"}}'), text], calls: 3, tools: 1, waits: [250], identical: [1, 2] },
  { name: 'structured overload exhaustion remains bounded', step: () => error('[LLM Error] {"error":{"type":"overloaded_error","message":"Please try again later"}}'), calls: 2, failure: true, waits: [250] },
  { name: 'structured overload wording in a message is not sufficient', steps: [error('[LLM Error] {"error":{"type":"invalid_request_error","message":"server_is_overloaded example is invalid"}}'), text], calls: 1, failure: true, waits: [] },
  { name: 'transport before any content', steps: [{ kind: 'throw', value: 'fetch failed: ECONNRESET' }, text], calls: 2, waits: [250] },
  { name: 'transient exhaustion', step: () => transient, calls: 2, failure: true, waits: [250] },
  { name: 'empty cannot renew transient budget', steps: [transient, empty, transient, text], calls: 3, failure: true, waits: [250, 200] },
  { name: 'partial text is never replayed', steps: [{ kind: 'partial-error' }, text], calls: 1, failure: true, waits: [] },
  { name: 'broker-only private preface is never replayed', brokerOnly: true, steps: [{ kind: 'partial-error' }, text], calls: 1, failure: true, waits: [] },
  { name: 'delivered tool call is never replayed', steps: [{ kind: 'tool-error' }, text], calls: 1, tools: 0, failure: true, waits: [] },
  { name: 'authentication is never retried', steps: [error('[LLM Error: 401] Invalid API key'), text], calls: 1, failure: true, waits: [] },
  { name: 'balance is never retried', steps: [error('[LLM Error: 402] Payment required'), text], calls: 1, failure: true, waits: [] },
  { name: 'permission failure is never retried', steps: [error('[LLM Error: 403] Permission denied'), text], calls: 1, failure: true, waits: [] },
  { name: 'invalid request is never retried', steps: [error('[LLM Error: 400] Invalid parameter'), text], calls: 1, failure: true, waits: [] },
  { name: 'Retry-After 503 honored', steps: [error('[LLM Error: 503] Retry-After: 2s temporary failure'), text], calls: 2, waits: [2000] },
  { name: 'Retry-After 429 honored', steps: [error('[LLM Error: 429] Retry-After: 1250ms too many requests'), text], calls: 2, waits: [1250] },
  { name: 'oversized Retry-After skips extra request', steps: [error('[LLM Error: 503] Retry-After: 6s temporary failure'), text], calls: 1, failure: true, waits: [] },
  { name: 'Guide and completed tool survive recovery', guide: true, steps: [{ kind: 'tool' }, transient, empty, thought, text], calls: 5, tools: 1, identical: [1, 2, 3, 4] },
  { name: 'Auto original same-deployment budget remains single', auto: true, step: () => transient, calls: 2, failure: true, waits: ['planned'] },
  { name: 'Auto preserves Retry-After on 503', auto: true, steps: [error('[LLM Error: 503] Retry-After: 2s temporary failure'), text], calls: 2, waits: ['planned'], actualWaits: [2000] },
  { name: 'Auto preserves Retry-After on 408', auto: true, steps: [error('[LLM Error: 408] Retry-After: 2s temporary failure'), text], calls: 2, waits: ['planned'], actualWaits: [2000] },
  { name: 'Auto Retry-After 429 control', auto: true, steps: [error('[LLM Error: 429] Retry-After: 2s too many requests'), text], calls: 2, waits: ['planned'], actualWaits: [2000] },
  { name: 'real tool progress renews the no-progress allowance', repeatedTools: true, step: round => round > 12 ? text : round % 2 ? empty : { kind: 'tool' }, calls: 13, tools: 6, waits: [200, 200, 200, 200, 200, 200] },
];
const model = name => ({ name, display: name, description: 'Recovery fixture', enabled: true, max_tokens: 128000,
  thinking: true, speed_rating: 'fast', capability_rating: 'high', capabilities: ['text_input', 'text_output', 'tool_use'],
  validation: { level: 'standard', status: 'verified', checked_at: '2026-09-06T00:00:00.000Z', capabilities: { text_input: true, text_output: true, tool_use: true } } });

async function run() {
  const report = { at: new Date().toISOString(), cases: [], checks: [], boundary: 'Actual Agent/Native Kernel with controlled in-process providers; retry waits recorded but skipped. No HTTP, paid request, user state or upstream cache-hit claim.' };
  const check = (name, fn) => { try { fn(); report.checks.push({ name, passed: true }); } catch (error) { report.checks.push({ name, passed: false, error: error.stack || String(error) }); } };
  for (const spec of specs) {
    if (option('--case') && option('--case') !== spec.name) continue;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-build-recovery-'));
    let agent;
    const requests = [], waits = [], actualWaits = [], toolEvents = [];
    let failure, output = '', watchdog = false, guideAccepted = false;
    try {
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ models: {
        providers: { value: [{ id: 'recovery-fixture', name: 'Recovery fixture', enabled: true, base_url: 'https://fixture.invalid/v1', api_key: 'fixture-only', protocol: 'openai', models: spec.routed ? [model('primary'), model('backup')] : [model('primary')] }] },
        default_model: { value: spec.auto ? 'auto' : 'primary' }, auto_switch: { value: !!spec.auto }, fallback_on_unavailable: { value: !!spec.routed },
        auto_switch_scope: { value: 'provider' }, auto_switch_anchor_provider: { value: 'recovery-fixture' },
      }, context: { auto_compress: { value: false } }, workspace: { auto_create_timestamp_workspace: { value: false } } }));
      agent = new Agent(root, { agentOnly: true, workspaceRegistryMode: 'detached', conversationId: spec.name });
      agent.workspace.current = null; agent.config.clearWorkspaceOverrides();
      agent.waitForPlannedRouteRetry = async delay => { waits.push(delay === undefined ? 'planned' : delay); actualWaits.push(delay === undefined ? agent.lastRouteRetryDelayMs : delay); };
      agent.subscribeWorkEvents(event => { if (event.type === 'tool_call' || event.type === 'tool_result') toolEvents.push({ type: event.type, name: event.toolName, id: event.toolCallId }); });
      if (spec.brokerOnly) {
        const catalog = agent.cachedToolDefinitions();
        agent.cachedToolDefinitions = () => catalog.filter(tool => tool.function?.name === 'git_status' || tool.name === 'git_status');
      }
      agent.forcedProvider = {
        intelligenceConfig: () => ({ temperature: 0, maxTokens: 64 }), async chat() { return 'Recovery fixture title'; },
        async *chatStreamWithTools(modelName, messages, system, _temperature, _maxTokens, tools) {
          const round = requests.length + 1;
          requests.push({ model: modelName, systemHash: hash(system), toolsHash: hash(tools), messagesHash: hash(messages), messages: copy(messages), toolNames: tools.map(tool => tool.function.name), routeKind: agent.routeTransitionKind() });
          if (round > Math.max(8, spec.calls + 1)) { watchdog = true; agent.abortActiveKernelRun('test-watchdog'); }
          yield { type: 'usage', text: '', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } };
          if (watchdog) return;
          if (spec.guide && round === 1) guideAccepted = agent.queueActiveKernelMessage('RECOVERY_GUIDE_KEEP_ONCE', 'steer', 'recovery-guide-id', agent.currentWorkRunId());
          const step = spec.step ? spec.step(round, modelName) : spec.steps[round - 1] || text;
          if (step.kind === 'throw') throw new Error(step.value);
          if (step.kind === 'error') yield { type: 'text', text: step.value };
          if (step.kind === 'thought') yield { type: 'text', text: '', reasoningContent: 'PRIVATE_RECOVERY_REASONING' };
          if (step.kind === 'text') yield { type: 'text', text: 'RECOVERY_VISIBLE_DONE' };
          if (step.kind === 'partial-error') {
            yield { type: 'text', text: 'RECOVERY_PARTIAL_PREFIX' };
            throw new Error('HTTP 503 after partial content');
          }
          if (step.kind === 'tool' || step.kind === 'tool-error') {
            yield { type: 'tool_call', text: '', toolCall: { id: spec.repeatedTools ? `recovery-real-pwd-${round}` : 'recovery-real-pwd', name: 'pwd', arguments: '{}' } };
            if (step.kind === 'tool-error') throw new Error('HTTP 503 after completed tool envelope');
          }
        },
      };
      try { output = (await agent.process('Complete this isolated recovery test.')).map(token => token.text || '').join(''); }
      catch (error) { failure = { name: error.name, message: error.message }; }
      report.cases.push({ name: spec.name, requests: requests.map(({ messages, ...rest }) => rest), waits, actualWaits, toolEvents, failure, output, watchdog, totals: copy(agent.providerUsageTotals) });
      check(spec.name + ': bounded outcome', () => { assert.equal(watchdog, false); assert.equal(requests.length, spec.calls); if (spec.failure) { assert.equal(failure?.name, 'ProviderRunError'); assert.equal(agent.status, 'error'); assert.ok(!output.includes('RECOVERY_VISIBLE_DONE')); } else { assert.equal(failure, undefined); assert.ok(output.includes('RECOVERY_VISIBLE_DONE')); assert.equal(agent.status, 'idle'); } });
      check(spec.name + ': real usage is retained without retries for zero cache', () => { assert.deepEqual(agent.providerUsageTotals, { input: requests.length * 100, output: requests.length * 10, cacheRead: 0, cacheWrite: 0 }); assert.ok(!JSON.stringify(agent.history).includes('PRIVATE_RECOVERY_REASONING')); });
      if (spec.waits) check(spec.name + ': planned waits and budgets', () => assert.deepEqual(waits, spec.waits));
      if (spec.actualWaits) check(spec.name + ': server wait survives the Auto planner', () => assert.deepEqual(actualWaits, spec.actualWaits));
      if (spec.models) check(spec.name + ': actual route followed by same-deployment recovery', () => assert.deepEqual(requests.map(request => request.model), spec.models));
      if (spec.tools !== undefined) check(spec.name + ': tools are executed once, never replayed', () => { assert.equal(toolEvents.filter(event => event.type === 'tool_call').length, spec.tools); assert.equal(toolEvents.filter(event => event.type === 'tool_result').length, spec.tools); });
      if (spec.identical) check(spec.name + ': existing system, schemas and submitted prefix are byte-stable', () => { for (const key of ['systemHash', 'toolsHash', 'messagesHash']) assert.equal(new Set(spec.identical.map(index => requests[index]?.[key])).size, 1); if (spec.tools) assert.ok(requests.at(-1).messages.some(message => message.role === 'tool' && message.tool_call_id === 'recovery-real-pwd')); });
      if (spec.guide) check(spec.name + ': accepted Guide stays in the same Build exactly once', () => { assert.equal(guideAccepted, true); assert.equal(agent.history.filter(message => message.role === 'user' && message.content === 'RECOVERY_GUIDE_KEEP_ONCE').length, 1); for (const request of requests.slice(1)) assert.equal(request.messages.filter(message => message.role === 'user' && message.content === 'RECOVERY_GUIDE_KEEP_ONCE').length, 1); });
      if (spec.brokerOnly) check(spec.name + ': fixture really uses a broker-only surface', () => assert.deepEqual(requests[0].toolNames, ['tool_provision']));
      console.log(JSON.stringify({ name: spec.name, requests: requests.length, expectedRequests: spec.calls, failure, watchdog }));
    } finally {
      agent?.flushWorkspaceConversationState();
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('newmark-build-recovery-')) throw Error('Temporary cleanup path guard failed');
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  report.passed = report.checks.every(check => check.passed);
  if (option('--output')) fs.writeFileSync(path.resolve(option('--output')), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, passedChecks: report.checks.filter(check => check.passed).length, failedChecks: report.checks.filter(check => !check.passed).length }));
  if (!report.passed) process.exitCode = 1;
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
