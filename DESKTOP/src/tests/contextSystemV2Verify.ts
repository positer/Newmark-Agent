/**
 * dev-0.3.0 context system v2 verification.
 * Run: npm run build && node dist/tests/contextSystemV2Verify.js
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BuildHistoryRepository,
  PlanTaskRepository,
  ContextOrchestrator,
  CONTEXT_SECTION_ORDER,
  ContextBudgetService,
  ToolResultService,
  AgentContextManager,
  VERSION_INFO,
  sha256,
} from '../context';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-context-v2-'));
}

function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}

function check(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  [PASS] ${name}`);
  else console.log(`  [FAIL] ${name}${detail ? `: ${detail}` : ''}`);
  assert.ok(cond, name);
}

async function main(): Promise<void> {
  const root = tempRoot();
  try {
    console.log('contextSystemV2Verify');

    // -----------------------------------------------------------------------
    // Version protocol
    // -----------------------------------------------------------------------
    check(VERSION_INFO.applicationVersion === 'dev-0.3.0', 'VERSION_INFO application version is dev-0.3.0');
    check(VERSION_INFO.contextSchemaVersion === 2, 'context schema version is 2');
    check(VERSION_INFO.agentProtocolVersion === '0.3', 'agent protocol version is 0.3');
    check(VERSION_INFO.toolCapabilityProtocolVersion === '1', 'tool capability protocol version is 1');

    // -----------------------------------------------------------------------
    // Build History repository (append-only + idempotency + supersede)
    // -----------------------------------------------------------------------
    const history = new BuildHistoryRepository(root);
    const blockId = 'block-1';
    const write1 = history.appendEntry({
      buildBlockId: blockId,
      type: 'user_guide',
      content: 'Initial instruction',
      source: 'user',
      importance: 'high',
      operationId: 'op-1',
    });
    check(write1.applied === true && !!write1.entry, 'first build history entry applies');
    check(!!write1.entry?.contentHash, 'entry carries a content hash');

    const duplicate = history.appendEntry({
      buildBlockId: blockId,
      type: 'user_guide',
      content: 'Initial instruction (duplicate retry)',
      source: 'user',
      operationId: 'op-1',
    });
    check(duplicate.applied === false && duplicate.reason === 'duplicate_operation', 're-applying the same operationId is a no-op');

    const write2 = history.appendEntry({
      buildBlockId: blockId,
      type: 'decision',
      content: 'Use structured plan v2',
      source: 'agent',
      operationId: 'op-2',
    });
    check(write2.applied === true, 'second entry applies with a different operationId');

    const entries = history.readEntries(blockId);
    check(entries.length === 2, 'history is append-only: two entries persisted');

    const oldContent = entries[0].content;
    const amendment = history.appendEntry({
      buildBlockId: blockId,
      type: 'amendment',
      content: 'Correction to op-1',
      source: 'agent',
      operationId: 'op-3',
      supersedes: entries[0].id,
    });
    check(amendment.applied === true, 'amendment entry applies');
    const afterAmend = history.readEntries(blockId);
    check(afterAmend.length === 3, 'amendment appends, never deletes');
    check(afterAmend[0].content === oldContent, 'old content is untouched by amendment');
    check(afterAmend[2].supersededBy === entries[0].id && afterAmend[2].type === 'amendment', 'amendment recorded with supersede link');

    // supersede link
    const superseded = history.supersede(blockId, entries[0].id, amendment.entry!.id);
    check(superseded === true, 'supersede marks an earlier entry');
    const afterSupersede = history.readEntries(blockId);
    check(afterSupersede[0].supersededBy === amendment.entry!.id, 'supersededBy link is persisted');

    // checkpoint + delta
    for (let i = 0; i < 8; i++) {
      history.appendEntry({
        buildBlockId: blockId,
        type: 'implementation_progress',
        content: `Progress step ${i + 1}`,
        source: 'agent',
        operationId: `step-${i + 1}`,
      });
    }
    const { checkpoint, delta } = history.checkpoint(blockId);
    check(checkpoint.foldedEntryCount >= 3, 'checkpoint folds older entries');
    check(delta.checkpointId === checkpoint.checkpointId, 'delta references the checkpoint');
    const compressedView = history.readCompressedView(blockId);
    check(compressedView.checkpoint?.checkpointId === checkpoint.checkpointId, 'compressed view keeps the checkpoint');
    check(compressedView.delta.entries.length <= 10, 'compressed delta is small');
    const rawEntriesAfterCheckpoint = history.readEntries(blockId);
    check(rawEntriesAfterCheckpoint.length === 11, 'original history is NOT deleted by checkpoint');

    // build block lifecycle
    history.saveBlock({
      id: blockId,
      conversationId: 'conv-1',
      branchId: 'branch-1',
      parentBuildBlockId: null,
      startupInput: 'Build the feature',
      status: 'created',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      revision: 1,
      activeCheckpointId: null,
      tokenBudgetPolicyId: 'default',
      metadata: {},
    });
    const readBlock = history.readBlock(blockId);
    check(!!readBlock && readBlock.id === blockId, 'block reads back');
    const transitioned = history.transitionBlock(readBlock!, { status: 'active' }, { expectedRevision: 1 });
    check(transitioned.applied === true && transitioned.block.revision === 2, 'block transition increments revision');
    const stale = history.transitionBlock(transitioned.block, { status: 'completed' }, { expectedRevision: 1 });
    check(stale.applied === false, 'stale expectedRevision rejects the block transition');

    // -----------------------------------------------------------------------
    // Plan / Task repository (expectedVersion)
    // -----------------------------------------------------------------------
    const planTask = new PlanTaskRepository(root);
    const plan = planTask.createPlan({ conversationId: 'conv-1', title: 'v2 plan' });
    check(plan.revision === 1, 'new plan starts at revision 1');

    const stepAdd = planTask.addStep('conv-1', plan.id, 1, { title: 'Step A', detail: 'do A' });
    check(stepAdd.ok === true && stepAdd.value.steps.length === 1, 'step added under expectedVersion 1');
    check(stepAdd.ok === true && stepAdd.value.revision === 2, 'plan revision advanced to 2');

    const conflict = planTask.updatePlanStatus('conv-1', plan.id, 1, 'active');
    check(conflict.ok === false && conflict.reason === 'version_conflict', 'expectedVersion conflict rejects the write (no last-write-wins)');

    const okStatus = planTask.updatePlanStatus('conv-1', plan.id, 2, 'active');
    check(okStatus.ok === true && okStatus.value.status === 'active', 'fresh expectedVersion applies');

    const task = planTask.createTask({ conversationId: 'conv-1', title: 'task 1' });
    check(task.revision === 1, 'new task starts at revision 1');
    const taskUpdate = planTask.updateTaskStatus('conv-1', task.id, 1, 'in_progress');
    check(taskUpdate.ok === true, 'task status update applies at expectedVersion');
    const taskConflict = planTask.updateTaskStatus('conv-1', task.id, 1, 'completed');
    check(taskConflict.ok === false && taskConflict.reason === 'version_conflict', 'task version conflict rejected');
    const taskDone = planTask.updateTaskStatus('conv-1', task.id, 2, 'completed');
    check(taskDone.ok === true && taskDone.value.completedAt !== undefined, 'task completion records completedAt');

    const defaultTasks = planTask.listTasks('conv-1');
    check(defaultTasks.length === 0, 'default task list excludes completed/cancelled');
    const allTasks = planTask.listTasks('conv-1', { includeCompleted: true });
    check(allTasks.length === 1, 'includeCompleted reveals completed tasks');

    // -----------------------------------------------------------------------
    // Context Orchestrator (fixed order + layered hashes)
    // -----------------------------------------------------------------------
    const orchestrator = new ContextOrchestrator();
    const assembled = orchestrator.assemble({
      generalPrompt: 'GENERAL',
      responseProtocol: 'PROTOCOL',
      baseToolDefinitions: [{ name: 'tool-a' }],
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
      currentUserInput: 'USER INPUT',
    });
    check(assembled.sections.length === CONTEXT_SECTION_ORDER.length, 'all 18 sections are assembled in the fixed order');
    const order = assembled.sections.map(section => section.name);
    check(JSON.stringify(order) === JSON.stringify(CONTEXT_SECTION_ORDER), 'section order matches the fixed CONTEXT_SECTION_ORDER');
    check(assembled.text.includes('USER INPUT'), 'current user input appears in the assembled text');
    check(assembled.sections[17].name === 'current_user_input', 'current user input is the last section');
    check(typeof assembled.hashes.stablePrefixHash === 'string' && assembled.hashes.stablePrefixHash.length === 64, 'stable prefix hash computed');

    // stable prefix must not change when only the dynamic tail changes
    const assembled2 = orchestrator.assemble({
      generalPrompt: 'GENERAL',
      responseProtocol: 'PROTOCOL',
      baseToolDefinitions: [{ name: 'tool-a' }],
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
      currentUserInput: 'DIFFERENT USER INPUT',
    });
    check(assembled.hashes.stablePrefixHash === assembled2.hashes.stablePrefixHash, 'stablePrefixHash is invariant to the user input (dynamic tail)');
    check(assembled.hashes.dynamicContextHash !== assembled2.hashes.dynamicContextHash, 'dynamicContextHash changes with the user input');
    check(assembled.hashes.fullRequestHash !== assembled2.hashes.fullRequestHash, 'fullRequestHash changes with the user input');

    // -----------------------------------------------------------------------
    // Context Budget Service (snapshot + verification)
    // -----------------------------------------------------------------------
    const budget = new ContextBudgetService();
    const snapshot = budget.snapshot({
      conversationId: 'conv-1',
      branchId: 'branch-1',
      buildBlockId: 'block-1',
      agentId: 'agent-1',
      agentType: 'main',
      provider: 'fixture',
      model: 'fixture-model',
      modelContextLimit: 128000,
      assembled,
      toolPayloadBytes: 1000,
    });
    check(snapshot.snapshotId.startsWith('snapshot-'), 'snapshot carries an id');
    check(snapshot.contextContentHash === assembled.contentHash, 'snapshot content hash equals the assembled context hash');
    check(budget.verify(snapshot, assembled) === true, 'budget.verify accepts a matching snapshot');
    check(snapshot.modelContextLimit === 128000, 'model context limit recorded');
    check(snapshot.remainingInputTokens >= 0, 'remaining input tokens is non-negative');
    check(snapshot.sections.length === 18, 'snapshot has per-section usage');
    check(snapshot.usageRatio > 0 && snapshot.usageRatio < 1, 'usage ratio within (0,1)');

    // -----------------------------------------------------------------------
    // Tool Result lifecycle
    // -----------------------------------------------------------------------
    const toolResults = new ToolResultService(root);
    const small = toolResults.store({
      callId: 'call-1',
      toolId: 'file.read',
      capabilityId: 'filesystem.read',
      buildBlockId: 'block-1',
      conversationId: 'conv-1',
      lifecycle: 'build_scoped',
      status: 'ok',
      summary: 'File contents',
      rawOutput: 'short output',
      operationId: 'tr-op-1',
    });
    check(small.artifactWritten === false && small.truncated === false, 'small tool result stays inline');
    check(small.record.contentHash.length === 64, 'tool result carries a content hash');

    const large = toolResults.store({
      callId: 'call-2',
      toolId: 'terminal.exec',
      capabilityId: 'terminal.execute',
      buildBlockId: 'block-1',
      conversationId: 'conv-1',
      lifecycle: 'build_scoped',
      status: 'ok',
      summary: 'Large command output truncated',
      rawOutput: 'x'.repeat(20000),
      operationId: 'tr-op-2',
    });
    check(large.artifactWritten === true && large.record.artifactPaths.length === 1, 'large tool output is spilled to an artifact');
    check(fs.existsSync(large.record.artifactPaths[0]), 'artifact file exists on disk');
    check(large.record.rawOutput === undefined, 'build_scoped record does not retain raw output inline');

    const ephemeral = toolResults.store({
      callId: 'call-3',
      toolId: 'web.fetch',
      capabilityId: 'web.public',
      conversationId: 'conv-1',
      lifecycle: 'ephemeral',
      status: 'ok',
      summary: 'web result',
      rawOutput: 'raw web content',
      operationId: 'tr-op-3',
    });
    check(ephemeral.record.rawOutput === 'raw web content', 'ephemeral record retains raw output');
    const found = toolResults.find('conv-1', 'call-2');
    check(!!found && found.artifactPaths.length === 1, 'tool result is findable by callId');
    const resultsBlock = toolResults.buildContextBlock('conv-1');
    check(resultsBlock.includes('Current Tool Results') && resultsBlock.includes('terminal.exec'), 'tool results context block is compact');

    // -----------------------------------------------------------------------
    // AgentContextManager facade
    // -----------------------------------------------------------------------
    const manager = new AgentContextManager(root);
    check(manager.flags.structuredContextV2 === false, 'all context flags default to disabled');
    check(manager.orchestrator instanceof ContextOrchestrator, 'orchestrator facade available');
    const managerSnapshot = manager.snapshot({
      conversationId: 'conv-1',
      branchId: 'branch-1',
      buildBlockId: 'block-1',
      agentId: 'agent-1',
      agentType: 'main',
      provider: 'fixture',
      model: 'm',
      modelContextLimit: 128000,
      assembledText: assembled.text,
      sections: assembled.sections.map(section => ({ name: section.name, order: section.order, content: section.content })),
      contextContentHash: assembled.contentHash,
    });
    check(managerSnapshot.contextContentHash === assembled.contentHash, 'facade snapshot binds to the assembled content hash');

    // hashing utility sanity
    check(sha256({ a: 1, b: 2 }) === sha256({ b: 2, a: 1 }), 'sha256 is key-order independent');

    console.log('contextSystemV2Verify: all assertions passed');
  } finally {
    cleanup(root);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
