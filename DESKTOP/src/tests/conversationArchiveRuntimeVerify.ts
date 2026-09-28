import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../core/agent';

async function run(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-archive-runtime-'));
  const startedAt = Date.now();
  try {
    const agent = new Agent(root, { agentOnly: true });
    agent.createInternalWorkspace('archive-pressure');
    const ids = Array.from({ length: 48 }, (_, index) => `archive-${index}`);
    for (const [index, id] of ids.entries()) {
      agent.setConversation(id);
      agent.chatMessages = [
        { role: 'user', content: `archive pressure request ${index}`, mode: 'Build', model: agent.model, timestamp: `2026-08-11T00:00:${String(index).padStart(2, '0')}.000Z` },
        { role: 'assistant', content: `archive pressure response ${index}`, mode: 'Build', model: agent.model, timestamp: `2026-08-11T00:01:${String(index).padStart(2, '0')}.000Z` },
      ];
      agent.history = agent.chatMessages.map(message => ({ role: message.role, content: message.content }));
      agent.flushConversationState();
    }

    // This is the backend half of rapid multi-click pressure: all archive
    // payloads start together, while the state-file lock preserves every
    // delete and unique names prevent same-millisecond overwrites.
    const names = await Promise.all(ids.map(id => agent.archiveConversationAsync(id)));
    const archiveNames = names.filter((name): name is string => !!name);
    assert.equal(archiveNames.length, ids.length, 'every concurrent archive request must produce a receipt');
    assert.equal(new Set(archiveNames).size, ids.length, 'concurrent archive requests must never share a filename');

    const archiveDir = path.join(agent.workspace.current!.path, 'archive');
    for (const name of archiveNames) {
      assert.ok(fs.existsSync(path.join(archiveDir, name)), 'archive markdown must be atomically visible');
      assert.ok(fs.existsSync(path.join(archiveDir, `${name}.conversation.json`)), 'archive manifest must be atomically visible');
    }
    const statePath = path.join(agent.workspace.current!.path, 'conversations', 'state.json');
    const stored = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { conversations?: Record<string, unknown> };
    const remainingIds = Object.keys(stored.conversations || {}).filter(key => ids.some(id => key.endsWith(`-${id}`)));
    assert.deepEqual(remainingIds, [], 'the shared conversation store must lose every archived target');
    assert.equal(fs.existsSync(`${statePath}.lock`), false, 'archive pressure must release the shared state lock');

    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 15_000, `48 concurrent archives must finish promptly, observed ${elapsedMs}ms`);

    // A shard-backed conversation archived by a process that never loaded it
    // (the GUI archives while a utility runtime owns the transcript) must still
    // capture the transcript. The index record keeps its payload behind
    // non-enumerable accessors, so a plain clone of the store used to archive an
    // empty conversation and then delete the real transcript with it.
    const crossProcessId = 'cross-process-archive';
    agent.setConversation(crossProcessId);
    agent.chatMessages = [
      { role: 'user', content: 'CROSS_PROCESS_USER_INPUT', mode: 'Build', model: agent.model, timestamp: '2026-08-11T00:20:00.000Z' },
      { role: 'assistant', content: 'CROSS_PROCESS_ASSISTANT_REPLY', mode: 'Build', model: agent.model, timestamp: '2026-08-11T00:20:01.000Z' },
    ];
    agent.history = [{ role: 'user', content: 'CROSS_PROCESS_USER_INPUT' }, { role: 'assistant', content: 'CROSS_PROCESS_ASSISTANT_REPLY' }];
    agent.saveWorkspaceConversationState(true);
    const crossWorkspace = { ...agent.workspace.current! };
    const shardDir = path.join(crossWorkspace.path, 'conversations', 'shards');
    const shardsBefore = fs.existsSync(shardDir) ? fs.readdirSync(shardDir) : [];
    const reader = new Agent(root, { agentOnly: true });
    reader.workspace.current = crossWorkspace;
    reader.config.loadWorkspaceConfig(crossWorkspace.path);
    const crossFileName = await reader.archiveConversationAsync(crossProcessId);
    assert.ok(crossFileName, 'the cross-process archive must produce a receipt');
    const crossMarkdown = fs.readFileSync(path.join(crossWorkspace.path, 'archive', crossFileName!), 'utf-8');
    assert.ok(crossMarkdown.includes('CROSS_PROCESS_USER_INPUT'), 'a store-only archive must keep the user input');
    assert.ok(crossMarkdown.includes('CROSS_PROCESS_ASSISTANT_REPLY'), 'a store-only archive must keep the assistant reply');
    const crossManifest = JSON.parse(fs.readFileSync(
      path.join(crossWorkspace.path, 'archive', `${crossFileName}.conversation.json`), 'utf-8',
    )) as { entry?: { chatMessages?: unknown[] } };
    assert.equal(crossManifest.entry?.chatMessages?.length, 2, 'the manifest must carry the restored transcript');
    const shardsAfter = fs.existsSync(shardDir) ? fs.readdirSync(shardDir) : [];
    assert.equal(shardsAfter.length, shardsBefore.length - 1, 'the deleted conversation must not leave its transcript shard behind');
    assert.ok(!shardsAfter.some(name => name.includes(crossProcessId)), 'no orphaned shard may keep the archived transcript');

    // The archive wait for an in-flight run is real work, not a budget: the
    // kernel must await the conversation's own run, and the way that wait ends
    // is by *releasing the occupancy* of the run (the caller's hard stop), so
    // no timer may cut it short.
    const { ConversationKernel } = await import('../core/conversationKernel.js');
    agent.setConversation('stuck-run-archive');
    agent.chatMessages = [{ role: 'user', content: 'stuck run archive target', mode: 'Build', model: agent.model, timestamp: '2026-08-11T00:10:00.000Z' }];
    agent.history = [{ role: 'user', content: 'stuck run archive target' }];
    agent.flushConversationState();
    const kernel = new ConversationKernel(root, agent, null, { createRunner: () => agent });
    const kernelInternals = kernel as unknown as {
      normalizeTarget(target: unknown): unknown;
      runtime(target: unknown, options: Record<string, unknown>, runner?: Agent): { activePromise: Promise<unknown> | null };
    };
    const runtime = kernelInternals.runtime(kernelInternals.normalizeTarget('stuck-run-archive'), {
      mode: 'build', model: agent.model, intelligence: agent.intelligence, inputMode: 'guide', engine: 'builtin',
    }, agent);

    // (a) A run that really ends is really awaited -- neither early-returned by
    // a timer nor skipped.
    let longRunSettled = false;
    runtime.activePromise = new Promise(resolve => {
      setTimeout(() => { longRunSettled = true; resolve({ tokens: [], interrupted: false }); }, 1_200);
    });
    const realSettleStarted = Date.now();
    await kernel.prepareForArchive('stuck-run-archive');
    const realSettleMs = Date.now() - realSettleStarted;
    assert.equal(longRunSettled, true, 'the archive must await the conversation run that it cancelled');
    assert.ok(realSettleMs >= 1_000, `the archive must not return before the run settled, observed ${realSettleMs}ms`);
    assert.ok(realSettleMs < 20_000, `awaiting one settled run must stay cheap, observed ${realSettleMs}ms`);

    // (b) A run that only ends when its occupancy is released: the release runs
    // in parallel with the settle and is what ends it -- no timer involved.
    let released = false;
    let releaseRun: (() => void) | null = null;
    runtime.activePromise = new Promise(resolve => {
      releaseRun = () => { longRunSettled = true; resolve({ tokens: [], interrupted: false }); };
    });
    const releaseStarted = Date.now();
    await kernel.prepareForArchive('stuck-run-archive', {
      releaseOccupancy: () => { released = true; releaseRun?.(); },
    });
    const releaseMs = Date.now() - releaseStarted;
    assert.equal(released, true, 'the archive must release the occupancy that holds the run');
    assert.ok(releaseMs < 5_000, `a released run must not keep the archive waiting, observed ${releaseMs}ms`);

    // (c) Without an occupancy release the archive keeps waiting for the real
    // settle: proof that no settle budget was reintroduced.
    runtime.activePromise = new Promise(() => { /* never settles, never gets released */ });
    const unboundStarted = Date.now();
    const unboundOutcome = await Promise.race([
      kernel.prepareForArchive('stuck-run-archive').then(() => 'returned'),
      new Promise<string>(resolve => { setTimeout(() => resolve('still-waiting'), 2_500); }),
    ]);
    const unboundMs = Date.now() - unboundStarted;
    assert.equal(unboundOutcome, 'still-waiting', 'an unreleased, unsettled run must still hold the archive (no timer cap)');

    console.log(JSON.stringify({
      ok: true, archives: archiveNames.length, uniqueNames: new Set(archiveNames).size, elapsedMs,
      awaitedRunSettleMs: realSettleMs, releasedRunSettleMs: releaseMs, unreleasedWaitMs: unboundMs,
      crossProcessArchiveBytes: crossMarkdown.length, shardsReclaimed: shardsBefore.length - shardsAfter.length,
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
