import * as assert from 'assert';
import { SubagentExecutionJob, SubagentManager, SubagentState } from '../core/subagent';

const flush = async (): Promise<void> => {
  for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve));
};
const occurrences = (text: string, token: string): number => text.split(token).length - 1;

function harness(concurrency = 4, state?: SubagentState) {
  const jobs: SubagentExecutionJob[] = [];
  const gates = new Map<number, { resolve: (result: string) => void; reject: (error: Error) => void }>();
  const activeByPeer = new Map<string, number>();
  let active = 0;
  let maxActive = 0;
  let maxPerPeer = 0;
  const persisted: SubagentState[] = [];
  const manager = new SubagentManager({
    conversationId: 'mailbox-concurrency-verification', concurrency, state,
    persist: snapshot => persisted.push(JSON.parse(JSON.stringify(snapshot)) as SubagentState),
    executor: async job => {
      const index = jobs.push(job) - 1;
      active++;
      activeByPeer.set(job.record.id, (activeByPeer.get(job.record.id) || 0) + 1);
      maxActive = Math.max(maxActive, active);
      maxPerPeer = Math.max(maxPerPeer, activeByPeer.get(job.record.id)!);
      try {
        return await new Promise<string>((resolve, reject) => gates.set(index, { resolve, reject }));
      } finally {
        active--;
        activeByPeer.set(job.record.id, activeByPeer.get(job.record.id)! - 1);
      }
    },
  });
  const release = (index: number, fail = false) => {
    const gate = gates.get(index);
    assert.ok(gate, `missing execution gate ${index}`);
    gates.delete(index);
    if (fail) gate!.reject(new Error(`planned failure ${index}`));
    else gate!.resolve(`completed ${index}`);
  };
  const drain = async () => {
    for (let round = 0; round < 1024; round++) {
      for (const index of [...gates.keys()]) release(index);
      await flush();
      if (!manager.hasPendingWork()) return;
    }
    throw new Error('deterministic scheduler did not drain');
  };
  return { manager, jobs, gates, persisted, release, drain, metrics: () => ({ active, maxActive, maxPerPeer }) };
}

async function completedAndFailedWake(): Promise<void> {
  const h = harness(1);
  const id = h.manager.create('completed-wake', 'initial work');
  for (let iteration = 0; iteration < 24; iteration++) {
    h.release(iteration, iteration % 3 === 0);
    await flush();
    const token = `SETTLED_MAIL_${iteration}_END`;
    assert.ok(h.manager.sendMessage('peer-source', id, token, 'directive', {}, true).ok);
    await flush();
    assert.strictEqual(occurrences(h.jobs[iteration + 1].prompt, token), 1, 'a settled peer receives each directive once');
  }
  await h.drain();
}

async function workingBurst(): Promise<void> {
  const h = harness(4);
  const id = h.manager.create('working-burst', 'initial work');
  const tokens = Array.from({ length: 64 }, (_, index) => `WORKING_MAIL_${index}_END`);
  for (const token of tokens) assert.ok(h.manager.sendMessage('peer-source', id, token).ok);
  assert.strictEqual(h.jobs.length, 1, 'mail to a running peer must not start a second executor');
  h.release(0);
  await flush();
  assert.strictEqual(h.jobs.length, 2);
  for (const token of tokens) assert.strictEqual(occurrences(h.jobs[1].prompt, token), 1, 'burst delivery must be exactly once');
  assert.ok(tokens.every((token, index) => !index || h.jobs[1].prompt.indexOf(tokens[index - 1]) < h.jobs[1].prompt.indexOf(token)), 'mailbox preserves send order');
  await h.drain();
}

async function coldUnreadRecovery(): Promise<void> {
  const seed = harness(1);
  const id = seed.manager.create('cold-peer', 'ORIGINAL_ALREADY_FINISHED');
  seed.release(0);
  await flush();
  seed.manager.pauseScheduling();
  seed.manager.sendMessage('peer-source', id, 'COLD_UNREAD_DIRECTIVE', 'directive', {}, true);
  // A durable send writes the unread item before its wake job is enqueued.
  const accepted = seed.persisted.slice().reverse().find(snapshot => snapshot.records[0]?.status === 'completed' && snapshot.mailbox.length === 1)!;
  assert.ok(accepted, 'capture the accepted mailbox before wake enqueue');
  const h = harness(1, accepted);
  h.manager.resumeScheduling();
  await flush();
  assert.strictEqual(occurrences(h.jobs[0].prompt, 'COLD_UNREAD_DIRECTIVE'), 1, 'cold unread delivery must occur once');
  assert.strictEqual(occurrences(h.jobs[0].prompt, 'ORIGINAL_ALREADY_FINISHED'), 0, 'cold mailbox wake must not redo the original task');
  await h.drain();
}

async function dispatchedMailboxRecovery(): Promise<void> {
  const h = harness(1);
  const id = h.manager.create('dispatch-peer', 'ORIGINAL_COMPLETED');
  h.release(0);
  await flush();
  h.manager.sendMessage('peer-source', id, 'DURABLE_DISPATCH_DIRECTIVE', 'directive', {}, true);
  await flush();
  const acknowledged = h.persisted.slice().reverse().find(snapshot => snapshot.mailbox[0]?.readAt)!;
  assert.ok(acknowledged, 'scheduler acknowledges a dispatched mailbox');
  const restart = harness(1, acknowledged);
  await flush();
  assert.strictEqual(occurrences(restart.jobs[0]?.prompt || '', 'DURABLE_DISPATCH_DIRECTIVE'), 1, 'acknowledged mailbox survives restart before child context persistence');
  assert.strictEqual(occurrences(restart.jobs[0].prompt, 'ORIGINAL_COMPLETED'), 0);
  await h.drain();
  await restart.drain();
}

async function directSendSerializesSamePeer(): Promise<void> {
  const h = harness(16);
  const id = h.manager.create('legacy-send-peer', 'initial work');
  assert.ok(h.manager.send(id, 'LEGACY_CONTINUATION_ONE'));
  assert.ok(h.manager.send(id, 'LEGACY_CONTINUATION_TWO'));
  assert.strictEqual(h.jobs.length, 1, 'legacy send must not overlap a running peer');
  await h.drain();
  assert.strictEqual(h.metrics().maxPerPeer, 1);
  for (const token of ['LEGACY_CONTINUATION_ONE', 'LEGACY_CONTINUATION_TWO']) {
    assert.strictEqual(occurrences(h.jobs.slice(1).map(job => job.prompt).join('\n'), token), 1, 'legacy continuations survive settlement');
  }
}

async function queueFairnessAndTierLimits(): Promise<void> {
  for (const cap of [4, 16]) {
    const h = harness(cap);
    const ids = Array.from({ length: 128 }, (_, index) => h.manager.create(`fifo-${index}`, `task-${index}`));
    assert.strictEqual(h.metrics().active, cap);
    for (let index = 0; index < ids.length; index++) h.manager.sendMessage('peer-source', ids[index], `FIFO_MAIL_${index}_END`);
    await h.drain();
    assert.deepStrictEqual(h.jobs.slice(0, ids.length).map(job => job.record.id), ids, 'mail continuations must not bypass already queued peers');
    assert.strictEqual(h.metrics().maxActive, cap);
    assert.strictEqual(h.metrics().maxPerPeer, 1);
    for (let index = 0; index < ids.length; index++) {
      const prompt = h.jobs.filter(job => job.record.id === ids[index]).map(job => job.prompt).join('\n');
      assert.strictEqual(occurrences(prompt, `FIFO_MAIL_${index}_END`), 1, 'every queued and running target gets exactly one directive');
    }
  }
}

async function pauseRestoreAndLowerLimit(): Promise<void> {
  const h = harness(16);
  const ids = Array.from({ length: 80 }, (_, index) => h.manager.create(`pause-${index}`, `pause-task-${index}`));
  h.manager.pauseScheduling();
  for (const id of ids) h.manager.sendMessage('peer-source', id, `PAUSE_MAIL_${id}`);
  for (const index of [...h.gates.keys()]) h.release(index);
  await flush();
  assert.strictEqual(h.jobs.length, 16, 'stop gate prevents queued and mailbox work from starting');
  const restarted = harness(16, JSON.parse(JSON.stringify(h.manager.serialize())) as SubagentState);
  await flush();
  assert.strictEqual(restarted.jobs.length, 0, 'paused scheduling survives cold restore');
  restarted.manager.setConcurrencyLimit(4);
  assert.strictEqual(restarted.jobs.length, 0, 'changing tier cannot bypass the stop gate');
  restarted.manager.resumeScheduling();
  assert.strictEqual(restarted.metrics().active, 4);
  await restarted.drain();
  assert.strictEqual(restarted.metrics().maxActive, 4);
  for (const id of ids) {
    const prompt = restarted.jobs.filter(job => job.record.id === id).map(job => job.prompt).join('\n');
    assert.strictEqual(occurrences(prompt, `PAUSE_MAIL_${id}`), 1, 'stop and restore preserve all mailbox work once');
  }
}

async function liveAcknowledgementAndFailure(): Promise<void> {
  const h = harness(16);
  const received: string[] = [];
  h.manager.bind({ onMailboxMessage: message => {
    received.push(message.body);
    return h.manager.acknowledgeMailbox(message.toAgentId, message.id);
  } });
  const ids = Array.from({ length: 16 }, (_, index) => h.manager.create(`live-${index}`, `task-${index}`));
  for (let round = 0; round < 32; round++) {
    for (const id of ids) h.manager.sendMessage('live-source', id, `LIVE_${round}_${id}`);
  }
  assert.strictEqual(received.length, 512);
  assert.strictEqual(new Set(received).size, 512);
  for (const index of [...h.gates.keys()]) h.release(index, index % 3 === 0);
  await flush();
  assert.strictEqual(h.jobs.length, 16, 'acknowledged live messages never trigger a replay job');
  assert.ok(!h.manager.hasPendingWork());
}

async function synchronousExecutorFailure(): Promise<void> {
  const starts: string[] = [];
  const manager = new SubagentManager();
  const failing = manager.create('sync-failure', 'sync failure');
  const healthy = manager.create('healthy', 'healthy');
  manager.bind({ concurrency: 1, executor: job => {
    starts.push(job.record.id);
    if (job.record.id === failing) throw new Error('synchronous executor failure');
    return Promise.resolve('healthy completion');
  } });
  await flush();
  assert.deepStrictEqual(starts, [failing, healthy], 'synchronous executor failure must release its slot');
  assert.strictEqual(manager.get(failing)?.status, 'error');
  assert.strictEqual(manager.get(healthy)?.status, 'completed');
}

async function serializedContextIsolation(): Promise<void> {
  const manager = new SubagentManager();
  const id = manager.create('context-isolation', 'initial work');
  manager.replaceContext(id, [{ role: 'assistant', content: '', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read', arguments: '{"path":"original"}' } }] }], null);
  manager.get(id)!.metadata = { cachedPrefix: { fingerprint: 'original-fingerprint' } };
  const snapshot = manager.serialize();
  snapshot.records[0].messages[0].tool_calls![0].function.arguments = '{"path":"mutated"}';
  (snapshot.records[0].metadata!.cachedPrefix as { fingerprint: string }).fingerprint = 'mutated-fingerprint';
  assert.strictEqual(manager.get(id)!.messages[0].tool_calls![0].function.arguments, '{"path":"original"}', 'snapshot editing cannot rewrite a peer tool prefix');
  assert.strictEqual((manager.get(id)!.metadata!.cachedPrefix as { fingerprint: string }).fingerprint, 'original-fingerprint');
  const requestCache = { system: 'stable-system-prefix', tools: [{ name: 'read' }] };
  manager.patchMetadata(id, { requestCache });
  requestCache.tools[0].name = 'caller-mutated';
  assert.strictEqual(((manager.get(id)!.metadata!.requestCache as typeof requestCache).tools[0].name), 'read', 'metadata updates retain their own durable cache snapshot');
  assert.ok(manager.get(id)!.metadata!.cachedPrefix, 'metadata patch preserves unrelated metadata');
}

async function queuedDurabilityAndSelfAliases(): Promise<void> {
  const persisted: SubagentState[] = [];
  const manager = new SubagentManager({ persist: state => persisted.push(state) });
  const id = manager.create('durable-queued-peer', 'QUEUED_WITHOUT_EXECUTOR');
  assert.strictEqual(persisted.at(-1)?.records[0].id, id, 'accepted work persists synchronously while waiting for an executor');
  for (const target of [id, manager.get(id)!.shortId, manager.get(id)!.qualifiedName, manager.get(id)!.name]) {
    assert.strictEqual(manager.sendMessage(id, target, 'self mail').ok, false, 'peer aliases cannot bypass self-message rejection');
  }
  const h = harness(4, persisted.at(-1));
  await flush();
  assert.strictEqual(h.jobs.length, 1);
  assert.strictEqual(h.jobs[0].prompt, 'QUEUED_WITHOUT_EXECUTOR');
  await h.drain();
}

async function passiveSettledStressAndExplicitWake(): Promise<void> {
  const seed = harness(16);
  const ids = Array.from({ length: 128 }, (_, index) => seed.manager.create(`passive-${index}`, `initial-${index}`));
  await seed.drain();
  const contextBefore = JSON.stringify(seed.manager.serialize().records.map(record => ({ messages: record.messages, metadata: record.metadata })));
  for (const id of ids) {
    assert.ok(seed.manager.sendMessage('sender', id, `PASSIVE_${id}`).ok);
  }
  await flush();
  assert.strictEqual(seed.jobs.length, 128, '128 passive messages cannot restart settled peers');
  assert.strictEqual(seed.manager.hasPendingWork(), false);
  assert.ok(seed.manager.serialize().mailbox.every(message => message.wakeup === false && message.acceptedWhileActive === false));
  assert.strictEqual(JSON.stringify(seed.manager.serialize().records.map(record => ({ messages: record.messages, metadata: record.metadata }))), contextBefore, 'passive mailbox admission leaves the recipient history/cache untouched');
  const restored = harness(16, JSON.parse(JSON.stringify(seed.manager.serialize())) as SubagentState);
  await flush();
  assert.strictEqual(restored.jobs.length, 0, 'restore cannot turn passive messages into wake intents');
  for (const id of ids) assert.ok(restored.manager.send(id, `WAKE_${id}`, true));
  await restored.drain();
  assert.strictEqual(restored.jobs.length, 128);
  assert.strictEqual(restored.metrics().maxActive, 16);
  assert.strictEqual(restored.metrics().maxPerPeer, 1);
  for (const id of ids) {
    const prompt = restored.jobs.find(job => job.record.id === id)!.prompt;
    assert.strictEqual(occurrences(prompt, `PASSIVE_${id}`), 1);
    assert.strictEqual(occurrences(prompt, `WAKE_${id}`), 1);
  }
  assert.ok(restored.manager.serialize().mailbox.every(message => !!message.readAt));
}

async function activePassiveIntentSurvivesStopRestore(): Promise<void> {
  const seed = harness(16);
  const ids = Array.from({ length: 16 }, (_, index) => seed.manager.create(`active-passive-${index}`, `initial-${index}`));
  seed.manager.pauseScheduling();
  for (const id of ids) {
    const sent = seed.manager.sendMessage('sender', id, `ACTIVE_FALSE_${id}`);
    assert.strictEqual(sent.message?.wakeup, false);
    assert.strictEqual(sent.message?.acceptedWhileActive, true);
  }
  for (const index of [...seed.gates.keys()]) seed.release(index, index % 2 === 0);
  await flush();
  assert.strictEqual(seed.jobs.length, 16);
  const snapshot = seed.manager.serialize();
  assert.strictEqual(snapshot.jobs?.length, 16, 'accepted active mail persists a continuation while scheduling is paused');
  const restored = harness(16, JSON.parse(JSON.stringify(snapshot)) as SubagentState);
  await flush();
  assert.strictEqual(restored.jobs.length, 0);
  restored.manager.resumeScheduling();
  await restored.drain();
  assert.strictEqual(restored.jobs.length, 16);
  for (const id of ids) assert.strictEqual(occurrences(restored.jobs.find(job => job.record.id === id)!.prompt, `ACTIVE_FALSE_${id}`), 1);
}

async function wakeIntentPersistsBeforeEnqueue(): Promise<void> {
  const seed = harness(1);
  const id = seed.manager.create('stop-wake', 'initial');
  await seed.drain();
  seed.manager.pauseScheduling();
  seed.manager.send(id, 'PASSIVE_BEFORE_WAKE');
  assert.strictEqual(seed.manager.hasPendingWork(), false);
  const sent = seed.manager.sendMessage('sender', id, 'EXPLICIT_WAKE_AFTER_STOP', 'directive', {}, true);
  const beforeEnqueue = seed.persisted.slice().reverse().find(snapshot => snapshot.records[0].status === 'completed'
    && snapshot.mailbox.some(message => message.id === sent.message!.id));
  assert.ok(beforeEnqueue, 'the acceptance write contains wake intent before its job exists');
  assert.strictEqual(beforeEnqueue!.jobs?.length, 0);
  const restored = harness(16, beforeEnqueue);
  await flush();
  assert.strictEqual(restored.jobs.length, 0, 'durable true must not bypass the restored global stop gate');
  assert.strictEqual(restored.manager.serialize().jobs?.length, 1);
  restored.manager.resumeScheduling();
  await restored.drain();
  assert.strictEqual(restored.jobs.length, 1);
  assert.strictEqual(occurrences(restored.jobs[0].prompt, 'PASSIVE_BEFORE_WAKE'), 1);
  assert.strictEqual(occurrences(restored.jobs[0].prompt, 'EXPLICIT_WAKE_AFTER_STOP'), 1);
}

async function activeAcceptanceCrashBoundary(): Promise<void> {
  const seed = harness(1);
  const id = seed.manager.create('active-crash', 'initial');
  seed.manager.send(id, 'ACCEPTED_ACTIVE_FALSE');
  const snapshot = seed.manager.serialize();
  // The main job has settled and been saved; a crash precedes its continuation
  // enqueue. Keep the persisted acceptance provenance but no pending job.
  snapshot.records[0].status = 'completed';
  snapshot.records[0].result = 'already completed initial job';
  snapshot.jobs = [];
  const restored = harness(1, snapshot);
  await flush();
  assert.strictEqual(restored.jobs.length, 1);
  assert.strictEqual(occurrences(restored.jobs[0].prompt, 'ACCEPTED_ACTIVE_FALSE'), 1);
  assert.strictEqual(occurrences(restored.jobs[0].prompt, 'initial'), 0, 'recovery schedules only accepted mail');
  await restored.drain();
  await seed.drain();
}

async function legacyWakesMigrateButFalseRemainsPassive(): Promise<void> {
  const seed = harness(1);
  const id = seed.manager.create('legacy-wake', 'initial');
  await seed.drain();
  seed.manager.send(id, 'LEGACY_UNREAD');
  seed.manager.sendRootMessage(id, 'LEGACY_ROOT_UNREAD');
  const snapshot = JSON.parse(JSON.stringify(seed.manager.serialize())) as SubagentState;
  delete (snapshot.mailbox[0] as Partial<typeof snapshot.mailbox[number]>).wakeup;
  delete (snapshot.mailbox[0] as Partial<typeof snapshot.mailbox[number]>).acceptedWhileActive;
  delete (snapshot.rootInbox[0] as Partial<typeof snapshot.rootInbox[number]>).wakeup;
  const restored = harness(1, snapshot);
  await flush();
  assert.strictEqual(restored.jobs.length, 1, 'legacy unread mail preserves its historical wake behavior');
  assert.strictEqual(restored.manager.serialize().mailbox[0].wakeup, true);
  assert.strictEqual(restored.manager.readRootInbox()[0].wakeup, true);
  await restored.drain();
  const passive = seed.manager.sendRootMessage(id, 'NEW_PASSIVE_ROOT', 'result', 2);
  const active = seed.manager.sendRootMessage(id, 'NEW_WAKE_ROOT', 'result', 3, true);
  assert.strictEqual(passive.message?.wakeup, false);
  assert.strictEqual(active.message?.wakeup, true);
  assert.strictEqual(active.message?.settlementRevision, 3);
  assert.strictEqual(active.message?.source, 'automatic-settlement');
}

async function passiveIdleErrorAndClosedTargets(): Promise<void> {
  const h = harness(1);
  const id = h.manager.create('inactive-variants', 'initial');
  h.release(0, true);
  await flush();
  assert.strictEqual(h.manager.get(id)?.status, 'error');
  h.manager.send(id, 'PASSIVE_ERROR');
  h.manager.get(id)!.status = 'idle';
  h.manager.send(id, 'PASSIVE_IDLE');
  h.manager.complete(id, 'external completion cannot activate passive mail');
  await flush();
  assert.strictEqual(h.jobs.length, 1);
  assert.strictEqual(h.manager.hasPendingWork(), false);
  assert.ok(h.manager.send(id, 'EXPLICIT_RECOVERY', true));
  await h.drain();
  assert.strictEqual(h.jobs.length, 2);
  for (const token of ['PASSIVE_ERROR', 'PASSIVE_IDLE', 'EXPLICIT_RECOVERY']) assert.strictEqual(occurrences(h.jobs[1].prompt, token), 1);
  h.manager.close(id);
  const before = h.manager.serialize().mailbox.length;
  assert.strictEqual(h.manager.send(id, 'CLOSED_FALSE'), false);
  assert.strictEqual(h.manager.send(id, 'CLOSED_TRUE', true), false);
  assert.strictEqual(h.manager.serialize().mailbox.length, before, 'closed peers reject both wakeup values without accepting mail');
}

async function stopBroadcastIsBatchedDurableAndConversationLocal(): Promise<void> {
  const active = harness(16);
  const other = harness(16);
  const ids = Array.from({ length: 24 }, (_, index) => active.manager.create(`stop-${index}`, `initial-${index}`));
  const settled = active.manager.create('stop-settled', 'completed context');
  const failed = active.manager.create('stop-error', 'error context');
  const closed = active.manager.create('stop-closed', 'closed context');
  active.manager.complete(settled, 'completed retained context');
  active.manager.fail(failed, 'retained error context');
  active.manager.close(closed);
  other.manager.create('unrelated-active-peer', 'other conversation work');
  const otherBefore = JSON.stringify(other.manager.serialize());
  const recordsBefore = JSON.stringify(active.manager.serialize().records);
  const persistedBefore = active.persisted.length;
  const receipt = active.manager.broadcastStop(active.manager.rootAgentId, 'root-stop-run');
  assert.strictEqual(receipt.count, 26, 'all nonclosed working, queued, completed and failed peers receive control');
  assert.strictEqual(new Set(receipt.ids).size, 26);
  assert.deepStrictEqual(receipt.peerIds, [...ids, settled, failed]);
  assert.strictEqual(active.persisted.length, persistedBefore + 1, 'the scheduling gate and entire stop batch persist once');
  assert.strictEqual(active.manager.isSchedulingPaused(), true);
  assert.strictEqual(JSON.stringify(active.manager.serialize().records), recordsBefore, 'stop controls preserve every peer history, cache and status');
  assert.strictEqual(JSON.stringify(other.manager.serialize()), otherBefore, 'another active conversation is wholly unchanged');
  const controls = active.manager.serialize().mailbox;
  assert.ok(controls.every(message => message.control?.action === 'stop' && message.control.runId === 'root-stop-run'
    && message.control.force === false && message.wakeup === false && message.acceptedWhileActive === false && !!message.readAt));
  assert.strictEqual(active.manager.broadcastStop(active.manager.rootAgentId, 'root-stop-run').count, 0);
  assert.strictEqual(active.persisted.length, persistedBefore + 1, 'duplicate single stop writes nothing');
  assert.strictEqual(active.manager.broadcastStop(active.manager.rootAgentId, 'root-stop-run', true).count, 26, 'force escalation has its own receipt for each peer');
  assert.strictEqual(active.persisted.length, persistedBefore + 2);
  assert.strictEqual(active.manager.broadcastStop(active.manager.rootAgentId, 'root-stop-run', true).count, 0);
  controls[0].control!.force = true;
  assert.strictEqual(active.manager.serialize().mailbox[0].control!.force, false, 'external snapshots cannot rewrite stop provenance');
  for (const index of [...active.gates.keys()]) active.release(index);
  await flush();
  assert.strictEqual(active.jobs.length, 16, 'no queued peer starts after stop broadcast');
  const restored = harness(16, active.manager.serialize());
  await flush();
  assert.strictEqual(restored.jobs.length, 0);
  restored.manager.resumeScheduling();
  await restored.drain();
  assert.strictEqual(restored.jobs.length, 8, 'only the original eight queued jobs resume; stop controls cannot schedule settled peers');
  assert.ok(restored.jobs.every(job => !job.prompt.includes('[Runtime control]')), 'runtime stop controls never replay into LLM job input');
  assert.ok(restored.manager.serialize().mailbox.every(message => !!message.readAt));
  await other.drain();
}

async function main(): Promise<void> {
  const scenarios = [completedAndFailedWake, workingBurst, coldUnreadRecovery, dispatchedMailboxRecovery, directSendSerializesSamePeer, queueFairnessAndTierLimits, pauseRestoreAndLowerLimit, liveAcknowledgementAndFailure, synchronousExecutorFailure, serializedContextIsolation, queuedDurabilityAndSelfAliases, passiveSettledStressAndExplicitWake, activePassiveIntentSurvivesStopRestore, wakeIntentPersistsBeforeEnqueue, activeAcceptanceCrashBoundary, legacyWakesMigrateButFalseRemainsPassive, passiveIdleErrorAndClosedTargets, stopBroadcastIsBatchedDurableAndConversationLocal];
  const results: Array<{ scenario: string; ok: boolean; error?: string }> = [];
  for (const scenario of scenarios) {
    try { await scenario(); results.push({ scenario: scenario.name, ok: true }); }
    catch (error) { results.push({ scenario: scenario.name, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  console.log(JSON.stringify({ suite: 'SubAgent mailbox concurrency and durable continuation', scenarios: results, ok: results.every(result => result.ok) }, null, 2));
  if (results.some(result => !result.ok)) process.exitCode = 1;
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
