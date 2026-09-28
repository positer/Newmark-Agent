import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../core/config';
import { FileWriteObservationGate } from '../core/fileWriteObservation';
import { ToolExecutionContext, ToolExecutor } from '../tools';

let assertions = 0;

function check(condition: unknown, message: string): void {
  assertions += 1;
  assert.ok(condition, message);
}

async function verifyToolBoundary(root: string): Promise<void> {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const config = new ConfigManager(path.join(root, 'config'));
  config.set('workspace', 'access_permission', 'full_access');
  const tools = new ToolExecutor(workspace, config);
  const context: ToolExecutionContext = {
    mode: 'build',
    invocation: 'cli',
    runtimeKey: 'write-gate-stress-runtime',
    runId: 'write-gate-stress-run-a',
    workspaceId: 'write-gate-stress-workspace',
    workspacePath: workspace,
    conversationId: 'write-gate-stress-conversation-a',
    actorId: 'write-gate-stress-actor',
    backend: process.platform,
  };
  const call = (name: string, args: Record<string, unknown>, callContext = context): Promise<string> =>
    tools.execute(name, JSON.stringify(args), workspace, callContext);

  const existing = path.join(workspace, 'existing.txt');
  fs.writeFileSync(existing, 'old value\n', 'utf8');
  const noObservation = await call('write', { path: existing, content: 'must stay old\n' });
  check(noObservation.includes('[write gate blocked]') && fs.readFileSync(existing, 'utf8') === 'old value\n',
    'write tool refuses an existing target without a model-visible read');
  const observed = await call('read', { path: existing });
  check(observed.includes('old value') && observed.includes('[write gate]'), 'read tool returns content and a write observation');
  const overwritten = await call('write', { path: existing, content: 'new value\n' });
  check(overwritten.includes('[write] OK') && fs.readFileSync(existing, 'utf8') === 'new value\n',
    'write succeeds once after a complete exact-target read');
  const replay = await call('write', { path: existing, content: 'replay must fail\n' });
  check(replay.includes('[write gate blocked]') && fs.readFileSync(existing, 'utf8') === 'new value\n',
    'successful write consumes its one-use observation');

  const scoped = path.join(workspace, 'scope.txt');
  fs.writeFileSync(scoped, 'scope-bound\n', 'utf8');
  const scopeA = { ...context, conversationId: 'scope-a', runId: 'scope-run-a' };
  const scopeB = { ...context, conversationId: 'scope-b', runId: 'scope-run-b' };
  await call('read', { path: scoped }, scopeA);
  const crossedScope = await call('write', { path: scoped, content: 'cross-scope\n' }, scopeB);
  check(crossedScope.includes('[write gate blocked]') && fs.readFileSync(scoped, 'utf8') === 'scope-bound\n',
    'a read receipt cannot authorize another conversation or run');
  const originalScopeWrite = await call('write', { path: scoped, content: 'scope-a-write\n' }, scopeA);
  check(originalScopeWrite.includes('[write] OK'), 'a denied cross-scope attempt leaves the original receipt intact');

  const nested = path.join(workspace, 'new-parent', 'nested.txt');
  const absent = await call('read', { path: nested });
  check(absent.includes('Exact-path absence observed'), 'new-file creation starts with exact-path absence');
  const created = await call('write', { path: nested, content: 'nested creation\n' });
  check(created.includes('[write] OK') && fs.readFileSync(nested, 'utf8') === 'nested creation\n',
    'observed absence permits exclusive creation in a new parent path');

  const racedNew = path.join(workspace, 'race-new.txt');
  await call('read', { path: racedNew });
  fs.writeFileSync(racedNew, 'external winner\n', 'utf8');
  const lostCreationRace = await call('write', { path: racedNew, content: 'must not overwrite\n' });
  check(lostCreationRace.includes('[write gate blocked]') && fs.readFileSync(racedNew, 'utf8') === 'external winner\n',
    'creation refuses a target that appeared after the absence observation');

  const ranged = path.join(workspace, 'ranged.txt');
  fs.writeFileSync(ranged, 'line 1\nline 2\nline 3\nline 4\n', 'utf8');
  const partial = await call('read', { path: ranged, start_line: 2, end_line: 3 });
  check(partial.includes('line 2') && partial.includes('line 3'), 'bounded read returns the requested target lines');
  const partialOverwrite = await call('write', { path: ranged, content: 'partial must not replace full file\n' });
  check(partialOverwrite.includes('[write gate blocked]'), 'partial coverage cannot authorize full overwrite');
  await call('read', { path: ranged, start_line: 1, end_line: 2 });
  await call('read', { path: ranged, start_line: 3, end_line: 4 });
  const fullAfterRanges = await call('write', { path: ranged, content: 'full range coverage\n' });
  check(fullAfterRanges.includes('[write] OK') && fs.readFileSync(ranged, 'utf8') === 'full range coverage\n',
    'disjoint read ranges accumulate to full-file authorization');

  const editTarget = path.join(workspace, 'edit.txt');
  fs.writeFileSync(editTarget, 'top\nunique phrase\nbottom\n', 'utf8');
  await call('read', { path: editTarget, start_line: 2, end_line: 2 });
  const edit = await call('edit', { path: editTarget, old_str: 'unique phrase', new_str: 'updated phrase' });
  check(edit.includes('[edit] OK') && fs.readFileSync(editTarget, 'utf8').includes('updated phrase'),
    'edit is allowed when old_str is in the observed range');
  const duplicateTarget = path.join(workspace, 'duplicate.txt');
  fs.writeFileSync(duplicateTarget, 'same same\n', 'utf8');
  await call('read', { path: duplicateTarget });
  const ambiguousEdit = await call('edit', { path: duplicateTarget, old_str: 'same', new_str: 'changed' });
  check(ambiguousEdit.includes('more than one position') && fs.readFileSync(duplicateTarget, 'utf8') === 'same same\n',
    'ambiguous edit refuses to choose one of multiple matches');

  const stale = path.join(workspace, 'stale.txt');
  fs.writeFileSync(stale, 'read version\n', 'utf8');
  await call('read', { path: stale });
  fs.writeFileSync(stale, 'external newer version\n', 'utf8');
  const staleWrite = await call('write', { path: stale, content: 'stale overwrite\n' });
  check(staleWrite.includes('[write gate blocked]') && fs.readFileSync(stale, 'utf8') === 'external newer version\n',
    'stale content fingerprint refuses mutation and preserves the newer target');

  const deleteTarget = path.join(workspace, 'delete.txt');
  fs.writeFileSync(deleteTarget, 'read before delete\n', 'utf8');
  const unobservedDelete = await call('delete_file', { path: deleteTarget });
  check(unobservedDelete.includes('[write gate blocked]') && fs.existsSync(deleteTarget),
    'delete tool refuses without a complete exact-target read');
  await call('read', { path: deleteTarget });
  const deleted = await call('delete_file', { path: deleteTarget });
  check(deleted.includes('[delete_file] OK') && !fs.existsSync(deleteTarget), 'delete succeeds after full read');

  const oversized = path.join(workspace, 'oversized.txt');
  fs.writeFileSync(oversized, 'x'.repeat(20_001), 'utf8');
  const truncatedRead = await call('read', { path: oversized });
  const truncatedWrite = await call('write', { path: oversized, content: 'must not replace unseen tail' });
  check(truncatedRead.includes('[truncated]') && truncatedWrite.includes('[write gate blocked]'),
    'truncated read output never grants full-file overwrite');

  const directoryDelete = await call('delete_file', { path: workspace });
  check(directoryDelete.includes('Refused') && fs.existsSync(existing), 'directory deletion keeps its explicit refusal');

  if (process.platform === 'win32') {
    const priorGuard = process.env.NEWMARK_TEST_CU_OBSERVE_ONLY;
    process.env.NEWMARK_TEST_CU_OBSERVE_ONLY = '1';
    try {
      const blockedAction = await call('computer_use', { action: 'click', x: 10, y: 10 });
      check(blockedAction.includes('[computer_use test guard]'), 'real-model CU test guard blocks desktop input before host dispatch');
    } finally {
      if (priorGuard === undefined) delete process.env.NEWMARK_TEST_CU_OBSERVE_ONLY;
      else process.env.NEWMARK_TEST_CU_OBSERVE_ONLY = priorGuard;
    }
  }
}

async function verifyBoundedRangeLedger(root: string): Promise<void> {
  const target = path.join(root, 'range-cap.txt');
  fs.writeFileSync(target, Array.from({ length: 129 }, (_, index) => `line-${index + 1}`).join('\n') + '\n', 'utf8');
  const gate = new FileWriteObservationGate();
  const scope = 'bounded-range-ledger';
  for (let line = 1; line <= 128; line += 1) {
    const output = await gate.read(target, scope, { startLine: line, endLine: line });
    check(!output.startsWith('[read blocked]'), `range ${line} fits the bounded observation ledger`);
  }
  const overflow = await gate.read(target, scope, { startLine: 129, endLine: 129 });
  check(overflow.includes('ledger reached its bounded range capacity'), 'the 129th distinct read range is refused');
  const denied = await gate.mutate(target, scope, { kind: 'full' }, () => ({ value: true, committed: false }));
  check(!denied.ok && denied.error.includes('complete file has not been read'), 'bounded range overflow cannot grant full-file mutation');
}

async function verifyReceiptExpiry(root: string): Promise<void> {
  const target = path.join(root, 'expired-receipt.txt');
  fs.writeFileSync(target, 'fresh baseline\n', 'utf8');
  const gate = new FileWriteObservationGate();
  const scope = 'expired-receipt-scope';
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    const read = await gate.read(target, scope);
    check(read.includes('fresh baseline'), 'expiry fixture records a successful exact-target read');
    now += 5 * 60 * 1000 + 1;
    const expiredWrite = await gate.mutate(target, scope, { kind: 'full' }, () => ({ value: true, committed: true }));
    check(!expiredWrite.ok && fs.readFileSync(target, 'utf8') === 'fresh baseline\n',
      'an observation older than five minutes cannot authorize a mutation');
  } finally {
    Date.now = originalNow;
  }
}

async function verifyConcurrentToolExecutorWrites(root: string): Promise<void> {
  const workspace = path.join(root, 'tool-executor-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, 'contended.txt');
  fs.writeFileSync(target, 'shared baseline\n', 'utf8');
  const config = new ConfigManager(path.join(root, 'tool-executor-config'));
  config.set('workspace', 'access_permission', 'full_access');
  const contenders = Array.from({ length: 32 }, (_, index) => ({
    tools: new ToolExecutor(workspace, config),
    index,
    context: {
      mode: 'build',
      invocation: 'cli' as const,
      runtimeKey: 'write-gate-executor-stress',
      runId: `tool-executor-run-${index}`,
      workspaceId: 'write-gate-executor-stress-workspace',
      workspacePath: workspace,
      conversationId: `tool-executor-conversation-${index}`,
      actorId: `tool-executor-actor-${index}`,
      backend: process.platform,
    } satisfies ToolExecutionContext,
  }));
  const reads = await Promise.all(contenders.map(contender => contender.tools.execute(
    'read', JSON.stringify({ path: target }), workspace, contender.context,
  )));
  check(reads.length === 32 && reads.every(result => result.includes('shared baseline')),
    '32 independent ToolExecutor instances each observe the same initial target');

  const writes = await Promise.all(contenders.map(contender => contender.tools.execute(
    'write', JSON.stringify({ path: target, content: `tool-winner-${contender.index}\n` }), workspace, contender.context,
  )));
  const successful = writes.flatMap((result, index) => result.includes('[write] OK') ? [index] : []);
  check(successful.length === 1, 'exactly one of 32 concurrent ToolExecutor writes commits');
  check(writes.filter(result => result.includes('[write gate blocked]')).length === 31,
    'the other ToolExecutor writes are refused after the observed target changes');
  check(fs.readFileSync(target, 'utf8') === `tool-winner-${successful[0]}\n`,
    'the final target contains the sole successful ToolExecutor write');
}

async function verifyGateLockSerialization(root: string): Promise<void> {
  const target = path.join(root, 'contended.txt');
  fs.writeFileSync(target, 'shared baseline\n', 'utf8');
  const contenders = Array.from({ length: 32 }, (_, index) => ({ gate: new FileWriteObservationGate(), index, scope: `writer-${index}` }));
  await Promise.all(contenders.map(async contender => {
    const read = await contender.gate.read(target, contender.scope);
    check(read.includes('shared baseline'), `contender ${contender.index} observes the same initial target`);
  }));

  let activeMutations = 0;
  let maximumConcurrentMutations = 0;
  const committed: number[] = [];
  const results = await Promise.allSettled(contenders.map(contender => contender.gate.mutate(
    target,
    contender.scope,
    { kind: 'full' },
    async observed => {
      activeMutations += 1;
      maximumConcurrentMutations = Math.max(maximumConcurrentMutations, activeMutations);
      try {
        await new Promise(resolve => setTimeout(resolve, 4));
        observed.assertBeforeCommit();
        fs.writeFileSync(target, `winner-${contender.index}\n`, 'utf8');
        committed.push(contender.index);
        return { value: contender.index, committed: true };
      } finally {
        activeMutations -= 1;
      }
    },
  )));
  let successfulMutations = 0;
  for (const result of results) {
    check(result.status === 'fulfilled', 'contended mutation settles without a rejected promise');
    if (result.status === 'fulfilled' && result.value.ok) successfulMutations += 1;
  }
  check(committed.length === 1, 'exactly one of 32 concurrent authorized writes commits');
  check(maximumConcurrentMutations === 1, 'path mutation callbacks never overlap across gate instances');
  check(successfulMutations === 1, 'all later writers fail stale observation revalidation');
  check(fs.readFileSync(target, 'utf8') === `winner-${committed[0]}\n`, 'final file contains only the serialized winner');
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-file-write-gate-stress-'));
  try {
    await verifyToolBoundary(root);
    await verifyBoundedRangeLedger(root);
    await verifyReceiptExpiry(root);
    await verifyConcurrentToolExecutorWrites(root);
    await verifyGateLockSerialization(root);
    console.log(`FILE_WRITE_OBSERVATION_STRESS_OK assertions=${assertions} toolExecutors=32 gateCallbacks=32`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
