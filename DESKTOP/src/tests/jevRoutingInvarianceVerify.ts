/**
 * The single most important Auto Router v2 gate (execution guide §29 / §51):
 *
 *   For an identical JEV output, identical candidate catalog, identical user
 *   policy and identical live endpoint state, the resolved deployment must be
 *   identical no matter how `feedback.jsonl`, past 👍/👎 ratings, past manual
 *   model switches, past tool outcomes or stored `quality_by_task` values
 *   change.
 *
 * If a test in this file fails, legacy self-learning is still influencing model
 * selection somewhere on a hidden path.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Agent } from '../core/agent';
import {
  AutoRouteCandidate,
  RouteExecutionController,
  classifyTaskClasses,
  classifyRouteFailure,
  defaultRoutePolicy,
} from '../core/autoRouter';
import {
  JEV_ROUTE_MODEL_VERSION,
  CURRENT_MODEL_JEV_VERSION,
  type JevDecisionEngine,
  type JevRouteDecision,
  type JevRouteRequest,
} from '../core/jevDecision';
import { resolveAutoRouteDecision } from '../core/routeDecisionValidator';

let mockProviderBaseUrl = '';
let currentModelDecision: Record<string, unknown> = {};
let mockProviderServer: http.Server | null = null;

function setCurrentModelDecision(value: JevRouteDecision): void {
  const deployment = (item: JevRouteDecision['primary']) => ({
    providerId: item.providerId,
    modelId: item.modelId,
    logicalModelGroupId: item.logicalModelGroupId || '',
  });
  currentModelDecision = {
    primary: deployment(value.primary),
    alternates: value.alternates.map(deployment),
    reasonCodes: [...value.reasonCodes],
    confidence: value.confidence ?? null,
    modelVersion: CURRENT_MODEL_JEV_VERSION,
  };
}

function startMockProvider(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw) as Record<string, unknown>;
        if (!body.response_format || typeof body.response_format !== 'object') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'JEV requires native JSON Schema output' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: 'jev-local-provider-fixture',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(currentModelDecision) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 128, completion_tokens: 32, total_tokens: 160 },
        }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Invalid JEV request JSON' } }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      mockProviderBaseUrl = `http://127.0.0.1:${address.port}/v1`;
      resolve(server);
    });
  });
}

let assertions = 0;
function ok(value: unknown, message: string): void {
  assert.ok(value, message);
  assertions += 1;
  console.log(`PASS: ${message}`);
}

class FakeJevDecisionEngine implements JevDecisionEngine {
  public calls = 0;
  constructor(private readonly response: JevRouteDecision | ((request: JevRouteRequest) => JevRouteDecision)) {}

  async decide(request: JevRouteRequest): Promise<JevRouteDecision> {
    this.calls += 1;
    return typeof this.response === 'function' ? this.response(request) : this.response;
  }
}

class HangingJevDecisionEngine implements JevDecisionEngine {
  public calls = 0;
  async decide(): Promise<JevRouteDecision> {
    this.calls += 1;
    return new Promise<JevRouteDecision>(() => { /* never settles inside the budget */ });
  }
}

function decision(providerId: string, modelId: string, alternates: Array<[string, string]> = []): JevRouteDecision {
  return {
    primary: { providerId, modelId },
    alternates: alternates.map(([provider, model]) => ({ providerId: provider, modelId: model })),
    reasonCodes: ['coding', 'tool_use', 'short_context', 'mode:balanced'],
    modelVersion: JEV_ROUTE_MODEL_VERSION,
  };
}

function providerFixture(id: string, name: string, models: Array<Record<string, unknown>>) {
  return {
    id,
    name,
    base_url: mockProviderBaseUrl || `https://${id}.invalid/v1`,
    api_key: `${id}-secret-key`,
    protocol: 'openai',
    enabled: true,
    models,
  };
}

function modelFixture(name: string, cost: number, extra: Record<string, unknown> = {}) {
  return {
    name,
    display: name,
    description: '',
    cost_per_1k_input: cost,
    cost_per_1k_output: cost,
    max_tokens: 128000,
    vision: false,
    thinking: false,
    image_output: false,
    speed_rating: 'fast',
    capability_rating: 'high',
    capabilities: ['text_input', 'text_output', 'tool_use', 'json_schema'],
    validation: {
      level: 'standard',
      status: 'verified',
      checked_at: new Date().toISOString(),
      capabilities: { text_input: true, text_output: true, tool_use: true, json_schema: true },
    },
    intelligence_tiers: { low: { description: 'Quick' }, medium: { description: 'Balanced' }, high: { description: 'Deep' } },
    ...extra,
  };
}

/**
 * A catalog whose history-bearing fields are deliberately hostile: model A is
 * the "historically perfect" deployment and model B the "historically failing"
 * one. Auto Router v2 must be indifferent to both.
 */
function writeInvarianceRoot(options: {
  qualityPreference?: 'provider-a' | 'none';
  feedbackHistory?: boolean;
  ratingHistory?: boolean;
  extraModels?: Array<Record<string, unknown>>;
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-jev-invariance-'));
  const qualityA = options.qualityPreference === 'none'
    ? {}
    : { quality_by_task: { coding: { successes: 1000, attempts: 1000 }, tool_use: { successes: 1000, attempts: 1000 }, chat: { successes: 1000, attempts: 1000 } } };
  const qualityB = options.qualityPreference === 'none'
    ? {}
    : { quality_by_task: { coding: { successes: 0, attempts: 1000 }, tool_use: { successes: 0, attempts: 1000 }, chat: { successes: 0, attempts: 1000 } } };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    models: {
      providers: { value: [
        providerFixture('provider-a', 'Provider A', [
          modelFixture('model-a', 0.1, { route_preference: 0, ...qualityA }),
          ...(options.extraModels || []),
        ]),
        providerFixture('provider-b', 'Provider B', [modelFixture('model-b', 0.2, qualityB)]),
      ] },
      default_model: { value: 'model-a' },
      auto_switch: { value: true },
      auto_switch_preference: { value: 'balanced' },
      auto_switch_scope: { value: 'all' },
      fallback_on_unavailable: { value: true },
      jev_enabled: { value: true },
      jev_timeout_ms: { value: 3000 },
    },
    workspace: { auto_create_timestamp_workspace: { value: false } },
  }, null, 2));
  const routingDir = path.join(root, 'routing');
  fs.mkdirSync(routingDir, { recursive: true });
  if (options.feedbackHistory) {
    const at = Date.now();
    const lines: string[] = [];
    for (let index = 0; index < 240; index += 1) {
      for (const taskClass of ['coding', 'tool_use', 'chat']) {
        lines.push(JSON.stringify({
          deployment: { providerId: 'provider-a', modelId: 'model-a' },
          taskClass,
          score: 1,
          source: index % 3 === 0 ? 'manual_switch' : index % 3 === 1 ? 'explicit_rating' : 'objective_success',
          at: at - index * 1_000,
        }));
        lines.push(JSON.stringify({
          deployment: { providerId: 'provider-b', modelId: 'model-b' },
          taskClass,
          score: -1,
          source: 'explicit_rating',
          at: at - index * 1_000,
        }));
      }
    }
    fs.writeFileSync(path.join(routingDir, 'feedback.jsonl'), `${lines.join('\n')}\n`);
  }
  if (options.ratingHistory) {
    fs.writeFileSync(path.join(routingDir, 'ratings.jsonl'), `${JSON.stringify({
      routeId: 'legacy-route',
      score: -1,
      deployment: { providerId: 'provider-b', modelId: 'model-b' },
      taskClasses: ['coding', 'tool_use'],
      decisionSource: 'jev',
      jevModelVersion: JEV_ROUTE_MODEL_VERSION,
      at: Date.now(),
    })}\n`);
  }
  return root;
}

function routingSummary(agent: Agent): string {
  return JSON.stringify({
    deployment: agent.lastRouteDecision?.resolvedDeployment || null,
    alternatives: agent.lastRouteDecision?.alternatives || [],
    decisionSource: agent.lastRouteDecision?.decisionSource || '',
    reasonCodes: agent.lastRouteDecision?.jev.reasonCodes || [],
    finalStatus: agent.lastRouteDecision?.finalStatus || '',
  });
}

async function main(): Promise<void> {
  mockProviderServer = await startMockProvider();
  // ---- Test A: stored feedback cannot beat the JEV decision ---------------
  {
    const cleanRoot = writeInvarianceRoot();
    const historyRoot = writeInvarianceRoot({ feedbackHistory: true, ratingHistory: true });
    setCurrentModelDecision(decision('provider-b', 'model-b', [['provider-a', 'model-a']]));
    const cleanAgent = new Agent(cleanRoot, { agentOnly: true, conversationId: 'invariance-a' });
    const historyAgent = new Agent(historyRoot, { agentOnly: true, conversationId: 'invariance-a' });
    try {
      for (const agent of [cleanAgent, historyAgent]) {
        agent.setModel('auto');
        await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
      }
      ok(historyAgent.activeDeployment()?.providerId === 'provider-b'
        && historyAgent.activeDeployment()?.modelId === 'model-b',
      'test A: a 240-line learned feedback log strongly preferring model A cannot override the JEV decision for model B');
      ok(routingSummary(cleanAgent) === routingSummary(historyAgent),
        'test A: identical JEV output and catalog produce identical routing with and without routing history on disk');
    } finally {
      fs.rmSync(cleanRoot, { recursive: true, force: true });
      fs.rmSync(historyRoot, { recursive: true, force: true });
    }
  }

  // ---- Test B: quality_by_task cannot beat the JEV decision ---------------
  {
    const root = writeInvarianceRoot({ qualityPreference: 'provider-a' });
    setCurrentModelDecision(decision('provider-b', 'model-b'));
    const agent = new Agent(root, { agentOnly: true, conversationId: 'invariance-b' });
    try {
      const stored = agent.config.findDeployment({ providerId: 'provider-a', modelId: 'model-a' })?.quality_by_task;
      ok(stored?.coding?.successes === 1000,
        'test B: the fixture stores a 1000/1000 quality_by_task history for model A');
      agent.setModel('auto');
      await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
      ok(agent.activeDeployment()?.modelId === 'model-b',
        'test B: stored quality_by_task (1000/1000 vs 0/1000) cannot override the JEV decision for model B');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- Test C: legacy feedback files remain inert and untouched -----------
  {
    const root = writeInvarianceRoot({ feedbackHistory: true, ratingHistory: true });
    setCurrentModelDecision(decision('provider-b', 'model-b'));
    const agent = new Agent(root, { agentOnly: true, conversationId: 'invariance-c' });
    try {
      const ratingsPath = path.join(root, 'routing', 'ratings.jsonl');
      const savedRatings = fs.readFileSync(ratingsPath, 'utf-8');
      agent.setModel('auto');
      await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
      const firstDeployment = JSON.stringify(agent.lastRouteDecision?.resolvedDeployment || null);
      const beforePreference = JSON.stringify(agent.config.findDeployment({ providerId: 'provider-b', modelId: 'model-b' })?.quality_by_task || {});
      agent.resetAutoRoute();
      await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
      ok(agent.activeDeployment()?.modelId === 'model-b'
        && JSON.stringify(agent.lastRouteDecision?.resolvedDeployment || null) === firstDeployment,
      'test C: a repeated current-model decision is unaffected by legacy feedback files');
      ok(JSON.stringify(agent.config.findDeployment({ providerId: 'provider-b', modelId: 'model-b' })?.quality_by_task || {}) === beforePreference,
        'test C: existing model-quality records are not modified by Auto routing');
      ok(fs.readFileSync(ratingsPath, 'utf-8') === savedRatings,
        'test C: existing rating telemetry is neither read into the decision nor rewritten/deleted');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- Test D: a manual switch cannot train the next Auto route ----------
  {
    const root = writeInvarianceRoot();
    setCurrentModelDecision(decision('provider-b', 'model-b'));
    const agent = new Agent(root, { agentOnly: true, conversationId: 'invariance-d' });
    try {
      agent.setModel('auto');
      await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
      agent.setModel('model-a');
      ok(agent.model === 'model-a', 'test D: the user manually switched Auto to model A');
      agent.setModel('auto');
      await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
      ok(agent.activeDeployment()?.modelId === 'model-b',
        'test D: an Auto → manual A → Auto sequence cannot teach Auto to prefer A');
      ok(!fs.existsSync(path.join(root, 'routing', 'feedback.jsonl')),
        'test D: a manual model switch records no learned feedback event');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- Test E: tool outcomes are health-only ------------------------------
  {
    const root = writeInvarianceRoot();
    setCurrentModelDecision(decision('provider-a', 'model-a'));
    const agent = new Agent(root, { agentOnly: true, conversationId: 'invariance-e' });
    try {
      agent.setModel('auto');
      await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
      for (let index = 0; index < 100; index += 1) agent.recordRouteToolOutcome(true);
      ok(agent.activeDeployment()?.modelId === 'model-a', 'test E: the first decision selects model A for the tool request');
      const qualityBefore = JSON.stringify(agent.config.findDeployment({ providerId: 'provider-a', modelId: 'model-a' })?.quality_by_task || {});
      const health = (agent as unknown as { routeController: { endpointMetrics(deployment: { providerId: string; modelId: string }): { toolAttempts: number } } }).routeController.endpointMetrics({ providerId: 'provider-a', modelId: 'model-a' });
      ok(health.toolAttempts >= 100, 'test E: 100 successful tool results are recorded as operational health');
      agent.resetAutoRoute();
      await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
      ok(agent.activeDeployment()?.modelId === 'model-a'
        && JSON.stringify(agent.config.findDeployment({ providerId: 'provider-a', modelId: 'model-a' })?.quality_by_task || {}) === qualityBefore
        && !fs.existsSync(path.join(root, 'routing', 'feedback.jsonl')),
      'test E: 100 tool successes never become model preference, quality evidence or a feedback event');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ---- Tests F + G: the validator refuses anything the guard excluded ----
  {
    const engine = new FakeJevDecisionEngine(decision('provider-b', 'model-b'));
    const candidates: AutoRouteCandidate[] = [
      {
        deployment: { providerId: 'provider-a', modelId: 'model-a' },
        enabled: true,
        validation: { level: 'standard', status: 'verified', checkedAt: 'fixture' },
        capabilities: ['text_input', 'text_output', 'tool_use'],
        maxContextTokens: 128_000,
        preview: false,
        privacy: ['default'],
        expectedInputCostUsdPerM: 1,
        expectedOutputCostUsdPerM: 4,
      },
      {
        deployment: { providerId: 'provider-a', modelId: 'model-without-tools' },
        enabled: true,
        validation: { level: 'standard', status: 'verified', checkedAt: 'fixture' },
        capabilities: ['text_input', 'text_output'],
        maxContextTokens: 128_000,
        preview: true,
        privacy: ['default'],
        expectedInputCostUsdPerM: 1,
        expectedOutputCostUsdPerM: 4,
      },
    ];
    const guarded = await resolveAutoRouteDecision({
      selection: { kind: 'auto', scope: { kind: 'provider', providerId: 'provider-a' }, policyId: 'balanced' },
      policy: defaultRoutePolicy('balanced'),
      taskText: 'Use a tool to inspect this screenshot',
      request: {
        transactionId: 'scope-guard',
        taskText: 'Use a tool to inspect this screenshot',
        estimatedInputTokens: 500,
        expectedOutputTokens: 500,
        requiredCapabilities: ['text_input', 'text_output', 'tool_use'],
      },
      candidates,
      taskClasses: classifyTaskClasses('Use a tool to inspect this screenshot', ['tool_use'], 500),
      engine,
    });
    ok(guarded.decisionSource === 'jev'
      && !guarded.resolvedDeployment
      && guarded.finalStatus === 'no_candidate'
      && String(guarded.decisionError || '').includes('primary_not_eligible'),
    'test F/G: a JEV primary outside the guard set stops Auto without a second selector');
  }

  // ---- Test H: a JEV timeout fails closed -------------------------------
  {
    const engine = new HangingJevDecisionEngine();
    const candidate: AutoRouteCandidate = {
      deployment: { providerId: 'provider-a', modelId: 'model-a' },
      enabled: true,
      validation: { level: 'standard', status: 'verified', checkedAt: 'fixture' },
      capabilities: ['text_input', 'text_output'],
      maxContextTokens: 128_000,
      preview: false,
      privacy: ['default'],
    };
    const startedAt = Date.now();
    const timeoutRoute = await resolveAutoRouteDecision({
      selection: { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
      policy: defaultRoutePolicy('balanced'),
      taskText: 'Write TypeScript code.',
      request: { transactionId: 'jev-timeout', taskText: 'Write TypeScript code.', estimatedInputTokens: 100, expectedOutputTokens: 100, requiredCapabilities: ['text_input', 'text_output'] },
      candidates: [candidate],
      taskClasses: classifyTaskClasses('Write TypeScript code.', [], 100),
      engine,
      timeoutMs: 25,
    });
    const elapsed = Date.now() - startedAt;
    ok(!timeoutRoute.resolvedDeployment && timeoutRoute.finalStatus === 'no_candidate'
      && timeoutRoute.decisionSource === 'jev'
      && timeoutRoute.decisionError?.includes('timeout'),
    'test H: a JEV timeout stops Auto instead of selecting a deterministic fallback');
    ok(elapsed < 2_000, `test H: the timeout budget stops the Auto route promptly (${elapsed} ms)`);
  }

  // ---- Test I: recovery cannot cross the failed provider boundary ---------
  {
    const controller = new RouteExecutionController();
    const candidates: AutoRouteCandidate[] = [
      {
        deployment: { providerId: 'provider-a', modelId: 'model-a' },
        enabled: true,
        validation: { level: 'standard', status: 'verified', checkedAt: 'fixture' },
        capabilities: ['text_input', 'text_output'],
        maxContextTokens: 128_000,
        preview: false,
        privacy: ['default'],
      },
      {
        deployment: { providerId: 'provider-b', modelId: 'model-b' },
        enabled: true,
        validation: { level: 'standard', status: 'verified', checkedAt: 'fixture' },
        capabilities: ['text_input', 'text_output'],
        maxContextTokens: 128_000,
        preview: false,
        privacy: ['default'],
      },
    ];
    const routed = await resolveAutoRouteDecision({
      selection: { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' },
      policy: defaultRoutePolicy('balanced'),
      taskText: 'Explain the result',
      request: {
        transactionId: 'provider-local-recovery',
        taskText: 'Explain the result',
        estimatedInputTokens: 100,
        expectedOutputTokens: 100,
        requiredCapabilities: ['text_input', 'text_output'],
      },
      candidates,
      taskClasses: classifyTaskClasses('Explain the result', [], 100),
      engine: new FakeJevDecisionEngine(decision('provider-a', 'model-a', [['provider-b', 'model-b']])),
    });
    const ladder = controller.planAttempts(routed, candidates, {
      error: classifyRouteFailure('HTTP 503 upstream unavailable'),
      streamCommitted: false,
      sideEffectCommitted: false,
    });
    ok(routed.resolvedDeployment?.providerId === 'provider-a'
      && routed.alternatives.some(item => item.providerId === 'provider-b'),
    'test I: the validated JEV alternate crosses providers as an ordering hint');
    ok(ladder.length >= 1 && ladder.every(attempt => attempt.deployment.providerId === 'provider-a'),
      'test I: provider-local recovery never switches to the alternate provider on failure');
  }

  // ---- Test J: transaction continuation keeps the first Build decision ----
  {
    const candidates: AutoRouteCandidate[] = [
      {
        deployment: { providerId: 'provider-a', modelId: 'model-a' },
        enabled: true,
        validation: { level: 'standard', status: 'verified', checkedAt: 'fixture' },
        capabilities: ['text_input', 'text_output'],
        maxContextTokens: 128_000,
        preview: false,
        privacy: ['default'],
        expectedInputCostUsdPerM: 0.1,
        expectedOutputCostUsdPerM: 0.1,
      },
      {
        deployment: { providerId: 'provider-a', modelId: 'model-b' },
        enabled: true,
        validation: { level: 'standard', status: 'verified', checkedAt: 'fixture' },
        capabilities: ['text_input', 'text_output'],
        maxContextTokens: 128_000,
        preview: false,
        privacy: ['default'],
        expectedInputCostUsdPerM: 0.2,
        expectedOutputCostUsdPerM: 0.2,
      },
    ];
    const pipelineInput = {
      selection: { kind: 'auto', scope: { kind: 'global' }, policyId: 'balanced' } as const,
      policy: defaultRoutePolicy('balanced'),
      taskText: 'Continue the Build',
      request: {
        transactionId: 'build-turn',
        taskText: 'Continue the Build',
        estimatedInputTokens: 100,
        expectedOutputTokens: 100,
        requiredCapabilities: ['text_input', 'text_output'],
      },
      candidates,
      taskClasses: classifyTaskClasses('Continue the Build', [], 100),
    };
    const firstTurn = await resolveAutoRouteDecision({
      ...pipelineInput,
      engine: new FakeJevDecisionEngine(decision('provider-a', 'model-a', [['provider-a', 'model-b']])),
    });
    const secondTurn = await resolveAutoRouteDecision({
      ...pipelineInput,
      engine: new FakeJevDecisionEngine(decision('provider-a', 'model-b', [['provider-a', 'model-a']])),
      pinnedDeployment: firstTurn.resolvedDeployment,
    });
    ok(secondTurn.resolvedDeployment?.modelId === 'model-a'
      && secondTurn.pinReason === 'transaction'
      && secondTurn.alternatives.some(item => item.modelId === 'model-b'),
    'test J: a transaction continuation cannot silently re-decide the Build onto another deployment');
  }

  // ---- Determinism across repeated identical requests ---------------------
  {
    const root = writeInvarianceRoot();
    setCurrentModelDecision(decision('provider-b', 'model-b', [['provider-a', 'model-a']]));
    const agent = new Agent(root, { agentOnly: true, conversationId: 'invariance-determinism' });
    try {
      agent.setModel('auto');
      const summaries: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        agent.resetAutoRoute();
        await agent.evaluateAndSwitch('Write TypeScript code with a validated tool.');
        summaries.push(routingSummary(agent));
      }
      ok(new Set(summaries).size === 1,
        'determinism: repeated identical Auto requests resolve to one identical decision');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  if (mockProviderServer) {
    await new Promise<void>(resolve => mockProviderServer!.close(() => resolve()));
    mockProviderServer = null;
  }
  console.log(`JEV routing invariance verification passed (${assertions} assertions)`);
}

main().catch(error => {
  if (mockProviderServer) mockProviderServer.close();
  console.error(error);
  process.exit(1);
});
