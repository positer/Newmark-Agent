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
    console.log(JSON.stringify({ ok: true, archives: archiveNames.length, uniqueNames: new Set(archiveNames).size, elapsedMs }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
