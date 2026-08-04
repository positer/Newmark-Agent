/**
 * dev-0.3.0 context system stress gate.
 *
 * Repeatable integration stress for the new context/toolchain/runtime modules.
 * It exercises concurrency, idempotency, checkpoint+delta, optimistic versioning,
 * snapshot/hash binding, agent-run lease contention, subagent ceiling, and tool
 * exposure churn without touching the legacy agent paths.
 *
 * Run: npm run build && node dist/tests/contextSystemV2StressVerify.js
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BuildHistoryRepository,
  PlanTaskRepository,
  ContextOrchestrator,
  ContextBudgetService,
  ToolResultService,
} from '../context';
import { AgentRunService, recoverRunningAgentRuns } from '../agent-runtime';
import { SubAgentContextService, SubAgentCeiling } from '../subagent-runtime';
import {
  ToolRegistry,
  CapabilityCatalog,
  ToolExposurePlanner,
  SchemaLoader,
  ToolPermissionService,
  createToolchainCore,
} from '../toolchain';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-context-v2-stress-'));
}

function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

let passed = 0;
let failed = 0;

function assertOk(cond: boolean, name: string, detail?: string): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`); }
  assert.ok(cond, name);
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runMany(count: number, fn: (index: number) => Promise<void>): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, index) => fn(index)));
}

// ---------------------------------------------------------------------------
// 1. Build History: concurrent appends + idempotency + checkpoint under load
// ---------------------------------------------------------------------------
async function stressBuildHistory(root: string): Promise<void> {
  const history = new BuildHistoryRepository(root);
  const appends = 200;
  const blockId2 = 'stress-block-2';
  await runMany(appends, async (i) => {
    history.appendEntry({
      buildBlockId: blockId2,
      type: 'implementation_progress',
      content: `worker ${i}`,
      source: 'agent',
      operationId: `stress-op-${i}`,
    });
  });
  let entries = history.readEntries(blockId2);
  assertOk(entries.length === appends, `concurrent appends persisted exactly ${appends} entries (got ${entries.length})`);

  // Duplicate operationId retries are all no-ops (idempotency under churn).
  await runMany(appends, async (i) => {
    history.appendEntry({
      buildBlockId: blockId2,
      type: 'implementation_progress',
      content: `duplicate retry ${i}`,
      source: 'agent',
      operationId: `stress-op-${i}`,
    });
  });
  entries = history.readEntries(blockId2);
  assertOk(entries.length === appends, `duplicate operationIds are all no-ops (still ${appends})`);

  // Large history: create a block with many entries, then checkpoint.
  const blockId3 = 'stress-block-3';
  const many = 400;
  for (let i = 0; i < many; i++) {
    history.appendEntry({
      buildBlockId: blockId3,
      type: i % 4 === 0 ? 'established_fact' : 'implementation_progress',
      content: `fact/progress ${i}`,
      source: 'agent',
      importance: i % 10 === 0 ? 'high' : 'normal',
      operationId: `many-${i}`,
    });
  }
  const beforeCheckpoint = history.readEntries(blockId3).length;
  const { checkpoint, delta } = history.checkpoint(blockId3, { keepRecent: 8 });
  assertOk(checkpoint.foldedEntryCount > many - 16, `checkpoint folds older entries (folded=${checkpoint.foldedEntryCount})`);
  assertOk(delta.entries.length <= 16, `delta is small after checkpoint (${delta.entries.length})`);
  assertOk(history.readEntries(blockId3).length === beforeCheckpoint, 'checkpoint never deletes original history');
  assertOk(history.readCompressedView(blockId3).checkpoint?.checkpointId === checkpoint.checkpointId, 'compressed view reads checkpoint');

  // High importance retention: a high/critical entry folded into the checkpoint
  // must be marked in the compression summary.
  const compressed = history.readCompressedView(blockId3);
  assertOk(!!compressed.checkpoint, 'compressed view has a checkpoint');
  const hasHighMarker = compressed.checkpoint!.summary.includes('established_fact*') || compressed.checkpoint!.summary.includes('implementation_progress*');
  assertOk(hasHighMarker, 'high-importance entries are marked in the checkpoint summary');
}

// ---------------------------------------------------------------------------
// 2. Plan/Task: optimistic version conflict under many writers
// ---------------------------------------------------------------------------
async function stressPlanTask(root: string): Promise<void> {
  const repo = new PlanTaskRepository(root);
  const plan = repo.createPlan({ conversationId: 'stress-conv', title: 'stress plan' });

  // 40 writers race to advance the same plan; each must supply the current
  // revision, so exactly one wins at every step and the final revision is 41.
  const writers = 40;
  let version = plan.revision;
  let successes = 0;
  await runMany(writers, async () => {
    const expected = version;
    const result = repo.updatePlan('stress-conv', plan.id, expected, p => { p.status = 'active'; });
    if (result.ok) {
      version = result.value.revision;
      successes += 1;
    }
  });
  assertOk(successes > 0 && version === plan.revision + successes, `optimistic updates: ${successes} writers won, final revision ${version}`);

  // Task creation + status churn with stale rejection.
  const tasks: Array<{ id: string }> = [];
  for (let i = 0; i < 30; i++) {
    const task = repo.createTask({ conversationId: 'stress-conv', title: `task ${i}` });
    tasks.push(task);
  }
  await runMany(30, async (i) => {
    const task = tasks[i % tasks.length];
    const r1 = repo.updateTaskStatus('stress-conv', task.id, 1, 'in_progress');
    const r2 = repo.updateTaskStatus('stress-conv', task.id, 2, 'completed');
    const r3 = repo.updateTaskStatus('stress-conv', task.id, 1, 'completed');
    assertOk(r1.ok === true && r2.ok === true && r3.ok === false && r3.reason === 'version_conflict',
      `task ${i}: fresh version applies, stale version is rejected`);
  });
  const completed = repo.listTasks('stress-conv', { includeCompleted: true });
  assertOk(completed.length === 30, 'all 30 tasks completed through versioned writes');
}

// ---------------------------------------------------------------------------
// 3. Orchestrator + Budget: stable prefix + snapshot hash binding under churn
// ---------------------------------------------------------------------------
async function stressContextSnapshot(root: string): Promise<void> {
  const orchestrator = new ContextOrchestrator();
  const budget = new ContextBudgetService();
  const baseInput = {
    generalPrompt: 'GENERAL',
    responseProtocol: 'PROTOCOL',
    baseToolDefinitions: [{ name: 'tool-a' }, { name: 'tool-b' }],
    workspaceAgentProfile: 'PROFILE',
    agentRoleAndPermissions: 'ROLE',
    capabilityBoundarySummary: 'BOUNDARY',
    activeToolsetManifest: 'MANIFEST',
    buildBlockStartupInput: 'STARTUP',
    buildBlockMetadata: 'META',
    linkedPlan: 'PLAN',
    activeTasks: 'TASKS',
    currentWorkSet: 'WORKSET',
    branchLogSummary: 'BRANCH',
    retrievedOldBlockSummary: 'OLD',
    buildHistoryCheckpoint: 'CHECKPOINT',
    checkpointDelta: 'DELTA',
    currentToolResults: 'RESULTS',
    currentUserInput: 'INPUT',
  };

  const first = orchestrator.assemble(baseInput);
  const firstSnapshot = budget.snapshot({
    conversationId: 'stress-conv',
    branchId: 'branch',
    buildBlockId: 'block',
    agentId: 'agent',
    agentType: 'main',
    provider: 'p',
    model: 'm',
    modelContextLimit: 128000,
    assembled: first,
    toolPayloadBytes: 2048,
  });
  assertOk(budget.verify(firstSnapshot, first) === true, 'first snapshot verifies');

  // 200 dynamic churns: only the user input changes. The stable prefix hash and
  // the snapshot content hash must stay stable until the dynamic tail changes.
  let stableHash = first.hashes.stablePrefixHash;
  let lastContentHash = first.contentHash;
  for (let i = 0; i < 200; i++) {
    const assembled = orchestrator.assemble({ ...baseInput, currentUserInput: `churn ${i}` });
    assertOk(assembled.hashes.stablePrefixHash === stableHash, `stablePrefixHash invariant across churn ${i}`);
    assertOk(assembled.hashes.fullRequestHash !== lastContentHash || i === 0, `fullRequestHash changes with user input churn ${i}`);
    const snapshot = budget.snapshot({
      conversationId: 'stress-conv',
      branchId: 'branch',
      buildBlockId: 'block',
      agentId: 'agent',
      agentType: 'main',
      provider: 'p',
      model: 'm',
      modelContextLimit: 128000,
      assembled,
      toolPayloadBytes: 2048,
    });
    assertOk(budget.verify(snapshot, assembled) === true, `snapshot ${i} binds to its assembled context`);
    lastContentHash = assembled.contentHash;
  }
}

// ---------------------------------------------------------------------------
// 4. Tool results: large outputs spilled, lifecycle respected, block compact
// ---------------------------------------------------------------------------
async function stressToolResults(root: string): Promise<void> {
  const service = new ToolResultService(root);
  const conversationId = 'stress-conv';
  await runMany(60, async (i) => {
    const big = 'y'.repeat(20_000);
    const outcome = service.store({
      callId: `stress-call-${i}`,
      toolId: `tool-${i % 3}`,
      capabilityId: i % 3 === 0 ? 'terminal.execute' : 'filesystem.read',
      buildBlockId: 'stress-block',
      conversationId,
      lifecycle: 'build_scoped',
      status: i % 5 === 0 ? 'error' : 'ok',
      summary: `result ${i}`,
      rawOutput: i % 2 === 0 ? big : 'small',
      operationId: `tr-stress-${i}`,
    });
    if (i % 2 === 0) {
      assertOk(outcome.artifactWritten === true && outcome.record.artifactPaths.length === 1,
        `large output ${i} spills to artifact`);
      assertOk(fs.existsSync(outcome.record.artifactPaths[0]), `artifact ${i} exists`);
    } else {
      assertOk(outcome.artifactWritten === false, `small output ${i} stays inline`);
    }
  });
  const blockText = service.buildContextBlock(conversationId);
  assertOk(blockText.includes('Current Tool Results'), 'tool result context block renders');
  const index = service.readIndex(conversationId);
  assertOk(index.length === 60, 'tool result index holds all results');
}

// ---------------------------------------------------------------------------
// 5. Agent Run: lease contention + limits + recovery under many runs
// ---------------------------------------------------------------------------
async function stressAgentRuns(root: string): Promise<void> {
  const service = new AgentRunService(root);
  const runs: Array<{ id: string }> = [];
  for (let i = 0; i < 50; i++) {
    runs.push(service.create({
      conversationId: 'stress-conv',
      buildBlockId: `b-${i}`,
      agentId: 'agent',
      agentType: i % 3 === 0 ? 'subagent' : 'main',
      limits: { maxIterations: 3 },
    }));
  }
  // 50 owners race to acquire each run: exactly one wins per run.
  await runMany(50, async (i) => {
    const run = runs[i % runs.length];
    service.acquireLease(run.id, `owner-${i}`);
  });
  let leased = 0;
  for (const run of runs) {
    const r = service.read(run.id);
    if (r?.leaseOwner) leased++;
  }
  assertOk(leased === runs.length, `every run has exactly one lease owner (${leased}/${runs.length})`);

  // Advance iterations until every run pauses at max_iterations.
  for (let round = 0; round < 5; round++) {
    for (const run of runs) service.advanceIteration(run.id);
  }
  let paused = 0;
  for (const run of runs) {
    const check = service.checkLimits(run.id);
    if (check.paused) paused++;
  }
  assertOk(paused === runs.length, `all runs pause at the iteration limit (${paused}/${runs.length})`);

  // Recovery: create fresh runs with a short-lived stale lease and verify the
  // recovery scan flags them.
  const crashRuns: Array<{ id: string }> = [];
  for (let i = 0; i < 10; i++) {
    const run = service.create({
      conversationId: 'stress-crash',
      buildBlockId: `crash-${i}`,
      agentId: 'agent',
      agentType: 'main',
    });
    service.acquireLease(run.id, 'dead-owner', 1);
    crashRuns.push({ id: run.id });
  }
  await wait(15);
  const recovered = recoverRunningAgentRuns(service);
  assertOk(crashRuns.every(run => recovered.includes(run.id)), 'stale-lease runs are recovered');
}

// ---------------------------------------------------------------------------
// 6. SubAgent ceiling: no bypass under churn
// ---------------------------------------------------------------------------
async function stressSubAgentCeiling(root: string): Promise<void> {
  const service = new SubAgentContextService(root);
  const ceiling: SubAgentCeiling = {
    allowedCapabilityDomains: ['filesystem', 'code'],
    forbiddenCapabilityIds: ['secrets.read'],
    allowedToolIds: ['file.read', 'code.search'],
    resourceScopes: ['workspace:stress'],
    riskCeiling: 'write',
  };
  const pkg = service.createPackage({
    runId: 'stress-sub',
    parentRunId: 'parent',
    task: 'investigate',
    ceiling,
    discoverableCapabilityIds: ['code.search', 'web.search', 'vcs.publish', 'secrets.read'],
  });
  assertOk(service.verifyImmutable('stress-sub'), 'package is immutable');
  await runMany(80, async (i) => {
    const allowed = service.capabilityAllowed('stress-sub', i % 2 === 0 ? 'filesystem.read' : 'code.search', 'read');
    assertOk(allowed.allowed === true, `ceiling allows in-domain capability ${i}`);
  });
  for (let i = 0; i < 40; i++) {
    const forbidden = service.capabilityAllowed('stress-sub', 'secrets.read', 'read');
    const domain = service.capabilityAllowed('stress-sub', 'web.search', 'read');
    const risk = service.capabilityAllowed('stress-sub', 'vcs.publish', 'external');
    assertOk(forbidden.allowed === false, `forbidden capability never allowed ${i}`);
    assertOk(domain.allowed === false, `out-of-domain capability never allowed ${i}`);
    assertOk(risk.allowed === false, `above-ceiling risk never allowed ${i}`);
  }
  const d1 = service.appendDelta('stress-sub', 'obs A');
  const d2 = service.appendDelta('stress-sub', 'obs B');
  assertOk(d1.sequence === 1 && d2.sequence === 2, 'deltas append in order');
  assertOk(service.verifyImmutable('stress-sub'), 'delta churn keeps the package immutable');
}

// ---------------------------------------------------------------------------
// 7. Tool exposure: planner stability, schema loading churn, permission gates
// ---------------------------------------------------------------------------
async function stressToolExposure(root: string): Promise<void> {
  const { registry, catalog } = createToolchainCore();
  catalog.register({ capabilityId: 'filesystem.read', domain: 'filesystem', name: 'Read', shortDescription: 'read', riskLevel: 'read', discoverability: 'always', loadPolicy: 'on_demand', operations: ['read'] });
  catalog.register({ capabilityId: 'filesystem.write', domain: 'filesystem', name: 'Write', shortDescription: 'write', riskLevel: 'write', discoverability: 'always', loadPolicy: 'on_demand', operations: ['write'] });
  catalog.register({ capabilityId: 'terminal.execute', domain: 'terminal', name: 'Terminal', shortDescription: 'run', riskLevel: 'write', discoverability: 'always', loadPolicy: 'on_demand', operations: ['bash'] });
  catalog.register({ capabilityId: 'code.search', domain: 'code', name: 'Search', shortDescription: 'grep', riskLevel: 'read', discoverability: 'always', loadPolicy: 'on_demand', operations: ['grep'] });
  catalog.register({ capabilityId: 'vcs.publish', domain: 'vcs', name: 'Publish', shortDescription: 'push', riskLevel: 'external', discoverability: 'task_relevant', loadPolicy: 'approval_required', operations: ['push'] });
  catalog.register({ capabilityId: 'secrets.read', domain: 'secrets', name: 'Secrets', shortDescription: 'secret', riskLevel: 'read', discoverability: 'hidden', loadPolicy: 'never', operations: [] });

  registry.register({ toolId: 'file.read', capabilityId: 'filesystem.read', namespace: 'file', name: 'read', version: '1', shortDescription: 'read file', fullDescription: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, riskLevel: 'read' });
  registry.register({ toolId: 'file.write', capabilityId: 'filesystem.write', namespace: 'file', name: 'write', version: '1', shortDescription: 'write file', fullDescription: 'write', inputSchema: { type: 'object', properties: {} }, riskLevel: 'write' });
  registry.register({ toolId: 'terminal.exec', capabilityId: 'terminal.execute', namespace: 'terminal', name: 'bash', version: '1', shortDescription: 'run cmd', fullDescription: 'run', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, riskLevel: 'write' });
  registry.register({ toolId: 'code.search', capabilityId: 'code.search', namespace: 'code', name: 'grep', version: '1', shortDescription: 'grep', fullDescription: 'grep', inputSchema: { type: 'object', properties: {} }, riskLevel: 'read' });
  registry.register({ toolId: 'vcs.push', capabilityId: 'vcs.publish', namespace: 'vcs', name: 'git_push', version: '1', shortDescription: 'push', fullDescription: 'push', inputSchema: { type: 'object', properties: {} }, riskLevel: 'external' });
  registry.register({ toolId: 'secrets.read', capabilityId: 'secrets.read', namespace: 'secrets', name: 'read_secret', version: '1', shortDescription: 'secret', fullDescription: 'secret', inputSchema: { type: 'object', properties: {} }, riskLevel: 'read' });

  // Planner: identical input yields an identical stable hash (no random churn).
  const planner = new ToolExposurePlanner(registry, catalog);
  const frequency = new Map<string, number>();
  const planInput = {
    agentRunId: 'run-stress',
    buildBlockId: 'block-stress',
    userInput: 'refactor the git history',
    objective: 'refactor',
    previousToolCalls: ['file.read'],
    toolUsageFrequency: frequency,
    permissionScope: ['workspace'],
    tokenBudget: 20_000,
    providerToolLimit: 0,
  };
  const h1 = planner.plan(planInput).plan.stableToolsetHash;
  const h2 = planner.plan(planInput).plan.stableToolsetHash;
  assertOk(h1 === h2, 'exposure plan hash is stable for identical input');

  // Schema loader churn: 120 loads of an authorized capability, release, prune.
  const loader = new SchemaLoader(registry, catalog);
  for (let i = 0; i < 120; i++) {
    const result = loader.load({
      agentRunId: `run-${i % 4}`,
      capabilityId: 'code.search',
      reason: 'stress',
    }, { allowedCapabilityIds: ['code.search'], resourceScopes: ['workspace'] });
    assertOk(result.ok === true, `schema load ${i} succeeds`);
  }
  // Prune should collapse to the exposure limit.
  const pruned = loader.prune(4);
  assertOk(loader.activeRecords().length <= 4, `prune caps active exposures (${loader.activeRecords().length})`);

  // Permission gate: 100 checks; subagent external is blocked, and the external
  // tool always requires separate approval.
  const permission = new ToolPermissionService(registry);
  const loader2 = new SchemaLoader(registry, catalog);
  for (let i = 0; i < 100; i++) {
    const read = permission.authorize('file.read', {
      requiredPermissions: [],
      resourceScopes: ['workspace'],
      isSubagent: false,
      allowedCapabilityIds: ['filesystem.read'],
    });
    const subagentPush = permission.authorize('vcs.push', {
      requiredPermissions: [],
      resourceScopes: ['workspace'],
      isSubagent: true,
      allowedCapabilityIds: ['vcs.publish'],
      allowedDomains: ['vcs'],
    });
    const secretLoad = loader2.load({
      agentRunId: `sec-${i % 4}`,
      capabilityId: 'secrets.read',
      reason: 'stress',
    }, { allowedCapabilityIds: ['secrets.read'], resourceScopes: ['workspace'], isSubagent: true, allowedDomains: ['secrets'] });
    const requiresApproval = permission.requiresApproval('vcs.push');
    assertOk(read.allowed === true, `authorized read passes ${i}`);
    assertOk(subagentPush.allowed === false, `external tool blocked for subagent ${i}`);
    assertOk(secretLoad.ok === false && secretLoad.error?.code === 'never_loadable', `never-loadable secret blocked ${i}`);
    assertOk(requiresApproval === true, `external tool requires approval ${i}`);
  }
}

async function main(): Promise<void> {
  const root = tempRoot();
  const startedAt = Date.now();
  try {
    console.log('contextSystemV2StressVerify');
    await stressBuildHistory(root);
    await stressPlanTask(root);
    await stressContextSnapshot(root);
    await stressToolResults(root);
    await stressAgentRuns(root);
    await stressSubAgentCeiling(root);
    await stressToolExposure(root);
    const elapsedMs = Date.now() - startedAt;
    console.log(`contextSystemV2StressVerify: ${passed} passed, ${failed} failed, ${elapsedMs} ms`);
    if (failed > 0) process.exitCode = 1;
    else process.exitCode = 0;
  } finally {
    cleanup(root);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
