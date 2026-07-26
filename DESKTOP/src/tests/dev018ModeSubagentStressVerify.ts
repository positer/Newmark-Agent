import * as assert from 'assert';
import { SubagentExecutionJob, SubagentManager, SubagentState } from '../core/subagent';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const waitUntil = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Stress condition timed out after ${timeoutMs} ms`);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
};

async function restoredMailboxStress(): Promise<void> {
  const seed = new SubagentManager({ conversationId: 'dev018-restored-mailbox', concurrency: 8 });
  seed.pauseScheduling();
  const ids = Array.from({ length: 64 }, (_, index) => {
    const modes = ['build', 'plan', 'goal', 'flow'] as const;
    const mode = modes[index % modes.length];
    const id = seed.create(
      `restore-${index}`,
      `initial-${index}`,
      'stress-model',
      index % 2 ? 'next' : 'guide',
      mode,
      seed.rootAgentId,
      mode === 'flow' ? `flow-${index}` : '',
      mode === 'goal' ? `goal-${index}` : '',
      mode === 'flow' ? index : 0,
    );
    const delivery = seed.sendMessage(seed.rootAgentId, id, `RESTORE_TOKEN_${index}`);
    assert.strictEqual(delivery.ok, true);
    return id;
  });
  const saved = seed.serialize();

  let active = 0;
  let maxActive = 0;
  const prompts = new Map<string, string>();
  const restored = new SubagentManager({
    conversationId: 'dev018-restored-mailbox',
    concurrency: 8,
    state: saved,
    executor: async (job: SubagentExecutionJob) => {
      active++;
      maxActive = Math.max(maxActive, active);
      prompts.set(job.record.id, job.prompt);
      await new Promise<void>(resolve => setTimeout(resolve, parseInt(job.record.shortId.slice(0, 2), 16) % 4));
      active--;
      if (job.record.natureSlug.endsWith('-17') || job.record.natureSlug.endsWith('-43')) {
        throw new Error(`isolated-${job.record.natureSlug}`);
      }
      return `completed:${job.record.agentMode}:${job.record.inputMode}`;
    },
  });
  restored.resumeScheduling();
  await waitUntil(() => restored.listAll().every(record => ['completed', 'error'].includes(record.status)));

  assert.ok(maxActive > 1, 'stress run should exercise real concurrency');
  assert.ok(maxActive <= 8, `concurrency exceeded configured cap: ${maxActive}`);
  assert.strictEqual(restored.listAll().filter(record => record.status === 'error').length, 2);
  assert.strictEqual(new Set(restored.listAll().map(record => record.id)).size, 64);
  for (let index = 0; index < ids.length; index++) {
    const record = restored.get(ids[index]);
    const prompt = prompts.get(ids[index]) || '';
    const token = `RESTORE_TOKEN_${index}`;
    assert.ok(record, `missing restored peer ${index}`);
    assert.strictEqual(prompt.split(token).length - 1, 1, `restored mailbox directive duplicated for peer ${index}`);
    assert.strictEqual(record!.agentMode, (['build', 'plan', 'goal', 'flow'] as const)[index % 4]);
    assert.strictEqual(record!.inputMode, index % 2 ? 'next' : 'guide');
    if (record!.agentMode === 'goal') assert.strictEqual(record!.goalObjective, `goal-${index}`);
    if (record!.agentMode === 'flow') {
      assert.strictEqual(record!.flowName, `flow-${index}`);
      assert.strictEqual(record!.flowPc, index);
    }
  }
}

async function lateExecutorBindingStress(): Promise<void> {
  const starts = new Map<string, number>();
  const manager = new SubagentManager({ conversationId: 'dev018-late-executor', concurrency: 4 });
  const ids = Array.from({ length: 48 }, (_, index) => manager.create(`late-${index}`, `late-prompt-${index}`));
  assert.ok(ids.every(id => manager.get(id)?.status === 'queued'), 'unbound peers must remain queued, never fake working');
  const saved = manager.serialize();
  assert.strictEqual(saved.records.filter(record => record.status === 'queued').length, 48);

  manager.bind({
    executor: async job => {
      starts.set(job.record.id, (starts.get(job.record.id) || 0) + 1);
      await tick();
      return `late-complete:${job.record.shortId}`;
    },
  });
  await waitUntil(() => manager.listAll().every(record => record.status === 'completed'));
  assert.ok(ids.every(id => starts.get(id) === 1), 'late executor binding must start every durable peer exactly once');
}

async function queueCloseAndFailureIsolationStress(): Promise<void> {
  const releases: Array<() => void> = [];
  const executed = new Set<string>();
  const manager = new SubagentManager({
    conversationId: 'dev018-close-isolation',
    concurrency: 4,
    executor: async job => {
      executed.add(job.record.id);
      await new Promise<void>(resolve => releases.push(resolve));
      if (job.record.natureSlug.includes('failure')) throw new Error('planned isolated failure');
      return `done:${job.record.natureSlug}`;
    },
  });
  const running = Array.from({ length: 4 }, (_, index) => manager.create(`running-${index}`, `run-${index}`));
  const failures = Array.from({ length: 4 }, (_, index) => manager.create(`failure-${index}`, `fail-${index}`));
  const closed = Array.from({ length: 24 }, (_, index) => manager.create(`closed-${index}`, `close-${index}`));
  await tick();
  for (const id of closed) assert.strictEqual(manager.close(id, manager.rootAgentId), true);
  while (releases.length || manager.listAll().some(record => ['queued', 'working'].includes(record.status))) {
    const release = releases.shift();
    if (release) release();
    await tick();
  }
  assert.ok(running.every(id => manager.get(id)?.status === 'completed'));
  assert.ok(failures.every(id => manager.get(id)?.status === 'error'));
  assert.ok(closed.every(id => manager.get(id)?.status === 'closed'));
  assert.ok(closed.every(id => !executed.has(id)), 'closed queued peers must never execute');
}

function rootInboxStress(): void {
  const manager = new SubagentManager({ conversationId: 'dev018-root-inbox' });
  const ids: string[] = [];
  for (let index = 0; index < 256; index++) {
    const delivery = manager.sendRootMessage(`peer-${index}`, `root-result-${index}`, index % 2 ? 'handoff' : 'result');
    assert.strictEqual(delivery.ok, true);
    ids.push(delivery.message!.id);
  }
  const inbox = manager.readRootInbox();
  assert.strictEqual(inbox.length, 256);
  assert.strictEqual(new Set(inbox.map(message => message.id)).size, 256);
  assert.deepStrictEqual(inbox.map(message => message.sequence), [...inbox].map(message => message.sequence).sort((a, b) => a - b));
  ids.forEach((id, index) => {
    if (index % 2 === 0) assert.strictEqual(manager.acknowledgeRootInbox(id), true);
  });
  const saved: SubagentState = manager.serialize();
  const restored = new SubagentManager({ conversationId: 'dev018-root-inbox', state: saved });
  assert.strictEqual(restored.readRootInbox().length, 128);
  assert.ok(restored.readRootInbox().every(message => Number(message.body.replace('root-result-', '')) % 2 === 1));
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await restoredMailboxStress();
  await lateExecutorBindingStress();
  await queueCloseAndFailureIsolationStress();
  rootInboxStress();
  console.log(JSON.stringify({
    ok: true,
    suite: 'dev-0.1.8 mode and SubAgent stress',
    scenarios: 4,
    restoredPeers: 64,
    lateBoundPeers: 48,
    closedQueuedPeers: 24,
    rootInboxMessages: 256,
    elapsedMs: Date.now() - startedAt,
  }));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
